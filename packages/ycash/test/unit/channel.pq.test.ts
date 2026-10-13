// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// The hybrid TX_PQCHANNEL (quantum spec D-Q-19): the template against the node's matcher vectors
// (vectors/pq/yellowback_pq_vectors.json "scripts" = ycash-dd src/test/data/yellowback_pq_vectors.json
// at 8af82551b; its "scripts" unchanged since aa0fd3812, reviewer B's differential of MatchPQChannel / the TX_PQPKH Solver match), and the
// spends: the cooperative close (client PQ chunks + server ECDSA + OP_1) and the refund (client PQ
// chunks + OP_0 after t).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as channel from "../../src/channel/index.js";
import * as pq from "../../src/pq/index.js";
import * as T from "../../src/tx/index.js";

const file = fileURLToPath(new URL("../../../../vectors/pq/yellowback_pq_vectors.json", import.meta.url));
const vec = JSON.parse(readFileSync(file, "utf8")) as { scripts: { name: string; hex: string; type: string; holder: string }[] };
const keys = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../vectors/pq/pq_vectors.json", import.meta.url)), "utf8")) as { keys: { scheme: number; seed: string }[] };

const G = T.hexToBytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
const BRANCH = 0x6d5b7a31;

describe("TX_PQCHANNEL against the node's matcher vectors", () => {
  it(`classifies all ${vec.scripts.length} scripts as MatchPQChannel / Solver do, with the same holder`, () => {
    expect(vec.scripts.length).toBeGreaterThan(300);
    for (const s of vec.scripts) {
      const spk = T.hexToBytes(s.hex);
      const ch = channel.parsePQChannelScript(spk);
      const pkh = pq.pqpkhKeyId(spk);
      const type = ch ? "pqchannel" : pkh ? "pqpubkeyhash" : "other";
      expect(`${s.name}: ${type}`).toBe(`${s.name}: ${s.type}`);
      const id = ch?.client ?? pkh;
      const holder = id ? T.bytesToHex(Uint8Array.from([id.scheme, ...id.hash])) : "";
      expect(`${s.name}: ${holder}`).toBe(`${s.name}: ${s.holder}`);
      if (ch) {
        expect(T.bytesToHex(channel.buildPQChannelScript(ch))).toBe(s.hex);
        expect(channel.channelScriptPubKey(spk)).toEqual(spk); // bare: its own scriptPubKey
      }
    }
  });

  it("is `63 20<h> 5n c2 69 21<pk> ac 67 <num> b1 75 20<h> 5n c2 68`, 112–117 bytes", () => {
    const h = new Uint8Array(32).fill(7);
    const s = channel.buildPQChannelScript({ client: { scheme: 1, hash: h }, serverPubKey: G, refundHeight: 1_000_000 });
    expect(T.bytesToHex(s)).toBe(`6320${"07".repeat(32)}51c26921${T.bytesToHex(G)}ac670340420fb17520${"07".repeat(32)}51c268`);
    expect(channel.buildPQChannelScript({ client: { scheme: 2, hash: h }, serverPubKey: G, refundHeight: 1 }).length).toBe(112);
    expect(channel.buildPQChannelScript({ client: { scheme: 2, hash: h }, serverPubKey: G, refundHeight: 499_999_999 }).length).toBe(116);
    expect(() => channel.buildPQChannelScript({ client: { scheme: 1, hash: h }, serverPubKey: G, refundHeight: 500_000_000 })).toThrow(/block height/);
    expect(() => channel.buildPQChannelScript({ client: { scheme: 1, hash: h }, serverPubKey: Uint8Array.from([2, ...new Uint8Array(32)]), refundHeight: 5 })).toThrow(/valid compressed/);
    expect(() => channel.buildPQChannelScript({ client: { scheme: 3 as pq.PQScheme, hash: h }, serverPubKey: G, refundHeight: 5 })).toThrow(/scheme 3/);
  });
});

describe("TX_PQCHANNEL spends", () => {
  const serverPriv = T.hexToBytes("44".repeat(32));
  const serverPub = T.pubkeyFromPriv(serverPriv);
  const kp = pq.pqKeygen(1, T.hexToBytes(keys.keys[0]!.seed));
  const client = pq.keyIdOf(1, kp.publicKey);
  const rs = channel.buildPQChannelScript({ client, serverPubKey: serverPub, refundHeight: 1200 });
  const payTo = T.p2pkhScript(new Uint8Array(20).fill(0xaa));
  const returnScript = pq.pqpkhScript({ scheme: 1, hash: new Uint8Array(32).fill(0xbb) });
  const ch = channel.channelFromScript({ outpoint: { txid: "ab".repeat(32), vout: 0 }, redeemScript: rs, value: 50_000n, closeFee: 30_000n, payToScript: payTo });
  const layout = channel.yedVoucherLayout(2_000n);

  it("parses into a PQChannel with the client's key id, S and t", () => {
    expect(ch.template).toBe("pq");
    if (ch.template !== "pq") return;
    expect(ch.client).toEqual(client);
    expect(ch.serverPubKey).toEqual(serverPub);
    expect(ch.refundHeight).toBe(1200);
    expect(channel.channelTermsOf(rs)).toEqual({ serverPubKey: serverPub, refundHeight: 1200, template: "pq" });
  });

  it("voucher → server completion: `OP_0|<sigS> <sigC chunks> 16 <pk> 1 OP_1` (s + p + 4 pushes), both signatures over one sighash", () => {
    const v = channel.buildVoucher({ channel: ch, cumulative: 100n, clientScript: returnScript, clientPQKey: kp, branchId: BRANCH, layout });
    expect(channel.checkVoucherShape(v, ch, 100n, { layout, clientScript: returnScript })).toBeNull();
    expect(channel.verifyVoucherSignature(v, ch, BRANCH)).toBe(true);
    expect(channel.verifyVoucherSignature(v, ch, 0x19bd2d2f)).toBe(false); // the branch id is signed
    const open = channel.parsePQCloseScriptSig(v.vin[0]!.scriptSig)!;
    expect(open.sigS.length).toBe(0);
    expect(T.parseScript(v.vin[0]!.scriptSig).length).toBe(16 + 1 + 4);
    const done = channel.completeVoucher(v, ch, serverPriv, BRANCH);
    const ps = channel.parsePQCloseScriptSig(done.vin[0]!.scriptSig)!;
    const sh = channel.voucherSighash(done, ch, BRANCH);
    expect(T.verifyInputSig(ps.sigS, sh, serverPub)).toBe(true);
    expect(pq.pqVerify(1, ps.spend.pk, ps.spend.sig.subarray(0, -1), sh)).toBe(true);
    expect(done.vin[0]!.scriptSig.length).toBeLessThanOrEqual(8013); // the node's 9,000-byte PQ allowance covers it
    expect(channel.checkVoucherShape(done, ch, 100n, { layout, clientScript: returnScript })).toBe("script_sig");
    expect(channel.checkVoucherShape(done, ch, 100n, { layout, clientScript: returnScript, allowCompleted: true })).toBeNull();
    // the fee is exactly closeFee, and closeFee covers the close's floor
    expect(channel.closeFeeFloor(rs, done.vout)).toBeLessThanOrEqual(30_000n);
    expect(channel.closeFeeFloor(rs, done.vout)).toBe(27_000n);
  });

  it("refuses another client key, a P2SH-shaped scriptSig and a non-ALL hash type", () => {
    const other = pq.pqKeygen(1, T.hexToBytes(keys.keys[1]!.seed));
    expect(() => channel.buildVoucher({ channel: ch, cumulative: 100n, clientScript: returnScript, clientPQKey: other, branchId: BRANCH, layout })).toThrow(/not the channel's client key/);
    expect(() => channel.buildVoucher({ channel: ch, cumulative: 100n, clientScript: returnScript, branchId: BRANCH, layout })).toThrow(/post-quantum key/);
    const v = channel.buildVoucher({ channel: ch, cumulative: 100n, clientScript: returnScript, clientPQKey: kp, branchId: BRANCH, layout });
    const ps = channel.parsePQCloseScriptSig(v.vin[0]!.scriptSig)!;
    const none = Uint8Array.from(ps.spend.sig);
    none[none.length - 1] = 0x02;
    const bad = { ...v, vin: [{ ...v.vin[0]!, scriptSig: channel.pqCloseScriptSig(new Uint8Array(), ps.spend.pk, none) }] };
    expect(channel.verifyVoucherSignature(bad, ch, BRANCH)).toBe(false);
    const p2shLike = { ...v, vin: [{ ...v.vin[0]!, scriptSig: T.p2shScriptSig([T.OP.OP_0, new Uint8Array(72), T.OP.OP_0, T.OP.OP_1], rs) }] };
    expect(channel.checkVoucherShape(p2shLike, ch, 100n, { layout, clientScript: returnScript })).toBe("script_sig");
  });

  it("refund: `<sigC chunks> 16 <pk> 1 OP_0` (s + p + 3 pushes), nLockTime ≥ t, non-final sequence, a TRANSFER of all of D", () => {
    const r = channel.buildYedRefund({ channel: ch, clientPQKey: kp, toScript: returnScript, branchId: BRANCH, depositCents: 2_000n });
    expect(r.lockTime).toBe(1200);
    expect(r.vin[0]!.sequence).toBe(channel.REFUND_SEQUENCE);
    const chunks = T.parseScript(r.vin[0]!.scriptSig);
    expect(chunks.length).toBe(16 + 1 + 3);
    expect(chunks.at(-1)!.op).toBe(T.OP.OP_0);
    const sp = pq.parsePQSpend(chunks.slice(0, -1))!;
    const sh = T.sighashV4(r, 0, rs, ch.value, T.SIGHASH.ALL, BRANCH);
    expect(pq.pqVerify(1, sp.pk, sp.sig.subarray(0, -1), sh)).toBe(true);
    expect(T.bytesToHex(r.vout[1]!.scriptPubKey)).toBe(T.bytesToHex(returnScript));
    expect(r.vout[1]!.value).toBe(50_000n - T.feeFloor(r));
  });

  it("the YED voucher layout takes a P2PKH or post-quantum return script, never P2SH", () => {
    expect(() => layout({ channel: ch, cumulative: 100n, clientScript: T.p2shScript(new Uint8Array(20)) })).toThrow(/key-hash/);
    expect(layout({ channel: ch, cumulative: 100n, clientScript: returnScript })).toHaveLength(3);
    expect(layout({ channel: ch, cumulative: 100n, clientScript: T.p2pkhScript(new Uint8Array(20).fill(1)) })).toHaveLength(3);
  });

  it("a Falcon client's voucher is a function of the channel, the cumulative and the branch id (derived entropy): re-signing yields the same bytes", () => {
    const fk = pq.pqKeygen(2, T.hexToBytes("5a".repeat(48)));
    const frs = channel.buildPQChannelScript({ client: pq.keyIdOf(2, fk.publicKey), serverPubKey: serverPub, refundHeight: 1200 });
    const fch = channel.channelFromScript({ outpoint: { txid: "cd".repeat(32), vout: 0 }, redeemScript: frs, value: 26_000n, closeFee: 6_000n, payToScript: payTo });
    const falconReturn = pq.pqpkhScript({ scheme: 2, hash: new Uint8Array(32).fill(0xcc) });
    const sign = (cumulative: bigint) => T.serializeTxHex(channel.buildVoucher({ channel: fch, cumulative, clientScript: falconReturn, clientPQKey: fk, branchId: BRANCH, layout }));
    const a = sign(100n);
    expect(sign(100n)).toBe(a); // a restarted client (the CLI between `channel open` and `pay`) re-signs the stored voucher's bytes
    expect(sign(125n)).not.toBe(a);
    const v = T.parseTx(a);
    const spend = channel.parsePQCloseScriptSig(v.vin[0]!.scriptSig)!;
    expect(spend.spend.scheme).toBe(2);
    expect(channel.verifyVoucherSignature(v, fch, BRANCH)).toBe(true);
  });
});
