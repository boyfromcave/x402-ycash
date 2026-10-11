// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// YED and YEC `exact` on the quantum line: paying a post-quantum (TX_PQPKH, 35-byte script) payee,
// and a payer spending a TX_PQPKH coin: rule 5 reads the chunked spend, `payer` is its address.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { exact, pq, yed } from "../../../src/index.js";
import { payerOf } from "../../../src/exact/facilitator/verify.js";
import { InMemorySettlementStore } from "../../../src/store/index.js";
import { buildScript, encodeAddress, encodePQAddress, hash160, hexToBytes, newTx, parseTx, pubkeyFromPriv, SEQUENCE_FINAL, serializeTxHex, sighashV4, SIGHASH, type TxOut } from "../../../src/tx/index.js";
import { BRANCH_ID, FakeNode, FakeUtxoSource, NETWORK, paymentPayload, requirements, testKey } from "./fakeNode.js";

const vec = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../vectors/pq/pq_vectors.json", import.meta.url)), "utf8")) as { keys: { scheme: number; seed: string }[] };
const payer = testKey(1);
const payerYr = encodeAddress(NETWORK, "yed", hash160(pubkeyFromPriv(payer.priv)));
const pqKey = pq.pqKeygen(1, hexToBytes(vec.keys[0]!.seed));
const pqId = pq.keyIdOf(1, pqKey.publicKey);
const pqScript = pq.pqpkhScript(pqId);
const merchantYrPQ = encodePQAddress(NETWORK, "yedpq", { scheme: 2, hash: new Uint8Array(32).fill(0x5a) });
const yedReq = (payTo: string, amount = "2500") => ({ ...requirements(payTo, amount, { confirmationPolicy: { confirmations: 1 } }), asset: "YED" });

let node: FakeNode;
let facilitator: exact.ExactYcashFacilitatorScheme;
beforeEach(() => {
  node = new FakeNode();
  node.yellowback = true;
  facilitator = new exact.ExactYcashFacilitatorScheme(node, { settlementStore: new InMemorySettlementStore(), confirmationTimeoutMs: 0, yellowback: true });
});

describe("paying a post-quantum YED holder", () => {
  it("the client pays the 53-character yr… payee with a 35-byte TX_PQPKH output; the facilitator verifies it", async () => {
    expect(merchantYrPQ).toHaveLength(53);
    node.addToken(5_000, payer.script);
    node.addCoin(1_000_000n, payer.script);
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    const req = yedReq(merchantYrPQ);
    const hex = ((await client.createPaymentPayload(2, req)).payload as { transaction: string }).transaction;
    const tx = parseTx(hex);
    expect(tx.vout[0]!.scriptPubKey).toHaveLength(35);
    expect(pq.pqpkhKeyId(tx.vout[0]!.scriptPubKey)).toEqual({ scheme: 2, hash: new Uint8Array(32).fill(0x5a) });
    expect(yed.findPayload(tx.vout)).toMatchObject({ payload: { assignments: [{ vout: 0, cents: 2500 }, { vout: 1, cents: 2500 }] } });
    expect(await facilitator.verify(paymentPayload(req, hex), req)).toEqual({ isValid: true, payer: payerYr });
  });

  it("policy: a YED payTo is either Yellowback form, never sq…; a YEC payTo may be sq… above its dust", () => {
    expect(exact.checkTransparentYedRequirements(yedReq(merchantYrPQ))).toBeNull();
    const sq = encodePQAddress(NETWORK, "pq", pqId);
    expect(sq.startsWith("rq")).toBe(true);
    expect(exact.checkTransparentYedRequirements(yedReq(sq))).toMatch(/Yellowback/);
    expect(exact.checkTransparentYecRequirements(requirements(sq, "250000"))).toBeNull();
    expect(exact.checkTransparentYecRequirements(requirements(sq, "2405"))).toMatch(/post-quantum dust threshold of 2406/);
    expect(exact.checkTransparentYecRequirements(requirements(merchantYrPQ, "250000"))).toMatch(/transparent/);
    expect([pq.pqDustThreshold(1), pq.pqDustThreshold(2)]).toEqual([2406n, 498n]);
  });
});

describe("a payer spending a TX_PQPKH coin", () => {
  /** A YEC payment whose only input is the TX_PQPKH coin, signed with `hashType`. */
  function pqPayment(payTo: Uint8Array, hashType: number = SIGHASH.ALL): string {
    const c = node.addCoin(1_000_000n, pqScript);
    const outputs: TxOut[] = [{ value: 250_000n, scriptPubKey: payTo }, { value: 1_000_000n - 250_000n - 30_000n, scriptPubKey: pqScript }];
    const tx = newTx({ vin: [{ prevout: c, scriptSig: new Uint8Array(), sequence: SEQUENCE_FINAL }], vout: outputs, expiryHeight: node.tip + 3 + 4 });
    const sh = sighashV4(tx, 0, pqScript, 1_000_000n, hashType, BRANCH_ID);
    const sig = Uint8Array.from([...pq.pqSign(1, pqKey.secretKey, sh), hashType]);
    tx.vin[0]!.scriptSig = buildScript(pq.pqSpendItems(pqKey.publicKey, sig));
    return serializeTxHex(tx);
  }

  it("rule 5 accepts its SIGHASH_ALL chunked signature; payer is its sq… (here rq…) address", async () => {
    const merchant = testKey(2);
    const req = requirements(merchant.address, "250000", { confirmationPolicy: { confirmations: 1 } });
    const hex = pqPayment(merchant.script);
    expect(exact.checkSighashAll(parseTx(hex).vin[0]!.scriptSig)).toBeNull();
    const v = await facilitator.verify(paymentPayload(req, hex), req);
    expect(v).toEqual({ isValid: true, payer: encodePQAddress(NETWORK, "pq", pqId) });
    expect(exact.addressOfScriptSig(parseTx(hex).vin[0]!.scriptSig, NETWORK)).toBe(encodePQAddress(NETWORK, "pq", pqId));
    expect(payerOf(pqScript, { network: NETWORK, yed: { opReturnIndex: 2, assignments: [] } })).toBe(encodePQAddress(NETWORK, "yedpq", pqId));
  });

  it("rule 5 refuses a non-ALL post-quantum signature", () => {
    const hex = pqPayment(testKey(2).script, SIGHASH.ALL | 0x80);
    expect(exact.checkSighashAll(parseTx(hex).vin[0]!.scriptSig)).toMatch(/0x81 is not SIGHASH_ALL/);
  });
});
