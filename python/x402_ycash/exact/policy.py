"""The pure rules of the exact binding: confirmation policy, the expiry window, the requirement
forms. Shared by server and facilitator so the two never disagree (packages/ycash/src/exact/policy.ts)."""

from __future__ import annotations

import math
import re
from typing import Any

from ..constants import (
    ASSET_YEC,
    ASSET_YED,
    BLOCK_SECONDS,
    DUST_ZAT,
    TX_EXPIRING_SOON_THRESHOLD,
    YED_MAX_OUTPUT_CENTS,
    YED_MIN_OUTPUT_CENTS,
    is_ycash_network,
)
from ..tx import decode_address
from .constants import (
    ATM_SAPLING_PROOF,
    ATM_SAPLING_RESERVED,
    ATM_TRANSPARENT,
    FLOW_AUTHORIZATION,
    MAX_CONFIRMATIONS,
    MIN_CONFIRMATIONS,
)

CANONICAL_AMOUNT = re.compile(r"^[1-9][0-9]*$")


def asset_transfer_method_of(extra: dict[str, Any] | None) -> Any:
    """The method a requirement names; absent means ``transparent``."""
    v = (extra or {}).get("assetTransferMethod")
    return ATM_TRANSPARENT if v is None else v


def is_shielded_method(extra: dict[str, Any] | None) -> bool:
    return asset_transfer_method_of(extra) == ATM_SAPLING_PROOF


def is_int(v: Any) -> bool:
    """A JSON integer: bool is an int subclass in Python and must not pass."""
    return isinstance(v, int) and not isinstance(v, bool)


def resolve_confirmation_policy(extra: dict[str, Any] | None, fallback: int) -> int | None:
    """``extra.confirmationPolicy``, a closed object ``{confirmations}`` with an integer in [−1, 20].
    Absent resolves to ``fallback``; malformed to None."""
    value = (extra or {}).get("confirmationPolicy")
    if value is None:
        return fallback
    if not isinstance(value, dict) or list(value.keys()) != ["confirmations"]:
        return None
    n = value["confirmations"]
    if not is_int(n) or not MIN_CONFIRMATIONS <= n <= MAX_CONFIRMATIONS:
        return None
    return n


def confirmations_satisfy(observed: int, required: int) -> bool:
    """Evidence is −1 for a mempool tx and the node's depth (≥ 1) for a mined one, so 0 and 1 both
    need a block, as the spec says."""
    return observed >= required


def timeout_blocks(max_timeout_seconds: int) -> int:
    return math.ceil(max_timeout_seconds / BLOCK_SECONDS)


def client_expiry_height(tip: int, max_timeout_seconds: int) -> int:
    """The client's expiry: tip + 3 + ⌈maxTimeoutSeconds / 75⌉ (Transaction Construction)."""
    return tip + TX_EXPIRING_SOON_THRESHOLD + timeout_blocks(max_timeout_seconds)


def expiry_window(tip: int, max_timeout_seconds: int) -> tuple[int, int]:
    """Rule 8's window, inclusive: tip + 4 ≤ nExpiryHeight ≤ tip + 4 + ⌈maxTimeoutSeconds / 75⌉ + 1.
    The lower bound is the node's relay floor, next block + TX_EXPIRING_SOON_THRESHOLD
    (ycash-dd/src/main.cpp:742, ycash6 :799; plan R-2, X-F8)."""
    lo = tip + 1 + TX_EXPIRING_SOON_THRESHOLD
    return lo, lo + timeout_blocks(max_timeout_seconds) + 1


def check_transparent_yec_requirements(network: str, asset: str, amount: Any, pay_to: str,
                                       max_timeout_seconds: Any) -> str | None:
    """The form checks of a ``transparent`` YEC requirement; a reason, or None when well formed."""
    if not is_ycash_network(network):
        return f"unsupported network {network}"
    if asset != ASSET_YEC:
        return f"asset must be {ASSET_YEC}"
    if not isinstance(amount, str) or not CANONICAL_AMOUNT.match(amount):
        return "amount must be a positive canonical integer"
    if int(amount) < DUST_ZAT:
        return f"amount below the dust threshold of {DUST_ZAT} zatoshis"
    if not is_int(max_timeout_seconds) or max_timeout_seconds <= 0:
        return "maxTimeoutSeconds must be a positive integer"
    try:
        # The network comes from the requirements, never from the address (plan X-F1).
        if decode_address(pay_to, network).kind == "yed":
            return "a YEC payTo must be a transparent address"
    except ValueError as e:
        return f"invalid payTo: {e}"
    return None


def check_transparent_yed_requirements(network: str, asset: str, amount: Any, pay_to: str,
                                       max_timeout_seconds: Any) -> str | None:
    """The form checks of a ``transparent`` YED requirement: ``amount`` in cents in [100, 10,000,000]
    (XFER-1: a smaller YED output burns, ycash-dd/src/yellowback/params.cpp:18-19) and a Yellowback
    ``payTo`` of the requirements' network. A reason, or None."""
    if not is_ycash_network(network):
        return f"unsupported network {network}"
    if asset != ASSET_YED:
        return f"asset must be {ASSET_YED}"
    if not isinstance(amount, str) or not CANONICAL_AMOUNT.match(amount):
        return "amount must be a positive canonical integer"
    if not YED_MIN_OUTPUT_CENTS <= int(amount) <= YED_MAX_OUTPUT_CENTS:
        return (f"a YED amount must be {YED_MIN_OUTPUT_CENTS}..{YED_MAX_OUTPUT_CENTS} cents ($1.00 to $100,000): "
                "a smaller output burns")
    if not is_int(max_timeout_seconds) or max_timeout_seconds <= 0:
        return "maxTimeoutSeconds must be a positive integer"
    try:
        if decode_address(pay_to, network).kind != "yed":
            return "a YED payTo must be a Yellowback (ye…/yt…/yr…) address"
    except ValueError as e:
        return f"invalid payTo: {e}"
    return None


def check_transparent_requirements(network: str, asset: str, amount: Any, pay_to: str, max_timeout_seconds: Any) -> str | None:
    """The form checks of a ``transparent`` requirement of either asset."""
    check = check_transparent_yed_requirements if asset == ASSET_YED else check_transparent_yec_requirements
    return check(network, asset, amount, pay_to, max_timeout_seconds)


def check_transparent_method(extra: dict[str, Any] | None) -> tuple[str, str] | None:
    """Method and flow checks shared by every ``transparent`` party: (reason, message), or None.
    reason is "method", "flow" or "fees"."""
    method = asset_transfer_method_of(extra)
    if method == ATM_SAPLING_RESERVED:
        return "method", "assetTransferMethod sapling is reserved, not yet specified"
    if method != ATM_TRANSPARENT:
        return "method", f"unknown assetTransferMethod {method}"
    extra = extra or {}
    flow = extra.get("paymentFlow")
    if flow is not None and flow != FLOW_AUTHORIZATION:
        return "flow", f"paymentFlow must be absent or {FLOW_AUTHORIZATION} for transparent"
    if "areFeesSponsored" in extra and extra["areFeesSponsored"] is not False:
        return "fees", "areFeesSponsored must be false"
    return None


def json_equal(a: Any, b: Any) -> bool:
    """Deep equality of JSON values that, unlike ``==``, tells true from 1 and 1.0 from 1."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(json_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(json_equal(x, y) for x, y in zip(a, b, strict=True))
    return bool(a == b)
