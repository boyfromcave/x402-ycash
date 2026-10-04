import { describe, expect, it } from "vitest";
import { tx } from "x402-ycash-mechanism";
import { createAgent } from "../src/agent.js";
import { loadAgentConfig } from "../src/config.js";

const priv = new Uint8Array(32).fill(3);
const wifRegtest = tx.encodeWif(priv, "ycash:regtest");
const wifMainnet = tx.encodeWif(priv, "ycash:mainnet");

describe("loadAgentConfig", () => {
  it("builds a WIF signer and derives its sm… address on regtest", () => {
    const c = loadAgentConfig({ AGENT_WIF: wifRegtest });
    expect(c).toMatchObject({ url: "http://127.0.0.1:4021/exact/quote", requests: 1, network: "ycash:regtest", maxPaymentZat: "1000000" });
    expect(c.signer.kind).toBe("wif");
    if (c.signer.kind === "wif") {
      expect(c.signer.address.startsWith("sm")).toBe(true);
      expect(tx.decodeAddress(c.signer.address, "ycash:regtest").kind).toBe("p2pkh");
    }
  });

  it("refuses a mainnet WIF on regtest", () => {
    expect(() => loadAgentConfig({ AGENT_WIF: wifMainnet })).toThrow(/not for ycash:regtest/);
  });

  it("builds a node-wallet signer from RPC settings", () => {
    const c = loadAgentConfig({ AGENT_SIGNER: "node", AGENT_RPC_URL: "http://127.0.0.1:18232", AGENT_RPC_USER: "u", AGENT_RPC_PASSWORD: "p" });
    expect(c.signer.kind).toBe("node");
  });

  it("requires a signer and sane numbers", () => {
    expect(() => loadAgentConfig({})).toThrow(/AGENT_SIGNER=node needs/);
    expect(() => loadAgentConfig({ AGENT_SIGNER: "hsm" })).toThrow(/"wif" or "node"/);
    expect(() => loadAgentConfig({ AGENT_WIF: wifRegtest, REQUESTS: "0" })).toThrow(/REQUESTS/);
    expect(() => loadAgentConfig({ AGENT_WIF: wifRegtest, MAX_PAYMENT_ZAT: "$1" })).toThrow(/MAX_PAYMENT_ZAT/);
    expect(() => loadAgentConfig({ AGENT_WIF: wifRegtest, X402_NETWORK: "ycash:devnet" })).toThrow(/X402_NETWORK/);
  });
});

describe("createAgent", () => {
  it("registers no Ycash client scheme until the mechanism chunks are wired (update this test then)", () => {
    expect(createAgent(loadAgentConfig({ AGENT_WIF: wifRegtest })).schemes).toEqual([]);
  });
});
