// The lightwalletd adapter over a real gRPC wire (fakeLwd.ts): URL parsing, the client's decoding
// and error mapping, LwdChain's gettxout and broadcast, and LwdUtxoSource's listings and holds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exact, InMemoryCoinReservationStore, SendRawTransactionError, tx as T } from "../../../src/index.js";
import { LwdChain, LwdClient, LwdError, LwdUtxoSource, parseLwdUrl } from "../../../src/lwd/index.js";
import { startFakeLwd, type FakeLwdState } from "./fakeLwd.js";

const NET = "ycash:regtest" as const;
const priv = T.hexToBytes("11".repeat(32));
const pkh = T.hash160(T.pubkeyFromPriv(priv));
const ADDR = T.encodeAddress(NET, "p2pkh", pkh);
const YED_ADDR = T.encodeAddress(NET, "yed", pkh);
const SCRIPT = T.bytesToHex(T.p2pkhScript(pkh));
const txid = (c: string): string => c.repeat(64);

/** A real v4 transaction paying `outs` (zatoshis) to the test key, so parseTx and the address lookup work. */
function rawTx(outs: bigint[]): { hex: string; id: string } {
  const t = T.newTx({
    vin: [{ prevout: { txid: txid("9"), vout: 0 }, scriptSig: new Uint8Array(), sequence: T.SEQUENCE_FINAL }],
    vout: outs.map((value) => ({ value, scriptPubKey: T.p2pkhScript(pkh) })),
  });
  return { hex: T.serializeTxHex(t), id: T.txid(t) };
}

describe("parseLwdUrl", () => {
  it("TLS for grpcs/https and remote bare hosts, plaintext for grpc/http and loopback; default ports", () => {
    expect(parseLwdUrl("lite.ycash.xyz")).toEqual({ target: "lite.ycash.xyz:443", tls: true });
    expect(parseLwdUrl("lite.ycash.xyz:9067")).toEqual({ target: "lite.ycash.xyz:9067", tls: true });
    expect(parseLwdUrl("127.0.0.1:34271")).toEqual({ target: "127.0.0.1:34271", tls: false });
    expect(parseLwdUrl("localhost")).toEqual({ target: "localhost:9067", tls: false });
    expect(parseLwdUrl("grpc://example.org:9067")).toEqual({ target: "example.org:9067", tls: false });
    expect(parseLwdUrl("grpcs://127.0.0.1:9067")).toEqual({ target: "127.0.0.1:9067", tls: true });
    expect(parseLwdUrl("https://lite.ycash.xyz/")).toEqual({ target: "lite.ycash.xyz:443", tls: true });
    expect(parseLwdUrl("[::1]:9067")).toEqual({ target: "[::1]:9067", tls: false });
  });

  it("refuses what is not host[:port]", () => {
    for (const bad of ["", "http://", "host:port", "a b:1", "host:70000", "ftp://host:1", "host:1/path"]) expect(() => parseLwdUrl(bad), bad).toThrow();
  });
});

describe("LwdClient over gRPC", () => {
  let fake: Awaited<ReturnType<typeof startFakeLwd>>;
  let lwd: LwdClient;
  let s: FakeLwdState;

  beforeAll(async () => {
    fake = await startFakeLwd();
    s = fake.state;
    lwd = new LwdClient({ url: fake.url, deadlineMs: 2_000 });
  });
  afterAll(async () => {
    lwd.close();
    await fake.stop();
  });

  it("decodes GetLightdInfo and GetLatestBlock", async () => {
    expect(await lwd.getLightdInfo()).toMatchObject({ chainName: "regtest", blockHeight: "200", consensusBranchId: "19bd2d2f", taddrSupport: true });
    expect(await lwd.getLatestBlock()).toBe(200);
    expect(lwd.tls).toBe(false);
  });

  it("GetAddressUtxos: txids back in display order, values as bigint, height filter", async () => {
    s.utxos = [
      { address: ADDR, txid: "01" + "00".repeat(31), vout: 1, script: SCRIPT, valueZat: 123_456, height: 150 },
      { address: ADDR, txid: txid("2"), vout: 0, script: SCRIPT, valueZat: 7, height: 199 },
      { address: "smOther", txid: txid("3"), vout: 0, script: SCRIPT, valueZat: 1, height: 10 },
    ];
    const got = await lwd.getAddressUtxos([ADDR]);
    expect(got).toEqual([
      { address: ADDR, txid: "01" + "00".repeat(31), vout: 1, scriptPubKey: T.hexToBytes(SCRIPT), value: 123_456n, height: 150 },
      expect.objectContaining({ txid: txid("2"), value: 7n }),
    ]);
    expect((await lwd.getAddressUtxos([ADDR], 160)).map((u) => u.txid)).toEqual([txid("2")]);
    expect(await lwd.getTaddressBalance([ADDR])).toBe(123_463n);
  });

  it("GetTransaction: a mined tx has its height; a mempool tx (0, or -1 as uint64) has none; an unknown one is undefined", async () => {
    s.txs.set(txid("4"), { hex: "abcd", height: 120 });
    s.txs.set(txid("5"), { hex: "ef", height: 0 });
    s.txs.set(txid("6"), { hex: "01", height: -1 });
    expect(await lwd.getTransaction(txid("4"))).toEqual({ hex: "abcd", height: 120 });
    expect(await lwd.getTransaction(txid("5"))).toEqual({ hex: "ef", height: undefined });
    expect(await lwd.getTransaction(txid("6"))).toEqual({ hex: "01", height: undefined });
    expect(await lwd.getTransaction(txid("7"))).toBeUndefined();
  });

  it("SendTransaction: the JSON-quoted txid on success; the node's refusal as SendRawTransactionError, classified as over RPC", async () => {
    expect(await lwd.sendTransaction("0400")).toBe("ab".repeat(32));
    expect(s.sent.at(-1)).toBe("0400");
    s.sendReply = { errorCode: -26, errorMessage: "18: txn-mempool-conflict" }; // 6.21.0 (X-F7)
    const v6 = await lwd.sendTransaction("0401").catch((e: unknown) => e);
    expect(v6).toBeInstanceOf(SendRawTransactionError);
    expect(v6).toMatchObject({ code: -26, kind: "mempool-conflict", rejectCode: 18, method: "sendrawtransaction" });
    s.sendReply = { errorCode: -25, errorMessage: "" }; // v4.5.0's silent conflict (X-F7)
    await expect(lwd.sendTransaction("0402")).rejects.toMatchObject({ kind: "mempool-conflict" });
    s.sendReply = { errorCode: -27, errorMessage: "transaction already in block chain" };
    await expect(lwd.sendTransaction("0403")).rejects.toMatchObject({ kind: "already-in-chain" });
    s.sendReply = { errorCode: 0, errorMessage: "not a txid" };
    await expect(lwd.sendTransaction("0404")).rejects.toThrow(/unexpected result/);
    delete s.sendReply;
  });

  it("GetMempoolTx: the listed txids, less the excluded", async () => {
    s.mempool = [txid("a"), txid("b")];
    expect(await lwd.getMempoolTxids()).toEqual([txid("a"), txid("b")]);
    expect(await lwd.getMempoolTxids([txid("a")])).toEqual([txid("b")]);
  });

  it("GetAddressTokens and ValidateRawTransaction (YellowbackStreamer)", async () => {
    s.tokens = [{ txid: txid("c"), vout: 2, cents: 500, valueZat: 10_000, height: 190, address: YED_ADDR, transparentAddress: ADDR }];
    expect(await lwd.getAddressTokens([YED_ADDR])).toEqual([expect.objectContaining({ txid: txid("c"), vout: 2, cents: "500", valueZat: "10000", transparentAddress: ADDR })]);
    expect(await lwd.validateRawTransaction("0400")).toMatchObject({ valid: true, verdict: "ok", yedIn: "500" });
  });

  it("a call past its deadline fails with DEADLINE_EXCEEDED", async () => {
    const slow = new LwdClient({ url: fake.url, deadlineMs: 150 });
    s.hang = true;
    try {
      const e = await slow.getLightdInfo().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LwdError);
      expect((e as LwdError).grpcCode).toBe(4);
    } finally {
      s.hang = false;
      slow.close();
    }
  });

  it("an unreachable server fails with UNAVAILABLE, not a hang", async () => {
    const gone = new LwdClient({ url: "127.0.0.1:1", deadlineMs: 2_000 });
    await expect(gone.getLightdInfo()).rejects.toMatchObject({ grpcCode: 14 });
    gone.close();
  });
});

describe("LwdChain", () => {
  let fake: Awaited<ReturnType<typeof startFakeLwd>>;
  let chain: LwdChain;

  beforeAll(async () => {
    fake = await startFakeLwd({ height: 300 });
    chain = new LwdChain(new LwdClient(fake.url));
  });
  afterAll(async () => {
    chain.lwd.close();
    await fake.stop();
  });

  it("chainState and getBlockchainInfo: tip and the tip's branch id (lightwalletd has no nextblock)", async () => {
    expect(await chain.chainState()).toEqual({ chain: "regtest", height: 300, branchId: 0x19bd2d2f });
    expect(await chain.getBlockchainInfo()).toEqual({ chain: "regtest", blocks: 300, consensus: { chaintip: "19bd2d2f", nextblock: "19bd2d2f" } });
  });

  it("getTxOut: mined and still indexed → depth; mined and gone from the index → null; mempool only with includeMempool; unknown → null", async () => {
    const mined = rawTx([5_000n, 6_000n]);
    fake.state.txs.set(mined.id, { hex: mined.hex, height: 291 });
    fake.state.utxos = [{ address: ADDR, txid: mined.id, vout: 1, script: SCRIPT, valueZat: 6_000, height: 291 }];
    expect(await chain.getTxOut(mined.id, 1, true)).toMatchObject({ confirmations: 10, value: 0.00006, scriptPubKey: { hex: SCRIPT, addresses: [ADDR], type: "pubkeyhash" } });
    expect(await chain.getTxOut(mined.id, 0, false)).toBeNull(); // spent in a block: not in the index
    expect(await chain.getTxOut(mined.id, 2, true)).toBeNull(); // no such output

    const pending = rawTx([7_000n]);
    fake.state.txs.set(pending.id, { hex: pending.hex, height: -1 });
    expect(await chain.getTxOut(pending.id, 0, true)).toMatchObject({ confirmations: 0 });
    expect(await chain.getTxOut(pending.id, 0, false)).toBeNull();
    expect(await chain.getTxOut(txid("d"), 0, true)).toBeNull();
  });

  it("sendRawTransaction broadcasts through SendTransaction; getRawTransaction reads one back", async () => {
    expect(await chain.sendRawTransaction("0400ff")).toBe("ab".repeat(32));
    expect(fake.state.sent).toEqual(["0400ff"]);
    const t = rawTx([1n]);
    fake.state.txs.set(t.id, { hex: t.hex, height: 5 });
    expect(await chain.getRawTransaction(t.id)).toBe(t.hex);
    await expect(chain.getRawTransaction(txid("e"))).rejects.toThrow(/knows no transaction/);
  });
});

describe("LwdUtxoSource", () => {
  let fake: Awaited<ReturnType<typeof startFakeLwd>>;
  let lwd: LwdClient;

  beforeAll(async () => {
    fake = await startFakeLwd({ height: 500 });
    lwd = new LwdClient(fake.url);
  });
  afterAll(async () => {
    lwd.close();
    await fake.stop();
  });

  const utxo = (c: string, value: number, height: number) => ({ address: ADDR, txid: txid(c), vout: 0, script: SCRIPT, valueZat: value, height });

  it("listCoins: confirmed coins with their depth, never a YED-bearing output", async () => {
    fake.state.utxos = [utxo("1", 50_000, 500), utxo("2", 70_000, 451), utxo("3", 10_000, 490)];
    fake.state.tokens = [{ txid: txid("3"), vout: 0, cents: 100, valueZat: 10_000, height: 490, address: YED_ADDR, transparentAddress: ADDR }];
    const src = new LwdUtxoSource(lwd);
    expect(await src.listCoins(ADDR)).toEqual([
      { txid: txid("1"), vout: 0, value: 50_000n, scriptPubKey: T.hexToBytes(SCRIPT), confirmations: 1 },
      { txid: txid("2"), vout: 0, value: 70_000n, scriptPubKey: T.hexToBytes(SCRIPT), confirmations: 50 },
    ]);
    expect(await src.chainState()).toEqual({ chain: "regtest", height: 500, branchId: 0x19bd2d2f });
  });

  it("listTokens: token records with the key's script, cents and value", async () => {
    const src = new LwdUtxoSource(lwd);
    expect(await src.listTokens(YED_ADDR)).toEqual([{ outpoint: { txid: txid("3"), vout: 0 }, cents: 100, value: 10_000n, scriptPubKey: T.hexToBytes(SCRIPT) }]);
  });

  it("the mempool-spend gap is covered by reservations: a reserved coin stays out until its spend's expiry passes", async () => {
    const reservations = new InMemoryCoinReservationStore();
    const src = new LwdUtxoSource(lwd, { reservations });
    expect(await src.reserve([{ txid: txid("2"), vout: 0 }], { txid: txid("f"), expiryHeight: 520 })).toBe(true);
    // A second spend of the same coin (another process sharing the store) is refused.
    expect(await new LwdUtxoSource(lwd, { reservations }).reserve([{ txid: txid("2"), vout: 0 }], { txid: txid("e"), expiryHeight: 520 })).toBe(false);
    expect((await src.listCoins(ADDR)).map((c) => c.txid)).toEqual([txid("1")]);
    // lightwalletd still lists the coin (its index ignores the mempool) …
    expect((await lwd.getAddressUtxos([ADDR])).map((u) => u.txid)).toContain(txid("2"));
    // … and once the spend can no longer be mined (expiry is inclusive, X-F8) the coin is free again.
    fake.state.height = 521;
    expect((await src.listCoins(ADDR)).map((c) => c.txid)).toEqual([txid("1"), txid("2")]);
    expect((await reservations.list()).size).toBe(0);
    fake.state.height = 500;
  });

  it("a server without the YellowbackStreamer: coins listed (no token filter), tokens refused", async () => {
    const plain = await startFakeLwd({ height: 500, yellowback: false, utxos: fake.state.utxos });
    const c = new LwdClient(plain.url);
    try {
      const src = new LwdUtxoSource(c);
      expect(await src.listCoins(ADDR)).toHaveLength(3);
      const e = await src.listTokens(YED_ADDR).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LwdError);
      expect((e as LwdError).unimplemented).toBe(true);
    } finally {
      c.close();
      await plain.stop();
    }
  });

  it("LocalKeySigner over LwdUtxoSource: a signed payment from the listed coins, held so the next one picks another", async () => {
    fake.state.tokens = [];
    fake.state.utxos = [utxo("1", 500_000, 400), utxo("2", 400_000, 400)];
    const src = new LwdUtxoSource(lwd);
    const signer = new exact.LocalKeySigner(T.encodeWif(priv, NET), src);
    const state = await signer.chainState();
    const order = { network: NET, payTo: T.encodeAddress(NET, "p2pkh", T.hash160(T.pubkeyFromPriv(T.hexToBytes("22".repeat(32))))), amount: 100_000n, expiryHeight: state.height + 20, tip: state.height, branchId: state.branchId };
    const a = await signer.signPayment(order);
    const b = await signer.signPayment(order);
    expect(a.inputs).toEqual([{ txid: txid("1"), vout: 0 }]);
    expect(b.inputs).toEqual([{ txid: txid("2"), vout: 0 }]);
    expect(T.parseTx(a.hex).vout[0]).toMatchObject({ value: 100_000n });
  });
});
