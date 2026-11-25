// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The private routes (/v1/private/…, `sapling-proof`) over real HTTP: the real Ycash `exact` server
// scheme with the API's issuer (a fake wallet hands out diversified addresses, the registry is a real
// file), the facilitator service with a fake upfront scheme behind it, and a fake node. Plus the
// configuration's checks and the agent's private-tour guards.
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse, VerifyResponse } from "@x402/core/types";
import { tx } from "x402-ycash-mechanism";
import { createApp as createFacilitatorApp, silentLogger } from "x402-ycash-facilitator";
import { runAgent, waitSpendable } from "../src/agent/agent.js";
import { createChainApi, pricingDocument, type ChainApi } from "../src/app.js";
import { ConfigError, loadChainApiConfig } from "../src/config.js";
import { ChainReader } from "../src/reader.js";
import { FakeNode } from "./fakes.js";

const NETWORK = "ycash:regtest" as const;
const PAY_TO = tx.encodeAddress(NETWORK, "p2pkh", new Uint8Array(20).fill(7));
const BASE = "yregtestsapling1" + "q".repeat(60);
const TXID = "5a".repeat(32);

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  X402_NETWORK: NETWORK,
  API_ALLOW_REGTEST: "1",
  API_PAY_TO: PAY_TO,
  API_RPC_URL: "http://127.0.0.1:1",
  API_RPC_USER: "u",
  API_RPC_PASSWORD: "p",
  ...extra,
});

/** A wallet issuing distinct diversified addresses of BASE. */
class FakeWallet {
  n = 0;
  async zGetNewAddress(): Promise<string> {
    return BASE;
  }
  async zGetNewDiversifiedAddress(base: string): Promise<string> {
    expect(base).toBe(BASE);
    return "yregtestsapling1" + (++this.n).toString().padStart(60, "d");
  }
  async yedGetPrice(): Promise<never> {
    throw new Error("no YED price on this node");
  }
}

/** An upfront sapling-proof facilitator: settles a (txid, payTo) once; a second settle is `resumed`. */
class FakeSaplingProof implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "ycash:*";
  readonly settled = new Set<string>();
  readonly seen: PaymentRequirements[] = [];
  getExtra(_network: Network): Record<string, unknown> {
    return { assets: ["YEC"], assetTransferMethods: ["transparent", "sapling-proof"], areFeesSponsored: false, confirmations: { minimum: -1, maximum: 20 } };
  }
  getSigners(): string[] {
    return [];
  }
  async verify(): Promise<VerifyResponse> {
    throw new Error("upfront: core must not call verify");
  }
  async settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    this.seen.push(req);
    const key = `${String(p.payload.txid)}@${req.payTo}`;
    const resumed = this.settled.has(key);
    this.settled.add(key);
    return { success: true, transaction: String(p.payload.txid), network: req.network, payer: "", amount: req.amount, extra: { status: "mempool", confirmations: -1, ...(resumed ? { resumed: true } : {}) } };
  }
}

async function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("the private routes' configuration", () => {
  it("is off without API_ISSUED_REGISTRY, and refuses its other settings alone", () => {
    expect(loadChainApiConfig(env()).shielded).toBeUndefined();
    expect(() => loadChainApiConfig(env({ API_SAPLING_BASE_ADDRESS: BASE }))).toThrow(/need API_ISSUED_REGISTRY/);
  });

  it("needs a base Sapling address of the network, and checks the policy", () => {
    expect(() => loadChainApiConfig(env({ API_ISSUED_REGISTRY: "/tmp/r.json" }))).toThrow(ConfigError);
    expect(() => loadChainApiConfig(env({ API_ISSUED_REGISTRY: "/tmp/r.json", API_SAPLING_BASE_ADDRESS: "ytestsapling1" + "q".repeat(60) }))).toThrow(/regtest Sapling address/);
    expect(() => loadChainApiConfig(env({ API_ISSUED_REGISTRY: "/tmp/r.json", API_SAPLING_BASE_ADDRESS: BASE, API_SHIELDED_CONFIRMATIONS: "-2" }))).toThrow(/-1\.\.20/);
    expect(() => loadChainApiConfig(env({ API_ISSUED_REGISTRY: "/tmp/r.json", API_SAPLING_BASE_ADDRESS: BASE, API_SHIELDED_CONFIRMATIONS: "21" }))).toThrow(/-1\.\.20/);
    const c = loadChainApiConfig(env({ API_ISSUED_REGISTRY: "/tmp/r.json", API_SAPLING_BASE_ADDRESS: BASE, API_SHIELDED_CONFIRMATIONS: "-1", API_PRICE_ZAT: "20000" }));
    expect(c.shielded).toEqual({ registryPath: "/tmp/r.json", baseAddress: BASE, confirmations: -1, priceZat: 20000n, maxOutstanding: 1000 });
  });

  it("lists the private routes and the sapling-proof kind on /pricing", () => {
    const c = loadChainApiConfig(env({ API_ISSUED_REGISTRY: "/tmp/r.json", API_SAPLING_BASE_ADDRESS: BASE, API_SHIELDED_CONFIRMATIONS: "-1", API_PRICE_SHIELDED_ZAT: "15000" }));
    const doc = pricingDocument(c) as { routes: { path: string; payment: string; priceZat: string }[]; payment: { kinds: { assetTransferMethod: string }[] } };
    expect(doc.payment.kinds.map((k) => k.assetTransferMethod)).toEqual(["transparent", "sapling-proof"]);
    const priv = doc.routes.filter((r) => r.payment === "sapling-proof");
    expect(priv.map((r) => r.path)).toEqual(["/v1/private/tx/:txid", "/v1/private/address/:address", "/v1/private/block/:id", "/v1/private/chain", "/v1/private/yellowback"]);
    expect(priv.every((r) => r.priceZat === "15000")).toBe(true);
  });
});

describe("a private route, paid upfront in shielded YEC", () => {
  const facScheme = new FakeSaplingProof();
  const wallet = new FakeWallet();
  let fac: { server: Server; url: string };
  let api: { server: Server; url: string };
  let chainApi: ChainApi;

  beforeAll(async () => {
    const facilitator = new x402Facilitator().register(NETWORK, facScheme);
    const probe = { capabilities: async () => ({ line: "v6" as const, subversion: "", version: 0, yellowback: false, chain: "regtest" }), getBlockCount: async () => 120 };
    fac = await listen(createFacilitatorApp({ facilitator, network: NETWORK, node: probe, confirmations: { minimum: -1, maximum: 20 }, logger: silentLogger }).app);
    const dir = mkdtempSync(join(tmpdir(), "x402-private-"));
    const config = loadChainApiConfig(env({ FACILITATOR_URL: fac.url, API_ISSUED_REGISTRY: join(dir, "issued.json"), API_SAPLING_BASE_ADDRESS: BASE, API_SHIELDED_CONFIRMATIONS: "-1", API_UNPAID_PER_MINUTE: "1000" }));
    chainApi = createChainApi(config, { facilitator: new HTTPFacilitatorClient({ url: fac.url }), reader: new ChainReader(new FakeNode()), wallet, healthPollMs: 0, log: () => undefined });
    api = await listen(chainApi.app);
  });
  afterAll(async () => {
    chainApi.close();
    await Promise.all([fac, api].map((s) => new Promise<void>((r) => s.server.close(() => r()))));
  });

  it("answers 402 with a fresh Sapling address and a memo per request; the transparent route is unchanged", async () => {
    const a = await fetch(`${api.url}/v1/private/chain`);
    const b = await fetch(`${api.url}/v1/private/chain`);
    expect([a.status, b.status]).toEqual([402, 402]);
    const ra = decodePaymentRequiredHeader(a.headers.get("PAYMENT-REQUIRED") as string).accepts[0] as PaymentRequirements;
    const rb = decodePaymentRequiredHeader(b.headers.get("PAYMENT-REQUIRED") as string).accepts[0] as PaymentRequirements;
    expect(ra.payTo).toMatch(/^yregtestsapling1/);
    expect(ra.payTo).not.toBe(rb.payTo);
    expect(ra.extra).toMatchObject({ assetTransferMethod: "sapling-proof", paymentFlow: "upfront", confirmationPolicy: { confirmations: -1 } });
    expect(String(ra.extra.memo)).toMatch(/^x402:/);
    const t = decodePaymentRequiredHeader((await fetch(`${api.url}/v1/chain`)).headers.get("PAYMENT-REQUIRED") as string).accepts[0] as PaymentRequirements;
    expect(t).toMatchObject({ payTo: PAY_TO, extra: { assetTransferMethod: "transparent" } });
  });

  it("serves the data once the facilitator settles the txid, and refuses the same payment again with 409", async () => {
    const res = await fetch(`${api.url}/v1/private/chain`);
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") as string);
    const header = encodePaymentSignatureHeader({ x402Version: 2, resource: required.resource, accepted: required.accepts[0] as PaymentRequirements, payload: { txid: TXID } });
    const ok = await fetch(`${api.url}/v1/private/chain`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { blocks: number }).blocks).toBe(120);
    expect(decodePaymentResponseHeader(ok.headers.get("PAYMENT-RESPONSE") as string).transaction).toBe(TXID);
    expect(facScheme.seen.at(-1)?.payTo).toBe(required.accepts[0]?.payTo);
    const again = await fetch(`${api.url}/v1/private/chain`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("payment_used");
  });

  it("checks parameters before any address is issued", async () => {
    const before = wallet.n;
    const res = await fetch(`${api.url}/v1/private/tx/nothex`);
    expect(res.status).toBe(400);
    expect(wallet.n).toBe(before);
  });
});

describe("the reference agent's private tour", () => {
  it("refuses a WIF or a node beside --sapling-builder, and a builder that is not http", async () => {
    const errs: string[] = [];
    const io = { out: () => undefined, err: (l: string) => void errs.push(l) };
    expect(await runAgent(["http://127.0.0.1:9", "--sapling-builder", "http://127.0.0.1:8", "--wif-file", "/x"], {}, io)).toBe(2);
    expect(await runAgent(["http://127.0.0.1:9", "--sapling-builder", "x402-light build"], {}, io)).toBe(2);
    expect(errs.join("\n")).toMatch(/takes the private tour alone[\s\S]*must be the http URL/);
  });

  it("pays only sapling-proof requirements to a Sapling address, within /pricing's price", async () => {
    const out: Record<string, unknown>[] = [];
    let signed = 0;
    let n = 0;
    const api = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (req.headers.get("PAYMENT-SIGNATURE")) signed++;
      if (url.pathname === "/pricing") {
        return Response.json({ network: NETWORK, payTo: PAY_TO, routes: ["/v1/private/chain", "/v1/private/block/:id", "/v1/private/tx/:txid", "/v1/private/address/:address", "/v1/private/yellowback"].map((path) => ({ method: "GET", path, priceZat: "10000", payment: "sapling-proof" })) });
      }
      // first a transparent ask, then a Sapling ask above the price
      const accepts = ++n === 1
        ? [{ scheme: "exact", network: NETWORK, asset: "YEC", amount: "10000", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "transparent" } }]
        : [{ scheme: "exact", network: NETWORK, asset: "YEC", amount: "15000", payTo: BASE, maxTimeoutSeconds: 600, extra: { assetTransferMethod: "sapling-proof", paymentFlow: "upfront", memo: "x402:" + "0".repeat(64), expiresAt: 4_000_000_000 } }];
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: url.href, description: "", mimeType: "application/json" }, accepts }), "content-type": "application/json" } });
    }) as typeof fetch;
    // The light client: plenty spendable, so the agent goes straight to the 402s.
    const light = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = body.method === "status" ? { network: "regtest", lwdHeight: 120, height: 120, synced: true, hasKey: true, address: BASE, balance: { spendableZat: 1_000_000, pendingChangeZat: 0, pendingIncomingZat: 0, totalZat: 1_000_000 } } : {};
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }) as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = light; // LightClient's own calls
    try {
      const code = await runAgent(["http://127.0.0.1:9", "--sapling-builder", "http://127.0.0.1:8", "--network", NETWORK, "--wait", "0"], {}, { out: (r) => void out.push(r), err: () => undefined }, api);
      expect(code).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    const errors = out.map((l) => String(l.error ?? "")).join("\n");
    expect(errors).toMatch(/pays sapling-proof only/);
    expect(errors).toMatch(/asks 15000 zatoshis, \/pricing says 10000/);
    expect(signed).toBe(0);
  });

  it("waits for change to become spendable, and says when the key holds too little", async () => {
    const states = [
      { spendableZat: 0, pendingChangeZat: 50_000, pendingIncomingZat: 0 },
      { spendableZat: 50_000, pendingChangeZat: 0, pendingIncomingZat: 0 },
    ];
    let i = 0;
    let syncs = 0;
    const light = { status: async () => ({ balance: states[Math.min(i++, 1)] as (typeof states)[number] }), sync: async () => void syncs++ };
    expect(await waitSpendable(light, 20_000n, 60_000, async () => undefined)).toBeUndefined();
    expect(syncs).toBe(2); // a sync before each look
    const poor = { status: async () => ({ balance: { spendableZat: 5_000, pendingChangeZat: 0, pendingIncomingZat: 0 } }), sync: async () => undefined };
    expect(await waitSpendable(poor, 20_000n, 60_000, async () => undefined)).toMatch(/get more from the faucet/);
  });
});
