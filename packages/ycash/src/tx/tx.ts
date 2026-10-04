// The v4 (Overwinter-flagged, Sapling version group) transaction: model, parser and serialiser.
// Wire order: ycash-dd/src/primitives/transaction.h:575-640 (same on ycash6). v4 is the only format
// either line relays: v5 is refused by consensus while NU5 has no activation height (plan R-1).
import { ByteReader, ByteWriter, bytesToHex, fromReversedHex, hexToBytes, reversedHex } from "./bytes.js";
import { sha256d } from "./hash.js";

/** fOverwintered | nVersion = 4. */
export const TX_VERSION = 4;
/** SAPLING_VERSION_GROUP_ID, src/primitives/transaction.h:39. */
export const SAPLING_VERSION_GROUP_ID = 0x892f2085;
/** CTxIn::SEQUENCE_FINAL. */
export const SEQUENCE_FINAL = 0xffffffff;

// Shielded structure sizes (src/primitives/transaction.h:78-152, src/zcash/Zcash.h).
export const SPEND_DESCRIPTION_SIZE = 384;
export const OUTPUT_DESCRIPTION_SIZE = 948;
/** A v4 JSDescription carries a Groth16 proof (src/primitives/transaction.h:78). */
export const JOINSPLIT_SIZE = 1698;
export const ENC_CIPHERTEXT_SIZE = 580;
export const OUT_CIPHERTEXT_SIZE = 80;
export const GROTH_PROOF_SIZE = 192;

export interface OutPoint {
  /** Display-order hex (as the node's RPCs print it). */
  txid: string;
  vout: number;
}

export interface TxIn {
  prevout: OutPoint;
  scriptSig: Uint8Array;
  sequence: number;
}

export interface TxOut {
  /** zatoshi */
  value: bigint;
  scriptPubKey: Uint8Array;
}

/** A Sapling spend, fields kept addressable (all byte strings in wire order). */
export interface SpendDescription {
  cv: Uint8Array;
  anchor: Uint8Array;
  nullifier: Uint8Array;
  rk: Uint8Array;
  zkproof: Uint8Array;
  spendAuthSig: Uint8Array;
}

/** A Sapling output; a facilitator trial-decrypts encCiphertext (X4b). */
export interface OutputDescription {
  cv: Uint8Array;
  cmu: Uint8Array;
  ephemeralKey: Uint8Array;
  encCiphertext: Uint8Array;
  outCiphertext: Uint8Array;
  zkproof: Uint8Array;
}

export interface Tx {
  version: typeof TX_VERSION;
  overwintered: true;
  versionGroupId: typeof SAPLING_VERSION_GROUP_ID;
  vin: TxIn[];
  vout: TxOut[];
  lockTime: number;
  /** 0 = never expires. */
  expiryHeight: number;
  /** Sapling value balance, zatoshi (int64). */
  valueBalance: bigint;
  shieldedSpends: SpendDescription[];
  shieldedOutputs: OutputDescription[];
  /** Opaque JSDescriptions, JOINSPLIT_SIZE bytes each. */
  joinSplits: Uint8Array[];
  /** Present iff joinSplits is non-empty (32 and 64 bytes). */
  joinSplitPubKey: Uint8Array | null;
  joinSplitSig: Uint8Array | null;
  /** Present iff there is a shielded spend or output (64 bytes). */
  bindingSig: Uint8Array | null;
}

/**
 * A transparent v4 transaction; callers fill vin/vout and the heights.
 *
 * @param fields - Initial inputs, outputs, lock time and expiry height; the rest default to empty.
 * @returns The transaction.
 */
export function newTx(fields: Partial<Pick<Tx, "vin" | "vout" | "lockTime" | "expiryHeight">> = {}): Tx {
  return {
    version: TX_VERSION,
    overwintered: true,
    versionGroupId: SAPLING_VERSION_GROUP_ID,
    vin: fields.vin ?? [],
    vout: fields.vout ?? [],
    lockTime: fields.lockTime ?? 0,
    expiryHeight: fields.expiryHeight ?? 0,
    valueBalance: 0n,
    shieldedSpends: [],
    shieldedOutputs: [],
    joinSplits: [],
    joinSplitPubKey: null,
    joinSplitSig: null,
    bindingSig: null,
  };
}

/**
 * True when the tx carries any Sprout or Sapling component (a transparent binding refuses it).
 *
 * @param tx - The transaction.
 * @returns Whether it has a spend, output or JoinSplit.
 */
export function hasShielded(tx: Tx): boolean {
  return tx.shieldedSpends.length > 0 || tx.shieldedOutputs.length > 0 || tx.joinSplits.length > 0;
}

/**
 * Writes an outpoint: the txid in internal byte order, then the output index.
 *
 * @param w - The writer.
 * @param p - The outpoint, txid in display order.
 */
export function writeOutPoint(w: ByteWriter, p: OutPoint): void {
  w.bytes(fromReversedHex(p.txid)).u32(p.vout);
}

/**
 * Writes an output: the int64 value then the length-prefixed scriptPubKey.
 *
 * @param w - The writer.
 * @param o - The output.
 */
export function writeTxOut(w: ByteWriter, o: TxOut): void {
  w.i64(o.value).varBytes(o.scriptPubKey);
}

/**
 * Writes an input: outpoint, length-prefixed scriptSig, nSequence.
 *
 * @param w - The writer.
 * @param i - The input.
 */
export function writeTxIn(w: ByteWriter, i: TxIn): void {
  writeOutPoint(w, i.prevout);
  w.varBytes(i.scriptSig).u32(i.sequence);
}

/**
 * Writes a Sapling output description in wire order.
 *
 * @param w - The writer.
 * @param d - The output description.
 */
export function writeOutputDescription(w: ByteWriter, d: OutputDescription): void {
  w.bytes(d.cv).bytes(d.cmu).bytes(d.ephemeralKey).bytes(d.encCiphertext).bytes(d.outCiphertext).bytes(d.zkproof);
}

/**
 * Writes a Sapling spend description in wire order, spendAuthSig included.
 *
 * @param w - The writer.
 * @param d - The spend description.
 */
function writeSpendDescription(w: ByteWriter, d: SpendDescription): void {
  w.bytes(d.cv).bytes(d.anchor).bytes(d.nullifier).bytes(d.rk).bytes(d.zkproof).bytes(d.spendAuthSig);
}

/**
 * Guards a fixed-size field before it is serialized.
 *
 * @param b - The field, or null when absent.
 * @param len - The required length in bytes.
 * @param what - The field name used in the error message.
 * @returns `b` unchanged.
 * @throws Error when `b` is null or the wrong length.
 */
function fixed(b: Uint8Array | null, len: number, what: string): Uint8Array {
  if (b === null || b.length !== len) throw new Error(`${what} must be ${len} bytes`);
  return b;
}

/**
 * Refuses anything that would not serialize as a valid v4 transaction: a wrong header, an output
 * value outside 0..21M coins, or a shielded field of the wrong size.
 *
 * @param tx - The transaction.
 * @throws Error describing the first problem found.
 */
function checkShape(tx: Tx): void {
  if (tx.version !== TX_VERSION || tx.overwintered !== true || tx.versionGroupId !== SAPLING_VERSION_GROUP_ID) {
    throw new Error("only v4 (Sapling version group) transactions are supported");
  }
  for (const o of tx.vout) {
    if (o.value < 0n || o.value > 21_000_000n * 100_000_000n) throw new Error("output value out of range");
  }
  for (const s of tx.shieldedSpends) {
    fixed(s.cv, 32, "cv"); fixed(s.anchor, 32, "anchor"); fixed(s.nullifier, 32, "nullifier"); fixed(s.rk, 32, "rk");
    fixed(s.zkproof, GROTH_PROOF_SIZE, "zkproof"); fixed(s.spendAuthSig, 64, "spendAuthSig");
  }
  for (const o of tx.shieldedOutputs) {
    fixed(o.cv, 32, "cv"); fixed(o.cmu, 32, "cmu"); fixed(o.ephemeralKey, 32, "ephemeralKey");
    fixed(o.encCiphertext, ENC_CIPHERTEXT_SIZE, "encCiphertext"); fixed(o.outCiphertext, OUT_CIPHERTEXT_SIZE, "outCiphertext");
    fixed(o.zkproof, GROTH_PROOF_SIZE, "zkproof");
  }
  for (const js of tx.joinSplits) fixed(js, JOINSPLIT_SIZE, "JSDescription");
}

/**
 * Serializes a v4 transaction in wire order, after a shape check.
 *
 * @param tx - The transaction.
 * @returns The raw transaction bytes.
 * @throws Error when the transaction is malformed.
 */
export function serializeTx(tx: Tx): Uint8Array {
  checkShape(tx);
  const w = new ByteWriter();
  w.u32((0x80000000 | tx.version) >>> 0).u32(tx.versionGroupId);
  w.compactSize(tx.vin.length);
  for (const i of tx.vin) writeTxIn(w, i);
  w.compactSize(tx.vout.length);
  for (const o of tx.vout) writeTxOut(w, o);
  w.u32(tx.lockTime).u32(tx.expiryHeight).i64(tx.valueBalance);
  w.compactSize(tx.shieldedSpends.length);
  for (const s of tx.shieldedSpends) writeSpendDescription(w, s);
  w.compactSize(tx.shieldedOutputs.length);
  for (const o of tx.shieldedOutputs) writeOutputDescription(w, o);
  w.compactSize(tx.joinSplits.length);
  for (const js of tx.joinSplits) w.bytes(js);
  if (tx.joinSplits.length > 0) {
    w.bytes(fixed(tx.joinSplitPubKey, 32, "joinSplitPubKey")).bytes(fixed(tx.joinSplitSig, 64, "joinSplitSig"));
  }
  if (tx.shieldedSpends.length > 0 || tx.shieldedOutputs.length > 0) w.bytes(fixed(tx.bindingSig, 64, "bindingSig"));
  return w.finish();
}

/**
 * Parses a raw v4 Sapling-group transaction, rejecting any other format and trailing bytes.
 *
 * @param input - The raw transaction, as hex or bytes.
 * @returns The transaction.
 * @throws Error on another version, truncation, a non-canonical CompactSize or trailing bytes.
 */
export function parseTx(input: string | Uint8Array): Tx {
  const bytes = typeof input === "string" ? hexToBytes(input) : input;
  const r = new ByteReader(bytes);
  const header = r.u32();
  const versionGroupId = r.u32();
  if (header >>> 31 !== 1 || (header & 0x7fffffff) !== TX_VERSION || versionGroupId !== SAPLING_VERSION_GROUP_ID) {
    throw new Error(
      `unsupported transaction format: header 0x${header.toString(16)}, group 0x${versionGroupId.toString(16)} (only v4 Sapling)`,
    );
  }
  const vin: TxIn[] = [];
  for (let n = r.compactSize(); n > 0; n--) {
    const txid = reversedHex(r.take(32));
    const vout = r.u32();
    vin.push({ prevout: { txid, vout }, scriptSig: r.varBytes(), sequence: r.u32() });
  }
  const vout: TxOut[] = [];
  for (let n = r.compactSize(); n > 0; n--) vout.push({ value: r.i64(), scriptPubKey: r.varBytes() });
  const lockTime = r.u32();
  const expiryHeight = r.u32();
  const valueBalance = r.i64();
  const shieldedSpends: SpendDescription[] = [];
  for (let n = r.compactSize(); n > 0; n--) {
    shieldedSpends.push({
      cv: r.take(32), anchor: r.take(32), nullifier: r.take(32), rk: r.take(32),
      zkproof: r.take(GROTH_PROOF_SIZE), spendAuthSig: r.take(64),
    });
  }
  const shieldedOutputs: OutputDescription[] = [];
  for (let n = r.compactSize(); n > 0; n--) {
    shieldedOutputs.push({
      cv: r.take(32), cmu: r.take(32), ephemeralKey: r.take(32),
      encCiphertext: r.take(ENC_CIPHERTEXT_SIZE), outCiphertext: r.take(OUT_CIPHERTEXT_SIZE), zkproof: r.take(GROTH_PROOF_SIZE),
    });
  }
  const joinSplits: Uint8Array[] = [];
  for (let n = r.compactSize(); n > 0; n--) joinSplits.push(r.take(JOINSPLIT_SIZE));
  const joinSplitPubKey = joinSplits.length > 0 ? r.take(32) : null;
  const joinSplitSig = joinSplits.length > 0 ? r.take(64) : null;
  const bindingSig = shieldedSpends.length > 0 || shieldedOutputs.length > 0 ? r.take(64) : null;
  if (r.remaining !== 0) throw new Error(`${r.remaining} trailing bytes`);
  return {
    version: TX_VERSION, overwintered: true, versionGroupId: SAPLING_VERSION_GROUP_ID,
    vin, vout, lockTime, expiryHeight, valueBalance,
    shieldedSpends, shieldedOutputs, joinSplits, joinSplitPubKey, joinSplitSig, bindingSig,
  };
}

/**
 * The txid in display order: SHA256d of the serialisation, reversed.
 *
 * @param tx - The transaction, or its raw bytes or hex.
 * @returns The display-order txid hex.
 */
export function txid(tx: Tx | Uint8Array | string): string {
  const bytes = typeof tx === "string" ? hexToBytes(tx) : tx instanceof Uint8Array ? tx : serializeTx(tx);
  return reversedHex(sha256d(bytes));
}

/**
 * Serializes a v4 transaction to hex, as `sendrawtransaction` takes it.
 *
 * @param tx - The transaction.
 * @returns The raw transaction hex.
 */
export function serializeTxHex(tx: Tx): string {
  return bytesToHex(serializeTx(tx));
}
