// secp256k1 keys, transparent signatures and WIF.
// The node signs with RFC 6979 and no extra entropy (ycash-dd/src/key.cpp:201-214, ycash6 :204-217),
// as @noble/secp256k1 does by default, so a signature made here is byte-identical to
// `signrawtransaction`'s. Relay policy wants strict DER and low S (SCRIPT_VERIFY_DERSIG|LOW_S).
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as secp from "@noble/secp256k1";
import { YCASH_MAINNET, type YcashNetwork } from "../constants.js";
import { base58CheckDecode, base58CheckEncode } from "./base58.js";
import { concatBytes } from "./bytes.js";
import { decodeDer, encodeDer } from "./der.js";
import { SIGHASH } from "./sighash.js";

// The sync API needs these hooks; set once at module load.
secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);

/** The 33-byte compressed public key (or 65-byte uncompressed). */
export function pubkeyFromPriv(privKey: Uint8Array, compressed = true): Uint8Array {
  return secp.getPublicKey(privKey, compressed);
}

/** A fresh random private key. */
export function randomPrivKey(): Uint8Array {
  return secp.utils.randomSecretKey();
}

/**
 * Sign a sighash: low-S strict DER followed by the hash-type byte, ready to push in a scriptSig.
 */
export function signInput(sighash: Uint8Array, privKey: Uint8Array, hashType: number = SIGHASH.ALL): Uint8Array {
  if (sighash.length !== 32) throw new Error("sighash must be 32 bytes");
  const compact = secp.sign(sighash, privKey, { prehash: false, lowS: true });
  return concatBytes(encodeDer(compact), Uint8Array.of(hashType & 0xff));
}

/**
 * Verify a scriptSig signature (DER ‖ hash type) against a sighash, as the node's policy would:
 * strict DER, low S. Returns false rather than throwing on malformed input.
 */
export function verifyInputSig(sig: Uint8Array, sighash: Uint8Array, pubkey: Uint8Array): boolean {
  if (sig.length < 9) return false;
  try {
    return secp.verify(decodeDer(sig.slice(0, -1)), sighash, pubkey, { prehash: false, lowS: true });
  } catch {
    return false;
  }
}

/** The hash-type byte a scriptSig signature ends with. */
export function sigHashType(sig: Uint8Array): number {
  const t = sig[sig.length - 1];
  if (t === undefined) throw new Error("empty signature");
  return t;
}

// SECRET_KEY prefixes: mainnet 0x80, testnet and regtest 0xEF (ycash-dd/src/chainparams.cpp:153,413,615;
// ycash6 :165,460,691).
const WIF_MAINNET = 0x80;
const WIF_TEST = 0xef;

export interface DecodedWif {
  privKey: Uint8Array;
  compressed: boolean;
  /** "ycash:mainnet", or "ycash:testnet" for both testnet and regtest (they share 0xEF). */
  network: YcashNetwork;
}

export function encodeWif(privKey: Uint8Array, network: YcashNetwork, compressed = true): string {
  if (privKey.length !== 32) throw new Error("private key must be 32 bytes");
  const version = network === YCASH_MAINNET ? WIF_MAINNET : WIF_TEST;
  return base58CheckEncode(concatBytes(Uint8Array.of(version), privKey, compressed ? Uint8Array.of(1) : new Uint8Array()));
}

/** Decode a WIF key; with `network`, also require that network's prefix. */
export function decodeWif(wif: string, network?: YcashNetwork): DecodedWif {
  const b = base58CheckDecode(wif);
  const version = b[0];
  if (version !== WIF_MAINNET && version !== WIF_TEST) throw new Error("not a Ycash WIF key");
  let compressed: boolean;
  if (b.length === 34 && b[33] === 1) compressed = true;
  else if (b.length === 33) compressed = false;
  else throw new Error("bad WIF length");
  const decodedNet: YcashNetwork = version === WIF_MAINNET ? YCASH_MAINNET : "ycash:testnet";
  if (network !== undefined && (network === YCASH_MAINNET) !== (version === WIF_MAINNET)) {
    throw new Error(`WIF key is not for ${network}`);
  }
  return { privKey: b.slice(1, 33), compressed, network: network ?? decodedNet };
}
