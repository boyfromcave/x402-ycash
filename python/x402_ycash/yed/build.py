"""Building a TRANSFER that never burns: token coin selection under the dollar floor, YEC coins for
the outputs' value and the fee, and the unsigned v4 transaction with its payload. Used by the YED
channel's funding transaction (specs/scheme_batch_settlement_ycash.md, "YED Channels"). Mirrors
packages/ycash/src/yed/build.ts.

The node's own wallet builder is the model (ycash-dd/src/yellowback/txbuilder.cpp:365-370, same on
ycash6): token inputs confirmed only, each YED output carrying TOKEN_VALUE (params.h:78), every cent
of yedIn assigned.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ..constants import DUST_ZAT, TOKEN_VALUE_ZAT, YED_MAX_OUTPUT_CENTS, YED_MIN_OUTPUT_CENTS
from ..tx import OutPoint, Tx, TxIn, TxOut, fee_floor
from .payload import Assignment
from .rules import validate_transfer_assignments
from .script import transfer_op_return_script

_MAX_P2PKH_SCRIPTSIG = 1 + 73 + 1 + 33
"""A P2PKH scriptSig at its largest: push(72-byte DER + hash type) + push(33-byte key)."""


@dataclass(frozen=True)
class YecCoin:
    """A confirmed plain-YEC output (no token record), or any input with its value and script."""

    outpoint: OutPoint
    value: int
    script_pubkey: bytes


@dataclass(frozen=True)
class TokenCoin:
    """A confirmed output holding YED (a token record: ``yed_listtokens``)."""

    outpoint: OutPoint
    cents: int
    value: int
    """The output's YEC value, zatoshis."""
    script_pubkey: bytes


@dataclass(frozen=True)
class TokenSelection:
    coins: list[TokenCoin]
    change_cents: int
    """yedIn − amount: 0, or in [100, 10,000,000]."""


def _valid_change(c: int) -> bool:
    return c == 0 or YED_MIN_OUTPUT_CENTS <= c <= YED_MAX_OUTPUT_CENTS


def select_token_coins(tokens: Sequence[TokenCoin], amount_cents: int) -> TokenSelection:
    """Token coins for ``amount_cents`` whose change is 0 or a valid YED output (XFER-1). An exact
    single coin first, then largest-first; a sub-dollar change is cured by one more coin. Raises
    rather than return a burning selection."""
    if not YED_MIN_OUTPUT_CENTS <= amount_cents <= YED_MAX_OUTPUT_CENTS:
        raise ValueError(f"a YED amount must be {YED_MIN_OUTPUT_CENTS}..{YED_MAX_OUTPUT_CENTS} cents: {amount_cents}")
    exact = next((t for t in tokens if t.cents == amount_cents), None)
    if exact is not None:
        return TokenSelection([exact], 0)
    ordered = sorted(tokens, key=lambda t: -t.cents)
    picked: list[TokenCoin] = []
    for i, t in enumerate(ordered):
        picked.append(t)
        change = sum(c.cents for c in picked) - amount_cents
        if change < 0:
            continue
        if _valid_change(change):
            return TokenSelection(picked, change)
        rest = ordered[i + 1:]
        if rest and _valid_change(change + rest[-1].cents):
            return TokenSelection([*picked, rest[-1]], change + rest[-1].cents)
        break
    total = sum(t.cents for t in tokens)
    if total < amount_cents:
        raise ValueError(f"insufficient YED: {total} cents in {len(tokens)} confirmed token outputs, need {amount_cents}")
    raise ValueError(f"no selection of {len(tokens)} token outputs pays {amount_cents} cents without a change below $1.00 (it would burn)")


@dataclass(frozen=True)
class TransferRecipient:
    script_pubkey: bytes
    cents: int
    value: int = TOKEN_VALUE_ZAT


@dataclass(frozen=True)
class BuiltYedTransfer:
    tx: Tx
    """Unsigned: every scriptSig empty. Token inputs first, then YEC inputs."""
    inputs: list[YecCoin]
    """The coin each vin spends, in vin order (value and script for the sighash)."""
    assignments: list[Assignment]
    op_return_index: int
    change_cents: int
    fee: int


def build_yed_transfer(recipients: Sequence[TransferRecipient], tokens: Sequence[TokenCoin], yec_coins: Sequence[YecCoin],
                       yed_change_script: bytes, yec_change_script: bytes, expiry_height: int = 0) -> BuiltYedTransfer:
    """Recipients at vouts 0..n−1, the YED change (if any) next, then the OP_RETURN, then YEC change
    (if not dust). Every cent of yedIn is assigned; the fee is the floor of the tx with signatures
    at their largest. Raises when the coins cannot pay."""
    if not recipients:
        raise ValueError("a transfer needs a recipient")
    yed_in = sum(t.cents for t in tokens)
    change_cents = yed_in - sum(r.cents for r in recipients)
    if not _valid_change(change_cents):
        raise ValueError(f"YED change {change_cents} cents would burn (it must be 0 or {YED_MIN_OUTPUT_CENTS}..{YED_MAX_OUTPUT_CENTS})")
    assigned = [TxOut(r.value, r.script_pubkey) for r in recipients]
    assignments = [Assignment(n, r.cents) for n, r in enumerate(recipients)]
    if change_cents > 0:
        assignments.append(Assignment(len(assigned), change_cents))
        assigned.append(TxOut(TOKEN_VALUE_ZAT, yed_change_script))
    op_return_index = len(assigned)
    op_return = TxOut(0, transfer_op_return_script(assignments))
    check = validate_transfer_assignments(assignments, len(assigned) + 1, op_return_index, yed_in)
    if not check.valid:
        raise ValueError(f"the transfer would burn: {check.error}")

    token_inputs = [YecCoin(t.outpoint, t.value, t.script_pubkey) for t in tokens]
    out_value = sum(o.value for o in assigned)
    yec = sorted(yec_coins, key=lambda c: -c.value)

    def draft(inputs: Sequence[YecCoin], vout: list[TxOut]) -> Tx:
        return Tx(vin=[TxIn(c.outpoint, bytes(_MAX_P2PKH_SCRIPTSIG)) for c in inputs], vout=vout, expiry_height=expiry_height)

    for n in range(len(yec) + 1):
        inputs = [*token_inputs, *yec[:n]]
        total = sum(c.value for c in inputs)
        fee_with = fee_floor(draft(inputs, [*assigned, op_return, TxOut(1, yec_change_script)]))
        vout: list[TxOut] | None = None
        fee = 0
        if total >= out_value + fee_with + DUST_ZAT:
            fee = fee_with
            vout = [*assigned, op_return, TxOut(total - out_value - fee_with, yec_change_script)]
        elif total >= out_value + fee_floor(draft(inputs, [*assigned, op_return])):
            fee = total - out_value  # a sub-dust remainder pays the fee
            vout = [*assigned, op_return]
        if vout is not None:
            tx = draft(inputs, vout)
            for i in tx.vin:
                i.script_sig = b""
            return BuiltYedTransfer(tx, inputs, assignments, op_return_index, change_cents, fee)
    have = sum(c.value for c in [*token_inputs, *yec])
    raise ValueError(f"insufficient YEC: {have} zatoshis cannot pay {out_value} for the YED outputs plus the fee")
