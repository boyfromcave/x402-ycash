// The `sapling` route (/shielded/private-report, plan X4b): issued like the sapling-proof route from the
// same registry, offered with assetTransferMethod "sapling" and no paymentFlow, and served only while
// the facilitator lists `sapling` in /supported (re-probed, as the YED routes are).
import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { InMemoryIssuedAddressRegistry, shielded, tx } from "x402-ycash-mechanism";
import { createMerchant, PAID_ROUTES } from "../src/app.js";
import { loadMerchantConfig } from "../src/config.js";
import { facilitatorListsMethod, MethodGate, shieldedHook, ShieldedRouteIssuer } from "../src/shielded.js";

const NETWORK = "ycash:regtest" as const;
const PAY_TO = tx.encodeAddress(NETWORK, "p2pkh", new Uint8Array(20).fill(7));
const VK = (JSON.parse(readFileSync(new URL("../../../vectors/shielded/divaddr.json", import.meta.url), "utf8")) as { cases: { viewingKey: string }[] }).cases[0]!.viewingKey;

function facilitator(methods: string[] | (() => string[])): FacilitatorClient & { probes: number } {
  const f = {
    probes: 0,
    getSupported: async (): Promise<SupportedResponse> => {
      f.probes++;
      const m = typeof methods === "function" ? methods() : methods;
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { assets: ["YEC"], assetTransferMethods: m } }], extensions: [], signers: {} };
    },
    verify: async () => ({ isValid: false, invalidReason: "unused" }),
    settle: async () => ({ success: false, transaction: "", network: NETWORK, errorReason: "unused" }),
  };
  return f;
}

function config() {
  const dir = mkdtempSync(join(tmpdir(), "x402-sapling-route-"));
  return loadMerchantConfig({
    X402_NETWORK: NETWORK,
    MERCHANT_PAY_TO: PAY_TO,
    FACILITATOR_URL: "http://127.0.0.1:9",
    MERCHANT_ISSUED_REGISTRY: join(dir, "issued.json"),
    MERCHANT_SHIELDED_CONFIRMATIONS: "-1",
    MERCHANT_SAPLING_ISSUER: "offline",
    MERCHANT_SAPLING_VIEWING_KEY: VK,
    MERCHANT_SAPLING_INDEX_FILE: join(dir, "index.json"),
    PRICE_PRIVATE_REPORT_ZAT: "2500000",
  });
}

async function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("the sapling route", () => {
  it("offers exact YEC sapling (authorization flow) at a fresh address with the memo, when the facilitator lists sapling", async () => {
    const merchant = createMerchant(config(), { facilitator: facilitator(["transparent", "sapling-proof", "sapling"]), saplingListed: true });
    const { server, url } = await listen(merchant.app);
    try {
      expect(merchant.modes.sapling).toBe(true);
      const res = await fetch(`${url}/shielded/private-report`);
      expect(res.status).toBe(402);
      const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") as string);
      const offer = pr.accepts[0]!;
      expect(offer).toMatchObject({ scheme: "exact", network: NETWORK, asset: "YEC", amount: "2500000", maxTimeoutSeconds: 900 });
      expect(offer.payTo.startsWith("yregtestsapling1")).toBe(true);
      expect(offer.extra).toMatchObject({ assetTransferMethod: "sapling", areFeesSponsored: false, confirmationPolicy: { confirmations: -1 } });
      expect(offer.extra).not.toHaveProperty("paymentFlow");
      expect(offer.extra.memo).toMatch(shielded.MEMO_REGEX);
      // the sapling-proof route beside it still offers its own method, from the same registry
      const proof = decodePaymentRequiredHeader((await fetch(`${url}/shielded/report`)).headers.get("PAYMENT-REQUIRED") as string).accepts[0]!;
      expect(proof.extra).toMatchObject({ assetTransferMethod: "sapling-proof", paymentFlow: "upfront" });
      expect(proof.payTo).not.toBe(offer.payTo);
      expect(await (await fetch(url)).json()).toMatchObject({ routes: { [PAID_ROUTES.privateReport]: "paid", [PAID_ROUTES.shielded]: "paid" } });
    } finally {
      server.close();
      await merchant.close();
    }
  });

  it("answers 501 while the facilitator does not list sapling, and turns on when it does (re-probed on request)", async () => {
    let methods = ["transparent", "sapling-proof"];
    const f = facilitator(() => methods);
    const merchant = createMerchant(config(), { facilitator: f, saplingListed: false });
    const { server, url } = await listen(merchant.app);
    try {
      const off = await fetch(`${url}/shielded/private-report`);
      expect(off.status).toBe(501);
      expect(await off.json()).toMatchObject({ mode: "sapling" });
      expect(f.probes).toBeGreaterThan(0);
      methods = [...methods, "sapling"];
      await new Promise((r) => setTimeout(r, 5_100)); // the on-demand re-probe is rate-limited to every 5 s
      expect((await fetch(`${url}/shielded/private-report`)).status).toBe(402);
      expect(merchant.modes.sapling).toBe(true);
    } finally {
      server.close();
      await merchant.close();
    }
  }, 15_000);

  it("is not wired without the shielded setup", () => {
    const merchant = createMerchant(loadMerchantConfig({ X402_NETWORK: NETWORK, MERCHANT_PAY_TO: PAY_TO, FACILITATOR_URL: "http://127.0.0.1:9" }), { facilitator: facilitator(["sapling"]) });
    expect(merchant.modes.sapling).toBe(false);
  });
});

describe("shielded route helpers", () => {
  it("the issuer builds each method's extra; the hook advertises both flows", async () => {
    let n = 0;
    const rpc = { zGetNewAddress: async () => "yregtestsapling1base", zGetNewDiversifiedAddress: async () => `yregtestsapling1div${++n}`, yedGetPrice: async () => Promise.reject(new Error("unused")) };
    const server = new shielded.ShieldedExactServer({ rpc, registry: new InMemoryIssuedAddressRegistry() });
    const issuer = new ShieldedRouteIssuer(server, { network: NETWORK, method: "sapling", amount: "1500000", maxTimeoutSeconds: 900, confirmations: -1 });
    const ctx = { adapter: { getUrl: () => "http://shop.test/shielded/private-report" } } as never;
    const payTo = await issuer.payTo(ctx);
    const base = { scheme: "exact", network: NETWORK, asset: "YEC", amount: "1500000", payTo, maxTimeoutSeconds: 900 };
    const s = await issuer.enhanceRequirements({ ...base, extra: { assetTransferMethod: "sapling", paymentFlow: "upfront" } });
    expect(s.extra).toMatchObject({ assetTransferMethod: "sapling", areFeesSponsored: false });
    expect(s.extra).not.toHaveProperty("paymentFlow");
    expect((await issuer.enhanceRequirements({ ...base, extra: { assetTransferMethod: "sapling-proof" } })).extra).toMatchObject({ paymentFlow: "upfront" });
    await expect(issuer.enhanceRequirements({ ...base, extra: { assetTransferMethod: "transparent" } })).rejects.toThrow(/not a shielded method/);
    expect(shieldedHook(issuer, ["sapling-proof", "sapling"]).flows).toEqual({ "sapling-proof": "upfront", sapling: "authorization" });
  });

  it("facilitatorListsMethod reads the exact kind of the network; the gate treats a failed probe as off", async () => {
    expect(await facilitatorListsMethod(facilitator(["sapling"]), NETWORK, "sapling")).toBe(true);
    expect(await facilitatorListsMethod(facilitator(["sapling"]), "ycash:testnet", "sapling")).toBe(false);
    const gate = new MethodGate(true, () => Promise.reject(new Error("down")));
    expect(await gate.refresh(true)).toBe(false);
    expect(gate.listed).toBe(false);
  });
});
