// X4a acceptance on either node line: `sapling-proof` end to end against a real merchant wallet
// (node 0) and a real payer wallet (the pool, node 2), tiers P1 (z→z) and P0 (t→z).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import * as secp from "@noble/secp256k1";
import { beforeAll, expect, it } from "vitest";
import { FileSettlementStore, YCASH_REGTEST, type DecodedTransaction, type ZSendManyOptions } from "../../src/index.js";
import {
  ERR,
  FileIssuedAddressRegistry,
  SaplingProofHandler,
  ShieldedExactClient,
  memoToHex,
  verifyReceipt,
  type JwsSignedArtifact,
} from "../../src/shielded/index.js";
import { describeDevnet, devnet, record, waitFor, type Devnet } from "./harness.js";

const RESOURCE = "https://merchant.example/x402/report";
const AMOUNT = 1_500_000n; // 0.015 YEC

describeDevnet("sapling-proof (X4a) on the devnet", () => {
  let d: Devnet;
  let handler: SaplingProofHandler;
  let receiptPub: Uint8Array;
  let tFrom: string; // the payer's transparent source (P0)
  let zFrom: string; // the payer's shielded source (P1)
  let tOpts: ZSendManyOptions; // z_sendmany options for a transparent source on this line

  const template = (confirmations: number, extra: Record<string, unknown> = {}): PaymentRequirements => ({
    scheme: "exact",
    network: YCASH_REGTEST,
    asset: "YEC",
    amount: AMOUNT.toString(),
    payTo: "",
    maxTimeoutSeconds: 900,
    extra: { assetTransferMethod: "sapling-proof", confirmationPolicy: { confirmations }, ...extra },
  });
  const issue = (confirmations: number, extra?: Record<string, unknown>) => handler.enhanceRequirements(template(confirmations, extra), { url: RESOURCE });
  const payloadFor = (req: PaymentRequirements, txid: string): PaymentPayload => ({ x402Version: 2, accepted: structuredClone(req), payload: { txid } });
  /** settle, retried while the merchant wallet has not yet seen the note (it learns of mempool txs asynchronously). */
  const settleSeen = async (req: PaymentRequirements, txid: string): Promise<SettleResponse> => {
    let last: SettleResponse | undefined;
    await waitFor(
      async () => {
        last = await handler.settle(payloadFor(req, txid), req);
        return last.errorReason !== ERR.notReceived;
      },
      { timeoutMs: 30_000, what: `the merchant wallet to see ${txid}` },
    );
    return last!;
  };
  /** A raw payment from the pool's transparent source, for the malformed cases a client would never build. */
  const rawPay = (outputs: { address: string; zat: bigint; memo: string }[]) =>
    d.pool.zSendManyAndWait(tFrom, outputs.map((o) => ({ address: o.address, amount: o.zat, memo: memoToHex(o.memo) })), tOpts);

  /** The chain-level privacy check: no transparent output of the payment pays the merchant. */
  const chainShape = async (txid: string) => {
    const tx = await d.wallet.call<DecodedTransaction>("getrawtransaction", [txid, 1]);
    const outAddrs = tx.vout.flatMap((o) => o.scriptPubKey.addresses ?? []);
    const mine = await Promise.all(outAddrs.map(async (a) => (await d.wallet.call<{ ismine: boolean }>("validateaddress", [a])).ismine));
    return { vin: tx.vin.length, vout: tx.vout.length, outAddrs, merchantTransparentOutputs: mine.filter(Boolean).length, saplingOutputs: tx.vShieldedOutput?.length ?? 0, saplingSpends: tx.vShieldedSpend?.length ?? 0, valueBalance: tx.valueBalance };
  };
  const receiptOf = (res: SettleResponse): JwsSignedArtifact => (res.extensions as { "offer-receipt": { info: { receipt: JwsSignedArtifact } } })["offer-receipt"].info.receipt;

  beforeAll(async () => {
    d = await devnet();
    const dir = mkdtempSync(join(tmpdir(), "x402-shielded-"));
    const key = secp.utils.randomSecretKey();
    receiptPub = secp.getPublicKey(key, true);
    handler = new SaplingProofHandler({
      network: YCASH_REGTEST,
      rpc: d.wallet,
      settlementStore: new FileSettlementStore(join(dir, "claims.json")),
      registry: new FileIssuedAddressRegistry(join(dir, "issued.json")),
      capabilities: d.caps,
      receiptKey: key,
      fallbackPriceMicroUsd: 50_000_000,
    });
    tOpts = d.line === "v6" ? { minconf: 1, privacyPolicy: "AllowFullyTransparent" } : { minconf: 1 };
    // The payer: ten confirmed transparent coins, and three confirmed Sapling notes made from three of them.
    tFrom = await d.pool.getNewAddress();
    for (let i = 0; i < 12; i++) await d.fund(tFrom, 100_000_000n);
    await d.mine(1);
    zFrom = await d.pool.zGetNewAddress();
    for (let i = 0; i < 3; i++) await d.pool.zSendManyAndWait(tFrom, [{ address: zFrom, amount: 50_000_000n }], tOpts);
    await d.mine(1);
    await waitFor(async () => (await d.pool.zListReceivedByAddress(zFrom, 1)).length >= 3, { what: "the payer's three notes" });
  });

  it("P1 (z→z) at zero confirmations: policy −1 settles on the mempool note", async () => {
    const req = await issue(-1);
    const client = new ShieldedExactClient({ rpc: d.pool, from: zFrom });
    const { payload } = await client.createPaymentPayload(2, req);
    const res = await settleSeen(req, payload.txid);
    const shape = await chainShape(payload.txid);
    record(d.line, "X4a-P1-0conf", { res: { ...res, extensions: undefined }, shape });
    expect(res).toMatchObject({ success: true, transaction: payload.txid, network: YCASH_REGTEST, extra: { status: "mempool", confirmations: -1, receivedZat: AMOUNT.toString() } });
    expect(res.payer).toBeUndefined();
    // Nothing public: no transparent input or output at all, the value moves inside the pool.
    expect(shape).toMatchObject({ vin: 0, vout: 0, merchantTransparentOutputs: 0 });
    // valueBalance is the fee leaving the pool, not the amount paid
    expect(shape.valueBalance).toBeGreaterThan(0);
    expect(shape.valueBalance).toBeLessThan(0.001);
    expect(shape.saplingSpends).toBeGreaterThan(0);
    expect(shape.saplingOutputs).toBeGreaterThan(0);
    expect(verifyReceipt(receiptOf(res), { trustedPublicKeys: [receiptPub] })).toMatchObject({ network: YCASH_REGTEST, resourceUrl: RESOURCE, payer: "anonymous", transaction: payload.txid });
    await d.mine(1);
  });

  it("P1 at one confirmation: settlement_pending (nothing claimed) until mined, then success", async () => {
    const req = await issue(1);
    const { payload } = await new ShieldedExactClient({ rpc: d.pool, from: zFrom }).createPaymentPayload(2, req);
    const pending = await settleSeen(req, payload.txid);
    expect(pending).toMatchObject({ success: false, errorReason: ERR.settlementPending, transaction: payload.txid, extra: { status: "pending", confirmations: -1 } });
    await d.mine(1);
    const res = await handler.settle(payloadFor(req, payload.txid), req);
    record(d.line, "X4a-P1-1conf", { pending, res: { ...res, extensions: undefined } });
    expect(res).toMatchObject({ success: true, extra: { status: "confirmed", confirmations: 1 } });
    expect(verifyReceipt(receiptOf(res), { trustedPublicKeys: [receiptPub] }).transaction).toBe(payload.txid);
    // the receipt names only the merchant's key
    expect(() => verifyReceipt(receiptOf(res), { trustedPublicKeys: [secp.getPublicKey(secp.utils.randomSecretKey(), true)] })).toThrow();
    expect((await chainShape(payload.txid)).merchantTransparentOutputs).toBe(0);
  });

  it("P0 (t→z): settles; the payer is public on chain, the merchant is not", async () => {
    const req = await issue(1, { priceUsd: "0.10" });
    const quote = req.extra.quote as { source: string; priceMicroUsd: number };
    const { payload } = await new ShieldedExactClient({ rpc: d.pool, from: tFrom }).createPaymentPayload(2, req);
    await d.mine(1);
    const res = await settleSeen(req, payload.txid);
    const shape = await chainShape(payload.txid);
    record(d.line, "X4a-P0", { amount: req.amount, quote, res: { ...res, extensions: undefined }, shape });
    expect(res).toMatchObject({ success: true, extra: { status: "confirmed" } });
    expect(shape.vin).toBeGreaterThan(0); // the payer's transparent coins are visible
    expect(shape.merchantTransparentOutputs).toBe(0); // only the payer's change, if any, is transparent
    // the transparent change goes to the payer (v4.5.0 picks a fresh change address, not tFrom)
    for (const a of shape.outAddrs) expect((await d.pool.call<{ ismine: boolean }>("validateaddress", [a])).ismine).toBe(true);
    expect(shape.saplingOutputs).toBeGreaterThan(0);
    expect(BigInt(req.amount)).toBe((100_000n * 100_000_000n + BigInt(quote.priceMicroUsd) - 1n) / BigInt(quote.priceMicroUsd));
  });

  it("refuses an underpayment, accepts an overpayment, refuses a wrong memo", async () => {
    const under = await issue(1);
    const over = await issue(1);
    const wrong = await issue(1);
    const txUnder = await rawPay([{ address: under.payTo, zat: AMOUNT - 1n, memo: under.extra.memo as string }]);
    const txOver = await rawPay([{ address: over.payTo, zat: AMOUNT + 12_345n, memo: over.extra.memo as string }]);
    const txWrong = await rawPay([{ address: wrong.payTo, zat: AMOUNT, memo: over.extra.memo as string }]);
    await d.mine(1);
    const rUnder = await settleSeen(under, txUnder);
    const rOver = await settleSeen(over, txOver);
    const rWrong = await settleSeen(wrong, txWrong);
    record(d.line, "X4a-amounts", { rUnder, rOver: { ...rOver, extensions: undefined }, rWrong });
    expect(rUnder).toMatchObject({ success: false, errorReason: ERR.underpaid });
    expect(rOver).toMatchObject({ success: true, extra: { receivedZat: (AMOUNT + 12_345n).toString() } });
    expect(rWrong).toMatchObject({ success: false, errorReason: ERR.memoMismatch });
  });

  it("one txid buys one resource: a replay is a duplicate, another request's address has no note", async () => {
    const a = await issue(1);
    const b = await issue(1);
    const tx = await rawPay([{ address: a.payTo, zat: AMOUNT, memo: a.extra.memo as string }]);
    await d.mine(1);
    const first = await settleSeen(a, tx);
    const replay = await handler.settle(payloadFor(a, tx), a);
    const elsewhere = await handler.settle(payloadFor(b, tx), b);
    record(d.line, "X4a-replay", { first: first.success, replay, elsewhere });
    expect(first.success).toBe(true);
    expect(replay).toMatchObject({ success: false, errorReason: ERR.duplicateSettlement });
    expect(elsewhere).toMatchObject({ success: false, errorReason: ERR.notReceived });
  });

  it("one txid paying two requests settles both (the consumption key is txid@payTo)", async () => {
    const a = await issue(1);
    const b = await issue(1);
    const tx = await rawPay([
      { address: a.payTo, zat: AMOUNT, memo: a.extra.memo as string },
      { address: b.payTo, zat: AMOUNT, memo: b.extra.memo as string },
    ]);
    await d.mine(1);
    const ra = await settleSeen(a, tx);
    const rb = await settleSeen(b, tx);
    record(d.line, "X4a-two-requests-one-tx", { ra: ra.success, rb });
    expect(ra.success).toBe(true);
    expect(rb.success).toBe(true);
    expect(await settleSeen(a, tx)).toMatchObject({ success: false, errorReason: ERR.duplicateSettlement });
  });
});
