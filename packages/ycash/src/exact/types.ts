// Types shared by the exact client, server and facilitator (specs/scheme_exact_ycash.md).
import type {
  FacilitatorContext,
  PaymentFlowName,
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
/** The facilitator-submitted shielded method (plan X4b), implemented in `src/shielded/` beside `sapling-proof`. */
export const ATM_SAPLING = "sapling" as const;
/** @deprecated the method is specified; kept for callers of the old name. */
export const ATM_SAPLING_RESERVED = ATM_SAPLING;

/** The flows the spec names per method (`transparent`, `sapling`: authorization; `sapling-proof`: upfront). */
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
 * The shielded methods (`sapling-proof`, plan X4a; `sapling`, plan X4b) are implemented in
 * `src/shielded/`. The exact server and facilitator only route to this hook, so the transparent
 * code never grows shielded logic.
 */
export interface ShieldedExactHandler {
  /** Flow per method the handler serves; absent means `sapling-proof` upfront only. */
  readonly flows?: Readonly<Record<string, PaymentFlowName>>;
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
