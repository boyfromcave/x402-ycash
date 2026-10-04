// FF1 (NIST SP 800-38G) with AES-256 over radix 2: ZIP-32's Sapling diversifier permutation,
// d_j = FF1-AES256_dk("", I2LEBSP_88(j)). Numerals are the bits of the input bytes in little-endian
// bit order, as `fpe::ff1::BinaryNumeralString::from_bytes_le` reads them (fpe 0.6, which
// sapling-crypto 0.7's zip32.rs uses). Node's AES does the block cipher.
import { createCipheriv } from "node:crypto";

/**
 * One AES-256 block encryption.
 *
 * @param key - The 32-byte key.
 * @param block - 16 bytes.
 * @returns The ciphertext block.
 */
function aesBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-256-ecb", key, null);
  c.setAutoPadding(false);
  return new Uint8Array(c.update(block));
}

/**
 * SP 800-38G's PRF: the last block of AES-CBC with a zero IV.
 *
 * @param key - The 32-byte key.
 * @param data - A whole number of 16-byte blocks.
 * @returns The 16-byte MAC.
 */
function prf(key: Uint8Array, data: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-256-cbc", key, new Uint8Array(16));
  c.setAutoPadding(false);
  const out = c.update(data);
  return new Uint8Array(out.subarray(out.length - 16));
}

/**
 * Big-endian encoding of a non-negative integer.
 *
 * @param x - The value, below 2^(8·len).
 * @param len - The output length in bytes.
 * @returns The bytes.
 */
function beBytes(x: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * Big-endian decoding.
 *
 * @param bytes - The bytes.
 * @returns Their value.
 */
function beNum(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

/**
 * NUM_2 of numerals [from, from + len) of a little-endian-bit byte string; numeral `from` is the most significant.
 *
 * @param bytes - The numeral string's bytes.
 * @param from - The first numeral.
 * @param len - How many numerals.
 * @returns Their value.
 */
function numBits(bytes: Uint8Array, from: number, len: number): bigint {
  let x = 0n;
  for (let k = from; k < from + len; k++) x = (x << 1n) | BigInt(((bytes[k >> 3] as number) >> (k & 7)) & 1);
  return x;
}

/**
 * STR_2: writes `x` as numerals [from, from + len) of a little-endian-bit byte string (the inverse of numBits).
 *
 * @param out - The bytes to write into (bits assumed zero).
 * @param from - The first numeral.
 * @param len - How many numerals.
 * @param x - The value, below 2^len.
 */
function writeBits(out: Uint8Array, from: number, len: number, x: bigint): void {
  for (let k = from + len - 1; k >= from; k--) {
    if (x & 1n) out[k >> 3] = (out[k >> 3] as number) | (1 << (k & 7));
    x >>= 1n;
  }
}

/**
 * FF1-AES256 encryption of `input` read as 8·len radix-2 numerals (SP 800-38G Algorithm 7).
 *
 * @param key - The 32-byte AES key (for ZIP-32, the diversifier key dk).
 * @param tweak - The tweak (empty for ZIP-32).
 * @param input - The plaintext bytes; at least 3 (FF1's radix-2 minimum of 20 numerals).
 * @returns The ciphertext, the same length.
 * @throws {Error} When the key is not 32 bytes or the input is too short.
 */
export function ff1Aes256EncryptBits(key: Uint8Array, tweak: Uint8Array, input: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error("FF1-AES256 needs a 32-byte key");
  const n = input.length * 8;
  if (n < 20) throw new Error("FF1 radix 2 needs at least 20 numerals");
  const t = tweak.length;
  const u = Math.floor(n / 2);
  const v = n - u;
  const b = Math.ceil(v / 8);
  const d = 4 * Math.ceil(b / 4) + 4;
  // P = [1, 2, 1] || [radix = 2]^3 || [10] || [u mod 256] || [n]^4 || [t]^4
  const p = new Uint8Array([1, 2, 1, 0, 0, 2, 10, u & 0xff, ...beBytes(BigInt(n), 4), ...beBytes(BigInt(t), 4)]);
  const pad = (((-t - b - 1) % 16) + 16) % 16;
  let a = numBits(input, 0, u);
  let bb = numBits(input, u, v);
  for (let i = 0; i < 10; i++) {
    const r = prf(key, new Uint8Array([...p, ...tweak, ...new Uint8Array(pad), i, ...beBytes(bb, b)]));
    // S = R || CIPH(R ⊕ [1]) || CIPH(R ⊕ [2]) || …, first d bytes.
    const s = new Uint8Array(Math.ceil(d / 16) * 16);
    s.set(r);
    for (let j = 1; j * 16 < d; j++) {
      const blk = r.slice();
      const jb = beBytes(BigInt(j), 16);
      for (let k = 0; k < 16; k++) blk[k] = (blk[k] as number) ^ (jb[k] as number);
      s.set(aesBlock(key, blk), j * 16);
    }
    const m = i % 2 === 0 ? u : v;
    const c = (a + beNum(s.subarray(0, d))) % (1n << BigInt(m));
    a = bb;
    bb = c;
  }
  const out = new Uint8Array(input.length);
  writeBits(out, 0, u, a);
  writeBits(out, u, v, bb);
  return out;
}
