"""The overlay's transfer rules and the YED dollar floor, as a builder and a verifier must apply
them before a TRANSFER is signed or accepted. A transaction that breaks any of them burns YED, and
burns are final.

Sources: XFER-1 (ycash-dd/src/yellowback/params.cpp:18-19, state.cpp:447-449), XFER-2 and the
partial-assignment burn (state.cpp:450-473), FindPayload (payload.cpp:416-430); the dollar floor is
plan X-7.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ..constants import YED_MAX_OUTPUT_CENTS, YED_MIN_OUTPUT_CENTS
from .payload import MAX_ASSIGNMENTS, Assignment


@dataclass(frozen=True)
class TransferValidation:
    valid: bool
    total_cents: int = 0
    error: str | None = None
    """no_assignments, too_many_assignments, vout_not_u8, vout_out_of_range, vout_is_op_return,
    duplicate_vout, cents_out_of_range (XFER-1), over_assigned (XFER-2), under_assigned (burns the rest)."""
    assignment: int | None = None


def validate_transfer_assignments(
    assignments: Sequence[Assignment],
    output_count: int,
    op_return_index: int,
    yed_in_cents: int | None = None,
) -> TransferValidation:
    """Checks a TRANSFER's assignments against the transaction it will sit in. Valid means the
    overlay registers every assigned cent (verdict OK) and, with ``yed_in_cents``, that nothing burns."""

    def fail(error: str, i: int | None = None) -> TransferValidation:
        return TransferValidation(False, error=error, assignment=i)

    if not assignments:
        return fail("no_assignments")
    if len(assignments) > MAX_ASSIGNMENTS:
        return fail("too_many_assignments")
    seen: set[int] = set()
    total = 0
    for i, a in enumerate(assignments):
        if not 0 <= a.vout <= 0xFF:
            return fail("vout_not_u8", i)
        if a.vout >= output_count:
            return fail("vout_out_of_range", i)
        if a.vout == op_return_index:
            return fail("vout_is_op_return", i)
        if a.vout in seen:
            return fail("duplicate_vout", i)
        seen.add(a.vout)
        if not YED_MIN_OUTPUT_CENTS <= a.cents <= YED_MAX_OUTPUT_CENTS:
            return fail("cents_out_of_range", i)
        total += a.cents
    if yed_in_cents is not None:
        if total > yed_in_cents:
            return fail("over_assigned")
        if total < yed_in_cents:
            return fail("under_assigned")
    return TransferValidation(True, total_cents=total)


@dataclass(frozen=True)
class YedChannelSplit:
    server_cents: int
    client_cents: int
    """0 means the voucher has no client output."""


def _deposit_ok(deposit_cents: int) -> bool:
    return isinstance(deposit_cents, int) and YED_MIN_OUTPUT_CENTS <= deposit_cents <= YED_MAX_OUTPUT_CENTS


def is_valid_yed_voucher_cumulative(deposit_cents: int, cumulative_cents: int) -> bool:
    """True when ``cumulative_cents`` is an integer in [$1.00, deposit] of a deposit inside XFER-1."""
    return _deposit_ok(deposit_cents) and isinstance(cumulative_cents, int) and (
        YED_MIN_OUTPUT_CENTS <= cumulative_cents <= deposit_cents)


def yed_channel_split(deposit_cents: int, cumulative_cents: int) -> YedChannelSplit:
    """The TRANSFER assignments of a YED voucher at ``cumulative_cents`` out of ``deposit_cents``:
    server + client always equals the deposit, so nothing burns. A client remainder in
    (0, $1.00) goes to the server, since no YED output can hold less than $1.00."""
    if not _deposit_ok(deposit_cents):
        raise ValueError(f"channel deposit {deposit_cents} cents is outside [{YED_MIN_OUTPUT_CENTS}, {YED_MAX_OUTPUT_CENTS}]")
    if not isinstance(cumulative_cents, int):
        raise ValueError(f"cumulative {cumulative_cents} is not an integer")
    if cumulative_cents < YED_MIN_OUTPUT_CENTS:
        raise ValueError(f"cumulative {cumulative_cents} cents is below the $1.00 floor")
    if cumulative_cents > deposit_cents:
        raise ValueError(f"cumulative {cumulative_cents} cents exceeds the deposit {deposit_cents}")
    remainder = deposit_cents - cumulative_cents
    if remainder < YED_MIN_OUTPUT_CENTS:
        return YedChannelSplit(deposit_cents, 0)
    return YedChannelSplit(cumulative_cents, remainder)
