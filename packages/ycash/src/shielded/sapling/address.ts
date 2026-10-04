// Sapling diversified payment addresses from a full viewing key alone (ZIP-32; plan X4-M (f)):
// d_j = FF1-AES256_dk(j), g_d = DiversifyHash(d_j), pk_d = [ivk]·g_d, address = d_j || repr(pk_d).
// It needs ivk and dk only, both inside the `zxview…` key `z_exportviewingkey` prints, and mirrors
// sapling-crypto 0.7 (`zip32.rs:756-770`, `spec.rs:25-48`, `group_hash.rs`), which
// tools/x4m/rust `divaddr` runs. No spending key and no node are involved.
import { jubjub, jubjub_groupHash } from "@noble/curves/misc.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET, type YcashNetwork } from "../../constants.js";
import { SAPLING_HRP } from "../constants.js";
import { bech32Decode, bech32Encode } from "./bech32.js";
import { ff1Aes256EncryptBits } from "./ff1.js";

/** Extended-full-viewing-key HRPs per network (`chainparams.cpp`, tools/x4m/rust/src/lib.rs). */
export const SAPLING_EXTFVK_HRP: Readonly<Record<YcashNetwork, string>> = {
  [YCASH_MAINNET]: "zxviews",
  [YCASH_TESTNET]: "zxviewtestsapling",
  [YCASH_REGTEST]: "zxviewregtestsapling",
};

/** ZIP-32 diversifier indices are 88 bits. */
export const MAX_DIVERSIFIER_INDEX = (1n << 88n) - 1n;

const EXTFVK_LEN = 169; // depth 1, parent tag 4, child index 4, chain code 32, ak 32, nk 32, ovk 32, dk 32
const utf8 = (s: string) => new TextEncoder().encode(s);
const IVK_PERSONALIZATION = utf8("Zcashivk");
const DIVERSIFY_PERSONALIZATION = utf8("Zcash_gd");

/** The parts of a viewing key address derivation needs. ovk and the chain code are not kept. */
export interface SaplingIncomingKey {
  network: YcashNetwork;
  /** ivk as a scalar, < 2^251 */
  ivk: bigint;
  /** the 32-byte diversifier key */
  dk: Uint8Array;
}

function leNum(bytes: Uint8Array): bigint {
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i] as number);
  return x;
}

/** CRH^ivk(ak, nk): BLAKE2s-256 "Zcashivk", top five bits dropped (`spec.rs:25-41`). */
export function crhIvk(ak: Uint8Array, nk: Uint8Array): bigint {
  const h = blake2s.create({ dkLen: 32, personalization: IVK_PERSONALIZATION }).update(ak).update(nk).digest();
  h[31] = (h[31] as number) & 0x07;
  return leNum(h);
}

/** Decodes a `zxview…` key and checks its HRP is `network`'s: testnet and regtest differ here. */
export function decodeSaplingViewingKey(key: string, network: YcashNetwork): SaplingIncomingKey {
  const { hrp, bytes } = bech32Decode(key);
  if (hrp !== SAPLING_EXTFVK_HRP[network]) throw new Error(`not a ${network} Sapling viewing key (${SAPLING_EXTFVK_HRP[network]}1…): ${hrp}`);
  if (bytes.length !== EXTFVK_LEN) throw new Error(`a Sapling extended full viewing key is ${EXTFVK_LEN} bytes, got ${bytes.length}`);
  const ak = bytes.subarray(41, 73);
  const nk = bytes.subarray(73, 105);
  // ak must be a valid point (sapling-crypto rejects the key otherwise); noble throws on a bad encoding.
  jubjub.Point.fromBytes(ak);
  jubjub.Point.fromBytes(nk);
  const ivk = crhIvk(ak, nk);
  if (ivk === 0n) throw new Error("the viewing key's ivk is zero");
  return { network, ivk, dk: bytes.slice(137, 169) };
}

/** I2LEBSP_88(j). */
function indexBytes(j: bigint): Uint8Array {
  if (j < 0n || j > MAX_DIVERSIFIER_INDEX) throw new RangeError(`diversifier index out of range: ${j}`);
  const out = new Uint8Array(11);
  for (let i = 0; i < 11; i++) out[i] = Number((j >> BigInt(8 * i)) & 0xffn);
  return out;
}

/** d_j = FF1-AES256_dk("", j) (`zip32` DiversifierKey::diversifier). */
export function diversifier(dk: Uint8Array, j: bigint): Uint8Array {
  return ff1Aes256EncryptBits(dk, new Uint8Array(0), indexBytes(j));
}

/** The address at exactly index j, or undefined when d_j has no g_d (about half of all indices). */
export function saplingAddressAt(key: SaplingIncomingKey, j: bigint): string | undefined {
  const d = diversifier(key.dk, j);
  let gd;
  try {
    gd = jubjub_groupHash(d, DIVERSIFY_PERSONALIZATION);
  } catch {
    return undefined; // not on the curve, or small order: an invalid diversifier
  }
  const pkd = gd.multiply(key.ivk);
  if (pkd.is0()) return undefined;
  return bech32Encode(SAPLING_HRP[key.network], new Uint8Array([...d, ...pkd.toBytes()]));
}

/** The first valid address at an index ≥ j, with that index (`find_address`). */
export function findSaplingAddress(key: SaplingIncomingKey, j: bigint): { index: bigint; address: string } {
  for (let i = j; i <= MAX_DIVERSIFIER_INDEX; i++) {
    const address = saplingAddressAt(key, i);
    if (address) return { index: i, address };
  }
  throw new Error("diversifier space exhausted");
}
