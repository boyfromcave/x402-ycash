import { describe, expect, it } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired, SupportedResponse } from "@x402/core/types";
import { batch, channel, tx as T, BatchYcashFacilitatorScheme, InMemorySettlementStore } from "../../../src/index.js";
import { NET, reasonOf, setup } from "./setup.js";

const E = batch.BatchError;

async function openedChannel(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  const first = await s.pay();
  await reasonOf(s.server.manager.verify(first, s.req)); // relays; funding depth
  s.chain.mine();
  const v = await s.server.manager.verify(first, s.req);
  await s.client.applySettleResponse(await s.server.manager.settle(v, 2000n));
  return { ...s, channelId: v.channelId };
}

describe("client", () => {
  it("opens with t = tip + minLockBlocks + slack, D + closeFee in the channel, and the first voucher at amount", async () => {
    const s = await setup();
    const p = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    const script = channel.parseChannelScript(T.hexToBytes(p.redeemScript))!;
    expect(script.refundHeight).toBe(1100);
    expect(T.parseTx(p.fundingTx).vout[p.vout]!.value).toBe(101_500n);
    expect(p.voucher.cumulative).toBe("2000");
    const st = await s.client.status(`${T.txid(T.parseTx(p.fundingTx))}:0`);
    expect(st).toMatchObject({ status: "opening", blocksToRefund: 100, deposit: "100000" });
  });

  it("pre-pays dust: a first voucher for an amount below 54 zat is 54", async () => {
    const s = await setup({ amount: "10" });
    const p = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    expect(p.voucher.cumulative).toBe("54");
  });

  it("retires an exhausted channel (or one at its margin) and opens a new one", async () => {
    const s = await openedChannel({ deposit: 3000n });
    const p = await s.pay();
    expect(p.payload.type).toBe("open");
    expect((await s.client.storage.get(s.channelId))?.status).toBe("retired");
    const m = await openedChannel();
    m.chain.tip = 1090;
    expect((await m.pay()).payload.type).toBe("open");
  });

  it("resyncs from a corrective channelState, but never above what it signed", async () => {
    const s = await openedChannel();
    await s.pay(); // signed 4000, charged 2000
    const state = await s.server.manager.channelState(s.channelId);
    expect(await s.client.resync({ ...state, chargedCumulative: "4001" })).toBe(false);
    expect(await s.client.resync({ ...state, chargedCumulative: "3000" })).toBe(true);
    expect((await s.client.storage.get(s.channelId))?.charged).toBe("3000");
    const recovered = await s.client.schemeHooks.onPaymentResponse!({
      paymentPayload: await s.pay(), requirements: s.req,
      paymentRequired: { x402Version: 2, resource: { url: "x" }, accepts: [{ ...s.req, extra: { ...s.req.extra, channelState: state } }] },
    });
    expect(recovered).toEqual({ recovered: true });
  });

  it("refunds alone from t: not before, then a CLTV spend the chain accepts", async () => {
    const s = await openedChannel();
    await expect(s.client.refund(s.channelId)).rejects.toThrow(/from height 1100/);
    s.chain.tip = 1100;
    const txid = await s.client.refund(s.channelId);
    const r = T.parseTx(s.chain.sent.at(-1)!);
    expect(T.txid(r)).toBe(txid);
    expect(r.lockTime).toBe(1100);
    expect(await s.client.status(s.channelId)).toMatchObject({ status: "refunded", unspent: false, blocksToRefund: 0 });
    // the server's later close finds the channel spent
    expect(await s.server.manager.close(s.channelId)).toBeUndefined();
  });

  it("knows YEC as a default asset with 8 decimals", async () => {
    const s = await setup();
    expect(s.client.findDefaultAsset("YEC", NET)).toEqual({ asset: "YEC", decimals: 8, symbol: "YEC" });
    expect(s.client.findDefaultAsset("USDC", NET)).toBeUndefined();
  });
});

describe("facilitator", () => {
  it("verifies an open, relays it, and answers settlement_pending until the depth", async () => {
    const s = await setup({ slack: 5 }); // the retried settle re-checks t ≥ tip + minLockBlocks
    const f = new BatchYcashFacilitatorScheme({ rpc: s.chain });
    const p = await s.pay();
    expect(await f.verify(p, s.req)).toMatchObject({ isValid: true });
    const pending = await f.settle(p, s.req);
    expect(pending).toMatchObject({ success: false, errorReason: E.SETTLEMENT_PENDING });
    expect(pending.transaction).toHaveLength(64);
    s.chain.mine();
    const done = await f.settle(p, s.req);
    expect(done).toMatchObject({ success: true, transaction: pending.transaction });
    expect(s.chain.sent).toHaveLength(1);
    expect(f.getExtra(NET)).toEqual({ confirmations: { minimum: -1, maximum: 20 } });
    expect(f.getSigners(NET)).toEqual([]);
  });

  it("verifies a voucher against the live channel, broadcasts a server-completed claim once, refuses a client close", async () => {
    const s = await openedChannel();
    const store = new InMemorySettlementStore();
    const f = new BatchYcashFacilitatorScheme({ rpc: s.chain, settlementStore: store });
    const p = await s.pay();
    expect(await f.verify(p, s.req)).toMatchObject({ isValid: true, payer: s.channelId });
    expect(await f.settle(p, s.req)).toMatchObject({ success: true, transaction: "" });
    // an uncompleted voucher is not a claim
    const asClaim = s.wrap({ ...p.payload, type: "claim" });
    expect(await f.verify(asClaim, s.req)).toMatchObject({ isValid: false, invalidReason: E.SCRIPT });
    const rec = (await s.client.storage.get(s.channelId))!;
    const ch = batch.client.channelOfRecord(rec);
    const done = channel.completeVoucher(T.parseTx(p.payload.tx as string), ch, (await import("./setup.js")).serverPriv, s.chain.branchId);
    const claim = s.wrap({ ...p.payload, type: "claim", tx: T.serializeTxHex(done) });
    const r = await f.settle(claim, s.req);
    expect(r).toMatchObject({ success: true, transaction: T.txid(done), payer: s.channelId });
    expect((await f.settle(claim, s.req)).success).toBe(false); // the channel is spent now
    const close = s.wrap((await s.client.closePayload(s.channelId)).payload);
    expect((await f.settle(close, s.req)).success).toBe(false);
  });

  it("refuses a confirmation policy outside its range", async () => {
    const s = await setup({ confirmations: -1 });
    const f = new BatchYcashFacilitatorScheme({ rpc: s.chain, confirmations: { minimum: 0, maximum: 20 } });
    expect(await f.verify(await s.pay(), s.req)).toMatchObject({ isValid: false, invalidReason: E.REQUIREMENTS });
  });
});

describe("@x402/core integration", () => {
  it("x402Client → x402ResourceServer hooks: local verify, dynamic charge at settle, cancel releases the lock", async () => {
    const s = await setup({ confirmations: -1 });
    const fac = new x402Facilitator().register(NET, new BatchYcashFacilitatorScheme({ rpc: s.chain }));
    const resourceServer = new x402ResourceServer({
      verify: (p, r) => fac.verify(p, r),
      settle: (p, r) => fac.settle(p, r),
      // core types facilitator kinds with network: string; the client wants `${string}:${string}`
      getSupported: async () => fac.getSupported() as SupportedResponse,
    }).register(NET, s.server);
    await resourceServer.initialize();
    const [req] = await resourceServer.buildPaymentRequirements({ scheme: "batch-settlement", network: NET, payTo: s.req.payTo, price: "0.00002", maxTimeoutSeconds: 300 });
    expect(req!.extra).toMatchObject({ serverPubKey: s.req.extra.serverPubKey, closeFee: "1500" });
    const agent = new x402Client().register(NET, s.client);
    const required: PaymentRequired = { x402Version: 2, resource: { url: "https://api.example/x" }, accepts: [req!] };

    const open = await agent.createPaymentPayload(required);
    const ok = await resourceServer.verifyPayment(open, req!);
    expect(ok).toMatchObject({ isValid: true, payer: expect.stringMatching(/:0$/) });
    const settled = await resourceServer.settlePayment(open, req!, undefined, undefined, { amount: "1500" });
    expect(settled.extra).toMatchObject({ chargedAmount: "1500" });
    await agent.handlePaymentResponse({ paymentPayload: open, requirements: req!, settleResponse: settled });

    const next = await agent.createPaymentPayload(required);
    expect(next.payload).toMatchObject({ type: "voucher", cumulative: "3500" });
    expect(await resourceServer.verifyPayment(next, req!)).toMatchObject({ isValid: true });
    await resourceServer.createPaymentCancellationDispatcher(next, req!).cancel({ reason: "handler_failed" });
    expect(await resourceServer.verifyPayment(next, req!)).toMatchObject({ isValid: true }); // lock released
    expect(await resourceServer.verifyPayment(next, req!)).toMatchObject({ isValid: false, invalidReason: E.CHANNEL_BUSY });
    await resourceServer.createPaymentCancellationDispatcher(next, req!).cancel({ reason: "handler_failed" });

    const stale = await resourceServer.verifyPayment(open, req!);
    expect(stale).toMatchObject({ isValid: false, invalidReason: E.STALE_VOUCHER });
    expect(await reasonOf(Promise.resolve())).toBe("accepted");
  });
});
