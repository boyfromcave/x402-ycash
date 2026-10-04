import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import { InMemoryIssuedAddressRegistry, InMemorySettlementStore, SaplingProofHandler, type NodeCapabilities } from "x402-ycash-mechanism";
import { resolveConfig, type FacilitatorConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ChainMismatchError, waitForNode } from "../src/node.js";
import { facilitatorHalf, registerSchemes, type SchemeDeps } from "../src/schemes.js";
import { startFacilitator, type RunningFacilitator } from "../src/server.js";
import { body, FakeFacilitatorScheme } from "./fakeScheme.js";
import { startFakeNode, type FakeNode } from "./fakeNode.js";

const logs: string[] = [];
const logger = createLogger("debug", {}, l => logs.push(l));

function config(node: FakeNode, extra: Record<string, string> = {}): FacilitatorConfig {
  const dir = mkdtempSync(join(tmpdir(), "x402-fac-"));
  return resolveConfig(
    {},
    {
      X402_NETWORK: "ycash:regtest",
      X402_RPC_URL: node.url,
      X402_RPC_USER: node.user,
      X402_RPC_PASSWORD: node.password,
      X402_PORT: "0",
      X402_SETTLEMENT_STORE: join(dir, "settlements.json"),
      X402_NODE_WAIT_MS: "3000",
      X402_SHUTDOWN_TIMEOUT_MS: "5000",
      ...extra,
    },
  );
}

describe("startFacilitator", () => {
  let node: FakeNode | undefined;
  let running: RunningFacilitator | undefined;
  afterEach(async () => {
    await running?.close();
    await node?.close();
    running = undefined;
    node = undefined;
    logs.length = 0;
  });

  it("starts against a node (UTF-8 credentials), registers exact and batch-settlement, and answers /supported and /healthz", async () => {
    node = await startFakeNode();
    running = await startFacilitator(config(node), { logger });
    const supported = (await (await fetch(`${running.url}/supported`)).json()) as { kinds: { scheme: string; network: string; extra: Record<string, unknown> }[]; signers: unknown };
    expect(supported.kinds.map(k => `${k.scheme}@${k.network}`)).toEqual(["exact@ycash:regtest", "batch-settlement@ycash:regtest"]);
    // without sapling-proof configured, exact offers transparent only, at the operator's range
    expect(supported.kinds[0]?.extra).toMatchObject({ assetTransferMethods: ["transparent"], confirmations: { minimum: 0, maximum: 20 } });
    expect(supported.signers).toEqual({});
    const health = await (await fetch(`${running.url}/healthz`)).json();
    expect(health).toMatchObject({ status: "ok", node: { line: "v4", chain: "regtest", yellowback: true }, kinds: ["exact@ycash:regtest", "batch-settlement@ycash:regtest"] });
    expect(logs.some(l => l.includes("no scheme registered"))).toBe(false);
  });

  it("offers sapling-proof when a receipt key and the issued-address registry are configured", async () => {
    node = await startFakeNode();
    const dir = mkdtempSync(join(tmpdir(), "x402-fac-sp-"));
    running = await startFacilitator(config(node, { X402_RECEIPT_KEY: "11".repeat(32), X402_ISSUED_REGISTRY: join(dir, "issued.json") }), { logger });
    const supported = (await (await fetch(`${running.url}/supported`)).json()) as { kinds: { scheme: string; extra: Record<string, unknown> }[] };
    expect(supported.kinds.find(k => k.scheme === "exact")?.extra).toMatchObject({ assetTransferMethods: ["transparent", "sapling-proof"] });
    expect(logs.join("\n")).not.toContain("11".repeat(32)); // the receipt key never reaches a log line
  });

  it("lists sapling in /supported when opted in with the offline issuer's viewing key", async () => {
    const vk = (JSON.parse(readFileSync(new URL("../../../vectors/shielded/divaddr.json", import.meta.url), "utf8")) as { cases: { viewingKey: string }[] }).cases[0]!.viewingKey;
    node = await startFakeNode({ viewingKey: true });
    const dir = mkdtempSync(join(tmpdir(), "x402-fac-sap-"));
    const shieldedEnv = { X402_RECEIPT_KEY: "11".repeat(32), X402_ISSUED_REGISTRY: join(dir, "issued.json"), X402_SAPLING_ISSUER: "offline", X402_SAPLING_VIEWING_KEY: vk, X402_SAPLING_INDEX_FILE: join(dir, "i.json") };
    running = await startFacilitator(config(node, { ...shieldedEnv, X402_SHIELDED_METHODS: "sapling-proof,sapling" }), { logger });
    const supported = (await (await fetch(`${running.url}/supported`)).json()) as { kinds: { scheme: string; extra: Record<string, unknown> }[] };
    expect(supported.kinds.find(k => k.scheme === "exact")?.extra).toMatchObject({ assetTransferMethods: ["transparent", "sapling-proof", "sapling"] });
    expect(logs.join("\n")).not.toContain(vk); // the viewing key never reaches a log line
  });

  it("refuses to start when the node's chain is not the network's", async () => {
    node = await startFakeNode({ chain: "main" });
    await expect(startFacilitator(config(node), { logger })).rejects.toBeInstanceOf(ChainMismatchError);
  });

  it("waits for a node still loading its block index", async () => {
    node = await startFakeNode({ warmupCalls: 2, subversion: "/YcashCpp:6.21.0/", yellowback: false });
    running = await startFacilitator(config(node), { logger });
    const health = await (await fetch(`${running.url}/healthz`)).json();
    expect(health).toMatchObject({ node: { line: "v6", yellowback: false } });
  });

  it("hands the schemes their deps and lets an in-flight settle finish on shutdown", async () => {
    node = await startFakeNode();
    const scheme = new FakeFacilitatorScheme();
    let seen: SchemeDeps | undefined;
    running = await startFacilitator(config(node, { X402_CONFIRMATIONS_MIN: "-1" }), {
      logger,
      register: (f, deps) => {
        seen = deps;
        f.register(deps.network, scheme);
        return ["fake"];
      },
    });
    expect(seen).toMatchObject({ network: "ycash:regtest", confirmations: { minimum: -1, maximum: 20 }, capabilities: { chain: "regtest" } });

    scheme.holdSlowSettles();
    const url = running.url;
    const settle = fetch(`${url}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body("slow")) });
    await new Promise(r => setTimeout(r, 100)); // the settle is now inside the mechanism
    const closing = running.close();
    await new Promise(r => setTimeout(r, 50));
    await expect(fetch(`${url}/supported`)).rejects.toThrow(); // no longer accepting
    scheme.release();
    const res = await settle;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    await closing;
    running = undefined;
  });
});

describe("waitForNode", () => {
  const caps: NodeCapabilities = { line: "v4", subversion: "", version: 0, yellowback: false, chain: "regtest" };
  it("gives up after the wait with the last error", async () => {
    const probe = { capabilities: async () => Promise.reject(new Error("ECONNREFUSED")), getBlockCount: async () => 0 };
    await expect(waitForNode(probe, "ycash:regtest", 0, logger, async () => {})).rejects.toThrow("ECONNREFUSED");
  });
  it("fails at once on a wrong chain", async () => {
    let calls = 0;
    const probe = { capabilities: async () => (calls++, { ...caps, chain: "test" }), getBlockCount: async () => 0 };
    await expect(waitForNode(probe, "ycash:regtest", 60_000, logger, async () => {})).rejects.toBeInstanceOf(ChainMismatchError);
    expect(calls).toBe(1);
  });
});

describe("registerSchemes", () => {
  const deps = {
    network: "ycash:regtest",
    rpc: {} as SchemeDeps["rpc"], // registration makes no node call
    settlementStore: new InMemorySettlementStore(),
    confirmations: { minimum: -1, maximum: 6 },
    capabilities: { line: "v4", subversion: "", version: 0, yellowback: true, chain: "regtest" },
    logger,
  } satisfies SchemeDeps;

  it("registers exact (transparent) and batch-settlement on the configured network", () => {
    const f = new x402Facilitator();
    expect(registerSchemes(f, deps)).toEqual(["exact (transparent)", "batch-settlement"]);
    const kinds = f.getSupported().kinds;
    expect(kinds.map(k => [k.scheme, k.network])).toEqual([["exact", "ycash:regtest"], ["batch-settlement", "ycash:regtest"]]);
    // a Yellowback node (capabilities.yellowback) lists YED beside YEC (X3)
    expect(kinds[0]?.extra).toMatchObject({ assets: ["YEC", "YED"], assetTransferMethods: ["transparent"], areFeesSponsored: false, confirmations: { minimum: -1, maximum: 6 } });
    expect(kinds[1]?.extra).toEqual({ confirmations: { minimum: -1, maximum: 6 } });
  });

  it("adds sapling-proof to exact when configured, and the facilitator half refuses to issue", async () => {
    const f = new x402Facilitator();
    const sp = { receiptKey: "22".repeat(32), registry: new InMemoryIssuedAddressRegistry() };
    expect(registerSchemes(f, { ...deps, saplingProof: sp })).toEqual(["exact (transparent, sapling-proof)", "batch-settlement"]);
    expect(f.getSupported().kinds[0]?.extra).toMatchObject({ assetTransferMethods: ["transparent", "sapling-proof"] });
    const half = facilitatorHalf(new SaplingProofHandler({ ...deps, ...sp }));
    await expect(half.enhanceRequirements({} as never, {} as never, [])).rejects.toThrow(/merchant's server/);
  });

  it("the facilitator half delegates settle once: the bounded note wait is the mechanism's (noteWaitMs)", async () => {
    const handler = new SaplingProofHandler({ ...deps, receiptKey: "22".repeat(32), registry: new InMemoryIssuedAddressRegistry() });
    const answers = ["invalid_exact_ycash_not_received", "invalid_exact_ycash_not_received", "ok"];
    let calls = 0;
    handler.settle = async () => {
      const a = answers[Math.min(calls++, answers.length - 1)];
      return a === "ok" ? { success: true, transaction: "t", network: "ycash:regtest" } : { success: false, errorReason: a, transaction: "t", network: "ycash:regtest" };
    };
    expect(await facilitatorHalf(handler).settle({} as never, {} as never)).toMatchObject({ errorReason: "invalid_exact_ycash_not_received" });
    expect(calls).toBe(1);
  });

  it("routes sapling-proof and sapling through one router; sapling alone, and sapling without a viewing key", async () => {
    const vk = (JSON.parse(readFileSync(new URL("../../../vectors/shielded/divaddr.json", import.meta.url), "utf8")) as { cases: { viewingKey: string }[] }).cases[0]!.viewingKey;
    const sp = { receiptKey: "22".repeat(32), registry: new InMemoryIssuedAddressRegistry(), viewingKey: vk };
    const both = new x402Facilitator();
    expect(registerSchemes(both, { ...deps, saplingProof: { ...sp, methods: ["sapling-proof", "sapling"] } })).toEqual(["exact (transparent, sapling-proof, sapling)", "batch-settlement"]);
    expect(both.getSupported().kinds[0]?.extra).toMatchObject({ assetTransferMethods: ["transparent", "sapling-proof", "sapling"] });
    const only = new x402Facilitator();
    expect(registerSchemes(only, { ...deps, saplingProof: { ...sp, methods: ["sapling"] } })).toEqual(["exact (transparent, sapling)", "batch-settlement"]);
    // sapling-proof is not configured here: refused by the router, not served
    const req = { scheme: "exact", network: "ycash:regtest", asset: "YEC", amount: "1", payTo: "x", maxTimeoutSeconds: 60, extra: { assetTransferMethod: "sapling-proof", paymentFlow: "upfront" } };
    const res = await only.settle({ x402Version: 2, accepted: req, payload: { txid: "00".repeat(32) } } as never, req as never);
    expect(res).toMatchObject({ success: false, errorReason: "invalid_exact_ycash_asset_transfer_method" });
    // sapling verify reaches the sapling facilitator (rule 1 here: no transaction in the payload)
    const sreq = { ...req, extra: { assetTransferMethod: "sapling", memo: "x402:" + "00".repeat(32), expiresAt: 1 } };
    const v = await both.verify({ x402Version: 2, accepted: sreq, payload: {} } as never, sreq as never).catch((e: { invalidReason?: string }) => ({ isValid: false, invalidReason: e.invalidReason }));
    expect(v).toMatchObject({ isValid: false, invalidReason: "invalid_exact_ycash_transaction" });
    expect(() => registerSchemes(new x402Facilitator(), { ...deps, saplingProof: { ...sp, viewingKey: undefined, methods: ["sapling"] } })).toThrow(/viewing key/);
  });

  it("refuses a sapling-proof handler whose node is on another chain", () => {
    const f = new x402Facilitator();
    const sp = { receiptKey: "22".repeat(32), registry: new InMemoryIssuedAddressRegistry() };
    expect(() => registerSchemes(f, { ...deps, capabilities: { ...deps.capabilities, chain: "main" }, saplingProof: sp })).toThrow(/regtest/);
  });
});
