"""The fee rule (plan S-6, §5.4): fee = max(1000, 500 × max(2, logical actions)).

It meets v4.5.0's DEFAULT_FEE of 1000 zat (ycash-dd/src/policy/fees.h:15) and 6.21.0's ZIP-317
conventional fee, below which ZIP-401 adds an eviction penalty (ycash6/src/zip317.h:16-19,
src/mempool_limit.h:24-25). It is SDK and facilitator policy: neither node enforces it (X-F3).
"""

from __future__ import annotations

from collections.abc import Sequence

from .transaction import Tx

MARGINAL_FEE = 500
GRACE_ACTIONS = 2
MIN_FEE = 1000
"""DEFAULT_FEE on v4.5.0."""
_P2PKH_STANDARD_INPUT_SIZE = 150
_P2PKH_STANDARD_OUTPUT_SIZE = 34


def _ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def logical_actions(tx: Tx) -> int:
    """ZIP-317 logical actions, as ycash6/src/zip317.cpp:24-38 computes them: the larger of the
    transparent input and output sizes in standard-P2PKH units (vector bytes without the count),
    plus 2 per JoinSplit, plus max(Sapling spends, outputs)."""
    size_in = sum(len(i.serialize()) for i in tx.vin)
    size_out = sum(len(o.serialize()) for o in tx.vout)
    return (
        max(_ceil_div(size_in, _P2PKH_STANDARD_INPUT_SIZE), _ceil_div(size_out, _P2PKH_STANDARD_OUTPUT_SIZE))
        + 2 * len(tx.join_splits)
        + max(len(tx.shielded_spends), len(tx.shielded_outputs))
    )


def fee_floor(tx: Tx) -> int:
    """The minimum fee, in zatoshi, the SDK pays and a facilitator requires."""
    return max(MIN_FEE, MARGINAL_FEE * max(GRACE_ACTIONS, logical_actions(tx)))


def tx_fee(tx: Tx, input_values: Sequence[int]) -> int:
    """The fee a tx pays: transparent inputs − outputs, plus the Sapling value balance and the
    JoinSplits' net vpub_new − vpub_old. ``input_values[i]`` is the value of the coin vin[i] spends."""
    if len(input_values) != len(tx.vin):
        raise ValueError("one input value per vin is required")
    fee = tx.value_balance + sum(input_values) - sum(o.value for o in tx.vout)
    for js in tx.join_splits:
        vpub_old = int.from_bytes(js[0:8], "little", signed=True)
        vpub_new = int.from_bytes(js[8:16], "little", signed=True)
        fee += vpub_new - vpub_old
    return fee
