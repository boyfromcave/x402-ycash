// ZIP-243 signature hash, bound to the consensus branch id.
// Source: ycash-dd/src/script/interpreter.cpp:1099-1250 (SignatureHash, SIGVERSION_SAPLING; same on
// ycash6), qa/rpc-tests/test_framework/script.py:829-935, yew/core/src/tx.rs:347.
import { ByteWriter, concatBytes } from "./bytes.js";
import { blake2b256 } from "./hash.js";
import { writeOutPoint, writeOutputDescription, writeTxOut, type Tx } from "./tx.js";

export const SIGHASH = {
  ALL: 0x01,
  NONE: 0x02,
  SINGLE: 0x03,
  ANYONECANPAY: 0x80,
} as const;

const ZERO: Uint8Array = new Uint8Array(32);

function prevoutsHash(tx: Tx): Uint8Array {
  const w = new ByteWriter();
  for (const i of tx.vin) writeOutPoint(w, i.prevout);
  return blake2b256("ZcashPrevoutHash", w.finish());
}

function sequenceHash(tx: Tx): Uint8Array {
  const w = new ByteWriter();
  for (const i of tx.vin) w.u32(i.sequence);
  return blake2b256("ZcashSequencHash", w.finish());
}

function outputsHash(outs: Tx["vout"]): Uint8Array {
  const w = new ByteWriter();
  for (const o of outs) writeTxOut(w, o);
  return blake2b256("ZcashOutputsHash", w.finish());
}

function joinSplitsHash(tx: Tx): Uint8Array {
  if (tx.joinSplits.length === 0) return ZERO;
  return blake2b256("ZcashJSplitsHash", concatBytes(...tx.joinSplits, tx.joinSplitPubKey ?? new Uint8Array(32)));
}

/** spendAuthSig is not committed (interpreter.cpp:1108-1118). */
function shieldedSpendsHash(tx: Tx): Uint8Array {
  if (tx.shieldedSpends.length === 0) return ZERO;
  const w = new ByteWriter();
  for (const s of tx.shieldedSpends) w.bytes(s.cv).bytes(s.anchor).bytes(s.nullifier).bytes(s.rk).bytes(s.zkproof);
  return blake2b256("ZcashSSpendsHash", w.finish());
}

function shieldedOutputsHash(tx: Tx): Uint8Array {
  if (tx.shieldedOutputs.length === 0) return ZERO;
  const w = new ByteWriter();
  for (const o of tx.shieldedOutputs) writeOutputDescription(w, o);
  return blake2b256("ZcashSOutputHash", w.finish());
}

/**
 * The ZIP-243 sighash for a transparent input (or, with `inputIndex` null, the hash the
 * joinSplitSig and Sapling signatures cover). `scriptCode` is the spent scriptPubKey for P2PKH
 * and the redeem script for P2SH; `amount` is the spent output's value in zatoshi.
 */
export function sighashV4(
  tx: Tx,
  inputIndex: number | null,
  scriptCode: Uint8Array,
  amount: bigint,
  hashType: number,
  consensusBranchId: number,
): Uint8Array {
  if (inputIndex !== null && (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.vin.length)) {
    throw new Error(`input index ${inputIndex} out of range`);
  }
  const base = hashType & 0x1f;
  const anyoneCanPay = (hashType & SIGHASH.ANYONECANPAY) !== 0;
  const singleOrNone = base === SIGHASH.SINGLE || base === SIGHASH.NONE;

  const hPrevouts = anyoneCanPay ? ZERO : prevoutsHash(tx);
  const hSequence = anyoneCanPay || singleOrNone ? ZERO : sequenceHash(tx);
  let hOutputs = ZERO;
  if (!singleOrNone) hOutputs = outputsHash(tx.vout);
  else if (base === SIGHASH.SINGLE && inputIndex !== null && inputIndex < tx.vout.length) {
    hOutputs = outputsHash([tx.vout[inputIndex]!]);
  }

  const w = new ByteWriter();
  w.u32((0x80000000 | tx.version) >>> 0).u32(tx.versionGroupId);
  w.bytes(hPrevouts).bytes(hSequence).bytes(hOutputs);
  w.bytes(joinSplitsHash(tx)).bytes(shieldedSpendsHash(tx)).bytes(shieldedOutputsHash(tx));
  w.u32(tx.lockTime).u32(tx.expiryHeight).i64(tx.valueBalance).u32(hashType >>> 0);
  if (inputIndex !== null) {
    const i = tx.vin[inputIndex]!;
    writeOutPoint(w, i.prevout);
    w.varBytes(scriptCode).i64(amount).u32(i.sequence);
  }
  const person = new Uint8Array(16);
  person.set(new TextEncoder().encode("ZcashSigHash"));
  new DataView(person.buffer).setUint32(12, consensusBranchId >>> 0, true);
  return blake2b256(person, w.finish());
}
