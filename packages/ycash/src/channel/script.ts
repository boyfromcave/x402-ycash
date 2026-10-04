// The channel redeem script (specs/scheme_batch_settlement_ycash.md, "Redeem script"):
//
//   OP_IF   OP_2 <C> <S> OP_2 OP_CHECKMULTISIG
//   OP_ELSE <t> OP_CHECKLOCKTIMEVERIFY OP_DROP <C> OP_CHECKSIG
//   OP_ENDIF
//
// 3 sigops, standard under the 15-sigop P2SH limit (ycash-dd/src/policy/policy.cpp:174-179, ycash6
// :204-209). CLTV is enforced on both lines (ycash-dd/src/script/interpreter.cpp:346; ycash6 :349).
import * as secp from "@noble/secp256k1";
import type { YcashNetwork } from "../constants.js";
import { encodeAddress } from "../tx/address.js";
import { bytesToHex, equalBytes } from "../tx/bytes.js";
import { hash160 } from "../tx/hash.js";
import { OP, buildScript, decodeScriptNum, p2shScript, parseScript } from "../tx/script.js";
import { LOCKTIME_THRESHOLD } from "./constants.js";

export interface ChannelScript {
  /** C, the client's compressed public key. */
  clientPubKey: Uint8Array;
  /** S, the server's compressed public key (`extra.serverPubKey`). */
  serverPubKey: Uint8Array;
  /** t, the refund height. */
  refundHeight: number;
}

/**
 * The spec's key form: 33 bytes with prefix 02/03 (uncompressed keys are refused by the binding).
 * The script itself does not need a valid point; a key off the curve simply never verifies.
 */
export function isCompressedPubKey(k: Uint8Array): boolean {
  return k.length === 33 && (k[0] === 0x02 || k[0] === 0x03);
}

/** A compressed key that is also a point on secp256k1 (required of S in the requirements). */
export function isValidCompressedPubKey(k: Uint8Array): boolean {
  return isCompressedPubKey(k) && secp.utils.isValidPublicKey(k, true);
}

function check(p: ChannelScript): void {
  if (!isCompressedPubKey(p.clientPubKey)) throw new Error("client key must be a compressed secp256k1 key");
  if (!isCompressedPubKey(p.serverPubKey)) throw new Error("server key must be a compressed secp256k1 key");
  if (equalBytes(p.clientPubKey, p.serverPubKey)) throw new Error("client and server keys must differ");
  if (!Number.isSafeInteger(p.refundHeight) || p.refundHeight <= 0 || p.refundHeight >= LOCKTIME_THRESHOLD) {
    throw new Error(`refund height must be a block height in (0, ${LOCKTIME_THRESHOLD}): ${p.refundHeight}`);
  }
}

/** The redeem script, byte for byte `63 52 21 <C> 21 <S> 52 ae 67 <push(t)> b1 75 21 <C> ac 68`. */
export function buildChannelScript(p: ChannelScript): Uint8Array {
  check(p);
  return buildScript([
    OP.OP_IF, OP.OP_2, p.clientPubKey, p.serverPubKey, OP.OP_2, OP.OP_CHECKMULTISIG,
    OP.OP_ELSE, BigInt(p.refundHeight), OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP, p.clientPubKey, OP.OP_CHECKSIG,
    OP.OP_ENDIF,
  ]);
}

/**
 * Parses exactly the channel script, or returns null. The parse is checked by rebuilding: any
 * other encoding (a non-minimal t push, extra opcodes, an uncompressed key, C = S) is refused.
 */
export function parseChannelScript(rs: Uint8Array): ChannelScript | null {
  let chunks;
  try {
    chunks = parseScript(rs);
  } catch {
    return null;
  }
  if (chunks.length !== 13) return null;
  const c = chunks[2]?.data;
  const s = chunks[3]?.data;
  const t = chunks[7]?.data;
  if (!c || !s || !t || t.length === 0 || t.length > 5) return null;
  const height = decodeScriptNum(t);
  if (height <= 0n || height >= BigInt(LOCKTIME_THRESHOLD)) return null;
  const parsed: ChannelScript = { clientPubKey: c, serverPubKey: s, refundHeight: Number(height) };
  try {
    return equalBytes(buildChannelScript(parsed), rs) ? parsed : null;
  } catch {
    return null;
  }
}

/** The funding output's scriptPubKey: `a9 14 <HASH160(redeemScript)> 87`. */
export function channelScriptPubKey(rs: Uint8Array): Uint8Array {
  return p2shScript(hash160(rs));
}

/** The channel's P2SH address (`s2…`/`s3…` on mainnet). */
export function channelAddress(network: YcashNetwork, rs: Uint8Array): string {
  return encodeAddress(network, "p2sh", hash160(rs));
}

export function channelScriptHex(p: ChannelScript): string {
  return bytesToHex(buildChannelScript(p));
}
