import { describe, expect, it } from "vitest";
import { tx } from "x402-ycash-mechanism";
import { createAgent } from "../src/agent.js";
import { loadAgentConfig } from "../src/config.js";

const priv = new Uint8Array(32).fill(3);
const wifRegtest = tx.encodeWif(priv, "ycash:regtest");
const wifMainnet = tx.encodeWif(priv, "ycash:mainnet");

const node = { AGENT_RPC_URL: "http://127.0.0.1:18232", AGENT_RPC_USER: "u", AGENT_RPC_PASSWORD: "p" };

describe("loadAgentConfig", () => {
  it("builds a WIF signer and derives its sm… address on regtest", () => {
    const c = loadAgentConfig({ ...node, AGENT_WIF: wifRegtest });
    expect(c).toMatchObject({ url: "http://127.0.0.1:4021/exact/quote", requests: 1, network: "ycash:regtest", maxPaymentZat: "1000000" });
    expect(c.signer.kind).toBe("wif");
    if (c.signer.kind === "wif") {
      expect(c.signer.address.startsWith("sm")).toBe(true);
      expect(tx.decodeAddress(c.signer.address, "ycash:regtest").kind).toBe("p2pkh");
    }
  });

  it("refuses a mainnet WIF on regtest", () => {
    expect(() => loadAgentConfig({ ...node, AGENT_WIF: wifMainnet })).toThrow(/not for ycash:regtest/);
  });

  it("builds a node-wallet signer from RPC settings", () => {
    const c = loadAgentConfig({ AGENT_SIGNER: "node", ...node });
    expect(c.signer.kind).toBe("node");
    expect(c.node.url).toBe("http://127.0.0.1:18232/");
  });

  it("takes the sapling-proof source, the channel store and the deposit", () => {
    const c = loadAgentConfig({ ...node, AGENT_SHIELDED_FROM: "yregtestsapling1x", AGENT_CHANNEL_STORE: "/c.json", AGENT_CHANNEL_DEPOSIT_ZAT: "200000" });
    expect(c).toMatchObject({ shieldedFrom: "yregtestsapling1x", channelStorePath: "/c.json", channelDepositZat: 200_000n });
    expect(() => loadAgentConfig({ ...node, AGENT_CHANNEL_DEPOSIT_ZAT: "-1" })).toThrow(/DEPOSIT/);
  });

  it("keeps reservations in a per-payer file (AGENT_RESERVATIONS overrides) and takes the client's deposit cap", () => {
    const w = loadAgentConfig({ ...node, AGENT_WIF: wifRegtest });
    expect(w.reservationsPath).toMatch(new RegExp(`x402-ycash-reservations-${w.signer.kind === "wif" ? w.signer.address : "?"}\\.json$`));
    expect(loadAgentConfig({ ...node, AGENT_SIGNER: "node" }).reservationsPath).toMatch(/x402-ycash-reservations-node-[0-9a-f]{16}\.json$/);
    const c = loadAgentConfig({ ...node, AGENT_WIF: wifRegtest, AGENT_RESERVATIONS: "/r.json", AGENT_CHANNEL_MAX_DEPOSIT_ZAT: "5000000" });
    expect(c).toMatchObject({ reservationsPath: "/r.json", channelMaxDepositZat: 5_000_000n });
    expect(() => loadAgentConfig({ ...node, AGENT_CHANNEL_MAX_DEPOSIT_ZAT: "1e8" })).toThrow(/MAX_DEPOSIT/);
  });

  it("takes the client's closeFee cap (plan X-F50); unset, the mechanism's 5,000 zat applies", () => {
    expect(loadAgentConfig({ ...node, AGENT_CHANNEL_MAX_CLOSE_FEE_ZAT: "3000" }).channelMaxCloseFeeZat).toBe(3_000n);
    expect(loadAgentConfig(node).channelMaxCloseFeeZat).toBeUndefined();
    expect(() => loadAgentConfig({ ...node, AGENT_CHANNEL_MAX_CLOSE_FEE_ZAT: "-1" })).toThrow(/MAX_CLOSE_FEE/);
  });

  it("requires a signer and sane numbers", () => {
    expect(() => loadAgentConfig({})).toThrow(/needs its node/);
    expect(() => loadAgentConfig({ AGENT_WIF: wifRegtest })).toThrow(/needs its node/);
    expect(() => loadAgentConfig({ ...node, AGENT_SIGNER: "hsm" })).toThrow(/"wif" or "node"/);
    expect(() => loadAgentConfig({ ...node, AGENT_WIF: wifRegtest, REQUESTS: "0" })).toThrow(/REQUESTS/);
    expect(() => loadAgentConfig({ ...node, AGENT_WIF: wifRegtest, MAX_PAYMENT_ZAT: "$1" })).toThrow(/MAX_PAYMENT_ZAT/);
    expect(() => loadAgentConfig({ ...node, AGENT_WIF: wifRegtest, X402_NETWORK: "ycash:devnet" })).toThrow(/X402_NETWORK/);
  });
});

describe("createAgent", () => {
  it("registers exact (transparent) and batch-settlement; sapling-proof joins exact with a Sapling source", () => {
    const a = createAgent(loadAgentConfig({ ...node, AGENT_WIF: wifRegtest }));
    expect(a.schemes).toEqual(["exact (transparent)", "batch-settlement"]);
    expect(a.batch).toBeDefined();
    expect(createAgent(loadAgentConfig({ ...node, AGENT_SHIELDED_FROM: "yregtestsapling1x" })).schemes).toEqual(["exact (transparent, sapling-proof)", "batch-settlement"]);
  });

  it("allows YEC with an atomic cap (YEC is not a default asset) and refuses a 402 above it", async () => {
    const required = { x402Version: 2, resource: { url: "http://x/r", description: "", mimeType: "" }, accepts: [{ scheme: "exact", network: "ycash:regtest", asset: "YEC", amount: "2000000", payTo: "sm", maxTimeoutSeconds: 60, extra: {} }] };
    const res = new Response(JSON.stringify(required), { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") } });
    const a = createAgent(loadAgentConfig({ ...node, AGENT_WIF: wifRegtest, MAX_PAYMENT_ZAT: "1000000" }), undefined, async () => res.clone());
    await expect(a.call("http://x/r")).rejects.toThrow(/maxAmountPerPayment|spendControls/);
  });
});
