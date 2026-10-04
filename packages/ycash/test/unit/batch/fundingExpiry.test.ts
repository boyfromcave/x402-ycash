// The funding expiry (plan X-F52; spec "`open`"): the client's funding expires at tip + 3 + a window,
// so a funding the server never relays frees the client's coins by height; the server refuses a
// funding that expires before it could reach the policy depth; an expired opening is abandoned.
import { describe, expect, it } from "vitest";
import { batch, tx as T } from "../../../src/index.js";
import { minFundingExpiry } from "../../../src/batch/verify.js";
import { reasonOf, setup } from "./setup.js";

const E = batch.BatchError;

describe("funding expiry", () => {
  it("the client asks for nExpiryHeight = tip + 3 + 40 by default, or its own window; vouchers keep 0", async () => {
    expect(batch.client.DEFAULT_FUNDING_EXPIRY_BLOCKS).toBe(40);
    const s = await setup();
    const p = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    expect(s.fundings[0]).toMatchObject({ tip: 1000, expiryHeight: 1043 });
    expect(T.parseTx(p.fundingTx).expiryHeight).toBe(1043);
    expect(T.parseTx(p.voucher.tx).expiryHeight).toBe(0);
    const w = await setup({ fundingExpiryBlocks: 10 });
    await w.pay();
    expect(w.fundings[0]?.expiryHeight).toBe(1013);
  });

  it("the server refuses a funding that cannot land and reach the depth: expiry < tip + 3 + depth", async () => {
    expect(minFundingExpiry(1000, 1)).toBe(1004);
    expect(minFundingExpiry(1000, -1)).toBe(1003);
    expect(minFundingExpiry(1000, 6)).toBe(1009);
    const s = await setup({ fundingExpiryBlocks: 1, confirmations: 3 }); // 1004 < 1000 + 3 + 3
    expect(await reasonOf(s.server.manager.verify(await s.pay(), s.req))).toBe(E.FUNDING);
    const ok = await setup({ fundingExpiryBlocks: 3, confirmations: 3 }); // 1006 ≥ 1006
    expect(await reasonOf(ok.server.manager.verify(await ok.pay(), ok.req))).toBe(E.FUNDING_DEPTH); // relayed, waiting
  });

  it("an opening whose funding expired unrelayed is abandoned, and a new channel opens", async () => {
    const s = await setup();
    const first = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    const firstId = `${T.txid(T.parseTx(first.fundingTx))}:0`;
    s.chain.tip = 1039; // next block 1040 still relays an expiry of 1043
    expect((await s.pay()).payload).toEqual(first);
    s.chain.tip = 1040; // the next block would refuse it: expiring soon
    const second = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    expect(second.fundingTx).not.toBe(first.fundingTx);
    expect((await s.client.storage.get(firstId))?.status).toBe("expired");
  });

  it("an opening whose funding the server relayed is resent, not abandoned", async () => {
    const s = await setup();
    const first = await s.pay();
    expect(await reasonOf(s.server.manager.verify(first, s.req))).toBe(E.FUNDING_DEPTH); // relayed into the mempool
    s.chain.tip = 1050;
    expect((await s.pay()).payload).toEqual(first.payload);
  });
});
