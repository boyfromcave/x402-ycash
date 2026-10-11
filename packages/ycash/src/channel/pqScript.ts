// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// The hybrid post-quantum channel, TX_PQCHANNEL (quantum spec header, D-Q-19; the node's
// GetScriptForPQChannel / MatchPQChannel, ycash-dd src/script/standard.cpp). A bare output:
//
//   OP_IF   <clientHash:32> OP_1|OP_2 OP_CHECKPQSIG OP_VERIFY <serverKey:33> OP_CHECKSIG
//   OP_ELSE <refundHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <clientHash:32> OP_1|OP_2 OP_CHECKPQSIG
//   OP_ENDIF
//
// bytes `63 20<h> 5n c2 69 21<pk> ac 67 <num> b1 75 20<h> 5n c2 68`, 112–117 bytes. It is not
// P2SH-wrapped: a redeem script holding OP_CHECKPQSIG is non-standard (R-B2). Both client slots are
// byte-identical; the server key is a valid compressed secp256k1 point; refundHeight is a minimal
// positive CScriptNum below 500,000,000 (a height). After the node's Falcon height a YED channel
// must have a scheme-2 client (TOK-PQ); before it, policy refuses a scheme-2 client (A-1).
import * as secp from "@noble/secp256k1";
import { isKnownScheme, type PQKeyId, type PQScheme } from "../pq/scheme.js";
import { equalBytes } from "../tx/bytes.js";
import { OP, buildScript, decodeScriptNum, parseScript } from "../tx/script.js";
import { LOCKTIME_THRESHOLD } from "./constants.js";

export interface PQChannelScript {
  /** The client's post-quantum key, by scheme and key hash. */
  client: PQKeyId;
  /** S, the server's compressed secp256k1 key (`extra.serverPubKey`). */
  serverPubKey: Uint8Array;
  /** t, the refund height. */
  refundHeight: number;
}

/** The smallest and largest TX_PQCHANNEL (111 bytes + a 1–6-byte refund-height push). */
export const PQ_CHANNEL_SCRIPT_MIN = 112;
export const PQ_CHANNEL_SCRIPT_MAX = 117;

/**
 * Enforces the template's field rules.
 *
 * @param p - The script parameters.
 * @throws Error naming the first rule broken.
 */
function check(p: PQChannelScript): void {
  if (!isKnownScheme(p.client.scheme)) throw new Error(`unknown post-quantum scheme ${p.client.scheme}`);
  if (p.client.hash.length !== 32) throw new Error("the client key hash must be 32 bytes");
  const s = p.serverPubKey;
  if (s.length !== 33 || (s[0] !== 0x02 && s[0] !== 0x03) || !secp.utils.isValidPublicKey(s, true)) throw new Error("server key must be a valid compressed secp256k1 key");
  if (!Number.isSafeInteger(p.refundHeight) || p.refundHeight <= 0 || p.refundHeight >= LOCKTIME_THRESHOLD) {
    throw new Error(`refund height must be a block height in (0, ${LOCKTIME_THRESHOLD}): ${p.refundHeight}`);
  }
}

/**
 * The channel's scriptPubKey, byte for byte the node's GetScriptForPQChannel.
 *
 * @param p - The client key, S and t.
 * @returns The serialized script (it is also the funding output's scriptPubKey).
 * @throws Error when the parameters break the template's rules.
 */
export function buildPQChannelScript(p: PQChannelScript): Uint8Array {
  check(p);
  const schemeOp = OP.OP_1 + p.client.scheme - 1;
  return buildScript([
    OP.OP_IF, p.client.hash, schemeOp, OP.OP_CHECKPQSIG, OP.OP_VERIFY, p.serverPubKey, OP.OP_CHECKSIG,
    OP.OP_ELSE, BigInt(p.refundHeight), OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP, p.client.hash, schemeOp, OP.OP_CHECKPQSIG,
    OP.OP_ENDIF,
  ]);
}

/**
 * Parses exactly a TX_PQCHANNEL, or returns null: the node's MatchPQChannel (decode the fields by
 * token, then require the rebuilt script byte for byte, so non-minimal pushes, differing client
 * slots, an invalid server key or a time-based refund are all refused).
 *
 * @param spk - A candidate scriptPubKey.
 * @returns The client key, S and t, or null.
 */
export function parsePQChannelScript(spk: Uint8Array): PQChannelScript | null {
  if (spk.length < PQ_CHANNEL_SCRIPT_MIN || spk.length > PQ_CHANNEL_SCRIPT_MAX || spk[0] !== OP.OP_IF || spk[spk.length - 1] !== OP.OP_ENDIF) return null;
  let chunks;
  try {
    chunks = parseScript(spk);
  } catch {
    return null;
  }
  if (chunks.length !== 15) return null;
  const hash = chunks[1]?.data;
  const server = chunks[5]?.data;
  const schemeOp = chunks[2];
  const tc = chunks[8];
  if (!hash || hash.length !== 32 || !server || server.length !== 33 || !schemeOp || !tc) return null;
  if (schemeOp.data !== undefined || (schemeOp.op !== OP.OP_1 && schemeOp.op !== OP.OP_2)) return null;
  let height: bigint;
  if (tc.data === undefined && tc.op >= OP.OP_1 && tc.op <= OP.OP_16) height = BigInt(tc.op - OP.OP_1 + 1);
  else if (tc.data && tc.data.length > 0 && tc.data.length <= 5) height = decodeScriptNum(tc.data);
  else return null;
  if (height <= 0n || height >= BigInt(LOCKTIME_THRESHOLD)) return null;
  const parsed: PQChannelScript = {
    client: { scheme: (schemeOp.op - OP.OP_1 + 1) as PQScheme, hash },
    serverPubKey: server,
    refundHeight: Number(height),
  };
  try {
    return equalBytes(buildPQChannelScript(parsed), spk) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a script is a TX_PQCHANNEL.
 *
 * @param spk - A scriptPubKey.
 * @returns True when {@link parsePQChannelScript} accepts it.
 */
export function isPQChannelScript(spk: Uint8Array): boolean {
  return parsePQChannelScript(spk) !== null;
}
