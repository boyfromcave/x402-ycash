// End to end over real HTTP: the agent (agent-client, @x402/fetch) pays the merchant (@x402/express),
// which verifies and settles through the facilitator service. A fake `exact` scheme stands in for the
// Ycash mechanism; everything else is the production code path.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { tx, type NodeCapabilities } from "x402-ycash-mechanism";
import { createApp as createFacilitatorApp, silentLogger } from "x402-ycash-facilitator";
import { createAgent } from "../../agent-client/src/agent.js";
import { createMerchant, PAID_ROUTES } from "../src/app.js";
import { loadMerchantConfig } from "../src/config.js";
import { FAKE_TXID, FakeExactClient, FakeExactFacilitator, FakeExactServer } from "./fakeExact.js";

const NETWORK = "ycash:regtest" as const;
const PAY_TO = tx.encodeAddress(NETWORK, "p2pkh", new Uint8Array(20).fill(7));
const CAPS: NodeCapabilities = { line: "v4", subversion: "/YcashCpp:4.5.0/", version: 4050050, yellowback: false, chain: "regtest" };

async function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>(r => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("agent → merchant → facilitator", () => {
  const facScheme = new FakeExactFacilitator();
  const clientScheme = new FakeExactClient();
  let fac: { server: Server; url: string };
  let shop: { server: Server; url: string };

  beforeAll(async () => {
    const facilitator = new x402Facilitator().register(NETWORK, facScheme);
    const node = { capabilities: async () => CAPS, getBlockCount: async () => 232 };
    fac = await listen(createFacilitatorApp({ facilitator, network: NETWORK, node, confirmations: { minimum: -1, maximum: 20 }, logger: silentLogger }).app);
    const config = loadMerchantConfig({ X402_NETWORK: NETWORK, MERCHANT_PAY_TO: PAY_TO, FACILITATOR_URL: fac.url });
    const merchant = createMerchant(config, {
      register: (server, deps) => {
        server.register(deps.network, new FakeExactServer());
        return { exact: true, channel: false, shielded: false };
      },
    });
    shop = await listen(merchant.app);
  });
  afterAll(async () => {
    await Promise.all([fac, shop].map(s => new Promise<void>(r => s.server.close(() => r()))));
  });

  it("answers an unpaid request with 402 and PAYMENT-REQUIRED for exact YEC to the merchant", async () => {
    const res = await fetch(`${shop.url}/exact/quote`);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") as string);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: NETWORK,
      asset: "YEC",
      amount: "250000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "transparent", areFeesSponsored: false },
    });
  });

  it("pays automatically: verify, handler, settle, PAYMENT-RESPONSE", async () => {
    const agent = createAgent(
      { url: `${shop.url}/exact/quote`, requests: 1, network: NETWORK, signer: { kind: "wif", privKey: new Uint8Array(32).fill(1), address: "smAgent" }, maxPaymentZat: "1000000" },
      (client, deps) => {
        client.register(deps.network, clientScheme);
        return ["exact"];
      },
    );
    const before = facScheme.calls.length;
    const r = await agent.call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paidWith: "exact/transparent" });
    expect(r.settlement).toMatchObject({ success: true, transaction: FAKE_TXID, network: NETWORK });
    expect(facScheme.calls.slice(before)).toEqual(["verify", "settle"]);
  });

  it("refuses to pay above the agent's cap", async () => {
    const agent = createAgent(
      { url: `${shop.url}/exact/quote`, requests: 1, network: NETWORK, signer: { kind: "wif", privKey: new Uint8Array(32).fill(1), address: "smAgent" }, maxPaymentZat: "1000" },
      (client, deps) => {
        client.register(deps.network, new FakeExactClient());
        return ["exact"];
      },
    );
    await expect(agent.call()).rejects.toThrow(/spendControls|maxAmountPerPayment|exceeds/i);
  });

  it("serves a 501, never the content, on a mode whose scheme is not wired, in any path spelling", async () => {
    for (const path of ["/channel/search", "/CHANNEL/search", "/channel/search/", "/shielded/report"]) {
      const res = await fetch(`${shop.url}${path}`);
      expect(res.status, path).toBe(501);
      expect(await res.json()).toMatchObject({ error: "payment mode not wired yet" });
    }
  });

  it("lists its routes and what is wired", async () => {
    const res = await fetch(shop.url);
    expect(await res.json()).toEqual({
      network: NETWORK,
      routes: { [PAID_ROUTES.exact]: "paid", [PAID_ROUTES.channel]: "not wired", [PAID_ROUTES.shielded]: "not wired" },
    });
  });
});

describe("merchant with nothing wired (today's default)", () => {
  it("starts and refuses every paid route with 501", async () => {
    const config = loadMerchantConfig({ X402_NETWORK: NETWORK, MERCHANT_PAY_TO: PAY_TO, FACILITATOR_URL: "http://127.0.0.1:9" });
    const merchant = createMerchant(config);
    expect(merchant.modes).toEqual({ exact: false, channel: false, shielded: false });
    const shopNow = await listen(merchant.app);
    try {
      expect((await fetch(`${shopNow.url}/exact/quote`)).status).toBe(501);
    } finally {
      await new Promise<void>(r => shopNow.server.close(() => r()));
    }
  });
});

describe("loadMerchantConfig", () => {
  it("takes the network from config, never from the address (testnet and regtest share sm…)", () => {
    expect(loadMerchantConfig({ X402_NETWORK: "ycash:testnet", MERCHANT_PAY_TO: PAY_TO }).network).toBe("ycash:testnet");
  });
  it("refuses a mainnet address on regtest, a YED address, and a bad price", () => {
    const mainnet = tx.encodeAddress("ycash:mainnet", "p2pkh", new Uint8Array(20).fill(7));
    expect(() => loadMerchantConfig({ X402_NETWORK: NETWORK, MERCHANT_PAY_TO: mainnet })).toThrow(/not a ycash:regtest address/);
    const yed = tx.encodeAddress(NETWORK, "yed", new Uint8Array(20).fill(7));
    expect(() => loadMerchantConfig({ X402_NETWORK: NETWORK, MERCHANT_PAY_TO: yed })).toThrow(/YED/);
    expect(() => loadMerchantConfig({ X402_NETWORK: NETWORK, MERCHANT_PAY_TO: PAY_TO, PRICE_EXACT_ZAT: "0.5" })).toThrow(/zatoshis/);
    expect(() => loadMerchantConfig({ X402_NETWORK: NETWORK })).toThrow(/MERCHANT_PAY_TO/);
  });
});
