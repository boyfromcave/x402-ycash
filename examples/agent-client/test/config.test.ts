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
    expect(c.node?.url).toBe("http://127.0.0.1:18232/");
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
    expect(() => loadAgentConfig({ ...node, AGENT_SIGNER: "hsm" })).toThrow(/"wif", "node" or "none"/);
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

describe("a private agent: the light client alone (AGENT_SAPLING_BUILDER=http://… x402-light serve)", () => {
  it("needs no node, no lightwalletd client and no WIF; registers only the shielded methods", () => {
    const c = loadAgentConfig({ AGENT_SAPLING_BUILDER: "http://127.0.0.1:1/" });
    expect(c.signer).toEqual({ kind: "none" });
    expect(c.node).toBeUndefined();
    expect(c.lwd).toBeUndefined();
    expect(c.light?.url).toBe("http://127.0.0.1:1/");
    expect(c.reservationsPath).toMatch(/x402-ycash-reservations-light-[0-9a-f]{16}\.json$/);
    expect(createAgent(c).schemes).toEqual(["exact (sapling-proof, sapling)"]);
  });

  it("refuses a command builder alone (no tip, no sapling-proof payer) and AGENT_SIGNER=none without the light client", () => {
    expect(() => loadAgentConfig({ AGENT_SAPLING_BUILDER: "x402-light build" })).toThrow(/needs its node/);
    expect(() => loadAgentConfig({ ...node, AGENT_SIGNER: "none" })).toThrow(/AGENT_SAPLING_BUILDER/);
  });

  it("refuses a transparent 402: there is no transparent payer", async () => {
    const pr = { x402Version: 2, resource: { url: "http://shop/exact/quote", description: "", mimeType: "" }, accepts: [{ scheme: "exact", network: "ycash:regtest", asset: "YEC", amount: "1000", payTo: "sm1x", maxTimeoutSeconds: 60, extra: { assetTransferMethod: "transparent", areFeesSponsored: false } }] };
    const res = new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
    const a = createAgent(loadAgentConfig({ AGENT_SAPLING_BUILDER: "http://127.0.0.1:1/" }), undefined, async () => res.clone());
    await expect(a.call("http://shop/exact/quote")).rejects.toThrow(/shielded methods only/);
  });
});

describe("sapling (AGENT_SAPLING_BUILDER)", () => {
  const MEMO = "x402:" + "d4".repeat(32);
  const offer = (payTo: string) => ({
    scheme: "exact",
    network: "ycash:regtest",
    asset: "YEC",
    amount: "1500000",
    payTo,
    maxTimeoutSeconds: 900,
    extra: { assetTransferMethod: "sapling", areFeesSponsored: false, memo: MEMO, expiresAt: Math.floor(Date.now() / 1000) + 900 },
  });
  const required = (payTo: string) => ({ x402Version: 2, resource: { url: "http://shop/shielded/private-report", description: "", mimeType: "" }, accepts: [offer(payTo)] });

  it("reads the builder, joins sapling to exact, and refuses sapling routes cleanly without one", async () => {
    expect(loadAgentConfig({ ...node, AGENT_SAPLING_BUILDER: "x402-light build" }).saplingBuilder).toBe("x402-light build");
    // An http(s) builder is x402-light serve: it pays sapling-proof too (send), unless a node source is named.
    expect(createAgent(loadAgentConfig({ ...node, AGENT_SAPLING_BUILDER: "http://127.0.0.1:1/" })).schemes).toEqual(["exact (transparent, sapling-proof, sapling)", "batch-settlement"]);
    expect(createAgent(loadAgentConfig({ ...node, AGENT_SAPLING_BUILDER: "x402-light build" })).schemes).toEqual(["exact (transparent, sapling)", "batch-settlement"]);
    const pr = required("yregtestsapling1x");
    const res = new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
    const a = createAgent(loadAgentConfig({ ...node, MAX_PAYMENT_ZAT: "5000000" }), undefined, async () => res.clone());
    await expect(a.call("http://shop/shielded/private-report")).rejects.toThrow(/no Sapling transaction builder is configured/);
  });

  it("pays a sapling 402 with the builder's transaction: the expiry from the node's tip, the hex in payload.transaction", async () => {
    const { createServer } = await import("node:http");
    const { addressOf, buildPaymentTx, TEST_KEY } = await import("../../../packages/ycash/test/unit/shielded/saplingBuild.js");
    const payTo = addressOf(TEST_KEY);
    const TIP = 400;
    const built = buildPaymentTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: 1_500_000n, memo: MEMO }], valueBalance: 1000n, expiryHeight: TIP + 3 + 12 });
    const builds: unknown[] = [];
    // One endpoint plays the agent's node (getblockcount) and x402-light serve (build).
    const server = createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c: Buffer) => (body += c.toString()));
      rq.on("end", () => {
        const call = JSON.parse(body) as { id: number; method: string; params: unknown };
        rs.setHeader("content-type", "application/json");
        if (call.method === "getblockcount") return rs.end(JSON.stringify({ id: call.id, result: TIP, error: null }));
        builds.push(call.params);
        rs.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { txHex: built.hex, txid: built.txid } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      let presented: { payload?: { transaction?: string }; accepted?: { extra?: Record<string, unknown> } } | undefined;
      const shop: typeof fetch = async (input, init) => {
        const sig = (input instanceof Request ? input.headers : new Headers(init?.headers)).get("PAYMENT-SIGNATURE");
        if (!sig) {
          const pr = required(payTo.address);
          return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
        }
        presented = JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as typeof presented;
        return new Response(JSON.stringify({ paidWith: "exact/sapling" }), { status: 200 });
      };
      const a = createAgent(loadAgentConfig({ AGENT_RPC_URL: url, AGENT_RPC_USER: "u", AGENT_RPC_PASSWORD: "p", AGENT_SAPLING_BUILDER: url, MAX_PAYMENT_ZAT: "5000000" }), undefined, shop);
      const r = await a.call("http://shop/shielded/private-report");
      expect(r.status).toBe(200);
      expect(presented?.payload).toEqual({ transaction: built.hex });
      expect(presented?.accepted?.extra).toMatchObject({ assetTransferMethod: "sapling", memo: MEMO });
      expect(builds).toEqual([{ to: payTo.address, amountZat: "1500000", memoHex: Buffer.from(MEMO).toString("hex"), expiryHeight: TIP + 3 + 12 }]);
    } finally {
      server.close();
    }
  });
});
