// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// Post-quantum keys and signatures, on @noble/post-quantum 0.7.1 (pinned exactly):
// - SLH-DSA-SHA2-128s: FIPS 205 final (not round-3 SPHINCS+), the *pure* interface with an empty
//   context, deterministic (opt_rand = PK.seed), as the node signs (ycash-dd src/crypto/pq/sign.h).
// - FN-DSA-512: noble's `falcon512padded`, which matches PQClean `falcon-padded-512` byte for byte
//   (keygen from the 48-byte seed, signatures from the 88-byte nonce ‖ sampler-seed entropy, verify):
//   proven against the node's pq_vectors.json (test/unit/pq.vectors.test.ts).
// The message is the 32-byte ZIP-243 sighash in memory order, the bytes an ECDSA input signs.
import { falcon512padded } from "@noble/post-quantum/falcon.js";
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa.js";
import { SCHEME_FN_DSA_512, SCHEME_SLH_DSA_SHA2_128S, SEED_SIZE, pubKeySize, sigSize, type PQScheme } from "./scheme.js";

/** Falcon signing entropy: a 40-byte nonce then a 48-byte sampler seed (PQClean's randombytes order). */
export const FALCON_SIGN_ENTROPY_SIZE = 88;

export interface PQKeyPair {
  scheme: PQScheme;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Key generation from a 48-byte seed (SLH-DSA: SK.seed ‖ SK.prf ‖ PK.seed; Falcon: PQClean's DRBG seed).
 *
 * @param scheme - The scheme.
 * @param seed - 48 bytes of secret seed.
 * @returns The key pair.
 * @throws Error when the seed is not 48 bytes.
 */
export function pqKeygen(scheme: PQScheme, seed: Uint8Array): PQKeyPair {
  if (seed.length !== SEED_SIZE) throw new Error(`a post-quantum seed is ${SEED_SIZE} bytes`);
  const kp = scheme === SCHEME_SLH_DSA_SHA2_128S ? slh_dsa_sha2_128s.keygen(seed) : falcon512padded.keygen(seed);
  return { scheme, publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * Signs a 32-byte message. SLH-DSA is deterministic. Falcon takes `entropy` (88 bytes, for
 * reproducible vectors) or draws it from the platform CSPRNG.
 *
 * @param scheme - The scheme.
 * @param secretKey - The secret key from {@link pqKeygen}.
 * @param msg - The 32-byte sighash.
 * @param entropy - Falcon only: the 88-byte nonce ‖ sampler seed.
 * @returns The signature, without a hash-type byte.
 * @throws Error when the message is not 32 bytes or `entropy` has the wrong length.
 */
export function pqSign(scheme: PQScheme, secretKey: Uint8Array, msg: Uint8Array, entropy?: Uint8Array): Uint8Array {
  if (msg.length !== 32) throw new Error("the signed message is a 32-byte sighash");
  if (scheme === SCHEME_SLH_DSA_SHA2_128S) return slh_dsa_sha2_128s.sign(msg, secretKey, { extraEntropy: false });
  if (entropy === undefined) return falcon512padded.sign(msg, secretKey);
  if (entropy.length !== FALCON_SIGN_ENTROPY_SIZE) throw new Error(`Falcon entropy is ${FALCON_SIGN_ENTROPY_SIZE} bytes`);
  let off = 0;
  // noble's Falcon signer reads its randomness through `opts.random` (40 nonce bytes, then the
  // 48-byte sampler seed: PQClean's order); the option is implemented but not in the exported type.
  const opts = {
    random: (n = 0): Uint8Array => {
      const out = entropy.slice(off, off + n);
      off += n;
      if (out.length !== n) throw new Error("Falcon entropy exhausted");
      return out;
    },
  };
  return falcon512padded.sign(msg, secretKey, opts as unknown as Parameters<typeof falcon512padded.sign>[2]);
}

/**
 * Verifies a signature (without its hash-type byte) as the node's pq::Verify does.
 *
 * @param scheme - The scheme.
 * @param publicKey - The public key.
 * @param sig - The signature.
 * @param msg - The 32-byte sighash.
 * @returns True when valid; false (never a throw) on any malformed input.
 */
export function pqVerify(scheme: number, publicKey: Uint8Array, sig: Uint8Array, msg: Uint8Array): boolean {
  if (msg.length !== 32 || publicKey.length !== pubKeySize(scheme) || sig.length !== sigSize(scheme)) return false;
  try {
    if (scheme === SCHEME_SLH_DSA_SHA2_128S) return slh_dsa_sha2_128s.verify(sig, msg, publicKey);
    if (scheme === SCHEME_FN_DSA_512) return falcon512padded.verify(sig, msg, publicKey);
  } catch {
    return false;
  }
  return false;
}
