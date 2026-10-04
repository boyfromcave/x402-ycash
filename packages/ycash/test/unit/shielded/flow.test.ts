import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import * as secp from "@noble/secp256k1";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemorySettlementStore, RpcError, YCASH_MAINNET, YCASH_REGTEST, type BlockchainInfo, type NodeCapabilities, type YedPrice, type ZReceived, type ZRecipient, type ZSendManyOptions } from "../../../src/index.js";
import {
  ERR,
  SaplingProofHandler,
  ShieldedExactClient,
  es256kSigner,
  memoToHex,
  meetsPolicy,
  requestHash,
  tierOf,
  verifyReceipt,
  type JwsSignedArtifact,
  type JwsSigner,
} from "../../../src/shielded/index.js";

const NOW = 1_800_000_000;
const RESOURCE = "https://api.example.com/data";
const TXID = "5b".repeat(32);
const RECEIPT_KEY = new Uint8Array(32).fill(3);

/** A merchant wallet: issues diversified addresses and holds notes per address. */
class MockWallet {
  chain = "regtest";
  baseCalls = 0;
  divCalls = 0;
  notes = new Map<string, ZReceived[]>();
  repeat: string | undefined;
  price: Partial<YedPrice> | Error = { height: 10, pMid: 300_000, pFast: null, pSlow: null };

  async zGetNewAddress(): Promise<string> {
    this.baseCalls++;
    return "yregtestsapling1base";
  }
  async zGetNewDiversifiedAddress(base: string): Promise<string> {
    expect(base).toBe("yregtestsapling1base");
    this.divCalls++;
    return this.repeat ?? `yregtestsapling1div${this.divCalls}`;
  }
  async zListReceivedByAddress(address: string, minconf = 1): Promise<ZReceived[]> {
    expect(minconf).toBe(0);
    return this.notes.get(address) ?? [];
  }
  async getBlockchainInfo(): Promise<BlockchainInfo> {
    return { chain: this.chain } as BlockchainInfo;
  }
  async yedGetPrice(): Promise<YedPrice> {
    if (this.price instanceof Error) throw this.price;
    return this.price as YedPrice;
  }
  pay(address: string, zat: number, memo: string, confirmations: number, txid = TXID): void {
    const hex = memoToHex(memo) + "00".repeat(512 - memo.length);
    const list = this.notes.get(address) ?? [];
    list.push({ txid, amount: zat / 1e8, amountZat: zat, memo: hex, outindex: list.length, confirmations, change: false });
    this.notes.set(address, list);
  }
}

const template = (extra: Record<string, unknown> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: YCASH_REGTEST,
  asset: "YEC",
  amount: "1500000",
  payTo: "",
  maxTimeoutSeconds: 600,
  extra: { assetTransferMethod: "sapling-proof", ...extra },
});

const payloadFor = (req: PaymentRequirements, txid: string = TXID): PaymentPayload => ({ x402Version: 2, accepted: structuredClone(req), payload: { txid } });

let wallet: MockWallet;
let store: InMemorySettlementStore;
let handler: SaplingProofHandler;
let now: number;

function makeHandler(opts: { signer?: JwsSigner; maxOutstanding?: number; fallbackPriceMicroUsd?: number } = {}): SaplingProofHandler {
  return new SaplingProofHandler({
    network: YCASH_REGTEST,
    rpc: wallet,
    settlementStore: store,
    receiptKey: opts.signer ?? RECEIPT_KEY,
    now: () => now,
    ...(opts.maxOutstanding === undefined ? {} : { maxOutstanding: opts.maxOutstanding }),
    ...(opts.fallbackPriceMicroUsd === undefined ? {} : { fallbackPriceMicroUsd: opts.fallbackPriceMicroUsd }),
  });
}

beforeEach(() => {
  wallet = new MockWallet();
  store = new InMemorySettlementStore();
  now = NOW;
  handler = makeHandler();
});

describe("sapling-proof server: enhanceRequirements", () => {
  it("issues a fresh diversified address per request, with the memo committing to the record", async () => {
    const a = await handler.enhanceRequirements(template(), { url: RESOURCE });
    const b = await handler.enhanceRequirements(template(), RESOURCE);
    expect(wallet.baseCalls).toBe(1); // z_getnewaddress sapling once
    expect([a.payTo, b.payTo]).toEqual(["yregtestsapling1div1", "yregtestsapling1div2"]);
    expect(a.extra).toMatchObject({ assetTransferMethod: "sapling-proof", paymentFlow: "upfront", areFeesSponsored: false, expiresAt: NOW + 600, confirmationPolicy: { confirmations: 1 } });
    const rec = await handler.server.requestRecord(a.payTo);
    expect(rec).toMatchObject({ v: 1, network: YCASH_REGTEST, asset: "YEC", amount: "1500000", payTo: a.payTo, resource: RESOURCE, expiresAt: NOW + 600 });
    expect(rec!.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(a.extra.memo).toBe("x402:" + requestHash(rec!));
    expect(a.extra.memo).not.toBe(b.extra.memo);
  });
  it("keeps a declared confirmation policy and refuses one out of range", async () => {
    const r = await handler.enhanceRequirements(template({ confirmationPolicy: { confirmations: -1 } }), RESOURCE);
    expect(r.extra.confirmationPolicy).toEqual({ confirmations: -1 });
    await expect(handler.enhanceRequirements(template({ confirmationPolicy: { confirmations: 21 } }), RESOURCE)).rejects.toThrow(/outside/);
  });
  it("never reissues an address the wallet repeats", async () => {
    const a = await handler.enhanceRequirements(template(), RESOURCE);
    wallet.repeat = a.payTo;
    await expect(handler.enhanceRequirements(template(), RESOURCE)).rejects.toThrow(/already issued/);
  });
  it("quotes a dollar price from yed_getprice, else the configured price", async () => {
    const r = await handler.enhanceRequirements({ ...template({ priceUsd: "0.05" }), amount: "" }, RESOURCE);
    expect(r.amount).toBe("16666667");
    expect(r.extra.priceUsd).toBeUndefined();
    expect(r.extra.quote).toEqual({ usd: "0.05", priceMicroUsd: 300_000, source: "yed_getprice:pMid", height: 10 });
    expect((await handler.server.requestRecord(r.payTo))?.amount).toBe("16666667");
    wallet.price = new RpcError(-32601, "Method not found", "yed_getprice");
    await expect(handler.enhanceRequirements(template({ priceUsd: "0.05" }), RESOURCE)).rejects.toThrow(/no YEC price/);
    const h2 = makeHandler({ fallbackPriceMicroUsd: 500_000 });
    expect((await h2.enhanceRequirements(template({ priceUsd: "1" }), RESOURCE)).amount).toBe("200000000");
  });
  it("refuses what it cannot issue", async () => {
    await expect(handler.enhanceRequirements({ ...template(), asset: "YED" }, RESOURCE)).rejects.toThrow(/YEC only/);
    await expect(handler.enhanceRequirements(template({ assetTransferMethod: "transparent" }), RESOURCE)).rejects.toThrow(/sapling-proof/);
    await expect(handler.enhanceRequirements({ ...template(), network: "eip155:1" }, RESOURCE)).rejects.toThrow(/serves ycash:regtest/);
    await expect(handler.enhanceRequirements({ ...template(), amount: "0" }, RESOURCE)).rejects.toThrow(/amount/);
    await expect(handler.enhanceRequirements(template(), "")).rejects.toThrow(/resource/);
    // a mainnet requirement at a regtest handler
    await expect(handler.enhanceRequirements({ ...template(), network: YCASH_MAINNET }, RESOURCE)).rejects.toThrow(/serves ycash:regtest/);
    // a mainnet handler on a regtest wallet: the address HRP gives it away
    const mainnet = new SaplingProofHandler({ network: YCASH_MAINNET, rpc: wallet, settlementStore: store, receiptKey: RECEIPT_KEY });
    await expect(mainnet.enhanceRequirements({ ...template(), network: YCASH_MAINNET }, RESOURCE)).rejects.toThrow(/not a ycash:mainnet Sapling/);
  });
  it("enforces an issuance limit, freed when records are pruned", async () => {
    const h = makeHandler({ maxOutstanding: 1 });
    await h.enhanceRequirements(template(), RESOURCE);
    await expect(h.enhanceRequirements(template(), RESOURCE)).rejects.toThrow(/issuance limit/);
    now = NOW + 600 + 150 + 3600 + 1;
    await h.server.registry.prune(now);
    await expect(h.enhanceRequirements(template(), RESOURCE)).resolves.toBeTruthy();
  });
});

describe("sapling-proof handler: construction from the facilitator's SchemeDeps", () => {
  it("takes network, store, operator range, capabilities, logger, base address and a hex receipt key", async () => {
    const logs: string[] = [];
    const caps: NodeCapabilities = { line: "v4", subversion: "", version: 0, yellowback: true, chain: "regtest" };
    const h = new SaplingProofHandler({
      network: YCASH_REGTEST,
      rpc: wallet,
      settlementStore: store,
      confirmations: { minimum: 0, maximum: 6 },
      capabilities: caps,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      baseAddress: "yregtestsapling1base",
      receiptKey: Buffer.from(RECEIPT_KEY).toString("hex"),
      now: () => now,
    });
    expect(h.receiptSigner.kid).toBe(es256kSigner(RECEIPT_KEY).kid);
    const req = await h.enhanceRequirements(template(), RESOURCE);
    expect(wallet.baseCalls).toBe(0); // the configured base address is used
    await expect(h.enhanceRequirements(template({ confirmationPolicy: { confirmations: -1 } }), RESOURCE)).rejects.toThrow(/operator's range/);
    wallet.pay(req.payTo, 1_500_000, req.extra.memo as string, 1);
    expect((await h.settle(payloadFor(req), req)).success).toBe(true);
    expect((await h.settle(payloadFor(req), req)).errorReason).toBe(ERR.duplicateSettlement);
    expect(logs).toEqual(["sapling-proof settled", "sapling-proof settle refused"]);
    const other = { ...req, network: YCASH_MAINNET };
    expect(await h.settle(payloadFor(other), other)).toMatchObject({ errorReason: "network_mismatch" });
    expect(await h.verify(payloadFor(other), other)).toMatchObject({ isValid: false, invalidReason: "network_mismatch" });
    expect(() => new SaplingProofHandler({ network: YCASH_MAINNET, rpc: wallet, settlementStore: store, capabilities: caps, receiptKey: RECEIPT_KEY })).toThrow(/regtest, not ycash:mainnet/);
  });
});

describe("sapling-proof facilitator: settle", () => {
  const issue = (extra: Record<string, unknown> = {}) => handler.enhanceRequirements(template(extra), RESOURCE);

  it("settles a confirmed payment once, with a receipt that verifies, and no payer", async () => {
    const req = await issue();
    wallet.pay(req.payTo, 1_500_000, req.extra.memo as string, 1);
    const res = await handler.settle(payloadFor(req), req);
    expect(res).toMatchObject({ success: true, transaction: TXID, network: YCASH_REGTEST, extra: { status: "confirmed", confirmations: 1, receivedZat: "1500000" } });
    expect(res.payer).toBeUndefined();
    const receipt = (res.extensions as { "offer-receipt": { info: { receipt: JwsSignedArtifact } } })["offer-receipt"].info.receipt;
    expect(verifyReceipt(receipt, { trustedPublicKeys: [secp.getPublicKey(RECEIPT_KEY, true)] })).toEqual({ version: 1, network: YCASH_REGTEST, resourceUrl: RESOURCE, payer: "anonymous", issuedAt: NOW, transaction: TXID });
    expect(await store.isClaimed(`ycash:regtest:${TXID}@${req.payTo}`)).toBe(true);
    // the same proof again
    expect(await handler.settle(payloadFor(req), req)).toMatchObject({ success: false, errorReason: ERR.duplicateSettlement, transaction: TXID });
  });
  it("of two concurrent settles of one txid, exactly one succeeds", async () => {
    const req = await issue();
    wallet.pay(req.payTo, 1_500_000, req.extra.memo as string, 3);
    const rs = await Promise.all([handler.settle(payloadFor(req), req), handler.settle(payloadFor(req), req)]);
    expect(rs.filter((r) => r.success)).toHaveLength(1);
    expect(rs.filter((r) => r.errorReason === ERR.duplicateSettlement)).toHaveLength(1);
  });
  it("returns settlement_pending below the policy depth and claims nothing; policy -1 accepts the mempool", async () => {
    const req = await issue();
    wallet.pay(req.payTo, 1_500_000, req.extra.memo as string, 0);
    const pending = await handler.settle(payloadFor(req), req);
    expect(pending).toMatchObject({ success: false, errorReason: ERR.settlementPending, transaction: TXID, extra: { status: "pending", confirmations: -1 } });
    expect(pending.errorMessage).toMatch(/0 confirmations, the policy needs 1/);
    expect(await store.isClaimed(`ycash:regtest:${TXID}`)).toBe(false);

    const req0 = await issue({ confirmationPolicy: { confirmations: -1 } });
    wallet.pay(req0.payTo, 1_500_000, req0.extra.memo as string, 0, "77".repeat(32));
    expect(await handler.settle(payloadFor(req0, "77".repeat(32)), req0)).toMatchObject({ success: true, extra: { status: "mempool", confirmations: -1 } });
  });
  it("policy 0 means in a block, the same evidence as 1", () => {
    expect(meetsPolicy(-1, -1)).toBe(true);
    expect(meetsPolicy(-1, 0)).toBe(false);
    expect(meetsPolicy(1, 0)).toBe(true);
    expect(meetsPolicy(1, 1)).toBe(true);
    expect(meetsPolicy(5, 6)).toBe(false);
    expect(meetsPolicy(6, 6)).toBe(true);
  });
  it("rejects an underpayment (funds stay) and accepts an overpayment (kept)", async () => {
    const under = await issue();
    wallet.pay(under.payTo, 1_499_999, under.extra.memo as string, 1);
    expect(await handler.settle(payloadFor(under), under)).toMatchObject({ success: false, errorReason: ERR.underpaid });
    const over = await issue();
    wallet.pay(over.payTo, 9_000_000, over.extra.memo as string, 1, "88".repeat(32));
    expect(await handler.settle(payloadFor(over, "88".repeat(32)), over)).toMatchObject({ success: true, extra: { receivedZat: "9000000" } });
  });
  it("sums the notes of one txid at payTo; a single memo-bearing note is enough", async () => {
    const req = await issue();
    wallet.pay(req.payTo, 1_000_000, req.extra.memo as string, 2);
    wallet.pay(req.payTo, 500_000, "", 2);
    wallet.pay(req.payTo, 9_999_999, req.extra.memo as string, 2, "99".repeat(32)); // another tx does not count
    expect(await handler.settle(payloadFor(req), req)).toMatchObject({ success: true, extra: { receivedZat: "1500000", confirmations: 2 } });
  });
  it("names each unmet condition", async () => {
    const req = await issue();
    // not received (nothing claimed: it may still arrive)
    expect(await handler.settle(payloadFor(req), req)).toMatchObject({ errorReason: ERR.notReceived, transaction: TXID });
    // wrong memo
    wallet.pay(req.payTo, 1_500_000, "x402:" + "0".repeat(64), 1);
    expect(await handler.settle(payloadFor(req), req)).toMatchObject({ errorReason: ERR.memoMismatch });
    // malformed txid
    expect(await handler.settle(payloadFor(req, TXID.toUpperCase()), req)).toMatchObject({ errorReason: ERR.txidMalformed });
    expect(await handler.settle({ ...payloadFor(req), payload: {} }, req)).toMatchObject({ errorReason: ERR.txidMalformed });
  });
  it("binds the proof to the request: a txid that paid another request settles nothing here", async () => {
    const a = await issue();
    const b = await issue();
    wallet.pay(a.payTo, 1_500_000, a.extra.memo as string, 1);
    expect(await handler.settle(payloadFor(b), b)).toMatchObject({ errorReason: ERR.notReceived });
    // and a's memo sent to b's address is the wrong commitment
    wallet.pay(b.payTo, 1_500_000, a.extra.memo as string, 1, "aa".repeat(32));
    expect(await handler.settle(payloadFor(b, "aa".repeat(32)), b)).toMatchObject({ errorReason: ERR.memoMismatch });
  });
  it("refuses requirements this server did not issue, or altered ones", async () => {
    const req = await issue();
    wallet.pay(req.payTo, 1_500_000, req.extra.memo as string, 1);
    const forgedTo = { ...req, payTo: "yregtestsapling1other" };
    expect(await handler.settle(payloadFor(forgedTo), forgedTo)).toMatchObject({ errorReason: ERR.unknownInstrument });
    const cheaper = { ...req, amount: "1" };
    expect(await handler.settle(payloadFor(cheaper), cheaper)).toMatchObject({ errorReason: ERR.unknownInstrument });
    const otherMemo = { ...req, extra: { ...req.extra, memo: "x402:" + "1".repeat(64) } };
    expect(await handler.settle(payloadFor(otherMemo), otherMemo)).toMatchObject({ errorReason: ERR.unknownInstrument });
    // once the record is pruned the address is no longer a held request
    now = NOW + 600 + 150 + 3600 + 1;
    await handler.server.registry.prune(now);
    expect(await handler.settle(payloadFor(req), req)).toMatchObject({ errorReason: ERR.unknownInstrument });
  });
  it("checks the envelope", async () => {
    const req = await issue();
    wallet.pay(req.payTo, 1_500_000, req.extra.memo as string, 1);
    const p = payloadFor(req);
    expect(await handler.settle({ ...p, x402Version: 1 }, req)).toMatchObject({ errorReason: ERR.requirementsMismatch });
    expect(await handler.settle({ ...p, accepted: { ...p.accepted, amount: "1" } }, req)).toMatchObject({ errorReason: ERR.requirementsMismatch });
    expect(await handler.settle({ ...p, accepted: { ...p.accepted, extra: { ...p.accepted.extra, expiresAt: 1 } } }, req)).toMatchObject({ errorReason: ERR.requirementsMismatch });
    expect(await handler.settle({ ...p, accepted: { ...p.accepted, extra: { ...p.accepted.extra, paymentFlow: "authorization" } } }, req)).toMatchObject({ errorReason: ERR.paymentFlow });
    expect(await handler.settle({ ...p, accepted: { ...p.accepted, extra: { ...p.accepted.extra, assetTransferMethod: "sapling" } } }, req)).toMatchObject({ errorReason: ERR.assetTransferMethod });
    const noMemo = { ...req, extra: { ...req.extra, memo: undefined } };
    expect(await handler.settle(payloadFor(noMemo), noMemo)).toMatchObject({ errorReason: ERR.requirementsMismatch });
    // an additive client field is fine
    expect(await handler.settle({ ...p, accepted: { ...p.accepted, extra: { ...p.accepted.extra, clientNote: 1 } } }, req)).toMatchObject({ success: true });
  });
  it("refuses a merchant node on another chain", async () => {
    const req = await issue();
    wallet.chain = "main";
    expect(await handler.settle(payloadFor(req), req)).toMatchObject({ errorReason: ERR.networkMismatch });
  });
  it("releases the claim when the attempt ends abnormally after it", async () => {
    const broken: JwsSigner = { format: "jws", algorithm: "ES256K", kid: "did:jwk:x", sign: async () => Promise.reject(new Error("HSM offline")) };
    const h = makeHandler({ signer: broken });
    const req = await h.enhanceRequirements(template(), RESOURCE);
    wallet.pay(req.payTo, 1_500_000, req.extra.memo as string, 1);
    expect(await h.settle(payloadFor(req), req)).toMatchObject({ success: false, errorReason: ERR.unexpected });
    expect(await store.isClaimed(`ycash:regtest:${TXID}`)).toBe(false);
  });
  it("verify is the read-only dry run: it never claims", async () => {
    const req = await issue();
    wallet.pay(req.payTo, 1_500_000, req.extra.memo as string, 1);
    expect(await handler.verify(payloadFor(req), req)).toMatchObject({ isValid: true, extra: { status: "confirmed" } });
    expect(await store.isClaimed(`ycash:regtest:${TXID}`)).toBe(false);
    await handler.settle(payloadFor(req), req);
    expect(await handler.verify(payloadFor(req), req)).toMatchObject({ isValid: false, invalidReason: ERR.duplicateSettlement });
  });
});

/** The payer node: records z_sendmany calls. */
class MockPayer {
  line: "v4" | "v6" = "v6";
  chain = "regtest";
  sent: { from: string; recipients: ZRecipient[]; opts: ZSendManyOptions | undefined }[] = [];
  async capabilities(): Promise<NodeCapabilities> {
    return { line: this.line, subversion: "", version: 0, yellowback: false, chain: this.chain };
  }
  async getBlockchainInfo(): Promise<BlockchainInfo> {
    return { chain: this.chain } as BlockchainInfo;
  }
  async zSendMany(from: string, recipients: ZRecipient[], opts?: ZSendManyOptions): Promise<string> {
    this.sent.push({ from, recipients, opts });
    return "opid-1";
  }
  async waitForOperation(opid: string): Promise<string> {
    expect(opid).toBe("opid-1");
    return TXID;
  }
}

describe("sapling-proof client", () => {
  const ZFROM = "yregtestsapling1payer";
  const TFROM = "smRtYkqrCqVJ2Kk1N3jqvKXyEZ3QnQqgdPa";

  it("sends exactly amount to payTo with the memo's UTF-8 bytes, and returns the txid", async () => {
    const payer = new MockPayer();
    const req = await handler.enhanceRequirements(template(), RESOURCE);
    const client = new ShieldedExactClient({ rpc: payer, from: ZFROM, now: () => now });
    expect(await client.createPaymentPayload(2, req)).toEqual({ x402Version: 2, payload: { txid: TXID } });
    const call = payer.sent[0]!;
    expect(call.from).toBe(ZFROM);
    expect(call.recipients).toEqual([{ address: req.payTo, amount: 1_500_000n, memo: memoToHex(req.extra.memo as string) }]);
    expect(call.opts).toEqual({ minconf: 1 }); // P1 on v6: the node's default FullPrivacy
  });
  it("passes AllowFullyTransparent for a transparent source on v6 only (X-F12)", async () => {
    const req = await handler.enhanceRequirements(template(), RESOURCE);
    const v6 = new MockPayer();
    await new ShieldedExactClient({ rpc: v6, from: TFROM, now: () => now }).createPaymentPayload(2, req);
    expect(v6.sent[0]!.opts).toEqual({ minconf: 1, privacyPolicy: "AllowFullyTransparent" });
    const v4 = new MockPayer();
    v4.line = "v4";
    await new ShieldedExactClient({ rpc: v4, from: TFROM, fee: 10_000n, now: () => now }).createPaymentPayload(2, req);
    expect(v4.sent[0]!.opts).toEqual({ minconf: 1, fee: 10_000n });
  });
  it("tells the tier from the source", () => {
    expect(tierOf(ZFROM, YCASH_REGTEST)).toBe("P1");
    expect(tierOf(TFROM, YCASH_REGTEST)).toBe("P0");
    expect(() => tierOf("ys1abc", YCASH_REGTEST)).toThrow();
  });
  it("pays nothing for an expired, malformed or wrong-chain requirement", async () => {
    const req = await handler.enhanceRequirements(template(), RESOURCE);
    const payer = new MockPayer();
    const late = new ShieldedExactClient({ rpc: payer, from: ZFROM, now: () => NOW + 601 });
    await expect(late.createPaymentPayload(2, req)).rejects.toThrow(/expired/);
    const client = new ShieldedExactClient({ rpc: payer, from: ZFROM, now: () => now });
    await expect(client.createPaymentPayload(2, { ...req, extra: { ...req.extra, memo: "hello" } })).rejects.toThrow(/memo/);
    await expect(client.createPaymentPayload(2, { ...req, extra: { ...req.extra, paymentFlow: "authorization" } })).rejects.toThrow(/upfront/);
    await expect(client.createPaymentPayload(2, { ...req, payTo: "smRtYkqrCqVJ2Kk1N3jqvKXyEZ3QnQqgdPa" })).rejects.toThrow(/Sapling/);
    payer.chain = "test";
    await expect(client.createPaymentPayload(2, req)).rejects.toThrow(/payer node is on test/);
    expect(payer.sent).toHaveLength(0);
  });
});
