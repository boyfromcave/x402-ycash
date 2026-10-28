// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// The post-quantum signature schemes of the vault upgrade's quantum line (quantum spec §0; the
// node's registry is ycash-dd src/crypto/pq/scheme.h). A key is named on chain by its key hash,
// SHA256(scheme ‖ pk), never by the key itself.
import { sha256 } from "@noble/hashes/sha2.js";

/** SLH-DSA-SHA2-128s (FIPS 205, pure, empty context), active with the vault upgrade. */
export const SCHEME_SLH_DSA_SHA2_128S = 0x01;
/** FN-DSA-512 in PQClean's padded format (`falcon-padded-512`), gated by the node's Falcon height. */
export const SCHEME_FN_DSA_512 = 0x02;

export type PQScheme = typeof SCHEME_SLH_DSA_SHA2_128S | typeof SCHEME_FN_DSA_512;

export const KEYHASH_SIZE = 32;
/** Every chunk but the last is exactly this long (== MAX_SCRIPT_ELEMENT_SIZE). */
export const MAX_CHUNK = 520;
/** Key generation takes a 48-byte seed for both schemes (SLH: SK.seed ‖ SK.prf ‖ PK.seed; Falcon: PQClean's DRBG seed, C-8). */
export const SEED_SIZE = 48;

const PUBKEY_SIZE: Readonly<Record<PQScheme, number>> = { [SCHEME_SLH_DSA_SHA2_128S]: 32, [SCHEME_FN_DSA_512]: 897 };
/** Signature sizes without the trailing hash-type byte. */
const SIG_SIZE: Readonly<Record<PQScheme, number>> = { [SCHEME_SLH_DSA_SHA2_128S]: 7856, [SCHEME_FN_DSA_512]: 666 };

/** A post-quantum key as the chain names it: the scheme and SHA256(scheme ‖ pk) (the node's CPQKeyID). */
export interface PQKeyId {
  scheme: PQScheme;
  hash: Uint8Array;
}

/**
 * Whether `s` is a registered scheme (activation is the node's concern, not this registry's).
 *
 * @param s - A scheme byte.
 * @returns True for 0x01 and 0x02.
 */
export function isKnownScheme(s: number): s is PQScheme {
  return s === SCHEME_SLH_DSA_SHA2_128S || s === SCHEME_FN_DSA_512;
}

/**
 * The public-key size of a scheme.
 *
 * @param s - A scheme byte.
 * @returns 32 or 897; 0 for an unknown scheme.
 */
export function pubKeySize(s: number): number {
  return isKnownScheme(s) ? PUBKEY_SIZE[s] : 0;
}

/**
 * The signature size of a scheme, without the hash-type byte.
 *
 * @param s - A scheme byte.
 * @returns 7856 or 666; 0 for an unknown scheme.
 */
export function sigSize(s: number): number {
  return isKnownScheme(s) ? SIG_SIZE[s] : 0;
}

/**
 * The scheme whose public key has this length.
 *
 * @param len - A public-key length.
 * @returns The scheme, or undefined.
 */
export function schemeOfPubKeyLength(len: number): PQScheme | undefined {
  if (len === PUBKEY_SIZE[SCHEME_SLH_DSA_SHA2_128S]) return SCHEME_SLH_DSA_SHA2_128S;
  if (len === PUBKEY_SIZE[SCHEME_FN_DSA_512]) return SCHEME_FN_DSA_512;
  return undefined;
}

/**
 * The key hash: SHA256(scheme ‖ pk) (the node's pq::KeyHash).
 *
 * @param scheme - The scheme.
 * @param pk - The public key.
 * @returns The 32-byte key hash.
 * @throws Error when the key has the wrong length for the scheme.
 */
export function keyHash(scheme: PQScheme, pk: Uint8Array): Uint8Array {
  if (pk.length !== pubKeySize(scheme)) throw new Error(`a scheme ${scheme} public key is ${pubKeySize(scheme)} bytes, not ${pk.length}`);
  const b = new Uint8Array(1 + pk.length);
  b[0] = scheme;
  b.set(pk, 1);
  return sha256(b);
}

/**
 * The key id of a public key.
 *
 * @param scheme - The scheme.
 * @param pk - The public key.
 * @returns Its PQKeyId.
 */
export function keyIdOf(scheme: PQScheme, pk: Uint8Array): PQKeyId {
  return { scheme, hash: keyHash(scheme, pk) };
}
