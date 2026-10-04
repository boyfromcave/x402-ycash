// The non-burning TRANSFER builder (src/yed/build.ts) and the overlay-verdict readers (src/yed/verdict.ts).
import { describe, expect, it } from "vitest";
import { tx as T, yed } from "../../src/index.js";
import type { YedValidation } from "../../src/node/index.js";

const spk = (b: number) => T.p2pkhScript(new Uint8Array(20).fill(b));
const PAYER = spk(1);
const PAYTO = spk(2);
const token = (cents: number, n: number): yed.TokenCoin => ({ outpoint: { txid: n.toString(16).padStart(64, "a"), vout: 0 }, cents, value: 10_000n, scriptPubKey: PAYER });
const yec = (value: bigint, n: number): yed.YecCoin => ({ outpoint: { txid: n.toString(16).padStart(64, "b"), vout: 1 }, value, scriptPubKey: PAYER });

describe("selectTokenCoins: never a change in (0, $1.00)", () => {
  it("takes an exact coin first", () => {
    expect(yed.selectTokenCoins([token(5000, 1), token(250, 2)], 250)).toEqual({ coins: [token(250, 2)], changeCents: 0 });
  });
  it("goes largest-first and returns a change of at least $1.00", () => {
    expect(yed.selectTokenCoins([token(300, 1), token(5000, 2)], 100)).toEqual({ coins: [token(5000, 2)], changeCents: 4900 });
  });
  it("cures a sub-dollar change with one more (the smallest) coin", () => {
    // 1,000 for 950 leaves 50 cents, which would burn everything: add the 300 for a change of 350
    const r = yed.selectTokenCoins([token(1000, 1), token(300, 2), token(400, 3)], 950);
    expect(r.coins.map((c) => c.cents)).toEqual([1000, 300]);
    expect(r.changeCents).toBe(350);
  });
  it("refuses rather than burn when no selection clears the floor", () => {
    expect(() => yed.selectTokenCoins([token(1000, 1)], 950)).toThrow(/would burn/);
  });
  it("refuses when the coins do not cover the amount", () => {
    expect(() => yed.selectTokenCoins([token(500, 1), token(200, 2)], 800)).toThrow(/insufficient YED: 700/);
  });
  it("refuses an amount outside [$1.00, $100,000]", () => {
    expect(() => yed.selectTokenCoins([token(5000, 1)], 50)).toThrow(RangeError);
    expect(() => yed.selectTokenCoins([token(5000, 1)], 10_000_001)).toThrow(RangeError);
  });
});

describe("buildYedTransfer", () => {
  const base = (over: Partial<yed.BuildYedTransferParams> = {}) =>
    yed.buildYedTransfer({ recipients: [{ scriptPubKey: PAYTO, cents: 2500 }], tokens: [token(5000, 1)], yecCoins: [yec(100_000n, 1)], yedChangeScript: PAYER, yecChangeScript: PAYER, expiryHeight: 77, ...over });

  it("lays out payTo, YED change, the OP_RETURN, YEC change; every cent assigned, the fee at the floor", () => {
    const b = base();
    expect(b.tx.vout.map((o) => o.value)).toEqual([10_000n, 10_000n, 0n, 10_000n + 100_000n - 20_000n - b.fee]);
    expect(b.assignments).toEqual([{ vout: 0, cents: 2500 }, { vout: 1, cents: 2500 }]);
    expect(b.opReturnIndex).toBe(2);
    const found = yed.findPayload(b.tx.vout);
    expect(found).toMatchObject({ index: 2, payload: { type: "transfer", assignments: b.assignments } });
    expect(b.fee).toBe(T.feeFloor({ ...b.tx, vin: b.tx.vin.map((i) => ({ ...i, scriptSig: new Uint8Array(108) })) }));
    expect(b.tx.expiryHeight).toBe(77);
    expect(b.inputs.map((i) => i.outpoint.txid[63])).toEqual(["1", "1"]); // token first, then YEC
    expect(b.tx.vin.every((i) => i.scriptSig.length === 0)).toBe(true);
  });
  it("omits the YED change when the tokens match exactly", () => {
    const b = base({ tokens: [token(2500, 1)] });
    expect(b.assignments).toEqual([{ vout: 0, cents: 2500 }]);
    expect(b.opReturnIndex).toBe(1);
    expect(b.changeCents).toBe(0);
  });
  it("adds YEC coins only as needed, and folds a sub-dust remainder into the fee", () => {
    const b = base({ tokens: [token(2500, 1)], yecCoins: [yec(1_200n, 1)] }); // 10,000 + 1,200 − 10,000 = 1,200: one output, fee 1,200
    expect(b.tx.vout).toHaveLength(2);
    expect(b.fee).toBe(1_200n);
  });
  it("refuses a recipient set that would burn, and coins that cannot pay the YEC", () => {
    expect(() => base({ recipients: [{ scriptPubKey: PAYTO, cents: 50 }], tokens: [token(50, 1)] })).toThrow(/would burn/);
    expect(() => base({ recipients: [{ scriptPubKey: PAYTO, cents: 4950 }] })).toThrow(/change 50 cents would burn/);
    expect(() => base({ yecCoins: [] })).toThrow(/insufficient YEC/);
  });
  it("carries a recipient's own YEC value (a channel output)", () => {
    const b = base({ recipients: [{ scriptPubKey: PAYTO, cents: 2500, value: 21_500n }] });
    expect(b.tx.vout[0]?.value).toBe(21_500n);
  });
});

describe("checkTransferVerdict and decodedTransferOf", () => {
  const ok: YedValidation = {
    valid: true, verdict: "ok", type: "transfer", path: "", yedIn: 500, yedOut: 500, burned: 0, feeZat: 1000, payee: null,
    blockValid: true, wouldBeRejected: false, mempoolExpiryOk: true, unconfirmedInputs: [],
  };
  it("accepts ok and names each problem", () => {
    expect(yed.checkTransferVerdict(ok, { yedIn: 500 })).toBeNull();
    expect(yed.checkTransferVerdict({ ...ok, valid: false })?.problem).toBe("scripts");
    expect(yed.checkTransferVerdict({ ...ok, valid: false }, { scripts: false })).toBeNull();
    expect(yed.checkTransferVerdict({ ...ok, unconfirmedInputs: [{ txid: "aa", vout: 1 }] })?.problem).toBe("unconfirmed_input");
    expect(yed.checkTransferVerdict({ ...ok, type: "none" })?.problem).toBe("type");
    expect(yed.checkTransferVerdict({ ...ok, verdict: "burned", yedOut: 400, burned: 100 })?.problem).toBe("verdict");
    expect(yed.checkTransferVerdict({ ...ok, verdict: "OK" })?.problem).toBe("verdict"); // the node writes lowercase
    expect(yed.checkTransferVerdict({ ...ok, burned: 1 })?.problem).toBe("burned");
    expect(yed.checkTransferVerdict({ ...ok, yedOut: 499 })?.problem).toBe("burned");
    expect(yed.checkTransferVerdict(ok, { yedIn: 600 })?.problem).toBe("yed_in");
  });
  it("reads yed_decodepayload's transfer, and nothing else", () => {
    const p = { valid: true, version: 3, type: "transfer", reason: "", opReturnIndex: 2, assignments: [{ vout: 0, cents: 100 }] };
    expect(yed.decodedTransferOf(p)).toEqual({ opReturnIndex: 2, assignments: [{ vout: 0, cents: 100 }] });
    expect(yed.decodedTransferOf({ ...p, type: "redeem" })).toBeNull();
    expect(yed.decodedTransferOf({ ...p, valid: false })).toBeNull();
    expect(yed.decodedTransferOf({ valid: true, version: 3, type: "transfer", assignments: [] })).toBeNull(); // no opReturnIndex: not from a tx
    expect(yed.decodedTransferOf({ ...p, assignments: [{ vout: "0", cents: 1 }] })).toBeNull();
  });
  it("compares assignment sets regardless of order", () => {
    const a = [{ vout: 0, cents: 100 }, { vout: 1, cents: 200 }];
    expect(yed.sameAssignments(a, [...a].reverse())).toBe(true);
    expect(yed.sameAssignments(a, [{ vout: 0, cents: 100 }])).toBe(false);
    expect(yed.sameAssignments(a, [{ vout: 0, cents: 100 }, { vout: 1, cents: 201 }])).toBe(false);
  });
});
