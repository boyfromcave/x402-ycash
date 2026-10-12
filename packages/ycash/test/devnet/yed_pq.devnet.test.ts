// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// The quantum line on a live devnet (ycash-dd upgrade/quantum-vaults, rpcversion 7): the 53-character
// YED post-quantum address against the node's own encoder; YED `exact` paid to a TX_PQPKH holder; YED
// payment channels on the hybrid TX_PQCHANNEL (D-Q-19): open → pay → cooperative close, and the
// client's refund after t; and the deprecated P2SH YED channel, still valid before the Falcon height.
// Either regime: the default devnet mirrors mainnet (Falcon from the vault activation, D-Q-2: Falcon
// holders, a Falcon client, no P2SH channel); `X402_NODE_ARGS=-pqfalconheight=<h>` runs the regime
// before it (P2PKH or SLH-DSA holders, an SLH-DSA client, the P2SH channel still valid).
import type { PaymentPayload, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import { randomBytes } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { batch, channel, exact, pq, BatchYcashClientScheme, BatchYcashServerScheme, BatchYcashFacilitatorScheme, rpcWalletFunder } from "../../src/index.js";
import { InMemorySettlementStore } from "../../src/store/index.js";
import * as T from "../../src/tx/index.js";
import { describeDevnet, devnet, falconNext, record, waitFor, yedSendFrom, type Devnet } from "./harness.js";

const NET = "ycash:regtest" as const;
const E = batch.BatchError;
const URL = { url: "https://merchant.test/yed-pq" };
let d: Devnet;
/** Falcon applies to the next block (TOK-PQ): YED only at Falcon holders, YED channels with a Falcon client. */
let falcon = false;

async function ensureYed(cents: number): Promise<void> {
  const balance = async () => (await d.wallet.call<{ confirmedCents: number }>("yed_getbalance")).confirmedCents;
  if ((await balance()) >= cents) return;
  await waitFor(async () => {
    try {
      await d.wallet.call("yed_mint", [cents, 48, "", "", false]);
      return true;
    } catch (e) {
      if (!/price|participation/i.test((e as Error).message)) throw e;
      await d.mine(4, d.pool);
      return false;
    }
  }, { timeoutMs: 180_000, pollMs: 100, what: "a mint price" });
  await waitFor(async () => (await d.mine(1), (await balance()) >= cents), { timeoutMs: 180_000, pollMs: 500, what: "the MINT" });
}

const yedSend = (to: string, cents: number): Promise<string> => yedSendFrom(d, d.wallet, to, cents);

/** The scriptSig items of a scheme's chunked PQ spend (quantum spec §4.2): sig chunks, s, pk chunks, p. */
const spendItemCount = (scheme: 1 | 2): number => pq.chunk(new Uint8Array(pq.sigSize(scheme) + 1)).length + 1 + pq.chunk(new Uint8Array(pq.pubKeySize(scheme))).length + 1;

async function mineOnPool(txid: string): Promise<void> {
  await waitFor(async () => (await d.pool.getRawMempool()).includes(txid), { what: `${txid} at the pool` });
  const [hash] = await d.mine(1, d.pool);
  expect((await d.pool.call<{ tx: string[] }>("getblock", [hash])).tx).toContain(txid);
}

const tokensOf = async (address: string) => {
  await d.syncBlocks();
  return d.wallet.call<{ txid: string; vout: number; cents: number }[]>("yed_listtokens", [[address]]);
};

const outType = async (txid: string, vout: number) =>
  (await d.wallet.call<{ vout: { scriptPubKey: { type: string } }[] }>("getrawtransaction", [txid, 1])).vout[vout]?.scriptPubKey.type;

describeDevnet("the quantum line: post-quantum YED addresses, exact payees and TX_PQCHANNEL channels", () => {
  beforeAll(async () => {
    d = await devnet();
    expect(d.caps.yellowback).toBe(true);
    expect((await d.wallet.getBlockchainInfo()).consensus.nextblock).toBe("6d5b7a31"); // rides UPGRADE_VAULT
    await ensureYed(20_000);
    falcon = await falconNext(d);
  });

  it("the 53-character yr… form is the node's: vault_getnewowner's address re-encodes byte for byte", async () => {
    const info = await d.wallet.call<{ rpcversion: number; params: { pq: { schemes: number[]; falconActive: boolean } } }>("yed_getinfo");
    expect(info.rpcversion).toBe(8); // the fee structure (rpcversion 8) on upgrade/quantum-vaults
    expect(info.params.pq.falconActive).toBe(falcon);
    const o = await d.wallet.call<{ scheme: 1 | 2; keyhash: string; owner: string; address: string }>("vault_getnewowner");
    expect(o.address).toHaveLength(53);
    expect(T.encodePQAddress(NET, "yedpq", { scheme: o.scheme, hash: T.hexToBytes(o.keyhash) })).toBe(o.address);
    expect(T.decodeAddress(o.address)).toEqual({ network: NET, kind: "yedpq", hash: T.hexToBytes(o.keyhash), scheme: o.scheme });
    // the wallet's default holder: P2PKH before the Falcon height, a Falcon post-quantum address from it
    const ye = await d.wallet.call<string>("yed_getnewaddress");
    if (falcon) expect(T.decodeAddress(ye, NET)).toMatchObject({ kind: "yedpq", scheme: 2 });
    else expect(T.decodeAddress(ye, NET).kind).toBe("yed");
    record(d.line, "pq address parity", { owner: o.address, yedP2pkh: ye, pq: info.params.pq });
  });

  it("exact YED to a TX_PQPKH holder: a 35-byte output, verified and settled; the node lists the YED under the 53-character address", async () => {
    const seed = randomBytes(48); // a fresh holder per run: the suite may run again on the same devnet
    // TOK-PQ: from the Falcon height only a Falcon (scheme-2) holder; before it an SLH-DSA one is admissible
    const holderScheme = falcon ? pq.SCHEME_FN_DSA_512 : pq.SCHEME_SLH_DSA_SHA2_128S;
    const holder = pq.pqKeygen(holderScheme, seed);
    const payTo = T.encodePQAddress(NET, "yedpq", pq.keyIdOf(holderScheme, holder.publicKey));
    let signer: exact.LocalKeySigner | exact.RpcWalletSigner;
    let payerYr: string;
    if (falcon) {
      // From the Falcon height a key-held P2PKH payer cannot hold YED (LocalKeySigner holds YED at its P2PKH key
      // only): node 4's wallet pays from its Falcon YED (yed_getnewaddress follows the holder policy).
      const w = d.nodes[4]!;
      payerYr = await w.call<string>("yed_getnewaddress");
      expect(T.decodeAddress(payerYr, NET)).toMatchObject({ kind: "yedpq", scheme: 2 });
      await d.fund(await w.getNewAddress(), 1);
      await yedSend(payerYr, 500);
      await d.mine(1);
      signer = new exact.RpcWalletSigner(w);
    } else {
      const payerPriv = T.randomPrivKey();
      const ph = T.hash160(T.pubkeyFromPriv(payerPriv));
      const payerAddr = T.encodeAddress(NET, "p2pkh", ph);
      payerYr = T.encodeAddress(NET, "yed", ph);
      await d.wallet.call("importaddress", [payerAddr, "", false]);
      await d.fund(payerAddr, 1);
      await yedSend(payerYr, 500);
      await d.mine(1);
      signer = new exact.LocalKeySigner(T.encodeWif(payerPriv, NET), new exact.RpcUtxoSource(d.wallet, { importAddress: true }));
    }
    const scheme = new exact.ExactYcashFacilitatorScheme(d.wallet, { settlementStore: new InMemorySettlementStore(), confirmationTimeoutMs: 30_000, confirmationPollMs: 250, yellowback: true });
    const facilitator = new x402Facilitator().register(NET, scheme);
    const server = new x402ResourceServer({
      verify: (p: PaymentPayload, r: PaymentRequirements) => facilitator.verify(p, r),
      settle: (p: PaymentPayload, r: PaymentRequirements) => facilitator.settle(p, r),
      getSupported: async () => facilitator.getSupported() as SupportedResponse,
    }).register(NET, new exact.ExactYcashServerScheme({ usdAsset: "YED" }));
    await server.initialize();
    const [req] = await server.buildPaymentRequirements({ scheme: "exact", network: NET, payTo, price: "$2", maxTimeoutSeconds: 600 });
    const client = new x402Client().register(NET, new exact.ExactYcashScheme(signer));
    client.setSpendControls({ maxAmountPerPayment: "$50" });
    const pl = await client.createPaymentPayload(await server.createPaymentRequiredResponse([req as PaymentRequirements], URL));
    const hex = (pl.payload as { transaction: string }).transaction;
    const tx = T.parseTx(hex);
    expect(pq.pqpkhKeyId(tx.vout[0]!.scriptPubKey)).toEqual(pq.keyIdOf(holderScheme, holder.publicKey));
    expect(await d.wallet.yedValidateRawTransaction(hex)).toMatchObject({ verdict: "ok", burned: 0 });
    const v = await server.verifyPayment(pl, req as PaymentRequirements);
    // node 4's wallet pays from whichever of its Falcon outputs it selects (the suites may run again on one devnet)
    expect(v).toMatchObject({ isValid: true, payer: falcon ? expect.stringMatching(/^yr/) : payerYr });
    if (falcon) expect(T.decodeAddress(v.payer!, NET)).toMatchObject({ kind: "yedpq", scheme: 2 });
    const settling = server.settlePayment(pl, req as PaymentRequirements);
    await mineOnPool(T.txid(hex));
    expect(await settling).toMatchObject({ success: true, transaction: T.txid(hex) });
    expect(await outType(T.txid(hex), 0)).toBe("pqpubkeyhash");
    expect((await tokensOf(payTo)).filter((t) => t.txid === T.txid(hex))).toMatchObject([{ txid: T.txid(hex), vout: 0, cents: 200 }]);
    record(d.line, "exact YED to PQPKH", { payTo, holderScheme, txid: T.txid(hex) });
  });

  interface Party {
    server: BatchYcashServerScheme;
    client: BatchYcashClientScheme;
    req: PaymentRequirements;
    payTo: string;
    closes: { channelId: string; reason: string; txid: string | undefined; cumulative: bigint }[];
  }

  async function party(deposit: bigint, price: string, template?: batch.client.YedChannelTemplate): Promise<Party> {
    const closes: Party["closes"] = [];
    const srv = new BatchYcashServerScheme({
      chain: d.wallet, serverPrivKey: T.randomPrivKey(), maxDeposit: 100_000_000n, maxDepositCents: 10_000n, minLockBlocks: 30,
      closeMarginBlocks: 5, confirmations: 1, usdAsset: "YED", onClose: (e) => closes.push(e),
    });
    const payTo = await d.wallet.call<string>("yed_getnewaddress");
    const priced = await srv.parsePrice(price, NET);
    const base: PaymentRequirements = { scheme: "batch-settlement", network: NET, asset: priced.asset, amount: priced.amount, payTo, maxTimeoutSeconds: 300, extra: {} };
    const req = await srv.enhancePaymentRequirements(base, { x402Version: 2, scheme: "batch-settlement", network: NET }, []);
    const client = new BatchYcashClientScheme({ chain: d.wallet, funder: rpcWalletFunder(d.wallet), deposit: () => deposit, lockSlackBlocks: 3, ...(template ? { yedChannelTemplate: template } : {}) });
    return { server: srv, client, req, payTo, closes };
  }
  const wrap = (req: PaymentRequirements, payload: Record<string, unknown>): PaymentPayload => ({ x402Version: 2, accepted: req, payload });

  async function open(p: Party): Promise<{ channelId: string; payload: PaymentPayload }> {
    const payload = wrap(p.req, (await p.client.createPaymentPayload(2, p.req)).payload);
    await expect(p.server.manager.verify(payload, p.req)).rejects.toMatchObject({ reason: E.FUNDING_DEPTH });
    await mineOnPool(T.txid((payload.payload as { fundingTx: string }).fundingTx));
    const v = await p.server.manager.verify(payload, p.req);
    await p.client.applySettleResponse(await p.server.manager.settle(v, BigInt(p.req.amount)));
    return { channelId: v.channelId, payload };
  }

  async function request(p: Party): Promise<PaymentPayload> {
    const payload = wrap(p.req, (await p.client.createPaymentPayload(2, p.req)).payload);
    const v = await p.server.manager.verify(payload, p.req);
    await p.client.applySettleResponse(await p.server.manager.settle(v, BigInt(p.req.amount)));
    return payload;
  }

  it("a YED channel on TX_PQCHANNEL: bare funding output, PQ vouchers (SLH-DSA before the Falcon height, Falcon from it), the server's ECDSA completion, cooperative close mined", async () => {
    const supply0 = (await d.wallet.call<{ supplyCents: number }>("yed_getstats")).supplyCents;
    const p = await party(500n, "$0.25");
    // rpcversion 8: the offer's closeFee is the close's network fee at the node's Yellowback rate
    // (yed_getinfo.params.fees.network), sized for the client scheme of a channel opened now
    const fees = T.networkFeesOf(await d.wallet.yedGetInfo());
    expect(fees).toBeDefined();
    expect(p.req.extra.closeFee).toBe(channel.yedCloseNetworkFee(falcon, fees).toString());
    const { channelId, payload } = await open(p);
    const [fundingTxid, vout] = channelId.split(":") as [string, string];
    expect(await outType(fundingTxid, Number(vout))).toBe("pqchannel");
    const rs = T.hexToBytes((payload.payload as { redeemScript: string }).redeemScript);
    expect(channel.parsePQChannelScript(rs)?.client.scheme).toBe(falcon ? 2 : 1);
    const t0 = Date.now();
    const mid = await request(p); // charged 50 (cumulative 100: the pre-paid dollar)
    await request(p); // charged 75
    const third = await request(p); // charged 100
    await request(p); // charged 125: a new PQ voucher
    const perVoucherMs = (Date.now() - t0) / 4;
    const fac = new BatchYcashFacilitatorScheme({ rpc: d.wallet });
    expect((await fac.verify(mid, p.req)).isValid).toBe(true);
    expect((await fac.verify(third, p.req)).isValid).toBe(true);
    const close = wrap(p.req, (await p.client.closePayload(channelId)).payload);
    const voucherBytes = T.hexToBytes((close.payload as { tx: string }).tx).length;
    const r = await p.server.manager.settle(await p.server.manager.verify(close, p.req), 0n);
    expect(r.success).toBe(true);
    const closeHex = await d.wallet.call<string>("getrawtransaction", [r.transaction]);
    const ss = channel.parsePQCloseScriptSig(T.parseTx(closeHex).vin[0]!.scriptSig);
    expect(ss?.sigS.length).toBeGreaterThan(0);
    await mineOnPool(r.transaction);
    expect((await tokensOf(p.payTo)).map((t) => t.cents)).toEqual([125]);
    const rec = (await p.client.storage.get(channelId))!;
    expect((await tokensOf(rec.returnAddress!)).map((t) => t.cents)).toEqual([375]);
    expect((await d.wallet.call<{ supplyCents: number }>("yed_getstats")).supplyCents).toBe(supply0);
    record(d.line, "YED channel on TX_PQCHANNEL", {
      channelId, closeTxid: r.transaction, closeBytes: closeHex.length / 2, voucherBytes, scriptSigBytes: T.parseTx(closeHex).vin[0]!.scriptSig.length, perVoucherMs,
    });
  });

  it("the client's refund of a TX_PQCHANNEL after t: its PQ signature alone, a TRANSFER of all of D back", async () => {
    const p = await party(300n, "$0.25");
    const { channelId } = await open(p);
    await request(p);
    const rec = (await p.client.storage.get(channelId))!;
    for (let left = rec.refundHeight - (await d.tip()); left > 0; left -= 8) await d.mine(Math.min(8, left));
    const txid = await p.client.refund(channelId);
    const hex = await d.wallet.call<string>("getrawtransaction", [txid]);
    expect(await d.wallet.yedValidateRawTransaction(hex)).toMatchObject({ verdict: "ok", type: "transfer", yedIn: 300, yedOut: 300, burned: 0 });
    const chunks = T.parseScript(T.parseTx(hex).vin[0]!.scriptSig);
    expect(chunks.length).toBe(spendItemCount(falcon ? 2 : 1) + 1); // the client's chunked PQ spend, then OP_0 (the refund branch)
    await mineOnPool(txid);
    expect(await tokensOf(rec.returnAddress!)).toMatchObject([{ txid, vout: 1, cents: 300 }]);
    record(d.line, "TX_PQCHANNEL refund", { txid, refundHeight: rec.refundHeight, scriptSigBytes: T.parseTx(hex).vin[0]!.scriptSig.length });
  });

  it("the deprecated P2SH YED channel still opens and closes before the Falcon height", async ({ skip }) => {
    // From the Falcon height TOK-PQ refuses a P2SH YED holder: yed_falcon covers the client's refusal there.
    if (falcon) skip();
    const p = await party(300n, "$0.25", "p2sh");
    const { channelId } = await open(p);
    const [fundingTxid, vout] = channelId.split(":") as [string, string];
    expect(await outType(fundingTxid, Number(vout))).toBe("scripthash");
    const close = wrap(p.req, (await p.client.closePayload(channelId)).payload);
    const r = await p.server.manager.settle(await p.server.manager.verify(close, p.req), 0n);
    await mineOnPool(r.transaction);
    expect((await tokensOf(p.payTo)).map((t) => t.cents)).toEqual([100]);
  });
});
