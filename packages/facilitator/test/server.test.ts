import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import { InMemorySettlementStore, type NodeCapabilities } from "x402-ycash-mechanism";
import { resolveConfig, type FacilitatorConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ChainMismatchError, waitForNode } from "../src/node.js";
import { registerSchemes, type SchemeDeps } from "../src/schemes.js";
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

  it("starts against a node (UTF-8 credentials), registers nothing by default, and answers /supported and /healthz", async () => {
    node = await startFakeNode();
    running = await startFacilitator(config(node), { logger });
    const supported = await (await fetch(`${running.url}/supported`)).json();
    expect(supported).toEqual({ kinds: [], extensions: [], signers: {} });
    const health = await (await fetch(`${running.url}/healthz`)).json();
    expect(health).toMatchObject({ status: "ok", node: { line: "v4", chain: "regtest", yellowback: true } });
    expect(logs.some(l => l.includes("no scheme registered"))).toBe(true);
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
  it("registers no Ycash scheme until the mechanism chunks are wired (update this test then)", () => {
    const f = new x402Facilitator();
    const deps = {
      network: "ycash:regtest",
      rpc: {} as SchemeDeps["rpc"], // never called by an empty registration
      settlementStore: new InMemorySettlementStore(),
      confirmations: { minimum: 0, maximum: 20 },
      capabilities: { line: "v4", subversion: "", version: 0, yellowback: true, chain: "regtest" },
      logger,
    } satisfies SchemeDeps;
    expect(registerSchemes(f, deps)).toEqual([]);
    expect(f.getSupported().kinds).toEqual([]);
  });
});
