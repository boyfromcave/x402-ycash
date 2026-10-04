// The client's return address (spec "`open`", "Voucher outputs"): the open names it, every voucher,
// the close and the refund return the client's remainder there, and the server and a facilitator
// that saw the open refuse a voucher paying anywhere else. Before it, the remainder went to the
// channel key C, which no wallet watches.
import { describe, expect, it } from "vitest";
import { batch, channel, tx as T, BatchYcashFacilitatorScheme } from "../../../src/index.js";
import { returnScriptOf } from "../../../src/batch/returnAddress.js";
import { NET, payToAddr, reasonOf, returnAddr, setup, type SetupOptions } from "./setup.js";

const E = batch.BatchError;
const returnScript = T.addressToScript(returnAddr, NET);
const other = T.encodeAddress(NET, "p2pkh", T.hexToBytes("bb".repeat(20)));

async function opened(o: SetupOptions = {}) {
  const s = await setup(o);
  const first = await s.pay();
  await reasonOf(s.server.manager.verify(first, s.req));
  s.chain.mine();
  const v = await s.server.manager.verify(first, s.req);
  await s.client.applySettleResponse(await s.server.manager.settle(v, 2000n));
  return { ...s, first, channelId: v.channelId };
}

/** A voucher at `cumulative` re-signed by C with its client output paying `to`. */
async function voucherTo(s: Awaited<ReturnType<typeof opened>>, cumulative: bigint, to: Uint8Array): Promise<string> {
  const rec = (await s.client.storage.get(s.channelId))!;
  const v = channel.buildVoucher({ channel: batch.client.channelOfRecord(rec), cumulative, clientScript: to, clientPrivKey: T.hexToBytes(rec.clientPrivKey), branchId: s.chain.branchId });
  return T.serializeTxHex(v);
}

describe("returnScriptOf", () => {
  const payTo = T.addressToScript(payToAddr, NET);
  it("takes a transparent P2PKH or P2SH address for YEC, a P2PKH (s… or ye…) for YED", () => {
    expect(returnScriptOf(returnAddr, NET, "YEC", payTo)).toEqual(returnScript);
    const p2sh = T.encodeAddress(NET, "p2sh", T.hexToBytes("cc".repeat(20)));
    expect(T.bytesToHex(returnScriptOf(p2sh, NET, "YEC", payTo))).toMatch(/^a914/);
    const ye = T.encodeAddress(NET, "yed", T.hash160(T.pubkeyFromPriv(T.hexToBytes("33".repeat(32)))));
    expect(returnScriptOf(ye, NET, "YED", payTo)).toEqual(returnScript);
    expect(returnScriptOf(returnAddr, NET, "YED", payTo)).toEqual(returnScript);
  });

  it("refuses P2SH for YED, a YED address for YEC, another network, garbage and payTo itself", () => {
    const reason = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as batch.BatchSettlementError).reason;
      }
      return "accepted";
    };
    const p2sh = T.encodeAddress(NET, "p2sh", T.hexToBytes("cc".repeat(20)));
    expect(reason(() => returnScriptOf(p2sh, NET, "YED", payTo))).toBe(E.RETURN_ADDRESS);
    expect(reason(() => returnScriptOf(T.encodeAddress(NET, "yed", T.hexToBytes("dd".repeat(20))), NET, "YEC", payTo))).toBe(E.RETURN_ADDRESS);
    expect(reason(() => returnScriptOf(T.encodeAddress("ycash:mainnet", "p2pkh", T.hexToBytes("dd".repeat(20))), NET, "YEC", payTo))).toBe(E.RETURN_ADDRESS);
    expect(reason(() => returnScriptOf("not-an-address", NET, "YEC", payTo))).toBe(E.RETURN_ADDRESS);
    expect(reason(() => returnScriptOf(payToAddr, NET, "YEC", payTo))).toBe(E.RETURN_ADDRESS);
  });
});

describe("client", () => {
  it("states the funder's address in the open, and every voucher returns the remainder there, never to C", async () => {
    const s = await setup();
    const p = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    expect(p.returnAddress).toBe(returnAddr);
    const v = T.parseTx(p.voucher.tx);
    expect(v.vout[1]!.scriptPubKey).toEqual(returnScript);
    const rec = (await s.client.storage.get(`${T.txid(T.parseTx(p.fundingTx))}:0`))!;
    expect(rec.returnAddress).toBe(returnAddr);
    const cScript = T.p2pkhScript(T.hash160(T.pubkeyFromPriv(T.hexToBytes(rec.clientPrivKey))));
    expect(v.vout.some((o) => T.equalBytes(o.scriptPubKey, cScript))).toBe(false);
  });

  it("a configured returnAddress wins over the funder's; with neither it refuses before funding", async () => {
    const s = await setup({ returnAddress: other });
    expect(((await s.pay()).payload as unknown as batch.BatchOpenPayload).returnAddress).toBe(other);
    const none = await setup({ funderWithoutReturn: true });
    await expect(none.pay()).rejects.toThrow(/no return address/);
    expect(none.fundings).toHaveLength(0);
    const bad = await setup({ returnAddress: payToAddr });
    await expect(bad.pay()).rejects.toThrow(/payTo/);
  });

  it("the close pays the remainder to the return address, and the refund goes there by default", async () => {
    const s = await opened();
    const close = s.wrap((await s.client.closePayload(s.channelId)).payload);
    const v = await s.server.manager.verify(close, s.req);
    const r = await s.server.manager.settle(v, 0n);
    const closeTx = T.parseTx(s.chain.sent.at(-1)!);
    expect(T.txid(closeTx)).toBe(r.transaction);
    expect(closeTx.vout[1]).toEqual({ value: 100_000n - 2000n, scriptPubKey: returnScript });

    const t = await opened();
    t.chain.tip = 1100;
    await t.client.refund(t.channelId);
    expect(T.parseTx(t.chain.sent.at(-1)!).vout.at(-1)!.scriptPubKey).toEqual(returnScript);
  });
});

describe("server", () => {
  it("refuses an open without a returnAddress, or with payTo's, one of another network, or garbage", async () => {
    const s = await setup();
    const p = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    const { returnAddress: _omit, ...without } = p;
    expect(await reasonOf(s.server.manager.verify(s.wrap(without), s.req))).toBe(E.PAYLOAD_TYPE);
    for (const addr of [payToAddr, T.encodeAddress("ycash:mainnet", "p2pkh", T.hexToBytes("dd".repeat(20))), "x"]) {
      expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p, returnAddress: addr }), s.req))).toBe(E.RETURN_ADDRESS);
    }
  });

  it("binds it: a first voucher or a later one paying the remainder elsewhere is refused", async () => {
    const s = await setup();
    const p = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    // the open says `other`, the voucher pays the funder's address
    expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p, returnAddress: other }), s.req))).toBe(E.VOUCHER_SHAPE);

    const o = await opened();
    const elsewhere = s.wrap({ type: "voucher", channelId: o.channelId, tx: await voucherTo(o, 4000n, T.addressToScript(other, NET)), cumulative: "4000" });
    expect(await reasonOf(o.server.manager.verify(elsewhere, o.req))).toBe(E.VOUCHER_SHAPE);
    expect((await o.server.manager.verify(await o.pay(), o.req)).cumulative).toBe(4000n);
  });
});

describe("facilitator", () => {
  it("binds the return address of an open it relayed; a stateless one still checks everything else", async () => {
    const s = await opened({ slack: 5 });
    const f = new BatchYcashFacilitatorScheme({ rpc: s.chain });
    // relays the open (already in a block): records the channel and its return script
    expect(await f.settle(s.first, s.req)).toMatchObject({ success: true });
    const elsewhere = s.wrap({ type: "voucher", channelId: s.channelId, tx: await voucherTo(s, 4000n, T.addressToScript(other, NET)), cumulative: "4000" });
    expect(await f.verify(elsewhere, s.req)).toMatchObject({ isValid: false, invalidReason: E.VOUCHER_SHAPE });
    expect(await f.verify(await s.pay(), s.req)).toMatchObject({ isValid: true });
    // a facilitator that never saw the open cannot know the address
    expect(await new BatchYcashFacilitatorScheme({ rpc: s.chain }).verify(elsewhere, s.req)).toMatchObject({ isValid: true });
  });
});
