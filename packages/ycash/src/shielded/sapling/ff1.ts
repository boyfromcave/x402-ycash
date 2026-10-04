// FF1 (NIST SP 800-38G) with AES-256 over radix 2, the ZIP-32 Sapling diversifier permutation:
// d_j = FF1-AES256_dk("", I2LEBSP_88(j)). Numerals are the bits of the input bytes in
// little-endian bit order, as `fpe::ff1::BinaryNumeralString::from_bytes_le` reads them
// (fpe 0.6, which sapling-crypto 0.7's zip32.rs uses).
import { createCipheriv } from "node:crypto";

function aesBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-256-ecb", key, null);
  c.setAutoPadding(false);
  return new Uint8Array(c.update(block));
}

/** PRF of SP 800-38G: the last block of AES-CBC with a zero IV. */
function prf(key: Uint8Array, data: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-256-cbc", key, new Uint8Array(16));
  c.setAutoPadding(false);
  const out = c.update(data);
  return new Uint8Array(out.subarray(out.length - 16));
}

function beBytes(x: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function beNum(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

/** NUM_2 of numerals [from, from+len) of a little-endian-bit byte string: numeral `from` is the most significant. */
function numBits(bytes: Uint8Array, from: number, len: number): bigint {
  let x = 0n;
  for (let k = from; k < from + len; k++) x = (x << 1n) | BigInt(((bytes[k >> 3] as number) >> (k & 7)) & 1);
  return x;
}

function writeBits(out: Uint8Array, from: number, len: number, x: bigint): void {
  for (let k = from + len - 1; k >= from; k--) {
    if (x & 1n) out[k >> 3] = (out[k >> 3] as number) | (1 << (k & 7));
    x >>= 1n;
  }
}

/** FF1-AES256 encryption of `input`, read as 8·len radix-2 numerals. */
export function ff1Aes256EncryptBits(key: Uint8Array, tweak: Uint8Array, input: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error("FF1-AES256 needs a 32-byte key");
  const n = input.length * 8;
  if (n < 20) throw new Error("FF1 radix 2 needs at least 20 numerals");
  const t = tweak.length;
  const u = Math.floor(n / 2);
  const v = n - u;
  const b = Math.ceil(v / 8);
  const d = 4 * Math.ceil(b / 4) + 4;
  const p = new Uint8Array([1, 2, 1, 0, 0, 2, 10, u & 0xff, ...beBytes(BigInt(n), 4), ...beBytes(BigInt(t), 4)]);
  const pad = (((-t - b - 1) % 16) + 16) % 16;
  let a = numBits(input, 0, u);
  let bb = numBits(input, u, v);
  for (let i = 0; i < 10; i++) {
    const q = new Uint8Array([...tweak, ...new Uint8Array(pad), i, ...beBytes(bb, b)]);
    const r = prf(key, new Uint8Array([...p, ...q]));
    const s = new Uint8Array(Math.ceil(d / 16) * 16);
    s.set(r);
    for (let j = 1; j * 16 < d; j++) {
      const blk = r.slice();
      const jb = beBytes(BigInt(j), 16);
      for (let k = 0; k < 16; k++) blk[k] = (blk[k] as number) ^ (jb[k] as number);
      s.set(aesBlock(key, blk), j * 16);
    }
    const y = beNum(s.subarray(0, d));
    const m = i % 2 === 0 ? u : v;
    const c = (a + y) % (1n << BigInt(m));
    a = bb;
    bb = c;
  }
  const out = new Uint8Array(input.length);
  writeBits(out, 0, u, a);
  writeBits(out, u, v, bb);
  return out;
}
