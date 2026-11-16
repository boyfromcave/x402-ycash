// Copyright (c) 2026 The Ycash developers. MIT License.
import { describe, expect, it } from "vitest";
import { exact, tx as T } from "x402-ycash-mechanism";
import { buildSplit, MAX_SPLIT_OUTPUTS } from "../src/split.js";
import { parseCli, run } from "../src/index.js";

const NET = "ycash:regtest" as const;
const priv = T.hexToBytes("11".repeat(32));
const wif = T.encodeWif(priv, NET);
const pub = T.pubkeyFromPriv(priv);
const script = T.p2pkhScript(T.hash160(pub));
const coin = (value: bigint, confirmations = 1, i = 0): exact.Coin => ({ txid: String(i).padStart(64, "a"), vout: i, value, scriptPubKey: script, confirmations });
const opts = { wif, network: NET, minOutput: 20_000n, height: 100, branchId: 0x6d5b7a31 };

describe("split", () => {
  it("spends the confirmed coins into N equal outputs to the key itself, signed for the branch, at the fee floor", () => {
    const plan = buildSplit([coin(1_000_000n, 1, 0), coin(500_000n, 0, 1), coin(200_000n, 3, 2)], { ...opts, count: 10 });
    const t = T.parseTx(plan.hex);
    expect(t.vin.map((i) => i.prevout.vout).sort()).toEqual([0, 2]); // the unconfirmed coin is left alone
    expect(t.vout).toHaveLength(10);
    expect(t.vout.every((o) => o.value === plan.each && T.equalBytes(o.scriptPubKey, script))).toBe(true);
    expect(plan.each * 10n + plan.fee).toBe(1_200_000n);
    expect(plan.fee).toBeGreaterThanOrEqual(exact.draftFee(2, t.vout));
    expect(plan.fee - exact.draftFee(2, t.vout)).toBeLessThan(10n);
    expect(t.expiryHeight).toBe(120);
    const values = [1_000_000n, 200_000n];
    t.vin.forEach((input, i) => {
      const sig = input.scriptSig.slice(1, 1 + (input.scriptSig[0] as number));
      const digest = T.sighashV4(t, i, script, values[i] as bigint, T.SIGHASH.ALL, opts.branchId);
      expect(T.verifyInputSig(sig, digest, pub)).toBe(true);
    });
    expect(plan.txid).toBe(T.txid(t));
  });
  it("refuses dust, too many outputs, and a key with no confirmed coin", () => {
    expect(() => buildSplit([coin(100_000n)], { ...opts, count: 10 })).toThrow(/below the smallest allowed.*at most 4/);
    expect(() => buildSplit([coin(100_000_000n)], { ...opts, count: MAX_SPLIT_OUTPUTS + 1 })).toThrow(/--count must be 2\.\.50/);
    expect(() => buildSplit([coin(100_000_000n)], { ...opts, count: 1 })).toThrow(/--count/);
    expect(() => buildSplit([coin(100_000n, 0)], { ...opts, count: 2 })).toThrow(/no confirmed coin/);
    expect(() => buildSplit([{ ...coin(100_000n), scriptPubKey: T.p2pkhScript(new Uint8Array(20)) }], { ...opts, count: 2 })).toThrow(/no confirmed coin/);
  });
  it("needs a key and --count", async () => {
    const errs: string[] = [];
    const io = { out: () => undefined, err: (l: string) => errs.push(l) };
    const env = { X402_RPC_URL: "http://127.0.0.1:1", X402_RPC_USER: "u", X402_RPC_PASSWORD: "p" };
    expect(await run(["split", "--count", "4"], env, io)).toBe(2);
    expect(errs.join("")).toMatch(/split needs --wif-file/);
    expect(await run(["split", "--wif", wif], env, io)).toBe(2);
    expect(errs.join("")).toMatch(/split needs --count/);
    expect(parseCli(["split", "--count", "3", "--min-output", "30000"]).values["min-output"]).toBe("30000");
  });
});
