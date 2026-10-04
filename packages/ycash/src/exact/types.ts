// Types shared by the exact client, server and facilitator (specs/scheme_exact_ycash.md).
import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
} from "@x402/core/types";

export const SCHEME_EXACT = "exact" as const;

/** `extra.assetTransferMethod` values. Absent means `transparent`. */
export const ATM_TRANSPARENT = "transparent" as const;
export const ATM_SAPLING_PROOF = "sapling-proof" as const;
/** Reserved, not yet specified (plan X4b): a facilitator MUST reject it. */
export const ATM_SAPLING_RESERVED = "sapling" as const;

/** The flows the spec names per method (`transparent`: authorization; `sapling-proof`: upfront). */
export const FLOW_AUTHORIZATION = "authorization" as const;
export const FLOW_UPFRONT = "upfront" as const;

/** `payload` of a `transparent` payment: the complete signed v4 tx, lowercase hex, not broadcast. */
export interface ExactYcashTransparentPayload {
  transaction: string;
}

/** `extra.confirmationPolicy`: −1 mempool, 0 in a block, N confirmations (N ≤ 20). */
export interface ConfirmationPolicy {
  confirmations: number;
}

/** `extra` of the settle response: the strongest evidence observed. */
export interface ExactYcashSettleExtra {
  status: "mempool" | "confirmed" | "pending";
  /** −1 for mempool, the node's depth when confirmed; null while nothing was observed. */
  confirmations: number | null;
}

/**
 * The `sapling-proof` method (plan X4a) is implemented in `src/shielded/`. The exact server and
 * facilitator only route to it, so the transparent code never grows shielded logic.
 */
export interface ShieldedExactHandler {
  /** Issues the per-request instrument (fresh diversified `payTo`, `memo`, `expiresAt`). */
  enhanceRequirements(
    requirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements>;
  /** The flow is `upfront`, so core does not call verify; a handler MAY still offer one. */
  verify?(payload: PaymentPayload, requirements: PaymentRequirements, context?: FacilitatorContext): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements, context?: FacilitatorContext): Promise<SettleResponse>;
}
