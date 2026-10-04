// The exact client: transaction construction (spec "Transaction Construction"), both signer
// backends, coin selection.
import { beforeEach, describe, expect, it } from "vitest";
import { exact } from "../../../src/index.js";
import { RpcError, type SignResult, type UnspentOutput } from "../../../src/node/index.js";
import { addressToScript, bytesToHex, feeFloor, parseTx, sigHashType, parseScript, txid } from "../../../src/tx/index.js";
import { FakeNode, FakeUtxoSource, NETWORK, paymentPayload, requirements, testKey } from "./fakeNode.js";

const payer = testKey(1);
const merchant = testKey(2);
let node: FakeNode;

beforeEach(() => {
  node = new FakeNode();
});

describe("ExactYcashScheme with a LocalKeySigner", () => {
  it("builds the spec's transaction, which the facilitator accepts", async () => {
    node.addCoin(10_000_000n, payer.script);
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    const req = requirements(merchant.address);
    const { x402Version, payload } = await client.createPaymentPayload(2, req);
    expect(x402Version).toBe(2);
    const hex = (payload as { transaction: string }).transaction;
    expect(hex).toMatch(/^[0-9a-f]+$/);
    const tx = parseTx(hex);
    expect(tx.lockTime).toBe(0);
    expect(tx.expiryHeight).toBe(node.tip + 3 + 4); // ⌈300 / 75⌉ = 4
    expect(tx.vout[0]).toEqual({ value: 250_000n, scriptPubKey: addressToScript(merchant.address, NETWORK) });
    expect(tx.vout[1]?.scriptPubKey).toEqual(payer.script);
    expect(10_000_000n - tx.vout.reduce((s, o) => s + o.value, 0n)).toBe(1_000n); // one-input, two-output floor
    expect(sigHashType(parseScript(tx.vin[0]!.scriptSig)[0]!.data!)).toBe(1);
    const f = new exact.ExactYcashFacilitatorScheme(node);
    expect(await f.verify(paymentPayload(req, hex), req)).toEqual({ isValid: true, payer: payer.address });
    expect(node.calls).not.toContain("sendrawtransaction");
  });

  it("counts expiry from maxTimeoutSeconds", async () => {
    node.addCoin(10_000_000n, payer.script);
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    const req = { ...requirements(merchant.address), maxTimeoutSeconds: 76 };
    const { payload } = await client.createPaymentPayload(2, req);
    expect(parseTx((payload as { transaction: string }).transaction).expiryHeight).toBe(node.tip + 3 + 2);
  });

  it("pays the floor of a many-input transaction", async () => {
    for (let i = 0; i < 4; i++) node.addCoin(100_000n, payer.script);
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    const { payload } = await client.createPaymentPayload(2, requirements(merchant.address, "350000"));
    const tx = parseTx((payload as { transaction: string }).transaction);
    expect(tx.vin).toHaveLength(4);
    const fee = 400_000n - tx.vout.reduce((s, o) => s + o.value, 0n);
    expect(fee).toBeGreaterThanOrEqual(feeFloor(tx));
    expect(fee).toBe(2_000n); // 4 inputs = 4 logical actions × 500
  });

  it("folds a sub-dust remainder into the fee", async () => {
    node.addCoin(251_050n, payer.script);
    const signer = new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node));
    const { payload } = await new exact.ExactYcashScheme(signer).createPaymentPayload(2, requirements(merchant.address));
    const tx = parseTx((payload as { transaction: string }).transaction);
    expect(tx.vout).toHaveLength(1);
  });

  it("does not reuse coins of a payment still pending", async () => {
    node.addCoin(1_000_000n, payer.script);
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    await client.createPaymentPayload(2, requirements(merchant.address));
    await expect(client.createPaymentPayload(2, requirements(merchant.address))).rejects.toThrow(/insufficient funds/);
  });

  it("skips unconfirmed coins and reports insufficient funds", async () => {
    node.addCoin(10_000_000n, payer.script, 0);
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    await expect(client.createPaymentPayload(2, requirements(merchant.address))).rejects.toThrow(/insufficient funds/);
  });

  it("refuses requirements the facilitator would reject, before touching the wallet", async () => {
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    await expect(client.createPaymentPayload(2, requirements(merchant.address, "53"))).rejects.toThrow(/dust/);
    await expect(client.createPaymentPayload(2, requirements(merchant.address, "1000", { areFeesSponsored: true }))).rejects.toThrow(/areFeesSponsored/);
    await expect(client.createPaymentPayload(2, requirements(merchant.address, "1000", { assetTransferMethod: "sapling" }))).rejects.toThrow(/reserved/);
    await expect(client.createPaymentPayload(2, { ...requirements(merchant.address), network: "ycash:nonet" })).rejects.toThrow(/network/);
  });

  it("checks the network against its own node", async () => {
    node.chain = "main";
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    await expect(client.createPaymentPayload(2, requirements(merchant.address))).rejects.toThrow(/runs main/);
  });

  it("checks what a pluggable signer returns", async () => {
    node.addCoin(10_000_000n, payer.script);
    const real = new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node));
    const lying: exact.YcashClientSigner = { chainState: () => real.chainState(), signPayment: (o) => real.signPayment({ ...o, amount: o.amount + 1n }) };
    await expect(new exact.ExactYcashScheme(lying).createPaymentPayload(2, requirements(merchant.address))).rejects.toThrow(/exactly amount/);
  });
});

describe("selectCoins", () => {
  const coin = (value: bigint, confirmations = 1) => ({ txid: "aa".repeat(32), vout: Number(value % 100n), value, scriptPubKey: payer.script, confirmations });
  it("takes the largest first", () => {
    const s = exact.selectCoins([coin(1_000n), coin(5_000_000n), coin(300_000n)], 250_000n, merchant.script, payer.script);
    expect(s.coins.map((c) => c.value)).toEqual([5_000_000n]);
    expect(s.fee).toBe(1_000n);
    expect(s.change).toBe(5_000_000n - 251_000n);
  });
  it("adds coins until amount and fee are covered", () => {
    const s = exact.selectCoins([coin(200_000n), coin(60_000n)], 250_000n, merchant.script, payer.script);
    expect(s.coins).toHaveLength(2);
    expect(s.change).toBe(9_000n);
  });
});

/** A scripted wallet RPC for the RPC signer. */
class FakeWallet {
  calls: [string, unknown[]][] = [];
  unspent: UnspentOutput[] = [];
  spentInMempool = new Set<string>();
  yedCoins: { txid: string; vout: number }[] = [];
  yellowback = false;
  signResults: SignResult[] = [];
  async getBlockchainInfo() {
    return { chain: "regtest", blocks: 300, headers: 300, bestblockhash: "", consensus: { chaintip: "19bd2d2f", nextblock: "19bd2d2f" }, upgrades: {} };
  }
  async listUnspent() {
    return this.unspent;
  }
  async getTxOut(t: string, n: number) {
    return this.spentInMempool.has(`${t}:${n}`) ? null : ({} as never);
  }
  async createRawTransaction(inputs: unknown, outputs: unknown, lockTime: number, expiry?: number) {
    this.calls.push(["createrawtransaction", [inputs, outputs, lockTime, expiry]]);
    return "unsigned";
  }
  async signRawTransactionWithWallet() {
    return this.signResults.shift() as SignResult;
  }
  async capabilities() {
    return { line: "v4" as const, subversion: "", version: 0, yellowback: this.yellowback, chain: "regtest" };
  }
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push([method, params]);
    if (method === "getrawchangeaddress") return testKey(5).address as T;
    if (method === "yed_listunspent") return this.yedCoins as T;
    return null as T;
  }
}

const utxo = (txid: string, zat: number): UnspentOutput => ({ txid, vout: 0, scriptPubKey: bytesToHex(payer.script), amount: zat / 1e8, amountZat: zat, confirmations: 3, spendable: true });

describe("RpcWalletSigner", () => {
  const signedHex = () => {
    // any valid v4 tx: the signer only re-hashes it
    const n = new FakeNode();
    n.addCoin(10_000_000n, payer.script);
    return new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(n)).signPayment({ network: NETWORK, payTo: merchant.address, amount: 1000n, expiryHeight: 307, tip: 300, branchId: 0x19bd2d2f });
  };

  it("locks its inputs and builds with the expiry", async () => {
    const w = new FakeWallet();
    w.unspent = [utxo("11".repeat(32), 10_000_000)];
    const hex = (await signedHex()).hex;
    w.signResults = [{ hex, complete: true }];
    const r = await new exact.RpcWalletSigner(w).signPayment({ network: NETWORK, payTo: merchant.address, amount: 250_000n, expiryHeight: 307, tip: 300, branchId: 0 });
    expect(r.txid).toBe(txid(hex));
    expect(w.calls.find((c) => c[0] === "lockunspent")?.[1]).toEqual([false, [{ txid: "11".repeat(32), vout: 0 }]]);
    const create = w.calls.find((c) => c[0] === "createrawtransaction")?.[1];
    expect(create?.[2]).toBe(0);
    expect(create?.[3]).toBe(307);
    expect(create?.[1]).toEqual({ [merchant.address]: 250_000n, [testKey(5).address]: 10_000_000n - 251_000n });
  });

  it("skips YED-bearing coins on a Yellowback node", async () => {
    const w = new FakeWallet();
    w.yellowback = true;
    w.unspent = [utxo("22".repeat(32), 50_000_000), utxo("33".repeat(32), 10_000_000)];
    w.yedCoins = [{ txid: "22".repeat(32), vout: 0 }];
    w.signResults = [{ hex: (await signedHex()).hex, complete: true }];
    const r = await new exact.RpcWalletSigner(w).signPayment({ network: NETWORK, payTo: merchant.address, amount: 250_000n, expiryHeight: 307, tip: 300, branchId: 0 });
    expect(r.inputs).toEqual([{ txid: "33".repeat(32), vout: 0 }]);
  });

  it("retries without a just-spent coin (X-F13)", async () => {
    const w = new FakeWallet();
    const a = "44".repeat(32);
    const b = "55".repeat(32);
    w.unspent = [utxo(a, 50_000_000), utxo(b, 10_000_000)];
    w.signResults = [{ hex: "", complete: false, errors: [{ txid: a, vout: 0, scriptSig: "", sequence: 0, error: "Input not found or already spent" }] }, { hex: (await signedHex()).hex, complete: true }];
    const r = await new exact.RpcWalletSigner(w).signPayment({ network: NETWORK, payTo: merchant.address, amount: 250_000n, expiryHeight: 307, tip: 300, branchId: 0 });
    expect(r.inputs).toEqual([{ txid: b, vout: 0 }]);
    expect(w.calls.filter((c) => c[0] === "lockunspent").map((c) => (c[1] as unknown[])[0])).toEqual([false, true, false]);
  });

  it("skips a coin the mempool already spends", async () => {
    const w = new FakeWallet();
    w.unspent = [utxo("66".repeat(32), 50_000_000), utxo("77".repeat(32), 10_000_000)];
    w.spentInMempool.add(`${"66".repeat(32)}:0`);
    w.signResults = [{ hex: (await signedHex()).hex, complete: true }];
    const r = await new exact.RpcWalletSigner(w).signPayment({ network: NETWORK, payTo: merchant.address, amount: 250_000n, expiryHeight: 307, tip: 300, branchId: 0 });
    expect(r.inputs).toEqual([{ txid: "77".repeat(32), vout: 0 }]);
  });

  it("gives up after its retries", async () => {
    const w = new FakeWallet();
    w.unspent = [utxo("88".repeat(32), 50_000_000)];
    w.signResults = Array.from({ length: 5 }, () => ({ hex: "", complete: false, errors: [] }));
    await expect(new exact.RpcWalletSigner(w, { retries: 1 }).signPayment({ network: NETWORK, payTo: merchant.address, amount: 250_000n, expiryHeight: 307, tip: 300, branchId: 0 })).rejects.toThrow(/incomplete/);
  });
});

describe("RpcUtxoSource", () => {
  it("lists confirmed coins, skips mempool-spent and YED-bearing ones, imports watch-only once", async () => {
    const w = new FakeWallet();
    w.yellowback = true;
    w.unspent = [utxo("aa".repeat(32), 1_000), utxo("bb".repeat(32), 2_000), utxo("cc".repeat(32), 3_000)];
    w.spentInMempool.add(`${"bb".repeat(32)}:0`);
    const tokenRows = [{ txid: "cc".repeat(32), vout: 0 }];
    const rpc = { ...w, getBlockchainInfo: () => w.getBlockchainInfo(), listUnspent: () => w.listUnspent(), getTxOut: (t: string, n: number) => w.getTxOut(t, n), capabilities: () => w.capabilities(),
      call: async <T,>(m: string, p: unknown[] = []): Promise<T> => (w.calls.push([m, p]), (m === "yed_listtokens" ? tokenRows : null) as T) };
    const src = new exact.RpcUtxoSource(rpc, { importAddress: true });
    const coins = await src.listCoins(payer.address);
    expect(coins.map((c) => c.value)).toEqual([1_000n]);
    await src.listCoins(payer.address);
    expect(w.calls.filter((c) => c[0] === "importaddress")).toEqual([["importaddress", [payer.address, "", false]]]);
    expect((await src.chainState()).branchId).toBe(0x19bd2d2f);
  });
  it("treats a node without yed_listtokens as stock", async () => {
    const w = new FakeWallet();
    w.yellowback = true;
    w.unspent = [utxo("aa".repeat(32), 1_000)];
    const rpc = { getBlockchainInfo: () => w.getBlockchainInfo(), listUnspent: () => w.listUnspent(), getTxOut: (t: string, n: number) => w.getTxOut(t, n), capabilities: () => w.capabilities(),
      call: async <T,>(): Promise<T> => { throw new RpcError(-32601, "Method not found", "yed_listtokens"); } };
    expect(await new exact.RpcUtxoSource(rpc).listCoins(payer.address)).toHaveLength(1);
  });
});

describe("spend controls", () => {
  it("YED is a USD default asset; YEC needs an allowedAssets entry", () => {
    expect(exact.findYcashDefaultAsset("YED", NETWORK)).toEqual({ asset: "YED", decimals: 2, symbol: "YED" });
    expect(exact.findYcashDefaultAsset("YEC", NETWORK)).toBeUndefined();
    expect(exact.yecSpendControl(NETWORK, 500_000n)).toEqual({ network: NETWORK, asset: "YEC", maxAmountPerPayment: "500000" });
  });
});
