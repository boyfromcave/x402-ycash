// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// YED channels across the Falcon height F on a live devnet (ycash-dd upgrade/quantum-vaults, regtest
// `-pqfalconheight=F` on every node: `X402_NODE_ARGS=-pqfalconheight=<F> scripts/devnet.sh up dd <seed>`).
// Before F: an SLH-DSA-client TX_PQCHANNEL opened, paid and closed cooperatively; another refunded
// before F; one with t beyond F closed by the server at F − margin; one left open across F. From F:
// a Falcon-client channel opened (the node wallet's Falcon payTo and return), paid, closed
// cooperatively; another refunded after t; the channel left open across F refunded to the wallet's
// Falcon address; and the node's TOK-PQ confirmed by a P2PKH-paying close refused after F.
// Runs only when the node reports a Falcon height at least 60 blocks above the tip.
import type { PaymentPayload, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { beforeAll, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import { batch, channel, exact, pq, yed, BatchYcashClientScheme, BatchYcashServerScheme, rpcWalletFunder } from "../../src/index.js";
import { InMemorySettlementStore } from "../../src/store/index.js";
import * as T from "../../src/tx/index.js";
import { describeDevnet, devnet, record, waitFor, type Devnet } from "./harness.js";

const NET = "ycash:regtest" as const;
const E = batch.BatchError;
let d: Devnet;
let F = -1;
let applicable = false;

async function ensureYed(cents: number): Promise<void> {
  const balance = async () => (await d.wallet.call<{ confirmedCents: number }>("yed_getbalance")).confirmedCents;
  if ((await balance()) >= cents) return;
  await waitFor(async () => {
    try {
      await d.wallet.call("yed_mint", [cents, 48, "", "", false]);
      return true;
    } catch (e) {
      if (!/price|participation/i.test((e as Error).message)) throw e;
      await d.mine(4, d.pool);
      return false;
    }
  }, { timeoutMs: 180_000, pollMs: 100, what: "a mint price" });
  await waitFor(async () => (await d.mine(1), (await balance()) >= cents), { timeoutMs: 180_000, pollMs: 500, what: "the MINT" });
}

async function mineOnPool(txid: string): Promise<number> {
  await waitFor(async () => (await d.pool.getRawMempool()).includes(txid), { what: `${txid} at the pool` });
  const [hash] = await d.mine(1, d.pool);
  const b = await d.pool.call<{ tx: string[]; height: number }>("getblock", [hash]);
  expect(b.tx).toContain(txid);
  return b.height;
}

async function mineTo(height: number): Promise<void> {
  for (let left = height - (await d.tip()); left > 0; left = height - (await d.tip())) await d.mine(Math.min(8, left));
}

const tokensOf = async (address: string) => {
  await d.syncBlocks();
  return d.wallet.call<{ txid: string; vout: number; cents: number }[]>("yed_listtokens", [[address]]);
};
const outType = async (txid: string, vout: number) =>
  (await d.wallet.call<{ vout: { scriptPubKey: { type: string } }[] }>("getrawtransaction", [txid, 1])).vout[vout]?.scriptPubKey.type;

interface Party {
  server: BatchYcashServerScheme;
  client: BatchYcashClientScheme;
  req: PaymentRequirements;
  payTo: string;
  closes: { channelId: string; reason: string; txid: string | undefined; cumulative: bigint }[];
}

async function party(deposit: bigint, minLockBlocks: number, template?: batch.client.YedChannelTemplate): Promise<Party> {
  const closes: Party["closes"] = [];
  const srv = new BatchYcashServerScheme({
    chain: d.wallet, serverPrivKey: T.randomPrivKey(), maxDeposit: 100_000_000n, maxDepositCents: 10_000n, minLockBlocks,
    closeMarginBlocks: 5, confirmations: 1, usdAsset: "YED", onClose: (e) => closes.push(e),
  });
  // the wallet's default: P2PKH before F, a Falcon post-quantum address from F (quantum spec A-13)
  const payTo = await d.wallet.call<string>("yed_getnewaddress");
  const priced = await srv.parsePrice("$0.25", NET);
  const base: PaymentRequirements = { scheme: "batch-settlement", network: NET, asset: priced.asset, amount: priced.amount, payTo, maxTimeoutSeconds: 300, extra: {} };
  const req = await srv.enhancePaymentRequirements(base, { x402Version: 2, scheme: "batch-settlement", network: NET }, []);
  const client = new BatchYcashClientScheme({
    chain: d.wallet, funder: rpcWalletFunder(d.wallet), deposit: () => deposit, lockSlackBlocks: 3, ...(template ? { yedChannelTemplate: template } : {}),
  });
  return { server: srv, client, req, payTo, closes };
}
const wrap = (req: PaymentRequirements, payload: Record<string, unknown>): PaymentPayload => ({ x402Version: 2, accepted: req, payload });

async function open(p: Party): Promise<{ channelId: string; fundingTx: T.Tx }> {
  const payload = wrap(p.req, (await p.client.createPaymentPayload(2, p.req)).payload);
  await expect(p.server.manager.verify(payload, p.req)).rejects.toMatchObject({ reason: E.FUNDING_DEPTH });
  const fundingHex = (payload.payload as { fundingTx: string }).fundingTx;
  await mineOnPool(T.txid(fundingHex));
  const v = await p.server.manager.verify(payload, p.req);
  await p.client.applySettleResponse(await p.server.manager.settle(v, BigInt(p.req.amount)));
  return { channelId: v.channelId, fundingTx: T.parseTx(fundingHex) };
}

async function request(p: Party): Promise<void> {
  const payload = wrap(p.req, (await p.client.createPaymentPayload(2, p.req)).payload);
  const v = await p.server.manager.verify(payload, p.req);
  await p.client.applySettleResponse(await p.server.manager.settle(v, BigInt(p.req.amount)));
}

async function closeCooperatively(p: Party, channelId: string): Promise<{ txid: string; hex: string; height: number }> {
  const close = wrap(p.req, (await p.client.closePayload(channelId)).payload);
  const r = await p.server.manager.settle(await p.server.manager.verify(close, p.req), 0n);
  expect(r.success).toBe(true);
  const hex = await d.wallet.call<string>("getrawtransaction", [r.transaction]);
  // the overlay's verdict while the channel output is still unspent (in the mempool close)
  expect(await d.wallet.yedValidateRawTransaction(hex)).toMatchObject({ type: "transfer", verdict: "ok", burned: 0 });
  return { txid: r.transaction, hex, height: await mineOnPool(r.transaction) };
}

const clientSchemeOf = (rec: batch.client.ClientChannelRecord | undefined) => channel.parsePQChannelScript(T.hexToBytes(rec!.redeemScript))?.client.scheme;

describeDevnet("YED channels across the Falcon height (-pqfalconheight)", () => {
  const pre: { a3?: Party & { channelId: string }; a4?: Party & { channelId: string } } = {};

  beforeAll(async () => {
    d = await devnet();
    const info = await d.wallet.call<{ rpcversion: number; params: { pq: { falconHeight: number; falconActive: boolean } } }>("yed_getinfo");
    F = info.params.pq.falconHeight;
    const tip = await d.tip();
    applicable = F > tip + 60;
    if (!applicable) {
      console.warn(`yed_falcon devnet: skipped (falconHeight ${F}, tip ${tip}); start the devnet with X402_NODE_ARGS=-pqfalconheight=<tip + 100 or more>`);
      return;
    }
    expect(info.params.pq.falconActive).toBe(false);
    await ensureYed(20_000); // a MINT is 10,000..1,000,000 cents
    // plain, non-coinbase YEC coins for the fundings' V and fees (rpcWalletFunder never spends coinbase)
    for (let i = 0; i < 8; i++) await d.fund(await d.wallet.call<string>("getnewaddress"), 2);
    await d.mine(1);
    record(d.line, "falcon devnet", { falconHeight: F, tip: await d.tip() });
  });

  it("before F: an SLH-DSA client, P2PKH payTo and return, a funding that expires below F; paid and closed cooperatively below F", async ({ skip }) => {
    if (!applicable) skip();
    const p = await party(500n, 30);
    expect(T.decodeAddress(p.payTo, NET).kind).toBe("yed");
    const { channelId, fundingTx } = await open(p);
    const rec = (await p.client.storage.get(channelId))!;
    expect(clientSchemeOf(rec)).toBe(pq.SCHEME_SLH_DSA_SHA2_128S);
    expect(rec.clientScheme).toBe(1);
    expect(T.decodeAddress(rec.returnAddress!, NET).kind).toBe("yed");
    expect(fundingTx.expiryHeight).toBeLessThan(F);
    await request(p);
    await request(p);
    await request(p);
    const c = await closeCooperatively(p, channelId);
    expect(c.height).toBeLessThan(F);
    expect((await tokensOf(p.payTo)).map((t) => t.cents)).toEqual([100]);
    record(d.line, "pre-Falcon SLH channel closed", { channelId, closeTxid: c.txid, height: c.height, scriptSigBytes: T.parseTx(c.hex).vin[0]!.scriptSig.length });
  });

  it("before F: the client's SLH-DSA refund after t < F", async ({ skip }) => {
    if (!applicable) skip();
    const p = await party(300n, 10);
    const { channelId } = await open(p);
    await request(p);
    const rec = (await p.client.storage.get(channelId))!;
    expect(rec.refundHeight).toBeLessThan(F - 10);
    await mineTo(rec.refundHeight);
    const txid = await p.client.refund(channelId);
    const height = await mineOnPool(txid);
    expect(height).toBeLessThan(F);
    expect(await tokensOf(rec.returnAddress!)).toMatchObject([{ txid, vout: 1, cents: 300 }]);
    record(d.line, "pre-Falcon SLH refund", { channelId, txid, height });
  });

  it("before F: channels whose t lies beyond F carry closeBy = F (one the server will close at F − margin, one left open)", async ({ skip }) => {
    if (!applicable) skip();
    for (const k of ["a3", "a4"] as const) {
      const p = await party(300n, F - (await d.tip()) + 20);
      const { channelId } = await open(p);
      await request(p);
      const st = await p.client.status(channelId);
      expect(st.refundHeight).toBeGreaterThan(F);
      expect(st.closeBy).toBe(F);
      expect(st.warning).toMatch(/must be closed below it/);
      expect((await p.server.manager.ledger.get(channelId))?.terms.closeBy).toBe(F);
      pre[k] = { ...p, channelId };
    }
  });

  it("at F − margin the server closes the pre-F channel (reason margin), mined below F; the client retires it", async ({ skip }) => {
    if (!applicable) skip();
    const a3 = pre.a3!;
    await mineTo(F - 5);
    const closed = await a3.server.manager.sweep();
    expect(closed).toMatchObject([{ channelId: a3.channelId, reason: "margin" }]);
    const height = await mineOnPool(closed[0]!.txid!);
    expect(height).toBeLessThan(F);
    expect((await tokensOf(a3.payTo)).map((t) => t.cents)).toEqual([100]);
    // the client's next request retires the channel and refuses a pre-F open this close to F
    await expect(a3.client.createPaymentPayload(2, a3.req)).rejects.toThrow(/too close/);
    record(d.line, "pre-Falcon channel closed at F − margin", { channelId: a3.channelId, closeTxid: closed[0]!.txid, height });
  });

  it("from F: a Falcon client, the wallet's Falcon payTo and return; ≈ 1.6 KB vouchers; paid and closed cooperatively", async ({ skip }) => {
    if (!applicable) skip();
    await mineTo(F);
    const info = await d.wallet.call<{ params: { pq: { falconActive: boolean; schemes: number[] } } }>("yed_getinfo");
    expect(info.params.pq).toMatchObject({ falconActive: true, schemes: [1, 2] });
    const p = await party(500n, 30);
    expect(T.decodeAddress(p.payTo, NET)).toMatchObject({ kind: "yedpq", scheme: 2 });
    const t0 = Date.now();
    const { channelId, fundingTx } = await open(p);
    const [fundingTxid, vout] = channelId.split(":") as [string, string];
    expect(await outType(fundingTxid, Number(vout))).toBe("pqchannel");
    const rec = (await p.client.storage.get(channelId))!;
    expect(clientSchemeOf(rec)).toBe(pq.SCHEME_FN_DSA_512);
    expect(rec.clientScheme).toBe(2);
    expect(T.decodeAddress(rec.returnAddress!, NET)).toMatchObject({ kind: "yedpq", scheme: 2 });
    // the funding's YED change went to a Falcon holder too (TOK-PQ)
    for (const o of fundingTx.vout) if (pq.pqpkhKeyId(o.scriptPubKey)) expect(channel.isFalconHolder(o.scriptPubKey)).toBe(true);
    await request(p);
    await request(p);
    await request(p);
    await request(p); // charged 125: a fresh Falcon voucher
    const perVoucherMs = (Date.now() - t0) / 5;
    const c = await closeCooperatively(p, channelId);
    const close = T.parseTx(c.hex);
    expect(channel.parsePQCloseScriptSig(close.vin[0]!.scriptSig)?.spend.scheme).toBe(2);
    expect(await outType(c.txid, 0)).toBe("pqpubkeyhash");
    expect(await outType(c.txid, 1)).toBe("pqpubkeyhash");
    expect((await tokensOf(p.payTo)).map((t) => t.cents)).toEqual([125]);
    expect((await tokensOf(rec.returnAddress!)).map((t) => t.cents)).toEqual([375]);
    record(d.line, "Falcon channel closed", { channelId, closeTxid: c.txid, height: c.height, scriptSigBytes: close.vin[0]!.scriptSig.length, closeBytes: c.hex.length / 2, perVoucherMs });
  });

  it("from F: the Falcon client's refund after t pays its Falcon return address", async ({ skip }) => {
    if (!applicable) skip();
    const p = await party(300n, 10);
    const { channelId } = await open(p);
    await request(p);
    const rec = (await p.client.storage.get(channelId))!;
    await mineTo(rec.refundHeight);
    const txid = await p.client.refund(channelId);
    const hex = await d.wallet.call<string>("getrawtransaction", [txid]);
    expect(await d.wallet.yedValidateRawTransaction(hex)).toMatchObject({ verdict: "ok", yedIn: 300, yedOut: 300, burned: 0 });
    await mineOnPool(txid);
    expect(await tokensOf(rec.returnAddress!)).toMatchObject([{ txid, vout: 1, cents: 300 }]);
    record(d.line, "Falcon refund", { channelId, txid, scriptSigBytes: T.parseTx(hex).vin[0]!.scriptSig.length });
  });

  it("across F: the pre-F channel left open cannot close any more (TOK-PQ); its refund after t pays the wallet's Falcon address", async ({ skip }) => {
    if (!applicable) skip();
    const a4 = pre.a4!;
    expect((await a4.client.status(a4.channelId)).warning).toMatch(/has passed/);
    // the server's stored voucher pays P2PKH outputs: the node refuses the completed close after F
    const ch = (await a4.server.manager.ledger.get(a4.channelId))!;
    const done = channel.completeVoucher(T.parseTx(ch.voucherTx!), batch.client.channelOfRecord((await a4.client.storage.get(a4.channelId))!),
      T.randomPrivKey(), parseInt((await d.wallet.getBlockchainInfo()).consensus.nextblock, 16) >>> 0);
    expect((await d.wallet.yedValidateRawTransaction(T.serializeTxHex(done))).verdict).not.toBe("ok");
    const rec = (await a4.client.storage.get(a4.channelId))!;
    await mineTo(rec.refundHeight);
    const txid = await a4.client.refund(a4.channelId);
    const tx = T.parseTx(await d.wallet.call<string>("getrawtransaction", [txid]));
    expect(channel.isFalconHolder(tx.vout[1]!.scriptPubKey)).toBe(true);
    await mineOnPool(txid);
    expect(await outType(txid, 1)).toBe("pqpubkeyhash");
    record(d.line, "pre-Falcon channel refunded after F", { channelId: a4.channelId, txid });
  });

  it("from F: exact YED to the wallet's Falcon address, Falcon YED change; a P2PKH payTo refused before signing, and by the facilitator", async ({ skip }) => {
    if (!applicable) skip();
    const fac = new exact.ExactYcashFacilitatorScheme(d.wallet, { settlementStore: new InMemorySettlementStore(), confirmationTimeoutMs: 30_000, confirmationPollMs: 250, yellowback: true });
    const facilitator = new x402Facilitator().register(NET, fac);
    const server = new x402ResourceServer({
      verify: (p: PaymentPayload, r: PaymentRequirements) => facilitator.verify(p, r),
      settle: (p: PaymentPayload, r: PaymentRequirements) => facilitator.settle(p, r),
      getSupported: async () => facilitator.getSupported() as SupportedResponse,
    }).register(NET, new exact.ExactYcashServerScheme({ usdAsset: "YED" }));
    await server.initialize();
    const client = new x402Client().register(NET, new exact.ExactYcashScheme(new exact.RpcWalletSigner(d.wallet)));
    client.setSpendControls({ maxAmountPerPayment: "$50" });
    const payTo = await d.wallet.call<string>("yed_getnewaddress");
    expect(T.decodeAddress(payTo, NET)).toMatchObject({ kind: "yedpq", scheme: 2 });
    const [req] = await server.buildPaymentRequirements({ scheme: "exact", network: NET, payTo, price: "$2", maxTimeoutSeconds: 600 });
    const pl = await client.createPaymentPayload(await server.createPaymentRequiredResponse([req as PaymentRequirements], { url: "https://merchant.test/falcon" }));
    const hex = (pl.payload as { transaction: string }).transaction;
    const tx = T.parseTx(hex);
    const found = yed.findPayload(tx.vout);
    const assignments = found && "payload" in found && found.payload.type === "transfer" ? found.payload.assignments : [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) expect(channel.isFalconHolder(tx.vout[a.vout]!.scriptPubKey)).toBe(true); // payTo and the YED change
    expect(await d.wallet.yedValidateRawTransaction(hex)).toMatchObject({ verdict: "ok", burned: 0 });
    expect(await server.verifyPayment(pl, req as PaymentRequirements)).toMatchObject({ isValid: true });
    const settling = server.settlePayment(pl, req as PaymentRequirements);
    await mineOnPool(T.txid(hex));
    expect(await settling).toMatchObject({ success: true, transaction: T.txid(hex) });
    expect((await tokensOf(payTo)).filter((t) => t.txid === T.txid(hex))).toMatchObject([{ vout: 0, cents: 200 }]);
    // a P2PKH YED payee after F: the client refuses before the wallet signs
    const p2pkh = await d.wallet.call<string>("yed_getnewaddress", ["p2pkh"]);
    const [bad] = await server.buildPaymentRequirements({ scheme: "exact", network: NET, payTo: p2pkh, price: "$2", maxTimeoutSeconds: 600 });
    await expect(client.createPaymentPayload(await server.createPaymentRequiredResponse([bad as PaymentRequirements], { url: "https://merchant.test/p2pkh" }))).rejects.toThrow(/TOK-PQ/);
    record(d.line, "exact YED after F", { payTo, txid: T.txid(hex), assignments: assignments.length });
  });

  it("from F: a P2SH YED channel is refused by the client before anything is funded", async ({ skip }) => {
    if (!applicable) skip();
    const p = await party(300n, 30, "p2sh");
    await expect(p.client.createPaymentPayload(2, p.req)).rejects.toThrow(/P2SH YED channel is invalid from the Falcon height/);
  });
});
