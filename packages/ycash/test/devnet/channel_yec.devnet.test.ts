// X2 acceptance on a live devnet (plan §7 X2): YEC payment channels as `batch-settlement`, on
// either node line. The server's node is node 1 (stock, no -yellowback): a YEC channel needs no
// overlay. The client funds from node 0's wallet. Every close is mined by node 1 (OP-1).
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import {
  batch, channel, tx as T, BatchYcashClientScheme, BatchYcashServerScheme, FileChannelStore, SendRawTransactionError, rpcWalletFunder, zatToYecString,
  type ChannelStore,
} from "../../src/index.js";
import { describeDevnet, devnet, record, waitFor, type Devnet } from "./harness.js";

const NET = "ycash:regtest" as const;
const E = batch.BatchError;
const MIN_LOCK = 30;
const MARGIN = 5;
const SLACK = 3;

interface Party {
  server: BatchYcashServerScheme;
  client: BatchYcashClientScheme;
  req: PaymentRequirements;
  payTo: string;
  closes: { channelId: string; reason: string; txid: string | undefined; cumulative: bigint }[];
}

describeDevnet("batch-settlement YEC channels on a live devnet", () => {
  let d: Devnet;

  beforeAll(async () => {
    d = await devnet();
    // a few fresh confirmed non-coinbase coins in node 0's wallet for the funder
    for (let i = 0; i < 4; i++) await d.fund(await d.wallet.getNewAddress(), 5);
    await d.mine(1);
  });

  async function party(o: { amount: bigint; deposit: bigint; confirmations?: number; store?: ChannelStore; serverPrivKey?: Uint8Array }): Promise<Party> {
    const closes: Party["closes"] = [];
    const server = new BatchYcashServerScheme({
      chain: d.stock, serverPrivKey: o.serverPrivKey ?? T.randomPrivKey(), ...(o.store ? { store: o.store } : {}), maxDeposit: 100_000_000n, minLockBlocks: MIN_LOCK, closeMarginBlocks: MARGIN,
      confirmations: o.confirmations ?? 1, onClose: (e) => closes.push(e),
    });
    const payTo = await d.stock.getNewAddress();
    const base: PaymentRequirements = { scheme: "batch-settlement", network: NET, asset: "YEC", amount: o.amount.toString(), payTo, maxTimeoutSeconds: 300, extra: {} };
    const req = await server.enhancePaymentRequirements(base, { x402Version: 2, scheme: "batch-settlement", network: NET }, []);
    const client = new BatchYcashClientScheme({ chain: d.wallet, funder: rpcWalletFunder(d.wallet), deposit: () => o.deposit, lockSlackBlocks: SLACK });
    return { server, client, req, payTo, closes };
  }

  const wrap = (p: Party, payload: Record<string, unknown>): PaymentPayload => ({ x402Version: 2, accepted: p.req, payload });
  const pay = async (p: Party) => wrap(p, (await p.client.createPaymentPayload(2, p.req)).payload);

  /** One paid request: the client's payload, verify, the handler's charge, settle. */
  async function request(p: Party, charge?: bigint) {
    const payload = await pay(p);
    const v = await p.server.manager.verify(payload, p.req);
    const settle = await p.server.manager.settle(v, charge ?? BigInt(p.req.amount));
    await p.client.applySettleResponse(settle);
    return { payload, settle, v };
  }

  /** The open: relayed at the first verify, accepted at the policy depth. */
  async function open(p: Party, charge?: bigint): Promise<string> {
    const payload = await pay(p);
    if (BigInt((p.req.extra.confirmationPolicy as { confirmations: number }).confirmations) >= 0n) {
      await expect(p.server.manager.verify(payload, p.req)).rejects.toMatchObject({ reason: E.FUNDING_DEPTH });
      await d.mine(1);
    }
    const v = await p.server.manager.verify(payload, p.req);
    const settle = await p.server.manager.settle(v, charge ?? BigInt(p.req.amount));
    await p.client.applySettleResponse(settle);
    expect(settle.transaction).toBe(v.fundingTxid);
    return v.channelId;
  }

  /** Mines one block on node 1 (stock) and checks that it carries `txid` (OP-1). */
  async function mineOnStock(txid: string): Promise<void> {
    const [hash] = await d.mine(1, d.stock);
    const block = await d.stock.call<{ tx: string[] }>("getblock", [hash]);
    expect(block.tx).toContain(txid);
  }

  /**
   * What node 1's wallet received at `address`, polled until it equals `want` (the wallet learns of
   * a block asynchronously, and the harness's wallet sync skips txs the wallet does not know yet).
   */
  async function received(address: string, want: bigint): Promise<bigint> {
    let got = -1n;
    await waitFor(async () => {
      got = BigInt(Math.round((await d.stock.call<number>("getreceivedbyaddress", [address, 1])) * 1e8));
      return got === want;
    }, { timeoutMs: 15_000, what: `${address} to receive ${want}` }).catch(() => undefined);
    return got;
  }

  /**
   * The client's remainder came home (the open's returnAddress, a node 0 wallet address): the
   * spend's output to it holds `want`, node 0's wallet received it, and nothing pays the channel key C.
   */
  async function remainderHome(p: Party, channelId: string, txid: string, want: bigint): Promise<void> {
    const rec = (await p.client.storage.get(channelId))!;
    expect(rec.returnAddress).toBeDefined();
    const home = T.addressToScript(rec.returnAddress!, NET);
    const cScript = T.p2pkhScript(T.hash160(T.pubkeyFromPriv(T.hexToBytes(rec.clientPrivKey))));
    const tx = T.parseTx(await d.stock.call<string>("getrawtransaction", [txid]));
    expect(tx.vout.some((o) => T.equalBytes(o.scriptPubKey, cScript))).toBe(false);
    expect(tx.vout.filter((o) => T.equalBytes(o.scriptPubKey, home)).reduce((s, o) => s + o.value, 0n)).toBe(want);
    let got = -1n;
    await waitFor(async () => {
      got = BigInt(Math.round((await d.wallet.call<number>("getreceivedbyaddress", [rec.returnAddress, 1])) * 1e8));
      return got === want;
    }, { timeoutMs: 15_000, what: `the client's wallet to receive ${want} at ${rec.returnAddress}` }).catch(() => undefined);
    expect(got).toBe(want);
    record(d.line, "X2 remainder home", { channelId, returnAddress: rec.returnAddress, txid, remainderZat: want.toString() });
  }

  /** Mines n blocks in batches: the harness reads every new block at once, and a big batch overflows the RPC work queue. */
  async function mineMany(n: number): Promise<void> {
    for (let left = n; left > 0; left -= 8) await d.mine(Math.min(8, left));
  }

  it("open, 1,000 paid requests, one close: the close carries the total and the server receives Σ charges", async () => {
    const N = 1000;
    const p = await party({ amount: 1000n, deposit: 1_100_000n });
    const t0 = Date.now();
    const channelId = await open(p);
    for (let i = 1; i < N; i++) await request(p);
    const ms = Date.now() - t0;
    const state = await p.server.manager.channelState(channelId);
    expect(state.chargedCumulative).toBe(String(N * 1000));
    const closeTxid = (await p.server.manager.close(channelId, "demand"))!;
    expect(p.closes).toHaveLength(1);
    await mineOnStock(closeTxid);
    expect(await received(p.payTo, BigInt(N * 1000))).toBe(BigInt(N * 1000));
    const closeOut = await d.stock.getTxOut(closeTxid, 0, false);
    expect(closeOut?.value).toBe(Number(zatToYecString(N * 1000)));
    await remainderHome(p, channelId, closeTxid, 1_100_000n - BigInt(N * 1000));
    // chain cost: two transactions against N exact payments
    const fundingTxid = channelId.split(":")[0]!;
    const sizes = await Promise.all([fundingTxid, closeTxid].map(async (id) => (await d.stock.call<string>("getrawtransaction", [id])).length / 2));
    const closeTx = T.parseTx(await d.stock.call<string>("getrawtransaction", [closeTxid]));
    const closeFee = BigInt(state.deposit) + 1500n - closeTx.vout.reduce((s, o) => s + o.value, 0n);
    const fundingTx = T.parseTx(await d.stock.call<string>("getrawtransaction", [fundingTxid]));
    record(d.line, "X2 chain cost", {
      requests: N, txs: 2, bytes: sizes[0]! + sizes[1]!, fundingBytes: sizes[0], closeBytes: sizes[1], closeFeeZat: Number(closeFee),
      fundingFeeFloorZat: Number(T.feeFloor(fundingTx)),
      exactEquivalent: { txs: N, bytesAt226: N * 226, feesZat: N * 1000 },
      msFor1000Requests: ms, msPerRequest: ms / N,
    });
  });

  it("dynamic pricing below the ceiling: a client close pays exactly the charged total", async () => {
    const p = await party({ amount: 5000n, deposit: 200_000n });
    const charges = [5000n, 1234n, 1n, 4999n, 2500n, 77n, 3000n];
    const channelId = await open(p, charges[0]);
    for (const c of charges.slice(1)) await request(p, c);
    const total = charges.reduce((s, c) => s + c, 0n);
    const state = await p.server.manager.channelState(channelId);
    expect(BigInt(state.chargedCumulative)).toBe(total);
    expect(BigInt(state.signedCumulative)).toBe(total - charges.at(-1)! + 5000n); // the highest voucher pre-pays the last ceiling (X-F16)
    const close = wrap(p, (await p.client.closePayload(channelId)).payload);
    const v = await p.server.manager.verify(close, p.req);
    const r = await p.server.manager.settle(v, 0n);
    await mineOnStock(r.transaction);
    expect(await received(p.payTo, total)).toBe(total);
    await remainderHome(p, channelId, r.transaction, 200_000n - total);
    record(d.line, "X2 dynamic pricing", { charges: charges.map(String), charged: total.toString(), highestVoucher: state.signedCumulative, closePaid: total.toString() });
  });

  it("refuses a stale voucher and one below charged + amount", async () => {
    const p = await party({ amount: 1000n, deposit: 50_000n });
    const channelId = await open(p);
    const old = await request(p);
    await request(p);
    await expect(p.server.manager.verify(old.payload, p.req)).rejects.toMatchObject({ reason: E.STALE_VOUCHER });
    const rec = (await p.client.storage.get(channelId))!;
    const ch = batch.client.channelOfRecord(rec);
    const branchId = parseInt((await d.wallet.getBlockchainInfo()).consensus.nextblock, 16);
    const low = channel.buildVoucher({ channel: ch, cumulative: 3999n, clientScript: T.hexToBytes(rec.clientScript), clientPrivKey: T.hexToBytes(rec.clientPrivKey), branchId });
    await expect(p.server.manager.verify(wrap(p, { type: "voucher", channelId, tx: T.serializeTxHex(low), cumulative: "3999" }), p.req)).rejects.toMatchObject({ reason: E.CUMULATIVE_MISMATCH });
    const closeTxid = (await p.server.manager.close(channelId))!;
    await mineOnStock(closeTxid);
    expect(await received(p.payTo, 3000n)).toBe(3000n);
  });

  it("a voucher at the margin is refused and the close goes out, mined before t", async () => {
    const p = await party({ amount: 1000n, deposit: 50_000n });
    const channelId = await open(p);
    await request(p);
    const rec = (await p.client.storage.get(channelId))!;
    const next = await pay(p); // signed before the margin…
    const tip = await d.tip();
    await mineMany(rec.refundHeight - MARGIN - tip);
    await expect(p.server.manager.verify(next, p.req)).rejects.toMatchObject({ reason: E.CHANNEL_CLOSING });
    expect(p.closes.map((c) => c.reason)).toEqual(["margin"]);
    const txid = p.closes[0]!.txid!;
    await mineOnStock(txid);
    expect(await d.tip()).toBeLessThan(rec.refundHeight);
    expect(await received(p.payTo, 2000n)).toBe(2000n);
    await remainderHome(p, channelId, txid, 48_000n);
    record(d.line, "X2 margin close", { refundHeight: rec.refundHeight, closedAt: await d.tip(), margin: MARGIN });
  });

  it("the client refunds alone after t (the node refuses it before)", async () => {
    const p = await party({ amount: 1000n, deposit: 50_000n });
    const channelId = await open(p);
    const rec = (await p.client.storage.get(channelId))!;
    const ch = batch.client.channelOfRecord(rec);
    await mineMany(rec.refundHeight - 1 - (await d.tip()));
    // tip = t − 1: a refund with nLockTime t is not final yet
    const branchId = parseInt((await d.wallet.getBlockchainInfo()).consensus.nextblock, 16);
    const early = channel.buildRefund({ channel: ch, clientPrivKey: T.hexToBytes(rec.clientPrivKey), toScript: T.hexToBytes(rec.clientScript), branchId });
    const err = await d.stock.sendRawTransaction(T.serializeTxHex(early)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SendRawTransactionError);
    await expect(p.client.refund(channelId)).rejects.toThrow(/valid from height/);
    await d.mine(1);
    const txid = await p.client.refund(channelId);
    await d.syncMempools();
    await mineOnStock(txid);
    const out = await d.stock.getTxOut(txid, 0, false);
    expect(out).not.toBeNull();
    expect(await received(p.payTo, 0n)).toBe(0n);
    // the refund goes to the return address by default: node 0's wallet gets it all back
    await remainderHome(p, channelId, txid, T.parseTx(await d.stock.call<string>("getrawtransaction", [txid])).vout[0]!.value);
    // the server's close finds the channel spent by the refund
    expect(await p.server.manager.close(channelId)).toBeUndefined();
    record(d.line, "X2 refund", { refundHeight: rec.refundHeight, earlyRefusal: (err as SendRawTransactionError).message, refundZat: T.parseTx(T.serializeTxHex(early)).vout[0]!.value.toString() });
  });

  it("funding at zero confirmations (server opt-in, YEC only): served before any block, closed with the funding", async () => {
    const p = await party({ amount: 1000n, deposit: 20_000n, confirmations: -1 });
    const channelId = await open(p);
    await request(p);
    const fundingTxid = channelId.split(":")[0]!;
    expect((await d.stock.getTxOut(fundingTxid, 0, true))?.confirmations).toBe(0);
    const closeTxid = (await p.server.manager.close(channelId))!;
    await waitFor(async () => (await d.wallet.getRawMempool()).includes(closeTxid), { what: "close to relay" });
    await mineOnStock(closeTxid);
    const block = await d.stock.call<{ tx: string[] }>("getblock", [await d.stock.call<string>("getbestblockhash")]);
    expect(block.tx).toContain(fundingTxid);
    expect(await received(p.payTo, 2000n)).toBe(2000n);
  });

  it("a merchant restart mid-session: the restarted server re-tracks the channel from its store and closes it on idle, before t − margin", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "x402-restart-")), "channels.json");
    const serverPrivKey = T.randomPrivKey();
    const p = await party({ amount: 1000n, deposit: 50_000n, store: new FileChannelStore(path), serverPrivKey });
    const channelId = await open(p);
    await request(p);
    const rec = (await p.client.storage.get(channelId))!;
    // The first process is gone (never swept); a fresh one starts on the same key and store file.
    const closes: Party["closes"] = [];
    const again = new BatchYcashServerScheme({
      chain: d.stock, serverPrivKey, store: new FileChannelStore(path), maxDeposit: 100_000_000n, minLockBlocks: MIN_LOCK, closeMarginBlocks: MARGIN,
      idleMs: 2_000, onClose: (e) => closes.push(e),
    });
    expect(again.manager.tracked()).toEqual([]);
    const t0 = Date.now();
    const w = again.manager.watcher({ pollMs: 500, warn: () => undefined });
    w.start();
    try {
      await waitFor(async () => closes.length > 0, { timeoutMs: 30_000, what: "the restarted server's idle close" });
    } finally {
      await w.stop();
    }
    expect(closes.map((c) => [c.channelId, c.reason, c.cumulative])).toEqual([[channelId, "idle", 2000n]]);
    expect(await d.tip()).toBeLessThan(rec.refundHeight - MARGIN);
    await mineOnStock(closes[0]!.txid!);
    expect(await received(p.payTo, 2000n)).toBe(2000n);
    record(d.line, "X2 restart close", { refundHeight: rec.refundHeight, closedAt: await d.tip(), margin: MARGIN, msToClose: Date.now() - t0 });
  });
});
