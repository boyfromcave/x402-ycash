// The commands. Each writes JSON lines to `out` and returns the process exit code.
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { ASSET_YED, batch as B, tx, yed } from "x402-ycash-mechanism";
import type { PayingClient } from "./client.js";
import { UsageError, type CliConfig } from "./config.js";

export type Out = (record: Record<string, unknown>) => void;

const BATCH = "batch-settlement";

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function settlementOf(res: Response): SettleResponse | undefined {
  const h = res.headers.get("PAYMENT-RESPONSE");
  return h ? decodePaymentResponseHeader(h) : undefined;
}

/** `pay <url>`: GET it `count` times, paying each 402 with whichever registered scheme it offers. */
export async function pay(c: PayingClient, config: CliConfig, url: string, out: Out, baseFetch: typeof fetch = fetch): Promise<number> {
  const paid = wrapFetchWithPayment(baseFetch, c.client);
  let code = 0;
  for (let i = 1; i <= config.count; i++) {
    const t0 = performance.now();
    const res = await paid(url);
    const settlement = settlementOf(res);
    out({ i, status: res.status, ms: Math.round(performance.now() - t0), ...(settlement ? { settlement } : {}), body: await bodyOf(res) });
    if (res.status >= 400) code = 1;
  }
  return code;
}

/** The route's unpaid 402, decoded. */
async function paymentRequired(c: PayingClient, url: string, baseFetch: typeof fetch): Promise<PaymentRequired> {
  const res = await baseFetch(url);
  if (res.status !== 402) throw new UsageError(`${url} answered ${res.status}, not 402: it is not a paid route`);
  const body = await bodyOf(res);
  return c.http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
}

function batchAccept(pr: PaymentRequired, url: string, asset?: string): PaymentRequirements {
  const accept = pr.accepts.find((a) => a.scheme === BATCH && (asset === undefined || a.asset === asset));
  const offered = pr.accepts.map((a) => `${a.scheme} ${a.asset}`).join(", ") || "nothing";
  if (!accept) throw new UsageError(`${url} offers no ${BATCH}${asset ? ` in ${asset}` : ""} (it offers ${offered})`);
  return accept;
}

const offerOf = (a: PaymentRequirements): string => B.client.offerKeyOf(a.network, a.payTo, String(a.extra?.serverPubKey ?? ""));

/** `channel open <url>`: pays the route's first request on a channel, opening one when none is live. */
export async function channelOpen(c: PayingClient, config: CliConfig, url: string, out: Out, baseFetch: typeof fetch = fetch): Promise<number> {
  const accept = batchAccept(await paymentRequired(c, url, baseFetch), url, config.asset);
  const code = await pay(c, { ...config, count: 1 }, url, out, baseFetch);
  const rec = await c.storage.findLive(offerOf(accept));
  if (!rec) {
    out({ msg: "no live channel for this route after the request" });
    return 1;
  }
  out({ msg: "channel", ...(await c.batch.status(rec.channelId)) });
  return code;
}

/** `channel status [channelId]`: one channel, or every channel in the store. */
export async function channelStatus(c: PayingClient, channelId: string | undefined, out: Out): Promise<number> {
  const ids = channelId ? [channelId] : (await c.storage.list()).map((r) => r.channelId);
  for (const id of ids) {
    const rec = await c.storage.get(id);
    if (!rec) throw new UsageError(`no channel ${id} in the store`);
    out({ ...(await c.batch.status(id)), asset: rec.asset, payTo: rec.payTo, ...(rec.closeTxid ? { closeTxid: rec.closeTxid } : {}), ...(rec.refundTxid ? { refundTxid: rec.refundTxid } : {}) });
  }
  if (ids.length === 0) out({ msg: "no channels in the store" });
  return 0;
}

/**
 * `channel close <url> [channelId]`: sends the client's `close` voucher at exactly the server's
 * charged total (spec "`close` (optional, client-initiated)"); the server broadcasts it at once and
 * the client's remainder comes back without waiting for t.
 */
export async function channelClose(c: PayingClient, url: string, channelId: string | undefined, out: Out, baseFetch: typeof fetch = fetch, asset?: string): Promise<number> {
  const pr = await paymentRequired(c, url, baseFetch);
  const accept = batchAccept(pr, url, asset);
  const rec = channelId ? await c.storage.get(channelId) : await c.storage.findLive(offerOf(accept));
  if (!rec) throw new UsageError(channelId ? `no channel ${channelId} in the store` : `no live channel for ${url}`);
  if (rec.offerKey !== offerOf(accept)) throw new UsageError(`channel ${rec.channelId} is not a channel of ${url}'s offer`);
  const close = await c.batch.closePayload(rec.channelId);
  const payload: PaymentPayload = { x402Version: 2, ...(pr.resource ? { resource: pr.resource } : {}), accepted: accept, payload: close.payload };
  const res = await baseFetch(url, { headers: c.http.encodePaymentSignatureHeader(payload) });
  const settlement = settlementOf(res);
  const body = await bodyOf(res);
  if (!settlement?.success) {
    out({ msg: "close refused", status: res.status, ...(settlement ? { settlement } : {}), body });
    return 1;
  }
  await c.batch.markClosed(rec.channelId, settlement.transaction);
  // The close voucher's cumulative: the charged total, or $1.00 for a YED channel charged less (X-F41).
  out({ msg: "closed", channelId: rec.channelId, asset: rec.asset, charged: rec.charged, cumulative: String(close.payload.cumulative), transaction: settlement.transaction, settlement });
  return 0;
}

/**
 * Where the refund of a channel recorded before return addresses existed goes without `--to`: the
 * WIF key's address, or a new address of the node's wallet (Yellowback for YED). Such a record's
 * client script is the channel key C's, which lives only in the channel store and which no wallet
 * watches. A newer record refunds to its open's returnAddress.
 */
async function legacyRefundScript(config: CliConfig, isYed: boolean): Promise<Uint8Array> {
  if (config.wif) {
    const { privKey, compressed } = tx.decodeWif(config.wif, config.network);
    return tx.p2pkhScript(tx.hash160(tx.pubkeyFromPriv(privKey, compressed)));
  }
  return tx.addressToScript(await config.node.call<string>(isYed ? "yed_getnewaddress" : "getrawchangeaddress"), config.network);
}

/** `channel refund <channelId>`: the client alone, from height t. A YED refund carries a TRANSFER of all of D. */
export async function channelRefund(c: PayingClient, config: CliConfig, channelId: string, out: Out): Promise<number> {
  const rec = await c.storage.get(channelId);
  if (!rec) throw new UsageError(`no channel ${channelId} in the store`);
  const isYed = rec.asset === ASSET_YED;
  if (isYed && config.refundTo && tx.decodeAddress(config.refundTo, config.network).kind === "p2sh") throw new UsageError("--to: a YED refund pays a P2PKH (ye…) address");
  const toScript = config.refundTo
    ? tx.addressToScript(config.refundTo, config.network)
    : rec.returnAddress
      ? tx.hexToBytes(rec.clientScript)
      : await legacyRefundScript(config, isYed);
  const txid = await c.batch.refund(channelId, { toScript });
  const record: Record<string, unknown> = { msg: "refunded", channelId, asset: rec.asset, transaction: txid };
  if (isYed) {
    // The TRANSFER as broadcast (vout 1 is the refund output): proof the YED came back, nothing burned.
    const hex = await config.node.call<string>("getrawtransaction", [txid]);
    const found = yed.findPayload(tx.parseTx(hex).vout);
    record.transfer = found && "payload" in found ? found.payload : found;
    record.to = tx.encodeAddress(config.network, "yed", tx.p2pkhHash(toScript) as Uint8Array);
  }
  out(record);
  return 0;
}
