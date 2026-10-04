// USD prices for YEC-denominated requirements. Pluggable; the bundled source reads the Yellowback
// overlay's own price, `yed_getprice` (plan Y-9), on a Yellowback node.
import type { YcashRpc } from "../../node/index.js";

export interface YecPriceSource {
  /** micro-USD per YEC (1 YEC = $50 is 50_000_000n), positive. */
  microUsdPerYec(network: string): Promise<bigint>;
}

/** The fields of `yed_getprice`, all in micro-USD per YEC (ycash-dd/src/rpc/yellowback.cpp). */
export type YedPriceField = "pFast" | "pMid" | "pSlow" | "pMint" | "pClaim";

/**
 * `yed_getprice`'s median of the chain's price windows. pMid by default: steadier than pFast,
 * fresher than pSlow; a merchant may prefer another field.
 */
export class YedGetPriceSource implements YecPriceSource {
  constructor(
    private readonly rpc: Pick<YcashRpc, "yedGetPrice">,
    private readonly field: YedPriceField = "pMid",
  ) {}

  async microUsdPerYec(_network: string): Promise<bigint> {
    void _network;
    const p = await this.rpc.yedGetPrice();
    const v = p[this.field];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error(`yed_getprice has no ${this.field} price`);
    return BigInt(v);
  }
}

/** A fixed price, for tests and for merchants with their own feed. */
export class FixedPriceSource implements YecPriceSource {
  constructor(private readonly microUsd: bigint) {
    if (microUsd <= 0n) throw new Error("price must be positive");
  }
  async microUsdPerYec(): Promise<bigint> {
    return this.microUsd;
  }
}

/** USD (micro-USD) to zatoshis, rounded up so the merchant never receives less than the price. */
export function microUsdToZat(microUsd: bigint, microUsdPerYec: bigint): bigint {
  return (microUsd * 100_000_000n + microUsdPerYec - 1n) / microUsdPerYec;
}
