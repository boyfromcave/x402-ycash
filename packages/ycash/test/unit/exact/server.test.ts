// The exact resource-server side: prices and the 402's extra (spec "PaymentRequirements").
import { describe, expect, it } from "vitest";
import { exact } from "../../../src/index.js";
import { NETWORK, requirements, testKey } from "./fakeNode.js";

const merchant = testKey(2);
const kind = (extra?: Record<string, unknown>) => ({ x402Version: 2, scheme: "exact", network: NETWORK, ...(extra ? { extra } : {}) }) as const;
const base = (amount = "250000", extra: Record<string, unknown> = {}) => ({ ...requirements(merchant.address, amount), extra });
const $50 = new exact.FixedPriceSource(50_000_000n);

describe("parsePrice", () => {
  const s = new exact.ExactYcashServerScheme({ priceSource: $50 });
  it("YEC and YED money strings", async () => {
    expect(await s.parsePrice("0.0025 YEC", NETWORK)).toEqual({ amount: "250000", asset: "YEC", extra: {} });
    expect(await s.parsePrice("25 YED", NETWORK)).toEqual({ amount: "2500", asset: "YED", extra: {} });
  });
  it("USD through the price source, rounded up", async () => {
    expect(await s.parsePrice("$0.10", NETWORK)).toEqual({ amount: "200000", asset: "YEC", extra: {} });
    expect(await s.parsePrice("0.10 USD", NETWORK)).toEqual({ amount: "200000", asset: "YEC", extra: {} });
    expect((await new exact.ExactYcashServerScheme({ priceSource: new exact.FixedPriceSource(30_000_000n) }).parsePrice("$0.01", NETWORK)).amount).toBe("33334");
  });
  it("asset amounts pass through, validated", async () => {
    expect(await s.parsePrice({ amount: "1000", asset: "YEC" }, NETWORK)).toEqual({ amount: "1000", asset: "YEC", extra: {} });
    await expect(s.parsePrice({ amount: "53", asset: "YEC" }, NETWORK)).rejects.toThrow(/dust/);
    await expect(s.parsePrice({ amount: "99", asset: "YED" }, NETWORK)).rejects.toThrow(/cents/);
    await expect(s.parsePrice({ amount: "1", asset: "USDC" }, NETWORK)).rejects.toThrow(/asset/);
  });
  it("needs a price source for USD", async () => {
    await expect(new exact.ExactYcashServerScheme().parsePrice("$1", NETWORK)).rejects.toThrow(/price source/);
  });
  it("custom money parsers run first", async () => {
    const t = new exact.ExactYcashServerScheme().registerMoneyParser(async (amount) => ({ amount: String(Number(amount) * 1000), asset: "YEC" }));
    expect((await t.parsePrice("$2", NETWORK)).amount).toBe("2000");
  });
  it("refuses other networks and unknown tickers", async () => {
    await expect(s.parsePrice("1 YEC", "eip155:1")).rejects.toThrow(/network/);
    await expect(s.parsePrice("1 ZEC", NETWORK)).rejects.toThrow(/unknown asset/);
  });
  it("YedGetPriceSource reads yed_getprice", async () => {
    const src = new exact.YedGetPriceSource({ yedGetPrice: async () => ({ pMid: 40_000_000, pFast: 1 }) as never });
    expect(await src.microUsdPerYec(NETWORK)).toBe(40_000_000n);
    expect(await new exact.YedGetPriceSource({ yedGetPrice: async () => ({ pMid: null, pSlow: 30_000_000 }) as never }).microUsdPerYec(NETWORK)).toBe(30_000_000n);
    await expect(new exact.YedGetPriceSource({ yedGetPrice: async () => ({ pMid: null, pSlow: null }) as never }).microUsdPerYec(NETWORK)).rejects.toThrow(/pMid/);
    expect(await new exact.YedGetPriceSource({ yedGetPrice: async () => ({ pFast: 7 }) as never }, "pFast").microUsdPerYec(NETWORK)).toBe(7n);
  });
});

describe("enhancePaymentRequirements", () => {
  it("adds the transparent extra; -1 up to the $1 cap, 1 above it", async () => {
    const s = new exact.ExactYcashServerScheme({ priceSource: $50 });
    expect((await s.enhancePaymentRequirements(base("2000000"), kind(), [])).extra).toEqual({ assetTransferMethod: "transparent", areFeesSponsored: false, confirmationPolicy: { confirmations: -1 } });
    expect((await s.enhancePaymentRequirements(base("2000001"), kind(), [])).extra.confirmationPolicy).toEqual({ confirmations: 1 });
  });
  it("an unavailable price falls back to 1", async () => {
    const s = new exact.ExactYcashServerScheme({ priceSource: { microUsdPerYec: async () => { throw new Error("no price"); } } });
    expect((await s.enhancePaymentRequirements(base("100"), kind(), [])).extra.confirmationPolicy).toEqual({ confirmations: 1 });
  });
  it("an explicit cap, or none without a price source", async () => {
    expect((await new exact.ExactYcashServerScheme({ zeroConfCapZat: 10n ** 6n }).enhancePaymentRequirements(base("1000000"), kind(), [])).extra.confirmationPolicy).toEqual({ confirmations: -1 });
    expect((await new exact.ExactYcashServerScheme().enhancePaymentRequirements(base("100"), kind(), [])).extra.confirmationPolicy).toEqual({ confirmations: 1 });
  });
  it("keeps a route's own policy, within the facilitator's range", async () => {
    const s = new exact.ExactYcashServerScheme({ priceSource: $50 });
    expect((await s.enhancePaymentRequirements(base("100", { confirmationPolicy: { confirmations: 3 } }), kind(), [])).extra.confirmationPolicy).toEqual({ confirmations: 3 });
    const adv = kind({ assetTransferMethods: ["transparent"], confirmations: { minimum: 0, maximum: 20 } });
    expect((await s.enhancePaymentRequirements(base("100"), adv, [])).extra.confirmationPolicy).toEqual({ confirmations: 0 });
    await expect(s.enhancePaymentRequirements(base("100", { confirmationPolicy: { confirmations: -1 } }), adv, [])).rejects.toThrow(/settles confirmations/);
    await expect(s.enhancePaymentRequirements(base("100"), kind({ assetTransferMethods: ["sapling-proof"] }), [])).rejects.toThrow(/does not support/);
  });
  it("YED defaults to 1", async () => {
    const s = new exact.ExactYcashServerScheme({ priceSource: $50 });
    expect((await s.enhancePaymentRequirements({ ...base("2500"), asset: "YED" }, kind(), [])).extra.confirmationPolicy).toEqual({ confirmations: 1 });
  });
  it("routes sapling-proof to the shielded handler", async () => {
    const shielded: exact.ShieldedExactHandler = {
      enhanceRequirements: async (r) => ({ ...r, payTo: "yregtestsapling1fresh", extra: { ...r.extra, paymentFlow: "upfront" } }),
      settle: async () => ({ success: false, transaction: "", network: NETWORK }),
    };
    const s = new exact.ExactYcashServerScheme({ shielded });
    expect(s.paymentFlows).toEqual({ transparent: { supported: ["authorization"], default: "authorization" }, "sapling-proof": { supported: ["upfront"], default: "upfront" } });
    const r = await s.enhancePaymentRequirements(base("1500000", { assetTransferMethod: "sapling-proof" }), kind(), []);
    expect(r.payTo).toBe("yregtestsapling1fresh");
    await expect(new exact.ExactYcashServerScheme().enhancePaymentRequirements(base("1", { assetTransferMethod: "sapling-proof" }), kind(), [])).rejects.toThrow(/shielded handler/);
  });
  it("declares transparent as the default method with the authorization flow", () => {
    const s = new exact.ExactYcashServerScheme();
    expect(s.defaultAssetTransferMethod).toBe("transparent");
    expect(s.paymentFlows).toEqual({ transparent: { supported: ["authorization"], default: "authorization" } });
    expect(s.getAssetDecimals("YEC", NETWORK)).toBe(8);
    expect(s.getAssetDecimals("YED", NETWORK)).toBe(2);
  });
});

describe("policy helpers", () => {
  it("expiry window and client expiry agree", () => {
    for (const t of [1, 75, 76, 300, 3600]) {
      const e = exact.clientExpiryHeight(1000, t);
      const w = exact.expiryWindow(1000, t);
      expect(e).toBeGreaterThanOrEqual(w.min);
      expect(e).toBeLessThanOrEqual(w.max);
      expect(e + 1).toBeLessThanOrEqual(w.max); // one block of slack between client and facilitator
    }
  });
  it("0 and 1 both need a block", () => {
    expect(exact.confirmationsSatisfy(-1, 0)).toBe(false);
    expect(exact.confirmationsSatisfy(1, 0)).toBe(true);
    expect(exact.confirmationsSatisfy(1, 1)).toBe(true);
    expect(exact.confirmationsSatisfy(-1, -1)).toBe(true);
  });
});
