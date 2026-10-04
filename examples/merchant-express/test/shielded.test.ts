// The shielded route's issuer: a fresh address per 402, the same one on the paid retry, and the
// requirement's extra from the issued record (so core's rebuilt requirements match `accepted`).
import type { HTTPRequestContext } from "@x402/core/server";
import { describe, expect, it } from "vitest";
import { InMemoryIssuedAddressRegistry, shielded } from "x402-ycash-mechanism";
import { ShieldedRouteIssuer } from "../src/shielded.js";

const NET = "ycash:regtest" as const;

function setup() {
  let n = 0;
  const rpc = {
    zGetNewAddress: async () => "yregtestsapling1base",
    zGetNewDiversifiedAddress: async () => `yregtestsapling1div${++n}`,
    yedGetPrice: async () => Promise.reject(new Error("unused")),
  };
  const server = new shielded.ShieldedExactServer({ rpc, registry: new InMemoryIssuedAddressRegistry() });
  return new ShieldedRouteIssuer(server, { network: NET, amount: "1500000", maxTimeoutSeconds: 900, confirmations: -1 });
}

const ctx = (url: string, paymentHeader?: string): HTTPRequestContext =>
  ({ adapter: { getUrl: () => url }, path: new URL(url).pathname, method: "GET", ...(paymentHeader ? { paymentHeader } : {}) }) as unknown as HTTPRequestContext;
const header = (payTo: string) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { payTo }, payload: { txid: "00" } })).toString("base64");
const URL1 = "http://shop.test/shielded/report";

describe("ShieldedRouteIssuer", () => {
  it("issues a fresh address per unpaid request and reuses the accepted one on the paid retry", async () => {
    const issuer = setup();
    const a = await issuer.payTo(ctx(URL1));
    const b = await issuer.payTo(ctx(URL1));
    expect(a).not.toBe(b);
    expect(await issuer.payTo(ctx(URL1, header(a)))).toBe(a);
  });

  it("never reuses an address issued for another resource, or one it never issued", async () => {
    const issuer = setup();
    const a = await issuer.payTo(ctx(URL1));
    expect(await issuer.payTo(ctx("http://shop.test/other", header(a)))).not.toBe(a);
    expect(await issuer.payTo(ctx(URL1, header("yregtestsapling1forged")))).not.toBe("yregtestsapling1forged");
    expect(await issuer.payTo(ctx(URL1, "not base64 json"))).toMatch(/^yregtestsapling1div/);
  });

  it("fills memo, expiresAt, the flow and the policy from the issued record", async () => {
    const issuer = setup();
    const payTo = await issuer.payTo(ctx(URL1));
    const req = await issuer.enhanceRequirements({ scheme: "exact", network: NET, asset: "YEC", amount: "1500000", payTo, maxTimeoutSeconds: 900, extra: { assetTransferMethod: "sapling-proof" } });
    expect(req.extra).toMatchObject({ assetTransferMethod: "sapling-proof", paymentFlow: "upfront", areFeesSponsored: false, confirmationPolicy: { confirmations: -1 } });
    expect(req.extra.memo).toMatch(shielded.MEMO_REGEX);
    // deterministic: a second build of the same address is identical (core matches it against `accepted`)
    expect(await issuer.enhanceRequirements({ ...req, extra: { assetTransferMethod: "sapling-proof" } })).toEqual(req);
    await expect(issuer.enhanceRequirements({ ...req, payTo: "yregtestsapling1unknown" })).rejects.toThrow(/not issued/);
    await expect(issuer.enhanceRequirements({ ...req, amount: "1" })).rejects.toThrow(/price differs/);
    expect(() => issuer.settle()).toThrow(/does not settle/);
  });
});
