// Quoting a YEC amount from a dollar price (plan §5.9, "Price in dollars"): from Yellowback's own
// attested price (`yed_getprice`, micro-USD per YEC) when the merchant node runs the overlay, else a
// configured price. The quote is fixed in `amount` for the request's validity window.
import { RPC_METHOD_NOT_FOUND, RpcError, type YedPrice } from "../node/index.js";

export interface PriceQuote {
  /** micro-USD per YEC */
  priceMicroUsd: number;
  /** "yed_getprice:pMid" etc., or "configured" */
  source: string;
  /** The snapshot height, for a yed_getprice quote */
  height?: number;
}

/** The yed_getprice fields tried in order: the mid window first, a median with less noise than pFast. */
export const YED_PRICE_FIELDS = ["pMid", "pFast", "pSlow"] as const;

/**
 * Parses a decimal USD string ("0.05", "12", "1.234567") to micro-USD, exactly.
 *
 * @param usd - The dollar amount, at most 6 decimals, no sign or unit.
 * @returns Micro-USD.
 * @throws RangeError when it is not such an amount.
 */
export function usdToMicro(usd: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd.trim());
  if (!m) throw new RangeError(`not a USD amount with at most 6 decimals: ${usd}`);
  return BigInt(m[1] ?? "0") * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/**
 * Zatoshis for `usd` at `priceMicroUsd` per YEC, rounded up so the merchant is never short.
 *
 * @param usd - The dollar price, as for {@link usdToMicro}.
 * @param priceMicroUsd - The YEC price, micro-USD per YEC.
 * @returns The amount in zatoshis.
 * @throws RangeError for a non-positive or non-integer price, or a non-positive amount.
 */
export function quoteZat(usd: string, priceMicroUsd: number): bigint {
  if (!Number.isSafeInteger(priceMicroUsd) || priceMicroUsd <= 0) throw new RangeError(`bad price ${priceMicroUsd}`);
  const micro = usdToMicro(usd);
  if (micro <= 0n) throw new RangeError(`USD amount must be positive: ${usd}`);
  const p = BigInt(priceMicroUsd);
  return (micro * 100_000_000n + p - 1n) / p;
}

export interface PriceRpc {
  yedGetPrice(height?: number): Promise<YedPrice>;
}

/**
 * The price from `yed_getprice` when the node has the overlay and a live price, else `fallback`.
 * A stock node answers -32601 (no such method); a Yellowback node before activation, or with too few
 * quote tags, returns null prices.
 *
 * @param rpc - The merchant node.
 * @param fallbackMicroUsd - The configured price, micro-USD per YEC.
 * @returns The first positive of pMid, pFast, pSlow, or the configured price.
 * @throws Error when neither is available; any RPC error other than method-not-found is rethrown.
 */
export async function currentPrice(rpc: PriceRpc, fallbackMicroUsd?: number): Promise<PriceQuote> {
  try {
    const p = await rpc.yedGetPrice();
    for (const f of YED_PRICE_FIELDS) {
      const v = p[f];
      if (typeof v === "number" && v > 0) return { priceMicroUsd: v, source: `yed_getprice:${f}`, height: p.height };
    }
  } catch (e) {
    if (!(e instanceof RpcError) || e.transport || e.code !== RPC_METHOD_NOT_FOUND) throw e;
  }
  if (fallbackMicroUsd !== undefined) return { priceMicroUsd: fallbackMicroUsd, source: "configured" };
  throw new Error("no YEC price: the node has no live yed_getprice and no fallback price is configured");
}
