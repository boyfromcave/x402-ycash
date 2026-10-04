import { describe, expect, it } from "vitest";
import { channel as C, tx as T } from "../../src/index.js";

const h = T.hexToBytes;
const hex = T.bytesToHex;

// specs/scheme_batch_settlement_ycash.md, "Redeem script" example: valid compressed keys, the public
// keys of SHA-256("x402-ycash spec example client key C") and SHA-256("x402-ycash spec example server key S").
const SPEC_C = h("03efe7ffc36c3fed9fcd4f1b8de29a5a5a44faa7bf8418334518cf3a765df54ba6");
const SPEC_S = h("0289bb2b0ac2056bbc117fcee21dc12b8147066cea2d6ff9a1a650b8e444378435");
const SPEC_RS =
  "63522103efe7ffc36c3fed9fcd4f1b8de29a5a5a44faa7bf8418334518cf3a765df54ba6210289bb2b0ac2056bbc117fcee21dc12b8147066cea2d6ff9a1a650b8e44437843552ae670332522fb1752103efe7ffc36c3fed9fcd4f1b8de29a5a5a44faa7bf8418334518cf3a765df54ba6ac68";

const cPriv = h("11".repeat(32));
const sPriv = h("22".repeat(32));
const cPub = T.pubkeyFromPriv(cPriv);
const sPub = T.pubkeyFromPriv(sPriv);
const payTo = T.p2pkhScript(h("aa".repeat(20)));
const clientScript = T.p2pkhScript(T.hash160(cPub));
const BRANCH = 0x19bd2d2f;

function makeChannel(value = 101_500n, refundHeight = 2000): C.Channel {
  const redeemScript = C.buildChannelScript({ clientPubKey: cPub, serverPubKey: sPub, refundHeight });
  return C.channelFromScript({ outpoint: { txid: "ab".repeat(32), vout: 1 }, redeemScript, value, closeFee: 1500n, payToScript: payTo });
}

describe("redeem script", () => {
  it("matches the spec's bytes and HASH160", () => {
    const rs = C.buildChannelScript({ clientPubKey: SPEC_C, serverPubKey: SPEC_S, refundHeight: 3_101_234 });
    expect(hex(rs)).toBe(SPEC_RS);
    expect(rs.length).toBe(115);
    expect(hex(T.hash160(rs))).toBe("f702ca5dbbc301abd62ca7a92a563789b9721b86");
    expect(hex(C.channelScriptPubKey(rs))).toBe("a914f702ca5dbbc301abd62ca7a92a563789b9721b8687");
  });

  it("parses back exactly", () => {
    expect(C.parseChannelScript(h(SPEC_RS))).toEqual({ clientPubKey: SPEC_C, serverPubKey: SPEC_S, refundHeight: 3_101_234 });
    // small and large heights round-trip with their minimal pushes
    for (const t of [1, 16, 17, 127, 128, 65_535, 8_388_608, 499_999_999]) {
      const rs = C.buildChannelScript({ clientPubKey: cPub, serverPubKey: sPub, refundHeight: t });
      expect(C.parseChannelScript(rs)?.refundHeight).toBe(t);
    }
  });

  it("refuses any other script", () => {
    const rs = h(SPEC_RS);
    const withTrailing = T.concatBytes(rs, Uint8Array.of(0x61));
    const nonMinimalT = h(SPEC_RS.replace("670332522fb175", "67043252 2f00b175".replace(" ", "")));
    const sameKeys = h(SPEC_RS.replace(hex(SPEC_S), hex(SPEC_C)));
    const wrongOp = h(SPEC_RS.replace(/ac68$/, "ad68"));
    const uncompressed = T.buildScript([T.OP.OP_IF, T.OP.OP_2, h("04" + "c1".repeat(64)), SPEC_S, T.OP.OP_2, T.OP.OP_CHECKMULTISIG,
      T.OP.OP_ELSE, 3_101_234n, T.OP.OP_CHECKLOCKTIMEVERIFY, T.OP.OP_DROP, h("04" + "c1".repeat(64)), T.OP.OP_CHECKSIG, T.OP.OP_ENDIF]);
    const timeLock = T.buildScript([T.OP.OP_IF, T.OP.OP_2, SPEC_C, SPEC_S, T.OP.OP_2, T.OP.OP_CHECKMULTISIG,
      T.OP.OP_ELSE, 500_000_000n, T.OP.OP_CHECKLOCKTIMEVERIFY, T.OP.OP_DROP, SPEC_C, T.OP.OP_CHECKSIG, T.OP.OP_ENDIF]);
    for (const bad of [withTrailing, nonMinimalT, sameKeys, wrongOp, uncompressed, timeLock, rs.slice(0, 50), new Uint8Array()]) {
      expect(C.parseChannelScript(bad)).toBeNull();
    }
  });

  it("refuses C = S, an uncompressed key and a non-height t when building", () => {
    expect(() => C.buildChannelScript({ clientPubKey: cPub, serverPubKey: cPub, refundHeight: 10 })).toThrow(/differ/);
    expect(() => C.buildChannelScript({ clientPubKey: T.pubkeyFromPriv(cPriv, false), serverPubKey: sPub, refundHeight: 10 })).toThrow(/compressed/);
    expect(() => C.buildChannelScript({ clientPubKey: cPub, serverPubKey: sPub, refundHeight: 0 })).toThrow(/height/);
    expect(() => C.buildChannelScript({ clientPubKey: cPub, serverPubKey: sPub, refundHeight: 500_000_000 })).toThrow(/height/);
  });

  it("isValidCompressedPubKey also requires a curve point", () => {
    const notAPoint = h("03" + "5e".repeat(32)); // the spec's old illustrative key: the right shape, off the curve
    expect(C.isCompressedPubKey(notAPoint)).toBe(true);
    expect(C.isValidCompressedPubKey(notAPoint)).toBe(false);
    expect(C.isValidCompressedPubKey(SPEC_S)).toBe(true);
    expect(C.isValidCompressedPubKey(sPub)).toBe(true);
  });

  it("encodes the P2SH address for the network", () => {
    expect(C.channelAddress("ycash:mainnet", h(SPEC_RS))).toMatch(/^s[23]/);
    expect(T.decodeAddress(C.channelAddress("ycash:regtest", h(SPEC_RS)), "ycash:regtest").kind).toBe("p2sh");
  });
});

describe("channel ids", () => {
  it("channelId is <txid>:<vout> and the commitment id <channelId>@<cumulative>", () => {
    const id = C.channelIdOf({ txid: "ab".repeat(32), vout: 3 });
    expect(id).toBe(`${"ab".repeat(32)}:3`);
    expect(C.parseChannelId(id)).toEqual({ txid: "ab".repeat(32), vout: 3 });
    expect(C.commitmentIdOf(id, 26000n)).toBe(`${id}@26000`);
    for (const bad of ["", "ab:0", `${"AB".repeat(32)}:0`, `${"ab".repeat(32)}`, `${"ab".repeat(32)}:-1`, `${"ab".repeat(32)}:99999999999`]) {
      expect(C.parseChannelId(bad)).toBeNull();
    }
  });
});

describe("voucher outputs (YEC) and the close fee", () => {
  const ch = makeChannel(); // V = 101500, closeFee 1500, D = 100000

  it("pays payTo the cumulative and the client the remainder", () => {
    expect(C.yecVoucherOutputs({ channel: ch, cumulative: 2000n, clientScript })).toEqual([
      { value: 2000n, scriptPubKey: payTo },
      { value: 98_000n, scriptPubKey: clientScript },
    ]);
  });

  it("folds a remainder below dust (54 zat, X-F15) into payTo and keeps one of exactly 54", () => {
    expect(C.yecVoucherOutputs({ channel: ch, cumulative: 99_947n, clientScript })).toEqual([{ value: 100_000n, scriptPubKey: payTo }]);
    expect(C.yecVoucherOutputs({ channel: ch, cumulative: 100_000n })).toEqual([{ value: 100_000n, scriptPubKey: payTo }]);
    expect(C.yecVoucherOutputs({ channel: ch, cumulative: 99_946n, clientScript })[1]?.value).toBe(54n);
  });

  it("refuses a cumulative below dust or above D, a missing or payTo client script", () => {
    expect(() => C.yecVoucherOutputs({ channel: ch, cumulative: 53n, clientScript })).toThrow(/dust/);
    expect(C.yecVoucherOutputs({ channel: ch, cumulative: 54n, clientScript })[0]?.value).toBe(54n);
    expect(() => C.yecVoucherOutputs({ channel: ch, cumulative: 100_001n, clientScript })).toThrow(/exceeds/);
    expect(() => C.yecVoucherOutputs({ channel: ch, cumulative: 2000n })).toThrow(/client output/);
    expect(() => C.yecVoucherOutputs({ channel: ch, cumulative: 2000n, clientScript: payTo })).toThrow(/payTo/);
  });

  it("the default close fee is the close's fee floor (1500 zat, X-F3)", () => {
    const outs = C.yecVoucherOutputs({ channel: ch, cumulative: 2000n, clientScript });
    expect(C.closeFeeFloor(ch.redeemScript, outs)).toBe(C.DEFAULT_CLOSE_FEE);
    expect(C.closeFeeFloor(ch.redeemScript, outs.slice(0, 1))).toBe(C.DEFAULT_CLOSE_FEE);
    expect(C.yecDeposit(ch)).toBe(100_000n);
  });
});

describe("vouchers", () => {
  const ch = makeChannel();
  const v = C.buildVoucher({ channel: ch, cumulative: 2000n, clientScript, clientPrivKey: cPriv, branchId: BRANCH });

  it("spends the channel outpoint only, with nLockTime 0 and expiry 0, and the server slot empty", () => {
    expect(v.vin).toHaveLength(1);
    expect(v.vin[0]!.prevout).toEqual(ch.outpoint);
    expect(v.lockTime).toBe(0);
    expect(v.expiryHeight).toBe(0);
    const ss = C.parseCloseScriptSig(v.vin[0]!.scriptSig)!;
    expect(ss.sigS).toHaveLength(0);
    expect(hex(ss.redeemScript)).toBe(hex(ch.redeemScript));
    expect(hex(v.vin[0]!.scriptSig)).toBe(hex(T.p2shScriptSig([T.OP.OP_0, ss.sigC, T.OP.OP_0, T.OP.OP_1], ch.redeemScript)));
    expect(T.sigHashType(ss.sigC)).toBe(T.SIGHASH.ALL);
  });

  it("passes the shape and signature rules", () => {
    expect(C.checkVoucherShape(v, ch, 2000n)).toBeNull();
    expect(C.verifyVoucherSignature(v, ch, BRANCH)).toBe(true);
    expect(C.verifyVoucherSignature(v, ch, 0x76b809bb)).toBe(false); // another branch id
  });

  it("refuses each shape deviation", () => {
    const cases: [string, (t: T.Tx) => void, C.VoucherShapeError][] = [
      ["two inputs", (t) => t.vin.push({ ...t.vin[0]! }), "inputs"],
      ["another outpoint", (t) => (t.vin[0]!.prevout = { txid: "cd".repeat(32), vout: 1 }), "inputs"],
      ["lock time", (t) => (t.lockTime = 5), "lock_time"],
      ["expiry", (t) => (t.expiryHeight = 5), "expiry"],
      ["output value", (t) => (t.vout[0]!.value += 1n), "outputs"],
      ["extra output", (t) => t.vout.push({ value: 0n, scriptPubKey: payTo }), "outputs"],
      ["refund scriptSig", (t) => (t.vin[0]!.scriptSig = T.p2shScriptSig([h("30"), T.OP.OP_0], ch.redeemScript)), "script_sig"],
      ["other redeem script", (t) => (t.vin[0]!.scriptSig = T.p2shScriptSig([T.OP.OP_0, h("3001"), T.OP.OP_0, T.OP.OP_1], makeChannel(1n, 3000).redeemScript)), "redeem_script"],
    ];
    for (const [name, mutate, want] of cases) {
      const t = T.parseTx(T.serializeTx(v));
      mutate(t);
      expect(C.checkVoucherShape(t, ch, 2000n), name).toBe(want);
    }
    expect(C.checkVoucherShape(v, ch, 2001n)).toBe("outputs"); // a different cumulative
  });

  it("refuses a signature that is not SIGHASH_ALL or not by C", () => {
    const t = T.parseTx(T.serializeTx(v));
    const none = T.signInput(T.sighashV4(t, 0, ch.redeemScript, ch.value, T.SIGHASH.NONE, BRANCH), cPriv, T.SIGHASH.NONE);
    t.vin[0]!.scriptSig = T.p2shScriptSig([T.OP.OP_0, none, T.OP.OP_0, T.OP.OP_1], ch.redeemScript);
    expect(C.verifyVoucherSignature(t, ch, BRANCH)).toBe(false);
    const byS = C.buildVoucher({ channel: ch, cumulative: 2000n, clientScript, clientPrivKey: sPriv, branchId: BRANCH });
    expect(C.verifyVoucherSignature(byS, ch, BRANCH)).toBe(false);
  });

  it("server completion gives OP_0 <sigC> <sigS> OP_1 <rs> with both signatures valid", () => {
    const done = C.completeVoucher(v, ch, sPriv, BRANCH);
    const ss = C.parseCloseScriptSig(done.vin[0]!.scriptSig)!;
    const sh = C.voucherSighash(done, ch, BRANCH);
    expect(hex(done.vin[0]!.scriptSig)).toBe(hex(T.p2shScriptSig([T.OP.OP_0, ss.sigC, ss.sigS, T.OP.OP_1], ch.redeemScript)));
    expect(T.verifyInputSig(ss.sigC, sh, cPub)).toBe(true);
    expect(T.verifyInputSig(ss.sigS, sh, sPub)).toBe(true);
    expect(done.vin[0]!.scriptSig.length).toBeLessThanOrEqual(265);
    expect(C.checkVoucherShape(done, ch, 2000n)).toBe("script_sig");
    expect(C.checkVoucherShape(done, ch, 2000n, { allowCompleted: true })).toBeNull();
    expect(T.serializeTxHex({ ...done, vin: v.vin })).toBe(T.serializeTxHex(v)); // only the scriptSig changed
  });
});

describe("refund", () => {
  const ch = makeChannel(101_500n, 2000);

  it("takes the CLTV branch with nLockTime t and a non-final sequence", () => {
    const r = C.buildRefund({ channel: ch, clientPrivKey: cPriv, toScript: clientScript, branchId: BRANCH });
    expect(r.lockTime).toBe(2000);
    expect(r.vin[0]!.sequence).toBe(C.REFUND_SEQUENCE);
    expect(r.expiryHeight).toBe(0);
    const chunks = T.parseScript(r.vin[0]!.scriptSig);
    expect(chunks).toHaveLength(3);
    expect(chunks[1]!.op).toBe(T.OP.OP_0);
    expect(hex(chunks[2]!.data!)).toBe(hex(ch.redeemScript));
    const sh = T.sighashV4(r, 0, ch.redeemScript, ch.value, T.SIGHASH.ALL, BRANCH);
    expect(T.verifyInputSig(chunks[0]!.data!, sh, cPub)).toBe(true);
    expect(r.vout).toHaveLength(1);
    expect(ch.value - r.vout[0]!.value).toBe(T.feeFloor(r));
  });

  it("accepts a later lock time and refuses one below t", () => {
    expect(C.buildRefund({ channel: ch, clientPrivKey: cPriv, toScript: clientScript, branchId: BRANCH, lockTime: 2500 }).lockTime).toBe(2500);
    expect(() => C.buildRefund({ channel: ch, clientPrivKey: cPriv, toScript: clientScript, branchId: BRANCH, lockTime: 1999 })).toThrow(/≥ t/);
  });

  it("puts extra outputs (the YED TRANSFER) before the client's", () => {
    const opRet = T.opReturnScript(h("594203"));
    const r = C.buildRefund({ channel: ch, clientPrivKey: cPriv, toScript: clientScript, branchId: BRANCH, extraOutputs: [{ value: 0n, scriptPubKey: opRet }], fee: 2000n });
    expect(r.vout.map((o) => o.value)).toEqual([0n, 99_500n]);
  });
});

describe("funding", () => {
  const coinKey = h("33".repeat(32));
  const coinSpk = T.p2pkhScript(T.hash160(T.pubkeyFromPriv(coinKey)));
  const coin = { outpoint: { txid: "ee".repeat(32), vout: 0 }, value: 1_000_000n, scriptPubKey: coinSpk };
  const rs = makeChannel().redeemScript;

  it("pays V to the P2SH script at vout 0 with change, at the fee floor, signed", () => {
    const tx = C.buildFundingTx({ inputs: [coin], redeemScript: rs, value: 101_500n, changeScript: clientScript });
    expect(tx.vout[0]).toEqual({ value: 101_500n, scriptPubKey: C.channelScriptPubKey(rs) });
    expect(C.findChannelVout(tx, rs)).toBe(C.FUNDING_VOUT);
    const fee = 1_000_000n - tx.vout.reduce((s, o) => s + o.value, 0n);
    const signed = C.signFundingTx(tx, [coin], [coinKey], BRANCH);
    expect(fee).toBe(1000n);
    expect(fee).toBeGreaterThanOrEqual(T.feeFloor(signed));
    const [sig] = T.parseScript(signed.vin[0]!.scriptSig);
    expect(T.verifyInputSig(sig!.data!, T.sighashV4(signed, 0, coinSpk, coin.value, T.SIGHASH.ALL, BRANCH), T.pubkeyFromPriv(coinKey))).toBe(true);
  });

  it("drops change below dust and refuses inputs that cannot pay", () => {
    const tx = C.buildFundingTx({ inputs: [coin], redeemScript: rs, value: 1_000_000n - 1000n - 50n, changeScript: clientScript });
    expect(tx.vout).toHaveLength(1);
    expect(() => C.buildFundingTx({ inputs: [coin], redeemScript: rs, value: 1_000_000n, changeScript: clientScript })).toThrow(/cannot pay/);
    expect(() => C.signFundingTx(C.buildFundingTx({ inputs: [coin], redeemScript: rs, value: 1000n, changeScript: clientScript }), [coin], [cPriv], BRANCH)).toThrow(/P2PKH coin of its key/);
  });
});
