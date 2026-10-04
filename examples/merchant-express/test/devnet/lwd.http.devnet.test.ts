// The light agent on a live devnet of either line (plan X5): an agent and the CLI with only a WIF
// key and a lightwalletd URL, no node RPC, pay the merchant over HTTP: YEC exact, YED exact, a YEC
// channel of 20 requests closed by the CLI, and a CLI refund after t broadcast through
// SendTransaction. The same flows on the node-RPC path give the latency to compare against. The
// facilitator and the merchant run on node 0 as usual; lightwalletd serves node 0 too.
//
//   scripts/devnet.sh up dd 271
//   yellowback-devnet lightwalletd start --port 34271 --bin <lightwalletd> --extra=--yellowback   (YELLOWBACK_DEVNET_DIR=…/dd-271)
//   X402_DEVNET_JSON=…/dd-271/devnet.json X402_LWD_URL=127.0.0.1:34271 npm run test:devnet -w x402-ycash-example-merchant-express -- lwd
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { exact, LwdClient, LwdUtxoSource, SendRawTransactionError, tx } from "x402-ycash-mechanism";
import { DEVNET_JSON, describeDevnet as describeWithDevnet, devnet, record, waitFor, type Devnet } from "../../../../packages/ycash/test/devnet/harness.js";
import { runAgent, runCli, startCli, startService, type Proc } from "./procs.js";

const NETWORK = "ycash:regtest";
const LWD_URL = process.env.X402_LWD_URL;
const describeDevnet = (LWD_URL ? describeWithDevnet : describeWithDevnet.skip) as typeof describeWithDevnet;
const PRICE = { ticker: 10_000n, channel: 1_000n };
const MIN_LOCK = 30;

interface PaidLine {
  i: number;
  status: number;
  ms: number;
  settlement?: { success: boolean; transaction: string; payer?: string; extra?: Record<string, unknown> };
  body: unknown;
}

interface Payer {
  wif: string;
  address: string;
  yed: string;
}

function newPayer(): Payer {
  const priv = tx.randomPrivKey();
  const hash = tx.hash160(tx.pubkeyFromPriv(priv));
  return { wif: tx.encodeWif(priv, NETWORK), address: tx.encodeAddress(NETWORK, "p2pkh", hash), yed: tx.encodeAddress(NETWORK, "yed", hash) };
}

const mean = (xs: number[]): number => Math.round(xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length));
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

describeDevnet("the light agent: a WIF key and lightwalletd, no node RPC", () => {
  let d: Devnet;
  let dir: string;
  let lwd: LwdClient;
  let fac: Proc & { url: string };
  let shop: Proc & { url: string };
  const procs: Proc[] = [];
  let payTo: string;
  let merchantYed: string;
  const light = newPayer(); // lightwalletd only
  const heavy = newPayer(); // the node-RPC path, for the latency comparison
  const devnetJson = DEVNET_JSON as string;
  const lwdUrl = LWD_URL as string;

  /** The agent with only the key and lightwalletd (`light`), or the key read through node 0 (`heavy`). */
  const agentEnv = (who: "light" | "heavy", url: string, extra: Record<string, string>): Record<string, string> => ({
    X402_NETWORK: NETWORK,
    RESOURCE_URL: url,
    MAX_PAYMENT_ZAT: "5000000",
    AGENT_RESERVATIONS: join(dir, `${who}-reservations.json`),
    ...(who === "light" ? { AGENT_WIF: light.wif, AGENT_LWD_URL: lwdUrl } : { AGENT_WIF: heavy.wif, AGENT_DEVNET_JSON: devnetJson, AGENT_DEVNET_NODE: "0" }),
    ...extra,
  });

  async function agent(who: "light" | "heavy", url: string, extra: Record<string, string>, whileRunning?: (p: Proc) => Promise<void>): Promise<PaidLine[]> {
    const p = runAgent(agentEnv(who, url, extra));
    procs.push(p);
    if (whileRunning) await whileRunning(p);
    const code = await p.exited;
    if (code !== 0) throw new Error(`agent (${who}) exited ${code}: ${p.stderr.join("")} ${JSON.stringify(p.lines.slice(-3))}`);
    const start = p.lines.find((l) => l.msg === "agent") as { chain: string } | undefined;
    expect(start?.chain).toMatch(who === "light" ? `lightwalletd ${lwdUrl}` : /^node /);
    return p.lines.filter((l) => typeof l.i === "number") as unknown as PaidLine[];
  }

  /** While a process runs: mines one block on `node` once `n` transactions reach its mempool. */
  async function mineWhenSeen(p: Proc, node = d.stock, n = 1): Promise<void> {
    let done = false;
    void p.exited.then(() => (done = true));
    await waitFor(async () => done || (await node.getRawMempool()).length >= n, { timeoutMs: 120_000, what: "a transaction in the mempool" });
    if (!done) await d.mine(1, node);
  }

  async function receivedBy(address: string): Promise<bigint> {
    return BigInt(Math.round((await d.stock.call<number>("getreceivedbyaddress", [address, 1])) * 1e8));
  }

  async function tokensOf(address: string): Promise<{ cents: number }[]> {
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

  async function yedSend(to: string, cents: number): Promise<void> {
    await waitFor(async () => {
      try {
        await d.wallet.call<string>("yed_send", [to, cents]);
        return true;
      } catch {
        await d.mine(1);
        return false;
      }
    }, { timeoutMs: 60_000, what: "yed_send" });
  }

  beforeAll(async () => {
    d = await devnet();
    expect(d.caps.yellowback).toBe(true);
    dir = mkdtempSync(join(tmpdir(), "x402-lwd-"));
    lwd = new LwdClient(lwdUrl);
    const info = await lwd.getLightdInfo();
    expect(info.chainName).toBe("regtest");
    payTo = await d.stock.getNewAddress();
    merchantYed = tx.encodeAddress(NETWORK, "yed", tx.hash160(tx.pubkeyFromPriv(tx.randomPrivKey())));
    await ensureYed(20_000); // a MINT is $100 to $10,000 (X-F61)

    // The heavy payer's address is watched by node 0 before it is funded (importaddress, no rescan);
    // the light payer's is not: nothing but lightwalletd ever looks at it.
    await d.wallet.call("importaddress", [heavy.address, "", false]);
    for (const p of [light, heavy]) {
      for (let i = 0; i < 6; i++) await d.fund(p.address, 5_000_000n);
      await yedSend(p.yed, 500);
    }
    await d.mine(1);

    fac = await startService("facilitator", {
      X402_NETWORK: NETWORK,
      X402_DEVNET_JSON: devnetJson,
      X402_DEVNET_NODE: "0",
      X402_PORT: "0",
      X402_SETTLEMENT_STORE: join(dir, "settlements.json"),
      X402_CHANNEL_STORE: join(dir, "fac-channels.json"),
      X402_CONFIRMATIONS_MIN: "-1",
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
      MERCHANT_MIN_LOCK_BLOCKS: String(MIN_LOCK),
      MERCHANT_CLOSE_MARGIN_BLOCKS: "5",
      MERCHANT_WATCHER_POLL_MS: "2000",
      MERCHANT_YED_PAY_TO: merchantYed,
      PRICE_YED_REPORT: "$2",
    });
    procs.push(shop);
    record(d.line, "LWD stack", { lwd: lwdUrl, lightwalletd: `${info.vendor} ${info.version}`, node: info.zcashdSubversion, height: info.blockHeight, branch: info.consensusBranchId, merchant: shop.url });
  });

  afterAll(async () => {
    await Promise.all(procs.map((p) => p.stop()));
    lwd?.close();
  });

  it("YEC exact (mempool policy): five payments from the light agent, then five from the node-RPC agent; latency compared", async () => {
    const before = await receivedBy(payTo);
    const lightLines = await agent("light", `${shop.url}/exact/ticker`, { REQUESTS: "5" });
    expect(lightLines.every((l) => l.status === 200 && l.settlement?.success)).toBe(true);
    expect(lightLines[0]!.settlement!.payer).toBe(light.address);
    const heavyLines = await agent("heavy", `${shop.url}/exact/ticker`, { REQUESTS: "5" });
    expect(heavyLines.every((l) => l.status === 200 && l.settlement?.success)).toBe(true);
    // Five payments from one key with no block between them: each spent a different coin.
    const inputs = await Promise.all(lightLines.map(async (l) => tx.parseTx(await d.wallet.call<string>("getrawtransaction", [l.settlement!.transaction])).vin.map((i) => `${i.prevout.txid}:${i.prevout.vout}`)));
    expect(new Set(inputs.flat()).size).toBe(inputs.flat().length);
    await d.syncMempools();
    await d.mine(1, d.stock);
    await waitFor(async () => (await receivedBy(payTo)) - before === 10n * PRICE.ticker, { timeoutMs: 20_000, what: "ten ticker payments" });

    // The client-side reads alone, in process: lightwalletd vs node RPC.
    const lightSource = new LwdUtxoSource(lwd);
    const heavySource = new exact.RpcUtxoSource(d.wallet);
    const time = async (f: () => Promise<unknown>): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        await f();
        out.push(performance.now() - t0);
      }
      return out.map((x) => Math.round(x * 10) / 10);
    };
    const reads = {
      lwdChainStateMs: median(await time(() => lightSource.chainState())),
      rpcChainStateMs: median(await time(() => heavySource.chainState())),
      lwdListCoinsMs: median(await time(() => lightSource.listCoins(light.address))),
      rpcListCoinsMs: median(await time(() => heavySource.listCoins(heavy.address))),
    };
    record(d.line, "LWD latency YEC exact", { lightMs: lightLines.map((l) => l.ms), heavyMs: heavyLines.map((l) => l.ms), lightMean: mean(lightLines.map((l) => l.ms)), heavyMean: mean(heavyLines.map((l) => l.ms)), ...reads });
  });

  it("YED exact $2: the light agent pays from its key's YED (GetAddressTokens), mined by the strict pool; the node path for comparison", async () => {
    const results: Record<string, unknown> = {};
    for (const who of ["light", "heavy"] as const) {
      const lines = await agent(who, `${shop.url}/yed/report`, { MAX_PAYMENT_YED_CENTS: "200" }, async (p) => mineWhenSeen(p, d.pool));
      expect(lines[0]).toMatchObject({ status: 200, body: { paidWith: "exact/transparent YED" }, settlement: { success: true } });
      results[who] = { ms: lines[0]!.ms, txid: lines[0]!.settlement!.transaction, payer: lines[0]!.settlement!.payer };
    }
    expect((results.light as { payer: string }).payer).toBe(light.yed);
    await d.syncMempools();
    await d.mine(1, d.pool);
    expect((await tokensOf(merchantYed)).map((t) => t.cents)).toEqual([200, 200]);
    expect((await tokensOf(light.yed)).reduce((s, t) => s + t.cents, 0)).toBe(300); // $5.00 − $2.00 as YED change, nothing burned
    record(d.line, "LWD latency YED exact", results);
  });

  it("a YEC channel from the light agent: open (funding mined by the stock node), 20 requests, the CLI's close over --lwd; node path for comparison", async () => {
    const out: Record<string, unknown> = {};
    for (const who of ["light", "heavy"] as const) {
      const store = join(dir, `${who}-channels.json`);
      const url = `${shop.url}/channel/search?q=${who}`;
      const before = await receivedBy(payTo);
      const t0 = Date.now();
      const lines = await agent(who, url, { REQUESTS: "20", AGENT_CHANNEL_STORE: store, AGENT_CHANNEL_DEPOSIT_ZAT: "150000" }, (p) => mineWhenSeen(p));
      const sessionMs = Date.now() - t0;
      expect(lines).toHaveLength(20);
      expect(lines.every((l) => l.status === 200 && l.settlement?.success)).toBe(true);
      const last = lines.at(-1)!.settlement!.extra as { channelState: { channelId: string; chargedCumulative: string } };
      expect(last.channelState.chargedCumulative).toBe((20n * PRICE.channel).toString());
      const channelId = last.channelState.channelId;
      const payer = who === "light" ? light : heavy;
      const cli = who === "light" ? ["--lwd", lwdUrl, "--wif", payer.wif, "--channels", store] : ["--devnet", devnetJson, "--node", "0", "--wif", payer.wif, "--channels", store];
      const status = await runCli(["channel", "status", channelId, ...cli]);
      expect(status.code, status.stderr).toBe(0);
      expect(status.lines[0]).toMatchObject({ channelId, status: "open", unspent: true, charged: "20000", deposit: "150000" });
      const t1 = Date.now();
      const close = await runCli(["channel", "close", url, ...cli]);
      const closeMs = Date.now() - t1;
      expect(close.code, close.stderr + JSON.stringify(close.lines)).toBe(0);
      const closeTxid = close.lines.at(-1)!.transaction as string;
      await d.syncMempools();
      const [hash] = await d.mine(1, d.stock);
      expect((await d.stock.call<{ tx: string[] }>("getblock", [hash])).tx).toContain(closeTxid);
      await waitFor(async () => (await receivedBy(payTo)) - before === 20n * PRICE.channel, { timeoutMs: 20_000, what: "the close's payment" });
      // The remainder comes home to the key's own address (its returnAddress), nothing at C.
      const closeTx = tx.parseTx(await d.wallet.call<string>("getrawtransaction", [closeTxid]));
      expect(closeTx.vout.filter((o) => tx.equalBytes(o.scriptPubKey, tx.addressToScript(payer.address, NETWORK))).reduce((s, o) => s + o.value, 0n)).toBe(150_000n - 20n * PRICE.channel);
      if (who === "light") {
        const after = await runCli(["channel", "status", channelId, ...cli]);
        expect(after.lines[0]).toMatchObject({ status: "closed", unspent: false, closeTxid });
        expect((await lwd.getAddressUtxos([payer.address])).some((u) => u.txid === closeTxid)).toBe(true);
      }
      out[who] = { sessionMs, msPerRequest: Math.round(sessionMs / 20), medianRequestMs: median(lines.slice(1).map((l) => l.ms)), openMs: lines[0]!.ms, closeCliMs: closeMs, channelId, closeTxid };
    }
    record(d.line, "LWD latency YEC channel", out);
  });

  it("findings: SendTransaction and its refusals, GetTransaction of a mempool tx, GetMempoolTx (transparent vs Sapling)", async () => {
    // A plain transparent payment from the light key, broadcast through lightwalletd.
    const source = new LwdUtxoSource(lwd);
    const signer = new exact.LocalKeySigner(light.wif, source);
    const state = await signer.chainState();
    const signed = await signer.signPayment({ network: NETWORK, payTo, amount: 20_000n, expiryHeight: state.height + 40, tip: state.height, branchId: state.branchId });
    const t0 = performance.now();
    const txid = await lwd.sendTransaction(signed.hex);
    const sendMs = Math.round(performance.now() - t0);
    expect(txid).toBe(signed.txid);
    // Re-sending a transaction already in the mempool: a refusal or the txid again, as the line does it.
    const again = await lwd.sendTransaction(signed.hex).catch((e: unknown) => e);
    const pending = await lwd.getTransaction(txid);
    expect(pending?.hex).toBe(signed.hex);
    await waitFor(async () => (await d.wallet.getRawMempool()).includes(txid), { what: "the tx in node 0's mempool" });
    await new Promise((r) => setTimeout(r, 2_500)); // GetMempoolTx refreshes its copy at most every 2 s
    const transparentInMempoolList = (await lwd.getMempoolTxids()).includes(txid);
    // Still listed by GetAddressUtxos while its spend sits in the mempool: the documented gap.
    const spentCoinStillListed = (await lwd.getAddressUtxos([light.address])).some((u) => signed.inputs.some((i) => i.txid === u.txid && i.vout === u.vout));
    // A Sapling transaction does appear.
    const z = await d.wallet.zGetNewAddress();
    const zFrom = await d.wallet.getNewAddress();
    await d.fund(zFrom, 100_000_000n);
    await d.mine(1);
    const opts = d.line === "v6" ? { minconf: 1, privacyPolicy: "AllowFullyTransparent" as const } : { minconf: 1 };
    const ztxid = await d.wallet.zSendManyAndWait(zFrom, [{ address: z, amount: 10_000_000n }], opts);
    await new Promise((r) => setTimeout(r, 2_500));
    const saplingInMempoolList = (await lwd.getMempoolTxids()).includes(ztxid);
    await d.syncMempools();
    await d.mine(1, d.stock);
    const mined = await lwd.getTransaction(txid);
    const rebroadcast = await lwd.sendTransaction(signed.hex).catch((e: unknown) => e);
    expect(rebroadcast).toBeInstanceOf(SendRawTransactionError);
    expect((rebroadcast as SendRawTransactionError).kind).toBe("already-in-chain");
    const outcome = (r: unknown) => (r instanceof SendRawTransactionError ? { code: r.code, message: r.message, kind: r.kind } : { txid: r });
    record(d.line, "LWD SendTransaction + mempool", {
      sendMs,
      duplicateInMempool: outcome(again),
      afterMined: outcome(rebroadcast),
      getTransactionMempoolHeight: pending?.height ?? "none",
      getTransactionMinedHeight: mined?.height,
      transparentInMempoolList,
      saplingInMempoolList,
      spentCoinStillListed,
    });
    expect(saplingInMempoolList).toBe(true);
  });

  it("the CLI over --lwd: channel open (funding mined by the stock node), the merchant goes away, refund after t through SendTransaction", async () => {
    const store = join(dir, "cli-channels.json");
    const cli = ["--lwd", lwdUrl, "--wif", light.wif, "--channels", store, "--reservations", join(dir, "cli-reservations.json")];
    const url = `${shop.url}/channel/search?q=refund`;
    const open = startCli(["channel", "open", url, "--deposit", "30000", ...cli]);
    procs.push(open);
    await mineWhenSeen(open);
    expect(await open.exited, open.stderr.join("") + JSON.stringify(open.lines)).toBe(0);
    const ch = open.lines.find((l) => l.msg === "channel") as { channelId: string; status: string; refundHeight: number };
    expect(ch).toMatchObject({ status: "open" });
    await shop.stop(); // the merchant is gone: no close will come, the client waits for t
    const early = await runCli(["channel", "refund", ch.channelId, ...cli]);
    expect(early.code).toBe(1);
    expect(early.stderr).toMatch(new RegExp(`valid from height ${ch.refundHeight}`));
    while ((await d.tip()) < ch.refundHeight) await d.mine(Math.min(10, ch.refundHeight - (await d.tip())), d.stock);
    await waitFor(async () => (await lwd.getLatestBlock()) >= ch.refundHeight, { timeoutMs: 30_000, what: "lightwalletd at t" });
    const t0 = Date.now();
    const refund = await runCli(["channel", "refund", ch.channelId, ...cli]);
    const refundMs = Date.now() - t0;
    expect(refund.code, refund.stderr).toBe(0);
    const refundTxid = refund.lines.at(-1)!.transaction as string;
    await waitFor(async () => (await d.wallet.getRawMempool()).includes(refundTxid), { what: "the refund in node 0's mempool" });
    await d.syncMempools();
    await d.mine(1, d.stock);
    const refundTx = tx.parseTx(await d.wallet.call<string>("getrawtransaction", [refundTxid]));
    expect(refundTx.lockTime).toBe(ch.refundHeight);
    expect(tx.equalBytes(refundTx.vout[0]!.scriptPubKey, tx.addressToScript(light.address, NETWORK))).toBe(true);
    const status = await runCli(["channel", "status", ch.channelId, ...cli]);
    expect(status.lines[0]).toMatchObject({ status: "refunded", unspent: false, refundTxid });
    record(d.line, "LWD CLI refund", { channelId: ch.channelId, refundHeight: ch.refundHeight, refundTxid, refundCliMs: refundMs, refundZat: refundTx.vout[0]!.value.toString() });
  });
});
