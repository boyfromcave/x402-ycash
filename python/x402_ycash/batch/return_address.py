"""The client's return address (specs/scheme_batch_settlement_ycash.md, "``open``"): where every
voucher returns the client's remainder. Without it the remainder would go to the channel key C, which
lives only in the client's channel store and which no wallet watches. Mirrors
packages/ycash/src/batch/returnAddress.ts."""

from __future__ import annotations

from ..constants import ASSET_YED
from ..tx import address_to_script, decode_address, is_yed_kind
from .errors import BatchError, BatchSettlementError


def return_script_of(return_address: str, network: str, asset: str, pay_to_script: bytes) -> bytes:
    """The output script of ``return_address`` for a channel of ``asset`` paying ``pay_to_script``. YEC
    takes a transparent P2PKH, P2SH or post-quantum (``sq…``) address; YED a key-hash holder, P2PKH
    (``s…``, ``yb…``) or TX_PQPKH (the 53-character ``yb…``/``yt…``/``yr…``, or ``sq…``), never P2SH (plan
    Y-8; quantum spec §4). After the node's Falcon height only a scheme-2 TX_PQPKH holds YED (TOK-PQ):
    the node's verdict on the first voucher refuses any other return output then. Never payTo's own
    script: the voucher would then have two server outputs."""
    try:
        kind = decode_address(return_address, network).kind
    except ValueError as e:
        raise BatchSettlementError(BatchError.RETURN_ADDRESS, f"{return_address}: {e}") from e
    if asset == ASSET_YED and kind == "p2sh":
        raise BatchSettlementError(BatchError.RETURN_ADDRESS, "a YED channel returns to a key-hash (P2PKH or post-quantum) address")
    if asset != ASSET_YED and is_yed_kind(kind):
        raise BatchSettlementError(BatchError.RETURN_ADDRESS, "a YEC channel returns to a transparent address, not a YED one")
    script = address_to_script(return_address, network)
    if script == pay_to_script:
        raise BatchSettlementError(BatchError.RETURN_ADDRESS, "the return address is payTo's")
    return script
