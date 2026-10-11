// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// YED channels across the node's Falcon height F (quantum spec TOK-PQ, A-1; channel/falcon.ts):
// SLH-DSA clients and P2PKH/SLH holders before F, closed below F; Falcon clients and Falcon TX_PQPKH
// holders from F; the refund of a pre-F channel after F pays a Falcon address. The fake overlay applies
// TOK-PQ to every transaction it validates for a block at or after F, as the node's module does.
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { batch, channel, pq, tx as T, yed, BatchYcashClientScheme, BatchYcashServerScheme } from "../../../src/index.js";
import type { YedInfo, YedValidation } from "../../../src/node/types.js";
import { FakeYedChain } from "./fakeYedChain.js";
import { NET, reasonOf, serverPriv } from "./setup.js";

const E = batch.BatchError;
const coinKey = T.hexToBytes("33".repeat(32));
const coinSpk = T.p2pkhScript(T.hash160(T.pubkeyFromPriv(coinKey)));
const p2pkhYed = (b: string) => T.encodeAddress(NET, "yed", T.hexToBytes(b.repeat(20)));
const falconAddr = (n: number) => T.encodePQAddress(NET, "yedpq", pq.keyIdOf(pq.SCHEME_FN_DSA_512, pq.pqKeygen(pq.SCHEME_FN_DSA_512, new Uint8Array(48).fill(n)).publicKey));
const slhAddr = (n: number) => T.encodePQAddress(NET, "yedpq", pq.keyIdOf(pq.SCHEME_SLH_DSA_SHA2_128S, pq.pqKeygen(pq.SCHEME_SLH_DSA_SHA2_128S, new Uint8Array(48).fill(n)).publicKey));
const FALCON_PAYTO = falconAddr(1);
const FALCON_RETURN = falconAddr(2);

/** The overlay with a Falcon height: `yed_getinfo` reports it, and validation applies TOK-PQ from it. */
class FalconYedChain extends FakeYedChain {
  constructor(public falconHeight: number) {
    super();
  }
  async yedGetInfo(): Promise<YedInfo> {
    return { rpcversion: 7, params: { pq: { falconHeight: this.falconHeight, falconActive: channel.isFalconActiveAt(this.falconHeight, this.tip + 1) } } };
  }
  override async yedValidateRawTransaction(hex: string): Promise<YedValidation> {
    const v = await super.yedValidateRawTransaction(hex);
    if (!channel.isFalconActiveAt(this.falconHeight, this.tip + 1) || v.yedIn === 0) return v;
    const tx = T.parseTx(hex);
    const f = yed.findPayload(tx.vout);
    const as = f && !yed.isFindPayloadFailure(f) && f.payload.type === "transfer" ? f.payload.assignments : [];
    for (const a of as) {
      const spk = tx.vout[a.vout]!.scriptPubKey;
      const ch = channel.parsePQChannelScript(spk);
      if (!channel.isFalconHolder(spk) && ch?.client.scheme !== pq.SCHEME_FN_DSA_512) return { ...v, verdict: "tok-pq", valid: false };
    }
    return v;
  }
}

interface FSetup {
  chain: FalconYedChain;
  server: BatchYcashServerScheme;
  client: BatchYcashClientScheme;
  req: PaymentRequirements;
  closes: { channelId: string; reason: string; txid: string | undefined; cumulative: bigint }[];
  fundings: batch.client.FundingRequest[];
  pay(r?: PaymentRequirements): Promise<PaymentPayload>;
  open(r?: PaymentRequirements): Promise<string>;
  request(r?: PaymentRequirements): Promise<void>;
  offer(payTo: string): Promise<PaymentRequirements>;
  funderReturn: { address: string };
}

async function setup(o: {
  falconHeight: number; payTo: string; returnAddress?: string; funderReturn?: string; template?: batch.client.YedChannelTemplate; clientFalconHeight?: number;
}): Promise<FSetup> {
  const chain = new FalconYedChain(o.falconHeight);
  const closes: FSetup["closes"] = [];
  const server = new BatchYcashServerScheme({
    chain, serverPrivKey: serverPriv, maxDeposit: 1_000_000n, maxDepositCents: 5_000n, minLockBlocks: 100, closeMarginBlocks: 10, usdAsset: "YED",
    onClose: (e) => closes.push(e),
  });
  const offer = async (payTo: string) => {
    const base: PaymentRequirements = { scheme: "batch-settlement", network: NET, asset: "YED", amount: "1", payTo, maxTimeoutSeconds: 300, extra: {} };
    return server.enhancePaymentRequirements(base, { x402Version: 2, scheme: "batch-settlement", network: NET }, []);
  };
  const req = await offer(o.payTo);
  let n = 0;
  const fundings: batch.client.FundingRequest[] = [];
  const funderReturn = { address: o.funderReturn ?? FALCON_RETURN };
  const funder: batch.client.ChannelFunder = {
    returnAddress: async () => funderReturn.address,
    async fund(fr) {
      fundings.push(fr);
      const tid = (++n).toString(16).padStart(64, "d");
      const cid = n.toString(16).padStart(64, "c");
      chain.addToken(tid, 0, Number(fr.deposit) + 500, coinSpk); // a P2PKH token from before F: spendable after it
      chain.addCoin(cid, 0, 1_000_000n, coinSpk);
      const tokens = [{ outpoint: { txid: tid, vout: 0 }, cents: Number(fr.deposit) + 500, value: 10_000n, scriptPubKey: coinSpk }];
      const yecCoins = [{ outpoint: { txid: cid, vout: 0 }, value: 1_000_000n, scriptPubKey: coinSpk }];
      // YED change: a Falcon holder once Falcon applies (TOK-PQ), the P2PKH key before.
      const yedChangeScript = fr.falconActive ? T.addressToScript(FALCON_RETURN, NET) : coinSpk;
      const built = channel.buildYedFundingTx({
        redeemScript: fr.redeemScript, depositCents: fr.deposit!, closeFee: fr.value - channel.yedChannelValue(0n), tokens, yecCoins, yedChangeScript, yecChangeScript: coinSpk,
        expiryHeight: fr.expiryHeight ?? 0,
      });
      return T.serializeTxHex(channel.signFundingTx(built.tx, built.inputs, built.inputs.map(() => coinKey), fr.branchId));
    },
  };
  const client = new BatchYcashClientScheme({
    chain, funder, deposit: () => 2_000n, lockSlackBlocks: 0,
    ...(o.returnAddress ? { returnAddress: o.returnAddress } : {}),
    ...(o.template ? { yedChannelTemplate: o.template } : {}),
    ...(o.clientFalconHeight !== undefined ? { falconHeight: o.clientFalconHeight } : {}),
  });
  const wrap = (payload: Record<string, unknown>, r: PaymentRequirements): PaymentPayload => ({ x402Version: 2, accepted: r, payload });
  const pay = async (r = req) => wrap((await client.createPaymentPayload(2, r)).payload, r);
  const request = async (r = req) => {
    const v = await server.manager.verify(await pay(r), r);
    await client.applySettleResponse(await server.manager.settle(v, BigInt(r.amount)));
  };
  const open = async (r = req) => {
    const payload = await pay(r);
    expect(await reasonOf(server.manager.verify(payload, r))).toBe(E.FUNDING_DEPTH);
    chain.mine();
    const v = await server.manager.verify(payload, r);
    await client.applySettleResponse(await server.manager.settle(v, BigInt(r.amount)));
    return v.channelId;
  };
  return { chain, server, client, req, closes, fundings, pay, open, request, offer, funderReturn };
}

const channelScriptOf = (s: FSetup, channelId: string) => {
  const [txid, vout] = channelId.split(":");
  const funding = s.chain.sent.find((h) => T.txid(h) === txid)!;
  return channel.parsePQChannelScript(T.parseTx(funding).vout[Number(vout)]!.scriptPubKey);
};

describe("channel/falcon helpers", () => {
  it("isFalconActiveAt, falconHeightOf, yedHolderProblem, channelCloseBy, the network defaults", () => {
    expect(channel.isFalconActiveAt(-1, 10)).toBe(false);
    expect(channel.isFalconActiveAt(0, 0)).toBe(true);
    expect(channel.isFalconActiveAt(100, 99)).toBe(false);
    expect(channel.isFalconActiveAt(100, 100)).toBe(true);
    expect(channel.falconHeightOf({ params: { pq: { falconHeight: 130 } } })).toBe(130);
    expect(channel.falconHeightOf({ params: {} })).toBeUndefined();
    expect(channel.DEFAULT_FALCON_HEIGHT).toEqual({ "ycash:mainnet": 0, "ycash:testnet": 0, "ycash:regtest": -1 });
    const falcon = T.addressToScript(FALCON_PAYTO, NET);
    const slh = T.addressToScript(slhAddr(3), NET);
    const p2pkh = T.addressToScript(p2pkhYed("ab"), NET);
    expect(channel.yedHolderProblem(falcon, true)).toBeNull();
    expect(channel.yedHolderProblem(slh, true)).toMatch(/TOK-PQ/);
    expect(channel.yedHolderProblem(p2pkh, true)).toMatch(/TOK-PQ/);
    expect(channel.yedHolderProblem(falcon, false)).toMatch(/policy/);
    expect(channel.yedHolderProblem(slh, false)).toBeNull();
    expect(channel.yedHolderProblem(p2pkh, false)).toBeNull();
    expect(channel.channelCloseBy("YED", { template: "p2sh", refundHeight: 500 }, 300)).toBe(300);
    expect(channel.channelCloseBy("YED", { template: "pq", refundHeight: 500, client: { scheme: 1 } }, 300)).toBe(300);
    expect(channel.channelCloseBy("YED", { template: "pq", refundHeight: 500, client: { scheme: 2 } }, 300)).toBe(500);
    expect(channel.channelCloseBy("YED", { template: "pq", refundHeight: 500, client: { scheme: 1 } }, -1)).toBe(500);
    expect(channel.channelCloseBy("YEC", { template: "p2sh", refundHeight: 500 }, 300)).toBe(500);
    expect(batch.marginHeightOf({ refundHeight: 500, closeMarginBlocks: 10, closeBy: 300 })).toBe(290);
    expect(batch.marginHeightOf({ refundHeight: 500, closeMarginBlocks: 10 })).toBe(490);
  });
  it("readFalconHeight asks yed_getinfo once and caches it; without it the network default", async () => {
    let calls = 0;
    const node = { yedGetInfo: async () => (calls++, { params: { pq: { falconHeight: 42 } } }) };
    expect(await channel.readFalconHeight(node, NET)).toBe(42);
    expect(await channel.readFalconHeight(node, NET)).toBe(42);
    expect(calls).toBe(1);
    expect(await channel.readFalconHeight({}, "ycash:mainnet")).toBe(0);
    expect(await channel.readFalconHeight({ yedGetInfo: async () => { throw new Error("-32601"); } }, NET)).toBe(-1);
  });
});

describe("from the Falcon height: Falcon clients and Falcon holders", () => {
  it("opens on TX_PQCHANNEL with a Falcon client, pays, closes cooperatively; the record carries the scheme", async () => {
    const s = await setup({ falconHeight: 0, payTo: FALCON_PAYTO });
    const id = await s.open();
    expect(channelScriptOf(s, id)?.client.scheme).toBe(pq.SCHEME_FN_DSA_512);
    expect(s.fundings[0]).toMatchObject({ falconActive: true });
    const rec = (await s.client.storage.get(id))!;
    expect(rec.clientScheme).toBe(2);
    expect(rec.returnAddress).toBe(FALCON_RETURN);
    for (let i = 0; i < 3; i++) await s.request();
    // a Falcon voucher's scriptSig is ≈ 1.6 KB (an SLH-DSA one ≈ 8 KB)
    const v = T.parseTx(((await s.client.closePayload(id)).payload as { tx: string }).tx);
    expect(v.vin[0]!.scriptSig.length).toBeLessThan(1_700);
    const st = await s.client.status(id);
    expect(st).toMatchObject({ closeBy: rec.refundHeight });
    expect(st.warning).toBeUndefined();
    const txid = await s.server.manager.close(id, "demand");
    expect(txid).toBeDefined();
    const close = s.chain.sent.at(-1)!;
    expect(await s.chain.yedValidateRawTransaction(close)).toMatchObject({ verdict: "ok", burned: 0 });
    const out = T.parseTx(close).vout;
    expect(channel.isFalconHolder(out[0]!.scriptPubKey) && channel.isFalconHolder(out[1]!.scriptPubKey)).toBe(true);
  });
  it("the Falcon refund after t pays the Falcon return address; the overlay registers it", async () => {
    const s = await setup({ falconHeight: 0, payTo: FALCON_PAYTO });
    const id = await s.open();
    const rec = (await s.client.storage.get(id))!;
    s.chain.mine(rec.refundHeight - s.chain.tip);
    const txid = await s.client.refund(id);
    const hex = s.chain.sent.at(-1)!;
    expect(T.txid(hex)).toBe(txid);
    expect(await s.chain.yedValidateRawTransaction(hex)).toMatchObject({ valid: true, verdict: "ok", yedIn: 2_000, burned: 0 });
    expect(T.bytesToHex(T.parseTx(hex).vout[1]!.scriptPubKey)).toBe(T.bytesToHex(T.addressToScript(FALCON_RETURN, NET)));
  });
  it("refuses a P2PKH or SLH-DSA return address, a non-Falcon payTo, and the P2SH template (client side)", async () => {
    for (const ra of [p2pkhYed("ab"), slhAddr(4)]) {
      const s = await setup({ falconHeight: 0, payTo: FALCON_PAYTO, returnAddress: ra });
      expect(await reasonOf(s.pay())).toBe(E.RETURN_ADDRESS);
    }
    const p = await setup({ falconHeight: 0, payTo: p2pkhYed("aa") });
    expect(await reasonOf(p.pay())).toBe(E.REQUIREMENTS);
    const t = await setup({ falconHeight: 0, payTo: FALCON_PAYTO, template: "p2sh" });
    expect(await reasonOf(t.pay())).toMatch(/P2SH YED channel is invalid from the Falcon height/);
    expect(t.fundings).toEqual([]);
  });
  it("the server refuses an SLH-DSA client, a P2SH channel and a non-Falcon return after F (a client that does not know F)", async () => {
    // payTo P2PKH so the unaware client opens at all; the server's first refusal is the client key
    const slh = await setup({ falconHeight: 0, payTo: p2pkhYed("aa"), clientFalconHeight: -1, returnAddress: slhAddr(5) });
    expect(await reasonOf(slh.server.manager.verify(await slh.pay(), slh.req))).toBe(E.REDEEM_SCRIPT);
    const p2sh = await setup({ falconHeight: 0, payTo: p2pkhYed("aa"), clientFalconHeight: -1, template: "p2sh", returnAddress: p2pkhYed("ab") });
    expect(await reasonOf(p2sh.server.manager.verify(await p2sh.pay(), p2sh.req))).toBe(E.REDEEM_SCRIPT);
  });
  it("the server refuses a Falcon client before F (the node's policy refuses a scheme-2 output)", async () => {
    const s = await setup({ falconHeight: 5_000, payTo: p2pkhYed("aa"), clientFalconHeight: 0, returnAddress: FALCON_RETURN });
    // the client believes Falcon is active; its payTo check uses its own view
    const s2 = await setup({ falconHeight: 5_000, payTo: FALCON_PAYTO, clientFalconHeight: 0 });
    expect(await reasonOf(s2.server.manager.verify(await s2.pay(), s2.req))).toBe(E.REDEEM_SCRIPT);
    expect(await reasonOf(s.pay())).toBe(E.REQUIREMENTS);
  });
});

describe("before the Falcon height: SLH-DSA clients, closed below F", () => {
  it("opens with an SLH-DSA client and a funding that expires below F; client and server close below F", async () => {
    const s = await setup({ falconHeight: 1_060, payTo: p2pkhYed("aa"), funderReturn: p2pkhYed("ab") });
    const id = await s.open();
    expect(channelScriptOf(s, id)?.client.scheme).toBe(pq.SCHEME_SLH_DSA_SHA2_128S);
    expect(s.fundings[0]).toMatchObject({ falconActive: false, expiryHeight: 1_043 }); // tip + 3 + 40, below F
    const rec = (await s.client.storage.get(id))!;
    expect(rec.clientScheme).toBe(1);
    expect(rec.refundHeight).toBe(1_100);
    const st = await s.client.status(id);
    expect(st.closeBy).toBe(1_060);
    expect(st.warning).toMatch(/must be closed below it \(the server closes at 1050\)/);
    expect((await s.server.manager.ledger.get(id))?.terms.closeBy).toBe(1_060);
    await s.request();
    // at F − margin the server closes (reason margin), and refuses further vouchers
    s.chain.mine(1_050 - s.chain.tip);
    const closed = await s.server.manager.sweep();
    expect(closed).toMatchObject([{ channelId: id, reason: "margin" }]);
    expect(await s.chain.yedValidateRawTransaction(s.chain.sent.at(-1)!)).toMatchObject({ verdict: "ok" });
    // the client retires it too: its next payment would open a new channel, which is now too close to F
    expect(await reasonOf(s.pay())).toMatch(/Falcon height 1060 is too close/);
    expect((await s.client.storage.get(id))?.status).toBe("retired");
  });
  it("the server refuses a pre-F funding that could land at F, and an open inside F − margin", async () => {
    const s = await setup({ falconHeight: 1_040, payTo: p2pkhYed("aa"), funderReturn: p2pkhYed("ab"), clientFalconHeight: -1 });
    // the client does not know F: its funding expires at tip + 43 ≥ F
    expect(await reasonOf(s.server.manager.verify(await s.pay(), s.req))).toBe(E.FUNDING);
    const late = await setup({ falconHeight: 1_005, payTo: p2pkhYed("aa"), funderReturn: p2pkhYed("ab"), clientFalconHeight: -1 });
    expect(await reasonOf(late.server.manager.verify(await late.pay(), late.req))).toBe(E.REDEEM_SCRIPT);
  });
  it("a pre-F channel's refund after F pays the funder's Falcon address, or is refused without one", async () => {
    const s = await setup({ falconHeight: 1_060, payTo: p2pkhYed("aa"), funderReturn: p2pkhYed("ab") });
    const id = await s.open();
    s.chain.mine(1_100 - s.chain.tip); // past F and t; the server never closed (no sweep)
    expect((await s.client.status(id)).warning).toMatch(/has passed/);
    expect(await reasonOf(s.client.refund(id))).toBe(E.RETURN_ADDRESS); // the funder still returns P2PKH
    expect(await reasonOf(s.client.refund(id, { toScript: T.addressToScript(slhAddr(6), NET) }))).toBe(E.RETURN_ADDRESS);
    s.funderReturn.address = FALCON_RETURN; // a node wallet's yed_getnewaddress is a Falcon address from F
    await s.client.refund(id);
    const hex = s.chain.sent.at(-1)!;
    expect(await s.chain.yedValidateRawTransaction(hex)).toMatchObject({ valid: true, verdict: "ok", burned: 0 });
    expect(channel.isFalconHolder(T.parseTx(hex).vout[1]!.scriptPubKey)).toBe(true);
  });
  it("a P2SH YED channel (regtest, before F) is also closed below F", async () => {
    const s = await setup({ falconHeight: 1_060, payTo: p2pkhYed("aa"), funderReturn: p2pkhYed("ab"), template: "p2sh" });
    const id = await s.open();
    expect((await s.client.status(id)).closeBy).toBe(1_060);
    s.chain.mine(1_050 - s.chain.tip);
    expect(await s.server.manager.sweep()).toMatchObject([{ channelId: id, reason: "margin" }]);
  });
  it("after F the server switches payTo to a Falcon address and new channels are Falcon", async () => {
    const s = await setup({ falconHeight: 1_060, payTo: p2pkhYed("aa"), funderReturn: p2pkhYed("ab") });
    await s.open();
    s.chain.mine(1_060 - s.chain.tip);
    s.funderReturn.address = FALCON_RETURN;
    const after = await s.offer(FALCON_PAYTO);
    const id = await s.open(after);
    expect(channelScriptOf(s, id)?.client.scheme).toBe(pq.SCHEME_FN_DSA_512);
    await s.request(after);
    expect(await s.server.manager.close(id)).toBeDefined();
    expect(await s.chain.yedValidateRawTransaction(s.chain.sent.at(-1)!)).toMatchObject({ verdict: "ok" });
  });
});
