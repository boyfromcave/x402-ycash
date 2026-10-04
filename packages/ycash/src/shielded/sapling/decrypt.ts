// Sapling note trial decryption with an incoming viewing key, offline (Zcash protocol spec §4.19.2,
// as sapling-crypto 0.7 `note_encryption.rs` and zcash_note_encryption 0.4 `lib.rs:468-550` do it):
// shared secret [8·ivk]·epk, KDF^Sapling, ChaCha20-Poly1305, the plaintext's lead byte, diversifier,
// value, rseed and memo, then pk_d = [ivk]·g_d and the recomputed cmu, which must equal the output's.
// The `sapling` method's facilitator uses it on the transaction the client hands it, before anything
// is broadcast (specs/scheme_exact_ycash.md, "sapling", verification rule 5).
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { jubjub, jubjub_groupHash } from "@noble/curves/misc.js";
import { blake2b } from "@noble/hashes/blake2.js";
import type { YcashNetwork } from "../../constants.js";
import type { OutputDescription } from "../../tx/index.js";
import { SAPLING_HRP } from "../constants.js";
import { bech32Encode } from "./bech32.js";
import { extractU, noteCommitment } from "./pedersen.js";

export const NOTE_PLAINTEXT_SIZE = 564;
export const COMPACT_NOTE_SIZE = 52;
export const MEMO_SIZE = 512;
/** Note plaintext lead bytes: 0x01 before ZIP 212, 0x02 after (`note_encryption.rs:399-404`). */
export const LEAD_BYTE_BEFORE_ZIP212 = 0x01;
export const LEAD_BYTE_ZIP212 = 0x02;

const KDF_PERSONALIZATION = new TextEncoder().encode("Zcash_SaplingKDF");
const PRF_EXPAND_PERSONALIZATION = new TextEncoder().encode("Zcash_ExpandSeed");
const DIVERSIFY_PERSONALIZATION = new TextEncoder().encode("Zcash_gd");
/** PRF^expand domain separators (zcash_spec 0.2 `prf_expand.rs:70-71`). */
const PRF_SAPLING_RCM = 0x04;
const PRF_SAPLING_ESK = 0x05;
const ZERO_NONCE = new Uint8Array(12);
const R = jubjub.Point.CURVE().n;

/** The fields of an output description trial decryption reads. */
export type EncryptedOutput = Pick<OutputDescription, "cmu" | "ephemeralKey" | "encCiphertext">;

/** A decrypted and authenticated note. */
export interface DecryptedNote {
  /** 0x01 or 0x02 */
  leadByte: number;
  /** the 11-byte diversifier */
  diversifier: Uint8Array;
  /** zatoshis */
  value: bigint;
  /** rcm (0x01) or rseed (0x02), 32 bytes as in the plaintext */
  rseed: Uint8Array;
  /** the 512-byte memo field, as sent (trailing zero bytes included) */
  memo: Uint8Array;
  /** repr(pk_d) = [ivk]·g_d */
  pkd: Uint8Array;
  /** the recipient address, bech32 under the network's HRP */
  address: string;
}

/**
 * Little-endian bytes to a non-negative integer.
 *
 * @param bytes - The bytes.
 * @returns Their value.
 */
function leNum(bytes: Uint8Array): bigint {
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i] as number);
  return x;
}

/**
 * KDF^Sapling(sharedSecret, epk) = BLAKE2b-256("Zcash_SaplingKDF", repr(sharedSecret) ‖ epk)
 * (spec §5.4.5.4; `note_encryption.rs:32`).
 *
 * @param sharedSecret - repr of the key agreement output, 32 bytes.
 * @param epk - The ephemeral public key as encoded in the output, 32 bytes.
 * @returns The 32-byte symmetric key.
 */
export function kdfSapling(sharedSecret: Uint8Array, epk: Uint8Array): Uint8Array {
  return blake2b.create({ dkLen: 32, personalization: KDF_PERSONALIZATION }).update(sharedSecret).update(epk).digest();
}

/**
 * KA^Sapling.Agree(ivk, epk) = [8·ivk]·epk, repr'd: the cofactor is cleared, so a small-order
 * component of epk cannot leak ivk bits (`spec.rs:127-136`).
 *
 * @param ivk - The incoming viewing key, a Jubjub scalar.
 * @param epk - The ephemeral key's 32-byte encoding.
 * @returns repr(sharedSecret), or undefined when epk is not a curve point.
 */
export function saplingKaAgree(ivk: bigint, epk: Uint8Array): Uint8Array | undefined {
  let p;
  try {
    p = jubjub.Point.fromBytes(epk);
  } catch {
    return undefined;
  }
  return p.multiplyUnsafe(ivk).clearCofactor().toBytes();
}

/**
 * PRF^expand(sk, t) = BLAKE2b-512("Zcash_ExpandSeed", sk ‖ t), reduced to a Jubjub scalar
 * (ToScalar, LE mod r), as the ZIP 212 rcm and esk derivations do (`note.rs:34-41`, `:148-154`).
 *
 * @param rseed - The 32-byte seed.
 * @param tag - The one-byte domain separator.
 * @returns The scalar.
 */
export function prfExpandToScalar(rseed: Uint8Array, tag: number): bigint {
  const h = blake2b.create({ dkLen: 64, personalization: PRF_EXPAND_PERSONALIZATION }).update(rseed).update(Uint8Array.of(tag)).digest();
  return leNum(h) % R;
}

/**
 * ChaCha20-Poly1305 with the all-zero nonce and no associated data, as Sapling note encryption
 * uses it (spec §5.4.3). A tag failure is "not ours", not an error.
 *
 * @param key - The 32-byte symmetric key.
 * @param ciphertext - The 580-byte ciphertext (564 bytes plus the 16-byte tag).
 * @returns The 564-byte plaintext, or undefined.
 */
export function decryptNoteCiphertext(key: Uint8Array, ciphertext: Uint8Array): Uint8Array | undefined {
  if (ciphertext.length !== NOTE_PLAINTEXT_SIZE + 16) return undefined;
  try {
    return chacha20poly1305(key, ZERO_NONCE).decrypt(ciphertext);
  } catch {
    return undefined;
  }
}

/** A note plaintext taken apart, before any key-dependent check. */
export interface NotePlaintext {
  leadByte: number;
  diversifier: Uint8Array;
  value: bigint;
  rseed: Uint8Array;
  memo: Uint8Array;
}

/**
 * Splits a 564-byte note plaintext: lead byte, d (11), v (u64 LE), rseed (32), memo (512)
 * (`note_encryption.rs:84-110`, `:187-207`).
 *
 * @param p - The plaintext.
 * @returns Its fields, or undefined on a wrong length or an unknown lead byte.
 */
export function parseNotePlaintext(p: Uint8Array): NotePlaintext | undefined {
  if (p.length !== NOTE_PLAINTEXT_SIZE) return undefined;
  const leadByte = p[0] as number;
  if (leadByte !== LEAD_BYTE_BEFORE_ZIP212 && leadByte !== LEAD_BYTE_ZIP212) return undefined;
  return {
    leadByte,
    diversifier: p.slice(1, 12),
    value: new DataView(p.buffer, p.byteOffset + 12, 8).getBigUint64(0, true),
    rseed: p.slice(20, COMPACT_NOTE_SIZE),
    memo: p.slice(COMPACT_NOTE_SIZE, NOTE_PLAINTEXT_SIZE),
  };
}

/**
 * rcm of a note: the plaintext field itself before ZIP 212 (it must be a canonical scalar), else
 * PRF^expand(rseed, [0x04]) (`note.rs:34-41`).
 *
 * @param note - The parsed plaintext.
 * @returns rcm, or undefined when a 0x01 field is not a canonical scalar.
 */
export function noteRcm(note: Pick<NotePlaintext, "leadByte" | "rseed">): bigint | undefined {
  if (note.leadByte === LEAD_BYTE_ZIP212) return prfExpandToScalar(note.rseed, PRF_SAPLING_RCM);
  const r = leNum(note.rseed);
  return r < R ? r : undefined;
}

/**
 * Byte equality.
 *
 * @param a - Left.
 * @param b - Right.
 * @returns True when equal.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Trial-decrypts one Sapling output with an incoming viewing key and authenticates the result
 * the way a receiving wallet does: the AEAD tag, a known lead byte, a valid diversifier, pk_d =
 * [ivk]·g_d, the recomputed cmu equal to the output's, and for a ZIP 212 note epk = [esk]·g_d
 * with esk derived from rseed (zcash_note_encryption `lib.rs:531-550`; the node:
 * `ycash-dd/src/zcash/Note.cpp:241`, `plaintext_checks_without_height`).
 *
 * @param output - cmu, ephemeralKey and encCiphertext of the output description.
 * @param ivk - The incoming viewing key, a Jubjub scalar (from `decodeSaplingViewingKey`).
 * @param network - The network whose HRP the returned address carries.
 * @returns The note, or undefined when the output is not to this key or fails a check.
 */
export function trialDecryptOutput(output: EncryptedOutput, ivk: bigint, network: YcashNetwork): DecryptedNote | undefined {
  const shared = saplingKaAgree(ivk, output.ephemeralKey);
  if (!shared) return undefined;
  const plaintext = decryptNoteCiphertext(kdfSapling(shared, output.ephemeralKey), output.encCiphertext);
  if (!plaintext) return undefined;
  const note = parseNotePlaintext(plaintext);
  if (!note) return undefined;
  let gd;
  try {
    gd = jubjub_groupHash(note.diversifier, DIVERSIFY_PERSONALIZATION);
  } catch {
    return undefined; // the diversifier has no g_d
  }
  const pkd = gd.multiply(ivk);
  if (pkd.is0()) return undefined;
  const rcm = noteRcm(note);
  if (rcm === undefined) return undefined;
  const cmu = extractU(noteCommitment(gd.toBytes(), pkd.toBytes(), note.value, rcm));
  if (!bytesEqual(cmu, output.cmu)) return undefined;
  if (note.leadByte === LEAD_BYTE_ZIP212) {
    const esk = prfExpandToScalar(note.rseed, PRF_SAPLING_ESK);
    if (esk === 0n || !bytesEqual(gd.multiply(esk).toBytes(), output.ephemeralKey)) return undefined;
  }
  const pkdBytes = pkd.toBytes();
  return {
    leadByte: note.leadByte,
    diversifier: note.diversifier,
    value: note.value,
    rseed: note.rseed,
    memo: note.memo,
    pkd: pkdBytes,
    address: bech32Encode(SAPLING_HRP[network], new Uint8Array([...note.diversifier, ...pkdBytes])),
  };
}

/**
 * The memo's UTF-8 text with trailing zero bytes removed, the form `extra.memo` is compared with
 * (spec "sapling-proof", settlement step 5, which `sapling` rule 7 reuses).
 *
 * @param memo - The 512-byte memo field.
 * @returns The memo bytes up to the last non-zero byte.
 */
export function memoBytes(memo: Uint8Array): Uint8Array {
  let end = memo.length;
  while (end > 0 && memo[end - 1] === 0) end--;
  return memo.subarray(0, end);
}
