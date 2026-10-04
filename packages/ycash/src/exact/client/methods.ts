// One `exact` client for both client-side transfer methods. x402Client holds one scheme per
// (network, "exact"), so the transparent client and the `sapling-proof` payer sit behind a router
// that picks by `extra.assetTransferMethod`, as ExactYcashServerScheme and the facilitator route
// to their `shielded` handler.
import type { PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { isShieldedMethod } from "../policy.js";
import { SCHEME_EXACT } from "../types.js";
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
}

export class ExactYcashMethodRouter implements SchemeNetworkClient {
  readonly scheme = SCHEME_EXACT;
  readonly findDefaultAsset = findYcashDefaultAsset;

  constructor(private readonly config: ExactYcashMethodRouterConfig) {
    if (!config.transparent && !config.shielded) throw new Error("ExactYcashMethodRouter needs a transparent client, a shielded payer, or both");
  }

  /** The methods this client can pay, for logs and tests. */
  get methods(): string[] {
    return [...(this.config.transparent ? ["transparent"] : []), ...(this.config.shielded ? ["sapling-proof"] : [])];
  }

  createPaymentPayload(x402Version: number, requirements: PaymentRequirements, context?: PaymentPayloadContext): Promise<PaymentPayloadResult> {
    if (isShieldedMethod(requirements.extra)) {
      if (!this.config.shielded) return Promise.reject(new Error("this client has no Sapling wallet configured for sapling-proof"));
      return this.config.shielded.createPaymentPayload(x402Version, requirements);
    }
    if (!this.config.transparent) return Promise.reject(new Error("this client pays sapling-proof only, not transparent"));
    return this.config.transparent.createPaymentPayload(x402Version, requirements, context);
  }
}
