// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// Post-quantum script pieces (quantum spec §2, plan §4.2):
// - TX_PQPKH, 35 bytes: `20 <keyHash:32> 51|52 c2` (<hash> OP_1|OP_2 OP_CHECKPQSIG; F-1).
// - the chunked spend: `<sig_1>…<sig_s> <s> <pk_1>…<pk_p> <p>`, the hash type on the signature's
//   last byte; every chunk but the last is exactly 520 bytes; s and p are OP_1..OP_16. SLH-DSA:
//   s = 16 (15 × 520 + 57), p = 1 (32). Falcon: s = 2 (520 + 147), p = 2 (520 + 377).
import { equalBytes } from "../tx/bytes.js";
import { OP, buildScript, type ScriptChunk, type ScriptItem } from "../tx/script.js";
import { MAX_CHUNK, isKnownScheme, keyHash, pubKeySize, schemeOfPubKeyLength, sigSize, type PQKeyId, type PQScheme } from "./scheme.js";

/** The size of a TX_PQPKH scriptPubKey. */
export const PQPKH_SCRIPT_SIZE = 35;

/**
 * Splits bytes into MAX_CHUNK-sized pieces, the last one shorter.
 *
 * @param data - The bytes to split.
 * @returns The chunks, in order.
 */
export function chunk(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += MAX_CHUNK) out.push(data.slice(i, i + MAX_CHUNK));
  return out;
}

/**
 * The chunked spend's items, ready for buildScript: the signature chunks, s, the key chunks, p.
 *
 * @param pk - The public key.
 * @param sigWithHashType - The signature followed by its hash-type byte.
 * @returns The scriptSig items.
 */
export function pqSpendItems(pk: Uint8Array, sigWithHashType: Uint8Array): ScriptItem[] {
  const sigs = chunk(sigWithHashType);
  const pks = chunk(pk);
  return [...sigs, BigInt(sigs.length), ...pks, BigInt(pks.length)];
}

/**
 * The size of a scheme's chunked spend (the pushes alone), as the node's PQSpendInputSize counts it.
 *
 * @param scheme - The scheme.
 * @returns The bytes the pushes take in a scriptSig.
 */
export function pqSpendSize(scheme: PQScheme): number {
  return buildScript(pqSpendItems(new Uint8Array(pubKeySize(scheme)), new Uint8Array(sigSize(scheme) + 1))).length;
}

/**
 * The TX_PQPKH scriptPubKey.
 *
 * @param id - The key id.
 * @returns `20 <hash> 51|52 c2`.
 * @throws Error for an unknown scheme or a hash that is not 32 bytes.
 */
export function pqpkhScript(id: PQKeyId): Uint8Array {
  if (!isKnownScheme(id.scheme)) throw new Error(`unknown post-quantum scheme ${id.scheme}`);
  if (id.hash.length !== 32) throw new Error("a post-quantum key hash is 32 bytes");
  return buildScript([id.hash, OP.OP_1 + id.scheme - 1, OP.OP_CHECKPQSIG]);
}

/**
 * The key id of an exact TX_PQPKH (the node's Solver match: 35 bytes, a 32-byte push, OP_1|OP_2, OP_CHECKPQSIG).
 *
 * @param spk - A scriptPubKey.
 * @returns The key id, or null when `spk` is not TX_PQPKH.
 */
export function pqpkhKeyId(spk: Uint8Array): PQKeyId | null {
  if (spk.length !== PQPKH_SCRIPT_SIZE || spk[0] !== 0x20 || spk[34] !== OP.OP_CHECKPQSIG) return null;
  const s = spk[33];
  if (s !== OP.OP_1 && s !== OP.OP_2) return null;
  return { scheme: (s - OP.OP_1 + 1) as PQScheme, hash: spk.slice(1, 33) };
}

/** A parsed chunked spend. */
export interface PQSpend {
  scheme: PQScheme;
  pk: Uint8Array;
  /** The signature followed by its hash-type byte. */
  sig: Uint8Array;
}

/**
 * Reads OP_1..OP_16 as a number.
 *
 * @param c - A chunk.
 * @returns n, or undefined when `c` is not a small-integer opcode.
 */
function smallInt(c: ScriptChunk | undefined): number | undefined {
  if (!c || c.data !== undefined || c.op < OP.OP_1 || c.op > OP.OP_16) return undefined;
  return c.op - OP.OP_1 + 1;
}

/**
 * Joins chunk pushes, requiring every chunk but the last to be exactly MAX_CHUNK and the last 1..MAX_CHUNK.
 *
 * @param cs - The pushes.
 * @returns The joined bytes, or null when the chunking is not canonical.
 */
function joinChunks(cs: readonly ScriptChunk[]): Uint8Array | null {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < cs.length; i++) {
    const d = cs[i]?.data;
    if (!d || d.length === 0 || d.length > MAX_CHUNK) return null;
    if (i < cs.length - 1 && d.length !== MAX_CHUNK) return null;
    parts.push(d);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Parses exactly the chunked spend `<sig_1>…<sig_s> <s> <pk_1>…<pk_p> <p>` out of a run of chunks
 * (nothing before or after). The scheme is the one whose key and signature sizes match; push
 * minimality is the caller's (it compares a canonical rebuild).
 *
 * @param cs - The chunks.
 * @returns The spend, or null when the chunks are not one.
 */
export function parsePQSpend(cs: readonly ScriptChunk[]): PQSpend | null {
  const p = smallInt(cs[cs.length - 1]);
  if (p === undefined || cs.length < p + 3) return null;
  const pkChunks = cs.slice(cs.length - 1 - p, cs.length - 1);
  const s = smallInt(cs[cs.length - 2 - p]);
  if (s === undefined || cs.length !== s + p + 2) return null;
  const pk = joinChunks(pkChunks);
  const sig = joinChunks(cs.slice(0, s));
  if (!pk || !sig) return null;
  const scheme = schemeOfPubKeyLength(pk.length);
  if (scheme === undefined || sig.length !== sigSize(scheme) + 1) return null;
  if (s !== chunk(sig).length || p !== chunk(pk).length) return null;
  return { scheme, pk, sig };
}

/**
 * Whether a parsed spend is by the key `id` names (SHA256(scheme ‖ pk) = hash).
 *
 * @param spend - The parsed spend.
 * @param id - The key id it must match.
 * @returns True when scheme and key hash agree.
 */
export function spendMatches(spend: PQSpend, id: PQKeyId): boolean {
  return spend.scheme === id.scheme && equalBytes(keyHash(spend.scheme, spend.pk), id.hash);
}

/** A P2PKH scriptSig at its largest: push(72-byte DER + hash type) + push(33-byte compressed key). */
const MAX_P2PKH_SCRIPTSIG = 1 + 73 + 1 + 33;

/**
 * The largest scriptSig that spends `spk`, for sizing a draft before it is signed: the chunked
 * spend of a TX_PQPKH (7,938 bytes SLH-DSA, 1,577 Falcon), else a P2PKH spend.
 *
 * @param spk - The coin's scriptPubKey.
 * @returns The scriptSig size to reserve.
 */
export function maxScriptSigSizeOf(spk: Uint8Array): number {
  const id = pqpkhKeyId(spk);
  return id ? pqSpendSize(id.scheme) : MAX_P2PKH_SCRIPTSIG;
}

/** The default minimum relay fee, zatoshis per 1,000 bytes (both lines; plan X-F15). */
const MIN_RELAY_FEE_PER_KB = 100;

/**
 * The dust threshold of a TX_PQPKH output at the default relay fee, as the node's
 * GetPQDustThreshold computes it: 3 × the relay fee of the output plus the input that spends it
 * (outpoint, sequence, the scriptSig's compact size and the chunked spend). SLH-DSA 2,406, Falcon 498.
 *
 * @param scheme - The output's scheme.
 * @returns The least non-dust value, zatoshis.
 */
export function pqDustThreshold(scheme: PQScheme): bigint {
  const ss = pqSpendSize(scheme);
  const input = 40 + (ss > 252 ? 3 : 1) + ss;
  const output = 8 + 1 + PQPKH_SCRIPT_SIZE;
  return BigInt(3 * Math.floor((MIN_RELAY_FEE_PER_KB * (input + output)) / 1000));
}
