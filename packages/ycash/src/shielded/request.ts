// The request record, its hash, and the memo that commits to it (spec, "sapling-proof",
// Requirements): extra.memo = "x402:" + hex(SHA-256(JCS(record))).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { YcashNetwork } from "../constants.js";
import type { ZReceived } from "../node/index.js";
import { MEMO_PREFIX, MEMO_REGEX } from "./constants.js";
import { jcsBytes } from "./jcs.js";

/** The request-binding object the spec hashes. The server keeps it as the request record. */
export interface RequestRecord {
  v: 1;
  network: YcashNetwork;
  asset: "YEC";
  /** zatoshis, decimal string */
  amount: string;
  payTo: string;
  /** resource.url */
  resource: string;
  /** Unix seconds */
  expiresAt: number;
  /** 32 random bytes, lowercase hex */
  nonce: string;
}

/**
 * Hashes the request record: lowercase hex SHA-256 of its JCS serialisation.
 *
 * @param record - The request record.
 * @returns The 64-character hex hash.
 */
export function requestHash(record: RequestRecord): string {
  return bytesToHex(sha256(jcsBytes(record)));
}

/**
 * Builds the memo committing to a request hash: `x402:` followed by the hash.
 *
 * @param hash - Lowercase hex request hash.
 * @returns The memo text.
 * @throws When the result does not match the memo format (the hash is not 64 lowercase hex).
 */
export function memoForHash(hash: string): string {
  const memo = MEMO_PREFIX + hash;
  if (!MEMO_REGEX.test(memo)) throw new Error(`not a request hash: ${hash}`);
  return memo;
}

/**
 * Builds the memo committing to a request record.
 *
 * @param record - The request record.
 * @returns The memo text.
 */
export function memoForRecord(record: RequestRecord): string {
  return memoForHash(requestHash(record));
}

/**
 * Encodes a memo as `z_sendmany` takes it on both node lines: hex of its UTF-8 bytes.
 *
 * @param memo - The memo text.
 * @returns Lowercase hex.
 */
export function memoToHex(memo: string): string {
  return bytesToHex(new TextEncoder().encode(memo));
}

/**
 * A received note's memo bytes with trailing zero bytes removed. Both lines return the 512-byte
 * memo as hex in `memo` (`ycash-dd/src/wallet/rpcwallet.cpp:3557`, `ycash6/src/wallet/rpcwallet.cpp:4218-4219`,
 * z_listreceivedbyaddress); 6.21.0 adds `memoStr`, the UTF-8 text when it decodes, used only when
 * `memo` is absent.
 *
 * @param note - A `z_listreceivedbyaddress` entry.
 * @returns The memo bytes, empty when the note carries none.
 */
export function noteMemoBytes(note: Pick<ZReceived, "memo"> & { memoStr?: unknown }): Uint8Array {
  let bytes: Uint8Array;
  if (typeof note.memo === "string" && /^([0-9a-fA-F]{2})*$/.test(note.memo)) bytes = hexToBytes(note.memo.toLowerCase());
  else if (typeof note.memoStr === "string") bytes = new TextEncoder().encode(note.memoStr);
  else return new Uint8Array(0);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

/**
 * Compares a received note's memo, trailing zeros removed, with the UTF-8 bytes of `memo`.
 *
 * @param note - A `z_listreceivedbyaddress` entry.
 * @param memo - The expected memo text.
 * @returns True on an exact byte match.
 */
export function noteMemoEquals(note: Pick<ZReceived, "memo"> & { memoStr?: unknown }, memo: string): boolean {
  const want = new TextEncoder().encode(memo);
  const got = noteMemoBytes(note);
  return got.length === want.length && got.every((b, i) => b === want[i]);
}
