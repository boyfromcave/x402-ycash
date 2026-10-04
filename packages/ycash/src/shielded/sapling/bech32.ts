// Bech32 (BIP 173, not bech32m) with no length limit: Sapling viewing keys and regtest addresses are
// longer than BIP 173's 90 characters, and zcashd encodes them anyway (zcash_keys::encoding::bech32_decode).
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/**
 * The BCH checksum state over 5-bit values (BIP 173 `bech32_polymod`).
 *
 * @param values - 5-bit values: the expanded HRP, then the data.
 * @returns The polymod; 1 for a valid bech32 string.
 */
function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i] as number;
  }
  return chk >>> 0;
}

/**
 * The HRP as the checksum reads it: high bits of each character, a zero, then the low bits.
 *
 * @param hrp - The human-readable part, lower case.
 * @returns The expanded 5-bit values.
 */
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/**
 * Regroups a bit stream from `from`-bit to `to`-bit values.
 *
 * @param data - The input values, each below 2^from.
 * @param from - Bits per input value.
 * @param to - Bits per output value.
 * @param pad - True to pad the last value with zeros (encoding); false is the decoder's strict mode.
 * @returns The regrouped values.
 * @throws {Error} In strict mode, when the leftover bits are too many or not zero.
 */
function convertBits(data: Iterable<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error("bech32: invalid padding");
  }
  return out;
}

/**
 * Encodes bytes as bech32 under `hrp`, with no length limit.
 *
 * @param hrp - The human-readable part, lower case (e.g. "ys").
 * @param bytes - The payload.
 * @returns The bech32 string.
 */
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}

/**
 * Decodes a bech32 string, with no length limit.
 *
 * @param s - The string; all lower or all upper case.
 * @returns The HRP (lower case) and the payload bytes.
 * @throws {Error} On mixed case, a missing separator, a bad character, a bad checksum or bad padding.
 */
export function bech32Decode(s: string): { hrp: string; bytes: Uint8Array } {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error("bech32: mixed case");
  const str = s.toLowerCase();
  const sep = str.lastIndexOf("1");
  if (sep < 1 || sep + 7 > str.length) throw new Error("bech32: no separator or checksum");
  const hrp = str.slice(0, sep);
  const data: number[] = [];
  for (const c of str.slice(sep + 1)) {
    const d = CHARSET.indexOf(c);
    if (d < 0) throw new Error(`bech32: invalid character ${JSON.stringify(c)}`);
    data.push(d);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("bech32: bad checksum");
  return { hrp, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}
