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
 * `yed_getprice`'s price windows, first available of `fields`: pMid (steadier than pFast, fresher
 * than pSlow), then pSlow. A window is null until enough recent blocks carry pool quotes, so a
 * single field can go missing on a quiet chain.
 */
export class YedGetPriceSource implements YecPriceSource {
  private readonly fields: readonly YedPriceField[];

  /**
   * Builds a source over a Yellowback node's `yed_getprice`.
   *
   * @param rpc - A client exposing `yed_getprice`.
   * @param fields - Windows to try in order; defaults to pMid then pSlow.
   */
  constructor(
    private readonly rpc: Pick<YcashRpc, "yedGetPrice">,
    fields: YedPriceField | readonly YedPriceField[] = ["pMid", "pSlow"],
  ) {
    this.fields = typeof fields === "string" ? [fields] : fields;
  }

  /**
   * Returns the first window in `fields` that holds a positive integer price. The node answers for
   * its own chain, so the network argument is not consulted.
   *
   * @param _network - The requirement's network (unused).
   * @returns The price in micro-USD per YEC.
   * @throws Error when none of the windows has a price yet.
   */
  async microUsdPerYec(_network: string): Promise<bigint> {
    void _network;
    const p = await this.rpc.yedGetPrice();
    for (const f of this.fields) {
      const v = p[f];
      if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return BigInt(v);
    }
    throw new Error(`yed_getprice has no ${this.fields.join("/")} price`);
  }
}

/** A fixed price, for tests and for merchants with their own feed. */
export class FixedPriceSource implements YecPriceSource {
  /**
   * Fixes the rate.
   *
   * @param microUsd - The price in micro-USD per YEC.
   * @throws Error when the price is not positive.
   */
  constructor(private readonly microUsd: bigint) {
    if (microUsd <= 0n) throw new Error("price must be positive");
  }

  /**
   * Returns the fixed rate for every network.
   *
   * @returns The price in micro-USD per YEC.
   */
  async microUsdPerYec(): Promise<bigint> {
    return this.microUsd;
  }
}

/**
 * Converts micro-USD to zatoshis, rounded up so the merchant never receives less than the price.
 *
 * @param microUsd - The amount in micro-USD.
 * @param microUsdPerYec - The rate in micro-USD per YEC.
 * @returns The amount in zatoshis.
 */
export function microUsdToZat(microUsd: bigint, microUsdPerYec: bigint): bigint {
  return (microUsd * 100_000_000n + microUsdPerYec - 1n) / microUsdPerYec;
}
