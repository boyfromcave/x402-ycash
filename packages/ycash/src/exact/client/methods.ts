// One `exact` client for both client-side transfer methods. x402Client holds one scheme per
// (network, "exact"), so the transparent client and the `sapling-proof` payer sit behind a router
// that picks by `extra.assetTransferMethod`, as ExactYcashServerScheme and the facilitator route
// to their `shielded` handler.
import type { PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { assetTransferMethodOf, isShieldedMethod } from "../policy.js";
import { ATM_SAPLING, SCHEME_EXACT } from "../types.js";
import { findYcashDefaultAsset } from "./scheme.js";

/** The `sapling-proof` payer: pays from a Sapling wallet and presents the txid (src/shielded ShieldedExactClient). */
export interface ShieldedExactPayer {
  createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<PaymentPayloadResult>;
}

export interface ExactYcashMethodRouterConfig {
  /** `transparent`: an ExactYcashScheme over a local-key or node-wallet signer. */
  transparent?: SchemeNetworkClient;
  /** `sapling-proof`: a ShieldedExactClient over the payer's node wallet. */
  shielded?: ShieldedExactPayer;
  /** `sapling`: a SaplingExactClient over an external Sapling builder (src/shielded/builder.ts). */
  sapling?: ShieldedExactPayer;
}

/**
 * Routes `createPaymentPayload` to the transparent client or the Sapling payer by the
 * requirement's `extra.assetTransferMethod`.
 */
export class ExactYcashMethodRouter implements SchemeNetworkClient {
  readonly scheme = SCHEME_EXACT;
  readonly findDefaultAsset = findYcashDefaultAsset;

  /**
   * Builds the router.
   *
   * @param config - The transparent client, the shielded payer, or both.
   * @throws Error when neither is given.
   */
  constructor(private readonly config: ExactYcashMethodRouterConfig) {
    if (!config.transparent && !config.shielded && !config.sapling) throw new Error("ExactYcashMethodRouter needs a transparent client or a shielded payer");
  }

  /**
   * The methods this client can pay, for logs and tests.
   *
   * @returns The configured method names.
   */
  get methods(): string[] {
    return [...(this.config.transparent ? ["transparent"] : []), ...(this.config.shielded ? ["sapling-proof"] : []), ...(this.config.sapling ? ["sapling"] : [])];
  }

  /**
   * Hands the requirements to the payer for their method; rejects when that method is not
   * configured.
   *
   * @param x402Version - The protocol version of the 402.
   * @param requirements - The selected payment requirements.
   * @param context - Optional payload context, passed to the transparent client.
   * @returns The payment payload.
   */
  createPaymentPayload(x402Version: number, requirements: PaymentRequirements, context?: PaymentPayloadContext): Promise<PaymentPayloadResult> {
    if (isShieldedMethod(requirements.extra)) {
      // `sapling` needs a signed-but-unbroadcast Sapling transaction, which no node wallet builds (plan Z-1).
      if (assetTransferMethodOf(requirements.extra) === ATM_SAPLING) {
        if (!this.config.sapling) return Promise.reject(new Error("this client cannot pay sapling: no Sapling transaction builder is configured"));
        return this.config.sapling.createPaymentPayload(x402Version, requirements);
      }
      if (!this.config.shielded) return Promise.reject(new Error("this client has no Sapling wallet configured for sapling-proof"));
      return this.config.shielded.createPaymentPayload(x402Version, requirements);
    }
    if (!this.config.transparent) return Promise.reject(new Error("this client pays shielded methods only, not transparent"));
    return this.config.transparent.createPaymentPayload(x402Version, requirements, context);
  }
}
