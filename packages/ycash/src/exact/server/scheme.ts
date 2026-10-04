// The exact resource-server side for Ycash: prices in YEC (or USD through a price source), and
// the `extra` the 402 carries (specs/scheme_exact_ycash.md, "PaymentRequirements").
import type {
  AssetAmount,
  Money,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { ASSET_YEC, ASSET_YED, YED_MAX_OUTPUT_CENTS, YED_MIN_OUTPUT_CENTS } from "../../constants.js";
import { assetTransferMethodOf, DUST_ZAT, isShieldedMethod, isYcashNetwork, MAX_CONFIRMATIONS, MIN_CONFIRMATIONS, resolveConfirmationPolicy } from "../policy.js";
import { ATM_SAPLING_PROOF, ATM_TRANSPARENT, FLOW_AUTHORIZATION, FLOW_UPFRONT, SCHEME_EXACT, type ShieldedExactHandler } from "../types.js";
import { microUsdToZat, type YecPriceSource } from "./priceSource.js";

export interface ExactYcashServerConfig {
  /** Converts `$…` prices to YEC. Without one, only YEC (and YED) prices are accepted. */
  priceSource?: YecPriceSource;
  /**
   * The zero-confirmation cap: a YEC payment up to this many zatoshis defaults to policy −1,
   * larger ones to 1. Default: $1.00 through the price source (the spec's suggestion), or no
   * zero-confirmation default when there is no price source.
   */
  zeroConfCapZat?: bigint;
  /** The `sapling-proof` method (plan X4a), implemented in src/shielded. */
  shielded?: ShieldedExactHandler;
}

const CANONICAL_AMOUNT = /^[1-9][0-9]*$/;
const ONE_DOLLAR_MICRO_USD = 1_000_000n;

export class ExactYcashServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME_EXACT;
  readonly defaultAssetTransferMethod = ATM_TRANSPARENT;
  /** `transparent` signs and the facilitator submits after the handler; `sapling-proof` is paid upfront. */
  readonly paymentFlows: Readonly<Record<string, PaymentFlowConfig>>;
  private readonly moneyParsers: MoneyParser[] = [];

  constructor(private readonly config: ExactYcashServerConfig = {}) {
    const flows: Record<string, PaymentFlowConfig> = { [ATM_TRANSPARENT]: { supported: [FLOW_AUTHORIZATION], default: FLOW_AUTHORIZATION } };
    if (config.shielded) flows[ATM_SAPLING_PROOF] = { supported: [FLOW_UPFRONT], default: FLOW_UPFRONT };
    this.paymentFlows = flows;
  }

  /** Custom money parsers run first, in registration order; null defers to the next. */
  registerMoneyParser(parser: MoneyParser): this {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * `{amount, asset}` passes through after validation. Money: "0.0025 YEC" in YEC, "25 YED" in
   * YED, and "$0.10" (or "0.10", "0.10 USD") in YEC at the price source's rate.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (!isYcashNetwork(network)) throw new Error(`unsupported network ${network}`);
    if (typeof price === "object" && price !== null && "amount" in price) {
      return validate({ amount: price.amount, asset: price.asset, extra: price.extra ?? {} });
    }
    const { amount, symbol } = parseMoney(price as Money);
    for (const parser of this.moneyParsers) {
      const r = await parser(amount, network);
      if (r !== null) return validate(r);
    }
    if (symbol === ASSET_YEC) return validate({ amount: convertToTokenAmount(amount, 8), asset: ASSET_YEC, extra: {} });
    if (symbol === ASSET_YED) return validate({ amount: convertToTokenAmount(amount, 2), asset: ASSET_YED, extra: {} });
    if (symbol !== undefined) throw new Error(`unknown asset ${symbol} on ${network}`);
    if (!this.config.priceSource) throw new Error("a USD price needs a price source (or price in YEC)");
    const rate = await this.config.priceSource.microUsdPerYec(network);
    const zat = microUsdToZat(BigInt(convertToTokenAmount(amount, 6)), rate);
    return validate({ amount: zat.toString(), asset: ASSET_YEC, extra: {} });
  }

  getAssetDecimals(asset: string, network: Network): number | undefined {
    void network;
    return asset === ASSET_YEC ? 8 : asset === ASSET_YED ? 2 : undefined;
  }

  /**
   * Adds the `extra` the spec's 402 carries: `assetTransferMethod`, `areFeesSponsored: false`
   * and `confirmationPolicy` (−1 up to the zero-confirmation cap, else 1). Fields the route set
   * are kept. A facilitator that advertises capabilities must cover the method and the policy.
   */
  async enhancePaymentRequirements(req: PaymentRequirements, kind: SupportedKind, facilitatorExtensions: string[]): Promise<PaymentRequirements> {
    if (!isYcashNetwork(kind.network)) throw new Error(`unsupported network ${kind.network}`);
    if (isShieldedMethod(req.extra)) {
      if (!this.config.shielded) throw new Error("sapling-proof requirements need a shielded handler");
      return this.config.shielded.enhanceRequirements(req, kind, facilitatorExtensions);
    }
    const method = assetTransferMethodOf(req.extra);
    if (method !== ATM_TRANSPARENT) throw new Error(`unsupported assetTransferMethod ${String(method)}`);
    const advertised = kind.extra as { assetTransferMethods?: unknown; confirmations?: { minimum?: unknown; maximum?: unknown } } | undefined;
    const min = typeof advertised?.confirmations?.minimum === "number" ? advertised.confirmations.minimum : MIN_CONFIRMATIONS;
    const max = typeof advertised?.confirmations?.maximum === "number" ? advertised.confirmations.maximum : MAX_CONFIRMATIONS;
    if (Array.isArray(advertised?.assetTransferMethods) && !advertised.assetTransferMethods.includes(ATM_TRANSPARENT)) {
      throw new Error("the facilitator does not support assetTransferMethod transparent");
    }
    const fallback = Math.max(min, await this.defaultConfirmations(req));
    const policy = resolveConfirmationPolicy(req.extra, fallback);
    if (!policy) throw new Error("invalid confirmationPolicy");
    if (policy.confirmations < min || policy.confirmations > max) {
      throw new Error(`the facilitator settles confirmations ${min}..${max}, not ${policy.confirmations}`);
    }
    return {
      ...req,
      extra: { ...req.extra, assetTransferMethod: ATM_TRANSPARENT, areFeesSponsored: false, confirmationPolicy: policy },
    };
  }

  /** −1 for YEC up to the zero-confirmation cap; 1 otherwise and for YED (Confirmation policy). */
  private async defaultConfirmations(req: PaymentRequirements): Promise<number> {
    if (req.asset !== ASSET_YEC) return 1;
    let cap = this.config.zeroConfCapZat;
    if (cap === undefined && this.config.priceSource) {
      // No price, no zero-confirmation default: 1 is the safe side.
      const rate = await this.config.priceSource.microUsdPerYec(req.network).catch(() => undefined);
      if (rate !== undefined) cap = microUsdToZat(ONE_DOLLAR_MICRO_USD, rate);
    }
    return cap !== undefined && BigInt(req.amount) <= cap ? -1 : 1;
  }
}

function validate(v: AssetAmount): AssetAmount {
  if (!CANONICAL_AMOUNT.test(v.amount)) throw new Error(`amount must be a positive canonical integer: ${v.amount}`);
  if (v.asset === ASSET_YEC) {
    if (BigInt(v.amount) < DUST_ZAT) throw new Error(`a YEC amount must be at least ${DUST_ZAT} zatoshis (dust)`);
  } else if (v.asset === ASSET_YED) {
    const c = BigInt(v.amount);
    if (c < BigInt(YED_MIN_OUTPUT_CENTS) || c > BigInt(YED_MAX_OUTPUT_CENTS)) throw new Error(`a YED amount must be ${YED_MIN_OUTPUT_CENTS}..${YED_MAX_OUTPUT_CENTS} cents`);
  } else {
    throw new Error(`asset must be ${ASSET_YEC} or ${ASSET_YED}: ${v.asset}`);
  }
  return v;
}
