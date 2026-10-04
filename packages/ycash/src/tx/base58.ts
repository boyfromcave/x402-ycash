// Base58Check (src/base58.cpp): version bytes ‖ payload ‖ first 4 bytes of SHA256d.
import { concatBytes, equalBytes } from "./bytes.js";
import { sha256d } from "./hash.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

export function base58CheckEncode(payload: Uint8Array): string {
  return base58Encode(concatBytes(payload, sha256d(payload).slice(0, 4)));
}

export function base58CheckDecode(s: string): Uint8Array {
  const b = base58Decode(s);
  if (b.length < 4) throw new Error("base58check too short");
  const payload = b.slice(0, -4);
  if (!equalBytes(b.slice(-4), sha256d(payload).slice(0, 4))) throw new Error("bad base58check checksum");
  return payload;
}
