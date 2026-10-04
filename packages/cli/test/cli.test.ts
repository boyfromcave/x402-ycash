import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batch as B, channel, FileClientChannelStorage, tx as T, type YcashRpc } from "x402-ycash-mechanism";
import { loadCliConfig, parseCli, run, UsageError } from "../src/index.js";

const NET = "ycash:regtest" as const;
const devnetEnv = { X402_RPC_URL: "http://127.0.0.1:1", X402_RPC_USER: "u", X402_RPC_PASSWORD: "p" };
const wif = T.encodeWif(T.hexToBytes("07".repeat(32)), NET);

describe("configuration", () => {
  it("takes flags over the environment, with defaults", () => {
    const c = loadCliConfig(parseCli(["pay", "http://x", "--count", "3", "--network", "ycash:testnet", "--channels", "/c.json"]), { ...devnetEnv, X402_NETWORK: "ycash:mainnet", X402_CHANNEL_STORE: "/env.json" });
    expect(c).toMatchObject({ network: "ycash:testnet", count: 3, channelStorePath: "/c.json", maxPaymentZat: 1_000_000n });
    expect(c.node.url).toBe("http://127.0.0.1:1/");
    expect(loadCliConfig(parseCli(["pay", "x"]), { ...devnetEnv, X402_WIF: wif, X402_MAX_PAYMENT_ZAT: "5000" })).toMatchObject({ wif, maxPaymentZat: 5000n });
  });

  it("keeps coin reservations next to the channel store by default, and takes the client's deposit cap", () => {
    expect(loadCliConfig(parseCli(["pay", "x", "--channels", "/w/c.json"]), devnetEnv)).toMatchObject({ reservationsPath: "/w/reservations.json" });
    const c = loadCliConfig(parseCli(["channel", "open", "x", "--max-deposit", "3000000", "--reservations", "/r.json"]), devnetEnv);
    expect(c).toMatchObject({ reservationsPath: "/r.json", maxDepositZat: 3_000_000n });
    expect(loadCliConfig(parseCli(["pay", "x"]), { ...devnetEnv, X402_MAX_DEPOSIT_ZAT: "7" }).maxDepositZat).toBe(7n);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--max-deposit", "0"]), devnetEnv)).toThrow(/--max-deposit/);
  });

  it("refuses a missing node, a bad network, a mainnet WIF on regtest, and bad numbers", () => {
    expect(() => loadCliConfig(parseCli(["pay", "x"]), {})).toThrow(/no node/);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--rpc-url", "http://n"]), {})).toThrow(/rpc-user/);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--network", "zcash:mainnet"]), devnetEnv)).toThrow(UsageError);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--wif", T.encodeWif(T.hexToBytes("07".repeat(32)), "ycash:mainnet")]), devnetEnv)).toThrow(/--wif/);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--count", "0"]), devnetEnv)).toThrow(/--count/);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--deposit", "1.5"]), devnetEnv)).toThrow(/--deposit/);
    expect(() => parseCli(["pay", "--bogus"])).toThrow(UsageError);
  });
});

/** A live channel record and a node that sees it. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "x402-cli-"));
  const store = join(dir, "channels.json");
  const cPriv = T.hexToBytes("11".repeat(32));
  const sPub = T.pubkeyFromPriv(T.hexToBytes("22".repeat(32)));
  const cPub = T.pubkeyFromPriv(cPriv);
  const payTo = T.encodeAddress(NET, "p2pkh", new Uint8Array(20).fill(9));
  const redeemScript = channel.buildChannelScript({ clientPubKey: cPub, serverPubKey: sPub, refundHeight: 500 });
  const channelId = "ab".repeat(32) + ":0";
  const rec: B.client.ClientChannelRecord = {
    channelId, offerKey: B.client.offerKeyOf(NET, payTo, T.bytesToHex(sPub)), network: NET, asset: "YEC", payTo, serverPubKey: T.bytesToHex(sPub),
    redeemScript: T.bytesToHex(redeemScript), fundingTx: "00", vout: 0, value: "101500", closeFee: "1500", deposit: "100000", refundHeight: 500,
    closeMarginBlocks: 5, clientPrivKey: T.bytesToHex(cPriv), clientScript: T.bytesToHex(T.p2pkhScript(T.hash160(cPub))), charged: "5000", signed: "6000", status: "open",
  };
  const sent: string[] = [];
  const node = {
    url: "fake",
    getBlockchainInfo: async () => ({ chain: "regtest", blocks: 120, consensus: { chaintip: "19bd2d2f", nextblock: "19bd2d2f" } }),
    getTxOut: async () => ({ confirmations: 3, value: 0.001015 }),
    sendRawTransaction: async (hex: string) => (sent.push(hex), T.txid(T.parseTx(hex))),
  } as unknown as YcashRpc;
  const accept = { scheme: "batch-settlement", network: NET, asset: "YEC", amount: "1000", payTo, maxTimeoutSeconds: 300, extra: { serverPubKey: T.bytesToHex(sPub), minLockBlocks: 30, closeMarginBlocks: 5, maxDeposit: "100000000", closeFee: "1500" } };
  return { store, rec, node, accept, sent };
}

function capture() {
  const lines: Record<string, unknown>[] = [];
  const errs: string[] = [];
  return { lines, errs, io: { out: (r: Record<string, unknown>) => lines.push(r), err: (l: string) => errs.push(l) } };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

describe("x402-ycash channel", () => {
  it("status lists the store's channels against the node", async () => {
    const f = fixture();
    await new FileClientChannelStorage(f.store).put(f.rec);
    const c = capture();
    expect(await run(["channel", "status", "--channels", f.store], devnetEnv, c.io, { node: f.node })).toBe(0);
    expect(c.lines).toEqual([expect.objectContaining({ channelId: f.rec.channelId, status: "open", tip: 120, refundHeight: 500, blocksToRefund: 380, unspent: true, charged: "5000", payTo: f.rec.payTo })]);
  });

  it("close sends the client's close voucher at the charged total and records the server's close txid", async () => {
    const f = fixture();
    await new FileClientChannelStorage(f.store).put(f.rec);
    const required = { x402Version: 2, resource: { url: "http://shop/channel/search", description: "", mimeType: "" }, accepts: [f.accept] };
    let presented: { accepted: unknown; payload: { type: string; cumulative: string; channelId: string; tx: string } } | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const sig = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (!sig) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(required) } });
      presented = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
      return new Response(JSON.stringify({ channelId: f.rec.channelId, message: "closing" }), { status: 200, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "cd".repeat(32), network: NET }) } });
    }) as typeof fetch;
    const c = capture();
    expect(await run(["channel", "close", "http://shop/channel/search", "--channels", f.store], devnetEnv, c.io, { node: f.node, fetch: fakeFetch })).toBe(0);
    expect(presented?.accepted).toEqual(f.accept);
    expect(presented?.payload).toMatchObject({ type: "close", channelId: f.rec.channelId, cumulative: "5000" });
    // the voucher pays the server exactly the charged total
    expect(T.parseTx(presented!.payload.tx).vout[0]?.value).toBe(5000n);
    expect(c.lines.at(-1)).toMatchObject({ msg: "closed", transaction: "cd".repeat(32) });
    expect(await new FileClientChannelStorage(f.store).get(f.rec.channelId)).toMatchObject({ status: "closed", closeTxid: "cd".repeat(32) });
  });

  it("close refuses a route without batch-settlement, and a refusal leaves the channel open", async () => {
    const f = fixture();
    await new FileClientChannelStorage(f.store).put(f.rec);
    const exactOnly = { x402Version: 2, accepts: [{ ...f.accept, scheme: "exact" }] };
    const c = capture();
    const only = (async () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(exactOnly) } })) as unknown as typeof fetch;
    expect(await run(["channel", "close", "http://shop/x", "--channels", f.store], devnetEnv, c.io, { node: f.node, fetch: only })).toBe(2);
    expect(c.errs.join()).toMatch(/offers no batch-settlement/);
    const refusing = (async (_u: string, init?: RequestInit) =>
      new Headers(init?.headers).get("PAYMENT-SIGNATURE")
        ? new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [f.accept], error: "invalid_batch_settlement_ycash_channel_busy" }) } })
        : new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [f.accept] }) } })) as unknown as typeof fetch;
    expect(await run(["channel", "close", "http://shop/x", "--channels", f.store], devnetEnv, c.io, { node: f.node, fetch: refusing })).toBe(1);
    expect((await new FileClientChannelStorage(f.store).get(f.rec.channelId))?.status).toBe("open");
  });

  it("refund is refused before t and broadcast from t", async () => {
    const f = fixture();
    await new FileClientChannelStorage(f.store).put(f.rec);
    const c = capture();
    expect(await run(["channel", "refund", f.rec.channelId, "--channels", f.store], devnetEnv, c.io, { node: f.node })).toBe(1);
    expect(c.errs.join()).toMatch(/valid from height 500/);
    const late = { ...f.node, getBlockchainInfo: async () => ({ chain: "regtest", blocks: 500, consensus: { chaintip: "19bd2d2f", nextblock: "19bd2d2f" } }) } as unknown as YcashRpc;
    expect(await run(["channel", "refund", f.rec.channelId, "--channels", f.store], devnetEnv, c.io, { node: late })).toBe(0);
    expect(f.sent).toHaveLength(1);
    expect(T.parseTx(f.sent[0]!).lockTime).toBe(500);
    expect((await new FileClientChannelStorage(f.store).get(f.rec.channelId))?.status).toBe("refunded");
  });
});

describe("x402-ycash", () => {
  it("prints usage on --help and refuses unknown commands", async () => {
    const c = capture();
    expect(await run(["--help"], {}, c.io)).toBe(0);
    expect(c.errs[0]).toMatch(/x402-ycash channel open/);
    expect(await run(["frobnicate"], devnetEnv, c.io)).toBe(2);
    expect(await run(["channel", "open"], devnetEnv, c.io)).toBe(2);
  });

  it("pay reports a route that is not paid, and a 402 it cannot pay", async () => {
    const f = fixture();
    const c = capture();
    const free = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    expect(await run(["pay", "http://shop/free", "--channels", f.store], devnetEnv, c.io, { node: f.node, fetch: free })).toBe(0);
    expect(c.lines[0]).toMatchObject({ i: 1, status: 200, body: { ok: true } });
    const foreign = (async () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [{ ...f.accept, scheme: "exact", network: "eip155:1" }] }) } })) as unknown as typeof fetch;
    expect(await run(["pay", "http://shop/x", "--channels", f.store], devnetEnv, c.io, { node: f.node, fetch: foreign })).toBe(1);
    expect(c.errs.at(-1)).toMatch(/payment/i);
  });
});
