// Sapling diversified payment addresses from a full viewing key alone (ZIP-32):
// d_j = FF1-AES256_dk(j), g_d = DiversifyHash(d_j), pk_d = [ivk]·g_d, address = d_j || repr(pk_d).
// It needs ivk and dk only, both inside the `zxview…` key `z_exportviewingkey` prints, and mirrors
// sapling-crypto 0.7 (`zip32.rs:756-770`, `spec.rs:25-48`, `group_hash.rs`). No spending key and no
// node are involved.
import { jubjub, jubjub_groupHash } from "@noble/curves/misc.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET, type YcashNetwork } from "../../constants.js";
import { SAPLING_HRP } from "../constants.js";
import { bech32Decode, bech32Encode } from "./bech32.js";
import { ff1Aes256EncryptBits } from "./ff1.js";

/** Extended-full-viewing-key HRPs per network (`chainparams.cpp`: `SAPLING_EXTENDED_FVK`). */
export const SAPLING_EXTFVK_HRP: Readonly<Record<YcashNetwork, string>> = {
  [YCASH_MAINNET]: "zxviews",
  [YCASH_TESTNET]: "zxviewtestsapling",
  [YCASH_REGTEST]: "zxviewregtestsapling",
};

/** ZIP-32 diversifier indices are 88 bits. */
export const MAX_DIVERSIFIER_INDEX = (1n << 88n) - 1n;

// depth 1, parent tag 4, child index 4, chain code 32, then ak 32, nk 32, ovk 32, dk 32
const EXTFVK_LEN = 169;
const AK = 41;
const NK = 73;
const DK = 137;
const IVK_PERSONALIZATION = new TextEncoder().encode("Zcashivk");
const DIVERSIFY_PERSONALIZATION = new TextEncoder().encode("Zcash_gd");

/** The parts of a viewing key that address derivation needs; ovk and the chain code are not kept. */
export interface SaplingIncomingKey {
  network: YcashNetwork;
  /** ivk as a scalar, below 2^251 */
  ivk: bigint;
  /** the 32-byte diversifier key */
  dk: Uint8Array;
}

/**
 * Little-endian decoding.
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
 * CRH^ivk(ak, nk): BLAKE2s-256 personalised "Zcashivk", with the top five bits dropped so the
 * result is a Jubjub scalar (`spec.rs:25-41`).
 *
 * @param ak - The spend validating key's encoding, 32 bytes.
 * @param nk - The nullifier deriving key's encoding, 32 bytes.
 * @returns ivk.
 */
export function crhIvk(ak: Uint8Array, nk: Uint8Array): bigint {
  const h = blake2s.create({ dkLen: 32, personalization: IVK_PERSONALIZATION }).update(ak).update(nk).digest();
  h[31] = (h[31] as number) & 0x07;
  return leNum(h);
}

/**
 * Decodes a `zxview…` key and keeps its incoming half. The HRP must be the network's: testnet and
 * regtest keys differ here, though their transparent addresses do not.
 *
 * @param key - The extended full viewing key, as `z_exportviewingkey` prints it.
 * @param network - The network the key must belong to.
 * @returns ivk and dk.
 * @throws {Error} On a bad encoding, another network's HRP, a wrong length or invalid ak/nk points.
 */
export function decodeSaplingViewingKey(key: string, network: YcashNetwork): SaplingIncomingKey {
  const { hrp, bytes } = bech32Decode(key);
  if (hrp !== SAPLING_EXTFVK_HRP[network]) throw new Error(`not a ${network} Sapling viewing key (${SAPLING_EXTFVK_HRP[network]}1…): ${hrp}`);
  if (bytes.length !== EXTFVK_LEN) throw new Error(`a Sapling extended full viewing key is ${EXTFVK_LEN} bytes, got ${bytes.length}`);
  const ak = bytes.subarray(AK, AK + 32);
  const nk = bytes.subarray(NK, NK + 32);
  // sapling-crypto refuses a key whose ak or nk is not a point; noble throws on a bad encoding.
  jubjub.Point.fromBytes(ak);
  jubjub.Point.fromBytes(nk);
  const ivk = crhIvk(ak, nk);
  if (ivk === 0n) throw new Error("the viewing key's ivk is zero");
  return { network, ivk, dk: bytes.slice(DK, DK + 32) };
}

/**
 * I2LEBSP_88(j).
 *
 * @param j - The diversifier index.
 * @returns 11 little-endian bytes.
 * @throws {RangeError} Outside [0, 2^88).
 */
function indexBytes(j: bigint): Uint8Array {
  if (j < 0n || j > MAX_DIVERSIFIER_INDEX) throw new RangeError(`diversifier index out of range: ${j}`);
  const out = new Uint8Array(11);
  for (let i = 0; i < 11; i++) out[i] = Number((j >> BigInt(8 * i)) & 0xffn);
  return out;
}

/**
 * The diversifier at index j (`zip32` DiversifierKey::diversifier).
 *
 * @param dk - The 32-byte diversifier key.
 * @param j - The diversifier index.
 * @returns d_j, 11 bytes.
 */
export function diversifier(dk: Uint8Array, j: bigint): Uint8Array {
  return ff1Aes256EncryptBits(dk, new Uint8Array(0), indexBytes(j));
}

/**
 * The payment address at exactly index j.
 *
 * @param key - ivk and dk.
 * @param j - The diversifier index.
 * @returns The bech32 address, or undefined when d_j has no g_d (about half of all indices).
 */
export function saplingAddressAt(key: SaplingIncomingKey, j: bigint): string | undefined {
  const d = diversifier(key.dk, j);
  let gd;
  try {
    gd = jubjub_groupHash(d, DIVERSIFY_PERSONALIZATION);
  } catch {
    return undefined; // not a curve point, or of small order: an invalid diversifier
  }
  const pkd = gd.multiply(key.ivk);
  if (pkd.is0()) return undefined;
  return bech32Encode(SAPLING_HRP[key.network], new Uint8Array([...d, ...pkd.toBytes()]));
}

/**
 * The first valid address at an index ≥ j, with that index (sapling-crypto `find_address`).
 *
 * @param key - ivk and dk.
 * @param j - Where to start.
 * @returns The index used and the address.
 * @throws {Error} When no valid index is left below 2^88.
 */
export function findSaplingAddress(key: SaplingIncomingKey, j: bigint): { index: bigint; address: string } {
  for (let i = j; i <= MAX_DIVERSIFIER_INDEX; i++) {
    const address = saplingAddressAt(key, i);
    if (address) return { index: i, address };
  }
  throw new Error("diversifier space exhausted");
}
