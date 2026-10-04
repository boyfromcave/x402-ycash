// Coin reservations: a local-key agent must not pick a coin its own earlier payment spends while its
// node has not seen that spend yet (the facilitator broadcast it through another node), in this
// process or the next one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { channel, exact, FileCoinReservationStore, InMemoryCoinReservationStore, reservationLapsed, tx as T, utxoSourceFunder, type CoinReservationStore } from "../../../src/index.js";
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
