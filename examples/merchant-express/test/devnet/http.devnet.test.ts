// The HTTP path end to end on a live devnet of either line (plan §4.3, X1/X2/X4a acceptance): the
// facilitator service, the merchant and the agent run as separate processes and talk real HTTP;
// the CLI closes the channel the agent opened. Blocks that confirm payments are mined by node 1,
// the stock seat (OP-1); one block through the yolo stratum pool (OP-3); the same suite runs against
// a ycash-dd and a ycash6 devnet (OP-4); and a second facilitator runs on the stock node (OP-6).
//
//   scripts/devnet.sh up dd 181 && X402_DEVNET_JSON=…/dd-181/devnet.json npm run test:devnet -w x402-ycash-example-merchant-express
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tx, verifyReceipt, type DecodedTransaction, type ZSendManyOptions } from "x402-ycash-mechanism";
import { DEVNET_JSON, describeDevnet, devnet, record, waitFor, type Devnet } from "../../../../packages/ycash/test/devnet/harness.js";
import { REPO, runAgent, runCli, startService, type Proc } from "./procs.js";

const NETWORK = "ycash:regtest";
const WORKSPACE = process.env.YELLOWBACK_WORKSPACE ?? resolve(REPO, "../..");
const PRICE = { exact: 250_000n, ticker: 10_000n, channel: 1_000n, shielded: 1_500_000n };

interface PaidLine {
  i: number;
  status: number;
  ms: number;
  settlement?: { success: boolean; transaction: string; network: string; payer?: string; extra?: Record<string, unknown>; extensions?: Record<string, unknown> };
  body: unknown;
}

describeDevnet("HTTP end to end: facilitator, merchant and agent as processes", () => {
  let d: Devnet;
  let dir: string;
  let payTo: string; // node 1's wallet: getreceivedbyaddress counts what the merchant got
  let receiptPub: Uint8Array;
  let fac: Proc & { url: string };
  let shop: Proc & { url: string };
  const procs: Proc[] = [];
  let wif: string; // the local-key payer, watched by node 0
  let zFrom: string; // the node-2 payer's Sapling source (tier P1)
  const devnetJson = DEVNET_JSON as string;

  const agentEnv = (url: string, extra: Record<string, string>): Record<string, string> => ({
    X402_NETWORK: NETWORK,
    RESOURCE_URL: url,
    AGENT_DEVNET_JSON: devnetJson,
    MAX_PAYMENT_ZAT: "5000000",
    ...extra,
  });

  /** Runs the agent to completion; returns its per-request lines. */
  async function agent(url: string, extra: Record<string, string>, whileRunning?: (p: Proc) => Promise<void>): Promise<PaidLine[]> {
    const p = runAgent(agentEnv(url, extra));
    procs.push(p);
    if (whileRunning) await whileRunning(p);
    const code = await p.exited;
    const lines = p.lines.filter((l) => typeof l.i === "number") as unknown as PaidLine[];
    if (code !== 0) throw new Error(`agent exited ${code}: ${p.stderr.join("")} ${JSON.stringify(p.lines.slice(-3))}`);
    return lines;
  }

  /** Mines one block on node 1 (stock) once a transaction reaches its mempool, unless the agent finished first. */
  async function mineWhenSeen(p: Proc, n = 1): Promise<string | undefined> {
    let done = false;
    void p.exited.then(() => (done = true));
    await waitFor(async () => done || (await d.stock.getRawMempool()).length >= n, { timeoutMs: 120_000, what: "a payment in node 1's mempool" });
    if (done) return undefined;
    const [hash] = await d.mine(1, d.stock);
    return hash;
  }

  async function receivedBy(address: string, minconf = 1): Promise<bigint> {
    return BigInt(Math.round((await d.stock.call<number>("getreceivedbyaddress", [address, minconf])) * 1e8));
  }

  async function blockTxs(hash: string): Promise<string[]> {
    return (await d.stock.call<{ tx: string[] }>("getblock", [hash])).tx;
  }

  beforeAll(async () => {
    d = await devnet();
    dir = mkdtempSync(join(tmpdir(), "x402-http-"));
    const receiptKey = tx.randomPrivKey();
    receiptPub = tx.pubkeyFromPriv(receiptKey);
    payTo = await d.stock.getNewAddress();
    const registry = join(dir, "issued.json");

    // The merchant's own facilitator on node 0 (its wallet), with sapling-proof and mempool settlement.
    fac = await startService("facilitator", {
      X402_NETWORK: NETWORK,
      X402_DEVNET_JSON: devnetJson,
      X402_DEVNET_NODE: "0",
      X402_PORT: "0",
      X402_SETTLEMENT_STORE: join(dir, "settlements.json"),
      X402_CHANNEL_STORE: join(dir, "fac-channels.json"),
      X402_CONFIRMATIONS_MIN: "-1",
      X402_RECEIPT_KEY: tx.bytesToHex(receiptKey),
      X402_ISSUED_REGISTRY: registry,
    });
    procs.push(fac);
    shop = await startService("merchant", {
      X402_NETWORK: NETWORK,
      PORT: "0",
      FACILITATOR_URL: fac.url,
      MERCHANT_PAY_TO: payTo,
      MERCHANT_DEVNET_JSON: devnetJson,
      MERCHANT_DEVNET_NODE: "0",
      MERCHANT_CHANNEL_KEY: tx.bytesToHex(tx.randomPrivKey()),
      MERCHANT_CHANNEL_STORE: join(dir, "merchant-channels.json"),
      MERCHANT_MIN_LOCK_BLOCKS: "30",
      MERCHANT_CLOSE_MARGIN_BLOCKS: "5",
      MERCHANT_ISSUED_REGISTRY: registry,
      MERCHANT_SHIELDED_CONFIRMATIONS: "-1",
      MERCHANT_WATCHER_POLL_MS: "2000",
    });
    procs.push(shop);

    // The local-key payer: node 0 watches its address before it is funded (importaddress, no rescan).
    const priv = tx.randomPrivKey();
    wif = tx.encodeWif(priv, NETWORK);
    const wifAddress = tx.encodeAddress(NETWORK, "p2pkh", tx.hash160(tx.pubkeyFromPriv(priv)));
    await d.wallet.call("importaddress", [wifAddress, "", false]);
    for (let i = 0; i < 4; i++) await d.fund(wifAddress, 10_000_000n);
    // The node-2 payer: confirmed non-coinbase coins (the channel funder skips coinbase) and a Sapling note.
    const tFrom = await d.pool.getNewAddress();
    for (let i = 0; i < 4; i++) await d.fund(tFrom, 300_000_000n);
    await d.mine(1);
    zFrom = await d.pool.zGetNewAddress();
    const tOpts: ZSendManyOptions = d.line === "v6" ? { minconf: 1, privacyPolicy: "AllowFullyTransparent" } : { minconf: 1 };
    await d.pool.zSendManyAndWait(tFrom, [{ address: zFrom, amount: 100_000_000n }], tOpts);
    await d.mine(1);
    await waitFor(async () => (await d.pool.zListReceivedByAddress(zFrom, 1)).length > 0, { what: "the payer's Sapling note" });
    record(d.line, "HTTP stack", { facilitator: fac.url, merchant: shop.url, payTo });
  });

  afterAll(async () => {
    await Promise.all(procs.map((p) => p.stop()));
  });

  it("exact YEC at policy 1 (local key): settled once node 1, the stock seat, mines it (OP-1)", async () => {
    const before = await receivedBy(payTo);
    let mined: string | undefined;
    const [r] = await agent(`${shop.url}/exact/quote`, { AGENT_DEVNET_NODE: "0", AGENT_WIF: wif }, async (p) => {
      mined = await mineWhenSeen(p);
    });
    expect(r).toMatchObject({ status: 200, body: { paidWith: "exact/transparent" }, settlement: { success: true, network: NETWORK, extra: { status: "confirmed", confirmations: 1 } } });
    expect(await blockTxs(mined as string)).toContain(r!.settlement!.transaction);
    expect((await receivedBy(payTo)) - before).toBe(PRICE.exact);
    record(d.line, "HTTP exact policy 1", { ms: r!.ms, txid: r!.settlement!.transaction, payer: r!.settlement!.payer });
  });

  it("exact YEC at policy −1 (node wallet): served from the mempool, then mined through the yolo stratum pool (OP-3)", async () => {
    const [r] = await agent(`${shop.url}/exact/ticker`, { AGENT_DEVNET_NODE: "2", AGENT_SIGNER: "node" });
    expect(r).toMatchObject({ status: 200, settlement: { success: true, extra: { status: "mempool", confirmations: -1 } } });
    const id = r!.settlement!.transaction;
    const { n } = await d.findVout(id, payTo);

    const state = JSON.parse(readFileSync(devnetJson, "utf8")) as { portseed: number; bitcoind: string; dir: string; stratum?: Record<string, { payout: string }> };
    const repo = d.line === "v6" ? "ycash6" : "ycash-dd";
    const cli = join(WORKSPACE, repo, "contrib/yellowback/devnet/yellowback-devnet");
    const env = { ...process.env, YELLOWBACK_DEVNET_DIR: state.dir, YELLOWBACK_DEVNET_PORTSEED: String(state.portseed), [d.line === "v6" ? "ZCASHD" : "BITCOIND"]: state.bitcoind };
    const devnetCli = (...args: string[]) => promisify(execFile)(join(WORKSPACE, ".venv/bin/python"), [cli, ...args], { env, timeout: 300_000 });
    const POOL = 3;
    await devnetCli("pool", String(POOL), "stratum", "start");
    let stratumBlocks = 0;
    try {
      await d.syncMempools();
      // yolo hands out new work only when the height moves, so mine through it until the tx is in.
      while (stratumBlocks < 4 && (await d.stock.getTxOut(id, n, false)) === null) {
        await devnetCli("mine", "1", String(POOL));
        stratumBlocks++;
        await d.syncBlocks();
      }
    } finally {
      await devnetCli("pool", String(POOL), "stratum", "stop");
    }
    const out = await d.stock.getTxOut(id, n, false);
    expect(out?.confirmations).toBeGreaterThanOrEqual(1);
    const best = await d.stock.call<string>("getbestblockhash");
    const height = (await d.stock.call<{ height: number }>("getblock", [best])).height;
    const payout = (JSON.parse(readFileSync(devnetJson, "utf8")) as typeof state).stratum?.[String(POOL)]?.payout;
    record(d.line, "HTTP exact policy −1 + OP-3", { ms: r!.ms, txid: id, stratumBlocks, height, payout });
    await d.mine(1, d.stock); // let every wallet catch up before the next case
  });

  it("a channel session: open (funding mined by the stock node), 100 paid requests, the CLI's close; the merchant receives Σ charges", async () => {
    const store = join(dir, "agent-channels.json");
    const url = `${shop.url}/channel/search?q=ycash`;
    const before = await receivedBy(payTo);
    const t0 = Date.now();
    const lines = await agent(url, { AGENT_DEVNET_NODE: "2", AGENT_SIGNER: "node", REQUESTS: "100", AGENT_CHANNEL_STORE: store, AGENT_CHANNEL_DEPOSIT_ZAT: "150000" }, async (p) => {
      await mineWhenSeen(p); // the open waits for the funding depth (1)
    });
    const sessionMs = Date.now() - t0;
    expect(lines).toHaveLength(100);
    expect(lines.every((l) => l.status === 200 && l.settlement?.success)).toBe(true);
    const last = lines.at(-1)!.settlement!.extra as { channelState: { channelId: string; chargedCumulative: string } };
    expect(last.channelState.chargedCumulative).toBe((100n * PRICE.channel).toString());
    const channelId = last.channelState.channelId;

    const cliNode = ["--devnet", devnetJson, "--node", "2", "--channels", store];
    const status = await runCli(["channel", "status", channelId, ...cliNode]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.lines[0]).toMatchObject({ channelId, status: "open", unspent: true, charged: "100000", deposit: "150000" });

    const close = await runCli(["channel", "close", url, ...cliNode]);
    expect(close.code, close.stderr + JSON.stringify(close.lines)).toBe(0);
    const closeTxid = close.lines.at(-1)!.transaction as string;
    await d.syncMempools();
    const [hash] = await d.mine(1, d.stock);
    expect(await blockTxs(hash as string)).toContain(closeTxid);
    await waitFor(async () => (await receivedBy(payTo)) - before === 100n * PRICE.channel, { timeoutMs: 20_000, what: "the close's payment" });

    const after = await runCli(["channel", "status", channelId, ...cliNode]);
    expect(after.lines[0]).toMatchObject({ status: "closed", unspent: false, closeTxid });
    const fundingTxid = channelId.split(":")[0]!;
    record(d.line, "HTTP channel session", { requests: 100, sessionMs, msPerRequest: Math.round(sessionMs / 100), channelId, fundingTxid, closeTxid, chainTxs: 2, received: (100n * PRICE.channel).toString() });
  });

  it("a shielded P1 payment (z→z) with the merchant's signed receipt", async () => {
    const [r] = await agent(`${shop.url}/shielded/report`, { AGENT_DEVNET_NODE: "2", AGENT_SIGNER: "node", AGENT_SHIELDED_FROM: zFrom });
    expect(r).toMatchObject({ status: 200, body: { paidWith: "exact/sapling-proof" }, settlement: { success: true, extra: { status: "mempool", confirmations: -1, receivedZat: PRICE.shielded.toString() } } });
    const txid = r!.settlement!.transaction;
    const receipt = (r!.settlement!.extensions as { "offer-receipt": { info: { receipt: Parameters<typeof verifyReceipt>[0] } } })["offer-receipt"].info.receipt;
    expect(verifyReceipt(receipt, { trustedPublicKeys: [receiptPub] })).toMatchObject({ network: NETWORK, resourceUrl: `${shop.url}/shielded/report`, payer: "anonymous", transaction: txid });
    const shape = await d.wallet.call<DecodedTransaction>("getrawtransaction", [txid, 1]);
    expect(shape.vin).toHaveLength(0); // P1: nothing transparent, the value moves inside the pool
    expect(shape.vout).toHaveLength(0);
    record(d.line, "HTTP shielded P1", { ms: r!.ms, txid, receiptVerified: true });
    await d.mine(1, d.stock);
  });

  it("OP-6: a facilitator on the stock node (no -yellowback) settles YEC over HTTP, policy −1 and 1", async () => {
    const fac2 = await startService("facilitator", {
      X402_NETWORK: NETWORK,
      X402_DEVNET_JSON: devnetJson,
      X402_DEVNET_NODE: "1",
      X402_PORT: "0",
      X402_SETTLEMENT_STORE: join(dir, "settlements-stock.json"),
      X402_CHANNEL_STORE: join(dir, "fac-channels-stock.json"),
      X402_CONFIRMATIONS_MIN: "-1",
    });
    procs.push(fac2);
    const health = (await (await fetch(`${fac2.url}/healthz`)).json()) as { node: { yellowback: boolean; line: string } };
    expect(health.node.yellowback).toBe(false);
    const payTo2 = await d.stock.getNewAddress();
    const shop2 = await startService("merchant", { X402_NETWORK: NETWORK, PORT: "0", FACILITATOR_URL: fac2.url, MERCHANT_PAY_TO: payTo2 });
    procs.push(shop2);
    try {
      const [fast] = await agent(`${shop2.url}/exact/ticker`, { AGENT_DEVNET_NODE: "0", AGENT_WIF: wif });
      expect(fast).toMatchObject({ status: 200, settlement: { success: true, extra: { status: "mempool" } } });
      let mined: string | undefined;
      const [slow] = await agent(`${shop2.url}/exact/quote`, { AGENT_DEVNET_NODE: "0", AGENT_WIF: wif }, async (p) => {
        mined = await mineWhenSeen(p, 2); // the ticker payment is still in the mempool
      });
      expect(slow).toMatchObject({ status: 200, settlement: { success: true, extra: { status: "confirmed", confirmations: 1 } } });
      const txs = await blockTxs(mined as string);
      expect(txs).toContain(fast!.settlement!.transaction);
      expect(txs).toContain(slow!.settlement!.transaction);
      await waitFor(async () => (await receivedBy(payTo2)) === PRICE.exact + PRICE.ticker, { timeoutMs: 20_000, what: "both payments at payTo" });
      record(d.line, "HTTP OP-6 stock facilitator", { line: health.node.line, fastMs: fast!.ms, slowMs: slow!.ms });
    } finally {
      await shop2.stop();
      await fac2.stop();
    }
  });
});
