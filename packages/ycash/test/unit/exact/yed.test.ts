// YED `exact` (specs/scheme_exact_ycash.md, `transparent` with asset YED; plan §5.8): the client's
// TRANSFER, the server's prices, and the facilitator's rules 4Y and 9Y against an in-memory node.
import { beforeEach, describe, expect, it } from "vitest";
import { exact, yed } from "../../../src/index.js";
import { InMemorySettlementStore } from "../../../src/store/index.js";
import { encodeAddress, hash160, parseTx, pubkeyFromPriv, SEQUENCE_FINAL, newTx, p2pkhScriptSig, serializeTxHex, sighashV4, signInput, SIGHASH, txid, type TxOut } from "../../../src/tx/index.js";
import { BRANCH_ID, FakeNode, FakeUtxoSource, NETWORK, paymentPayload, requirements, testKey } from "./fakeNode.js";

const payer = testKey(1);
const merchant = testKey(2);
const yr = (k: { priv: Uint8Array }) => encodeAddress(NETWORK, "yed", hash160(pubkeyFromPriv(k.priv)));
const payerYr = yr(payer);
const merchantYr = yr(merchant);
const yedReq = (amount = "2500", extra: Record<string, unknown> = {}) => ({ ...requirements(merchantYr, amount, { confirmationPolicy: { confirmations: 1 }, ...extra }), asset: "YED" });

let node: FakeNode;
let facilitator: exact.ExactYcashFacilitatorScheme;

beforeEach(() => {
  node = new FakeNode();
  node.yellowback = true;
  facilitator = new exact.ExactYcashFacilitatorScheme(node, { settlementStore: new InMemorySettlementStore(), confirmationTimeoutMs: 0, yellowback: true });
});

/** The client's YED payment for `req`: token coins of `cents` and one YEC coin. */
async function clientPayment(req = yedReq(), cents: number[] = [5_000]): Promise<string> {
  for (const c of cents) node.addToken(c, payer.script);
  node.addCoin(1_000_000n, payer.script);
  const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
  return ((await client.createPaymentPayload(2, req)).payload as { transaction: string }).transaction;
}

/** A hand-built YED payment: one token coin, one YEC coin, these outputs. */
function handBuilt(tokenCents: number, outputs: TxOut[], opts: { unconfirmedToken?: boolean } = {}): string {
  const t = node.addToken(tokenCents, payer.script);
  if (opts.unconfirmedToken) node.unconfirmed.add(`${t.txid}:${t.vout}`);
  const c = node.addCoin(1_000_000n, payer.script);
  const tx = newTx({ vin: [t, c].map((o) => ({ prevout: o, scriptSig: new Uint8Array(), sequence: SEQUENCE_FINAL })), vout: outputs, expiryHeight: node.tip + 3 + 4 });
  const pub = pubkeyFromPriv(payer.priv);
  [10_000n, 1_000_000n].forEach((v, i) => {
    tx.vin[i]!.scriptSig = p2pkhScriptSig(signInput(sighashV4(tx, i, payer.script, v, SIGHASH.ALL, BRANCH_ID), payer.priv), pub);
  });
  return serializeTxHex(tx);
}

const out = (value: bigint, script: Uint8Array): TxOut => ({ value, scriptPubKey: script });
const transfer = (a: yed.Assignment[]): TxOut => out(0n, yed.transferOpReturnScript(a));
const yecChange = (used: bigint) => out(1_010_000n - used - 2_000n, payer.script);

describe("client: the YED TRANSFER", () => {
  it("assigns amount to payTo and the rest as YED change, TOKEN_VALUE on each, never broadcast; the facilitator accepts it", async () => {
    const hex = await clientPayment();
    const tx = parseTx(hex);
    const found = yed.findPayload(tx.vout);
    expect(found).toMatchObject({ index: 2, payload: { type: "transfer", assignments: [{ vout: 0, cents: 2500 }, { vout: 1, cents: 2500 }] } });
    expect(tx.vout[0]).toEqual(out(10_000n, merchant.script));
    expect(tx.vout[1]).toEqual(out(10_000n, payer.script));
    expect(tx.lockTime).toBe(0);
    expect(node.calls).not.toContain("sendrawtransaction");
    const v = await facilitator.verify(paymentPayload(yedReq(), hex), yedReq());
    expect(v).toEqual({ isValid: true, payer: payerYr });
  });
  it("picks other coins rather than a sub-dollar change, and refuses when none fit", async () => {
    const hex = await clientPayment(yedReq("950"), [1_000, 300]);
    const found = yed.findPayload(parseTx(hex).vout);
    expect(found && !yed.isFindPayloadFailure(found) && found.payload.type === "transfer" ? found.payload.assignments : null).toEqual([{ vout: 0, cents: 950 }, { vout: 1, cents: 350 }]);
    node = new FakeNode();
    await expect(clientPayment(yedReq("950"), [1_000])).rejects.toThrow(/would burn/);
  });
  it("refuses YED requirements below $1.00, with a transparent payTo, or with a signer that cannot pay YED", async () => {
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    await expect(client.createPaymentPayload(2, yedReq("99"))).rejects.toThrow(/100\.\.10000000/);
    await expect(client.createPaymentPayload(2, { ...yedReq(), payTo: merchant.address })).rejects.toThrow(/Yellowback/);
    const yecOnly: exact.YcashClientSigner = { chainState: async () => ({ chain: "regtest", height: 1, branchId: BRANCH_ID }), signPayment: async () => { throw new Error("unused"); } };
    await expect(new exact.ExactYcashScheme(yecOnly).createPaymentPayload(2, yedReq())).rejects.toThrow(/cannot pay YED/);
  });
});

describe("server: YED prices", () => {
  const s = new exact.ExactYcashServerScheme({ usdAsset: "YED" });
  it('reads "$x" (usdAsset YED) and "x YED" in cents', async () => {
    expect(await s.parsePrice("$1", NETWORK)).toEqual({ amount: "100", asset: "YED", extra: {} });
    expect(await s.parsePrice("$25.50", NETWORK)).toEqual({ amount: "2550", asset: "YED", extra: {} });
    expect(await s.parsePrice("3 YED", NETWORK)).toEqual({ amount: "300", asset: "YED", extra: {} });
    expect(await new exact.ExactYcashServerScheme().parsePrice("2 YED", NETWORK)).toMatchObject({ amount: "200", asset: "YED" });
  });
  it("refuses below $1.00 (a smaller YED output burns) and fractions of a cent", async () => {
    await expect(s.parsePrice("$0.50", NETWORK)).rejects.toThrow(/burns/);
    await expect(s.parsePrice("0.99 YED", NETWORK)).rejects.toThrow(/burns/);
    await expect(s.parsePrice("$1.005", NETWORK)).rejects.toThrow(/whole number of cents/);
    await expect(s.parsePrice({ amount: "50", asset: "YED" }, NETWORK)).rejects.toThrow(/burns/);
  });
  it("defaults YED to confirmation policy 1 and needs a facilitator that settles YED", async () => {
    const kind = { x402Version: 2, scheme: "exact", network: NETWORK } as const;
    const base = { scheme: "exact", network: NETWORK, asset: "YED", amount: "100", payTo: merchantYr, maxTimeoutSeconds: 300, extra: {} };
    expect((await s.enhancePaymentRequirements(base, kind, [])).extra.confirmationPolicy).toEqual({ confirmations: 1 });
    await expect(s.enhancePaymentRequirements(base, { ...kind, extra: { assets: ["YEC"] } }, [])).rejects.toThrow(/does not settle YED/);
    expect((await s.enhancePaymentRequirements(base, { ...kind, extra: { assets: ["YEC", "YED"] } }, [])).asset).toBe("YED");
  });
});

describe("facilitator: rules 4Y and 9Y", () => {
  const reason = async (hex: string, req = yedReq()) => (await facilitator.verify(paymentPayload(req, hex), req)).invalidReason;

  it("lists YED in /supported only on a Yellowback node", () => {
    expect(facilitator.getExtra(NETWORK)?.assets).toEqual(["YEC", "YED"]);
    expect(new exact.ExactYcashFacilitatorScheme(node).getExtra(NETWORK)?.assets).toEqual(["YEC"]);
    expect(new exact.ExactYcashFacilitatorScheme({ rpc: node, capabilities: { yellowback: true } }).getExtra(NETWORK)?.assets).toEqual(["YEC", "YED"]);
  });
  it("a stock node: yed_node_required", async () => {
    const hex = await clientPayment();
    node.yellowback = false;
    expect(await reason(hex)).toBe(exact.ERR_YED_NODE_REQUIRED);
  });
  it("4Y: the requirements' form (amount ≥ $1.00, a Yellowback payTo)", async () => {
    const hex = await clientPayment();
    expect(await reason(hex, yedReq("50"))).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
    expect(await reason(hex, { ...yedReq(), payTo: merchant.address })).toBe(exact.ERR_REQUIREMENTS_MISMATCH);
  });
  it("4Y: exactly one payTo output, above dust", async () => {
    expect(await reason(handBuilt(2500, [out(10_000n, payer.script), transfer([{ vout: 0, cents: 2500 }]), yecChange(10_000n)]))).toBe(exact.ERR_RECIPIENT_MISMATCH);
    expect(await reason(handBuilt(2500, [out(10_000n, merchant.script), out(10_000n, merchant.script), transfer([{ vout: 0, cents: 2500 }]), yecChange(20_000n)]))).toBe(exact.ERR_RECIPIENT_MISMATCH);
    expect(await reason(handBuilt(2500, [out(53n, merchant.script), transfer([{ vout: 0, cents: 2500 }]), yecChange(53n)]))).toBe(exact.ERR_RECIPIENT_MISMATCH);
  });
  it("4Y: a TRANSFER payload, with assignments the overlay registers", async () => {
    expect(await reason(handBuilt(2500, [out(10_000n, merchant.script), yecChange(10_000n)]))).toBe(exact.ERR_YED_PAYLOAD); // no OP_RETURN
    expect(await reason(handBuilt(2500, [out(10_000n, merchant.script), out(0n, Uint8Array.of(0x6a, 0x02, 0x59, 0x42)), yecChange(10_000n)]))).toBe(exact.ERR_YED_PAYLOAD);
    expect(await reason(handBuilt(2600, [out(10_000n, merchant.script), out(10_000n, payer.script), transfer([{ vout: 0, cents: 2500 }, { vout: 1, cents: 99 }]), yecChange(20_000n)]))).toBe(exact.ERR_YED_PAYLOAD); // 99 cents: XFER-1
    // a duplicate vout, which the SDK's encoder refuses to write: the bytes by hand
    const dup = Uint8Array.of(0x59, 0x42, 0x03, 0x02, 0x02, 0x00, 0xc4, 0x09, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x00, 0x00);
    expect(await reason(handBuilt(5000, [out(10_000n, merchant.script), out(0n, yed.payloadScript(dup)), yecChange(10_000n)]))).toBe(exact.ERR_YED_PAYLOAD);
  });
  it("4Y: payTo is assigned exactly amount", async () => {
    expect(await reason(handBuilt(2400, [out(10_000n, merchant.script), transfer([{ vout: 0, cents: 2400 }]), yecChange(10_000n)]))).toBe(exact.ERR_AMOUNT_MISMATCH);
    expect(await reason(handBuilt(2500, [out(10_000n, merchant.script), out(10_000n, payer.script), transfer([{ vout: 1, cents: 2500 }]), yecChange(20_000n)]))).toBe(exact.ERR_AMOUNT_MISMATCH);
  });
  it("4Y: yed_decodepayload must agree", async () => {
    const hex = await clientPayment();
    node.decodeOverride = { valid: true, version: 3, type: "transfer", reason: "", opReturnIndex: 2, assignments: [{ vout: 0, cents: 2500 }] };
    expect(await reason(hex)).toBe(exact.ERR_YED_PAYLOAD);
  });
  it("9Y: an under-assigning TRANSFER (the rest burns) is refused", async () => {
    // 5,000 in, 2,500 assigned: verdict burned, burned 2,500
    expect(await reason(handBuilt(5000, [out(10_000n, merchant.script), transfer([{ vout: 0, cents: 2500 }]), yecChange(10_000n)]))).toBe(exact.ERR_YED_VERDICT);
  });
  it("9Y: an over-assigning TRANSFER (everything burns) is refused", async () => {
    expect(await reason(handBuilt(2000, [out(10_000n, merchant.script), transfer([{ vout: 0, cents: 2500 }]), yecChange(10_000n)]))).toBe(exact.ERR_YED_VERDICT);
  });
  it("9Y: a token input the overlay cannot see yet is refused", async () => {
    expect(await reason(handBuilt(2500, [out(10_000n, merchant.script), transfer([{ vout: 0, cents: 2500 }]), yecChange(10_000n)], { unconfirmedToken: true }))).toBe(exact.ERR_YED_UNCONFIRMED_INPUT);
  });
  it("settles: claim, broadcast, the payTo output observed; payer in the Yellowback form", async () => {
    const hex = await clientPayment();
    const req = yedReq("2500", { confirmationPolicy: { confirmations: -1 } });
    const r = await facilitator.settle(paymentPayload(req, hex), req);
    expect(r).toMatchObject({ success: true, transaction: txid(hex), payer: payerYr, extra: { status: "mempool", confirmations: -1 } });
    const again = await facilitator.settle(paymentPayload(req, hex), req); // resumes, never broadcasts again
    expect(again).toMatchObject({ success: true, payer: payerYr });
    expect(node.calls.filter((c) => c === "sendrawtransaction")).toHaveLength(1);
  });
  it("a YEC payment spending a token coin is still refused (rule 9Y, YEC form)", async () => {
    const t = node.addToken(500, payer.script);
    const tx = newTx({ vin: [{ prevout: t, scriptSig: new Uint8Array(), sequence: SEQUENCE_FINAL }], vout: [out(5_000n, merchant.script)], expiryHeight: node.tip + 7 });
    tx.vin[0]!.scriptSig = p2pkhScriptSig(signInput(sighashV4(tx, 0, payer.script, 10_000n, SIGHASH.ALL, BRANCH_ID), payer.priv), pubkeyFromPriv(payer.priv));
    const req = requirements(merchant.address, "5000");
    expect((await facilitator.verify(paymentPayload(req, serializeTxHex(tx)), req)).invalidReason).toBe(exact.ERR_YED_INPUT);
  });
});
