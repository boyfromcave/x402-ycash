// Builds the `sapling` payload for the unit tests: a v4 transaction with Sapling outputs whose note
// ciphertexts are real (encrypted to the test key with the SDK's own primitives, so the facilitator's
// trial decryption, cmu and epk checks run for real) and whose proofs, value commitments and
// signatures are placeholders (the node checks those at relay; here a fake node accepts them).
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { jubjub, jubjub_groupHash } from "@noble/curves/misc.js";
import { YCASH_REGTEST, type YcashNetwork } from "../../../src/constants.js";
import {
  bech32Decode,
  extractU,
  kdfSapling,
  LEAD_BYTE_ZIP212,
  noteCommitment,
  noteRcm,
  prfExpandToScalar,
  saplingAddressAt,
  type SaplingIncomingKey,
} from "../../../src/shielded/index.js";
import { newTx, serializeTxHex, txid as txidOf, type OutputDescription, type Tx } from "../../../src/tx/index.js";

/** A fixed test key: ivk below 2^251, dk arbitrary. The address at index 0 is the merchant's payTo. */
export const TEST_KEY: SaplingIncomingKey = {
  network: YCASH_REGTEST,
  ivk: BigInt("0x0" + "4a".repeat(31) + "7"),
  dk: Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 0xff),
};
export const OTHER_KEY: SaplingIncomingKey = { ...TEST_KEY, ivk: TEST_KEY.ivk + 12345n };

const DIVERSIFY = new TextEncoder().encode("Zcash_gd");

/**
 * The first valid address of a key at or after an index, with its diversifier and pk_d.
 *
 * @param key - The incoming key.
 * @param from - The index to start at.
 * @returns Address and components.
 */
export function addressOf(key: SaplingIncomingKey, from = 0n): { address: string; index: bigint } {
  for (let j = from; ; j++) {
    const address = saplingAddressAt(key, j);
    if (address) return { address, index: j };
  }
}

export interface NoteSpec {
  /** The recipient's key (whose ivk derives pk_d) and diversifier index. */
  key: SaplingIncomingKey;
  index: bigint;
  value: bigint;
  memo: string;
  leadByte?: number;
  rseed?: Uint8Array;
}

/**
 * Encrypts one note into an output description the recipient's ivk decrypts.
 *
 * @param spec - The note.
 * @returns The output description.
 */
export function encryptNote(spec: NoteSpec): OutputDescription {
  const leadByte = spec.leadByte ?? LEAD_BYTE_ZIP212;
  const rseed = spec.rseed ?? crypto.getRandomValues(new Uint8Array(32));
  // The diversifier at the index: re-derive it from the address bytes the key produces.
  const address = saplingAddressAt(spec.key, spec.index);
  if (!address) throw new Error(`index ${spec.index} has no address`);
  const d = bech32Decode(address).bytes.subarray(0, 11);
  const gd = jubjub_groupHash(d, DIVERSIFY);
  const pkd = gd.multiply(spec.key.ivk);
  const esk = leadByte === LEAD_BYTE_ZIP212 ? prfExpandToScalar(rseed, 0x05) : 777n;
  const epk = gd.multiply(esk).toBytes();
  const shared = pkd.multiply(esk).clearCofactor().toBytes();
  const plaintext = new Uint8Array(564);
  plaintext[0] = leadByte;
  plaintext.set(d, 1);
  new DataView(plaintext.buffer).setBigUint64(12, spec.value, true);
  plaintext.set(rseed, 20);
  plaintext.set(new TextEncoder().encode(spec.memo), 52);
  const rcm = noteRcm({ leadByte, rseed });
  if (rcm === undefined) throw new Error("rseed is not a scalar");
  const cmu = extractU(noteCommitment(gd.toBytes(), pkd.toBytes(), spec.value, rcm));
  return {
    cv: jubjub.Point.BASE.multiply(BigInt(1000 + Number(spec.index))).toBytes(),
    cmu,
    ephemeralKey: epk,
    encCiphertext: chacha20poly1305(kdfSapling(shared, epk), new Uint8Array(12)).encrypt(plaintext),
    outCiphertext: new Uint8Array(80).fill(0x5a),
    zkproof: new Uint8Array(192).fill(0x7e),
  };
}

export interface PaymentTxSpec {
  notes: NoteSpec[];
  /** Sapling spends, placeholders (default 1). */
  spends?: number;
  /** valueBalance: the net value leaving the shielded pool, i.e. the fee of a z→z payment. */
  valueBalance: bigint;
  expiryHeight: number;
  lockTime?: number;
  /** Transparent inputs, as prevout references (the fake node must know them). */
  vin?: { txid: string; vout: number; scriptSig: Uint8Array }[];
  vout?: { value: bigint; scriptPubKey: Uint8Array }[];
}

/**
 * A z→z (or t→z) payment transaction with real note ciphertexts and placeholder proofs.
 *
 * @param spec - Notes, spends, fee, expiry and optional transparent parts.
 * @returns The transaction, its hex and txid.
 */
export function buildPaymentTx(spec: PaymentTxSpec): { tx: Tx; hex: string; txid: string } {
  const tx = newTx({
    expiryHeight: spec.expiryHeight,
    lockTime: spec.lockTime ?? 0,
    vin: (spec.vin ?? []).map((i) => ({ prevout: { txid: i.txid, vout: i.vout }, scriptSig: i.scriptSig, sequence: 0xffffffff })),
    vout: spec.vout ?? [],
  });
  tx.valueBalance = spec.valueBalance;
  tx.shieldedOutputs = spec.notes.map(encryptNote);
  tx.shieldedSpends = Array.from({ length: spec.spends ?? 1 }, (_, i) => ({
    cv: jubjub.Point.BASE.multiply(BigInt(2000 + i)).toBytes(),
    anchor: new Uint8Array(32).fill(0x11),
    nullifier: Uint8Array.from({ length: 32 }, (_, k) => (k * 31 + i) & 0xff),
    rk: jubjub.Point.BASE.multiply(BigInt(3000 + i)).toBytes(),
    zkproof: new Uint8Array(192).fill(0x33),
    spendAuthSig: new Uint8Array(64).fill(0x44),
  }));
  tx.bindingSig = new Uint8Array(64).fill(0x66);
  const hex = serializeTxHex(tx);
  return { tx, hex, txid: txidOf(tx) };
}

export const NETWORK: YcashNetwork = YCASH_REGTEST;
