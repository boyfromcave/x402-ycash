// The YED channel's builders (src/channel/yed.ts) and vectors/yed-channel/channel_yed.json.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { channel as C, tx as T, yed as Y } from "../../src/index.js";

const NET = "ycash:regtest" as const;
const h = T.hexToBytes;

interface Doc {
  branchId: string;
  channel: { clientPriv: string; serverPriv: string; funderPriv: string; refundHeight: number; depositCents: string; redeemScript: string; scriptPubKey: string; value: string; closeFee: string; payTo: string; returnAddress: string; clientScript: string };
  funding: { token: { outpoint: T.OutPoint; cents: number; value: string }; yecCoin: { outpoint: T.OutPoint; value: string }; assignments: Y.Assignment[]; opReturnIndex: number; fee: string; tx: string; txid: string };
  vouchers: { cumulative: string; serverCents: number; clientCents: number; assignments: Y.Assignment[]; sighash: string; voucher: string; close: string; closeTxid: string }[];
  refund: { lockTime: number; sequence: number; assignments: Y.Assignment[]; tx: string; txid: string };
}

const doc = JSON.parse(readFileSync(new URL("../../../../vectors/yed-channel/channel_yed.json", import.meta.url), "utf8")) as Doc;
const branch = parseInt(doc.branchId, 16);
const cPriv = h(doc.channel.clientPriv);
const sPriv = h(doc.channel.serverPriv);
const fPriv = h(doc.channel.funderPriv);
const fScript = T.p2pkhScript(T.hash160(T.pubkeyFromPriv(fPriv)));
const D = BigInt(doc.channel.depositCents);
const rs = h(doc.channel.redeemScript);
const ch = C.channelFromScript({
  outpoint: { txid: doc.funding.txid, vout: 0 }, redeemScript: rs, value: BigInt(doc.channel.value), closeFee: BigInt(doc.channel.closeFee),
  payToScript: T.addressToScript(doc.channel.payTo, NET),
});
const clientScript = h(doc.channel.clientScript);
// the client's YED returns to the open's returnAddress, the funder's ye… address, never to C
if (!T.equalBytes(T.addressToScript(doc.channel.returnAddress, NET), clientScript) || !T.equalBytes(clientScript, fScript)) throw new Error("vector: clientScript is not the returnAddress");
const assignmentsOf = (tx: T.Tx) => {
  const f = Y.findPayload(tx.vout);
  return f && !Y.isFindPayloadFailure(f) && f.payload.type === "transfer" ? { index: f.index, assignments: [...f.payload.assignments] } : null;
};

describe("the YED voucher layout", () => {
  const layout = C.yedVoucherLayout(D);
  it("is constant: payTo and client at TOKEN_VALUE, the TRANSFER of the split at vout 2", () => {
    for (const [cum, want] of [[100n, [{ vout: 0, cents: 100 }, { vout: 1, cents: 1900 }]], [1901n, [{ vout: 0, cents: 2000 }]], [2000n, [{ vout: 0, cents: 2000 }]]] as const) {
      const outs = layout({ channel: ch, cumulative: cum, clientScript });
      expect(outs.map((o) => o.value)).toEqual([10_000n, 10_000n, 0n]);
      expect(outs[0]?.scriptPubKey).toEqual(ch.payToScript);
      expect(outs[1]?.scriptPubKey).toEqual(clientScript);
      expect(assignmentsOf(T.newTx({ vout: outs }))).toEqual({ index: C.YED_TRANSFER_VOUT, assignments: want });
    }
  });
  it("refuses the floor, the deposit, V ≠ 2 × TOKEN_VALUE + closeFee, a missing client script or payTo as the client", () => {
    expect(() => layout({ channel: ch, cumulative: 99n, clientScript })).toThrow(/floor/);
    expect(() => layout({ channel: ch, cumulative: 2001n, clientScript })).toThrow(/exceeds/);
    expect(() => layout({ channel: { ...ch, value: ch.value + 1n }, cumulative: 100n, clientScript })).toThrow(/2 × TOKEN_VALUE/);
    expect(() => layout({ channel: ch, cumulative: 100n })).toThrow(/client output/);
    expect(() => layout({ channel: ch, cumulative: 100n, clientScript: ch.payToScript })).toThrow(/payTo/);
    // a YED holder is a key hash: the client's return output is never P2SH
    expect(() => layout({ channel: ch, cumulative: 100n, clientScript: T.p2shScript(h("cc".repeat(20))) })).toThrow(/P2PKH/);
  });
  it("binds the client output to the channel's return script in checkVoucherShape", () => {
    const v = C.buildVoucher({ channel: ch, cumulative: 500n, clientScript, clientPrivKey: cPriv, branchId: branch, layout });
    expect(C.checkVoucherShape(v, ch, 500n, { layout, clientScript })).toBeNull();
    expect(C.checkVoucherShape(v, ch, 500n, { layout, clientScript: T.p2pkhScript(h("ee".repeat(20))) })).toBe("outputs");
  });
  it("is what checkVoucherShape demands: a tampered TRANSFER is refused", () => {
    const v = C.buildVoucher({ channel: ch, cumulative: 500n, clientScript, clientPrivKey: cPriv, branchId: branch, layout });
    expect(C.checkVoucherShape(v, ch, 500n, { layout })).toBeNull();
    expect(C.checkVoucherShape(v, ch, 501n, { layout })).toBe("outputs");
    const tampered = { ...v, vout: [v.vout[0]!, v.vout[1]!, { value: 0n, scriptPubKey: Y.transferOpReturnScript([{ vout: 0, cents: 500 }]) }] };
    expect(C.checkVoucherShape(tampered, ch, 500n, { layout })).toBe("outputs");
    expect(C.checkVoucherShape(v, ch, 500n)).toBe("outputs"); // the YEC layout is another shape
  });
});

describe("funding and refund", () => {
  it("the funding assigns D to the P2SH output and the rest as YED change", () => {
    const b = C.buildYedFundingTx({ redeemScript: rs, depositCents: D, closeFee: 1500n, tokens: [{ ...doc.funding.token, value: 10_000n, scriptPubKey: fScript }], yecCoins: [{ ...doc.funding.yecCoin, value: 1_000_000n, scriptPubKey: fScript }], yedChangeScript: fScript, yecChangeScript: fScript });
    expect(b.tx.vout[0]).toEqual({ value: 21_500n, scriptPubKey: C.channelScriptPubKey(rs) });
    expect(b.assignments).toEqual([{ vout: 0, cents: 2000 }, { vout: 1, cents: 500 }]);
    expect(C.assignedTo(b.assignments, 0)).toBe(2000);
    expect(C.assignedTo(b.assignments, 5)).toBeUndefined();
  });
  it("the refund is the CLTV branch with a TRANSFER of all of D to the client's output", () => {
    const r = C.buildYedRefund({ channel: ch, depositCents: D, clientPrivKey: cPriv, toScript: clientScript, branchId: branch });
    expect(assignmentsOf(r)).toEqual({ index: 0, assignments: [{ vout: 1, cents: 2000 }] });
    expect(r.vout[1]?.scriptPubKey).toEqual(clientScript);
    expect(r.vout[1]!.value).toBe(21_500n - T.feeFloor(r));
    expect(r.lockTime).toBe(ch.refundHeight);
    expect(r.vin[0]!.sequence).toBe(0xfffffffe);
  });
});

describe("vectors/yed-channel/channel_yed.json", () => {
  it("reproduces the funding TRANSFER", () => {
    const tokens = [{ outpoint: doc.funding.token.outpoint, cents: doc.funding.token.cents, value: BigInt(doc.funding.token.value), scriptPubKey: fScript }];
    const yecCoins = [{ outpoint: doc.funding.yecCoin.outpoint, value: BigInt(doc.funding.yecCoin.value), scriptPubKey: fScript }];
    const b = C.buildYedFundingTx({ redeemScript: rs, depositCents: D, closeFee: BigInt(doc.channel.closeFee), tokens, yecCoins, yedChangeScript: fScript, yecChangeScript: fScript });
    expect(b.assignments).toEqual(doc.funding.assignments);
    expect(b.opReturnIndex).toBe(doc.funding.opReturnIndex);
    expect(b.fee.toString()).toBe(doc.funding.fee);
    const signed = C.signFundingTx(b.tx, b.inputs, [fPriv, fPriv], branch);
    expect(T.serializeTxHex(signed)).toBe(doc.funding.tx);
    expect(T.txid(signed)).toBe(doc.funding.txid);
  });

  it.each(doc.vouchers)("reproduces the voucher and close at $cumulative", (v) => {
    const layout = C.yedVoucherLayout(D);
    expect(Y.yedChannelSplit(Number(D), Number(v.cumulative))).toEqual({ serverCents: v.serverCents, clientCents: v.clientCents });
    expect(C.yedVoucherAssignments(D, BigInt(v.cumulative))).toEqual(v.assignments);
    const voucher = C.buildVoucher({ channel: ch, cumulative: BigInt(v.cumulative), clientScript, clientPrivKey: cPriv, branchId: branch, layout });
    expect(T.serializeTxHex(voucher)).toBe(v.voucher);
    expect(T.bytesToHex(C.voucherSighash(voucher, ch, branch))).toBe(v.sighash);
    const close = C.completeVoucher(T.parseTx(v.voucher), ch, sPriv, branch);
    expect(T.serializeTxHex(close)).toBe(v.close);
    expect(T.txid(close)).toBe(v.closeTxid);
    expect(assignmentsOf(close)).toEqual({ index: 2, assignments: v.assignments });
    expect(Y.validateTransferAssignments(v.assignments, 3, 2, { yedInCents: Number(D) })).toEqual({ valid: true, totalCents: Number(D) });
  });

  it("reproduces the refund", () => {
    const r = C.buildYedRefund({ channel: ch, depositCents: D, clientPrivKey: cPriv, toScript: clientScript, branchId: branch });
    expect(T.serializeTxHex(r)).toBe(doc.refund.tx);
    expect(T.txid(r)).toBe(doc.refund.txid);
    expect(assignmentsOf(r)?.assignments).toEqual(doc.refund.assignments);
    expect([r.lockTime, r.vin[0]!.sequence]).toEqual([doc.refund.lockTime, doc.refund.sequence]);
  });
});
