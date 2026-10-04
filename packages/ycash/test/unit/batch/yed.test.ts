// YED payment channels (specs/scheme_batch_settlement_ycash.md, "YED Channels"; plan §5.8, X-7):
// the funding TRANSFER, the dollar floor, a TRANSFER on every spend, the overlay's verdict, against
// an in-process chain with the Yellowback overlay.
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { batch, channel, tx as T, yed, BatchYcashClientScheme, BatchYcashFacilitatorScheme, BatchYcashServerScheme } from "../../../src/index.js";
import { FakeChain } from "./fakeChain.js";
import { FakeYedChain } from "./fakeYedChain.js";
import { NET, reasonOf, serverPriv } from "./setup.js";

const E = batch.BatchError;
const payTo = T.encodeAddress(NET, "yed", T.hexToBytes("aa".repeat(20)));
const coinKey = T.hexToBytes("33".repeat(32));
const coinSpk = T.p2pkhScript(T.hash160(T.pubkeyFromPriv(coinKey)));

interface YedSetup {
  chain: FakeYedChain;
  server: BatchYcashServerScheme;
  client: BatchYcashClientScheme;
  req: PaymentRequirements;
  closes: { channelId: string; reason: string; txid: string | undefined; cumulative: bigint }[];
  wrap(payload: Record<string, unknown>, r?: PaymentRequirements): PaymentPayload;
  pay(r?: PaymentRequirements): Promise<PaymentPayload>;
  request(charge?: bigint, r?: PaymentRequirements): Promise<{ payload: PaymentPayload; cumulative: string }>;
  /** the open: refused below a block (X-F14), then served */
  open(): Promise<{ channelId: string; first: string }>;
}

/**
 * A YED channel offer at `price` with deposit D; the funder spends a token coin of `tokenCents`
 * (default D + 500) and a YEC coin. `tamper` rewrites the unsigned funding before it is signed.
 */
async function setup(o: { deposit?: bigint; price?: string; tokenCents?: number; tamper?: (tx: T.Tx) => void; chain?: FakeYedChain } = {}): Promise<YedSetup> {
  const chain = o.chain ?? new FakeYedChain();
  const closes: YedSetup["closes"] = [];
  const server = new BatchYcashServerScheme({
    chain, serverPrivKey: serverPriv, maxDeposit: 1_000_000n, maxDepositCents: 5_000n, minLockBlocks: 100, closeMarginBlocks: 10, usdAsset: "YED",
    onClose: (e) => closes.push(e),
  });
  const priced = await server.parsePrice(o.price ?? "$0.01", NET);
  const base: PaymentRequirements = { scheme: "batch-settlement", network: NET, asset: priced.asset, amount: priced.amount, payTo, maxTimeoutSeconds: 300, extra: {} };
  const req = await server.enhancePaymentRequirements(base, { x402Version: 2, scheme: "batch-settlement", network: NET }, []);
  let n = 0;
  const funder: batch.client.ChannelFunder = {
    async fund(fr) {
      expect(fr.asset).toBe("YED");
      const tid = (++n).toString(16).padStart(64, "d");
      const cid = (n).toString(16).padStart(64, "c");
      chain.addToken(tid, 0, o.tokenCents ?? Number(fr.deposit) + 500, coinSpk);
      chain.addCoin(cid, 0, 1_000_000n, coinSpk);
      const tokens = [{ outpoint: { txid: tid, vout: 0 }, cents: o.tokenCents ?? Number(fr.deposit) + 500, value: 10_000n, scriptPubKey: coinSpk }];
      const yecCoins = [{ outpoint: { txid: cid, vout: 0 }, value: 1_000_000n, scriptPubKey: coinSpk }];
      const built = channel.buildYedFundingTx({ redeemScript: fr.redeemScript, depositCents: fr.deposit!, closeFee: fr.value - channel.yedChannelValue(0n), tokens, yecCoins, yedChangeScript: coinSpk, yecChangeScript: coinSpk });
      o.tamper?.(built.tx);
      return T.serializeTxHex(channel.signFundingTx(built.tx, built.inputs, built.inputs.map(() => coinKey), fr.branchId));
    },
  };
  const client = new BatchYcashClientScheme({ chain, funder, deposit: () => o.deposit ?? 2_000n, lockSlackBlocks: 0 });
  const wrap = (payload: Record<string, unknown>, r = req): PaymentPayload => ({ x402Version: 2, accepted: r, payload });
  const pay = async (r = req) => wrap((await client.createPaymentPayload(2, r)).payload, r);
  const request = async (charge?: bigint, r = req) => {
    const payload = await pay(r);
    const v = await server.manager.verify(payload, r);
    const settle = await server.manager.settle(v, charge ?? BigInt(r.amount));
    await client.applySettleResponse(settle);
    return { payload, cumulative: (payload.payload as { cumulative?: string }).cumulative ?? "" };
  };
  const open = async () => {
    const payload = await pay();
    expect(await reasonOf(server.manager.verify(payload, req))).toBe(E.FUNDING_DEPTH);
    chain.mine();
    const v = await server.manager.verify(payload, req);
    await client.applySettleResponse(await server.manager.settle(v, BigInt(req.amount)));
    return { channelId: v.channelId, first: (payload.payload as { voucher: { cumulative: string } }).voucher.cumulative };
  };
  return { chain, server, client, req, closes, wrap, pay, request, open };
}

/** The TRANSFER of a broadcast transaction. */
function assignmentsOf(hex: string): yed.Assignment[] {
  const f = yed.findPayload(T.parseTx(hex).vout);
  return f && !yed.isFindPayloadFailure(f) && f.payload.type === "transfer" ? [...f.payload.assignments] : [];
}

describe("YED channel requirements and prices", () => {
  it("prices $0.01 as one cent (the floor binds the cumulative, not a request) and offers D in cents", async () => {
    const s = await setup();
    expect(s.req).toMatchObject({ asset: "YED", amount: "1", extra: { maxDeposit: "5000", closeFee: "1500", confirmationPolicy: { confirmations: 1 } } });
    expect(await s.server.parsePrice("0.25 YED", NET)).toEqual({ amount: "25", asset: "YED" });
    expect(await s.server.parsePrice({ amount: "7", asset: "YED" }, NET)).toEqual({ amount: "7", asset: "YED" });
    await expect(s.server.parsePrice("$0.001", NET)).rejects.toThrow(/whole number of cents/);
  });
  it("refuses a mempool funding policy for YED (X-F14)", async () => {
    const server = new BatchYcashServerScheme({ chain: new FakeYedChain(), serverPrivKey: serverPriv, maxDeposit: 1n, confirmations: -1 });
    const base: PaymentRequirements = { scheme: "batch-settlement", network: NET, asset: "YED", amount: "1", payTo, maxTimeoutSeconds: 300, extra: {} };
    await expect(server.enhancePaymentRequirements(base, { x402Version: 2, scheme: "batch-settlement", network: NET }, [])).rejects.toThrow(/at least 0/);
  });
});

describe("open: the funding TRANSFER", () => {
  it("assigns D to the P2SH output of V = 2 × TOKEN_VALUE + closeFee, YED change to the funder; the first voucher pre-pays $1.00", async () => {
    const s = await setup();
    const { channelId, first } = await s.open();
    expect(first).toBe("100");
    const funding = s.chain.sent[0]!;
    const tx = T.parseTx(funding);
    expect(tx.vout[0]?.value).toBe(21_500n);
    expect(assignmentsOf(funding)).toEqual([{ vout: 0, cents: 2_000 }, { vout: 1, cents: 500 }]);
    expect(s.chain.tokens.get(channelId)).toBe(2_000);
    expect((await s.server.manager.channelState(channelId)).deposit).toBe("2000");
  });
  it("refuses a channel output with another YEC value", async () => {
    const s = await setup({ tamper: (tx) => { tx.vout[0]!.value += 1n; tx.vout[3]!.value -= 1n; } });
    expect(await reasonOf(s.server.manager.verify(await s.pay(), s.req))).toBe(E.FUNDING);
  });
  it("refuses a funding without a TRANSFER, or one that does not assign the channel output", async () => {
    const none = await setup({ tamper: (tx) => { tx.vout.splice(2, 1); } });
    expect(await reasonOf(none.server.manager.verify(await none.pay(), none.req))).toBe(E.FUNDING);
    const other = await setup({ tamper: (tx) => { tx.vout[2] = { value: 0n, scriptPubKey: yed.transferOpReturnScript([{ vout: 1, cents: 2_500 }]) }; } });
    expect(await reasonOf(other.server.manager.verify(await other.pay(), other.req))).toBe(E.FUNDING);
  });
  it("refuses a funding the overlay says burns (the token holds more than it assigns)", async () => {
    // the funder's token holds 3,000 but the TRANSFER assigns 2,000 + 500: 500 would burn
    const s = await setup({ tokenCents: 3_000, tamper: (tx) => { tx.vout[2] = { value: 0n, scriptPubKey: yed.transferOpReturnScript([{ vout: 0, cents: 2_000 }, { vout: 1, cents: 500 }]) }; } });
    expect(await reasonOf(s.server.manager.verify(await s.pay(), s.req))).toBe(E.YED_VERDICT);
  });
  it("caps D at maxDeposit on the client, and refuses D above it on the server", async () => {
    const s = await setup({ deposit: 6_000n });
    const p = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
    expect(assignmentsOf(p.fundingTx)[0]).toEqual({ vout: 0, cents: 5_000 });
    const terms = { ...batch.parseTerms(s.req), maxDeposit: 4_999n };
    expect(await reasonOf(batch.verifyOpen(p, terms, s.chain, { tip: s.chain.tip, branchId: s.chain.branchId }))).toBe(E.DEPOSIT_TOO_LARGE);
  });
  it("needs a Yellowback node: a stock chain, or one answering −32601, is yed_node_required", async () => {
    const stockServer = new BatchYcashServerScheme({ chain: new FakeChain(), serverPrivKey: serverPriv, maxDeposit: 1n, usdAsset: "YED" });
    const s = await setup();
    expect(await reasonOf(stockServer.manager.verify(await s.pay(), s.req))).toBe(E.YED_NODE_REQUIRED);
    const chain = new FakeYedChain();
    chain.stock = true;
    const t = await setup({ chain });
    expect(await reasonOf(t.server.manager.verify(await t.pay(), t.req))).toBe(E.YED_NODE_REQUIRED);
  });
});

describe("vouchers under the dollar floor (X-7)", () => {
  it("$0.01 requests consume the pre-paid dollar first, then the cumulative grows by the ceiling", async () => {
    const s = await setup();
    await s.open(); // charged 1
    const cum: string[] = [];
    for (let i = 0; i < 101; i++) cum.push((await s.request()).cumulative);
    expect(cum.slice(0, 99).every((c) => c === "100")).toBe(true);
    expect(cum.slice(99)).toEqual(["101", "102"]);
  });
  it("refuses a voucher below $1.00", async () => {
    const s = await setup({ price: "$0.25" });
    const { channelId } = await s.open();
    const rec = (await s.client.storage.get(channelId))!;
    const ch = batch.client.channelOfRecord(rec);
    const low = channel.buildVoucher({ channel: ch, cumulative: 50n, clientScript: T.hexToBytes(rec.clientScript), clientPrivKey: T.hexToBytes(rec.clientPrivKey), branchId: s.chain.branchId,
      layout: ({ channel: c, clientScript }) => [{ value: 10_000n, scriptPubKey: c.payToScript }, { value: 10_000n, scriptPubKey: clientScript! }, { value: 0n, scriptPubKey: yed.transferOpReturnScript([{ vout: 0, cents: 100 }, { vout: 1, cents: 1_900 }]) }] });
    // the server answers stale first (its stored voucher is at 100); a stateless facilitator checks the floor
    expect(await reasonOf(s.server.manager.verify(s.wrap({ type: "voucher", channelId, tx: T.serializeTxHex(low), cumulative: "50" }), s.req))).toBe(E.STALE_VOUCHER);
    const fac = new BatchYcashFacilitatorScheme({ rpc: s.chain });
    expect(await fac.verify(s.wrap({ type: "voucher", channelId, tx: T.serializeTxHex(low), cumulative: "50" }), s.req)).toMatchObject({ isValid: false, invalidReason: E.YED_FLOOR });
  });
  it("the remainder rule: a client remainder in (0, $1.00) goes to the server, and the server closes", async () => {
    const s = await setup();
    await s.open();
    await s.request(); // cumulative 100, charged 2
    expect(s.closes).toEqual([]);
    const last = await s.request(undefined, { ...s.req, amount: "1950" }); // 2 + 1,950 = 1,952: remainder 48
    expect(last.cumulative).toBe("1952");
    expect(assignmentsOf(T.serializeTxHex(T.parseTx((last.payload.payload as { tx: string }).tx)))).toEqual([{ vout: 0, cents: 2_000 }]);
    expect(s.closes.map((c) => c.reason)).toEqual(["exhausted"]);
    const close = s.chain.sent.at(-1)!;
    expect(assignmentsOf(close)).toEqual([{ vout: 0, cents: 2_000 }]);
    expect(T.parseTx(close).vout.map((o) => o.value)).toEqual([10_000n, 10_000n, 0n]); // constant shape; vout 1 plain YEC
    s.chain.mine();
    expect(s.chain.tokens.get(`${T.txid(close)}:0`)).toBe(2_000);
  });
  it("exhaustion near D: the server closes while the client still gets exactly $1.00", async () => {
    const s = await setup({ deposit: 300n, price: "$0.50" });
    await s.open();
    for (let i = 0; i < 3; i++) await s.request();
    expect(s.closes).toMatchObject([{ reason: "exhausted", cumulative: 200n }]);
    expect(assignmentsOf(s.chain.sent.at(-1)!)).toEqual([{ vout: 0, cents: 200 }, { vout: 1, cents: 100 }]);
  });
  it("a client close at max($1.00, charged)", async () => {
    const s = await setup({ price: "$0.25" });
    const { channelId } = await s.open(); // charged 25
    const close = s.wrap((await s.client.closePayload(channelId)).payload);
    expect((close.payload as { cumulative: string }).cumulative).toBe("100");
    const at25 = channel.buildVoucher({ ...voucherArgs(await s.client.storage.get(channelId), s.chain.branchId), cumulative: 100n, layout: channel.yedVoucherLayout(2_000n) });
    expect(T.serializeTxHex(at25)).toBe((close.payload as { tx: string }).tx);
    const v = await s.server.manager.verify(close, s.req);
    const r = await s.server.manager.settle(v, 0n);
    expect(r.success).toBe(true);
    expect(assignmentsOf(s.chain.sent.at(-1)!)).toEqual([{ vout: 0, cents: 100 }, { vout: 1, cents: 1_900 }]);
  });
  it("refuses a voucher the overlay decodes differently, or whose yedIn is not D", async () => {
    const s = await setup();
    await s.open();
    s.chain.decodeOverride = { valid: true, version: 3, type: "transfer", reason: "", opReturnIndex: 2, assignments: [{ vout: 0, cents: 100 }] };
    expect(await reasonOf(s.request())).toBe(E.YED_VERDICT);
    s.chain.decodeOverride = undefined;
    const [id] = [...s.chain.tokens.keys()].filter((k) => s.chain.tokens.get(k) === 2_000);
    s.chain.tokens.set(id!, 1_999); // the record says something else than the open did
    expect(await reasonOf(s.request())).toBe(E.YED_VERDICT);
  });
});

function voucherArgs(rec: batch.client.ClientChannelRecord | undefined, branchId: number) {
  return { channel: batch.client.channelOfRecord(rec!), clientScript: T.hexToBytes(rec!.clientScript), clientPrivKey: T.hexToBytes(rec!.clientPrivKey), branchId };
}

describe("refund with payload", () => {
  it("assigns all of D to the client's output (vout 1): the overlay registers it, nothing burns", async () => {
    const s = await setup({ deposit: 500n });
    const { channelId } = await s.open();
    const rec = (await s.client.storage.get(channelId))!;
    s.chain.mine(rec.refundHeight - s.chain.tip);
    const txid = await s.client.refund(channelId);
    const hex = s.chain.sent.at(-1)!;
    expect(T.txid(hex)).toBe(txid);
    expect(assignmentsOf(hex)).toEqual([{ vout: 1, cents: 500 }]);
    expect(await s.chain.yedValidateRawTransaction(hex)).toMatchObject({ valid: true, verdict: "ok", yedIn: 500, yedOut: 500, burned: 0 });
    s.chain.mine();
    expect(s.chain.tokens.get(`${txid}:1`)).toBe(500);
  });
});

describe("a stateless facilitator", () => {
  it("verifies vouchers and claims with D read from the overlay; refuses a burning claim and an unconfirmed channel", async () => {
    const s = await setup();
    const fac = new BatchYcashFacilitatorScheme({ rpc: s.chain });
    const openPayload = await s.pay();
    expect(await fac.verify(openPayload, s.req)).toMatchObject({ isValid: true });
    await s.server.manager.verify(openPayload, s.req).catch(() => undefined); // relays the funding
    const early = await s.pay(); // the same open, resent
    expect(early.payload).toEqual(openPayload.payload);
    s.chain.mine();
    const v = await s.server.manager.verify(openPayload, s.req);
    await s.client.applySettleResponse(await s.server.manager.settle(v, 1n));
    const { payload } = await s.request();
    expect(await fac.verify(payload, s.req)).toMatchObject({ isValid: true });
    const p = payload.payload as { channelId: string; tx: string; cumulative: string };
    const rec = (await s.client.storage.get(p.channelId))!;
    const ch = batch.client.channelOfRecord(rec);
    const claim = T.serializeTxHex(channel.completeVoucher(T.parseTx(p.tx), ch, serverPriv, s.chain.branchId));
    expect(await fac.verify(s.wrap({ type: "claim", channelId: p.channelId, tx: claim, cumulative: p.cumulative }), s.req)).toMatchObject({ isValid: true });
    // the burning voucher: right outputs, a TRANSFER of $1.00 out of $20.00
    const burning = channel.buildVoucher({ ...voucherArgs(rec, s.chain.branchId), cumulative: 100n,
      layout: ({ channel: c, clientScript }) => [{ value: 10_000n, scriptPubKey: c.payToScript }, { value: 10_000n, scriptPubKey: clientScript! }, { value: 0n, scriptPubKey: yed.transferOpReturnScript([{ vout: 0, cents: 100 }]) }] });
    const bClaim = T.serializeTxHex(channel.completeVoucher(burning, ch, serverPriv, s.chain.branchId));
    expect(await s.chain.yedValidateRawTransaction(bClaim)).toMatchObject({ verdict: "burned", burned: 1_900 });
    expect(await fac.verify(s.wrap({ type: "claim", channelId: p.channelId, tx: bClaim, cumulative: "100" }), s.req)).toMatchObject({ isValid: false, invalidReason: E.VOUCHER_SHAPE });
  });
  it("a voucher on a funding still in the mempool: funding_depth (the overlay has no record yet)", async () => {
    const s = await setup();
    const fac = new BatchYcashFacilitatorScheme({ rpc: s.chain });
    const openPayload = await s.pay();
    await s.server.manager.verify(openPayload, s.req).catch(() => undefined); // relayed, not mined
    const o = openPayload.payload as unknown as batch.BatchOpenPayload;
    const channelId = `${T.txid(o.fundingTx)}:0`;
    expect(await fac.verify(s.wrap({ type: "voucher", channelId, tx: o.voucher.tx, cumulative: o.voucher.cumulative }), s.req)).toMatchObject({ isValid: false, invalidReason: E.FUNDING_DEPTH });
  });
});

describe("pure rules", () => {
  it("closeCumulative, cumulativeFloor, isExhausted, layoutFor", () => {
    expect(batch.closeCumulative("YED", 25n)).toBe(100n);
    expect(batch.closeCumulative("YED", 250n)).toBe(250n);
    expect(batch.closeCumulative("YEC", 25n)).toBe(25n);
    expect(batch.cumulativeFloor("YED")).toBe(100n);
    expect(batch.cumulativeFloor("YEC")).toBe(0n);
    // YED: next = max(100, charged + ceiling); close if it exceeds D or leaves (0, 100)
    expect(batch.isExhausted("YED", 2_000n, 1_899n, 1n, 1_899n)).toBe(false); // next 1,900: remainder 100
    expect(batch.isExhausted("YED", 2_000n, 1_900n, 1n, 1_900n)).toBe(true); // next 1,901: remainder 99
    expect(batch.isExhausted("YED", 2_000n, 1_000n, 1_000n, 1_000n)).toBe(false); // next = D exactly: fine
    expect(batch.isExhausted("YED", 2_000n, 10n, 1n, 1_950n)).toBe(true); // the latest already gave all of D to the server
    expect(batch.isExhausted("YEC", 2_000n, 1_000n, 1_001n, 1_000n)).toBe(true);
    expect(batch.layoutFor("YEC", 1n)).toBe(channel.yecVoucherOutputs);
    expect(() => batch.layoutFor("BTC", 1n)).toThrow(/no channel layout/);
  });
});
