import { describe, expect, it } from "vitest";
import { feeFloor, logicalActions, newTx, p2pkhScript, txFee, type Tx, type TxIn, type TxOut } from "../../src/tx/index.js";
import { JOINSPLIT_SIZE } from "../../src/tx/tx.js";

const input = (scriptSigLen = 107): TxIn => ({ prevout: { txid: "11".repeat(32), vout: 0 }, scriptSig: new Uint8Array(scriptSigLen), sequence: 0xffffffff });
const output = (value = 1000n): TxOut => ({ value, scriptPubKey: p2pkhScript(new Uint8Array(20)) });
const tx = (nin: number, nout: number, sigLen = 107): Tx =>
  newTx({ vin: Array.from({ length: nin }, () => input(sigLen)), vout: Array.from({ length: nout }, () => output()) });

describe("logicalActions (ZIP-317, ycash6/src/zip317.cpp:24-38)", () => {
  it("counts transparent inputs in 150-byte units and outputs in 34-byte units", () => {
    // a signed P2PKH input is 32+4+1+107+4 = 148 bytes; a P2PKH output is 8+1+25 = 34 bytes
    expect(logicalActions(tx(1, 2))).toBe(2);
    expect(logicalActions(tx(1, 1))).toBe(1);
    expect(logicalActions(tx(3, 3))).toBe(3);
    expect(logicalActions(tx(1, 1, 300))).toBe(3); // a channel close input (~308 bytes)
    expect(logicalActions(tx(0, 0))).toBe(0);
    // input bytes are summed before dividing: 2 × 148 = 296 → 2
    expect(logicalActions(tx(2, 1))).toBe(2);
  });

  it("adds 2 per JoinSplit and max(spends, outputs) for Sapling", () => {
    const t = tx(1, 1);
    t.joinSplits = [new Uint8Array(JOINSPLIT_SIZE)];
    expect(logicalActions(t)).toBe(1 + 2);
    const f = (n: number): Uint8Array => new Uint8Array(n);
    const spend = { cv: f(32), anchor: f(32), nullifier: f(32), rk: f(32), zkproof: f(192), spendAuthSig: f(64) };
    const out = { cv: f(32), cmu: f(32), ephemeralKey: f(32), encCiphertext: f(580), outCiphertext: f(80), zkproof: f(192) };
    t.shieldedSpends = [spend];
    t.shieldedOutputs = [out, out, out];
    expect(logicalActions(t)).toBe(1 + 2 + 3);
  });
});

describe("feeFloor = max(1000, 500 × max(2, actions)) (plan S-6)", () => {
  it("is 1000 zat for a 1-in-2-out payment and grows by 500 per action past two", () => {
    expect(feeFloor(tx(1, 2))).toBe(1000n);
    expect(feeFloor(tx(1, 1))).toBe(1000n);
    expect(feeFloor(tx(3, 3))).toBe(1500n);
    expect(feeFloor(tx(1, 1, 300))).toBe(1500n);
    expect(feeFloor(tx(5, 2))).toBe(2500n);
    expect(feeFloor(tx(0, 0))).toBe(1000n);
  });
});

describe("txFee", () => {
  it("is inputs − outputs + valueBalance + Σ(vpub_new − vpub_old)", () => {
    const t = tx(2, 1);
    t.vout[0]!.value = 9000n;
    expect(txFee(t, [5000n, 5000n])).toBe(1000n);
    t.valueBalance = 2000n; // value leaving the Sapling pool
    expect(txFee(t, [5000n, 5000n])).toBe(3000n);
    const js = new Uint8Array(JOINSPLIT_SIZE);
    const dv = new DataView(js.buffer);
    dv.setBigInt64(0, 700n, true); // vpub_old: into the Sprout pool
    dv.setBigInt64(8, 200n, true); // vpub_new: out of it
    t.joinSplits = [js];
    expect(txFee(t, [5000n, 5000n])).toBe(2500n);
  });

  it("needs one value per input", () => {
    expect(() => txFee(tx(2, 1), [1n])).toThrow(/one input value/);
  });
});
