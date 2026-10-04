"""The server's channel ledger, kept in the shared ChannelStore with nothing but its atomic operations
(open = create-if-absent, compare_and_set_cumulative), so a SqliteChannelStore works across processes.
One channel is several records (packages/ycash/src/batch/server/ledger.ts):

    <id>            cumulative = the stored (highest) voucher's cumulative; data = the channel terms
    <id>@<cum>      the stored voucher's hex (data.tx); the previous one is deleted on each advance
    <id>#charged    cumulative = the charged total
    <id>#inflight   cumulative = 0 when free, else the lock's expiry (ms): one voucher in flight
    <id>#state      cumulative = 0 open, 1 closing, 2 closed
    <id>#close      data.txid = the close transaction

A closed channel's records are retired for ``closed_retention_ms`` and then pruned by the store (plan
X-F51), so list() and resume() stay as fast as the open channels; an open or closing channel is never
retired.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal

from ..store import DEFAULT_CLOSED_RETENTION_MS, ChannelRecord, ChannelStore

CHANNEL_OPEN = 0
CHANNEL_CLOSING = 1
CHANNEL_CLOSED = 2


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class LedgerChannel:
    terms: dict[str, Any]
    """The channel's fixed terms (JSON: channelId, network, asset, fundingTxid, vout, fundingTx,
    redeemScript, value, closeFee, deposit, payTo, refundHeight, closeMarginBlocks, confirmations, amount,
    returnScript: the client's output script in every voucher, hex, from the open's ``returnAddress``)."""
    signed_cumulative: int
    charged_cumulative: int
    state: int
    voucher_tx: str | None
    close_txid: str | None


class ChannelLedger:
    def __init__(self, store: ChannelStore, inflight_ttl_ms: int = 60_000, closed_retention_ms: int = DEFAULT_CLOSED_RETENTION_MS) -> None:
        self.store = store
        self._ttl = inflight_ttl_ms
        self._retention = closed_retention_ms

    async def open(self, terms: dict[str, Any]) -> bool:
        """Records a new channel; False if it is already known. Auxiliary records first: a reader that
        finds the main record finds them too."""
        cid = terms["channelId"]
        await self.store.open(ChannelRecord(f"{cid}#charged", 0))
        await self.store.open(ChannelRecord(f"{cid}#inflight", 0))
        await self.store.open(ChannelRecord(f"{cid}#state", CHANNEL_OPEN))
        return await self.store.open(ChannelRecord(cid, 0, dict(terms)))

    async def get(self, channel_id: str) -> LedgerChannel | None:
        main = await self.store.get(channel_id)
        if main is None or not main.data:
            return None
        charged = await self.store.get(f"{channel_id}#charged")
        state = await self.store.get(f"{channel_id}#state")
        voucher = await self.store.get(f"{channel_id}@{main.cumulative}") if main.cumulative > 0 else None
        close = await self.store.get(f"{channel_id}#close")
        vtx = (voucher.data or {}).get("tx") if voucher else None
        ctx = (close.data or {}).get("txid") if close else None
        return LedgerChannel(main.data, main.cumulative, charged.cumulative if charged else 0,
                             state.cumulative if state else CHANNEL_OPEN,
                             vtx if isinstance(vtx, str) else None, ctx if isinstance(ctx, str) else None)

    async def open_channel_ids(self) -> list[str]:
        """The ids of every channel still open (main records only: ids carry no ``#`` or ``@``)."""
        out: list[str] = []
        for cid in await self.store.list():
            if "#" in cid or "@" in cid:
                continue
            state = await self.store.get(f"{cid}#state")
            if state is not None and state.cumulative == CHANNEL_OPEN:
                out.append(cid)
        return out

    async def acquire(self, channel_id: str, now: int | None = None) -> int | None:
        """Takes the channel's in-flight lock; returns its token, or None when another voucher holds it.
        A stale lock (its holder crashed) is taken over by the same compare-and-set."""
        now = now_ms() if now is None else now
        key = f"{channel_id}#inflight"
        r = await self.store.get(key)
        if r is None or (r.cumulative != 0 and r.cumulative > now):
            return None
        token = now + self._ttl
        if token == r.cumulative:
            token += 1
        return token if await self.store.compare_and_set_cumulative(key, r.cumulative, token) else None

    async def release(self, channel_id: str, token: int) -> None:
        """Gives the lock back; a no-op when it expired and someone else took it."""
        await self.store.compare_and_set_cumulative(f"{channel_id}#inflight", token, 0)

    async def store_voucher(self, channel_id: str, cumulative: int, tx_hex: str) -> Literal["stored", "stale"]:
        """Voucher rule 8: stores the voucher only if its cumulative is at least the stored one's (the
        same cumulative must be the same voucher)."""
        while True:
            main = await self.store.get(channel_id)
            if main is None:
                raise KeyError(f"unknown channel {channel_id}")
            stored = main.cumulative
            if cumulative < stored:
                return "stale"
            key = f"{channel_id}@{cumulative}"
            if not await self.store.open(ChannelRecord(key, cumulative, {"tx": tx_hex})):
                existing = await self.store.get(key)
                if existing is None or (existing.data or {}).get("tx") != tx_hex:
                    return "stale"
            if cumulative == stored:
                return "stored"
            if await self.store.compare_and_set_cumulative(channel_id, stored, cumulative):
                if stored > 0:
                    await self.store.delete(f"{channel_id}@{stored}")
                return "stored"

    async def add_charge(self, channel_id: str, charge: int) -> int:
        """Adds a charge to the charged total; returns the new total."""
        key = f"{channel_id}#charged"
        while True:
            r = await self.store.get(key)
            if r is None:
                raise KeyError(f"unknown channel {channel_id}")
            if await self.store.compare_and_set_cumulative(key, r.cumulative, r.cumulative + charge):
                return r.cumulative + charge

    async def claim_close(self, channel_id: str) -> bool:
        """Moves the channel from open to closing; False if it was not open (one closer wins)."""
        return await self.store.compare_and_set_cumulative(f"{channel_id}#state", CHANNEL_OPEN, CHANNEL_CLOSING)

    async def mark_closed(self, channel_id: str, txid: str | None, now: int | None = None) -> None:
        """Records the close transaction, marks the channel closed and retires its records."""
        if txid:
            await self.store.open(ChannelRecord(f"{channel_id}#close", 0, {"txid": txid}))
        state = await self.store.get(f"{channel_id}#state")
        if state is not None and state.cumulative != CHANNEL_CLOSED:
            await self.store.compare_and_set_cumulative(f"{channel_id}#state", state.cumulative, CHANNEL_CLOSED)
        main = await self.store.get(channel_id)
        ids = [channel_id, f"{channel_id}#charged", f"{channel_id}#inflight", f"{channel_id}#state", f"{channel_id}#close"]
        if main is not None and main.cumulative > 0:
            ids.append(f"{channel_id}@{main.cumulative}")
        await self.store.retire(ids, (now_ms() if now is None else now) + self._retention)

    async def reopen(self, channel_id: str) -> bool:
        """Back to open after a close that could not be broadcast (so a later trigger retries)."""
        return await self.store.compare_and_set_cumulative(f"{channel_id}#state", CHANNEL_CLOSING, CHANNEL_OPEN)
