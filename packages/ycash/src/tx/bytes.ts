// Byte helpers: hex, concatenation, and the Bitcoin wire primitives (little-endian integers,
// CompactSize) the v4 transaction format is built from.

/**
 * Parses an even-length hex string (either case) into bytes.
 *
 * @param hex - The hex string, without a `0x` prefix.
 * @returns The decoded bytes.
 * @throws Error on odd length or a non-hex character.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * Lower-case hex of the bytes in their stored order.
 *
 * @param b - The bytes to encode.
 * @returns The hex string.
 */
export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Concatenates byte arrays into one new array.
 *
 * @param parts - The arrays, in order.
 * @returns A fresh array holding all of them.
 */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Byte-wise equality of two arrays.
 *
 * @param a - The first array.
 * @param b - The second array.
 * @returns True if both have the same length and contents.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Hex of a hash in display order (txid, block hash), which is the internal byte order reversed.
 *
 * @param b - The hash in internal byte order.
 * @returns The display-order hex string.
 */
export function reversedHex(b: Uint8Array): string {
  return bytesToHex(Uint8Array.from(b).reverse());
}

/**
 * Parses a display-order hash hex string back to internal byte order.
 *
 * @param hex - The display-order hex string.
 * @param len - The required length in bytes.
 * @returns The bytes in internal order.
 * @throws Error when the decoded length is not `len`.
 */
export function fromReversedHex(hex: string, len = 32): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
  return b.reverse();
}

/**
 * Size in bytes of the CompactSize prefix that encodes `n`.
 *
 * @param n - The value to encode.
 * @returns 1, 3, 5 or 9.
 */
export function compactSizeLen(n: number): number {
  return n < 253 ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
}

/**
 * Accumulates Bitcoin wire-format fields (little-endian integers, CompactSize) into one buffer.
 */
export class ByteWriter {
  private chunks: Uint8Array[] = [];

  /**
   * Appends raw bytes.
   *
   * @param b - The bytes to append.
   * @returns This writer, for chaining.
   */
  bytes(b: Uint8Array): this {
    this.chunks.push(b);
    return this;
  }

  /**
   * Appends the low 8 bits of `n`.
   *
   * @param n - The value.
   * @returns This writer, for chaining.
   */
  u8(n: number): this {
    return this.bytes(Uint8Array.of(n & 0xff));
  }

  /**
   * Appends a 32-bit little-endian unsigned integer.
   *
   * @param n - The value, taken modulo 2^32.
   * @returns This writer, for chaining.
   */
  u32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return this.bytes(b);
  }

  /**
   * Appends a 64-bit little-endian integer; negative values are written as two's complement (int64).
   *
   * @param n - The value.
   * @returns This writer, for chaining.
   */
  i64(n: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true);
    return this.bytes(b);
  }

  /**
   * Appends `n` in the shortest CompactSize encoding.
   *
   * @param n - A non-negative safe integer.
   * @returns This writer, for chaining.
   * @throws Error when `n` is negative or not a safe integer.
   */
  compactSize(n: number): this {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid CompactSize");
    if (n < 253) return this.u8(n);
    if (n <= 0xffff) {
      const b = new Uint8Array(3);
      b[0] = 253;
      new DataView(b.buffer).setUint16(1, n, true);
      return this.bytes(b);
    }
    if (n <= 0xffffffff) {
      this.u8(254);
      return this.u32(n);
    }
    this.u8(255);
    return this.i64(BigInt(n));
  }

  /**
   * Appends a CompactSize length followed by the bytes.
   *
   * @param b - The bytes to append.
   * @returns This writer, for chaining.
   */
  varBytes(b: Uint8Array): this {
    return this.compactSize(b.length).bytes(b);
  }

  /**
   * Joins everything written so far.
   *
   * @returns The serialized bytes.
   */
  finish(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

/**
 * Reads Bitcoin wire-format fields from a buffer, throwing on truncation.
 */
export class ByteReader {
  pos = 0;

  /**
   * Starts reading at offset 0.
   *
   * @param b - The buffer to read.
   */
  constructor(private readonly b: Uint8Array) {}

  /**
   * Bytes left after the read position.
   *
   * @returns The count.
   */
  get remaining(): number {
    return this.b.length - this.pos;
  }

  /**
   * Reads the next `n` bytes.
   *
   * @param n - The number of bytes.
   * @returns A copy of those bytes.
   * @throws Error when fewer than `n` bytes remain.
   */
  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.b.length) {
      throw new Error(`truncated at byte ${this.pos}`);
    }
    const s = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  /**
   * Reads one byte.
   *
   * @returns The byte value.
   */
  u8(): number {
    return this.take(1)[0] as number;
  }

  /**
   * Reads a 32-bit little-endian unsigned integer.
   *
   * @returns The value.
   */
  u32(): number {
    return new DataView(this.take(4).buffer).getUint32(0, true);
  }

  /**
   * Reads a 64-bit little-endian signed integer.
   *
   * @returns The value.
   */
  i64(): bigint {
    return new DataView(this.take(8).buffer).getBigInt64(0, true);
  }

  /**
   * Reads a CompactSize, refusing non-canonical encodings and values above MAX_SIZE as the node's
   * ReadCompactSize does.
   *
   * @returns The decoded value.
   * @throws Error on a non-canonical or oversized encoding.
   */
  compactSize(): number {
    const first = this.u8();
    let n: number;
    if (first < 253) return first;
    if (first === 253) {
      n = new DataView(this.take(2).buffer).getUint16(0, true);
      if (n < 253) throw new Error("non-canonical CompactSize");
    } else if (first === 254) {
      n = this.u32();
      if (n <= 0xffff) throw new Error("non-canonical CompactSize");
    } else {
      const big = new DataView(this.take(8).buffer).getBigUint64(0, true);
      if (big <= 0xffffffffn) throw new Error("non-canonical CompactSize");
      n = Number(big);
    }
    // MAX_SIZE in serialize.h: 0x02000000.
    if (n > 0x02000000) throw new Error("CompactSize too large");
    return n;
  }

  /**
   * Reads a CompactSize length and then that many bytes.
   *
   * @returns The bytes.
   */
  varBytes(): Uint8Array {
    return this.take(this.compactSize());
  }
}
