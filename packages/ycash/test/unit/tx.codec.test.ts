import { describe, expect, it } from "vitest";
import {
  type SAPLING_VERSION_GROUP_ID, SEQUENCE_FINAL, bytesToHex, hasShielded, hexToBytes, newTx, p2pkhScript, parseTx,
  serializeTx, serializeTxHex, txid, type Tx,
} from "../../src/tx/index.js";
import { ByteReader, ByteWriter } from "../../src/tx/bytes.js";
import { JOINSPLIT_SIZE } from "../../src/tx/tx.js";

const PREV = "7eee2c59d6e8d62eb5f29e37eb9bb019b8d76a9c4d16b51912fb5047e667c756";

function sample(): Tx {
  return newTx({
    vin: [{ prevout: { txid: PREV, vout: 1 }, scriptSig: Uint8Array.of(1, 2, 3), sequence: 0xfffffffe }],
    vout: [{ value: 123_456n, scriptPubKey: p2pkhScript(new Uint8Array(20).fill(7)) }],
    lockTime: 5,
    expiryHeight: 900,
  });
}

const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

describe("v4 codec", () => {
  it("serialises the v4 header, group id, and empty shielded vectors", () => {
    const hex = serializeTxHex(sample());
    expect(hex.startsWith("04000080" + "85202f89")).toBe(true);
    // lockTime 5, expiry 900, valueBalance 0, three empty vectors, no bindingSig
    expect(hex.endsWith("05000000" + "84030000" + "0000000000000000" + "000000")).toBe(true);
  });

  it("round-trips a transparent tx and keeps the prevout txid in display order", () => {
    const bytes = serializeTx(sample());
    const back = parseTx(bytes);
    expect(back).toEqual(sample());
    expect(back.vin[0]!.prevout.txid).toBe(PREV);
    // internal order on the wire: reversed
    expect(bytesToHex(bytes.slice(9, 41))).toBe(bytesToHex(hexToBytes(PREV).reverse()));
    expect(parseTx(bytesToHex(bytes))).toEqual(back);
  });

  it("computes the txid as reversed SHA256d, from a model, bytes or hex", () => {
    const tx = sample();
    const hex = serializeTxHex(tx);
    expect(txid(tx)).toMatch(/^[0-9a-f]{64}$/);
    expect(txid(hex)).toBe(txid(tx));
    expect(txid(hexToBytes(hex))).toBe(txid(tx));
  });

  it("round-trips Sapling spends and outputs with every field addressable, plus the binding sig", () => {
    const tx = sample();
    tx.valueBalance = -5000n;
    tx.shieldedSpends = [{ cv: fill(32, 1), anchor: fill(32, 2), nullifier: fill(32, 3), rk: fill(32, 4), zkproof: fill(192, 5), spendAuthSig: fill(64, 6) }];
    tx.shieldedOutputs = [
      { cv: fill(32, 7), cmu: fill(32, 8), ephemeralKey: fill(32, 9), encCiphertext: fill(580, 10), outCiphertext: fill(80, 11), zkproof: fill(192, 12) },
      { cv: fill(32, 13), cmu: fill(32, 14), ephemeralKey: fill(32, 15), encCiphertext: fill(580, 16), outCiphertext: fill(80, 17), zkproof: fill(192, 18) },
    ];
    tx.bindingSig = fill(64, 19);
    const back = parseTx(serializeTx(tx));
    expect(back).toEqual(tx);
    expect(back.shieldedOutputs[1]!.encCiphertext[0]).toBe(16);
    expect(hasShielded(back)).toBe(true);
    expect(back.valueBalance).toBe(-5000n);
  });

  it("round-trips JoinSplits with their pubkey and signature, and no binding sig without Sapling parts", () => {
    const tx = sample();
    tx.joinSplits = [fill(JOINSPLIT_SIZE, 1), fill(JOINSPLIT_SIZE, 2)];
    tx.joinSplitPubKey = fill(32, 3);
    tx.joinSplitSig = fill(64, 4);
    const bytes = serializeTx(tx);
    expect(parseTx(bytes)).toEqual(tx);
    expect(hasShielded(tx)).toBe(true);
    expect(() => serializeTx({ ...tx, joinSplitSig: null })).toThrow(/joinSplitSig/);
  });

  it("refuses a Sapling component without a binding sig and mis-sized fields", () => {
    const tx = sample();
    tx.shieldedOutputs = [{ cv: fill(32, 0), cmu: fill(32, 0), ephemeralKey: fill(32, 0), encCiphertext: fill(580, 0), outCiphertext: fill(80, 0), zkproof: fill(192, 0) }];
    expect(() => serializeTx(tx)).toThrow(/bindingSig/);
    tx.bindingSig = fill(64, 0);
    tx.shieldedOutputs[0]!.encCiphertext = fill(579, 0);
    expect(() => serializeTx(tx)).toThrow(/encCiphertext/);
  });

  it("refuses every format but v4 Sapling (v5 is refused by consensus on both lines, plan R-1)", () => {
    const hex = serializeTxHex(sample());
    const v5 = "05000080" + "0a27a726" + hex.slice(16); // NU5 header and group id
    expect(() => parseTx(v5)).toThrow(/only v4 Sapling/);
    const v3 = "03000080" + "7082c403" + hex.slice(16); // Overwinter
    expect(() => parseTx(v3)).toThrow(/unsupported/);
    const notOverwintered = "04000000" + hex.slice(8);
    expect(() => parseTx(notOverwintered)).toThrow(/unsupported/);
    const wrongGroup = "04000080" + "00000000" + hex.slice(16);
    expect(() => parseTx(wrongGroup)).toThrow(/unsupported/);
    expect(() => serializeTx({ ...sample(), versionGroupId: 0 as typeof SAPLING_VERSION_GROUP_ID })).toThrow(/only v4/);
  });

  it("refuses truncation, trailing bytes and bad hex", () => {
    const hex = serializeTxHex(sample());
    expect(() => parseTx(hex.slice(0, -2))).toThrow(/truncated/);
    expect(() => parseTx(hex + "00")).toThrow(/trailing/);
    expect(() => parseTx("zz")).toThrow(/hex/);
    expect(() => parseTx("abc")).toThrow(/hex/);
  });

  it("refuses output values outside 0..MAX_MONEY when serialising", () => {
    const tx = sample();
    tx.vout[0]!.value = -1n;
    expect(() => serializeTx(tx)).toThrow(/range/);
    tx.vout[0]!.value = 21_000_000n * 100_000_000n + 1n;
    expect(() => serializeTx(tx)).toThrow(/range/);
  });

  it("defaults to a final, never-expiring transparent tx", () => {
    const tx = newTx();
    expect([tx.lockTime, tx.expiryHeight, tx.valueBalance, hasShielded(tx)]).toEqual([0, 0, 0n, false]);
    expect(SEQUENCE_FINAL).toBe(0xffffffff);
  });
});

describe("CompactSize", () => {
  it("writes and reads each width", () => {
    for (const n of [0, 252, 253, 0xffff, 0x10000, 0x02000000]) {
      const b = new ByteWriter().compactSize(n).finish();
      expect(new ByteReader(b).compactSize()).toBe(n);
    }
    expect(new ByteWriter().compactSize(253).finish()).toEqual(Uint8Array.of(0xfd, 0xfd, 0x00));
  });

  it("refuses non-canonical encodings and sizes above MAX_SIZE, as serialize.h does", () => {
    expect(() => new ByteReader(Uint8Array.of(0xfd, 0x10, 0x00)).compactSize()).toThrow(/non-canonical/);
    expect(() => new ByteReader(Uint8Array.of(0xfe, 0xff, 0xff, 0x00, 0x00)).compactSize()).toThrow(/non-canonical/);
    expect(() => new ByteReader(Uint8Array.of(0xfe, 0x01, 0x00, 0x00, 0x02)).compactSize()).toThrow(/too large/);
  });

  it("writes int64 values in two's complement", () => {
    expect(bytesToHex(new ByteWriter().i64(-1n).finish())).toBe("ffffffffffffffff");
    expect(new ByteReader(new ByteWriter().i64(-5000n).finish()).i64()).toBe(-5000n);
  });
});
