// Rule-level tests of the ZIP-243 sighash; byte-level agreement with the node is in tx.vectors.test.ts.
import { describe, expect, it } from "vitest";
import { SIGHASH, bytesToHex, newTx, p2pkhScript, sighashV4, type Tx } from "../../src/tx/index.js";

const SAPLING = 0x76b809bb;
const CANOPY = 0x19bd2d2f;
const VAULT = 0x6d5b7a31; // the Ycash Vault network upgrade, after Canopy
const code = p2pkhScript(new Uint8Array(20).fill(1));

function tx3(): Tx {
  const t = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);
  return newTx({
    vin: [0, 1, 2].map((i) => ({ prevout: { txid: t(i + 1), vout: i }, scriptSig: new Uint8Array(), sequence: 0xffffffff - i })),
    vout: [0, 1, 2].map((i) => ({ value: BigInt(1000 * (i + 1)), scriptPubKey: p2pkhScript(new Uint8Array(20).fill(i + 10)) })),
    expiryHeight: 77,
  });
}

const h = (tx: Tx, i: number | null, ht: number, branch = SAPLING, amount = 5000n): string =>
  bytesToHex(sighashV4(tx, i, code, amount, ht, branch));

describe("sighashV4 (ZIP-243)", () => {
  it("binds the consensus branch id, the amount, the script code and the input index", () => {
    const tx = tx3();
    const base = h(tx, 0, SIGHASH.ALL);
    expect(h(tx, 0, SIGHASH.ALL, CANOPY)).not.toBe(base);
    expect(h(tx, 0, SIGHASH.ALL, SAPLING, 5001n)).not.toBe(base);
    expect(h(tx, 1, SIGHASH.ALL)).not.toBe(base);
    expect(bytesToHex(sighashV4(tx, 0, new Uint8Array([0x51]), 5000n, SIGHASH.ALL, SAPLING))).not.toBe(base);
  });

  it("Vault (6d5b7a31) is one more personalisation: same preimage, a different digest from Canopy's", () => {
    const tx = tx3();
    for (const ht of [SIGHASH.ALL, SIGHASH.NONE, SIGHASH.SINGLE, SIGHASH.ALL | SIGHASH.ANYONECANPAY]) {
      expect(h(tx, 0, ht, VAULT)).not.toBe(h(tx, 0, ht, CANOPY));
      expect(h(tx, 0, ht, VAULT)).toBe(h(tx, 0, ht, VAULT));
    }
  });

  it("ALL commits to every input, sequence, output, lock time and expiry", () => {
    const base = h(tx3(), 0, SIGHASH.ALL);
    const mutations: ((t: Tx) => void)[] = [
      (t) => { t.vin[2]!.sequence = 0; },
      (t) => { t.vin[1]!.prevout.vout = 9; },
      (t) => { t.vout[2]!.value += 1n; },
      (t) => { t.lockTime = 1; },
      (t) => { t.expiryHeight = 78; },
      (t) => { t.vin[0]!.scriptSig = Uint8Array.of(1); }, // scriptSigs are not committed
    ];
    const changed = mutations.map((m) => { const t = tx3(); m(t); return h(t, 0, SIGHASH.ALL) !== base; });
    expect(changed).toEqual([true, true, true, true, true, false]);
  });

  it("ANYONECANPAY ignores the other inputs", () => {
    const t = tx3();
    const base = h(t, 1, SIGHASH.ALL | SIGHASH.ANYONECANPAY);
    t.vin[0]!.prevout.vout = 42;
    t.vin[2]!.sequence = 1;
    expect(h(t, 1, SIGHASH.ALL | SIGHASH.ANYONECANPAY)).toBe(base);
    t.vin.splice(2, 1);
    expect(h(t, 1, SIGHASH.ALL | SIGHASH.ANYONECANPAY)).toBe(base);
    t.vout[0]!.value = 1n;
    expect(h(t, 1, SIGHASH.ALL | SIGHASH.ANYONECANPAY)).not.toBe(base);
  });

  it("NONE ignores the outputs and the other inputs' sequences", () => {
    const t = tx3();
    const base = h(t, 0, SIGHASH.NONE);
    t.vout = [];
    t.vin[1]!.sequence = 5;
    expect(h(t, 0, SIGHASH.NONE)).toBe(base);
    t.vin[1]!.prevout.vout = 99; // prevouts are still committed
    expect(h(t, 0, SIGHASH.NONE)).not.toBe(base);
  });

  it("SINGLE commits only to the output at the input's index, and to none past the last output", () => {
    const t = tx3();
    const base = h(t, 1, SIGHASH.SINGLE);
    t.vout[0]!.value = 1n;
    t.vout[2]!.value = 1n;
    expect(h(t, 1, SIGHASH.SINGLE)).toBe(base);
    t.vout[1]!.value = 1n;
    expect(h(t, 1, SIGHASH.SINGLE)).not.toBe(base);
    const u = tx3();
    u.vout = u.vout.slice(0, 2);
    const past = h(u, 2, SIGHASH.SINGLE);
    u.vout = [u.vout[0]!];
    expect(h(u, 2, SIGHASH.SINGLE)).toBe(past); // hashOutputs is zero either way
  });

  it("hashes the joinSplitSig / Sapling form with no input (inputIndex null)", () => {
    const t = tx3();
    expect(h(t, null, SIGHASH.ALL)).toMatch(/^[0-9a-f]{64}$/);
    expect(h(t, null, SIGHASH.ALL)).not.toBe(h(t, 0, SIGHASH.ALL));
    expect(h(t, null, SIGHASH.SINGLE)).toBe(h({ ...t, vout: [] }, null, SIGHASH.SINGLE));
  });

  it("commits Sapling spends without their spendAuthSig, and Sapling outputs whole", () => {
    const t = tx3();
    const f = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
    t.shieldedSpends = [{ cv: f(32, 1), anchor: f(32, 2), nullifier: f(32, 3), rk: f(32, 4), zkproof: f(192, 5), spendAuthSig: f(64, 6) }];
    t.shieldedOutputs = [{ cv: f(32, 7), cmu: f(32, 8), ephemeralKey: f(32, 9), encCiphertext: f(580, 1), outCiphertext: f(80, 2), zkproof: f(192, 3) }];
    t.bindingSig = f(64, 0);
    const base = h(t, 0, SIGHASH.ALL);
    t.shieldedSpends[0]!.spendAuthSig = f(64, 7);
    t.bindingSig = f(64, 1);
    expect(h(t, 0, SIGHASH.ALL)).toBe(base);
    t.shieldedSpends[0]!.zkproof = f(192, 6);
    expect(h(t, 0, SIGHASH.ALL)).not.toBe(base);
    const u = { ...t, shieldedOutputs: [{ ...t.shieldedOutputs[0]!, encCiphertext: f(580, 9) }] };
    expect(h(u, 0, SIGHASH.ALL)).not.toBe(h(t, 0, SIGHASH.ALL));
    expect(h({ ...t, valueBalance: 1n }, 0, SIGHASH.ALL)).not.toBe(h(t, 0, SIGHASH.ALL));
  });

  it("refuses an input index out of range", () => {
    expect(() => h(tx3(), 3, SIGHASH.ALL)).toThrow(/out of range/);
    expect(() => h(tx3(), -1, SIGHASH.ALL)).toThrow(/out of range/);
  });
});
