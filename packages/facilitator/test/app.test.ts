import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { SettleError, VerifyError } from "@x402/core/types";
import type { NodeCapabilities } from "x402-ycash-mechanism";
import { createApp, EXTENSION_RESPONSES_HEADER, withConfirmationLimits } from "../src/app.js";
import { createLogger, type Logger } from "../src/logger.js";
import type { NodeProbe } from "../src/node.js";
import { body, FAKE_PAYER, FAKE_SCHEME, FAKE_TXID, FakeFacilitatorScheme, paymentPayload, requirements, SECRET } from "./fakeScheme.js";

const CAPS: NodeCapabilities = { line: "v4", subversion: "/YcashCpp:4.5.0/", version: 4050050, yellowback: true, chain: "regtest" };

class StubNode implements NodeProbe {
  caps: NodeCapabilities = CAPS;
  down = false;
  async capabilities(): Promise<NodeCapabilities> {
    if (this.down) throw new Error("ECONNREFUSED 127.0.0.1:18232");
    return this.caps;
  }
  async getBlockCount(): Promise<number> {
    if (this.down) throw new Error("ECONNREFUSED");
    return 232;
  }
}

interface Harness {
  url: string;
  server: Server;
  logs: string[];
  node: StubNode;
  scheme: FakeFacilitatorScheme;
  facilitator: x402Facilitator;
  shutdown: () => void;
}

async function start(opts: { apiKey?: string; bodyLimit?: string } = {}): Promise<Harness> {
  const logs: string[] = [];
  const logger: Logger = createLogger("debug", {}, l => logs.push(l));
  const scheme = new FakeFacilitatorScheme();
  const facilitator = new x402Facilitator().register("ycash:regtest", scheme);
  const node = new StubNode();
  const handle = createApp({ facilitator, network: "ycash:regtest", node, confirmations: { minimum: 0, maximum: 20 }, logger, ...opts });
  const server = await new Promise<Server>(r => {
    const s = handle.app.listen(0, "127.0.0.1", () => r(s));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server, logs, node, scheme, facilitator, shutdown: handle.beginShutdown };
}

const post = (url: string, payload: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });

describe("facilitator HTTP contract (spec §7)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await start();
  });
  afterAll(() => new Promise<void>(r => h.server.close(() => r())));
  beforeEach(() => {
    h.logs.length = 0;
    h.node.down = false;
    h.node.caps = CAPS;
  });

  describe("GET /supported", () => {
    it("lists the registered kinds with the operator's confirmation range and no empty signer family", async () => {
      const res = await fetch(`${h.url}/supported`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        kinds: [{ x402Version: 2, scheme: FAKE_SCHEME, network: "ycash:regtest", extra: { confirmations: { minimum: 0, maximum: 20 } } }],
        extensions: [],
        signers: {},
      });
    });

    it("is what upstream's HTTPFacilitatorClient parses", async () => {
      const supported = await new HTTPFacilitatorClient({ url: h.url }).getSupported();
      expect(supported.kinds.map(k => k.scheme)).toEqual([FAKE_SCHEME]);
    });
  });

  describe("POST /verify", () => {
    it("answers a valid payment with isValid and the payer", async () => {
      const res = await post(`${h.url}/verify`, body("ok"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isValid: true, payer: FAKE_PAYER });
    });

    it("moves extensionResponses into the EXTENSION-RESPONSES header (§7.2.1)", async () => {
      const res = await post(`${h.url}/verify`, body("ok"));
      const header = res.headers.get(EXTENSION_RESPONSES_HEADER);
      expect(header).not.toBeNull();
      expect(JSON.parse(Buffer.from(header as string, "base64").toString("utf8"))).toEqual({ fakeext: { status: "seen" } });
      expect(await res.json()).not.toHaveProperty("extensionResponses");
    });

    it("passes a mechanism's refusal through with status 200", async () => {
      const res = await post(`${h.url}/verify`, body("invalid"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isValid: false, invalidReason: "invalid_exact_ycash_amount", payer: FAKE_PAYER });
    });

    it("answers a throwing mechanism with unexpected_verify_error and logs, never leaks, the cause", async () => {
      const res = await post(`${h.url}/verify`, body("throw"));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ isValid: false, invalidReason: "unexpected_verify_error" });
      expect(text).not.toContain("hunter2");
      expect(h.logs.join("\n")).toContain(SECRET);
    });

    it("refuses an unregistered scheme (unsupported_scheme) and network (invalid_network)", async () => {
      const r1 = await post(`${h.url}/verify`, body("ok", requirements({ scheme: "upto" })));
      expect(r1.status).toBe(200);
      expect(await r1.json()).toMatchObject({ isValid: false, invalidReason: "unsupported_scheme" });
      const r2 = await post(`${h.url}/verify`, body("ok", requirements({ network: "ycash:mainnet" })));
      expect(r2.status).toBe(200);
      expect(await r2.json()).toMatchObject({ isValid: false, invalidReason: "invalid_network" });
    });

    it("refuses a payload accepted for another kind than the requirements", async () => {
      const req = requirements();
      const res = await post(`${h.url}/verify`, { x402Version: 2, paymentPayload: paymentPayload("ok", requirements({ scheme: "exact" })), paymentRequirements: req });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ isValid: false, invalidReason: "invalid_scheme" });
    });

    it.each([
      ["a non-object body", [], "invalid_payload"],
      ["missing requirements", { x402Version: 2, paymentPayload: paymentPayload() }, "invalid_payment_requirements"],
      ["an unknown top-level key", { ...body(), debug: true }, "invalid_payload"],
      ["x402Version 1", { ...body(), x402Version: 1 }, "invalid_x402_version"],
      ["a non-CAIP-2 network", body("ok", requirements({ network: "regtest" as `${string}:${string}` })), "invalid_payment_requirements"],
      ["a payload without `payload`", { x402Version: 2, paymentPayload: { x402Version: 2, accepted: requirements() }, paymentRequirements: requirements() }, "invalid_payload"],
    ])("answers %s with 400 %s", async (_name, payload, reason) => {
      const res = await post(`${h.url}/verify`, payload);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ isValid: false, invalidReason: reason });
    });

    it("answers malformed JSON with 400 invalid_payload, no parser internals", async () => {
      const res = await post(`${h.url}/verify`, "{not json");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ isValid: false, invalidReason: "invalid_payload", invalidMessage: "malformed JSON body" });
    });

    it("requires application/json", async () => {
      const res = await fetch(`${h.url}/verify`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body()) });
      expect(res.status).toBe(415);
    });

    it("surfaces as upstream's VerifyError on a 400, carrying the reason", async () => {
      const client = new HTTPFacilitatorClient({ url: h.url });
      const p = paymentPayload("ok", requirements({ scheme: "exact" }));
      await expect(client.verify(p, requirements())).rejects.toSatisfy((e: unknown) => e instanceof VerifyError && e.invalidReason === "invalid_scheme");
    });

    it("writes one structured log line per request", async () => {
      await post(`${h.url}/verify`, body("ok"));
      const line = h.logs.map(l => JSON.parse(l) as Record<string, unknown>).find(l => l.msg === "request");
      expect(line).toMatchObject({ level: "info", method: "POST", path: "/verify", status: 200, op: "verify", scheme: FAKE_SCHEME, isValid: true });
      expect(typeof line?.reqId).toBe("string");
    });
  });

  describe("POST /settle", () => {
    it("settles, returning the transaction and the extension outcome in the header", async () => {
      const client = new HTTPFacilitatorClient({ url: h.url });
      const result = await client.settle(paymentPayload("ok"), requirements());
      expect(result).toMatchObject({ success: true, transaction: FAKE_TXID, network: "ycash:regtest", payer: FAKE_PAYER });
      expect(result.extensionResponses).toEqual({ fakeext: { status: "settled" } });
    });

    it("passes settlement_pending through with its txid (§9)", async () => {
      const res = await post(`${h.url}/settle`, body("pending"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: false, errorReason: "settlement_pending", transaction: FAKE_TXID, network: "ycash:regtest", payer: FAKE_PAYER });
    });

    it("passes a mechanism's failure through", async () => {
      const res = await post(`${h.url}/settle`, body("fail"));
      expect(await res.json()).toEqual({ success: false, errorReason: "duplicate_settlement", transaction: "", network: "ycash:regtest" });
    });

    it("answers a throwing mechanism with unexpected_settle_error, no leak", async () => {
      const res = await post(`${h.url}/settle`, body("throw"));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: "ycash:regtest" });
      expect(text).not.toContain("hunter2");
    });

    it("answers a malformed settle with a SettleResponse shape (upstream SettleError)", async () => {
      const res = await post(`${h.url}/settle`, { x402Version: 2 });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, errorReason: "invalid_payment_requirements", transaction: "", network: "ycash:regtest" });
      const client = new HTTPFacilitatorClient({ url: h.url });
      await expect(client.settle(paymentPayload("ok", requirements({ network: "ycash:mainnet" })), requirements({ network: "ycash:mainnet" }))).resolves.toMatchObject({ success: false, errorReason: "invalid_network" });
      await expect(client.settle({ ...paymentPayload(), x402Version: 1 }, requirements())).rejects.toBeInstanceOf(SettleError);
    });

    it("turns a before-settle hook's abort into a settle failure, not a 500", async () => {
      const local = await start();
      local.facilitator.onBeforeSettle(async () => ({ abort: true, reason: "not_verified" }));
      try {
        const res = await post(`${local.url}/settle`, body("ok"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: false, errorReason: "not_verified", transaction: "", network: "ycash:regtest" });
      } finally {
        await new Promise<void>(r => local.server.close(() => r()));
      }
    });
  });

  describe("GET /healthz", () => {
    it("reports the node's chain and line", async () => {
      const res = await fetch(`${h.url}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok",
        network: "ycash:regtest",
        node: { line: "v4", chain: "regtest", subversion: "/YcashCpp:4.5.0/", yellowback: true, height: 232 },
        kinds: [`${FAKE_SCHEME}@ycash:regtest`],
      });
    });

    it("is 503 when the node is unreachable, without the error text", async () => {
      h.node.down = true;
      const res = await fetch(`${h.url}/healthz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: "node_unreachable", network: "ycash:regtest" });
    });

    it("is 503 when the node's chain is not the network's", async () => {
      h.node.caps = { ...CAPS, chain: "main" };
      const res = await fetch(`${h.url}/healthz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "chain_mismatch" });
    });
  });

  it("answers an unknown route with a JSON 404", async () => {
    const res = await fetch(`${h.url}/admin`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("limits and access", () => {
  it("refuses a body over the limit with 413", async () => {
    const h = await start({ bodyLimit: "1kb" });
    try {
      const big = body("ok");
      (big.paymentPayload as { payload: Record<string, unknown> }).payload.transaction = "00".repeat(2000);
      const res = await post(`${h.url}/verify`, big);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ isValid: false, invalidReason: "invalid_payload", invalidMessage: "request body too large" });
    } finally {
      await new Promise<void>(r => h.server.close(() => r()));
    }
  });

  it("requires the bearer key on /verify and /settle when one is configured, not on /supported", async () => {
    const key = "k".repeat(32);
    const h = await start({ apiKey: key });
    try {
      expect((await post(`${h.url}/verify`, body())).status).toBe(401);
      expect((await post(`${h.url}/settle`, body(), { authorization: "Bearer wrong" })).status).toBe(401);
      expect((await post(`${h.url}/verify`, body(), { authorization: `Bearer ${key}` })).status).toBe(200);
      expect((await fetch(`${h.url}/supported`)).status).toBe(200);
      const client = new HTTPFacilitatorClient({ url: h.url, createAuthHeaders: async () => ({ verify: { Authorization: `Bearer ${key}` } }) });
      await expect(client.verify(paymentPayload(), requirements())).resolves.toMatchObject({ isValid: true });
    } finally {
      await new Promise<void>(r => h.server.close(() => r()));
    }
  });

  it("refuses new payments with 503 once shutdown begins", async () => {
    const h = await start();
    try {
      h.shutdown();
      const res = await post(`${h.url}/settle`, body());
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ success: false, errorReason: "unexpected_settle_error" });
      expect((await fetch(`${h.url}/healthz`)).status).toBe(503);
    } finally {
      await new Promise<void>(r => h.server.close(() => r()));
    }
  });
});

describe("withConfirmationLimits", () => {
  const limits = { minimum: -1, maximum: 6 };
  it("adds the range to a Ycash kind without one", () => {
    expect(withConfirmationLimits([{ x402Version: 2, scheme: "exact", network: "ycash:mainnet" }], limits)[0]?.extra).toEqual({ confirmations: limits });
  });
  it("keeps a mechanism's own range and other extra fields", () => {
    const own = { x402Version: 2, scheme: "exact", network: "ycash:mainnet", extra: { assets: ["YEC"], confirmations: { minimum: 0, maximum: 1 } } };
    expect(withConfirmationLimits([own], limits)[0]).toEqual(own);
  });
  it("leaves other chains alone", () => {
    const evm = { x402Version: 2, scheme: "exact", network: "eip155:8453" };
    expect(withConfirmationLimits([evm], limits)[0]).toEqual(evm);
  });
});
