// YED over HTTP on a live devnet of either line (plan X3 acceptance through the examples): the
// facilitator service on node 0 (a Yellowback node, so /supported lists YED), the merchant with its
// YED routes, the agent and the `x402-ycash` CLI, all as processes. Every YED transaction is mined
// by node 2, a Yellowback pool under its default `strict` template policy (OP-2), and Yellowback's
// supply is the same at the end as at the start (no case here burns).
//
//   scripts/devnet.sh up dd 231 && X402_DEVNET_JSON=…/dd-231/devnet.json npm run test:devnet:http
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tx } from "x402-ycash-mechanism";
import { DEVNET_JSON, describeDevnet, devnet, record, waitFor, type Devnet } from "../../../../packages/ycash/test/devnet/harness.js";
import { runAgent, runCli, startCli, startService, type Proc } from "./procs.js";

const NETWORK = "ycash:regtest";
const MIN_LOCK = 30;
const MARGIN = 5;

interface PaidLine {
  i: number;
  status: number;
  settlement?: { success: boolean; transaction: string; payer?: string; extra?: Record<string, unknown> };
  paymentError?: string;
  body: unknown;
}

interface ChannelState {
  channelId: string;
  chargedCumulative: string;
  signedCumulative: string;
}

describeDevnet("YED over HTTP: exact at ≥ $1 and YED channels through the merchant, the agent and the CLI", () => {
  let d: Devnet;
  let dir: string;
  let fac: Proc & { url: string };
  let shop: Proc & { url: string };
  const procs: Proc[] = [];
  let wif: string;
  let wifYed: string;
  let merchantYed: string; // a fresh key's ye… address: everything it holds came from this suite
  let supplyAtStart: number;
  const devnetJson = DEVNET_JSON as string;

  /** Yellowback's circulating supply, cents (yed_getstats). */
  async function supply(): Promise<number> {
    await d.syncBlocks();
    return (await d.wallet.call<{ supplyCents: number }>("yed_getstats")).supplyCents;
  }

  /** The YED token records paying `address`, from node 0's index. */
  /** Nothing ever sits at the channel key C: its key hash holds no token record. */
  async function nothingAtC(storePath: string, channelId: string): Promise<{ returnAddress: string }> {
    const rec = (JSON.parse(readFileSync(storePath, "utf8")) as { channels: Record<string, { returnAddress: string; clientPrivKey: string }> }).channels[channelId]!;
    expect(rec.returnAddress).toBeDefined();
    expect(await tokensOf(tx.encodeAddress(NETWORK, "yed", tx.hash160(tx.pubkeyFromPriv(tx.hexToBytes(rec.clientPrivKey)))))).toEqual([]);
    return rec;
  }

  async function tokensOf(address: string): Promise<{ txid: string; vout: number; cents: number }[]> {
    await d.syncBlocks();
    return d.wallet.call("yed_listtokens", [[address]]);
  }

  /** Node 0's confirmed YED, minting more when short (mint after pool blocks: X-F42). */
  async function ensureYed(cents: number): Promise<void> {
    const balance = async () => (await d.wallet.call<{ confirmedCents: number }>("yed_getbalance")).confirmedCents;
    if ((await balance()) >= cents) return;
    await waitFor(async () => {
      try {
        await d.wallet.call("yed_mint", [cents, 48, "", "", false]);
        return true;
      } catch (e) {
        if (!/price|participation/i.test((e as Error).message)) throw e;
        await d.mine(4, d.pool);
        return false;
      }
    }, { timeoutMs: 180_000, pollMs: 100, what: "a mint price" });
    await waitFor(async () => (await d.mine(1), (await balance()) >= cents), { timeoutMs: 180_000, pollMs: 500, what: "the MINT" });
  }

  async function yedSend(to: string, cents: number): Promise<string> {
    let txid = "";
    await waitFor(async () => {
      try {
        txid = await d.wallet.call<string>("yed_send", [to, cents]);
        return true;
      } catch {
        await d.mine(1);
        return false;
      }
    }, { timeoutMs: 60_000, what: "yed_send" });
    return txid;
  }

  /** Mines one block on the strict pool (node 2) and checks it carries `txid` (OP-2). */
  async function mineOnPool(txid: string): Promise<string> {
    await waitFor(async () => (await d.pool.getRawMempool()).includes(txid), { timeoutMs: 60_000, what: `${txid} at the pool` });
    const [hash] = await d.mine(1, d.pool);
    expect((await d.pool.call<{ tx: string[] }>("getblock", [hash])).tx).toContain(txid);
    return hash as string;
  }

  /** While a process runs: mines one pool block once `n` transactions reach the pool's mempool. Returns their txids. */
  async function minePoolWhenSeen(p: Proc, n = 1): Promise<string[]> {
    let done = false;
    void p.exited.then(() => (done = true));
    let seen: string[] = [];
    await waitFor(async () => done || (seen = await d.pool.getRawMempool()).length >= n, { timeoutMs: 120_000, what: "a transaction at the pool" });
    if (done) return [];
    await d.mine(1, d.pool);
    return seen;
  }

  async function agent(url: string, extra: Record<string, string>, whileRunning?: (p: Proc) => Promise<void>): Promise<{ code: number; lines: PaidLine[]; proc: Proc }> {
    const p = runAgent({ X402_NETWORK: NETWORK, RESOURCE_URL: url, AGENT_DEVNET_JSON: devnetJson, AGENT_RESERVATIONS: join(dir, `reservations-${procs.length}.json`), ...extra });
    procs.push(p);
    if (whileRunning) await whileRunning(p);
    const code = await p.exited;
    return { code, lines: p.lines.filter((l) => typeof l.i === "number") as unknown as PaidLine[], proc: p };
  }

  const cliNode = (store: string) => ["--devnet", devnetJson, "--node", "0", "--channels", store, "--reservations", join(dir, "cli-reservations.json")];

  beforeAll(async () => {
    d = await devnet();
    expect(d.caps.yellowback).toBe(true);
    dir = mkdtempSync(join(tmpdir(), "x402-yed-http-"));
    await ensureYed(20_000); // a MINT is $100 to $10,000 (bad-mint-amount below)

    // The local-key payer: node 0 watches its address; it holds YEC for fees and $5.00 of YED.
    const priv = tx.randomPrivKey();
    wif = tx.encodeWif(priv, NETWORK);
    const hash = tx.hash160(tx.pubkeyFromPriv(priv));
    wifYed = tx.encodeAddress(NETWORK, "yed", hash);
    await d.wallet.call("importaddress", [tx.encodeAddress(NETWORK, "p2pkh", hash), "", false]);
    for (let i = 0; i < 2; i++) await d.fund(tx.encodeAddress(NETWORK, "p2pkh", hash), 10_000_000n);
    await yedSend(wifYed, 500);
    await d.mine(1);
    merchantYed = tx.encodeAddress(NETWORK, "yed", tx.hash160(tx.pubkeyFromPriv(tx.randomPrivKey())));
    supplyAtStart = await supply();

    fac = await startService("facilitator", {
      X402_NETWORK: NETWORK,
      X402_DEVNET_JSON: devnetJson,
      X402_DEVNET_NODE: "0",
      X402_PORT: "0",
      X402_SETTLEMENT_STORE: join(dir, "settlements.json"),
      X402_CHANNEL_STORE: join(dir, "fac-channels.json"),
    });
    procs.push(fac);
    shop = await startService("merchant", {
      X402_NETWORK: NETWORK,
      PORT: "0",
      FACILITATOR_URL: fac.url,
      MERCHANT_PAY_TO: await d.stock.getNewAddress(),
      MERCHANT_DEVNET_JSON: devnetJson,
      MERCHANT_DEVNET_NODE: "0",
      MERCHANT_CHANNEL_KEY: tx.bytesToHex(tx.randomPrivKey()),
      MERCHANT_CHANNEL_STORE: join(dir, "merchant-channels.json"),
      MERCHANT_MIN_LOCK_BLOCKS: String(MIN_LOCK),
      MERCHANT_CLOSE_MARGIN_BLOCKS: String(MARGIN),
      MERCHANT_WATCHER_POLL_MS: "2000",
      MERCHANT_YED_PAY_TO: merchantYed,
      PRICE_YED_REPORT: "$2",
      PRICE_YED_STREAM: "$0.01",
      MERCHANT_MAX_DEPOSIT_CENTS: "1000",
    });
    procs.push(shop);
    const started = shop.lines.find((l) => l.msg === "merchant listening") as { modes: Record<string, boolean> };
    expect(started.modes).toMatchObject({ yedExact: true, yedChannel: true });
    const policy = (await d.pool.call<{ templatePolicy: string }>("yed_getinfo")).templatePolicy;
    expect(policy).toBe("strict");
    record(d.line, "HTTP YED stack", { facilitator: fac.url, merchant: shop.url, merchantYed, poolTemplatePolicy: policy, supplyAtStart });
  });

  afterAll(async () => {
    await Promise.all(procs.map((p) => p.stop()));
  });

  it("the merchant's 402s: /yed/report asks 200 YED cents (exact), /yed/stream 1 cent on a YED channel with maxDeposit $10.00", async () => {
    const decode = async (path: string) => {
      const res = await fetch(`${shop.url}${path}`);
      expect(res.status).toBe(402);
      return (JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") as string, "base64").toString("utf8")) as { accepts: Record<string, unknown>[] }).accepts;
    };
    expect(await decode("/yed/report")).toEqual([expect.objectContaining({ scheme: "exact", asset: "YED", amount: "200", payTo: merchantYed })]);
    expect(await decode("/yed/stream")).toEqual([expect.objectContaining({ scheme: "batch-settlement", asset: "YED", amount: "1", payTo: merchantYed, extra: expect.objectContaining({ maxDeposit: "1000" }) })]);
  });

  it("YED exact $2 over HTTP: refused at the default $1.00 cap; paid from a WIF key's YED and from node 0's wallet, mined by the strict pool", async () => {
    const before = await supply();
    const capped = await agent(`${shop.url}/yed/report`, { AGENT_WIF: wif });
    expect(capped.code).not.toBe(0);
    expect(capped.proc.stderr.join("")).toMatch(/maxAmountPerPayment/);

    const results: Record<string, unknown> = {};
    for (const [who, extra] of [["wif", { AGENT_WIF: wif }], ["node", { AGENT_SIGNER: "node", AGENT_DEVNET_NODE: "0" }]] as const) {
      let mined: string[] = [];
      const r = await agent(`${shop.url}/yed/report`, { ...extra, MAX_PAYMENT_YED_CENTS: "200" }, async (p) => {
        mined = await minePoolWhenSeen(p);
      });
      expect(r.code, r.proc.stderr.join("")).toBe(0);
      const [line] = r.lines;
      expect(line).toMatchObject({ status: 200, body: { paidWith: "exact/transparent YED" }, settlement: { success: true, extra: { status: "confirmed", confirmations: 1 } } });
      expect(mined).toContain(line!.settlement!.transaction);
      if (who === "wif") expect(line!.settlement!.payer).toBe(wifYed);
      results[who] = { txid: line!.settlement!.transaction, payer: line!.settlement!.payer };
    }
    expect((await tokensOf(merchantYed)).map((t) => t.cents)).toEqual([200, 200]);
    expect((await tokensOf(wifYed)).reduce((s, t) => s + t.cents, 0)).toBe(300); // $5.00 − $2.00, as YED change
    expect(await supply()).toBe(before);
    record(d.line, "HTTP YED exact $2", results);
  });

  it("a YED channel: 150 one-cent requests (the first voucher pre-pays $1.00), the CLI's close; the merchant receives exactly 150 cents; the close mined by the strict pool", async () => {
    const before = await supply();
    const store = join(dir, "agent-channels.json");
    const url = `${shop.url}/yed/stream?n=1`;
    const received = (await tokensOf(merchantYed)).reduce((s, t) => s + t.cents, 0);
    const t0 = Date.now();
    const r = await agent(url, { AGENT_SIGNER: "node", AGENT_DEVNET_NODE: "0", REQUESTS: "150", AGENT_CHANNEL_STORE: store, AGENT_YED_CHANNEL_DEPOSIT_CENTS: "500" }, async (p) => {
      await minePoolWhenSeen(p); // the open waits for the funding in a block (X-F14)
    });
    const sessionMs = Date.now() - t0;
    expect(r.code, r.proc.stderr.join("")).toBe(0);
    expect(r.lines).toHaveLength(150);
    expect(r.lines.every((l) => l.status === 200 && l.settlement?.success)).toBe(true);
    const first = r.lines[0]!.settlement!.extra!.channelState as ChannelState;
    expect(first).toMatchObject({ chargedCumulative: "1", signedCumulative: "100" });
    const last = r.lines.at(-1)!.settlement!.extra!.channelState as ChannelState;
    expect(last).toMatchObject({ chargedCumulative: "150", signedCumulative: "150" });
    const channelId = last.channelId;
    const funding = await d.wallet.yedDecodePayload(await d.wallet.call<string>("getrawtransaction", [channelId.split(":")[0]]));
    expect(funding.assignments).toContainEqual({ vout: 0, cents: 500 });

    const status = await runCli(["channel", "status", channelId, ...cliNode(store)]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.lines[0]).toMatchObject({ channelId, asset: "YED", status: "open", unspent: true, charged: "150", deposit: "500" });

    const close = await runCli(["channel", "close", url, "--asset", "YED", ...cliNode(store)]);
    expect(close.code, close.stderr + JSON.stringify(close.lines)).toBe(0);
    const closed = close.lines.at(-1) as { transaction: string; cumulative: string; charged: string };
    expect(closed).toMatchObject({ asset: "YED", charged: "150", cumulative: "150" }); // above $1.00: exactly the charged total
    // checked while in the mempool: once mined its input is spent and yedIn reads 0
    const closeHex = await d.wallet.call<string>("getrawtransaction", [closed.transaction]);
    expect(await d.wallet.yedValidateRawTransaction(closeHex)).toMatchObject({ verdict: "ok", yedIn: 500, yedOut: 500, burned: 0 });
    await mineOnPool(closed.transaction);
    expect((await d.wallet.yedDecodePayload(closeHex)).assignments).toEqual([{ vout: 0, cents: 150 }, { vout: 1, cents: 350 }]);
    expect((await tokensOf(merchantYed)).reduce((s, t) => s + t.cents, 0) - received).toBe(150);
    // the client's $3.50 came home to node 0's YED wallet (the open's returnAddress), not to C
    const home = await nothingAtC(store, channelId);
    expect(await tokensOf(home.returnAddress)).toMatchObject([{ txid: closed.transaction, vout: 1, cents: 350 }]);
    await waitFor(async () => (await d.wallet.call<{ txid: string; vout: number; cents: number }[]>("yed_listunspent")).some((u) => u.txid === closed.transaction && u.vout === 1 && u.cents === 350), { timeoutMs: 20_000, what: "node 0's YED wallet to list the remainder" });
    record(d.line, "HTTP YED remainder home", { channelId, returnAddress: home.returnAddress, closeTxid: closed.transaction, cents: 350, wallet: "node 0 (yed_listunspent)" });
    const after = await runCli(["channel", "status", channelId, ...cliNode(store)]);
    expect(after.lines[0]).toMatchObject({ status: "closed", unspent: false, closeTxid: closed.transaction });
    expect(await supply()).toBe(before);
    record(d.line, "HTTP YED channel", { requests: 150, sessionMs, msPerRequest: Math.round(sessionMs / 150), channelId, firstVoucher: first.signedCumulative, closeTxid: closed.transaction, serverReceived: 150, clientRemainder: 350 });
  });

  it("a YED channel funded from a WIF key's YED: 5 requests, then the CLI's close at the dollar floor (5 cents charged, $1.00 paid)", async () => {
    const before = await supply();
    const store = join(dir, "wif-channels.json");
    const url = `${shop.url}/yed/stream?n=wif`;
    const received = (await tokensOf(merchantYed)).reduce((s, t) => s + t.cents, 0);
    const r = await agent(url, { AGENT_WIF: wif, REQUESTS: "5", AGENT_CHANNEL_STORE: store, AGENT_YED_CHANNEL_DEPOSIT_CENTS: "300" }, async (p) => {
      await minePoolWhenSeen(p);
    });
    expect(r.code, r.proc.stderr.join("")).toBe(0);
    expect(r.lines.every((l) => l.status === 200 && l.settlement?.success)).toBe(true);
    const last = r.lines.at(-1)!.settlement!.extra!.channelState as ChannelState;
    expect(last).toMatchObject({ chargedCumulative: "5", signedCumulative: "100" });
    // the funding spent the key's own token output ($3.00 left after the exact case): no YED change
    const funding = await d.wallet.yedDecodePayload(await d.wallet.call<string>("getrawtransaction", [last.channelId.split(":")[0]]));
    expect(funding.assignments).toEqual([{ vout: 0, cents: 300 }]);
    expect(await tokensOf(wifYed)).toEqual([]);
    const close = await runCli(["channel", "close", url, "--asset", "YED", ...cliNode(store)]);
    expect(close.code, close.stderr + JSON.stringify(close.lines)).toBe(0);
    const closed = close.lines.at(-1) as { transaction: string };
    expect(closed).toMatchObject({ charged: "5", cumulative: "100" });
    await mineOnPool(closed.transaction);
    expect((await d.wallet.yedDecodePayload(await d.wallet.call<string>("getrawtransaction", [closed.transaction]))).assignments).toEqual([{ vout: 0, cents: 100 }, { vout: 1, cents: 200 }]);
    expect((await tokensOf(merchantYed)).reduce((s, t) => s + t.cents, 0) - received).toBe(100);
    // the client's $2.00 came home to the WIF key's own ye… address, not to C
    const home = await nothingAtC(store, last.channelId);
    expect(home.returnAddress).toBe(wifYed);
    expect(await tokensOf(wifYed)).toMatchObject([{ txid: closed.transaction, vout: 1, cents: 200 }]);
    expect(await supply()).toBe(before);
    record(d.line, "HTTP YED WIF channel", { channelId: last.channelId, charged: 5, serverReceived: 100, clientRemainder: 200, closeTxid: closed.transaction });
  });

  it("the CLI opens a YED channel (--asset YED --deposit 300), the merchant goes away, and the CLI refunds after t with a TRANSFER of all of D to node 0's wallet", async () => {
    const before = await supply();
    const store = join(dir, "cli-channels.json");
    const url = `${shop.url}/yed/stream?n=cli`;
    const open = startCli(["channel", "open", url, "--asset", "YED", "--deposit", "300", ...cliNode(store)]);
    procs.push(open);
    await minePoolWhenSeen(open);
    expect(await open.exited, open.stderr.join("")).toBe(0);
    const ch = open.lines.find((l) => l.msg === "channel") as { channelId: string; status: string; charged: string; signed: string; deposit: string; refundHeight: number };
    expect(ch).toMatchObject({ status: "open", charged: "1", signed: "100", deposit: "300" });
    const more = await runCli(["pay", url, "--count", "3", "--asset", "YED", ...cliNode(store)]);
    expect(more.code, more.stderr).toBe(0);

    // The merchant disappears holding a $1.00 voucher it never broadcasts: the client's way out is t.
    await shop.stop();
    const early = await runCli(["channel", "refund", ch.channelId, ...cliNode(store)]);
    expect(early.code).toBe(1);
    expect(early.stderr).toMatch(/valid from height/);
    while ((await d.tip()) < ch.refundHeight) await d.mine(Math.min(8, ch.refundHeight - (await d.tip())), d.pool);

    const refund = await runCli(["channel", "refund", ch.channelId, ...cliNode(store)]);
    expect(refund.code, refund.stderr).toBe(0);
    const out = refund.lines.at(-1) as { transaction: string; to: string; transfer: { type: string; assignments: { vout: number; cents: number }[] } };
    expect(out).toMatchObject({ msg: "refunded", asset: "YED", transfer: { type: "transfer", assignments: [{ vout: 1, cents: 300 }] } });
    const hex = await d.wallet.call<string>("getrawtransaction", [out.transaction]);
    expect(await d.wallet.yedValidateRawTransaction(hex)).toMatchObject({ verdict: "ok", type: "transfer", yedIn: 300, yedOut: 300, burned: 0 });
    await mineOnPool(out.transaction);
    expect(await tokensOf(out.to)).toMatchObject([{ txid: out.transaction, vout: 1, cents: 300 }]);
    // the default destination is node 0's own YED wallet, which now holds the refund
    const walletYed = await d.wallet.call<{ txid: string; vout: number }[]>("yed_listunspent");
    expect(walletYed).toContainEqual(expect.objectContaining({ txid: out.transaction, vout: 1 }));
    expect((await nothingAtC(store, ch.channelId)).returnAddress).toBe(out.to); // the open's returnAddress
    const status = await runCli(["channel", "status", ch.channelId, ...cliNode(store)]);
    expect(status.lines[0]).toMatchObject({ asset: "YED", status: "refunded", unspent: false, refundTxid: out.transaction });
    expect(await supply()).toBe(before);
    record(d.line, "HTTP YED CLI refund", { channelId: ch.channelId, refundHeight: ch.refundHeight, txid: out.transaction, to: out.to, inNodeWallet: true });
  });

  it("Yellowback supply is unchanged across the whole suite", async () => {
    expect(await supply()).toBe(supplyAtStart);
    record(d.line, "HTTP YED supply", { start: supplyAtStart, end: await supply() });
  });
});
