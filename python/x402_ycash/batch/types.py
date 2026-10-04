"""Wire types of ``batch-settlement`` on Ycash (specs/scheme_batch_settlement_ycash.md, "Payload Types",
"PaymentRequirements", "Settlement"). Mirrors packages/ycash/src/batch/types.ts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from x402.schemas import PaymentRequirements

from ..channel import is_valid_compressed_pubkey
from ..constants import ASSET_YEC, ASSET_YED, YCASH_NETWORKS
from ..exact.policy import is_int, json_equal
from .errors import BatchError, BatchSettlementError

BATCH_SETTLEMENT_SCHEME = "batch-settlement"

_HEX = re.compile(r"^(?:[0-9a-f]{2})+$")
_DECIMAL = re.compile(r"^(0|[1-9][0-9]{0,17})$")
_PUBKEY = re.compile(r"^[0-9a-f]{66}$")


def _is_hex(v: Any) -> bool:
    return isinstance(v, str) and bool(_HEX.match(v))


def _is_decimal(v: Any) -> bool:
    return isinstance(v, str) and bool(_DECIMAL.match(v))


def _voucher_fields(v: dict[str, Any]) -> bool:
    return _is_hex(v.get("tx")) and _is_decimal(v.get("cumulative"))


def is_batch_payload(v: Any) -> bool:
    """``open`` {fundingTx, vout, redeemScript, returnAddress, voucher{tx, cumulative}}; ``voucher``,
    ``close`` and ``claim`` {channelId, tx, cumulative}."""
    if not isinstance(v, dict):
        return False
    t = v.get("type")
    if t == "open":
        voucher = v.get("voucher")
        return (_is_hex(v.get("fundingTx")) and is_int(v.get("vout")) and v["vout"] >= 0 and _is_hex(v.get("redeemScript"))
                and isinstance(v.get("returnAddress"), str) and len(v["returnAddress"]) > 0
                and isinstance(voucher, dict) and _voucher_fields(voucher))
    if t in ("voucher", "close", "claim"):
        return isinstance(v.get("channelId"), str) and _voucher_fields(v)
    return False


@dataclass(frozen=True)
class BatchTerms:
    """The parsed, validated requirements of one channel offer."""

    network: str
    asset: str
    amount: int
    """The per-request ceiling."""
    pay_to: str
    max_timeout_seconds: int
    server_pubkey: bytes
    min_lock_blocks: int
    close_margin_blocks: int
    max_deposit: int
    close_fee: int
    confirmations: int
    """−1 mempool, 0 in a block, N confirmations."""


def _int(v: Any, what: str, lo: int, hi: int) -> int:
    if not is_int(v) or not lo <= v <= hi:
        raise BatchSettlementError(BatchError.REQUIREMENTS, f"extra.{what} must be an integer in [{lo}, {hi}]")
    return int(v)


def _amount(v: Any, what: str) -> int:
    if not _is_decimal(v) or int(v) <= 0:
        raise BatchSettlementError(BatchError.REQUIREMENTS, f"{what} must be a positive decimal string")
    return int(v)


def parse_terms(req: PaymentRequirements) -> BatchTerms:
    """Validates a ``batch-settlement`` requirements entry and returns its terms."""
    if req.scheme != BATCH_SETTLEMENT_SCHEME:
        raise BatchSettlementError(BatchError.REQUIREMENTS, f"scheme {req.scheme}")
    if req.network not in YCASH_NETWORKS:
        raise BatchSettlementError("invalid_network", f"network {req.network}")
    if req.asset not in (ASSET_YEC, ASSET_YED):
        raise BatchSettlementError(BatchError.REQUIREMENTS, f"asset {req.asset}")
    x = req.extra or {}
    spk = x.get("serverPubKey")
    if not isinstance(spk, str) or not _PUBKEY.match(spk) or not is_valid_compressed_pubkey(bytes.fromhex(spk)):
        raise BatchSettlementError(BatchError.REQUIREMENTS, "extra.serverPubKey must be a compressed key in lowercase hex")
    min_lock = _int(x.get("minLockBlocks"), "minLockBlocks", 1, 1_000_000)
    margin = _int(x.get("closeMarginBlocks"), "closeMarginBlocks", 0, min_lock - 1)
    if "areFeesSponsored" in x and x["areFeesSponsored"] is not False:
        raise BatchSettlementError(BatchError.REQUIREMENTS, "extra.areFeesSponsored must be false")
    confirmations = 1
    if "confirmationPolicy" in x:
        policy = x["confirmationPolicy"]
        if not isinstance(policy, dict):
            raise BatchSettlementError(BatchError.REQUIREMENTS, "extra.confirmationPolicy")
        confirmations = _int(policy.get("confirmations"), "confirmationPolicy.confirmations", -1, 20)
    # YED vouchers are only checkable against confirmed token records (plan X-F14).
    if req.asset == ASSET_YED and confirmations < 0:
        raise BatchSettlementError(BatchError.REQUIREMENTS, "YED channels require confirmations ≥ 0")
    return BatchTerms(req.network, req.asset, _amount(req.amount, "amount"), req.pay_to, req.max_timeout_seconds,
                      bytes.fromhex(spk), min_lock, margin, _amount(x.get("maxDeposit"), "extra.maxDeposit"),
                      _amount(x.get("closeFee"), "extra.closeFee"), confirmations)


def required_depth(confirmations: int) -> int:
    """The ``gettxout`` confirmations a policy needs: −1 is mempool acceptance (gettxout reports 0),
    0 means in a block, which is the node's 1 (scheme_exact_ycash.md, "Confirmation policy")."""
    return 0 if confirmations < 0 else max(1, confirmations)


SERVER_EXTRA_FIELDS = ("serverPubKey", "minLockBlocks", "closeMarginBlocks", "maxDeposit", "closeFee", "areFeesSponsored",
                       "confirmationPolicy")
"""The fields of ``accepted`` that must equal the requirements (``exact`` rule 1)."""


def same_offer(accepted: PaymentRequirements, req: PaymentRequirements) -> bool:
    """Envelope rule: ``accepted`` matches the requirements in every field the server declared, with
    JSON-type equality (true is not 1, 1.0 is not 1)."""
    for f in ("scheme", "network", "asset", "amount", "pay_to", "max_timeout_seconds"):
        if not json_equal(getattr(accepted, f), getattr(req, f)):
            return False
    ax, rx = accepted.extra or {}, req.extra or {}
    return all(json_equal(ax.get(k), rx.get(k)) for k in SERVER_EXTRA_FIELDS)
