// X3 acceptance on a live devnet (plan §7 X3, §4.3): YED per request at ≥ $1 (`exact`, through
// @x402/core's client, resource server and facilitator) and YED payment channels
// (`batch-settlement`), on either node line. Node 0 runs -yellowback: it mints the YED, hosts the
// facilitator and the channel server. Payments and closes are mined by node 2, a Yellowback pool
// under the default `strict` template policy (OP-2). The burning voucher goes through node 1 (stock).
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { beforeAll, expect, it } from "vitest";
import { batch, channel, exact, yed, BatchYcashClientScheme, BatchYcashServerScheme, BatchYcashFacilitatorScheme, rpcWalletFunder } from "../../src/index.js";
import type { YcashRpc, YedValidation } from "../../src/node/index.js";
import { InMemorySettlementStore } from "../../src/store/index.js";
import * as T from "../../src/tx/index.js";
import { describeDevnet, devnet, record, waitFor, type Devnet } from "./harness.js";

const NET = "ycash:regtest" as const;
const E = batch.BatchError;
const MIN_LOCK = 30;
const MARGIN = 5;
const SLACK = 3;
const URL = { url: "https://merchant.test/yed" };

let d: Devnet;

interface Key {
  priv: Uint8Array;
  script: Uint8Array;
  address: string;
  yr: string;
}

function newKey(): Key {
  const priv = T.randomPrivKey();
  const h = T.hash160(T.pubkeyFromPriv(priv));
  return { priv, script: T.p2pkhScript(h), address: T.encodeAddress(NET, "p2pkh", h), yr: T.encodeAddress(NET, "yed", h) };
}

/** Yellowback's circulating supply, cents (yed_getstats, ycash-dd/src/rpc/yellowback.cpp:796). */
async function supply(): Promise<number> {
  await d.syncBlocks();
  return (await d.wallet.call<{ supplyCents: number }>("yed_getstats")).supplyCents;
}

/** The YED token records paying `address` (any form of its key hash), as node 0's index has them. */
async function tokensOf(address: string): Promise<{ txid: string; vout: number; cents: number; valueZat: number }[]> {
  return d.wallet.call("yed_listtokens", [[address]]);
}

/** Node 0's confirmed YED, minting more when short (the lean --no-attest devnet mints). */
async function ensureYed(cents: number): Promise<void> {
  const balance = async () => (await d.wallet.call<{ confirmedCents: number }>("yed_getbalance")).confirmedCents;
  if ((await balance()) >= cents) return;
  await d.wallet.call("yed_mint", [cents, 48, "", "", false]);
  await waitFor(async () => (await d.mine(1), (await balance()) >= cents), { timeoutMs: 180_000, pollMs: 500, what: "the MINT" });
}

/** yed_send from node 0's wallet, retried while its YED settles into the index; returns the txid. */
async function yedSend(to: string, cents: number): Promise<string> {
  let txid = "";
  await waitFor(async () => {
    try {
      txid = await d.wallet.call<string>("yed_send", [to, cents]);
      return true;
    } catch {
      await d.mine(1);
      return false;
    }
  }, { timeoutMs: 60_000, what: "yed_send" });
  return txid;
}

/** Mines one block on the Yellowback pool (node 2, `strict`) and checks it carries `txid` (OP-2). */
async function mineOnPool(txid: string): Promise<void> {
  await waitFor(async () => (await d.pool.getRawMempool()).includes(txid), { what: `${txid} at the pool` });
  const [hash] = await d.mine(1, d.pool);
  const block = await d.pool.call<{ tx: string[] }>("getblock", [hash]);
  expect(block.tx).toContain(txid);
}

async function mineMany(n: number): Promise<void> {
  for (let left = n; left > 0; left -= 8) await d.mine(Math.min(8, left));
}

describeDevnet("YED on a live devnet: exact at ≥ $1 and payment channels", () => {
  let payer: Key;
  let merchant: Key;
  let facilitatorScheme: exact.ExactYcashFacilitatorScheme;
  let server: x402ResourceServer;
  let stockServer: x402ResourceServer;

  async function stack(node: YcashRpc): Promise<{ server: x402ResourceServer; scheme: exact.ExactYcashFacilitatorScheme }> {
    const scheme = new exact.ExactYcashFacilitatorScheme(node, {
      settlementStore: new InMemorySettlementStore(), confirmationTimeoutMs: 30_000, confirmationPollMs: 250, yellowback: (await node.capabilities()).yellowback,
    });
    const facilitator = new x402Facilitator().register(NET, scheme);
    const client = {
      verify: (p: PaymentPayload, r: PaymentRequirements) => facilitator.verify(p, r),
      settle: (p: PaymentPayload, r: PaymentRequirements) => facilitator.settle(p, r),
      getSupported: async () => facilitator.getSupported() as SupportedResponse,
    };
    const s = new x402ResourceServer(client).register(NET, new exact.ExactYcashServerScheme({ usdAsset: "YED" }));
    await s.initialize();
    return { server: s, scheme };
  }

  const payerClient = () => {
    const source = new exact.RpcUtxoSource(d.wallet, { importAddress: true });
    const c = new x402Client().register(NET, new exact.ExactYcashScheme(new exact.LocalKeySigner(T.encodeWif(payer.priv, NET), source)));
    c.setSpendControls({ maxAmountPerPayment: "$50" }); // YED is a default asset: core's USD cap applies
    return c;
  };

  async function requirements(s: x402ResourceServer, price: string): Promise<PaymentRequirements> {
    const [req] = await s.buildPaymentRequirements({ scheme: "exact", network: NET, payTo: merchant.yr, price, maxTimeoutSeconds: 600 });
    return req as PaymentRequirements;
  }

  /**
   * A payment the SDK would never build: input 0 the payer's token output, input 1 a YEC coin;
   * outputs payTo, the payer's change output, the TRANSFER of `assignments`, YEC change.
   */
  async function handBuilt(token: { txid: string; vout: number; valueZat: number }, assignments: yed.Assignment[]): Promise<string> {
    const fee = (await new exact.RpcUtxoSource(d.wallet).listCoins(payer.address))[0]!;
    const tokenValue = BigInt(token.valueZat);
    const tx = T.newTx({
      vin: [token, fee].map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: new Uint8Array(), sequence: T.SEQUENCE_FINAL })),
      vout: [
        { value: 10_000n, scriptPubKey: merchant.script },
        { value: 10_000n, scriptPubKey: payer.script },
        { value: 0n, scriptPubKey: yed.transferOpReturnScript(assignments) },
        { value: tokenValue + fee.value - 20_000n - 2_000n, scriptPubKey: payer.script },
      ],
      expiryHeight: (await d.tip()) + 10,
    });
    return signP2pkh(tx, payer, [tokenValue, fee.value]);
  }

  /** verify → (the resource) → settle, the payment mined by the pool once it reaches its mempool. */
  async function settleFlow(pl: PaymentPayload, req: PaymentRequirements): Promise<{ v: VerifyResponse; settled?: SettleResponse }> {
    const v = await server.verifyPayment(pl, req);
    if (!v.isValid) return { v };
    const settling = server.settlePayment(pl, req);
    await mineOnPool(T.txid((pl.payload as { transaction: string }).transaction));
    return { v, settled: await settling };
  }

  beforeAll(async () => {
    d = await devnet();
    expect(d.caps.yellowback).toBe(true);
    await ensureYed(20_000);
    payer = newKey();
    merchant = newKey();
    await d.wallet.call("importaddress", [payer.address, "", false]);
    for (let i = 0; i < 3; i++) await d.fund(payer.address, 1);
    await yedSend(payer.yr, 5_000);
    await d.mine(1);
    await yedSend(payer.yr, 300);
    await d.mine(1);
    ({ server } = await stack(d.wallet));
    facilitatorScheme = (await stack(d.wallet)).scheme;
    ({ server: stockServer } = await stack(d.stock));
    for (const n of [d.pool]) record(d.line, "pool template policy", (await n.call<{ templatePolicy: string }>("yed_getinfo")).templatePolicy);
  });

  it("exact YED at $1 and $25 through @x402/core: one assignment to payTo, YED change, mined by a strict pool; supply unchanged", async () => {
    const before = await supply();
    const client = payerClient();
    const results: Record<string, unknown> = {};
    for (const price of ["$1", "$25"]) {
      const req = await requirements(server, price);
      expect(req).toMatchObject({ asset: "YED", amount: price === "$1" ? "100" : "2500", extra: { assetTransferMethod: "transparent", confirmationPolicy: { confirmations: 1 } } });
      const pl = await client.createPaymentPayload(await server.createPaymentRequiredResponse([req], URL));
      const hex = (pl.payload as { transaction: string }).transaction;
      const dec = await d.wallet.yedDecodePayload(hex);
      const r = await settleFlow(pl, req);
      expect(r.v).toMatchObject({ isValid: true, payer: payer.yr });
      expect(r.settled).toMatchObject({ success: true, transaction: T.txid(hex), payer: payer.yr, extra: { status: "confirmed", confirmations: 1 } });
      results[price] = { txid: T.txid(hex), assignments: dec.assignments, opReturnIndex: dec.opReturnIndex };
    }
    await d.syncBlocks();
    expect((await tokensOf(merchant.yr)).map((t) => t.cents).sort((a, b) => a - b)).toEqual([100, 2500]);
    // 5,000 + 300 in; 100 and 2,500 out: the payer keeps 2,700 as YED change
    expect((await tokensOf(payer.yr)).reduce((s, t) => s + t.cents, 0)).toBe(2_700);
    expect(await supply()).toBe(before);
    record(d.line, "X3 exact YED", results);
  });

  it("exact YED through the RPC wallet signer (node 0's own YED)", async () => {
    const before = await supply();
    const client = new x402Client().register(NET, new exact.ExactYcashScheme(new exact.RpcWalletSigner(d.wallet)));
    const req = await requirements(server, "1 YED");
    const pl = await client.createPaymentPayload(await server.createPaymentRequiredResponse([req], URL));
    const r = await settleFlow(pl, req);
    expect(r.settled?.success).toBe(true);
    expect(await supply()).toBe(before);
  });

  it("exact YED at $0.50 is refused: by the server's price, and by the facilitator (the burn guard)", async () => {
    const before = await supply();
    await expect(server.buildPaymentRequirements({ scheme: "exact", network: NET, payTo: merchant.yr, price: "$0.50", maxTimeoutSeconds: 600 })).rejects.toThrow(/100\.\.10000000 cents/);
    // A requirement at 50 cents (from a server that skipped the check) and a payment that assigns 50 cents.
    const req = { ...(await requirements(server, "$1")), amount: "50" };
    const token = (await tokensOf(payer.yr)).sort((a, b) => b.cents - a.cents)[0]!;
    // 50 cents to payTo, the rest as change: XFER-1 refuses the 50, and the whole yedIn burns
    const hex = await handBuilt(token, [{ vout: 0, cents: 50 }, { vout: 1, cents: token.cents - 50 }]);
    const overlay = await d.wallet.yedValidateRawTransaction(hex);
    expect(overlay.verdict).not.toBe("ok"); // the node agrees: XFER-1 burns all of it
    const v = await facilitatorScheme.verify({ x402Version: 2, accepted: req, payload: { transaction: hex } }, req);
    expect(v).toMatchObject({ isValid: false, invalidReason: exact.ERR_REQUIREMENTS_MISMATCH });
    // the same transaction against honest $1.00 requirements: the assignment is not amount
    const honest = await requirements(server, "$1");
    const v2 = await facilitatorScheme.verify({ x402Version: 2, accepted: honest, payload: { transaction: hex } }, honest);
    expect(v2.isValid).toBe(false);
    expect([exact.ERR_YED_PAYLOAD, exact.ERR_AMOUNT_MISMATCH]).toContain(v2.invalidReason);
    expect(await supply()).toBe(before);
    record(d.line, "X3 exact YED $0.50", { overlayVerdict: overlay.verdict, burned: overlay.burned, facilitator50: v.invalidReason, facilitator100: v2.invalidReason });
  });

  it("an under-assigning YED payment (it would burn the rest) is refused with yed_verdict; a stock facilitator refuses YED outright", async () => {
    const token = (await tokensOf(payer.yr)).sort((a, b) => b.cents - a.cents)[0]!;
    const hex = await handBuilt(token, [{ vout: 0, cents: 100 }]); // the rest of yedIn is not assigned
    const req = await requirements(server, "$1");
    const v = await facilitatorScheme.verify({ x402Version: 2, accepted: req, payload: { transaction: hex } }, req);
    const overlay: YedValidation = await d.wallet.yedValidateRawTransaction(hex);
    expect(overlay).toMatchObject({ verdict: "burned", burned: token.cents - 100 });
    expect(v).toMatchObject({ isValid: false, invalidReason: exact.ERR_YED_VERDICT });
    // stock facilitator: no YED in /supported, and a YED payment is yed_node_required
    await expect(requirements(stockServer, "$1")).rejects.toThrow(/does not settle YED/);
    const stock = new exact.ExactYcashFacilitatorScheme(d.stock);
    expect(stock.getExtra(NET)?.assets).toEqual(["YEC"]);
    expect(await stock.verify({ x402Version: 2, accepted: req, payload: { transaction: hex } }, req)).toMatchObject({ isValid: false, invalidReason: exact.ERR_YED_NODE_REQUIRED });
    record(d.line, "X3 exact YED under-assigned", { overlay: { verdict: overlay.verdict, yedIn: overlay.yedIn, yedOut: overlay.yedOut, burned: overlay.burned }, facilitator: v.invalidReason });
  });

  // ------------------------------------------------------------------ channels

  interface Party {
    server: BatchYcashServerScheme;
    serverPriv: Uint8Array;
    client: BatchYcashClientScheme;
    req: PaymentRequirements;
    payTo: Key;
    closes: { channelId: string; reason: string; txid: string | undefined; cumulative: bigint }[];
  }

  async function party(deposit: bigint, price = "$0.01"): Promise<Party> {
    const closes: Party["closes"] = [];
    const serverPriv = T.randomPrivKey();
    const srv = new BatchYcashServerScheme({
      chain: d.wallet, serverPrivKey: serverPriv, maxDeposit: 100_000_000n, maxDepositCents: 10_000n, minLockBlocks: MIN_LOCK,
      closeMarginBlocks: MARGIN, confirmations: 1, usdAsset: "YED", onClose: (e) => closes.push(e),
    });
    const payTo = newKey();
    const priced = await srv.parsePrice(price, NET);
    const base: PaymentRequirements = { scheme: "batch-settlement", network: NET, asset: priced.asset, amount: priced.amount, payTo: payTo.yr, maxTimeoutSeconds: 300, extra: {} };
    const req = await srv.enhancePaymentRequirements(base, { x402Version: 2, scheme: "batch-settlement", network: NET }, []);
    const client = new BatchYcashClientScheme({ chain: d.wallet, funder: rpcWalletFunder(d.wallet), deposit: () => deposit, lockSlackBlocks: SLACK });
    return { server: srv, serverPriv, client, req, payTo, closes };
  }

  const wrap = (req: PaymentRequirements, payload: Record<string, unknown>): PaymentPayload => ({ x402Version: 2, accepted: req, payload });

  async function request(p: Party, req = p.req, charge?: bigint) {
    const payload = wrap(req, (await p.client.createPaymentPayload(2, req)).payload);
    const v = await p.server.manager.verify(payload, req);
    const settle = await p.server.manager.settle(v, charge ?? BigInt(req.amount));
    await p.client.applySettleResponse(settle);
    return { payload, settle, v };
  }

  /** The open: refused below the funding depth (YED needs a block, X-F14), accepted once mined. */
  async function open(p: Party): Promise<{ channelId: string; first: string }> {
    const payload = wrap(p.req, (await p.client.createPaymentPayload(2, p.req)).payload);
    await expect(p.server.manager.verify(payload, p.req)).rejects.toMatchObject({ reason: E.FUNDING_DEPTH });
    await mineOnPool(T.txid((payload.payload as { fundingTx: string }).fundingTx));
    const v = await p.server.manager.verify(payload, p.req);
    const settle = await p.server.manager.settle(v, BigInt(p.req.amount));
    await p.client.applySettleResponse(settle);
    return { channelId: v.channelId, first: (payload.payload as { voucher: { cumulative: string } }).voucher.cumulative };
  }

  it("a YED channel at D = $20 with $0.01 requests: the first voucher pre-pays $1.00, the remainder rule at the end, the close mined by a strict pool", async () => {
    const before = await supply();
    const p = await party(2_000n);
    expect(p.req).toMatchObject({ asset: "YED", amount: "1", extra: { maxDeposit: "10000", confirmationPolicy: { confirmations: 1 } } });
    const { channelId, first } = await open(p);
    expect(first).toBe("100");
    const fundingTxid = channelId.split(":")[0]!;
    const funding = await d.wallet.yedDecodePayload(await d.wallet.call<string>("getrawtransaction", [fundingTxid]));
    expect(funding.assignments).toContainEqual({ vout: 0, cents: 2_000 });
    const N = 200;
    const cumulatives: string[] = [];
    let mid: PaymentPayload | undefined;
    for (let i = 1; i < N; i++) {
      const r = await request(p);
      cumulatives.push((r.payload.payload as { cumulative: string }).cumulative);
      if (i === 150) mid = r.payload;
    }
    expect(cumulatives.slice(0, 98).every((c) => c === "100")).toBe(true); // the pre-paid dollar is consumed first
    expect(cumulatives.at(-1)).toBe(String(N));
    // a stateless facilitator accepts the mid-stream voucher (D read from the overlay)
    const fac = new BatchYcashFacilitatorScheme({ rpc: d.wallet });
    expect((await fac.verify(mid!, p.req)).isValid).toBe(true);
    // One request with a $17.50 ceiling: cumulative 200 + 1,750 = 1,950 leaves the client $0.50, so
    // the voucher assigns all of D to the server (the remainder rule) and the server closes.
    const big = { ...p.req, amount: "1750" };
    const last = await request(p, big);
    expect((last.payload.payload as { cumulative: string }).cumulative).toBe("1950");
    expect(p.closes.map((c) => c.reason)).toEqual(["exhausted"]);
    const closeTxid = p.closes[0]!.txid!;
    const closeHex = await d.wallet.call<string>("getrawtransaction", [closeTxid]);
    const decoded = await d.wallet.yedDecodePayload(closeHex);
    expect(decoded).toMatchObject({ type: "transfer", opReturnIndex: 2, assignments: [{ vout: 0, cents: 2_000 }] });
    await mineOnPool(closeTxid);
    await d.syncBlocks();
    expect(await tokensOf(p.payTo.yr)).toMatchObject([{ txid: closeTxid, vout: 0, cents: 2_000 }]);
    expect(await supply()).toBe(before);
    record(d.line, "X3 YED channel", {
      requests: N + 1, firstVoucher: first, lastCumulative: "1950", serverReceived: 2_000, clientRemainder: 0, closeTxid, closeAssignments: decoded.assignments,
    });
  });

  it("the floor at the end: a channel exhausted near D returns exactly $1.00 to the client", async () => {
    const before = await supply();
    const p = await party(300n, "$0.50");
    const { channelId, first } = await open(p); // first voucher 100, charged 50
    expect(first).toBe("100");
    const cum: string[] = [];
    for (let i = 0; i < 3; i++) cum.push(((await request(p)).payload.payload as { cumulative: string }).cumulative);
    expect(cum).toEqual(["100", "150", "200"]);
    // charged 200: the next voucher (250) would leave the client $0.50, so the server closes at 200
    expect(p.closes).toMatchObject([{ reason: "exhausted", cumulative: 200n }]);
    await mineOnPool(p.closes[0]!.txid!);
    const rec = (await p.client.storage.get(channelId))!;
    const clientYr = T.encodeAddress(NET, "yed", T.p2pkhHash(T.hexToBytes(rec.clientScript))!);
    expect((await tokensOf(p.payTo.yr)).map((t) => t.cents)).toEqual([200]);
    expect((await tokensOf(clientYr)).map((t) => t.cents)).toEqual([100]);
    expect(await supply()).toBe(before);
  });

  it("a client close below $1.00 charged pays the pre-paid dollar: cumulative max($1.00, charged)", async () => {
    const before = await supply();
    const p = await party(500n, "$0.25");
    const { channelId } = await open(p); // charged 25
    await request(p); // charged 50
    const close = wrap(p.req, (await p.client.closePayload(channelId)).payload);
    expect((close.payload as { cumulative: string }).cumulative).toBe("100");
    const v = await p.server.manager.verify(close, p.req);
    const r = await p.server.manager.settle(v, 0n);
    await mineOnPool(r.transaction);
    const rec = (await p.client.storage.get(channelId))!;
    const clientYr = T.encodeAddress(NET, "yed", T.p2pkhHash(T.hexToBytes(rec.clientScript))!);
    expect((await tokensOf(p.payTo.yr)).map((t) => t.cents)).toEqual([100]);
    expect((await tokensOf(clientYr)).map((t) => t.cents)).toEqual([400]);
    expect(await supply()).toBe(before);
  });

  it("the client refunds a YED channel after t with a TRANSFER: all of D back to the client, supply unchanged", async () => {
    const before = await supply();
    const p = await party(500n);
    const { channelId } = await open(p);
    await request(p);
    const rec = (await p.client.storage.get(channelId))!;
    await mineMany(rec.refundHeight - (await d.tip()));
    const txid = await p.client.refund(channelId);
    const hex = await d.wallet.call<string>("getrawtransaction", [txid]);
    const overlay = await d.wallet.yedValidateRawTransaction(hex);
    expect(overlay).toMatchObject({ verdict: "ok", type: "transfer", yedIn: 500, yedOut: 500, burned: 0 });
    await mineOnPool(txid);
    const clientYr = T.encodeAddress(NET, "yed", T.p2pkhHash(T.hexToBytes(rec.clientScript))!);
    expect(await tokensOf(clientYr)).toMatchObject([{ txid, vout: 1, cents: 500 }]);
    expect(await tokensOf(p.payTo.yr)).toEqual([]);
    expect(await p.server.manager.close(channelId)).toBeUndefined(); // spent by the refund
    expect(await supply()).toBe(before);
    record(d.line, "X3 YED refund", { refundHeight: rec.refundHeight, txid, assignments: (await d.wallet.yedDecodePayload(hex)).assignments });
  });

  it("a hand-built burning voucher: refused by the facilitator's verify; skipped by a strict pool's template, mined only by stock node 1", async () => {
    const p = await party(300n);
    const { channelId } = await open(p);
    const rec = (await p.client.storage.get(channelId))!;
    const ch = batch.client.channelOfRecord(rec);
    const branchId = parseInt((await d.wallet.getBlockchainInfo()).consensus.nextblock, 16);
    // The YED layout's outputs, but a TRANSFER assigning only $1.00 of the $3.00: $2.00 would burn.
    const burning: channel.VoucherLayout = ({ channel: c, clientScript }) => [
      { value: 10_000n, scriptPubKey: c.payToScript },
      { value: 10_000n, scriptPubKey: clientScript! },
      { value: 0n, scriptPubKey: yed.transferOpReturnScript([{ vout: 0, cents: 100 }]) },
    ];
    const voucher = channel.buildVoucher({ channel: ch, cumulative: 100n, clientScript: T.hexToBytes(rec.clientScript), clientPrivKey: T.hexToBytes(rec.clientPrivKey), branchId, layout: burning });
    const completed = T.serializeTxHex(channel.completeVoucher(voucher, ch, p.serverPriv, branchId)); // the test plays a colluding server
    const overlay = await d.wallet.yedValidateRawTransaction(completed);
    expect(overlay).toMatchObject({ valid: true, verdict: "burned", yedIn: 300, yedOut: 100, burned: 200 });
    const fac = new BatchYcashFacilitatorScheme({ rpc: d.wallet });
    const asVoucher = await fac.verify(wrap(p.req, { type: "voucher", channelId, tx: T.serializeTxHex(voucher), cumulative: "100" }), p.req);
    const asClaim = await fac.verify(wrap(p.req, { type: "claim", channelId, tx: completed, cumulative: "100" }), p.req);
    expect(asVoucher.isValid).toBe(false);
    expect(asClaim.isValid).toBe(false);
    await expect(p.server.manager.verify(wrap(p.req, { type: "voucher", channelId, tx: T.serializeTxHex(voucher), cumulative: "100" }), p.req)).rejects.toMatchObject({ reason: E.VOUCHER_SHAPE });

    // Forced through anyway: relayed by stock node 1, held in every mempool, skipped by the pool's template.
    const before = await supply();
    const burnTxid = await d.stock.sendRawTransaction(completed);
    await d.syncMempools();
    const template = await d.pool.call<{ transactions: { hash: string }[] }>("getblocktemplate", [{}]);
    const inTemplate = template.transactions.some((t) => t.hash === burnTxid);
    expect(inTemplate).toBe(false);
    const [hash] = await d.mine(1, d.stock);
    expect((await d.stock.call<{ tx: string[] }>("getblock", [hash])).tx).toContain(burnTxid);
    const after = await supply();
    expect(after).toBe(before - 200);
    record(d.line, "X3 burning voucher", {
      overlay: { verdict: overlay.verdict, yedIn: overlay.yedIn, yedOut: overlay.yedOut, burned: overlay.burned },
      facilitator: { voucher: asVoucher.invalidReason, claim: asClaim.invalidReason },
      strictPoolTemplate: inTemplate ? "included" : "skipped", minedBy: "node 1 (stock)", supplyBefore: before, supplyAfter: after,
    });
  });
});

/** Signs every input of `tx` with `k` (P2PKH coins of `values`). */
function signP2pkh(tx: T.Tx, k: Key, values: bigint[]): string {
  const pub = T.pubkeyFromPriv(k.priv);
  values.forEach((v, i) => {
    tx.vin[i]!.scriptSig = T.p2pkhScriptSig(T.signInput(T.sighashV4(tx, i, k.script, v, T.SIGHASH.ALL, 0x19bd2d2f), k.priv), pub);
  });
  return T.serializeTxHex(tx);
}
