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

  constructor(
    private readonly rpc: Pick<YcashRpc, "yedGetPrice">,
    fields: YedPriceField | readonly YedPriceField[] = ["pMid", "pSlow"],
  ) {
    this.fields = typeof fields === "string" ? [fields] : fields;
  }

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
