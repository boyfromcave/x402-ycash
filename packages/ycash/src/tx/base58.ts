// Base58Check (src/base58.cpp): version bytes ‖ payload ‖ first 4 bytes of SHA256d.
import { concatBytes, equalBytes } from "./bytes.js";
import { sha256d } from "./hash.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encodes bytes in Bitcoin's base58 alphabet, one leading `1` per leading zero byte.
 *
 * @param b - The bytes to encode.
 * @returns The base58 string.
 */
export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

/**
 * Decodes a base58 string, restoring one zero byte per leading `1`.
 *
 * @param s - The base58 string.
 * @returns The decoded bytes.
 * @throws Error on a character outside the base58 alphabet.
 */
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`invalid base58 character '${c}'`);
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

/**
 * Appends the 4-byte SHA256d checksum to a payload and base58-encodes the result.
 *
 * @param payload - Version bytes followed by the data.
 * @returns The base58check string.
 */
export function base58CheckEncode(payload: Uint8Array): string {
  return base58Encode(concatBytes(payload, sha256d(payload).slice(0, 4)));
}

/**
 * Decodes a base58check string and verifies its 4-byte SHA256d checksum.
 *
 * @param s - The base58check string.
 * @returns The payload without the checksum.
 * @throws Error when the string is too short or the checksum does not match.
 */
export function base58CheckDecode(s: string): Uint8Array {
  const b = base58Decode(s);
  if (b.length < 4) throw new Error("base58check too short");
  const payload = b.slice(0, -4);
  if (!equalBytes(b.slice(-4), sha256d(payload).slice(0, 4))) throw new Error("bad base58check checksum");
  return payload;
}
