// YEC amounts across the RPC boundary. The node parses an amount from a JSON number or a string
// with ParseFixedPoint(…, 8) (`src/rpc/server.cpp:119-129` v4.5.0, `:110-120` 6.21.0), so the SDK
// sends exact decimal strings built from integer zatoshis and never a float.

export const ZAT_PER_YEC = 100_000_000n;

/**
 * Formats zatoshis as the exact 8-decimal string the node parses, e.g. 250000n -> "0.00250000".
 *
 * @param zat - The amount in zatoshis; negative amounts keep their sign.
 * @returns The amount in YEC as a fixed-point decimal string.
 */
export function zatToYecString(zat: bigint | number): string {
  const z = BigInt(zat);
  const neg = z < 0n;
  const abs = neg ? -z : z;
  const whole = abs / ZAT_PER_YEC;
  const frac = (abs % ZAT_PER_YEC).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/**
 * A YEC amount the node printed (ValueFromAmount: a JSON number with at most 8 decimals) to zatoshis.
 * Exact for every amount below 2^53 zatoshis (about 90 million YEC, under the 21 million supply).
 *
 * @param yec - The amount in YEC, as a JSON number or a decimal string.
 * @returns The amount in zatoshis.
 * @throws RangeError when the input is not a decimal with at most 8 fractional digits.
 */
export function yecToZat(yec: number | string): bigint {
  const s = typeof yec === "number" ? yec.toFixed(8) : yec.trim();
  const m = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(s);
  if (!m) throw new RangeError(`not a YEC amount: ${s}`);
  const z = BigInt(m[2] ?? "0") * ZAT_PER_YEC + BigInt((m[3] ?? "").padEnd(8, "0"));
  return m[1] === "-" ? -z : z;
}
