// Verification rules 1–10 (specs/scheme_exact_ycash.md): one failing case per rule and reason,
// against an in-memory node.
import { beforeEach, describe, expect, it } from "vitest";
import { exact } from "../../../src/index.js";
import { InMemorySettlementStore, txidKey } from "../../../src/store/index.js";
import { addressToScript, encodeAddress, hash160, hexToBytes, parseTx, pubkeyFromPriv, serializeTxHex, SIGHASH, txid } from "../../../src/tx/index.js";
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
  facilitator = new exact.ExactYcashFacilitatorScheme(node, { settlementStore: store });
});

async function verify(hex: string, req = requirements(merchant.address), mutate?: (p: ReturnType<typeof paymentPayload>) => void) {
  const p = paymentPayload(req, hex);
  mutate?.(p);
  return facilitator.verify(p, req);
}

describe("verify: a well-formed payment", () => {
  it("is valid and names the payer of input 0", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const r = await verify(hex);
    expect(r).toEqual({ isValid: true, payer: payer.address });
  });
  it("is read-only: no broadcast, no claim", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    await verify(hex);
    expect(node.calls).not.toContain("sendrawtransaction");
    expect(await store.isClaimed(txidKey(NETWORK, txid(hex)))).toBe(false);
  });
});

describe("rule 1: envelope and requirement forms", () => {
  let hex: string;
  beforeEach(() => {
    hex = standardPayment(node, payer, merchant.address).hex;
  });
  const reason = async (r: Promise<{ invalidReason?: string }>) => (await r).invalidReason;

  it("x402Version must be 2", async () => {
    expect(await reason(verify(hex, undefined, (p) => (p.x402Version = 1)))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
  });
  it.each(["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"] as const)("accepted.%s must equal the requirements", async (f) => {
    const alt: Record<string, unknown> = { scheme: "upto", network: "ycash:mainnet", asset: "YED", amount: "1", payTo: payer.address, maxTimeoutSeconds: 60 };
    expect(await reason(verify(hex, undefined, (p) => ((p.accepted as Record<string, unknown>)[f] = alt[f])))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
  });
  it("every server-declared extra field must match", async () => {
    expect(await reason(verify(hex, undefined, (p) => (p.accepted.extra.confirmationPolicy = { confirmations: 1 })))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
  });
  it("an omitted method resolves to transparent on both sides", async () => {
    const req = requirements(merchant.address);
    delete req.extra.assetTransferMethod;
    expect((await verify(hex, req)).isValid).toBe(true);
    expect(await reason(verify(hex, req, (p) => (p.accepted.extra.assetTransferMethod = "sapling-proof")))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
  });
  it("sapling (reserved) and unknown methods are refused", async () => {
    expect(await reason(verify(hex, requirements(merchant.address, "250000", { assetTransferMethod: "sapling" })))).toBe(exact.ERR_ASSET_TRANSFER_METHOD);
    expect(await reason(verify(hex, requirements(merchant.address, "250000", { assetTransferMethod: "lightning" })))).toBe(exact.ERR_ASSET_TRANSFER_METHOD);
  });
  it("paymentFlow must be absent or authorization", async () => {
    expect(await reason(verify(hex, requirements(merchant.address, "250000", { paymentFlow: "upfront" })))).toBe(exact.ERR_PAYMENT_FLOW);
    expect((await verify(hex, requirements(merchant.address, "250000", { paymentFlow: "authorization" }))).isValid).toBe(true);
  });
  it("areFeesSponsored must be false", async () => {
    expect(await reason(verify(hex, requirements(merchant.address, "250000", { areFeesSponsored: true })))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
  });
  it("the confirmation policy is a closed object with an integer in [-1, 20]", async () => {
    for (const confirmationPolicy of [{ confirmations: 21 }, { confirmations: 0.5 }, { l1Confirmations: 1 }, { confirmations: 1, x: 1 }]) {
      expect(await reason(verify(hex, requirements(merchant.address, "250000", { confirmationPolicy })))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
    }
  });
  it("-1 needs the operator's opt-in", async () => {
    facilitator = new exact.ExactYcashFacilitatorScheme(node, { acceptMempool: false });
    expect(await reason(verify(hex))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
  });
  it("YED on a stock node: yed_node_required, before anything else", async () => {
    const req = { ...requirements(encodeAddress(NETWORK, "yed", hash160(pubkeyFromPriv(merchant.priv))), "250"), asset: "YED" };
    expect(await reason(verify(hex, req))).toBe(exact.ERR_YED_NODE_REQUIRED);
  });
  it("amount below dust, non-canonical, or a YED payTo is refused", async () => {
    expect(await reason(verify(hex, requirements(merchant.address, "53")))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
    expect(await reason(verify(hex, requirements(merchant.address, "0250000")))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
    const { encodeAddress, hash160, pubkeyFromPriv } = await import("../../../src/tx/index.js");
    const ye = encodeAddress(NETWORK, "yed", hash160(pubkeyFromPriv(merchant.priv)));
    expect(await reason(verify(hex, requirements(ye)))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
  });
});

describe("rule 2: network", () => {
  it("the node's chain must match", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    node.chain = "main";
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_NETWORK_MISMATCH);
  });
});

describe("rule 3: decoding", () => {
  it("lowercase hex only", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    expect((await verify(hex.toUpperCase())).invalidReason).toBe(exact.ERR_TRANSACTION);
    expect((await verify("zz")).invalidReason).toBe(exact.ERR_TRANSACTION);
  });
  it("no trailing bytes", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    expect((await verify(hex + "00")).invalidReason).toBe(exact.ERR_TRANSACTION);
  });
  it("v4 only", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    expect((await verify("05000080" + hex.slice(8))).invalidReason).toBe(exact.ERR_TRANSACTION);
  });
  it("nLockTime 0", async () => {
    const coin = node.addCoin(10_000_000n, payer.script);
    const hex = buildSigned({
      coins: [{ ...coin, value: 10_000_000n, script: payer.script }], priv: payer.priv, lockTime: 5, expiryHeight: node.tip + 7,
      outputs: [{ value: 250_000n, scriptPubKey: merchant.script }, { value: 10_000_000n - 251_000n, scriptPubKey: payer.script }],
    });
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_TRANSACTION);
  });
  it("no Sapling component", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const tx = parseTx(hex);
    tx.shieldedOutputs.push({
      cv: new Uint8Array(32), cmu: new Uint8Array(32), ephemeralKey: new Uint8Array(32),
      encCiphertext: new Uint8Array(580), outCiphertext: new Uint8Array(80), zkproof: new Uint8Array(192),
    });
    tx.bindingSig = new Uint8Array(64);
    expect((await verify(serializeTxHex(tx))).invalidReason).toBe(exact.ERR_TRANSACTION);
  });
  it("within the size limit", async () => {
    facilitator = new exact.ExactYcashFacilitatorScheme(node, { maxTransactionBytes: 100 });
    const { hex } = standardPayment(node, payer, merchant.address);
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_TRANSACTION);
  });
});

describe("rule 4: recipient and amount", () => {
  it("an output must pay payTo", async () => {
    const { hex } = standardPayment(node, payer, testKey(3).address);
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_RECIPIENT_MISMATCH);
  });
  it("exactly one output pays payTo", async () => {
    const { hex } = standardPayment(node, payer, merchant.address, { extraOutputs: [{ value: 1000n, scriptPubKey: merchant.script }] });
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_RECIPIENT_MISMATCH);
  });
  it("of exactly amount", async () => {
    const { hex } = standardPayment(node, payer, merchant.address, { amount: 250_001n });
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_AMOUNT_MISMATCH);
  });
  it("a P2SH payTo is matched by its script", async () => {
    const { encodeAddress } = await import("../../../src/tx/index.js");
    const p2sh = encodeAddress(NETWORK, "p2sh", new Uint8Array(20).fill(7));
    const { hex } = standardPayment(node, payer, p2sh);
    expect(addressToScript(p2sh, NETWORK)).toHaveLength(23);
    expect((await verify(hex, requirements(p2sh))).isValid).toBe(true);
  });
});

describe("rule 5: signature hash types", () => {
  it("SIGHASH_ALL only", async () => {
    for (const ht of [SIGHASH.NONE, SIGHASH.SINGLE, SIGHASH.ALL | SIGHASH.ANYONECANPAY]) {
      const { hex } = standardPayment(node, payer, merchant.address, { hashType: ht });
      expect((await verify(hex)).invalidReason).toBe(exact.ERR_SIGHASH);
    }
  });
  it("an unsigned input is refused", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const tx = parseTx(hex);
    tx.vin[0]!.scriptSig = hexToBytes("51");
    expect((await verify(serializeTxHex(tx))).invalidReason).toBe(exact.ERR_SIGHASH);
  });
});

describe("rule 6: inputs", () => {
  it("an unknown input", async () => {
    const { hex, coin } = standardPayment(node, payer, merchant.address);
    node.utxos.delete(`${coin.txid}:${coin.vout}`);
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_INPUT_SPENT);
  });
  it("an unconfirmed input", async () => {
    const { hex } = standardPayment(node, payer, merchant.address, { confirmations: 0 });
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_INPUT_SPENT);
  });
  it("an input spent by a mempool transaction", async () => {
    const { hex, coin } = standardPayment(node, payer, merchant.address);
    node.acceptToMempool(
      buildSigned({ coins: [{ ...coin, value: 10_000_000n, script: payer.script }], priv: payer.priv, outputs: [{ value: 9_990_000n, scriptPubKey: payer.script }], expiryHeight: node.tip + 10 }),
    );
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_INPUT_SPENT);
    expect(node.calls.filter((c) => c.startsWith("gettxout"))).toEqual(["gettxout false", "gettxout true"]);
  });
});

describe("rule 7: fee", () => {
  it("below the floor", async () => {
    const { hex } = standardPayment(node, payer, merchant.address, { fee: 999n });
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_FEE_TOO_LOW);
  });
  it("above the cap", async () => {
    const { hex } = standardPayment(node, payer, merchant.address, { fee: 100_001n });
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_FEE_TOO_HIGH);
  });
  it("at the floor and at the cap", async () => {
    expect((await verify(standardPayment(node, payer, merchant.address, { fee: 1_000n }).hex)).isValid).toBe(true);
    expect((await verify(standardPayment(node, payer, merchant.address, { fee: 100_000n }).hex)).isValid).toBe(true);
  });
});

describe("rule 8: expiry window", () => {
  // maxTimeoutSeconds 300: tip + 4 <= expiry <= tip + 4 + 4 + 1
  it("0 is refused", async () => {
    expect((await verify(standardPayment(node, payer, merchant.address, { expiry: 0 }).hex)).invalidReason).toBe(exact.ERR_EXPIRY);
  });
  it("below tip + 4 is refused", async () => {
    expect((await verify(standardPayment(node, payer, merchant.address, { expiry: node.tip + 3 }).hex)).invalidReason).toBe(exact.ERR_EXPIRY);
  });
  it("above the window is refused", async () => {
    expect((await verify(standardPayment(node, payer, merchant.address, { expiry: node.tip + 10 }).hex)).invalidReason).toBe(exact.ERR_EXPIRY);
  });
  it("both bounds are inclusive", async () => {
    expect((await verify(standardPayment(node, payer, merchant.address, { expiry: node.tip + 4 }).hex)).isValid).toBe(true);
    expect((await verify(standardPayment(node, payer, merchant.address, { expiry: node.tip + 9 }).hex)).isValid).toBe(true);
  });
});

describe("rule 9: scripts", () => {
  it("a corrupted signature fails the node's verifier", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    const tx = parseTx(hex);
    const sig = tx.vin[0]!.scriptSig;
    sig[10] = (sig[10] as number) ^ 1;
    const r = await verify(serializeTxHex(tx));
    expect(r.invalidReason).toBe(exact.ERR_SCRIPT);
  });
  it("a signature by another key fails", async () => {
    const coin = node.addCoin(10_000_000n, payer.script);
    const hex = buildSigned({
      coins: [{ ...coin, value: 10_000_000n, script: payer.script }], priv: testKey(9).priv, expiryHeight: node.tip + 7,
      outputs: [{ value: 250_000n, scriptPubKey: merchant.script }, { value: 9_749_000n, scriptPubKey: payer.script }],
    });
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_SCRIPT);
  });
});

describe("rule 9Y: YED-bearing inputs on a Yellowback node", () => {
  it("refuses a YEC payment that spends YED", async () => {
    node.yellowback = true;
    const { hex, coin } = standardPayment(node, payer, merchant.address);
    node.yedCents.set(`${coin.txid}:${coin.vout}`, 500);
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_YED_INPUT);
  });
  it("is not asked on a stock node", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    expect((await verify(hex)).isValid).toBe(true);
    expect(node.calls).not.toContain("yed_validaterawtransaction");
  });
});

describe("rule 10: not claimed", () => {
  it("a claimed txid is a duplicate, even though its inputs are now spent by it", async () => {
    const { hex } = standardPayment(node, payer, merchant.address);
    await store.claim(txidKey(NETWORK, txid(hex)), 400);
    await node.sendRawTransaction(hex);
    const r = await verify(hex);
    expect(r.invalidReason).toBe(exact.ERR_DUPLICATE_SETTLEMENT);
    expect(r.payer).toBe(payer.address);
  });
});

describe("rule order", () => {
  it("reports the first failing rule", async () => {
    // wrong amount (rule 4) and too-low fee (rule 7): rule 4 wins
    const { hex } = standardPayment(node, payer, merchant.address, { amount: 1n, fee: 1n });
    expect((await verify(hex)).invalidReason).toBe(exact.ERR_AMOUNT_MISMATCH);
  });
});
