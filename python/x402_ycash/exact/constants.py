"""Scheme constants and the error codes of specs/scheme_exact_ycash.md ("Error Codes").
The core codes keep upstream's names."""

SCHEME_EXACT = "exact"

ATM_TRANSPARENT = "transparent"
"""``extra.assetTransferMethod``; absent means transparent."""
ATM_SAPLING_PROOF = "sapling-proof"
ATM_SAPLING = "sapling"
"""The facilitator-submitted shielded method (plan X4b), in x402_ycash.shielded."""
ATM_SAPLING_RESERVED = ATM_SAPLING
"""Deprecated name, kept for callers."""
"""Reserved, not yet specified (plan X4b): a facilitator MUST reject it."""

FLOW_AUTHORIZATION = "authorization"
FLOW_UPFRONT = "upfront"

MIN_CONFIRMATIONS = -1
MAX_CONFIRMATIONS = 20

ERR_NETWORK_MISMATCH = "network_mismatch"
ERR_DUPLICATE_SETTLEMENT = "duplicate_settlement"
ERR_SETTLEMENT_PENDING = "settlement_pending"
ERR_SETTLEMENT_FAILED = "settlement_failed"
"""A node or transport failure: says nothing about the payment."""

ERR_REQUIREMENTS_MISMATCH = "invalid_exact_ycash_requirements_mismatch"
ERR_ASSET_TRANSFER_METHOD = "invalid_exact_ycash_asset_transfer_method"
ERR_PAYMENT_FLOW = "invalid_exact_ycash_payment_flow"
ERR_TRANSACTION = "invalid_exact_ycash_transaction"
ERR_RECIPIENT_MISMATCH = "invalid_exact_ycash_recipient_mismatch"
ERR_AMOUNT_MISMATCH = "invalid_exact_ycash_amount_mismatch"
ERR_SIGHASH = "invalid_exact_ycash_sighash"
ERR_INPUT_SPENT = "invalid_exact_ycash_input_spent"
ERR_FEE_TOO_LOW = "invalid_exact_ycash_fee_too_low"
ERR_FEE_TOO_HIGH = "invalid_exact_ycash_fee_too_high"
ERR_EXPIRY = "invalid_exact_ycash_expiry"
ERR_SCRIPT = "invalid_exact_ycash_script"
ERR_YED_INPUT = "invalid_exact_ycash_yed_input"
ERR_YED_NODE_REQUIRED = "invalid_exact_ycash_yed_node_required"
ERR_YED_PAYLOAD = "invalid_exact_ycash_yed_payload"
ERR_YED_VERDICT = "invalid_exact_ycash_yed_verdict"
ERR_YED_UNCONFIRMED_INPUT = "invalid_exact_ycash_yed_unconfirmed_input"
