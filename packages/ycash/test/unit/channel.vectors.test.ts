import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { channel as C, tx as T } from "../../src/index.js";

interface Doc {
  branchId: string;
  specExample: { clientPubKey: string; serverPubKey: string; refundHeight: number; redeemScript: string; hash160: string };
  channel: { clientPriv: string; serverPriv: string; refundHeight: number; redeemScript: string; scriptPubKey: string; outpoint: T.OutPoint; value: string; closeFee: string; payTo: string; returnAddress: string; clientScript: string };
  vouchers: { cumulative: string; sighash: string; voucher: string; close: string; closeTxid: string }[];
  refund: { lockTime: number; sequence: number; tx: string; txid: string };
}

const doc = JSON.parse(readFileSync(new URL("../../../../vectors/channel/channel_yec.json", import.meta.url), "utf8")) as Doc;
const h = T.hexToBytes;

describe("vectors/channel/channel_yec.json", () => {
  const branch = parseInt(doc.branchId, 16);
  const cPriv = h(doc.channel.clientPriv);
  const sPriv = h(doc.channel.serverPriv);
  const rs = C.buildChannelScript({ clientPubKey: T.pubkeyFromPriv(cPriv), serverPubKey: T.pubkeyFromPriv(sPriv), refundHeight: doc.channel.refundHeight });
  const ch = C.channelFromScript({ outpoint: doc.channel.outpoint, redeemScript: rs, value: BigInt(doc.channel.value), closeFee: BigInt(doc.channel.closeFee), payToScript: T.addressToScript(doc.channel.payTo, "ycash:regtest") });

  it("reproduces the spec example and the channel script", () => {
    const e = doc.specExample;
    const ers = C.buildChannelScript({ clientPubKey: h(e.clientPubKey), serverPubKey: h(e.serverPubKey), refundHeight: e.refundHeight });
    expect(T.bytesToHex(ers)).toBe(e.redeemScript);
    expect(T.bytesToHex(T.hash160(ers))).toBe(e.hash160);
    expect(T.bytesToHex(rs)).toBe(doc.channel.redeemScript);
    expect(T.bytesToHex(C.channelScriptPubKey(rs))).toBe(doc.channel.scriptPubKey);
    // the remainder goes to the open's returnAddress, not to C's key hash
    expect(T.bytesToHex(T.addressToScript(doc.channel.returnAddress, "ycash:regtest"))).toBe(doc.channel.clientScript);
    expect(doc.channel.clientScript).not.toBe(T.bytesToHex(T.p2pkhScript(T.hash160(T.pubkeyFromPriv(cPriv)))));
  });

  it.each(doc.vouchers)("reproduces the voucher and close at $cumulative", (v) => {
    const voucher = C.buildVoucher({ channel: ch, cumulative: BigInt(v.cumulative), clientScript: h(doc.channel.clientScript), clientPrivKey: cPriv, branchId: branch });
    expect(T.serializeTxHex(voucher)).toBe(v.voucher);
    expect(T.bytesToHex(C.voucherSighash(voucher, ch, branch))).toBe(v.sighash);
    const close = C.completeVoucher(T.parseTx(v.voucher), ch, sPriv, branch);
    expect(T.serializeTxHex(close)).toBe(v.close);
    expect(T.txid(close)).toBe(v.closeTxid);
    expect(C.checkVoucherShape(T.parseTx(v.voucher), ch, BigInt(v.cumulative))).toBeNull();
  });

  it("reproduces the refund", () => {
    const r = C.buildRefund({ channel: ch, clientPrivKey: cPriv, toScript: h(doc.channel.clientScript), branchId: branch });
    expect(T.serializeTxHex(r)).toBe(doc.refund.tx);
    expect(r.lockTime).toBe(doc.refund.lockTime);
    expect(r.vin[0]!.sequence).toBe(doc.refund.sequence);
  });
});
