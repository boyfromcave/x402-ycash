// The `sapling` facilitator against a fake node: every verification rule of the spec section
// ("sapling", Facilitator verification rules), the settle steps (claim, broadcast once, observe,
// receipt), the duplicate and rejection paths, and the router that puts both shielded methods behind
// the exact scheme's hook. The note ciphertexts are real; proofs and signatures are placeholders the
// fake node accepts, which is exactly what the Rust light client's `build` will replace.
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import * as secp from "@noble/secp256k1";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemorySettlementStore, RpcError, SendRawTransactionError, type BlockchainInfo, type TxOutInfo, type VerifyScriptsResult, type ZReceived } from "../../../src/index.js";
import {
  ERR,
  ERR_SAPLING,
  es256kSigner,
  InMemoryIssuedAddressRegistry,
  memoForRecord,
  memoToHex,
  recordRetainUntil,
  SaplingExactFacilitator,
  SaplingExactServer,
  SaplingHandler,
  ShieldedMethodRouter,
  verifyReceipt,
  type IssuedRequest,
  type JwsSignedArtifact,
  type RequestRecord,
} from "../../../src/shielded/index.js";
import { ExactYcashServerScheme } from "../../../src/exact/index.js";
import { addressOf, buildPaymentTx, NETWORK, OTHER_KEY, TEST_KEY, type PaymentTxSpec } from "./saplingBuild.js";

const NOW = 1_800_000_000;
const RESOURCE = "https://api.example.com/data";
const RECEIPT_KEY = new Uint8Array(32).fill(3);
const AMOUNT = 1_500_000n;
const TIP = 500;
const payTo = addressOf(TEST_KEY, 0n);
const otherAddress = addressOf(TEST_KEY, payTo.index + 1n);

/** A node: chain reads, a UTXO set, sendrawtransaction and the merchant wallet's notes. */
class FakeNode {
  chain = "regtest";
  tip = TIP;
  utxos = new Map<string, TxOutInfo>();
  mempoolSpent = new Set<string>();
  sent: string[] = [];
  sendError: Error | undefined;
  scriptsResult: VerifyScriptsResult = { complete: true, errors: [] };
  scriptCalls = 0;
  /** notes the wallet reports per address, filled by `land` */
  notes = new Map<string, ZReceived[]>();
  /** addresses the viewing-key wallet knows; others answer -5 */
  known = new Set<string>();
  /** when set, a broadcast lands the note at this depth immediately (−1: mempool) */
  landOnSend: number | undefined = -1;
  pendingLand: { address: string; txid: string; zat: bigint; memo: string } | undefined;

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    return { chain: this.chain, blocks: this.tip } as BlockchainInfo;
  }
  async getBlockCount(): Promise<number> {
    return this.tip;
  }
  async getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null> {
    const k = `${txid}:${n}`;
    if (includeMempool && this.mempoolSpent.has(k)) return null;
    return this.utxos.get(k) ?? null;
  }
  async verifyScripts(): Promise<VerifyScriptsResult> {
    this.scriptCalls++;
    return this.scriptsResult;
  }
  async sendRawTransaction(hex: string): Promise<string> {
    if (this.sendError) throw this.sendError;
    this.sent.push(hex);
    if (this.pendingLand && this.landOnSend !== undefined) this.land(this.pendingLand.address, this.pendingLand.txid, this.pendingLand.zat, this.pendingLand.memo, this.landOnSend);
    return this.pendingLand?.txid ?? "00".repeat(32);
  }
  async zListReceivedByAddress(address: string, minconf = 1): Promise<ZReceived[]> {
    expect(minconf).toBe(0);
    if (!this.known.has(address)) throw new RpcError(-5, "From address does not belong to this node, zaddr spending key or viewing key not found.", "z_listreceivedbyaddress");
    return this.notes.get(address) ?? [];
  }
  land(address: string, txid: string, zat: bigint, memo: string, confirmations: number): void {
    this.known.add(address);
    const list = this.notes.get(address) ?? [];
    list.push({ txid, amount: Number(zat) / 1e8, amountZat: Number(zat), memo: memoToHex(memo) + "00".repeat(512 - memo.length), outindex: 0, confirmations: Math.max(confirmations, 0), change: false });
    this.notes.set(address, list);
  }
}

const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  v: 1,
  network: NETWORK,
  asset: "YEC",
  amount: AMOUNT.toString(),
  payTo: payTo.address,
  resource: RESOURCE,
  expiresAt: NOW + 900,
  nonce: "ab".repeat(32),
  ...over,
});

const issuedFor = (rec: RequestRecord, confirmations = -1): IssuedRequest => ({
  record: rec,
  memo: memoForRecord(rec),
  confirmations,
  issuedAt: NOW,
  retainUntil: recordRetainUntil(rec.expiresAt, confirmations, 3600),
});

const requirementsFor = (rec: RequestRecord, extra: Record<string, unknown> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: rec.network,
  asset: "YEC",
  amount: rec.amount,
  payTo: rec.payTo,
  maxTimeoutSeconds: 900,
  extra: { assetTransferMethod: "sapling", areFeesSponsored: false, memo: memoForRecord(rec), expiresAt: rec.expiresAt, confirmationPolicy: { confirmations: -1 }, ...extra },
});

const payloadFor = (req: PaymentRequirements, hex: string, accepted: Partial<PaymentRequirements> = {}): PaymentPayload => ({
  x402Version: 2,
  resource: { url: RESOURCE, description: "", mimeType: "application/json" },
  accepted: { ...req, extra: { ...(req.extra ?? {}) }, ...accepted },
  payload: { transaction: hex },
});

const okTx = (over: Partial<PaymentTxSpec> = {}, memo = memoForRecord(record())) =>
  buildPaymentTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: AMOUNT, memo }], valueBalance: 1000n, expiryHeight: TIP + 10, ...over });

describe("SaplingExactFacilitator", () => {
  let node: FakeNode;
  let registry: InMemoryIssuedAddressRegistry;
  let store: InMemorySettlementStore;
  let f: SaplingExactFacilitator;
  const rec = record();
  const req = requirementsFor(rec);

  beforeEach(async () => {
    node = new FakeNode();
    registry = new InMemoryIssuedAddressRegistry();
    store = new InMemorySettlementStore();
    await registry.issue(rec.payTo, issuedFor(rec));
    f = new SaplingExactFacilitator({ rpc: node, viewingKey: TEST_KEY, network: NETWORK, registry, store, receiptSigner: es256kSigner(RECEIPT_KEY), now: () => NOW, observeWaitMs: 300, observePollMs: 20 });
  });

  it("refuses a viewing key of another network at construction", () => {
    expect(() => new SaplingExactFacilitator({ rpc: node, viewingKey: TEST_KEY, network: "ycash:mainnet", registry, store, receiptSigner: {} as never })).toThrow(/regtest/);
  });

  describe("verify", () => {
    it("accepts a z→z payment to payTo with the memo, the value and a fee at the floor", async () => {
      const { hex } = okTx();
      const r = await f.verify(payloadFor(req, hex), req);
      expect(r).toEqual({ isValid: true, extra: { receivedZat: AMOUNT.toString(), feeZat: "1000" } });
      expect(node.sent).toEqual([]);
      expect(node.scriptCalls).toBe(0); // no transparent inputs: nothing for signrawtransaction to verify
    });
    it("accepts an overpayment", async () => {
      const { hex } = okTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: AMOUNT + 5n, memo: memoForRecord(rec) }] });
      expect((await f.verify(payloadFor(req, hex), req)).isValid).toBe(true);
    });
    it("rule 1: envelope mismatches", async () => {
      const { hex } = okTx();
      expect((await f.verify(payloadFor(req, hex, { amount: "1" }), req)).invalidReason).toBe(ERR.requirementsMismatch);
      expect((await f.verify({ ...payloadFor(req, hex), x402Version: 1 }, req)).invalidReason).toBe(ERR.requirementsMismatch);
      const proof = requirementsFor(rec, { assetTransferMethod: "sapling-proof" });
      expect((await f.verify(payloadFor(proof, hex), proof)).invalidReason).toBe(ERR.assetTransferMethod);
      const upfront = requirementsFor(rec, { paymentFlow: "upfront" });
      expect((await f.verify(payloadFor(upfront, hex), upfront)).invalidReason).toBe(ERR.paymentFlow);
      const noMemo = requirementsFor(rec);
      delete noMemo.extra?.memo;
      expect((await f.verify(payloadFor(noMemo, hex), noMemo)).invalidReason).toBe(ERR.requirementsMismatch);
      const p = payloadFor(req, hex);
      (p.accepted.extra as Record<string, unknown>).expiresAt = rec.expiresAt + 1;
      expect((await f.verify(p, req)).invalidReason).toBe(ERR.requirementsMismatch);
      const mainnet = { ...req, network: "ycash:mainnet" as const };
      expect((await f.verify(payloadFor(mainnet, hex), mainnet)).invalidReason).toBe(ERR.networkMismatch);
    });
    it("rule 2: the node is on another chain", async () => {
      node.chain = "test";
      expect((await f.verify(payloadFor(req, okTx().hex), req)).invalidReason).toBe(ERR.networkMismatch);
    });
    it("rule 3: decoding", async () => {
      expect((await f.verify(payloadFor(req, "zz"), req)).invalidReason).toBe(ERR_SAPLING.transaction);
      expect((await f.verify(payloadFor(req, "0400"), req)).invalidReason).toBe(ERR_SAPLING.transaction);
      const noOutputs = buildPaymentTx({ notes: [], valueBalance: 1000n, expiryHeight: TIP + 10 });
      expect((await f.verify(payloadFor(req, noOutputs.hex), req)).invalidMessage).toMatch(/no Sapling outputs/);
      const locked = okTx({ lockTime: 5 });
      expect((await f.verify(payloadFor(req, locked.hex), req)).invalidMessage).toMatch(/nLockTime/);
      const big = new SaplingExactFacilitator({ rpc: node, viewingKey: TEST_KEY, network: NETWORK, registry, store, receiptSigner: {} as never, limits: { maxTransactionBytes: 100 } });
      expect((await big.verify(payloadFor(req, okTx().hex), req)).invalidMessage).toMatch(/exceeds 100 bytes/);
      const many = new SaplingExactFacilitator({ rpc: node, viewingKey: TEST_KEY, network: NETWORK, registry, store, receiptSigner: {} as never, limits: { maxComponents: 1 } });
      expect((await many.verify(payloadFor(req, okTx().hex), req)).invalidMessage).toMatch(/more than 1/);
      const dup = okTx({ spends: 2 });
      dup.tx.shieldedSpends[1]!.nullifier = dup.tx.shieldedSpends[0]!.nullifier;
      const { serializeTxHex } = await import("../../../src/tx/index.js");
      expect((await f.verify(payloadFor(req, serializeTxHex(dup.tx)), req)).invalidMessage).toMatch(/nullifier is repeated/);
    });
    it("rule 4: the instrument", async () => {
      const foreign = record({ payTo: otherAddress.address, nonce: "cd".repeat(32) });
      const r1 = requirementsFor(foreign);
      expect((await f.verify(payloadFor(r1, okTx().hex), r1)).invalidReason).toBe(ERR.unknownInstrument);
      const wrongMemo = requirementsFor(rec, { memo: "x402:" + "00".repeat(32) });
      expect((await f.verify(payloadFor(wrongMemo, okTx().hex), wrongMemo)).invalidReason).toBe(ERR.unknownInstrument);
      const wrongAmount = { ...req, amount: "2" };
      expect((await f.verify(payloadFor(wrongAmount, okTx().hex), wrongAmount)).invalidReason).toBe(ERR.unknownInstrument);
    });
    it("rule 5: exactly one output to payTo under the merchant's key, ZIP 212", async () => {
      const toOther = okTx({ notes: [{ key: OTHER_KEY, index: 0n, value: AMOUNT, memo: memoForRecord(rec) }] });
      expect((await f.verify(payloadFor(req, toOther.hex), req))).toMatchObject({ invalidReason: ERR_SAPLING.output, invalidMessage: /no output decrypts/ });
      const two = okTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: AMOUNT, memo: memoForRecord(rec) }, { key: TEST_KEY, index: otherAddress.index, value: 1n, memo: "" }] });
      expect((await f.verify(payloadFor(req, two.hex), req)).invalidMessage).toMatch(/2 outputs decrypt/);
      const wrongAddress = okTx({ notes: [{ key: TEST_KEY, index: otherAddress.index, value: AMOUNT, memo: memoForRecord(rec) }] });
      expect((await f.verify(payloadFor(req, wrongAddress.hex), req)).invalidMessage).toMatch(/not payTo/);
      const old = okTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: AMOUNT, memo: memoForRecord(rec), leadByte: 0x01, rseed: new Uint8Array(32).fill(1) }] });
      expect((await f.verify(payloadFor(req, old.hex), req)).invalidMessage).toMatch(/ZIP 212/);
      // Another recipient's output alongside the merchant's is fine (change to the payer).
      const withChange = okTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: AMOUNT, memo: memoForRecord(rec) }, { key: OTHER_KEY, index: 0n, value: 7n, memo: "" }] });
      expect((await f.verify(payloadFor(req, withChange.hex), req)).isValid).toBe(true);
    });
    it("rule 6 and 7: value and memo", async () => {
      const under = okTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: AMOUNT - 1n, memo: memoForRecord(rec) }] });
      expect((await f.verify(payloadFor(req, under.hex), req)).invalidReason).toBe(ERR.underpaid);
      const badMemo = okTx({}, "x402:" + "ff".repeat(32));
      expect((await f.verify(payloadFor(req, badMemo.hex), req)).invalidReason).toBe(ERR.memoMismatch);
    });
    it("rule 8: fee floor and cap", async () => {
      expect((await f.verify(payloadFor(req, okTx({ valueBalance: 999n }).hex), req)).invalidReason).toBe(ERR_SAPLING.feeTooLow);
      // Three spends and one output: 3 actions × 500 = 1500.
      expect((await f.verify(payloadFor(req, okTx({ spends: 3, valueBalance: 1000n }).hex), req))).toMatchObject({ invalidReason: ERR_SAPLING.feeTooLow, invalidMessage: /floor 1500/ });
      expect((await f.verify(payloadFor(req, okTx({ spends: 3, valueBalance: 1500n }).hex), req)).isValid).toBe(true);
      expect((await f.verify(payloadFor(req, okTx({ valueBalance: 100_001n }).hex), req)).invalidReason).toBe(ERR_SAPLING.feeTooHigh);
    });
    it("rule 9: transparent inputs are checked like the transparent method's", async () => {
      const prev = "ab".repeat(32);
      // A DER-shaped placeholder signature (0x30 len 0x02 r 0x02 s) ending in SIGHASH_ALL, then a 33-byte pubkey push.
      const der = (hashType: number) => Uint8Array.from([0x30, 0x44, 0x02, 0x20, ...new Uint8Array(32).fill(0x11), 0x02, 0x20, ...new Uint8Array(32).fill(0x22), hashType]);
      const sigAll = Uint8Array.from([0x47, ...der(0x01), 0x21, ...new Uint8Array(0x21).fill(0x02)]);
      const spec: Partial<PaymentTxSpec> = { vin: [{ txid: prev, vout: 0, scriptSig: sigAll }], valueBalance: -AMOUNT, spends: 0 };
      // Unknown input.
      expect((await f.verify(payloadFor(req, okTx(spec).hex), req)).invalidReason).toBe(ERR_SAPLING.inputSpent);
      node.utxos.set(`${prev}:0`, { value: Number(AMOUNT + 1000n) / 1e8, confirmations: 3, scriptPubKey: { hex: "76a914" + "00".repeat(20) + "88ac" } } as TxOutInfo);
      expect((await f.verify(payloadFor(req, okTx(spec).hex), req))).toEqual({ isValid: true, extra: { receivedZat: AMOUNT.toString(), feeZat: "1000" } });
      expect(node.scriptCalls).toBe(1);
      node.mempoolSpent.add(`${prev}:0`);
      expect((await f.verify(payloadFor(req, okTx(spec).hex), req)).invalidMessage).toMatch(/mempool/);
      node.mempoolSpent.clear();
      node.scriptsResult = { complete: false, errors: [{ txid: prev, vout: 0, scriptSig: "", sequence: 0, error: "bad sig" }] };
      expect((await f.verify(payloadFor(req, okTx(spec).hex), req)).invalidReason).toBe(ERR_SAPLING.script);
      node.scriptsResult = { complete: true, errors: [] };
      const sigNone = Uint8Array.from([0x47, ...der(0x02), 0x21, ...new Uint8Array(0x21).fill(0x02)]);
      expect((await f.verify(payloadFor(req, okTx({ ...spec, vin: [{ txid: prev, vout: 0, scriptSig: sigNone }] }).hex), req)).invalidReason).toBe(ERR_SAPLING.sighash);
    });
    it("rule 10: the expiry window", async () => {
      expect((await f.verify(payloadFor(req, okTx({ expiryHeight: 0 }).hex), req)).invalidReason).toBe(ERR_SAPLING.expiry);
      expect((await f.verify(payloadFor(req, okTx({ expiryHeight: TIP + 3 }).hex), req)).invalidReason).toBe(ERR_SAPLING.expiry);
      expect((await f.verify(payloadFor(req, okTx({ expiryHeight: TIP + 4 }).hex), req)).isValid).toBe(true);
      expect((await f.verify(payloadFor(req, okTx({ expiryHeight: TIP + 4 + 12 + 1 }).hex), req)).isValid).toBe(true);
      expect((await f.verify(payloadFor(req, okTx({ expiryHeight: TIP + 4 + 12 + 2 }).hex), req)).invalidReason).toBe(ERR_SAPLING.expiry);
    });
    it("rule 11: a claimed txid is a duplicate", async () => {
      const { hex, txid } = okTx();
      await store.claim(`${NETWORK}:${txid}`, TIP + 100);
      expect((await f.verify(payloadFor(req, hex), req)).invalidReason).toBe(ERR.duplicateSettlement);
    });
  });

  describe("settle", () => {
    it("claims, broadcasts once, observes the note and signs a receipt (policy −1)", async () => {
      const { hex, txid } = okTx();
      node.pendingLand = { address: rec.payTo, txid, zat: AMOUNT, memo: memoForRecord(rec) };
      const r = await f.settle(payloadFor(req, hex), req);
      expect(r).toMatchObject({ success: true, transaction: txid, network: NETWORK, extra: { status: "mempool", confirmations: -1, receivedZat: AMOUNT.toString() } });
      expect(node.sent).toEqual([hex]);
      const receipt = (r.extensions as Record<string, { info: { receipt: JwsSignedArtifact } }>)["offer-receipt"]?.info.receipt as JwsSignedArtifact;
      expect(verifyReceipt(receipt, { trustedPublicKeys: [secp.getPublicKey(RECEIPT_KEY, true)] })).toEqual({ version: 1, network: NETWORK, resourceUrl: RESOURCE, payer: "anonymous", issuedAt: NOW, transaction: txid });
      // A second settle of the same payload resumes observing: no second broadcast, same answer.
      const again = await f.settle(payloadFor(req, hex), req);
      expect(again.success).toBe(true);
      expect(node.sent).toHaveLength(1);
    });
    it("answers settlement_pending below the policy depth, then success on retry once mined", async () => {
      const conf = record({ nonce: "ee".repeat(32), payTo: otherAddress.address });
      await registry.issue(conf.payTo, issuedFor(conf, 1));
      const creq = requirementsFor(conf, { confirmationPolicy: { confirmations: 1 } });
      const { hex, txid } = okTx({ notes: [{ key: TEST_KEY, index: otherAddress.index, value: AMOUNT, memo: memoForRecord(conf) }] });
      node.pendingLand = { address: conf.payTo, txid, zat: AMOUNT, memo: memoForRecord(conf) };
      const first = await f.settle(payloadFor(creq, hex), creq);
      expect(first).toMatchObject({ success: false, errorReason: ERR.settlementPending, transaction: txid, extra: { status: "pending", confirmations: -1 } });
      expect(await store.isClaimed(`${NETWORK}:${txid}`)).toBe(true);
      node.notes.get(conf.payTo)![0]!.confirmations = 1;
      const second = await f.settle(payloadFor(creq, hex), creq);
      expect(second).toMatchObject({ success: true, extra: { status: "confirmed", confirmations: 1 } });
      expect(node.sent).toHaveLength(1);
    });
    it("a node rejection releases the claim and is terminal; the reason names the cause", async () => {
      const { hex, txid } = okTx();
      node.sendError = new SendRawTransactionError(new RpcError(-26, "16: bad-txns-sapling-binding-signature-invalid", "sendrawtransaction"));
      const r = await f.settle(payloadFor(req, hex), req);
      expect(r).toMatchObject({ success: false, errorReason: ERR_SAPLING.rejected, transaction: txid });
      expect(await store.isClaimed(`${NETWORK}:${txid}`)).toBe(false);
      node.sendError = new SendRawTransactionError(new RpcError(-26, "18: txn-mempool-conflict", "sendrawtransaction"));
      expect((await f.settle(payloadFor(req, hex), req)).errorReason).toBe(ERR_SAPLING.inputSpent);
      node.sendError = new SendRawTransactionError(new RpcError(-26, "tx-expiring-soon", "sendrawtransaction"));
      expect((await f.settle(payloadFor(req, hex), req)).errorReason).toBe(ERR_SAPLING.expiry);
      // A spent nullifier surfaces here, as the spec declares: the node's reason is relayed.
      node.sendError = new SendRawTransactionError(new RpcError(-26, "16: bad-txns-sapling-duplicate-nullifier", "sendrawtransaction"));
      expect((await f.settle(payloadFor(req, hex), req))).toMatchObject({ errorReason: ERR_SAPLING.rejected, errorMessage: /duplicate-nullifier/ });
    });
    it("a transport failure keeps the claim and observes", async () => {
      const { hex, txid } = okTx();
      node.sendError = new RpcError(0, "ECONNRESET", "sendrawtransaction", { transport: true } as never);
      const r = await f.settle(payloadFor(req, hex), req);
      expect(r).toMatchObject({ success: false, errorReason: ERR.settlementPending, transaction: txid });
      expect(await store.isClaimed(`${NETWORK}:${txid}`)).toBe(true);
    });
    it("past nExpiryHeight with no note, the payment can never land", async () => {
      const { hex, txid } = okTx();
      node.landOnSend = undefined;
      node.pendingLand = { address: rec.payTo, txid, zat: AMOUNT, memo: memoForRecord(rec) };
      node.known.add(rec.payTo);
      const r1 = await f.settle(payloadFor(req, hex), req);
      expect(r1.errorReason).toBe(ERR.settlementPending);
      node.tip = TIP + 11;
      const r2 = await f.settle(payloadFor(req, hex), req);
      expect(r2).toMatchObject({ success: false, errorReason: ERR_SAPLING.expiry, transaction: txid });
    });
    it("a verify failure settles nothing", async () => {
      const r = await f.settle(payloadFor(req, okTx({ valueBalance: 1n }).hex), req);
      expect(r).toMatchObject({ success: false, errorReason: ERR_SAPLING.feeTooLow });
      expect(node.sent).toEqual([]);
    });
  });
});

describe("SaplingExactServer and SaplingHandler", () => {
  const wallet = {
    chain: "regtest",
    async zGetNewAddress() {
      return "yregtestsapling1base";
    },
    async zGetNewDiversifiedAddress() {
      return payTo.address;
    },
    async yedGetPrice() {
      return { height: 10, pMid: 300_000, pFast: null, pSlow: null } as never;
    },
  };
  it("issues the same instrument as sapling-proof, as the sapling method (authorization)", async () => {
    const s = new SaplingExactServer({ rpc: wallet as never, now: () => NOW });
    const out = await s.enhanceRequirements({ scheme: "exact", network: NETWORK, asset: "YEC", amount: AMOUNT.toString(), payTo: "", maxTimeoutSeconds: 900, extra: { assetTransferMethod: "sapling" } }, RESOURCE);
    expect(out.payTo).toBe(payTo.address);
    expect(out.extra).toMatchObject({ assetTransferMethod: "sapling", areFeesSponsored: false, expiresAt: NOW + 900, confirmationPolicy: { confirmations: 1 } });
    expect(out.extra?.paymentFlow).toBeUndefined();
    expect(out.extra?.memo).toBe(memoForRecord((await s.registry.get(payTo.address))!.record));
    await expect(s.enhanceRequirements({ scheme: "exact", network: NETWORK, asset: "YEC", amount: "1", payTo: "", maxTimeoutSeconds: 900, extra: { assetTransferMethod: "sapling-proof" } }, RESOURCE)).rejects.toThrow(/not sapling/);
    await expect(s.enhanceRequirements({ scheme: "exact", network: NETWORK, asset: "YEC", amount: "1", payTo: "", maxTimeoutSeconds: 900, extra: { assetTransferMethod: "sapling", paymentFlow: "upfront" } }, RESOURCE)).rejects.toThrow(/authorization/);
  });
  it("the handler issues, verifies and settles end to end with a fake node", async () => {
    const node = new FakeNode();
    const rpc = Object.assign(node, wallet);
    const h = new SaplingHandler({ network: NETWORK, rpc: rpc as never, viewingKey: TEST_KEY, settlementStore: new InMemorySettlementStore(), receiptKey: RECEIPT_KEY, now: () => NOW, observeWaitMs: 200, observePollMs: 20 });
    const req = await h.enhanceRequirements({ scheme: "exact", network: NETWORK, asset: "YEC", amount: AMOUNT.toString(), payTo: "", maxTimeoutSeconds: 900, extra: { assetTransferMethod: "sapling", confirmationPolicy: { confirmations: -1 } } }, RESOURCE);
    const { hex, txid } = buildPaymentTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: AMOUNT, memo: req.extra?.memo as string }], valueBalance: 1000n, expiryHeight: TIP + 10 });
    expect((await h.verify(payloadFor(req, hex), req)).isValid).toBe(true);
    node.pendingLand = { address: payTo.address, txid, zat: AMOUNT, memo: req.extra?.memo as string };
    expect(await h.settle(payloadFor(req, hex), req)).toMatchObject({ success: true, transaction: txid });
    const mainnet = { ...req, network: "ycash:mainnet" as const };
    expect((await h.verify(payloadFor(mainnet, hex), mainnet)).invalidReason).toBe("network_mismatch");
    expect((await h.settle(payloadFor(mainnet, hex), mainnet)).errorReason).toBe("network_mismatch");
    expect(() => new SaplingHandler({ network: NETWORK, rpc: rpc as never, viewingKey: TEST_KEY, settlementStore: new InMemorySettlementStore(), receiptKey: RECEIPT_KEY, capabilities: { chain: "main" } as never })).toThrow(/main/);
  });
});

describe("ShieldedMethodRouter", () => {
  const stub = (name: string) => ({
    async enhanceRequirements(r: PaymentRequirements) {
      return { ...r, payTo: name };
    },
    async verify() {
      return { isValid: true, extra: { by: name } };
    },
    async settle() {
      return { success: true, transaction: name, network: NETWORK };
    },
  });
  const req = (method: string): PaymentRequirements => ({ scheme: "exact", network: NETWORK, asset: "YEC", amount: "1", payTo: "", maxTimeoutSeconds: 1, extra: { assetTransferMethod: method } });
  const payload = { x402Version: 2, resource: { url: RESOURCE, description: "", mimeType: "" }, accepted: req("sapling"), payload: {} } as PaymentPayload;

  it("dispatches by method and advertises each method's flow", async () => {
    const proof = { ...stub("proof"), verify: undefined };
    const router = new ShieldedMethodRouter({ "sapling-proof": proof, sapling: stub("sapling") });
    expect(router.methods).toEqual(["sapling-proof", "sapling"]);
    expect(router.flows).toEqual({ "sapling-proof": "upfront", sapling: "authorization" });
    expect((await router.enhanceRequirements(req("sapling"), RESOURCE)).payTo).toBe("sapling");
    expect((await router.enhanceRequirements(req("sapling-proof"), RESOURCE)).payTo).toBe("proof");
    expect(await router.verify(payload, req("sapling"))).toEqual({ isValid: true, extra: { by: "sapling" } });
    expect((await router.verify(payload, req("sapling-proof"))).invalidReason).toBe(ERR.paymentFlow);
    expect((await router.settle(payload, req("sapling-proof"))).transaction).toBe("proof");
    expect((await router.settle(payload, req("transparent"))).errorReason).toBe(ERR.assetTransferMethod);
    await expect(router.enhanceRequirements(req("transparent"), RESOURCE)).rejects.toThrow(/not a shielded method/);
  });
  it("a method without a handler is refused", async () => {
    const router = new ShieldedMethodRouter({ sapling: stub("sapling") });
    expect(router.methods).toEqual(["sapling"]);
    expect((await router.verify(payload, req("sapling-proof"))).invalidMessage).toMatch(/not configured/);
    expect((await router.settle(payload, req("sapling-proof"))).errorReason).toBe(ERR.assetTransferMethod);
  });
  it("the exact server scheme advertises the router's flows", () => {
    const router = new ShieldedMethodRouter({ "sapling-proof": stub("p"), sapling: stub("s") });
    const scheme = new ExactYcashServerScheme({ shielded: router as never });
    expect(scheme.paymentFlows).toEqual({
      transparent: { supported: ["authorization"], default: "authorization" },
      "sapling-proof": { supported: ["upfront"], default: "upfront" },
      sapling: { supported: ["authorization"], default: "authorization" },
    });
    const legacy = new ExactYcashServerScheme({ shielded: stub("p") as never });
    expect(Object.keys(legacy.paymentFlows)).toEqual(["transparent", "sapling-proof"]);
  });
});
