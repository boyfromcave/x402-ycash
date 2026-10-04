// AGENT_LWD_URL: the agent with only a WIF key and a lightwalletd server, no node RPC (plan X5).
import { describe, expect, it } from "vitest";
import { tx } from "x402-ycash-mechanism";
import { createAgent } from "../src/agent.js";
import { loadAgentConfig } from "../src/config.js";

const wif = tx.encodeWif(new Uint8Array(32).fill(3), "ycash:regtest");

describe("AGENT_LWD_URL", () => {
  it("replaces the node for a WIF signer; the agent registers exact (transparent) and batch-settlement", () => {
    const c = loadAgentConfig({ AGENT_LWD_URL: "127.0.0.1:9067", AGENT_WIF: wif });
    expect(c.node).toBeUndefined();
    expect(c.lwd).toMatchObject({ url: "127.0.0.1:9067", tls: false });
    expect(createAgent(c).schemes).toEqual(["exact (transparent)", "batch-settlement"]);
    c.lwd?.close();
  });

  it("refuses a node signer, and sapling-proof, without a node", () => {
    expect(() => loadAgentConfig({ AGENT_LWD_URL: "127.0.0.1:9067", AGENT_SIGNER: "node" })).toThrow(/AGENT_LWD_URL needs AGENT_WIF/);
    expect(() => loadAgentConfig({ AGENT_LWD_URL: "127.0.0.1:9067", AGENT_WIF: wif, AGENT_SHIELDED_FROM: "z" })).toThrow(/node wallet/);
    expect(() => loadAgentConfig({ AGENT_LWD_URL: "nope nope", AGENT_WIF: wif })).toThrow(/lightwalletd address/);
  });
});
