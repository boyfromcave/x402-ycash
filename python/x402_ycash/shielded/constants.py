"""``sapling-proof``: the client-submitted shielded YEC method of ``exact`` (specs/scheme_exact_ycash.md,
"sapling-proof"; plan §5.9 X4a). Mirrors packages/ycash/src/shielded/constants.ts."""

from __future__ import annotations

import re

from ..constants import YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET

SCHEME_EXACT = "exact"
ASSET_TRANSFER_METHOD_SAPLING_PROOF = "sapling-proof"
ASSET_TRANSFER_METHOD_SAPLING = "sapling"
"""The facilitator-submitted shielded method (plan X4b; x402_ycash.shielded.sapling_facilitator)."""
PAYMENT_FLOW_UPFRONT = "upfront"

MEMO_PREFIX = "x402:"
"""``extra.memo`` is this prefix and the 64-hex request hash."""
MEMO_REGEX = re.compile(r"^x402:[0-9a-f]{64}$")
TXID_REGEX = re.compile(r"^[0-9a-f]{64}$")

DEFAULT_SAPLING_PROOF_CONFIRMATIONS = 1
"""``sapling-proof`` defaults to one confirmation (spec, "Confirmation policy")."""
MIN_CONFIRMATIONS = -1
MAX_CONFIRMATIONS = 20

ANONYMOUS_PAYER = "anonymous"
"""The receipt's ``payer``: the method does not identify payers (spec, "Receipts")."""
OFFER_RECEIPT = "offer-receipt"
"""The ``offer-and-receipt`` extension key."""

SAPLING_HRP: dict[str, str] = {YCASH_MAINNET: "ys", YCASH_TESTNET: "ytestsapling", YCASH_REGTEST: "yregtestsapling"}
"""Sapling address HRPs per network (chainparams.cpp, plan G-2)."""
CHAIN_OF: dict[str, str] = {YCASH_MAINNET: "main", YCASH_TESTNET: "test", YCASH_REGTEST: "regtest"}

ERR_REQUIREMENTS_MISMATCH = "invalid_exact_ycash_requirements_mismatch"
ERR_ASSET_TRANSFER_METHOD = "invalid_exact_ycash_asset_transfer_method"
ERR_PAYMENT_FLOW = "invalid_exact_ycash_payment_flow"
ERR_UNKNOWN_INSTRUMENT = "invalid_exact_ycash_unknown_instrument"
ERR_TXID_MALFORMED = "invalid_exact_ycash_txid_malformed"
ERR_NOT_RECEIVED = "invalid_exact_ycash_not_received"
ERR_MEMO_MISMATCH = "invalid_exact_ycash_memo_mismatch"
ERR_UNDERPAID = "invalid_exact_ycash_underpaid"
ERR_NETWORK_MISMATCH = "network_mismatch"
ERR_SETTLEMENT_PENDING = "settlement_pending"
ERR_DUPLICATE_SETTLEMENT = "duplicate_settlement"
ERR_UNEXPECTED = "unexpected_settle_error"
