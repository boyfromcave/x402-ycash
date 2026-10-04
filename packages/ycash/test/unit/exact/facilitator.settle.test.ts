// Settlement (spec "Settlement", "Duplicate Settlement Mitigation"): claim, broadcast once,
// observe the payTo outpoint, pending without rebroadcast, release only on a certain rejection.
import { beforeEach, describe, expect, it } from "vitest";
import { exact } from "../../../src/index.js";
import { RpcError } from "../../../src/node/index.js";
import { InMemorySettlementStore, txidKey } from "../../../src/store/index.js";
import { txid } from "../../../src/tx/index.js";
import { buildSigned, standardPayment } from "./build.js";
import { FakeNode, NETWORK, paymentPayload, requirements, testKey } from "./fakeNode.js";

const payer = testKey(1);
const merchant = testKey(2);

let node: FakeNode;
let store: InMemorySettlementStore;
let facilitator: exact.ExactYcashFacilitatorScheme;

beforeEach(() => {
  node = new FakeNode();
  store = new InMemorySettlementStore();
  facilitator = new exact.ExactYcashFacilitatorScheme(node, { settlementStore: store, confirmationTimeoutMs: 60, confirmationPollMs: 10 });
});

const sends = () => node.calls.filter((c) => c === "sendrawtransaction").length;
const policy = (confirmations: number) => requirements(merchant.address, "250000", { confirmationPolicy: { confirmations } });

describe("settle", () => {
  it("-1: succeeds on the facilitator's own mempool acceptance", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(-1);
    const r = await facilitator.settle(paymentPayload(req, hex), req);
    expect(r).toEqual({ success: true, transaction: txid(hex), network: NETWORK, payer: payer.address, extra: { status: "mempool", confirmations: -1 } });
    expect(sends()).toBe(1);
    expect(await store.isClaimed(txidKey(NETWORK, txid(hex)))).toBe(true);
  });

  it("0 and 1: wait for a block; pending carries the txid; the retry never rebroadcasts", async () => {
    for (const c of [0, 1]) {
      node = new FakeNode();
      facilitator = new exact.ExactYcashFacilitatorScheme(node, { settlementStore: store, confirmationTimeoutMs: 60, confirmationPollMs: 10 });
      const { hex } = standardPayment(node, payer, merchant.address);
      const req = policy(c);
      const first = await facilitator.settle(paymentPayload(req, hex), req);
      expect(first).toMatchObject({ success: false, errorReason: exact.ERR_SETTLEMENT_PENDING, transaction: txid(hex), extra: { status: "pending", confirmations: -1 } });
      node.mine();
      const retry = await facilitator.settle(paymentPayload(req, hex), req);
      expect(retry).toMatchObject({ success: true, transaction: txid(hex), payer: payer.address, extra: { status: "confirmed", confirmations: 1 } });
      expect(sends()).toBe(1);
    }
  });

  it("N: reports the actual depth", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(3);
    expect((await facilitator.settle(paymentPayload(req, hex), req)).errorReason).toBe(exact.ERR_SETTLEMENT_PENDING);
    node.mine(4);
    expect((await facilitator.settle(paymentPayload(req, hex), req)).extra).toEqual({ status: "confirmed", confirmations: 4 });
  });

  it("observes while it waits: a block found during the wait settles the first call", async () => {
    facilitator = new exact.ExactYcashFacilitatorScheme(node, { settlementStore: store, confirmationTimeoutMs: 2_000, confirmationPollMs: 10 });
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(1);
    setTimeout(() => node.mine(), 50);
    expect((await facilitator.settle(paymentPayload(req, hex), req)).success).toBe(true);
  });

  it("re-runs verification: a payment whose input was spent after verify fails, unclaimed", async () => {
    const { hex, coin } = standardPayment(node, payer, merchant.address);
    const req = policy(-1);
    expect((await facilitator.verify(paymentPayload(req, hex), req)).isValid).toBe(true);
    node.acceptToMempool(buildSigned({ coins: [{ ...coin, value: 10_000_000n, script: payer.script }], priv: payer.priv, outputs: [{ value: 9_990_000n, scriptPubKey: payer.script }], expiryHeight: node.tip + 10 }));
    const r = await facilitator.settle(paymentPayload(req, hex), req);
    expect(r).toMatchObject({ success: false, errorReason: exact.ERR_INPUT_SPENT });
    expect(sends()).toBe(0);
    expect(await store.isClaimed(txidKey(NETWORK, txid(hex)))).toBe(false);
  });

  it("a certain rejection by the node releases the claim", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(-1);
    node.sendError = node.sendErrorOf(-26, "18: txn-mempool-conflict");
    expect(await facilitator.settle(paymentPayload(req, hex), req)).toMatchObject({ success: false, errorReason: exact.ERR_INPUT_SPENT });
    expect(await store.isClaimed(txidKey(NETWORK, txid(hex)))).toBe(false);
    node.sendError = node.sendErrorOf(-26, "tx-expiring-soon");
    expect(await facilitator.settle(paymentPayload(req, hex), req)).toMatchObject({ errorReason: exact.ERR_EXPIRY });
    node.sendError = node.sendErrorOf(-26, "16: mandatory-script-verify-flag-failed");
    expect(await facilitator.settle(paymentPayload(req, hex), req)).toMatchObject({ errorReason: exact.ERR_TRANSACTION });
    expect(await store.isClaimed(txidKey(NETWORK, txid(hex)))).toBe(false);
  });

  it("v4.5.0's empty -25 conflict maps to input_spent too (X-F7)", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(-1);
    node.sendError = node.sendErrorOf(-25, "");
    expect(await facilitator.settle(paymentPayload(req, hex), req)).toMatchObject({ errorReason: exact.ERR_INPUT_SPENT });
  });

  it("-27 (already mined) continues to observation", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(1);
    await node.sendRawTransaction(hex);
    node.mine();
    // simulate a facilitator that lost its store: the inputs are spent, so verify fails first
    expect((await facilitator.settle(paymentPayload(req, hex), req)).errorReason).toBe(exact.ERR_INPUT_SPENT);
    // with the tx in the mempool only, a -27 from the node is "on its way"
    node = new FakeNode();
    facilitator = new exact.ExactYcashFacilitatorScheme(node, { settlementStore: new InMemorySettlementStore(), confirmationTimeoutMs: 60, confirmationPollMs: 10 });
    const p2 = standardPayment(node, payer, merchant.address);
    node.sendError = node.sendErrorOf(-27, "transaction already in block chain");
    const r = await facilitator.settle(paymentPayload(policy(-1), p2.hex), policy(-1));
    expect(r).toMatchObject({ success: false, errorReason: exact.ERR_SETTLEMENT_PENDING });
  });

  it("a transport failure keeps the claim and never rebroadcasts", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(-1);
    node.sendError = new RpcError(0, "socket hang up", "sendrawtransaction", { transport: true });
    expect((await facilitator.settle(paymentPayload(req, hex), req)).errorReason).toBe(exact.ERR_SETTLEMENT_PENDING);
    expect(await store.isClaimed(txidKey(NETWORK, txid(hex)))).toBe(true);
    await node.sendRawTransaction(hex); // it had in fact reached the node
    const before = sends();
    expect((await facilitator.settle(paymentPayload(req, hex), req)).success).toBe(true);
    expect(sends()).toBe(before);
  });

  it("someone else relayed the payload first: a conflict error is not a failure", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(-1);
    node.acceptToMempool(hex);
    // verify sees the inputs spent in the mempool by this very tx: rule 6 refuses before any claim
    expect((await facilitator.settle(paymentPayload(req, hex), req)).errorReason).toBe(exact.ERR_INPUT_SPENT);
  });

  it("concurrent settles broadcast once and both report the outcome", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(-1);
    const [a, b] = await Promise.all([facilitator.settle(paymentPayload(req, hex), req), facilitator.settle(paymentPayload(req, hex), req)]);
    expect(sends()).toBe(1);
    expect([a.success, b.success]).toEqual([true, true]);
  });

  it("after expiry, an unmined claimed tx is a terminal expiry failure", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const req = policy(1);
    await store.claim(txidKey(NETWORK, txid(hex)), 1000); // claimed, never broadcast (a crash)
    node.tip += 20;
    expect(await facilitator.settle(paymentPayload(req, hex), req)).toMatchObject({ success: false, errorReason: exact.ERR_EXPIRY, transaction: txid(hex) });
    expect(sends()).toBe(0);
  });

  it("an invalid payload fails before anything else", async () => {
    const req = policy(-1);
    expect(await facilitator.settle(paymentPayload(req, "00"), req)).toMatchObject({ success: false, errorReason: exact.ERR_TRANSACTION, transaction: "" });
    expect(node.calls).toEqual([]);
  });
});

describe("getExtra and getSigners", () => {
  it("advertises transparent YEC, no sponsorship, and the confirmation range", () => {
    expect(facilitator.getExtra(NETWORK)).toEqual({ assets: ["YEC"], assetTransferMethods: ["transparent"], areFeesSponsored: false, confirmations: { minimum: -1, maximum: 20 } });
    expect(new exact.ExactYcashFacilitatorScheme(node, { acceptMempool: false }).getExtra(NETWORK)?.confirmations).toEqual({ minimum: 0, maximum: 20 });
    expect(facilitator.getSigners(NETWORK)).toEqual([]);
    expect(facilitator.caipFamily).toBe("ycash:*");
  });
});

describe("sapling-proof dispatch (plan X4a hook)", () => {
  const shieldedReq = () => requirements("yregtestsapling1xyz", "1500000", { assetTransferMethod: "sapling-proof", paymentFlow: "upfront" });
  it("routes verify and settle to the injected handler", async () => {
    const seen: string[] = [];
    const shielded: exact.ShieldedExactHandler = {
      enhanceRequirements: async (r) => r,
      verify: async () => (seen.push("verify"), { isValid: true, payer: "" }),
      settle: async (_p, r) => (seen.push("settle"), { success: true, transaction: "ab".repeat(32), network: r.network }),
    };
    facilitator = new exact.ExactYcashFacilitatorScheme(node, { shielded });
    const req = shieldedReq();
    const p = { x402Version: 2, accepted: req, payload: { txid: "ab".repeat(32) } };
    expect((await facilitator.verify(p, req)).isValid).toBe(true);
    expect((await facilitator.settle(p, req)).success).toBe(true);
    expect(seen).toEqual(["verify", "settle"]);
    expect(facilitator.getExtra(NETWORK)?.assetTransferMethods).toEqual(["transparent", "sapling-proof"]);
    expect(node.calls).toEqual([]);
  });
  it("without a handler, sapling-proof is an unknown method", async () => {
    const req = shieldedReq();
    const p = { x402Version: 2, accepted: req, payload: { txid: "ab".repeat(32) } };
    expect((await facilitator.verify(p, req)).invalidReason).toBe(exact.ERR_ASSET_TRANSFER_METHOD);
    expect((await facilitator.settle(p, req)).errorReason).toBe(exact.ERR_ASSET_TRANSFER_METHOD);
  });
  it("a handler without verify answers with the flow error", async () => {
    facilitator = new exact.ExactYcashFacilitatorScheme(node, { shielded: { enhanceRequirements: async (r) => r, settle: async (_p, r) => ({ success: true, transaction: "", network: r.network }) } });
    const req = shieldedReq();
    expect((await facilitator.verify({ x402Version: 2, accepted: req, payload: {} }, req)).invalidReason).toBe(exact.ERR_PAYMENT_FLOW);
  });
});
