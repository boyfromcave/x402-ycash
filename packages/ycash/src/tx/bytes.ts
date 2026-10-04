// Byte helpers: hex, concatenation, and the Bitcoin wire primitives (little-endian integers,
// CompactSize) the v4 transaction format is built from.

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

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

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A display-order hash (txid, block hash) is the internal byte order reversed. */
export function reversedHex(b: Uint8Array): string {
  return bytesToHex(Uint8Array.from(b).reverse());
}

export function fromReversedHex(hex: string, len = 32): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
  return b.reverse();
}

/** Size of the CompactSize prefix for n. */
export function compactSizeLen(n: number): number {
  return n < 253 ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
}

export class ByteWriter {
  private chunks: Uint8Array[] = [];

  bytes(b: Uint8Array): this {
    this.chunks.push(b);
    return this;
  }

  u8(n: number): this {
    return this.bytes(Uint8Array.of(n & 0xff));
  }

  u32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return this.bytes(b);
  }

  /** 64-bit little-endian; negative values are written as two's complement (int64). */
  i64(n: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true);
    return this.bytes(b);
  }

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

  varBytes(b: Uint8Array): this {
    return this.compactSize(b.length).bytes(b);
  }

  finish(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

export class ByteReader {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}

  get remaining(): number {
    return this.b.length - this.pos;
  }

  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.b.length) {
      throw new Error(`truncated at byte ${this.pos}`);
    }
    const s = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  u8(): number {
    return this.take(1)[0] as number;
  }

  u32(): number {
    return new DataView(this.take(4).buffer).getUint32(0, true);
  }

  i64(): bigint {
    return new DataView(this.take(8).buffer).getBigInt64(0, true);
  }

  /** CompactSize, refusing non-canonical encodings as the node's ReadCompactSize does. */
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

  varBytes(): Uint8Array {
    return this.take(this.compactSize());
  }
}
