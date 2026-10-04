import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batch, channel, tx as T, FileChannelStore } from "../../../src/index.js";
import { NET, reasonOf, serverPriv, setup } from "./setup.js";

const E = batch.BatchError;

/** Opens a channel and serves its first request (the funding mined to depth 1). */
async function opened(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  const payload = await s.pay();
  if (o.confirmations !== -1) {
    expect(await reasonOf(s.server.manager.verify(payload, s.req))).toBe(E.FUNDING_DEPTH);
    s.chain.mine();
  }
  const v = await s.server.manager.verify(payload, s.req);
  const settle = await s.server.manager.settle(v, 2000n);
  await s.client.applySettleResponse(settle);
  const channelId = settle.payer as string;
  return { ...s, channelId, openSettle: settle };
}

describe("open", () => {
  it("relays the funding, waits for depth 1, serves the request and answers per spec", async () => {
    const s = await opened();
    expect(s.chain.sent).toHaveLength(1); // the funding, relayed once
    const fundingTxid = s.channelId.split(":")[0];
    expect(s.openSettle).toMatchObject({ success: true, transaction: fundingTxid, network: NET, payer: s.channelId, amount: "" });
    expect(s.openSettle.extra).toEqual({
      commitmentId: `${s.channelId}@2000`,
      chargedAmount: "2000",
      channelState: { channelId: s.channelId, deposit: "100000", chargedCumulative: "2000", signedCumulative: "2000", refundHeight: 1100, closeMarginBlocks: 10 },
    });
    expect((await s.client.status(s.channelId)).status).toBe("open");
  });

  it("accepts a mempool funding with the −1 opt-in", async () => {
    const s = await opened({ confirmations: -1 });
    expect(s.openSettle.success).toBe(true);
  });

  it("a retried open (funding depth) resends the same open and is not relayed twice", async () => {
    const s = await setup();
    const a = await s.pay();
    expect(await reasonOf(s.server.manager.verify(a, s.req))).toBe(E.FUNDING_DEPTH);
    const b = await s.pay();
    expect(b.payload).toEqual(a.payload);
    expect(await reasonOf(s.server.manager.verify(b, s.req))).toBe(E.FUNDING_DEPTH);
    expect(s.chain.sent).toHaveLength(1);
  });

  it("refuses a redeem script with another S, a short lock, and C = S", async () => {
    const s = await setup();
    const good = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    const ch = channel.parseChannelScript(T.hexToBytes(good.redeemScript))!;
    for (const [script, why] of [
      [{ ...ch, serverPubKey: T.pubkeyFromPriv(T.hexToBytes("55".repeat(32))) }, "S"],
      [{ ...ch, refundHeight: s.chain.tip + 99 }, "t"],
    ] as const) {
      const p = { ...good, redeemScript: channel.channelScriptHex(script) };
      expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p }), s.req)), why).toBe(E.REDEEM_SCRIPT);
    }
    const same = T.buildScript([T.OP.OP_IF, T.OP.OP_2, ch.serverPubKey, ch.serverPubKey, T.OP.OP_2, T.OP.OP_CHECKMULTISIG, T.OP.OP_ELSE, BigInt(ch.refundHeight), T.OP.OP_CHECKLOCKTIMEVERIFY, T.OP.OP_DROP, ch.serverPubKey, T.OP.OP_CHECKSIG, T.OP.OP_ENDIF]);
    expect(await reasonOf(s.server.manager.verify(s.wrap({ ...good, redeemScript: T.bytesToHex(same) }), s.req))).toBe(E.REDEEM_SCRIPT);
  });

  it("refuses a deposit above maxDeposit, a funding not paying the script, a spent input and a low fee", async () => {
    const s = await setup({ maxDeposit: 50_000n, deposit: 40_000n });
    const p = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    // the client caps D at maxDeposit, so tamper on the wire: a V above maxDeposit + closeFee
    const f = T.parseTx(p.fundingTx);
    f.vout[0]!.value = 60_000n;
    expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p, fundingTx: T.serializeTxHex(f) }), s.req))).toBe(E.DEPOSIT_TOO_LARGE);
    expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p, vout: 1 }), s.req))).toBe(E.FUNDING);
    const lowFee = T.parseTx(p.fundingTx);
    lowFee.vout[1]!.value += 1n;
    expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p, fundingTx: T.serializeTxHex(lowFee) }), s.req))).toBe(E.FUNDING);
    const spent = s.chain.coins.get(`${f.vin[0]!.prevout.txid}:0`)!;
    spent.spentInMempool = true;
    expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p }), s.req))).toBe(E.FUNDING);
  });

  it("refuses a mismatched envelope, a wrong network and a malformed payload", async () => {
    const s = await setup();
    const p = await s.pay();
    expect(await reasonOf(s.server.manager.verify({ ...p, accepted: { ...s.req, amount: "1" } }, s.req))).toBe(E.REQUIREMENTS);
    expect(await reasonOf(s.server.manager.verify({ ...p, x402Version: 1 }, s.req))).toBe(E.REQUIREMENTS);
    expect(await reasonOf(s.server.manager.verify(s.wrap({ type: "claim", channelId: "x", tx: "00", cumulative: "1" }), s.req))).toBe(E.PAYLOAD_TYPE);
    expect(await reasonOf(s.server.manager.verify(s.wrap({ type: "voucher" }), s.req))).toBe(E.PAYLOAD_TYPE);
    s.chain.chain = "main";
    expect(await reasonOf(s.server.manager.verify(p, s.req))).toBe(E.NETWORK);
  });
});

describe("vouchers", () => {
  it("each voucher is charged + amount; dynamic pricing charges less and the next voucher follows", async () => {
    const s = await opened();
    const r1 = await s.request(700n);
    expect(r1.payload.payload.cumulative).toBe("4000");
    expect(r1.settle.extra?.channelState).toMatchObject({ chargedCumulative: "2700", signedCumulative: "4000" });
    expect(r1.settle.transaction).toBe("");
    expect(r1.settle.extra?.commitmentId).toBe(`${s.channelId}@4000`);
    const r2 = await s.request(1n);
    expect(r2.payload.payload.cumulative).toBe("4700");
    expect((await s.server.manager.channelState(s.channelId)).chargedCumulative).toBe("2701");
  });

  it("refuses a stale voucher, one below charged + amount, one above D, and a charge above the ceiling", async () => {
    const s = await opened();
    const first = await s.request();
    await s.request();
    expect(await reasonOf(s.server.manager.verify(first.payload, s.req))).toBe(E.STALE_VOUCHER);
    // a fresh voucher at charged + amount − 1
    const rec = (await s.client.storage.get(s.channelId))!;
    const ch = batch.client.channelOfRecord(rec);
    const mk = (cum: bigint) => s.wrap({ type: "voucher", channelId: s.channelId, cumulative: cum.toString(),
      tx: T.serializeTxHex(channel.buildVoucher({ channel: ch, cumulative: cum, clientScript: T.hexToBytes(rec.clientScript), clientPrivKey: T.hexToBytes(rec.clientPrivKey), branchId: s.chain.branchId })) });
    expect(await reasonOf(s.server.manager.verify(mk(7999n), s.req))).toBe(E.CUMULATIVE_MISMATCH);
    expect(await reasonOf(s.server.manager.verify({ ...mk(8000n), payload: { ...mk(8000n).payload, cumulative: "100001" } }, s.req))).toBe(E.CUMULATIVE_EXCEEDS_DEPOSIT);
    const v = await s.server.manager.verify(mk(8000n), s.req);
    expect(await reasonOf(s.server.manager.settle(v, 2001n))).toBe(E.CUMULATIVE_MISMATCH);
    // the lock was released: the same voucher can be retried
    const again = await s.server.manager.verify(mk(8000n), s.req);
    await s.server.manager.settle(again, 2000n);
  });

  it("refuses a bad client signature, a tampered shape and a voucher the node's verifier refuses", async () => {
    const s = await opened();
    const p = await s.pay();
    const t = T.parseTx(p.payload.tx as string);
    const ss = channel.parseCloseScriptSig(t.vin[0]!.scriptSig)!;
    const bad = ss.sigC.slice();
    bad[10]! ^= 1;
    t.vin[0]!.scriptSig = T.p2shScriptSig([T.OP.OP_0, bad, T.OP.OP_0, T.OP.OP_1], ss.redeemScript);
    expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p.payload, tx: T.serializeTxHex(t) }), s.req))).toBe(E.VOUCHER_SIGNATURE);
    const t2 = T.parseTx(p.payload.tx as string);
    t2.vout[1]!.value -= 1n;
    expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p.payload, tx: T.serializeTxHex(t2) }), s.req))).toBe(E.VOUCHER_SHAPE);
    s.chain.failScripts = true;
    expect(await reasonOf(s.server.manager.verify(p, s.req))).toBe(E.SCRIPT);
    s.chain.failScripts = false;
    expect((await s.server.manager.verify(p, s.req)).cumulative).toBe(4000n);
  });

  it("keeps one voucher in flight per channel; a failed handler releases it and the same voucher is resent", async () => {
    const s = await opened();
    const p = await s.pay();
    const v = await s.server.manager.verify(p, s.req);
    expect(await reasonOf(s.server.manager.verify(p, s.req))).toBe(E.CHANNEL_BUSY);
    await s.server.manager.release(v); // handler failed: nothing charged
    const v2 = await s.server.manager.verify(p, s.req);
    const r = await s.server.manager.settle(v2, 2000n);
    expect(r.extra?.channelState).toMatchObject({ chargedCumulative: "4000" });
  });

  it("refuses an unknown channel and a channel whose output is spent", async () => {
    const s = await opened();
    const p = await s.pay();
    expect(await reasonOf(s.server.manager.verify(s.wrap({ ...p.payload, channelId: `${"00".repeat(32)}:0` }), s.req))).toBe(E.UNKNOWN_CHANNEL);
    s.chain.coins.get(s.channelId)!.spentInMempool = true;
    expect(await reasonOf(s.server.manager.verify(p, s.req))).toBe(E.CHANNEL_CLOSING);
  });

  it("refuses a voucher under other requirements than the channel's", async () => {
    const s = await opened();
    const other = { ...s.req, payTo: T.encodeAddress(NET, "p2pkh", T.hexToBytes("bb".repeat(20))) };
    const p = await s.pay();
    expect(await reasonOf(s.server.manager.verify({ ...p, accepted: other }, other))).toBe(E.REQUIREMENTS);
  });
});

describe("close triggers", () => {
  it("margin: a voucher at t − margin is refused and the highest voucher is closed", async () => {
    const s = await opened();
    await s.request(1500n);
    const p = await s.pay();
    s.chain.tip = 1100 - 10;
    expect(await reasonOf(s.server.manager.verify(p, s.req))).toBe(E.CHANNEL_CLOSING);
    expect(s.closes).toEqual([{ channelId: s.channelId, reason: "margin", txid: expect.any(String), cumulative: 4000n }]);
    const close = T.parseTx(s.chain.sent.at(-1)!);
    expect(close.vout[0]!.value).toBe(4000n); // the highest voucher, not the charged total (X-F16)
    expect(close.vout[1]!.value).toBe(100_000n - 4000n);
    expect(await reasonOf(s.server.manager.verify(p, s.req))).toBe(E.CHANNEL_CLOSING);
    expect(await s.server.manager.close(s.channelId)).toBe(s.closes[0]!.txid); // idempotent
  });

  it("exhausted: the close goes out when the next request no longer fits", async () => {
    const s = await opened({ deposit: 6000n });
    await s.request();
    expect(s.closes).toHaveLength(0);
    await s.request(); // charged 6000 = D
    expect(s.closes.map((c) => [c.reason, c.cumulative])).toEqual([["exhausted", 6000n]]);
    const close = T.parseTx(s.chain.sent.at(-1)!);
    expect(close.vout).toHaveLength(1);
    expect(close.vout[0]!.value).toBe(6000n);
  });

  it("idle and margin sweeps close tracked channels; the watcher warns once and closes at the margin", async () => {
    const s = await opened({ idleMs: 0 });
    expect((await s.server.manager.sweep()).map((c) => c.reason)).toEqual(["idle"]);
    const m = await opened();
    const warnings: string[] = [];
    const w = m.server.manager.watcher({ warn: (x) => warnings.push(x) });
    expect(await w.check()).toEqual([]);
    m.chain.tip = 1090;
    expect((await w.check()).map((c) => c.channelId)).toEqual([m.channelId]);
    await w.check();
    expect(warnings).toHaveLength(1);
    expect(m.closes.map((c) => c.reason)).toEqual(["margin"]);
  });

  it("client close: a voucher at exactly the charged total is broadcast at settle and runs no handler", async () => {
    const s = await opened();
    await s.request(500n); // charged 2500, signed 4000
    const wrong = s.wrap({ ...(await s.client.closePayload(s.channelId)).payload, cumulative: "4000" });
    expect(await reasonOf(s.server.manager.verify(wrong, s.req))).toBe(E.CUMULATIVE_MISMATCH);
    const p = s.wrap((await s.client.closePayload(s.channelId)).payload);
    const v = await s.server.manager.verify(p, s.req);
    expect(v.kind).toBe("close");
    const r = await s.server.manager.settle(v, 0n);
    expect(r.success).toBe(true);
    const close = T.parseTx(s.chain.sent.at(-1)!);
    expect(T.txid(close)).toBe(r.transaction);
    expect(close.vout[0]!.value).toBe(2500n);
    expect(s.closes[0]).toMatchObject({ reason: "client", cumulative: 2500n });
  });

  it("a close after the client refunded records the channel as closed with no txid", async () => {
    const s = await opened();
    s.chain.coins.get(s.channelId)!.spentInMempool = true;
    expect(await s.server.manager.close(s.channelId)).toBeUndefined();
  });
});

describe("ledger", () => {
  const stores = [
    ["memory", () => undefined],
    ["file", () => new FileChannelStore(join(mkdtempSync(join(tmpdir(), "x402-batch-")), "channels.json"))],
  ] as const;
  it.each(stores)("works over the %s ChannelStore (compare-and-set, in-flight lock)", async (_n, make) => {
    const store = make();
    const s = await opened(store ? { store } : {});
    const L = s.server.manager.ledger;
    expect(await L.storeVoucher(s.channelId, 1000n, "aa")).toBe("stale");
    expect(await L.storeVoucher(s.channelId, 2000n, "bb")).toBe("stale"); // same cumulative, other voucher
    const t = await L.acquire(s.channelId);
    expect(t).not.toBeNull();
    expect(await L.acquire(s.channelId)).toBeNull();
    await L.release(s.channelId, t!);
    // a lock left by a crashed holder expires
    const t2 = await L.acquire(s.channelId, 0);
    expect(await L.acquire(s.channelId, Date.now())).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(await L.claimClose(s.channelId)).toBe(true);
    expect(await L.claimClose(s.channelId)).toBe(false);
  });
});

describe("requirements", () => {
  const base = async () => (await setup()).req;
  it("parseTerms enforces the extra rules", async () => {
    const req = await base();
    expect(batch.parseTerms(req)).toMatchObject({ amount: 2000n, minLockBlocks: 100, closeMarginBlocks: 10, closeFee: 1500n, confirmations: 1 });
    const bad = (extra: Record<string, unknown>, top: Record<string, unknown> = {}) => () => batch.parseTerms({ ...req, ...top, extra: { ...req.extra, ...extra } });
    expect(bad({ closeMarginBlocks: 100 })).toThrow(/closeMarginBlocks/);
    expect(bad({ areFeesSponsored: true })).toThrow(/areFeesSponsored/);
    expect(bad({ serverPubKey: "03" + "5e".repeat(32) })).toThrow(/serverPubKey/);
    expect(bad({ confirmationPolicy: { confirmations: 21 } })).toThrow(/confirmations/);
    expect(bad({ confirmationPolicy: { confirmations: -1 } }, { asset: "YED" })).toThrow(/YED/);
    expect(bad({}, { amount: "0" })).toThrow(/amount/);
    expect(bad({}, { network: "ycash:other" })).toThrow(/network/);
    expect(batch.requiredDepth(-1)).toBe(0);
    expect(batch.requiredDepth(0)).toBe(1);
    expect(batch.requiredDepth(3)).toBe(3);
  });

  it("the server refuses a close fee below the floor and a margin not below the lock", () => {
    expect(() => new batch.server.BatchYcashScheme({ chain: {} as never, serverPrivKey: serverPriv, maxDeposit: 1n, closeFee: 1499n })).toThrow(/floor/);
    expect(() => new batch.server.BatchYcashScheme({ chain: {} as never, serverPrivKey: serverPriv, maxDeposit: 1n, minLockBlocks: 10, closeMarginBlocks: 10 })).toThrow(/closeMarginBlocks/);
  });

  it("parsePrice reads YEC amounts", async () => {
    const s = await setup();
    expect(await s.server.parsePrice("0.0002", NET)).toEqual({ amount: "20000", asset: "YEC" });
    expect(await s.server.parsePrice(0.00002, NET)).toEqual({ amount: "2000", asset: "YEC" });
    expect(await s.server.parsePrice({ amount: "5", asset: "YEC" }, NET)).toEqual({ amount: "5", asset: "YEC" });
    await expect(s.server.parsePrice("$0.01", NET)).rejects.toThrow(/price source/);
  });
});
