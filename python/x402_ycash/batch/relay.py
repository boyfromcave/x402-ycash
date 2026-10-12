"""Broadcasting a channel transaction (rpcversion 8, the fee structure). A YED channel's funding,
close and refund pay the Yellowback network rate (``yed_getinfo.params.fees.network``), which at a low
YEC price is above the node's -maxtxfee, so the stock sendrawtransaction refuses them as absurdly high.
Their fees are bounded before they get here (a close's is the channel's closeFee, chosen under the
node's cap at the offer; a funding's is checked by verify_open), so a YED channel transaction refused
for its fee is resubmitted with allowhighfees, as the node's own Yellowback paths submit. A YEC channel
transaction never is. Mirrors packages/ycash/src/batch/relay.ts."""

from __future__ import annotations

from typing import Any

from ..node import SendRawTransactionError


async def send_channel_transaction(chain: Any, hex_tx: str, yed: bool) -> str:
    """sendrawtransaction, and for a YED channel transaction refused as absurdly high, once more with allowhighfees."""
    try:
        return str(await chain.send_raw_transaction(hex_tx))
    except SendRawTransactionError as e:
        if yed and e.kind == "absurd-fee":
            return str(await chain.send_raw_transaction(hex_tx, True))
        raise
