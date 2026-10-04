// Acceptance (plan §7 X1, §4.3): `exact` transparent YEC through the real @x402/core
// x402Client / x402ResourceServer / x402Facilitator, against a live devnet of either line.
// The whole suite runs twice: facilitator on node 0 (Yellowback) and on node 1 (stock).
// Blocks that confirm payments are mined by node 1 (stock); one by the yolo stratum pool.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { beforeAll, expect, it } from "vitest";
import { exact } from "../../src/index.js";
import type { YcashRpc } from "../../src/node/index.js";
import { InMemorySettlementStore } from "../../src/store/index.js";
import {
  encodeAddress,
  encodeWif,
  hash160,
  newTx,
  p2pkhScript,
  p2pkhScriptSig,
  parseTx,
  pubkeyFromPriv,
  randomPrivKey,
  serializeTxHex,
  sighashV4,
  signInput,
  SEQUENCE_FINAL,
  SIGHASH,
  txid as txidOf,
  addressToScript,
  type TxOut,
} from "../../src/tx/index.js";
import { DEVNET_JSON, describeDevnet, devnet, record, waitFor, type Devnet } from "./harness.js";

const NETWORK = "ycash:regtest" as const;
const AMOUNT = 250_000n; // 0.0025 YEC
const here = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.YELLOWBACK_WORKSPACE ?? resolve(here, "../../../../../..");

interface Payer {
  priv: Uint8Array;
  script: Uint8Array;
  address: string;
  yr: string;
  signer: exact.LocalKeySigner;
  client: x402Client;
  scheme: exact.ExactYcashScheme;
}

interface Stack {
  name: string;
  node: YcashRpc;
  yellowback: boolean;
  server: x402ResourceServer;
  facilitator: x402Facilitator;
}

let d: Devnet;
let merchant: string;
let served = 0;

/** A fresh local key, watched (not spendable) by node 0 so its RpcUtxoSource lists its coins. */
function newPayer(): Payer {
  const priv = randomPrivKey();
  const pub = pubkeyFromPriv(priv);
  const source = new exact.RpcUtxoSource(d.wallet, { importAddress: true });
  const signer = new exact.LocalKeySigner(encodeWif(priv, NETWORK), source);
  const scheme = new exact.ExactYcashScheme(signer);
  const client = new x402Client().register(NETWORK, scheme);
  client.setSpendControls({ allowedAssets: [exact.yecSpendControl(NETWORK, 10_000_000n)] });
  return { priv, script: p2pkhScript(hash160(pub)), address: encodeAddress(NETWORK, "p2pkh", hash160(pub)), yr: encodeAddress(NETWORK, "yed", hash160(pub)), signer, client, scheme };
}

/** `n` confirmed coins of `zat` each for the payer, in one block. */
async function fundPayer(p: Payer, n: number, zat = 10_000_000n): Promise<void> {
  await d.wallet.call("importaddress", [p.address, "", false]);
  for (let i = 0; i < n; i++) await d.fund(p.address, zat);
  await d.mine(1);
}

async function makeStack(name: string, node: YcashRpc, timeoutMs = 20_000): Promise<Stack> {
  const scheme = new exact.ExactYcashFacilitatorScheme(node, { settlementStore: new InMemorySettlementStore(), confirmationTimeoutMs: timeoutMs, confirmationPollMs: 250 });
  const facilitator = new x402Facilitator().register(NETWORK, scheme);
  const client = {
    verify: (p: PaymentPayload, r: PaymentRequirements) => facilitator.verify(p, r),
    settle: (p: PaymentPayload, r: PaymentRequirements) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
  const server = new x402ResourceServer(client).register(NETWORK, new exact.ExactYcashServerScheme({ priceSource: new exact.YedGetPriceSource(d.wallet) }));
  await server.initialize();
  return { name, node, yellowback: (await node.capabilities()).yellowback, server, facilitator };
}

async function requirementsFor(s: Stack, confirmations?: number, maxTimeoutSeconds = 300): Promise<PaymentRequirements> {
  const [req] = await s.server.buildPaymentRequirements({
    scheme: "exact", network: NETWORK, payTo: merchant, price: { amount: AMOUNT.toString(), asset: "YEC" }, maxTimeoutSeconds,
    ...(confirmations !== undefined ? { extra: { confirmationPolicy: { confirmations } } } : {}),
  });
  return req as PaymentRequirements;
}

/** The 402 → payload round trip through x402Client. */
async function payload(s: Stack, p: Payer, req: PaymentRequirements): Promise<PaymentPayload> {
  const required = await s.server.createPaymentRequiredResponse([req], { url: "https://merchant.test/resource" });
  return p.client.createPaymentPayload(required);
}

function txOf(pl: PaymentPayload): string {
  return (pl.payload as { transaction: string }).transaction;
}

/** verify → handler → settle, as core's authorization flow runs it. `mineWith` mines once the tx reaches its mempool. */
async function settleFlow(s: Stack, pl: PaymentPayload, req: PaymentRequirements, mineWith?: () => Promise<unknown>): Promise<{ v: VerifyResponse; settled?: SettleResponse; ms: number }> {
  const matched = s.server.findMatchingRequirements([req], pl);
  expect(matched).toBeDefined();
  const v = await s.server.verifyPayment(pl, matched as PaymentRequirements);
  if (!v.isValid) return { v, ms: 0 };
  served++; // the protected resource runs here
  const t0 = Date.now();
  const settling = s.server.settlePayment(pl, matched as PaymentRequirements);
  if (mineWith) {
    const id = txidOf(txOf(pl));
    await waitFor(async () => (await d.stock.getRawMempool()).includes(id), { what: `${id} in node 1's mempool` });
    await mineWith();
  }
  const settled = await settling;
  return { v, settled, ms: Date.now() - t0 };
}

/** A signed spend of the payment's input 0 back to the payer: the double spend. */
async function conflictingSpend(p: Payer, paymentHex: string, fee = 10_000n): Promise<string> {
  const prev = parseTx(paymentHex).vin[0]!.prevout;
  const out = await d.wallet.getTxOut(prev.txid, prev.vout, false);
  const value = BigInt(Math.round((out?.value ?? 0) * 1e8));
  return signLocal(p, [{ ...prev, value }], [{ value: value - fee, scriptPubKey: p.script }], (await d.tip()) + 20);
}

function signLocal(p: Payer, coins: { txid: string; vout: number; value: bigint; script?: Uint8Array }[], vout: TxOut[], expiryHeight: number): string {
  const tx = newTx({ vin: coins.map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: new Uint8Array(), sequence: SEQUENCE_FINAL })), vout, expiryHeight });
  const pub = pubkeyFromPriv(p.priv);
  coins.forEach((c, i) => {
    tx.vin[i]!.scriptSig = p2pkhScriptSig(signInput(sighashV4(tx, i, c.script ?? p.script, c.value, SIGHASH.ALL, 0x19bd2d2f), p.priv), pub);
  });
  return serializeTxHex(tx);
}

/** The same requirements in `accepted`, a payload built for different ones: what a cheating client sends. */
async function forged(p: Payer, req: PaymentRequirements, built: PaymentRequirements): Promise<PaymentPayload> {
  const r = await p.scheme.createPaymentPayload(2, built);
  return { x402Version: 2, accepted: req, payload: r.payload, resource: { url: "https://merchant.test/resource" } };
}

describeDevnet("exact YEC through @x402/core on a live devnet", () => {
  const stacks: Stack[] = [];
  let payer: Payer;

  beforeAll(async () => {
    d = await devnet();
    merchant = await d.stock.getNewAddress(); // the merchant's wallet is the stock node's
    stacks.push(await makeStack("yellowback", d.wallet), await makeStack("stock", d.stock));
    payer = newPayer();
    await fundPayer(payer, 40);
  });

  for (const which of ["yellowback", "stock"] as const) {
    const S = () => stacks.find((s) => s.name === which) as Stack;

    it(`[${which}] happy path at -1, 0 and 1; blocks mined by node 1, the stock seat; latency per policy`, async () => {
      const s = S();
      const latency: Record<string, number> = {};
      for (const c of [-1, 0, 1]) {
        const req = await requirementsFor(s, c);
        expect(req.extra).toMatchObject({ assetTransferMethod: "transparent", areFeesSponsored: false, confirmationPolicy: { confirmations: c } });
        const pl = await payload(s, payer, req);
        const before = served;
        const r = await settleFlow(s, pl, req, c >= 0 ? () => d.mine(1, d.stock) : undefined);
        expect(r.v).toMatchObject({ isValid: true, payer: payer.address });
        expect(r.settled).toMatchObject({ success: true, transaction: txidOf(txOf(pl)), network: NETWORK, payer: payer.address });
        expect(r.settled?.extra).toEqual(c < 0 ? { status: "mempool", confirmations: -1 } : { status: "confirmed", confirmations: 1 });
        expect(served).toBe(before + 1);
        latency[String(c)] = r.ms;
        if (c < 0) await d.mine(1, d.stock);
        // node 1 (stock) mined the block that holds it
        const best = await d.stock.call<{ tx: string[] }>("getblock", [await d.stock.call<string>("getbestblockhash")]);
        expect(best.tx).toContain(txidOf(txOf(pl)));
      }
      record(d.line, `exact latency ms, facilitator ${which} (settle call incl. mining trigger)`, latency);
    });

    it(`[${which}] the RPC wallet signer pays too (node 4's wallet)`, async () => {
      const s = S();
      const w = d.nodes[4] as YcashRpc;
      await d.fund(await w.getNewAddress(), 50_000_000n);
      await d.fund(await w.getNewAddress(), 50_000_000n);
      await d.mine(1);
      const client = new x402Client().register(NETWORK, new exact.ExactYcashScheme(new exact.RpcWalletSigner(w)));
      client.setSpendControls({ allowedAssets: [exact.yecSpendControl(NETWORK, 10_000_000n)] });
      const req = await requirementsFor(s, -1);
      const pl = await client.createPaymentPayload(await s.server.createPaymentRequiredResponse([req], { url: "https://merchant.test/resource" }));
      const r = await settleFlow(s, pl, req);
      expect(r.settled?.success).toBe(true);
      await d.mine(1);
    });

    it(`[${which}] USD price through yed_getprice`, async () => {
      const s = S();
      const priced = await s.server.buildPaymentRequirements({ scheme: "exact", network: NETWORK, payTo: merchant, price: "$0.10", maxTimeoutSeconds: 300 });
      const rate = await new exact.YedGetPriceSource(d.wallet).microUsdPerYec(NETWORK);
      const expected = (100_000n * 100_000_000n + rate - 1n) / rate;
      expect(priced[0]).toMatchObject({ asset: "YEC", amount: expected.toString(), extra: { confirmationPolicy: { confirmations: -1 } } });
    });

    it(`[${which}] wrong amount, wrong recipient, low fee, expiry out of window, bad signature`, async () => {
      const s = S();
      const req = await requirementsFor(s, -1);
      const results: Record<string, string | undefined> = {};
      const check = async (name: string, pl: PaymentPayload, reason: string) => {
        const v = await s.server.verifyPayment(pl, req);
        results[name] = v.invalidReason;
        expect(v.isValid).toBe(false);
        expect(v.invalidReason).toBe(reason);
      };
      await check("wrong amount", await forged(payer, req, { ...req, amount: (AMOUNT + 1n).toString() }), exact.ERR_AMOUNT_MISMATCH);
      await check("wrong recipient", await forged(payer, req, { ...req, payTo: await d.stock.getNewAddress() }), exact.ERR_RECIPIENT_MISMATCH);
      await check("expiry out of window", await forged(payer, req, { ...req, maxTimeoutSeconds: 3000 }), exact.ERR_EXPIRY);

      const coins = await new exact.RpcUtxoSource(d.wallet).listCoins(payer.address);
      const c = coins[coins.length - 1]!;
      const low = signLocal(payer, [{ txid: c.txid, vout: c.vout, value: c.value }], [{ value: AMOUNT, scriptPubKey: addressToScript(merchant, NETWORK) }, { value: c.value - AMOUNT - 500n, scriptPubKey: payer.script }], (await d.tip()) + 7);
      await check("low fee", { x402Version: 2, accepted: req, payload: { transaction: low } }, exact.ERR_FEE_TOO_LOW);

      const good = parseTx(txOf(await payload(s, payer, req)));
      const sig = good.vin[0]!.scriptSig;
      sig[10] = (sig[10] as number) ^ 1;
      await check("bad signature", { x402Version: 2, accepted: req, payload: { transaction: serializeTxHex(good) } }, exact.ERR_SCRIPT);
      record(d.line, `exact negatives, facilitator ${which}`, results);
    });

    it(`[${which}] a spent input and a conflicting mempool spend are refused; neither line replaces`, async () => {
      const s = S();
      const req = await requirementsFor(s, -1);
      // spent in a block
      const a = await payload(s, payer, req);
      await d.stock.sendRawTransaction(await conflictingSpend(payer, txOf(a)));
      await d.mine(1);
      expect((await s.server.verifyPayment(a, req)).invalidReason).toBe(exact.ERR_INPUT_SPENT);
      // spent in the mempool only
      const b = await payload(s, payer, req);
      await d.stock.sendRawTransaction(await conflictingSpend(payer, txOf(b)));
      await d.syncMempools();
      expect((await s.server.verifyPayment(b, req)).invalidReason).toBe(exact.ERR_INPUT_SPENT);
      // the replacement question (plan §5.5): the payment itself cannot displace the conflict
      let replacement: unknown = "accepted";
      try {
        await s.node.sendRawTransaction(txOf(b));
      } catch (e) {
        replacement = { code: (e as { code: number }).code, kind: (e as { kind: string }).kind };
      }
      record(d.line, `replacement of a mempool spend at ${which}`, replacement);
      expect(replacement).not.toBe("accepted");
      await d.mine(1);
    });

    it(`[${which}] the same transaction twice: one resource, then duplicate_settlement`, async () => {
      const s = S();
      const req = await requirementsFor(s, -1);
      const pl = await payload(s, payer, req);
      const before = served;
      expect((await settleFlow(s, pl, req)).settled?.success).toBe(true);
      const again = await settleFlow(s, pl, req);
      expect(again.v).toMatchObject({ isValid: false, invalidReason: exact.ERR_DUPLICATE_SETTLEMENT });
      expect(served).toBe(before + 1);
      // a direct re-settle resumes observing: no second broadcast is needed or made
      const direct = await s.facilitator.settle(pl, req);
      expect(direct).toMatchObject({ success: true, transaction: txidOf(txOf(pl)) });
      await d.mine(1);
    });

    it(`[${which}] settlement_pending when no blocks come; the retry never rebroadcasts`, async () => {
      const quick = await makeStack(`${which}-quick`, S().node, 3_000);
      const req = await requirementsFor(quick, 1);
      const pl = await payload(quick, payer, req);
      const t0 = Date.now();
      const r = await settleFlow(quick, pl, req);
      const id = txidOf(txOf(pl));
      expect(r.settled).toMatchObject({ success: false, errorReason: exact.ERR_SETTLEMENT_PENDING, transaction: id, extra: { status: "pending", confirmations: -1 } });
      record(d.line, `settlement_pending after core's one retry, facilitator ${which}`, { ms: Date.now() - t0 });
      await d.mine(1, d.stock);
      const later = await quick.facilitator.settle(pl, req);
      expect(later).toMatchObject({ success: true, extra: { status: "confirmed", confirmations: 1 } });
    });
  }

  it("a YED-bearing input: refused on the Yellowback facilitator, unseen by the stock one; coin selection skips it", async () => {
    const yp = newPayer();
    await fundPayer(yp, 2);
    // node 0 mints YED (two transactions: the carrier, then the MINT) and sends $1.00 to the payer's yr… address
    if ((await d.wallet.call<unknown[]>("yed_listunspent")).length === 0) {
      await d.wallet.call("yed_mint", [10_000, 48, "", "", false]);
      await waitFor(async () => (await d.mine(1), (await d.wallet.call<unknown[]>("yed_listunspent")).length > 0), { timeoutMs: 120_000, what: "the MINT" });
    }
    await waitFor(async () => {
      try {
        await d.wallet.call("yed_send", [yp.yr, 100]);
        return true;
      } catch {
        await d.mine(1); // the wallet's YED may still be settling into the index
        return false;
      }
    }, { timeoutMs: 60_000, what: "yed_send" });
    await d.mine(1);
    const tokens = await d.wallet.call<{ txid: string; vout: number; cents: number; valueZat: number }[]>("yed_listtokens", [[yp.yr]]);
    expect(tokens).toHaveLength(1);
    const t = tokens[0]!;
    const listed = await new exact.RpcUtxoSource(d.wallet).listCoins(yp.address);
    expect(listed.some((c) => c.txid === t.txid && c.vout === t.vout)).toBe(false); // rule 9Y's client-side guard
    expect(listed).toHaveLength(2);

    const results: Record<string, unknown> = {};
    for (const s of stacks) {
      const req = await requirementsFor(s, -1);
      const c = listed[0]!;
      const hex = signLocal(
        yp,
        [{ txid: t.txid, vout: t.vout, value: BigInt(t.valueZat) }, { txid: c.txid, vout: c.vout, value: c.value }],
        [{ value: AMOUNT, scriptPubKey: addressToScript(merchant, NETWORK) }, { value: BigInt(t.valueZat) + c.value - AMOUNT - 1_000n, scriptPubKey: yp.script }],
        (await d.tip()) + 7,
      );
      const v = await s.server.verifyPayment({ x402Version: 2, accepted: req, payload: { transaction: hex } }, req);
      results[s.name] = v.isValid ? "valid (no token records on a stock node)" : v.invalidReason;
      if (s.yellowback) expect(v.invalidReason).toBe(exact.ERR_YED_INPUT);
      else expect(v.isValid).toBe(true);
    }
    record(d.line, "YEC payment spending a YED coin", results);
  });

  it("one payment mined through the yolo stratum pool", async () => {
    const state = JSON.parse(readFileSync(DEVNET_JSON as string, "utf8")) as { portseed: number; bitcoind: string; dir: string };
    const repo = d.line === "v6" ? "ycash6" : "ycash-dd";
    const cli = join(WORKSPACE, repo, "contrib/yellowback/devnet/yellowback-devnet");
    const env = { ...process.env, YELLOWBACK_DEVNET_DIR: state.dir, YELLOWBACK_DEVNET_PORTSEED: String(state.portseed), [d.line === "v6" ? "ZCASHD" : "BITCOIND"]: state.bitcoind };
    const run = (...args: string[]) => promisify(execFile)(join(WORKSPACE, ".venv/bin/python"), [cli, ...args], { env, timeout: 300_000 });
    const POOL = 3;
    await run("pool", String(POOL), "stratum", "start");
    try {
      const s = await makeStack("yellowback-op3", d.wallet, 75_000);
      const req = await requirementsFor(s, 1);
      const pl = await payload(s, payer, req);
      const id = txidOf(txOf(pl));
      // yolo hands out new work only when the height moves (yolo/src/poller.rs:5-9), so a tx that
      // arrives mid-height waits for the next job: mine through the pool until it is in a block.
      let stratumBlocks = 0;
      const r = await settleFlow(s, pl, req, async () => {
        await waitFor(async () => (await (d.nodes[POOL] as YcashRpc).getRawMempool()).includes(id), { what: "the payment at the pool" });
        while (stratumBlocks < 4 && (await d.stock.getTxOut(id, 0, false)) === null) {
          await run("mine", "1", String(POOL));
          stratumBlocks++;
          await d.syncBlocks();
        }
      });
      expect(r.settled).toMatchObject({ success: true, extra: { status: "confirmed", confirmations: 1 } });
      await d.syncBlocks();
      const block = await d.stock.call<{ tx: string[]; height: number }>("getblock", [await d.stock.call<string>("getbestblockhash")]);
      expect(block.tx).toContain(id);
      const coinbaseOut = await d.stock.getTxOut(block.tx[0] as string, 0, false);
      const status = JSON.parse(readFileSync(DEVNET_JSON as string, "utf8")) as { stratum?: Record<string, { payout: string }> };
      const payout = status.stratum?.[String(POOL)]?.payout;
      expect(coinbaseOut?.scriptPubKey.addresses).toContain(payout); // yolo's --payout: the block is the pool's
      record(d.line, "yolo block", { height: block.height, payout, stratumBlocks, latencyMs: r.ms });
    } finally {
      await run("pool", String(POOL), "stratum", "stop");
    }
  });
});
