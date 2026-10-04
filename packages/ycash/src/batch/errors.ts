// Error codes (specs/scheme_batch_settlement_ycash.md, "Error Codes"; core codes from
// x402-specification-v2.md §9).
export const BatchError = {
  PAYLOAD: "invalid_payload",
  REQUIREMENTS: "invalid_payment_requirements",
  NETWORK: "network_mismatch",
  SETTLEMENT_PENDING: "settlement_pending",
  PAYLOAD_TYPE: "invalid_batch_settlement_ycash_payload_type",
  REDEEM_SCRIPT: "invalid_batch_settlement_ycash_redeem_script",
  FUNDING: "invalid_batch_settlement_ycash_funding",
  DEPOSIT_TOO_LARGE: "invalid_batch_settlement_ycash_deposit_too_large",
  FUNDING_DEPTH: "invalid_batch_settlement_ycash_funding_depth",
  UNKNOWN_CHANNEL: "invalid_batch_settlement_ycash_unknown_channel",
  CHANNEL_CLOSING: "invalid_batch_settlement_ycash_channel_closing",
  VOUCHER_SHAPE: "invalid_batch_settlement_ycash_voucher_shape",
  CUMULATIVE_MISMATCH: "invalid_batch_settlement_ycash_cumulative_mismatch",
  CUMULATIVE_EXCEEDS_DEPOSIT: "invalid_batch_settlement_ycash_cumulative_exceeds_deposit",
  STALE_VOUCHER: "invalid_batch_settlement_ycash_stale_voucher",
  VOUCHER_SIGNATURE: "invalid_batch_settlement_ycash_voucher_signature",
  SCRIPT: "invalid_batch_settlement_ycash_script",
  YED_FLOOR: "invalid_batch_settlement_ycash_yed_floor",
  YED_VERDICT: "invalid_batch_settlement_ycash_yed_verdict",
  YED_NODE_REQUIRED: "invalid_batch_settlement_ycash_yed_node_required",
  /** Another voucher of this channel is being served (one in flight per channel). */
  CHANNEL_BUSY: "invalid_batch_settlement_ycash_channel_busy",
} as const;

export type BatchErrorCode = (typeof BatchError)[keyof typeof BatchError] | (string & {});

/** A refusal with its wire reason; `message` is for logs. */
export class BatchSettlementError extends Error {
  readonly reason: BatchErrorCode;
  constructor(reason: BatchErrorCode, message?: string) {
    super(message ? `${reason}: ${message}` : reason);
    this.name = "BatchSettlementError";
    this.reason = reason;
  }
}

/** The wire reason of any thrown value. */
export function reasonOf(e: unknown): string {
  return e instanceof BatchSettlementError ? e.reason : "unexpected_error";
}
