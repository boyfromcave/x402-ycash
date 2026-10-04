// Hash functions of the transparent layer: SHA256d (txid, base58check), HASH160 (key and script
// hashes) and the personalised BLAKE2b-256 of ZIP-243.
import { blake2b } from "@noble/hashes/blake2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Double SHA-256, as used for txids and base58check checksums.
 *
 * @param data - The bytes to hash.
 * @returns The 32-byte digest.
 */
export function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/**
 * RIPEMD160(SHA256(data)): a P2PKH key hash or a P2SH script hash.
 *
 * @param data - A public key or a redeem script.
 * @returns The 20-byte hash.
 */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * BLAKE2b-256 with a 16-byte personalisation, the hash ZIP-243 sighash digests are built from.
 *
 * @param personalization - The 16-byte personalisation, as bytes or an ASCII string.
 * @param data - The bytes to hash.
 * @returns The 32-byte digest.
 * @throws Error when the personalisation is not 16 bytes.
 */
export function blake2b256(personalization: Uint8Array | string, data: Uint8Array): Uint8Array {
  const p = typeof personalization === "string" ? new TextEncoder().encode(personalization) : personalization;
  if (p.length !== 16) throw new Error("BLAKE2b personalisation must be 16 bytes");
  return blake2b(data, { dkLen: 32, personalization: p });
}
