// Error codes of specs/scheme_exact_ycash.md ("Error Codes"); the core codes keep upstream's names.

export const ERR_NETWORK_MISMATCH = "network_mismatch";
export const ERR_DUPLICATE_SETTLEMENT = "duplicate_settlement";
export const ERR_SETTLEMENT_PENDING = "settlement_pending";
/** A node or transport failure: says nothing about the payment. */
export const ERR_SETTLEMENT_FAILED = "settlement_failed";

export const ERR_REQUIREMENTS_MISMATCH = "invalid_exact_ycash_requirements_mismatch";
export const ERR_ASSET_TRANSFER_METHOD = "invalid_exact_ycash_asset_transfer_method";
export const ERR_PAYMENT_FLOW = "invalid_exact_ycash_payment_flow";
export const ERR_TRANSACTION = "invalid_exact_ycash_transaction";
export const ERR_RECIPIENT_MISMATCH = "invalid_exact_ycash_recipient_mismatch";
export const ERR_AMOUNT_MISMATCH = "invalid_exact_ycash_amount_mismatch";
export const ERR_SIGHASH = "invalid_exact_ycash_sighash";
export const ERR_INPUT_SPENT = "invalid_exact_ycash_input_spent";
export const ERR_FEE_TOO_LOW = "invalid_exact_ycash_fee_too_low";
export const ERR_FEE_TOO_HIGH = "invalid_exact_ycash_fee_too_high";
export const ERR_EXPIRY = "invalid_exact_ycash_expiry";
export const ERR_SCRIPT = "invalid_exact_ycash_script";
export const ERR_YED_INPUT = "invalid_exact_ycash_yed_input";
export const ERR_YED_NODE_REQUIRED = "invalid_exact_ycash_yed_node_required";
export const ERR_YED_PAYLOAD = "invalid_exact_ycash_yed_payload";
export const ERR_YED_VERDICT = "invalid_exact_ycash_yed_verdict";
export const ERR_YED_UNCONFIRMED_INPUT = "invalid_exact_ycash_yed_unconfirmed_input";
