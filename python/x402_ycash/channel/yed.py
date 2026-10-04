"""The YED channel (specs/scheme_batch_settlement_ycash.md, "YED Channels"; plan §5.8, X3): the YEC
channel's script and spends, with a Yellowback TRANSFER on every spend, because a YED spend without
one burns (plan Y-4; ycash-dd/src/yellowback/state.cpp:860-865, same on ycash6). Mirrors
packages/ycash/src/channel/yed.ts.

    funding  a TRANSFER assigning D cents to the P2SH output, whose YEC value is
             V = 2 × TOKEN_VALUE + closeFee (plan Y-12)
    voucher  vout 0 payTo TOKEN_VALUE, vout 1 client TOKEN_VALUE, vout 2 the TRANSFER of the split
    refund   the CLTV branch, a TRANSFER assigning all of D to the client's output
"""

from __future__ import annotations

from collections.abc import Sequence

from ..constants import TOKEN_VALUE_ZAT
from ..tx import Tx, TxOut, p2pkh_hash
from ..yed import Assignment, yed_channel_split
from ..yed.build import BuiltYedTransfer, TokenCoin, TransferRecipient, YecCoin, build_yed_transfer
from ..yed.script import transfer_op_return_script
from .builders import Channel, VoucherLayout, build_refund
from .script import channel_script_pubkey

YED_SERVER_VOUT = 0
YED_CLIENT_VOUT = 1
YED_TRANSFER_VOUT = 2


def yed_channel_value(close_fee: int) -> int:
    """V of a YED channel: the two voucher outputs' YEC plus the close fee."""
    return 2 * TOKEN_VALUE_ZAT + close_fee


def yed_voucher_assignments(deposit_cents: int, cumulative: int) -> list[Assignment]:
    """The voucher's TRANSFER at ``cumulative`` out of D: serverCents to the server's vout, clientCents
    to the client's, omitted when 0 (the dollar floor, X-7). Σ = D, so nothing burns."""
    split = yed_channel_split(deposit_cents, cumulative)
    a = [Assignment(YED_SERVER_VOUT, split.server_cents)]
    if split.client_cents > 0:
        a.append(Assignment(YED_CLIENT_VOUT, split.client_cents))
    return a


def yed_voucher_layout(deposit_cents: int) -> VoucherLayout:
    """The YED voucher layout of a channel holding D cents. Constant shape (three outputs whatever the
    split), so the fee is always V − 2 × TOKEN_VALUE = closeFee. Refuses a client script that is
    missing, not P2PKH or payTo's, or a cumulative that breaks the dollar floor."""

    def layout(channel: Channel, cumulative: int, client_script: bytes | None) -> list[TxOut]:
        if channel.value != yed_channel_value(channel.close_fee):
            raise ValueError(f"a YED channel's value must be 2 × TOKEN_VALUE + closeFee = {yed_channel_value(channel.close_fee)}, "
                             f"not {channel.value}")
        if client_script is None:
            raise ValueError("a YED voucher always has a client output script")
        # A YED holder is a key hash: there is no P2SH Yellowback address (plan Y-8).
        if p2pkh_hash(client_script) is None:
            raise ValueError("a YED voucher returns the client's YED to a P2PKH script")
        if client_script == channel.pay_to_script:
            raise ValueError("the client output must not pay payTo")
        return [TxOut(TOKEN_VALUE_ZAT, channel.pay_to_script), TxOut(TOKEN_VALUE_ZAT, client_script),
                TxOut(0, transfer_op_return_script(yed_voucher_assignments(deposit_cents, cumulative)))]

    return layout


def build_yed_funding_tx(redeem_script: bytes, deposit_cents: int, close_fee: int, tokens: Sequence[TokenCoin],
                         yec_coins: Sequence[YecCoin], yed_change_script: bytes, yec_change_script: bytes,
                         expiry_height: int = 0) -> BuiltYedTransfer:
    """The unsigned funding TRANSFER: vout 0 the channel's P2SH output carrying V and assigned D, then
    the YED change, the OP_RETURN and YEC change. The SDK builds it: there is no P2SH ``ye…`` address
    and ``yed_send`` refuses one (plan Y-8). Sign it with channel.sign_funding_tx(tx, inputs, …)."""
    return build_yed_transfer([TransferRecipient(channel_script_pubkey(redeem_script), deposit_cents, yed_channel_value(close_fee))],
                              tokens, yec_coins, yed_change_script, yec_change_script, expiry_height)


def build_yed_refund(channel: Channel, deposit_cents: int, client_priv: bytes, to_script: bytes, branch_id: int,
                     lock_time: int | None = None, fee: int | None = None) -> Tx:
    """The client's refund of a YED channel: the CLTV branch with a TRANSFER assigning all of D to it.
    build_refund puts the extra outputs first, so the client's output is vout 1."""
    op_return = TxOut(0, transfer_op_return_script([Assignment(1, deposit_cents)]))
    return build_refund(channel, client_priv, to_script, branch_id, lock_time, fee, [op_return])
