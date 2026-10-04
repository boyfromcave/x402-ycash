// End to end over real HTTP: the agent (agent-client, @x402/fetch) pays the merchant (@x402/express),
// which verifies and settles through the facilitator service. A fake `exact` scheme stands in for the
// Ycash mechanism; everything else is the production code path.
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { tx, YcashRpc, type NodeCapabilities } from "x402-ycash-mechanism";
import { createApp as createFacilitatorApp, silentLogger } from "x402-ycash-facilitator";
import { createAgent } from "../../agent-client/src/agent.js";
import { createMerchant, PAID_ROUTES } from "../src/app.js";
import { describeConfig, loadMerchantConfig } from "../src/config.js";
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
        return { modes: { exact: true, channel: false, shielded: false, yedExact: false, yedChannel: false } };
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
      { url: `${shop.url}/exact/quote`, requests: 1, network: NETWORK, node: new YcashRpc({ url: "http://127.0.0.1:1", user: "u", password: "p" }), signer: { kind: "node" }, maxPaymentZat: "1000000" },
      (client, deps) => {
        client.register(deps.network, clientScheme);
        return { names: ["exact"] };
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
      { url: `${shop.url}/exact/quote`, requests: 1, network: NETWORK, node: new YcashRpc({ url: "http://127.0.0.1:1", user: "u", password: "p" }), signer: { kind: "node" }, maxPaymentZat: "1000" },
      (client, deps) => {
        client.register(deps.network, new FakeExactClient());
        return { names: ["exact"] };
      },
    );
    await expect(agent.call()).rejects.toThrow(/spendControls|maxAmountPerPayment|exceeds/i);
  });

  it("serves a 501, never the content, on a mode that is not configured, in any path spelling", async () => {
    for (const path of ["/channel/search", "/CHANNEL/search", "/channel/search/", "/shielded/report"]) {
      const res = await fetch(`${shop.url}${path}`);
      expect(res.status, path).toBe(501);
      expect(await res.json()).toMatchObject({ error: "payment mode not configured" });
    }
  });

  it("lists its routes and what is wired", async () => {
    const res = await fetch(shop.url);
    expect(await res.json()).toEqual({
      network: NETWORK,
      routes: { [PAID_ROUTES.exact]: "paid", [PAID_ROUTES.ticker]: "paid", [PAID_ROUTES.channel]: "not wired", [PAID_ROUTES.shielded]: "not wired", [PAID_ROUTES.yedReport]: "not wired", [PAID_ROUTES.yedStream]: "not wired" },
    });
  });
});

describe("merchant with the production schemes and no node", () => {
  it("sells exact YEC (both routes) and answers 501 on the channel and shielded routes", async () => {
    const config = loadMerchantConfig({ X402_NETWORK: NETWORK, MERCHANT_PAY_TO: PAY_TO, FACILITATOR_URL: "http://127.0.0.1:9" });
    const merchant = createMerchant(config);
    expect(merchant.modes).toEqual({ exact: true, channel: false, shielded: false, yedExact: false, yedChannel: false });
    const shopNow = await listen(merchant.app);
    try {
      expect((await fetch(`${shopNow.url}/channel/search`)).status).toBe(501);
      expect((await fetch(`${shopNow.url}/shielded/report`)).status).toBe(501);
      expect(await (await fetch(shopNow.url)).json()).toMatchObject({ routes: { [PAID_ROUTES.exact]: "paid", [PAID_ROUTES.ticker]: "paid", [PAID_ROUTES.channel]: "not wired" } });
    } finally {
      await merchant.close();
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
  const base = { X402_NETWORK: NETWORK, MERCHANT_PAY_TO: PAY_TO };
  const node = { MERCHANT_RPC_URL: "http://127.0.0.1:1", MERCHANT_RPC_USER: "u", MERCHANT_RPC_PASSWORD: "p" };
  it("turns the channel route on with a server key and a node, with defaults for the terms", () => {
    const c = loadMerchantConfig({ ...base, ...node, MERCHANT_CHANNEL_KEY: "5a".repeat(32), MERCHANT_MIN_LOCK_BLOCKS: "40", MERCHANT_CHANNEL_CONFIRMATIONS: "-1" });
    expect(c.channel).toMatchObject({ maxDeposit: 100_000_000n, storePath: "merchant-channels.json", minLockBlocks: 40, confirmations: -1, fundingWaitMs: 60_000 });
    expect(() => loadMerchantConfig({ ...base, MERCHANT_CHANNEL_KEY: "5a".repeat(32) })).toThrow(/needs the merchant's node/);
    expect(() => loadMerchantConfig({ ...base, ...node, MERCHANT_CHANNEL_KEY: "00".repeat(32) })).toThrow(/private key/);
    expect(() => loadMerchantConfig({ ...base, ...node, MERCHANT_CHANNEL_KEY: "5a".repeat(32), MERCHANT_CHANNEL_CONFIRMATIONS: "21" })).toThrow(/-1..20/);
  });
  it("turns the shielded route on with the registry and a wallet; never shows the channel key", () => {
    const c = loadMerchantConfig({ ...base, ...node, MERCHANT_ISSUED_REGISTRY: "/r.json", MERCHANT_CHANNEL_KEY: "5a".repeat(32) });
    expect(c.shielded).toEqual({ registryPath: "/r.json", confirmations: 1 });
    expect(() => loadMerchantConfig({ ...base, ...node, MERCHANT_ISSUED_REGISTRY: "/r.json", MERCHANT_SAPLING_BASE_ADDRESS: "ys1abc" })).toThrow(/regtest Sapling/);
    expect(() => loadMerchantConfig({ ...base, MERCHANT_ISSUED_REGISTRY: "/r.json" })).toThrow(/wallet node/);
    expect(JSON.stringify(describeConfig(c))).not.toContain("5a".repeat(32));
  });
  it("issues offline from a viewing key with no node; validates the issuer settings", () => {
    const vk = (JSON.parse(readFileSync(new URL("../../../vectors/shielded/divaddr.json", import.meta.url), "utf8")) as { cases: { viewingKey: string }[] }).cases[0]!.viewingKey;
    const off = { ...base, MERCHANT_ISSUED_REGISTRY: "/r.json", MERCHANT_SAPLING_ISSUER: "offline", MERCHANT_SAPLING_VIEWING_KEY: vk };
    expect(loadMerchantConfig(off).shielded).toEqual({ registryPath: "/r.json", confirmations: 1, offline: { viewingKey: vk, startIndex: 1n << 40n, indexPath: "merchant-sapling-index.json" } });
    expect(loadMerchantConfig({ ...off, MERCHANT_SAPLING_START_INDEX: "4294967296", MERCHANT_SAPLING_INDEX_FILE: "/i.json" }).shielded?.offline).toMatchObject({ startIndex: 1n << 32n, indexPath: "/i.json" });
    expect(() => loadMerchantConfig({ ...off, MERCHANT_SAPLING_START_INDEX: "7" })).toThrow(/2\^32/);
    expect(() => loadMerchantConfig({ ...off, MERCHANT_SAPLING_VIEWING_KEY: undefined })).toThrow(/MERCHANT_SAPLING_VIEWING_KEY/);
    expect(() => loadMerchantConfig({ ...off, X402_NETWORK: "ycash:testnet", MERCHANT_PAY_TO: undefined })).toThrow();
    expect(() => loadMerchantConfig({ ...off, MERCHANT_SAPLING_BASE_ADDRESS: "yregtestsapling1abc" })).toThrow(/node-wallet issuer/);
    expect(() => loadMerchantConfig({ ...off, MERCHANT_SAPLING_ISSUER: "hosted" })).toThrow(/MERCHANT_SAPLING_ISSUER/);
    expect(JSON.stringify(describeConfig(loadMerchantConfig(off)))).not.toContain(vk);
  });
  it("defaults the zero-confirmation cap to the ticker price", () => {
    expect(loadMerchantConfig({ ...base, PRICE_TICKER_ZAT: "20000" }).zeroConfCapZat).toBe(20_000n);
    expect(loadMerchantConfig({ ...base, MERCHANT_ZERO_CONF_CAP_ZAT: "5" }).zeroConfCapZat).toBe(5n);
  });
});
