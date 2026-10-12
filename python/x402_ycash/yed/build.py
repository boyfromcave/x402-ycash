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
from ..pq import max_script_sig_size_of
from ..tx import NetworkFees, OutPoint, Tx, TxIn, TxOut, network_fee
from .payload import Assignment
from .rules import validate_transfer_assignments
from .script import transfer_op_return_script


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
                       yed_change_script: bytes, yec_change_script: bytes, expiry_height: int = 0,
                       falcon_active: bool | None = None, network_fees: NetworkFees | None = None) -> BuiltYedTransfer:
    """Recipients at vouts 0..n−1, the YED change (if any) next, then the OP_RETURN, then YEC change
    (if not dust). Every cent of yedIn is assigned; the fee is the floor of the tx with signatures
    at their largest. Raises when the coins cannot pay. With ``falcon_active`` (whether the node's
    Falcon height applies to the next block) every recipient and the YED change must be a valid
    holder then: a Falcon TX_PQPKH from F (TOK-PQ), no scheme-2 output below it; refused before
    anything is signed. With ``network_fees`` (``yed_getinfo.params.fees.network``, rpcversion 8) the
    fee is the Yellowback rate by size, capped (network_fee), instead of the S-6 floor."""
    if not recipients:
        raise ValueError("a transfer needs a recipient")
    yed_in = sum(t.cents for t in tokens)
    change_cents = yed_in - sum(r.cents for r in recipients)
    if not _valid_change(change_cents):
        raise ValueError(f"YED change {change_cents} cents would burn (it must be 0 or {YED_MIN_OUTPUT_CENTS}..{YED_MAX_OUTPUT_CENTS})")
    if falcon_active is not None:
        from ..channel.falcon import yed_holder_problem  # here: channel imports this module

        for n, r in enumerate(recipients):
            if problem := yed_holder_problem(r.script_pubkey, falcon_active):
                raise ValueError(f"YED recipient {n}: {problem}")
        if change_cents > 0 and (problem := yed_holder_problem(yed_change_script, falcon_active)):
            raise ValueError(f"the YED change: {problem}")
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
        # sized by each coin's script: a TX_PQPKH token coin (a node wallet's post-quantum holder) spends with an ≈ 8 KB scriptSig
        return Tx(vin=[TxIn(c.outpoint, bytes(max_script_sig_size_of(c.script_pubkey))) for c in inputs], vout=vout, expiry_height=expiry_height)

    for n in range(len(yec) + 1):
        inputs = [*token_inputs, *yec[:n]]
        total = sum(c.value for c in inputs)
        fee_with = network_fee(draft(inputs, [*assigned, op_return, TxOut(1, yec_change_script)]), "yellowback", network_fees)
        vout: list[TxOut] | None = None
        fee = 0
        if total >= out_value + fee_with + DUST_ZAT:
            fee = fee_with
            vout = [*assigned, op_return, TxOut(total - out_value - fee_with, yec_change_script)]
        elif total >= out_value + network_fee(draft(inputs, [*assigned, op_return]), "yellowback", network_fees):
            fee = total - out_value  # a sub-dust remainder pays the fee
            vout = [*assigned, op_return]
        if vout is not None:
            tx = draft(inputs, vout)
            for i in tx.vin:
                i.script_sig = b""
            return BuiltYedTransfer(tx, inputs, assignments, op_return_index, change_cents, fee)
    have = sum(c.value for c in [*token_inputs, *yec])
    raise ValueError(f"insufficient YEC: {have} zatoshis cannot pay {out_value} for the YED outputs plus the fee")
