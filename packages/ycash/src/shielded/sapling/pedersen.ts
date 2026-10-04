// The Sapling Pedersen hash and note commitment (Zcash protocol spec §5.4.1.7, §5.4.8.2), as
// sapling-crypto 0.7 computes them (`pedersen_hash.rs:33-120`, `spec.rs:143-165`,
// `note/commitment.rs:36-52`). A facilitator recomputes cmu from a decrypted note plaintext, so the
// plaintext is authenticated against the output description and not only against the AEAD tag.
import { jubjub, jubjub_groupHash } from "@noble/curves/misc.js";

type Point = ReturnType<typeof jubjub.Point.fromBytes>;

const PEDERSEN_PERSONALIZATION = new TextEncoder().encode("Zcash_PH");
/** c = 63 chunks of 3 bits per generator (`constants.rs:234`). */
const CHUNKS_PER_GENERATOR = 63;
/** The six-bit prefix of NoteCommit^Sapling (`pedersen_hash.rs:22`). */
const NOTE_COMMITMENT_PREFIX = [1, 1, 1, 1, 1, 1] as const;

const R = jubjub.Point.CURVE().n;

/**
 * FindGroupHash^J(r*)(D, M): the first i in 0..255 for which GroupHash(D, M || [i]) is a point of
 * the prime-order subgroup (spec §5.4.9.5; `constants.rs:281-294`).
 *
 * @param m - The message.
 * @param personalization - The eight-byte personalization.
 * @returns The point.
 */
export function findGroupHash(m: Uint8Array, personalization: Uint8Array): Point {
  const tag = new Uint8Array(m.length + 1);
  tag.set(m);
  for (let i = 0; i < 256; i++) {
    tag[m.length] = i;
    try {
      return jubjub_groupHash(tag, personalization);
    } catch {
      // not a point, or of small order: try the next index
    }
  }
  throw new Error("findGroupHash: tag overflow");
}

const generators: Point[] = [];
let randomnessBase: Point | undefined;

/**
 * I_i, the i-th Pedersen generator: FindGroupHash("Zcash_PH", I2LEOSP_32(i)) (`constants.rs:352-361`).
 *
 * @param i - The generator index, from 0.
 * @returns The point, computed once.
 */
function generator(i: number): Point {
  while (generators.length <= i) {
    const m = new Uint8Array(4);
    new DataView(m.buffer).setUint32(0, generators.length, true);
    generators.push(findGroupHash(m, PEDERSEN_PERSONALIZATION));
  }
  return generators[i] as Point;
}

/**
 * The note commitment randomness base: FindGroupHash("Zcash_PH", "r") (`constants.rs:312-316`).
 *
 * @returns The point, computed once.
 */
export function noteCommitmentRandomnessBase(): Point {
  randomnessBase ??= findGroupHash(new TextEncoder().encode("r"), PEDERSEN_PERSONALIZATION);
  return randomnessBase;
}

/**
 * PedersenHashToPoint(D, M) over the given bit string, the personalization bits already prepended.
 * Each 3-bit chunk encodes ⟨s⟩ = (1 − 2 s₂)(1 + s₀ + 2 s₁), chunk j of a segment weighs 2^(4j), and
 * segment i scales generator I_i; the sum is the hash (`pedersen_hash.rs:33-80`).
 *
 * @param bits - The message bits, 0 or 1 each.
 * @returns The hash point.
 */
export function pedersenHashToPoint(bits: readonly number[]): Point {
  let result = jubjub.Point.ZERO;
  let pos = 0;
  let segment = 0;
  while (pos < bits.length) {
    let acc = 0n;
    let cur = 1n;
    for (let c = 0; c < CHUNKS_PER_GENERATOR && pos < bits.length; c++, pos += 3) {
      const a = bits[pos] ?? 0;
      const b = bits[pos + 1] ?? 0;
      const neg = bits[pos + 2] ?? 0;
      const chunk = cur * BigInt(1 + a + 2 * b);
      acc += neg ? -chunk : chunk;
      cur <<= 4n;
    }
    const scalar = ((acc % R) + R) % R;
    if (scalar !== 0n) result = result.add(generator(segment).multiply(scalar));
    segment++;
  }
  return result;
}

/**
 * Little-endian bit order over bytes, the order Zcash's I2LEBSP and byte-to-bit conversions use.
 *
 * @param bytes - The bytes.
 * @returns The bits, LSB of byte 0 first.
 */
export function leBits(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (const b of bytes) for (let i = 0; i < 8; i++) out.push((b >> i) & 1);
  return out;
}

/**
 * NoteCommit^Sapling_rcm(g_d, pk_d, v) = WindowedPedersenCommit_rcm([1]⁶ ‖ I2LEBSP_64(v) ‖ repr(g_d) ‖
 * repr(pk_d)) (spec §5.4.8.2; `note/commitment.rs:36-52`).
 *
 * @param gd - The 32-byte encoding of g_d.
 * @param pkd - The 32-byte encoding of pk_d.
 * @param value - The note value in zatoshis.
 * @param rcm - The commitment trapdoor, a Jubjub scalar.
 * @returns The commitment point.
 */
export function noteCommitment(gd: Uint8Array, pkd: Uint8Array, value: bigint, rcm: bigint): Point {
  const v = new Uint8Array(8);
  new DataView(v.buffer).setBigUint64(0, value, true);
  const bits = [...NOTE_COMMITMENT_PREFIX, ...leBits(v), ...leBits(gd), ...leBits(pkd)];
  const h = pedersenHashToPoint(bits);
  const r = ((rcm % R) + R) % R;
  return r === 0n ? h : h.add(noteCommitmentRandomnessBase().multiply(r));
}

/**
 * Extract^J(r)(P): the u-coordinate as 32 little-endian bytes, which is how cmu is written in an
 * output description (`spec.rs:159-165`).
 *
 * @param p - A point of the prime-order subgroup.
 * @returns I2LEOSP_256(u).
 */
export function extractU(p: Point): Uint8Array {
  const u = p.toAffine().x;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((u >> BigInt(8 * i)) & 0xffn);
  return out;
}
