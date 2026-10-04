// Coin reservations: a local-key agent must not pick a coin its own earlier payment spends while its
// node has not seen that spend yet (the facilitator broadcast it through another node), in this
// process or the next one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { channel, exact, FileCoinReservationStore, InMemoryCoinReservationStore, reservationLapsed, RpcError, rpcWalletFunder, tx as T, utxoSourceFunder, type CoinReservationStore } from "../../../src/index.js";
import type { UnspentOutput } from "../../../src/node/index.js";
import { NETWORK, testKey } from "./fakeNode.js";

const payer = testKey(1);
const merchant = testKey(2);
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "x402-res-")), "reservations.json");

const stores: [string, () => CoinReservationStore][] = [
  ["InMemoryCoinReservationStore", () => new InMemoryCoinReservationStore()],
  ["FileCoinReservationStore", () => new FileCoinReservationStore(tmpFile())],
];

describe.each(stores)("%s", (_n, make) => {
  it("holds outpoints for one spend, all or none, and releases them", async () => {
    const s = make();
    expect(await s.reserve(["a:0", "b:0"], { spentBy: "t1", expiryHeight: 10 })).toBe(true);
    expect(await s.reserve(["a:0"], { spentBy: "t1", expiryHeight: 10 })).toBe(true); // the same spend again
    expect(await s.reserve(["c:0", "b:0"], { spentBy: "t2", expiryHeight: 10 })).toBe(false);
    expect([...(await s.list()).keys()].sort()).toEqual(["a:0", "b:0"]); // c:0 was not taken
    await s.release(["a:0", "zz:9"]);
    expect([...(await s.list()).keys()]).toEqual(["b:0"]);
  });
});

it("a reservation lapses after its expiry height (inclusive) or, without one, its time", () => {
  expect(reservationLapsed({ spentBy: "t", expiryHeight: 10 }, 10)).toBe(false);
  expect(reservationLapsed({ spentBy: "t", expiryHeight: 10 }, 11)).toBe(true);
  expect(reservationLapsed({ spentBy: "t", expiryHeight: 0, untilMs: 1000 }, 99, 999)).toBe(false);
  expect(reservationLapsed({ spentBy: "t", expiryHeight: 0, untilMs: 1000 }, 99, 1000)).toBe(true);
});

/** A node that has not seen the agent's spends: every listed coin is unspent in its mempool too. */
class LaggingNode {
  tip = 300;
  unspent: UnspentOutput[] = [];
  spentInBlock = new Set<string>();
  async getBlockchainInfo() {
    return { chain: "regtest", blocks: this.tip, headers: this.tip, bestblockhash: "", consensus: { chaintip: "19bd2d2f", nextblock: "19bd2d2f" }, upgrades: {} };
  }
  async listUnspent() {
    return this.unspent.filter((u) => !this.spentInBlock.has(`${u.txid}:${u.vout}`));
  }
  async getTxOut(t: string, n: number) {
    return this.spentInBlock.has(`${t}:${n}`) ? null : ({} as never);
  }
  async capabilities() {
    return { line: "v4" as const, subversion: "", version: 0, yellowback: false, chain: "regtest" };
  }
  async call<R>(): Promise<R> {
    return null as R;
  }
}

const coin = (txid: string, zat: number): UnspentOutput => ({ txid, vout: 0, scriptPubKey: T.bytesToHex(payer.script), amount: zat / 1e8, amountZat: zat, confirmations: 3, spendable: true });
const order = (expiryHeight = 307) => ({ network: NETWORK, payTo: merchant.address, amount: 100_000n, expiryHeight, tip: 300, branchId: 0x19bd2d2f });

describe("RpcUtxoSource with a reservation file (two agent processes, one key)", () => {
  it("the second process does not reselect the first one's pending coin", async () => {
    const node = new LaggingNode();
    node.unspent = [coin("aa".repeat(32), 1_000_000), coin("bb".repeat(32), 900_000)];
    const file = tmpFile();
    const first = new exact.LocalKeySigner(payer.wif, new exact.RpcUtxoSource(node, { reservations: new FileCoinReservationStore(file) }));
    const p1 = await first.signPayment(order());
    // A fresh process: new signer, new source, the same file.
    const second = new exact.LocalKeySigner(payer.wif, new exact.RpcUtxoSource(node, { reservations: new FileCoinReservationStore(file) }));
    const p2 = await second.signPayment(order());
    expect(p1.inputs.map((i) => i.txid)).toEqual(["aa".repeat(32)]);
    expect(p2.inputs.map((i) => i.txid)).toEqual(["bb".repeat(32)]);
    const held = await new FileCoinReservationStore(file).list();
    expect(held.get(`${"aa".repeat(32)}:0`)).toEqual({ spentBy: p1.txid, expiryHeight: 307 });
    await expect(new exact.LocalKeySigner(payer.wif, new exact.RpcUtxoSource(node, { reservations: new FileCoinReservationStore(file) })).signPayment(order())).rejects.toThrow(/insufficient/);
  });

  it("releases a coin when its spend confirms, and one whose spend expired", async () => {
    const node = new LaggingNode();
    node.unspent = [coin("aa".repeat(32), 1_000_000), coin("bb".repeat(32), 900_000)];
    const reservations = new InMemoryCoinReservationStore();
    const src = new exact.RpcUtxoSource(node, { reservations });
    await reservations.reserve([`${"aa".repeat(32)}:0`], { spentBy: "t1", expiryHeight: 305 });
    await reservations.reserve([`${"bb".repeat(32)}:0`], { spentBy: "t2", expiryHeight: 310 });
    expect(await src.listCoins(payer.address)).toEqual([]);
    node.spentInBlock.add(`${"aa".repeat(32)}:0`); // t1 mined
    node.tip = 311; // t2 can no longer be mined
    expect((await src.listCoins(payer.address)).map((c) => c.txid)).toEqual(["bb".repeat(32)]);
    expect((await reservations.list()).size).toBe(0);
  });

  it("selects again when another process takes a coin between listing and reserving", async () => {
    const node = new LaggingNode();
    node.unspent = [coin("aa".repeat(32), 1_000_000), coin("bb".repeat(32), 900_000)];
    const reservations = new InMemoryCoinReservationStore();
    const src = new exact.RpcUtxoSource(node, { reservations });
    let raced = false;
    const racing: exact.UtxoSource = {
      chainState: () => src.chainState(),
      listCoins: (a) => src.listCoins(a),
      reserve: async (coins, spend) => {
        if (!raced) {
          raced = true;
          await reservations.reserve([`${"aa".repeat(32)}:0`], { spentBy: "other", expiryHeight: 400 });
        }
        return src.reserve(coins, spend);
      },
    };
    const p = await new exact.LocalKeySigner(payer.wif, racing).signPayment(order());
    expect(p.inputs.map((i) => i.txid)).toEqual(["bb".repeat(32)]);
  });
});

describe("utxoSourceFunder with reservations", () => {
  it("holds the funding's coins for a while (a funding never expires)", async () => {
    const priv = payer.priv;
    const node = new LaggingNode();
    node.unspent = [coin("aa".repeat(32), 1_000_000), coin("bb".repeat(32), 900_000)];
    const file = tmpFile();
    const redeemScript = channel.buildChannelScript({ clientPubKey: T.pubkeyFromPriv(T.hexToBytes("44".repeat(32))), serverPubKey: T.pubkeyFromPriv(T.hexToBytes("55".repeat(32))), refundHeight: 500 });
    const req = { network: NETWORK, redeemScript, value: 500_000n, branchId: 0x19bd2d2f };
    const t0 = Date.now();
    const a = T.parseTx(await utxoSourceFunder(priv, new exact.RpcUtxoSource(node, { reservations: new FileCoinReservationStore(file) })).fund(req));
    const b = T.parseTx(await utxoSourceFunder(priv, new exact.RpcUtxoSource(node, { reservations: new FileCoinReservationStore(file) })).fund(req));
    expect(a.vin[0]!.prevout.txid).toBe("aa".repeat(32));
    expect(b.vin[0]!.prevout.txid).toBe("bb".repeat(32));
    const r = (await new FileCoinReservationStore(file).list()).get(`${"aa".repeat(32)}:0`)!;
    expect(r).toMatchObject({ spentBy: T.txid(a), expiryHeight: 0 });
    expect(r.untilMs! - t0).toBeGreaterThanOrEqual(1_800_000);
  });
});

describe("utxoSourceFunder with a funding expiry (plan X-F52)", () => {
  const redeemScript = channel.buildChannelScript({ clientPubKey: T.pubkeyFromPriv(T.hexToBytes("44".repeat(32))), serverPubKey: T.pubkeyFromPriv(T.hexToBytes("55".repeat(32))), refundHeight: 500 });

  it("holds the coins until the funding's expiry height, then a fresh process may reselect them", async () => {
    const node = new LaggingNode();
    node.unspent = [coin("aa".repeat(32), 1_000_000), coin("bb".repeat(32), 900_000)];
    const file = tmpFile();
    const funder = () => utxoSourceFunder(payer.priv, new exact.RpcUtxoSource(node, { reservations: new FileCoinReservationStore(file) }));
    const req = { network: NETWORK, redeemScript, value: 500_000n, branchId: 0x19bd2d2f, tip: 300, expiryHeight: 343 };
    const a = T.parseTx(await funder().fund(req));
    expect(a.expiryHeight).toBe(343);
    expect((await new FileCoinReservationStore(file).list()).get(`${"aa".repeat(32)}:0`)).toEqual({ spentBy: T.txid(a), expiryHeight: 343 });
    expect(T.parseTx(await funder().fund(req)).vin[0]!.prevout.txid).toBe("bb".repeat(32));
    node.tip = 344; // both fundings expired unrelayed: their coins are free again
    expect(T.parseTx(await funder().fund({ ...req, tip: 344, expiryHeight: 387 })).vin[0]!.prevout.txid).toBe("aa".repeat(32));
  });

  it("the same funder frees its own coins by height too", async () => {
    const node = new LaggingNode();
    node.unspent = [coin("aa".repeat(32), 1_000_000)];
    const f = utxoSourceFunder(payer.priv, new exact.RpcUtxoSource(node));
    const req = { network: NETWORK, redeemScript, value: 500_000n, branchId: 0x19bd2d2f, tip: 300, expiryHeight: 343 };
    await f.fund(req);
    await expect(f.fund(req)).rejects.toThrow(/cannot fund/);
    node.tip = 344;
    expect(T.parseTx(await f.fund({ ...req, tip: 344, expiryHeight: 387 })).vin[0]!.prevout.txid).toBe("aa".repeat(32));
  });
});

describe("utxoSourceFunder for YED channels", () => {
  const redeemScript = channel.buildChannelScript({ clientPubKey: T.pubkeyFromPriv(T.hexToBytes("44".repeat(32))), serverPubKey: T.pubkeyFromPriv(T.hexToBytes("55".repeat(32))), refundHeight: 500 });
  const token = (n: number, cents: number) => ({ outpoint: { txid: n.toString(16).padStart(64, "d"), vout: 0 }, cents, value: 10_000n, scriptPubKey: payer.script });
  const yecCoin = { txid: "cc".repeat(32), vout: 0, value: 1_000_000n, scriptPubKey: payer.script, confirmations: 3 };
  /** A light-client-like source: the key's token outputs and coins, with shared reservations. */
  const sourceOf = (store: CoinReservationStore, tokens = [token(1, 2_500)], tip = () => 300) => ({
    async listCoins() {
      const held = await heldOf(store, tip());
      return [yecCoin].filter((c) => !held.has(`${c.txid}:${c.vout}`));
    },
    async listTokens() {
      const held = await heldOf(store, tip());
      return tokens.filter((t) => !held.has(`${t.outpoint.txid}:${t.outpoint.vout}`));
    },
    reserve: (coins: readonly T.OutPoint[], spend: { txid: string; expiryHeight: number }) =>
      store.reserve(coins.map((c) => `${c.txid}:${c.vout}`), { spentBy: spend.txid, expiryHeight: spend.expiryHeight }),
  });
  /** As RpcUtxoSource: lapsed reservations are released, the rest are held. */
  const heldOf = async (store: CoinReservationStore, tip: number) => {
    const all = [...(await store.list())];
    await store.release(all.filter(([, r]) => reservationLapsed(r, tip)).map(([o]) => o));
    return new Set(all.filter(([, r]) => !reservationLapsed(r, tip)).map(([o]) => o));
  };
  const req = { network: NETWORK, redeemScript, value: channel.yedChannelValue(1500n), branchId: 0x19bd2d2f, asset: "YED", deposit: 2_000n, tip: 300, expiryHeight: 343 };

  it("funds a TRANSFER of D to the channel from the key's token outputs, YED change back to the key, and holds every input", async () => {
    const store = new InMemoryCoinReservationStore();
    const f = utxoSourceFunder(payer.priv, sourceOf(store));
    const tx = T.parseTx(await f.fund(req));
    expect(tx.expiryHeight).toBe(343);
    expect(tx.vout[0]).toEqual({ value: 21_500n, scriptPubKey: channel.channelScriptPubKey(redeemScript) });
    const found = (await import("../../../src/index.js")).yed.findPayload(tx.vout);
    expect(found && "payload" in found && found.payload.type === "transfer" ? found.payload.assignments : null).toEqual([{ vout: 0, cents: 2_000 }, { vout: 1, cents: 500 }]);
    expect(tx.vout[1]!.scriptPubKey).toEqual(payer.script);
    expect([...(await store.list()).keys()].sort()).toEqual([`${"cc".repeat(32)}:0`, `${"1".padStart(64, "d")}:0`].sort());
    expect(await f.returnAddress!({ network: NETWORK, asset: "YED" })).toBe(T.encodeAddress(NETWORK, "yed", T.hash160(T.pubkeyFromPriv(payer.priv))));
    expect(await f.returnAddress!({ network: NETWORK, asset: "YEC" })).toBe(payer.address);
  });

  it("does not reselect a held token output (another process, the same reservations), until the funding expires", async () => {
    const store = new InMemoryCoinReservationStore();
    let tip = 300;
    await utxoSourceFunder(payer.priv, sourceOf(store, undefined, () => tip)).fund(req);
    await expect(utxoSourceFunder(payer.priv, sourceOf(store, undefined, () => tip)).fund(req)).rejects.toThrow(/YED|cents|insufficient|cover/i);
    tip = 344;
    expect(T.parseTx(await utxoSourceFunder(payer.priv, sourceOf(store, undefined, () => tip)).fund({ ...req, tip: 344, expiryHeight: 387 })).vin[0]!.prevout.txid).toBe("1".padStart(64, "d"));
  });

  it("refuses YED with a source that cannot list token outputs", async () => {
    const f = utxoSourceFunder(payer.priv, { listCoins: async () => [yecCoin] });
    await expect(f.fund(req)).rejects.toThrow(/listTokens/);
  });
});

describe("rpcWalletFunder and the funding expiry", () => {
  const redeemScript = channel.buildChannelScript({ clientPubKey: T.pubkeyFromPriv(T.hexToBytes("44".repeat(32))), serverPubKey: T.pubkeyFromPriv(T.hexToBytes("55".repeat(32))), refundHeight: 500 });
  /** A node wallet that signs anything and records its RPC calls. */
  const wallet = () => {
    const calls: [string, unknown[]][] = [];
    return {
      calls,
      listUnspent: async () => [{ ...coin("aa".repeat(32), 1_000_000), generated: false }],
      signRawTransactionWithWallet: async (hex: string) => ({ hex, complete: true, errors: [] }),
      async call<R>(method: string, params: unknown[] = []): Promise<R> {
        calls.push([method, params]);
        if (method === "yed_listunspent") throw new RpcError(-32601, "Method not found", method);
        if (method === "getrawchangeaddress") return payer.address as R;
        if (method === "yed_getnewaddress") return "yr-new" as R;
        return null as R;
      },
    };
  };

  it("locks the funding's coins, and unlocks them once the funding expired unmined", async () => {
    const w = wallet();
    const f = rpcWalletFunder(w);
    const req = { network: NETWORK, redeemScript, value: 500_000n, branchId: 0x19bd2d2f, tip: 300, expiryHeight: 343 };
    expect(T.parseTx(await f.fund(req)).expiryHeight).toBe(343);
    const locks = () => w.calls.filter(([m]) => m === "lockunspent").map(([, p]) => p);
    expect(locks()).toEqual([[false, [{ txid: "aa".repeat(32), vout: 0 }]]]);
    await f.fund({ ...req, tip: 343 }); // still held at its expiry height (inclusive)
    expect(locks()).toHaveLength(2);
    await f.fund({ ...req, tip: 344, expiryHeight: 387 });
    expect(locks()[2]).toEqual([true, [{ txid: "aa".repeat(32), vout: 0 }]]);
  });

  it("returns the remainder to a new wallet address: transparent for YEC, Yellowback for YED", async () => {
    const f = rpcWalletFunder(wallet());
    expect(await f.returnAddress!({ network: NETWORK, asset: "YEC" })).toBe(payer.address);
    expect(await f.returnAddress!({ network: NETWORK, asset: "YED" })).toBe("yr-new");
  });
});
