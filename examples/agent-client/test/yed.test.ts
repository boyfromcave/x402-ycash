// The agent's YED settings (plan X3): its own per-payment cap in cents (YED is a default asset with
// core's $1 cap, X-F43), YED channel deposits in cents, and a WIF funder that pays YED channels.
import { describe, expect, it } from "vitest";
import { ASSET_YED, type batch, channel, type exact, tx, utxoSourceFunder, yed, type YcashNetwork } from "x402-ycash-mechanism";
import { createAgent } from "../src/agent.js";
import { loadAgentConfig } from "../src/config.js";
import { channelDeposit } from "../src/schemes.js";

const NET: YcashNetwork = "ycash:regtest";
const node = { AGENT_RPC_URL: "http://127.0.0.1:1", AGENT_RPC_USER: "u", AGENT_RPC_PASSWORD: "p" };

function yed402(amount: string): Response {
  const required = {
    x402Version: 2,
    resource: { url: "http://x/yed/report", description: "", mimeType: "" },
    accepts: [{ scheme: "exact", network: NET, asset: "YED", amount, payTo: tx.encodeAddress(NET, "yed", new Uint8Array(20).fill(1)), maxTimeoutSeconds: 60, extra: { assetTransferMethod: "transparent" } }],
  };
  return new Response(JSON.stringify(required), { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") } });
}

describe("YED config", () => {
  it("defaults the YED cap to $1.00 and takes channel deposits in cents", () => {
    expect(loadAgentConfig(node)).toMatchObject({ maxPaymentYedCents: "100" });
    const c = loadAgentConfig({ ...node, MAX_PAYMENT_YED_CENTS: "500", AGENT_YED_CHANNEL_DEPOSIT_CENTS: "300", AGENT_YED_CHANNEL_MAX_DEPOSIT_CENTS: "2000" });
    expect(c).toMatchObject({ maxPaymentYedCents: "500", yedChannelDepositCents: 300n, yedChannelMaxDepositCents: 2_000n });
  });

  it("refuses a sub-dollar YED deposit (a YED channel holds at least the pre-paid $1.00) and a bad cap", () => {
    expect(() => loadAgentConfig({ ...node, AGENT_YED_CHANNEL_DEPOSIT_CENTS: "99" })).toThrow(/100\.\.10000000/);
    expect(() => loadAgentConfig({ ...node, AGENT_YED_CHANNEL_MAX_DEPOSIT_CENTS: "1.5" })).toThrow(/cents/);
    expect(() => loadAgentConfig({ ...node, MAX_PAYMENT_YED_CENTS: "$2" })).toThrow(/MAX_PAYMENT_YED_CENTS/);
  });
});

describe("YED spend controls", () => {
  it("refuses a $2 YED route at the default $1.00 cap, and gets past spend controls with MAX_PAYMENT_YED_CENTS=200", async () => {
    const low = createAgent(loadAgentConfig({ ...node, AGENT_SIGNER: "node" }), undefined, async () => yed402("200"));
    await expect(low.call("http://x/yed/report")).rejects.toThrow(/maxAmountPerPayment/);
    // At 200 the client selects the requirement and asks the signer, whose node is unreachable here.
    const high = createAgent(loadAgentConfig({ ...node, AGENT_SIGNER: "node", MAX_PAYMENT_YED_CENTS: "200" }), undefined, async () => yed402("200"));
    await expect(high.call("http://x/yed/report")).rejects.not.toThrow(/maxAmountPerPayment|spendControls/);
  });
});

describe("channelDeposit", () => {
  const terms = (asset: string, amount: bigint, maxDeposit: bigint) => ({ asset, amount, maxDeposit }) as batch.BatchTerms;
  it("uses each asset's own deposit, in its own unit", () => {
    const d = channelDeposit({ YEC: 150_000n, YED: 500n }, {});
    expect(d(terms("YEC", 1_000n, 100_000_000n))).toBe(150_000n);
    expect(d(terms("YED", 1n, 10_000n))).toBe(500n);
  });
  it("falls back to amount × 100 clipped at the client's cap, and always within the server's maxDeposit", () => {
    const d = channelDeposit({ YEC: 150_000n }, { YED: 3_000n });
    expect(d(terms("YED", 1n, 10_000n))).toBe(100n);
    expect(d(terms("YED", 50n, 10_000n))).toBe(3_000n); // 5,000 clipped at the agent's cap
    expect(d(terms("YED", 75n, 10_000n))).toBe(3_000n);
    expect(channelDeposit({ YED: 500n }, {})(terms("YED", 1n, 400n))).toBe(400n);
    expect(channelDeposit({}, {})(terms("YED", 200n, 100_000n))).toBe(5_000n); // the mechanism's $50 default
  });
});

// A WIF agent funds both assets' channels with the mechanism's utxoSourceFunder (schemes.ts).
describe("utxoSourceFunder as the WIF channel funder", () => {
  const priv = new Uint8Array(32).fill(5);
  const hash = tx.hash160(tx.pubkeyFromPriv(priv));
  const script = tx.p2pkhScript(hash);
  const txid = (n: number) => n.toString(16).padStart(64, "0");
  const source = (reserveOk = true) => {
    const reserved: string[] = [];
    const s: exact.UtxoSource = {
      chainState: async () => ({ chain: "regtest", height: 300, branchId: 0x19bd2d2f }),
      listCoins: async () => [{ txid: txid(1), vout: 0, value: 5_000_000n, scriptPubKey: script, confirmations: 5 }],
      listTokens: async () => [{ outpoint: { txid: txid(2), vout: 0 }, cents: 800, value: 10_000n, scriptPubKey: script }],
      reserve: async (coins) => {
        reserved.push(...coins.map((c) => `${c.txid}:${c.vout}`));
        return reserveOk;
      },
    };
    return { s, reserved };
  };
  const redeemScript = channel.buildChannelScript({ clientPubKey: tx.pubkeyFromPriv(priv), serverPubKey: tx.pubkeyFromPriv(new Uint8Array(32).fill(6)), refundHeight: 400 });

  it("funds a YED channel with a TRANSFER of D to vout 0 and YED change to the key, and reserves both inputs", async () => {
    const { s, reserved } = source();
    const hex = await utxoSourceFunder(priv, s).fund({ network: NET, redeemScript, value: 25_000n, branchId: 0x19bd2d2f, asset: ASSET_YED, deposit: 500n });
    const t = tx.parseTx(hex);
    const found = yed.findPayload(t.vout);
    expect(found && "payload" in found ? found.payload : undefined).toMatchObject({ type: "transfer", assignments: [{ vout: 0, cents: 500 }, { vout: 1, cents: 300 }] });
    expect(tx.equalBytes(t.vout[1]!.scriptPubKey, script)).toBe(true);
    expect(reserved.sort()).toEqual([`${txid(1)}:0`, `${txid(2)}:0`]);
  });

  it("refuses when another spend took a coin meanwhile", async () => {
    await expect(utxoSourceFunder(priv, source(false).s).fund({ network: NET, redeemScript, value: 25_000n, branchId: 0x19bd2d2f, asset: ASSET_YED, deposit: 500n })).rejects.toThrow(/try again/);
  });
});
