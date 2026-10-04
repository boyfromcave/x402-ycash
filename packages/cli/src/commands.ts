// The commands. Each writes JSON lines to `out` and returns the process exit code.
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { batch as B, tx } from "x402-ycash-mechanism";
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

function batchAccept(pr: PaymentRequired, url: string): PaymentRequirements {
  const accept = pr.accepts.find((a) => a.scheme === BATCH);
  if (!accept) throw new UsageError(`${url} offers no ${BATCH} (it offers ${pr.accepts.map((a) => a.scheme).join(", ") || "nothing"})`);
  return accept;
}

const offerOf = (a: PaymentRequirements): string => B.client.offerKeyOf(a.network, a.payTo, String(a.extra?.serverPubKey ?? ""));

/** `channel open <url>`: pays the route's first request on a channel, opening one when none is live. */
export async function channelOpen(c: PayingClient, config: CliConfig, url: string, out: Out, baseFetch: typeof fetch = fetch): Promise<number> {
  const accept = batchAccept(await paymentRequired(c, url, baseFetch), url);
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
    out({ ...(await c.batch.status(id)), payTo: rec.payTo, ...(rec.closeTxid ? { closeTxid: rec.closeTxid } : {}), ...(rec.refundTxid ? { refundTxid: rec.refundTxid } : {}) });
  }
  if (ids.length === 0) out({ msg: "no channels in the store" });
  return 0;
}

/**
 * `channel close <url> [channelId]`: sends the client's `close` voucher at exactly the server's
 * charged total (spec "`close` (optional, client-initiated)"); the server broadcasts it at once and
 * the client's remainder comes back without waiting for t.
 */
export async function channelClose(c: PayingClient, url: string, channelId: string | undefined, out: Out, baseFetch: typeof fetch = fetch): Promise<number> {
  const pr = await paymentRequired(c, url, baseFetch);
  const accept = batchAccept(pr, url);
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
  out({ msg: "closed", channelId: rec.channelId, cumulative: rec.charged, transaction: settlement.transaction, settlement });
  return 0;
}

/** `channel refund <channelId>`: the client alone, from height t. */
export async function channelRefund(c: PayingClient, config: CliConfig, channelId: string, out: Out): Promise<number> {
  const toScript = config.refundTo ? tx.addressToScript(config.refundTo, config.network) : undefined;
  const txid = await c.batch.refund(channelId, toScript ? { toScript } : {});
  out({ msg: "refunded", channelId, transaction: txid });
  return 0;
}
