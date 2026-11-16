// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The API over real HTTP: the payment middleware with the real Ycash `exact` server scheme, the
// facilitator service (x402-ycash-facilitator) with a fake scheme behind it, and a fake node.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequired } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { tx } from "x402-ycash-mechanism";
import { createApp as createFacilitatorApp, silentLogger } from "x402-ycash-facilitator";
import { createChainApi, type ChainApi } from "../src/app.js";
import { loadChainApiConfig } from "../src/config.js";
import { ChainReader } from "../src/reader.js";
import { BLOCK, FakeClient, FakeFacilitatorScheme, FakeNode, TXID } from "./fakes.js";

const NETWORK = "ycash:regtest" as const;
const PAY_TO = tx.encodeAddress(NETWORK, "p2pkh", new Uint8Array(20).fill(7));
const OTHER = tx.encodeAddress(NETWORK, "p2pkh", new Uint8Array(20).fill(9));

async function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const baseEnv = (facilitatorUrl: string, extra: Record<string, string> = {}): Record<string, string> => ({
  X402_NETWORK: NETWORK,
  API_ALLOW_REGTEST: "1",
  API_PAY_TO: PAY_TO,
  API_RPC_URL: "http://127.0.0.1:1",
  API_RPC_USER: "u",
  API_RPC_PASSWORD: "p",
  FACILITATOR_URL: facilitatorUrl,
  ...extra,
});

describe("the paid chain-data API", () => {
  const facScheme = new FakeFacilitatorScheme();
  let fac: { server: Server; url: string };
  let api: { server: Server; url: string };
  let chainApi: ChainApi;
  let node: FakeNode;
  let client: FakeClient;
  let paid: typeof fetch;

  beforeAll(async () => {
    const facilitator = new x402Facilitator().register(NETWORK, facScheme);
    const probe = { capabilities: async () => ({ line: "v6" as const, subversion: "", version: 0, yellowback: false, chain: "regtest" }), getBlockCount: async () => 120 };
    fac = await listen(createFacilitatorApp({ facilitator, network: NETWORK, node: probe, confirmations: { minimum: -1, maximum: 20 }, logger: silentLogger }).app);
    node = new FakeNode();
    const config = loadChainApiConfig(baseEnv(fac.url, { API_UNPAID_PER_MINUTE: "1000", API_PAID_PER_MINUTE: "1000" }));
    chainApi = createChainApi(config, { facilitator: new HTTPFacilitatorClient({ url: fac.url }), reader: new ChainReader(node), healthPollMs: 0, log: () => undefined });
    api = await listen(chainApi.app);
  });
  afterAll(async () => {
    chainApi.close();
    await Promise.all([fac, api].map((s) => new Promise<void>((r) => s.server.close(() => r()))));
  });
  beforeEach(() => {
    node.calls.length = 0;
    facScheme.calls.length = 0;
    client = new FakeClient();
    const c = new x402Client().register(NETWORK, client);
    c.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: "YEC", maxAmountPerPayment: "20000" }] });
    paid = wrapFetchWithPayment(fetch, c);
  });

  async function required(path: string): Promise<PaymentRequired> {
    const res = await fetch(`${api.url}${path}`);
    expect(res.status).toBe(402);
    return decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") as string);
  }

  it("serves /pricing and / free, without a node call: every route, its price (D-10) and the payment kind", async () => {
    for (const path of ["/", "/pricing"]) {
      const res = await fetch(`${api.url}${path}`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as { network: string; payTo: string; routes: { path: string; priceZat: string; priceYec: string }[]; payment: { kinds: { scheme: string }[] } };
      expect(doc.network).toBe(NETWORK);
      expect(doc.payTo).toBe(PAY_TO);
      expect(doc.routes.map((r) => r.path)).toEqual(["/v1/tx/:txid", "/v1/address/:address", "/v1/block/:id", "/v1/chain", "/v1/yellowback", "/v1/broadcast"]);
      expect(doc.routes.every((r) => r.priceZat === "10000" && r.priceYec === "0.0001")).toBe(true);
      expect(doc.payment.kinds[0]?.scheme).toBe("exact");
    }
    expect(node.calls).toHaveLength(0);
  });

  it("answers an unpaid request with 402: exact YEC, 0.0001 to payTo, settled at the mempool (under the zero-conf cap); no node work", async () => {
    const pr = await required("/v1/chain");
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, asset: "YEC", amount: "10000", payTo: PAY_TO });
    expect(pr.accepts[0]?.extra).toMatchObject({ assetTransferMethod: "transparent", confirmationPolicy: { confirmations: -1 } });
    expect(node.calls).toHaveLength(0);
    expect(facScheme.calls).toHaveLength(0);
  });

  it("refuses bad parameters with 400 before any payment or node call", async () => {
    for (const path of ["/v1/tx/xyz", "/v1/tx/" + "a".repeat(63), "/v1/block/abc", "/v1/block/1234567890", "/v1/address/notbase58!", "/v1/address/" + "1".repeat(200), `/v1/address/${tx.encodeAddress("ycash:mainnet", "p2pkh", new Uint8Array(20))}`]) {
      const res = await fetch(`${api.url}${path}`);
      expect(res.status, path).toBe(400);
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    }
    for (const body of ["{}", '{"hex":"abc"}', '{"hex":"zz"}', '{"hex":"00","x":1}', "[]", "not json", JSON.stringify({ hex: "00".repeat(100_001) })]) {
      const res = await fetch(`${api.url}/v1/broadcast`, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect([400, 413], body.slice(0, 20)).toContain(res.status);
    }
    expect(node.calls).toHaveLength(0);
  });

  it("pays and answers each route; the node is read only after the facilitator verified the payment", async () => {
    const res = await paid(`${api.url}/v1/chain`);
    expect(res.status).toBe(200);
    expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") as string)).toMatchObject({ success: true, transaction: "ef".repeat(32) });
    expect(facScheme.calls).toEqual(["verify", "settle"]);
    const chain = (await res.json()) as Record<string, unknown>;
    expect(chain).toMatchObject({ chain: "regtest", blocks: 120, networkSolPs: 3, mempool: { size: 2, fees: { read: 2, totalFeesZat: 12_000 } }, transparentPools: [{ id: "transparent_ecc" }] });

    const t = (await (await paid(`${api.url}/v1/tx/${TXID.toUpperCase()}`)).json()) as Record<string, unknown>;
    expect(t).toMatchObject({ txid: TXID, feeZat: 10_000, confirmations: 1, inMempool: false, coinbase: false });

    const b = (await (await paid(`${api.url}/v1/block/120`)).json()) as Record<string, unknown>;
    expect(b).toMatchObject({ hash: BLOCK, height: 120, txCount: 1, transparentPools: null });
    expect(b.solution).toBeUndefined();
    expect(node.calls.find((c) => c.method === "getblockhash")?.params).toEqual([120]);

    const a = (await (await paid(`${api.url}/v1/address/${PAY_TO}`)).json()) as Record<string, unknown>;
    expect(a).toMatchObject({ address: PAY_TO, balanceZat: 5, utxoCount: 1, history: { fromHeight: 1, toHeight: 120, count: 2, newestFirst: [TXID, expect.any(String)] } });

    const y = (await (await paid(`${api.url}/v1/yellowback`)).json()) as Record<string, unknown>;
    expect(y).toMatchObject({ active: false });
    expect(String(y.reason)).toMatch(/^not active on this network/);

    const r = await paid(`${api.url}/v1/broadcast`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hex: "0400" }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ txid: TXID });
    expect(node.calls.find((c) => c.method === "sendrawtransaction")?.params).toEqual(["0400"]);
    // Only fixed read methods and the relay: nothing else ever reaches the node.
    const allowed = ["getblockchaininfo", "getnetworksolps", "getmempoolinfo", "getnetworkinfo", "getrawmempool", "getrawtransaction", "getblockhash", "getblock", "getblockcount", "getaddressbalance", "getaddressutxos", "getaddresstxids", "getaddressmempool", "sendrawtransaction"];
    expect(node.methods().every((m) => allowed.includes(m))).toBe(true);
  });

  it("refuses a replayed payment: one payment buys one request", async () => {
    expect((await paid(`${api.url}/v1/chain`)).status).toBe(200);
    const before = node.calls.length;
    client.replay = true;
    const again = await paid(`${api.url}/v1/chain`);
    expect(again.status).toBe(402);
    expect(node.calls.length).toBe(before); // the handler never ran
  });

  async function tampered(path: string, change: (a: PaymentRequired["accepts"][number]) => PaymentRequired["accepts"][number]): Promise<Response> {
    const pr = await required(path);
    const accepted = change(pr.accepts[0] as PaymentRequired["accepts"][number]);
    const header = encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted, payload: { transaction: `tx-tampered-${Math.random()}` } });
    return fetch(`${api.url}${path}`, { headers: { "PAYMENT-SIGNATURE": header } });
  }

  it("refuses an underpayment, another recipient and another network, before any node call", async () => {
    for (const change of [
      (a: PaymentRequired["accepts"][number]) => ({ ...a, amount: "9999" }),
      (a: PaymentRequired["accepts"][number]) => ({ ...a, payTo: OTHER }),
      (a: PaymentRequired["accepts"][number]) => ({ ...a, network: "ycash:mainnet" as const }),
    ]) {
      const res = await tampered("/v1/chain", change);
      expect(res.status).toBe(402);
    }
    expect(node.calls).toHaveLength(0);
    expect(facScheme.calls).not.toContain("settle");
  });

  it("does not charge a request the node cannot answer (404), and answers 404 for an unknown transaction", async () => {
    const res = await paid(`${api.url}/v1/tx/${"99".repeat(32)}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    expect(facScheme.calls).toEqual(["verify"]); // verified, never settled
  });

  it("never serves a paid route for free through a path variant", async () => {
    for (const path of ["/v1/chain/", "/V1/CHAIN", "/v1//chain", "/v1/%63hain", "/v1/chain?x=1", `/v1/tx/${TXID}/`, "/v1/chain;x"]) {
      const res = await fetch(`${api.url}${path}`);
      expect([402, 404], path).toContain(res.status);
    }
    expect(node.calls).toHaveLength(0);
  });

  it("/healthz is 503 until a node check succeeds, then 200 with the tip", async () => {
    expect((await fetch(`${api.url}/healthz`)).status).toBe(503);
    await chainApi.health.check();
    const res = await fetch(`${api.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tip: 120 });
  });

  it("rate-limits unpaid requests per client address (each 402 costs a challenge), apart from paid ones", async () => {
    const config = loadChainApiConfig(baseEnv(fac.url, { API_UNPAID_PER_MINUTE: "3", API_PAID_PER_MINUTE: "2" }));
    const small = createChainApi(config, { facilitator: new HTTPFacilitatorClient({ url: fac.url }), reader: new ChainReader(node), healthPollMs: 0, log: () => undefined });
    const s = await listen(small.app);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await fetch(`${s.url}/v1/chain`)).status);
      expect(codes).toEqual([402, 402, 402, 429]);
      // Paid attempts are counted apart: they still go through.
      const paidCodes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const header = encodePaymentSignatureHeader({ x402Version: 2, resource: { url: "x", description: "", mimeType: "" }, accepted: { scheme: "exact", network: NETWORK, asset: "YEC", amount: "1", payTo: PAY_TO, maxTimeoutSeconds: 1, extra: {} }, payload: { transaction: "x" } });
        paidCodes.push((await fetch(`${s.url}/v1/chain`, { headers: { "PAYMENT-SIGNATURE": header } })).status);
      }
      expect(paidCodes).toEqual([402, 402, 429]);
      // A junk payment header counts as unpaid, not against the (larger) paid limit.
      expect((await fetch(`${s.url}/v1/chain`, { headers: { "PAYMENT-SIGNATURE": "junk" } })).status).toBe(429);
    } finally {
      small.close();
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });

  it("answers 503 before any payment when the node has no address index", async () => {
    const config = loadChainApiConfig(baseEnv(fac.url));
    const noIndex = createChainApi(config, { facilitator: new HTTPFacilitatorClient({ url: fac.url }), reader: new ChainReader(node), addressIndex: false, healthPollMs: 0, log: () => undefined });
    const s = await listen(noIndex.app);
    try {
      const res = await fetch(`${s.url}/v1/address/${PAY_TO}`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "index_off" });
      const doc = (await (await fetch(`${s.url}/pricing`)).json()) as { routes: { path: string; available?: boolean }[] };
      expect(doc.routes.find((r) => r.path === "/v1/address/:address")?.available).toBe(false);
    } finally {
      noIndex.close();
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });
});
