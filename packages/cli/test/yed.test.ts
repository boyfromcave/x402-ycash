// The CLI's YED paths (plan X3): `--asset YED` with deposits in cents, YED spend caps, the YED
// channel close at max($1.00, charged), and the refund carrying its TRANSFER.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batch as B, channel, FileClientChannelStorage, tx as T, yed, type YcashRpc } from "x402-ycash-mechanism";
import { depositFor } from "../src/client.js";
import { loadCliConfig, parseCli, run } from "../src/index.js";

const NET = "ycash:regtest" as const;
const env = { X402_RPC_URL: "http://127.0.0.1:1", X402_RPC_USER: "u", X402_RPC_PASSWORD: "p" };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

function capture() {
  const lines: Record<string, unknown>[] = [];
  const errs: string[] = [];
  return { lines, errs, io: { out: (r: Record<string, unknown>) => lines.push(r), err: (l: string) => errs.push(l) } };
}

describe("YED configuration", () => {
  it("reads --deposit in cents under --asset YED, and the YED caps", () => {
    const c = loadCliConfig(parseCli(["channel", "open", "x", "--asset", "yed", "--deposit", "500", "--max-deposit-yed", "2000", "--max-payment-yed", "250"]), env);
    expect(c).toMatchObject({ asset: "YED", depositCents: 500n, maxDepositCents: 2_000n, maxPaymentYedCents: 250n });
    expect(c.depositZat).toBeUndefined();
    expect(loadCliConfig(parseCli(["pay", "x"]), env).maxPaymentYedCents).toBe(100n);
    expect(loadCliConfig(parseCli(["pay", "x"]), { ...env, X402_MAX_PAYMENT_YED_CENTS: "300", X402_MAX_DEPOSIT_YED_CENTS: "900" })).toMatchObject({ maxPaymentYedCents: 300n, maxDepositCents: 900n });
    expect(loadCliConfig(parseCli(["channel", "open", "x", "--deposit", "500"]), env)).toMatchObject({ depositZat: 500n });
  });

  it("refuses a sub-dollar YED deposit, an unknown asset and fractional cents", () => {
    expect(() => loadCliConfig(parseCli(["channel", "open", "x", "--asset", "YED", "--deposit", "99"]), env)).toThrow(/--deposit.*100\.\.10000000/);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--asset", "USDC"]), env)).toThrow(/YEC or YED/);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--max-payment-yed", "1.5"]), env)).toThrow(/--max-payment-yed/);
  });

  it("depositFor: each asset's own deposit, the default clipped at the client's cap, within the server's maxDeposit", () => {
    const t = (asset: string, amount: bigint, maxDeposit: bigint) => ({ asset, amount, maxDeposit }) as B.BatchTerms;
    expect(depositFor({})).toBeUndefined();
    const d = depositFor({ depositCents: 500n, depositZat: 150_000n })!;
    expect(d(t("YED", 1n, 10_000n))).toBe(500n);
    expect(d(t("YEC", 1_000n, 100_000_000n))).toBe(150_000n);
    expect(d(t("YED", 1n, 300n))).toBe(300n);
    expect(depositFor({ depositZat: 1n, maxDepositCents: 2_000n })!(t("YED", 100n, 100_000n))).toBe(2_000n);
    expect(depositFor({ depositZat: 1n })!(t("YED", 100n, 100_000n))).toBe(5_000n);
  });
});

/** A live YED channel record (D = $5.00, charged 50 cents) and a node that sees it. */
function fixture(tip = 120) {
  const store = join(mkdtempSync(join(tmpdir(), "x402-cli-yed-")), "channels.json");
  const cPriv = T.hexToBytes("11".repeat(32));
  const sPub = T.pubkeyFromPriv(T.hexToBytes("22".repeat(32)));
  const cPub = T.pubkeyFromPriv(cPriv);
  const payTo = T.encodeAddress(NET, "yed", new Uint8Array(20).fill(9));
  const redeemScript = channel.buildChannelScript({ clientPubKey: cPub, serverPubKey: sPub, refundHeight: 500 });
  const rec: B.client.ClientChannelRecord = {
    channelId: "ab".repeat(32) + ":0", offerKey: B.client.offerKeyOf(NET, payTo, T.bytesToHex(sPub)), network: NET, asset: "YED", payTo, serverPubKey: T.bytesToHex(sPub),
    redeemScript: T.bytesToHex(redeemScript), fundingTx: "00", vout: 0, value: channel.yedChannelValue(2_000n).toString(), closeFee: "2000", deposit: "500", refundHeight: 500,
    closeMarginBlocks: 5, clientPrivKey: T.bytesToHex(cPriv), clientScript: T.bytesToHex(T.p2pkhScript(T.hash160(cPub))), charged: "50", signed: "100", status: "open",
  };
  const sent: string[] = [];
  const walletYed = T.encodeAddress(NET, "yed", new Uint8Array(20).fill(4));
  const node = {
    url: "fake",
    getBlockchainInfo: async () => ({ chain: "regtest", blocks: tip, consensus: { chaintip: "19bd2d2f", nextblock: "19bd2d2f" } }),
    getTxOut: async () => ({ confirmations: 3, value: 0.0003 }),
    sendRawTransaction: async (hex: string) => (sent.push(hex), T.txid(T.parseTx(hex))),
    call: async (method: string) => {
      if (method === "yed_getnewaddress") return walletYed;
      if (method === "getrawtransaction") return sent.at(-1);
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as YcashRpc;
  const accept = { scheme: "batch-settlement", network: NET, asset: "YED", amount: "1", payTo, maxTimeoutSeconds: 300, extra: { serverPubKey: T.bytesToHex(sPub), minLockBlocks: 30, closeMarginBlocks: 5, maxDeposit: "10000", closeFee: "2000" } };
  return { store, rec, node, accept, sent, walletYed };
}

describe("x402-ycash with YED channels", () => {
  it("close pays the pre-paid $1.00 when less was charged: cumulative max($1.00, charged) in the YED layout", async () => {
    const f = fixture();
    await new FileClientChannelStorage(f.store).put(f.rec);
    let presented: { payload: { cumulative: string; tx: string } } | undefined;
    const fakeFetch = (async (_u: string, init?: RequestInit) => {
      const sig = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (!sig) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [f.accept] }) } });
      presented = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
      return new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "cd".repeat(32), network: NET }) } });
    }) as typeof fetch;
    const c = capture();
    expect(await run(["channel", "close", "http://shop/yed/stream", "--asset", "YED", "--channels", f.store], env, c.io, { node: f.node, fetch: fakeFetch })).toBe(0);
    expect(presented?.payload.cumulative).toBe("100");
    const found = yed.findPayload(T.parseTx(presented!.payload.tx).vout);
    expect(found && "payload" in found ? found.payload : found).toMatchObject({ type: "transfer", assignments: [{ vout: 0, cents: 100 }, { vout: 1, cents: 400 }] });
    expect(c.lines.at(-1)).toMatchObject({ msg: "closed", asset: "YED", charged: "50", cumulative: "100" });
  });

  it("refund from t carries a TRANSFER of all of D, by default to a new address of the node's YED wallet", async () => {
    const f = fixture(500);
    await new FileClientChannelStorage(f.store).put(f.rec);
    const c = capture();
    expect(await run(["channel", "refund", f.rec.channelId, "--channels", f.store], env, c.io, { node: f.node })).toBe(0);
    const t = T.parseTx(f.sent[0]!);
    expect(t.lockTime).toBe(500);
    expect(T.equalBytes(t.vout[1]!.scriptPubKey, T.addressToScript(f.walletYed, NET))).toBe(true);
    expect(c.lines.at(-1)).toMatchObject({ msg: "refunded", asset: "YED", to: f.walletYed, transfer: { type: "transfer", assignments: [{ vout: 1, cents: 500 }] } });
  });

  it("refund goes to the WIF key's address with --wif, to --to when given, and never to a P2SH", async () => {
    const wifPriv = T.hexToBytes("07".repeat(32));
    const wifYed = T.encodeAddress(NET, "yed", T.hash160(T.pubkeyFromPriv(wifPriv)));
    for (const [flags, want] of [[["--wif", T.encodeWif(wifPriv, NET)], wifYed], [["--to", T.encodeAddress(NET, "yed", new Uint8Array(20).fill(3))], T.encodeAddress(NET, "yed", new Uint8Array(20).fill(3))]] as const) {
      const f = fixture(500);
      await new FileClientChannelStorage(f.store).put(f.rec);
      const c = capture();
      expect(await run(["channel", "refund", f.rec.channelId, "--channels", f.store, ...flags], env, c.io, { node: f.node })).toBe(0);
      expect(c.lines.at(-1)).toMatchObject({ to: want });
    }
    const f = fixture(500);
    await new FileClientChannelStorage(f.store).put(f.rec);
    const c = capture();
    expect(await run(["channel", "refund", f.rec.channelId, "--channels", f.store, "--to", T.encodeAddress(NET, "p2sh", new Uint8Array(20).fill(3))], env, c.io, { node: f.node })).toBe(2);
    expect(f.sent).toHaveLength(0);
  });

  it("channel open --asset YED refuses a route without a YED channel; pay refuses a $2 YED route above the YED cap", async () => {
    const f = fixture();
    const yecOnly = (async () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [{ ...f.accept, asset: "YEC" }] }) } })) as unknown as typeof fetch;
    const c = capture();
    expect(await run(["channel", "open", "http://shop/channel/search", "--asset", "YED", "--channels", f.store], env, c.io, { node: f.node, fetch: yecOnly })).toBe(2);
    expect(c.errs.join()).toMatch(/no batch-settlement in YED/);
    const report = { scheme: "exact", network: NET, asset: "YED", amount: "200", payTo: f.accept.payTo, maxTimeoutSeconds: 60, extra: { assetTransferMethod: "transparent" } };
    const dollars = (async () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [report] }) } })) as unknown as typeof fetch;
    expect(await run(["pay", "http://shop/yed/report", "--channels", f.store], env, c.io, { node: f.node, fetch: dollars })).toBe(1);
    expect(c.errs.at(-1)).toMatch(/maxAmountPerPayment/);
  });
});
