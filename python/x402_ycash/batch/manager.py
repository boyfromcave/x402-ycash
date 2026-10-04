"""The resource server's side of a channel (specs/scheme_batch_settlement_ycash.md, "Verification",
"Close triggers", "Settlement"). The server holds S, verifies every voucher before the handler,
charges the actual price after it, and closes by completing its highest voucher. Framework-free: the
x402 scheme (server.py) and the watcher drive it. Mirrors packages/ycash/src/batch/server/manager.ts."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse

from ..channel import Channel, channel_id_of, commitment_id_of, complete_voucher, parse_channel_id
from ..constants import ASSET_YED
from ..node import SendRawTransactionError
from ..store import DEFAULT_CLOSED_RETENTION_MS, ChannelStore, InMemoryChannelStore
from ..tx import OutPoint, address_to_script, parse_tx, pubkey_from_priv, txid
from .errors import BatchError, BatchSettlementError
from .ledger import CHANNEL_OPEN, ChannelLedger, LedgerChannel
from .types import BatchTerms, is_batch_payload, parse_terms, required_depth, same_offer
from .verify import (
    ChainContext,
    ChainView,
    chain_context,
    check_completed,
    check_voucher,
    check_yed_voucher,
    close_cumulative,
    cumulative_floor,
    decode_tx,
    is_exhausted,
    layout_for,
    verify_open,
    yed_chain,
)
from .watcher import ChannelWatcher, WatchedChannel

log = logging.getLogger("x402_ycash.batch")

CloseReason = Literal["idle", "margin", "exhausted", "client", "demand"]
VoucherKind = Literal["open", "voucher", "close"]


@dataclass(frozen=True)
class CloseEvent:
    channel_id: str
    reason: CloseReason
    txid: str | None
    cumulative: int


@dataclass(frozen=True)
class VerifiedVoucher:
    """A voucher that passed verification and holds its channel's in-flight lock until settle or release."""

    kind: VoucherKind
    channel_id: str
    cumulative: int
    ceiling: int
    """The per-request ceiling (``amount``)."""
    token: int
    network: str
    funding_txid: str
    completed_hex: str | None = None
    """The completed close (kind "close")."""


@dataclass(frozen=True)
class ClosedChannel:
    channel_id: str
    reason: CloseReason
    txid: str | None


class ChannelManager:
    def __init__(self, chain: ChainView, server_priv_key: bytes, *, store: ChannelStore | None = None, idle: float = 600.0,
                 funding_wait: float = 0.0, funding_poll: float = 0.5, inflight_ttl_ms: int = 60_000,
                 closed_retention_ms: int = DEFAULT_CLOSED_RETENTION_MS, on_close: Callable[[CloseEvent], None] | None = None) -> None:
        """``chain`` is the server's node (any line; stock is enough for YEC). ``idle`` closes a channel
        after that many seconds without a request; ``funding_wait`` is how long an ``open`` waits for
        the funding depth before answering funding_depth; ``closed_retention_ms`` how long a closed
        channel's records are kept before the store prunes them (default 30 days, plan X-F51)."""
        self.chain = chain
        self._priv = server_priv_key
        self.server_pubkey = pubkey_from_priv(server_priv_key)
        self.ledger = ChannelLedger(store or InMemoryChannelStore(), inflight_ttl_ms, closed_retention_ms)
        self._idle = idle
        self._funding_wait = funding_wait
        self._funding_poll = funding_poll
        self._on_close = on_close
        self._last_activity: dict[str, float] = {}

    def tracked(self) -> list[str]:
        """Channels this process opened, was told to watch, or resumed from the store."""
        return list(self._last_activity)

    def track(self, channel_id: str, now: float | None = None) -> None:
        """Watch a channel recorded by another process (after a restart)."""
        self._last_activity.setdefault(channel_id, time.monotonic() if now is None else now)

    async def resume(self, now: float | None = None) -> list[str]:
        """Re-tracks every open channel in the store: a restarted server keeps closing them."""
        ids = await self.ledger.open_channel_ids()
        for cid in ids:
            self.track(cid, now)
        return ids

    # ------------------------------------------------------------------ verify

    async def verify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifiedVoucher:
        """Every rule before the handler. On success the channel's in-flight lock is held."""
        if payload.x402_version != 2 or not same_offer(payload.accepted, requirements):
            raise BatchSettlementError(BatchError.REQUIREMENTS, "accepted does not match the requirements")
        p = payload.payload
        if not is_batch_payload(p) or p["type"] == "claim":
            raise BatchSettlementError(BatchError.PAYLOAD_TYPE, str(p.get("type") if isinstance(p, dict) else p))
        terms = parse_terms(requirements)
        if terms.asset == ASSET_YED:
            yed_chain(self.chain)  # vouchers are checked by the overlay
        ctx = await chain_context(self.chain, terms.network)
        if p["type"] == "open":
            funding_txid = txid(decode_tx(p["fundingTx"], BatchError.FUNDING))
            known = await self.ledger.get(channel_id_of(OutPoint(funding_txid, int(p["vout"]))))
            if known is not None:
                channel_id = known.terms["channelId"]  # a retried open: its voucher is checked as a voucher
            else:
                v = await verify_open(p, terms, self.chain, ctx)
                channel_id = v.channel_id
                if not v.already_broadcast:
                    await self._relay_funding(p["fundingTx"], v.funding_txid, int(p["vout"]))
                await self.ledger.open({**_terms_of(v.channel, channel_id, p["fundingTx"], terms, v.deposit),
                                        "returnScript": v.return_script.hex()})
                log.info("open %s V=%s D=%s t=%s", channel_id, v.channel.value, v.deposit, v.channel.refund_height)
            self.track(channel_id)
            await self._wait_for_depth(channel_id)
            return await self._verify_voucher("open", channel_id, p["voucher"]["tx"], int(p["voucher"]["cumulative"]), terms, ctx)
        return await self._verify_voucher(p["type"], p["channelId"], p["tx"], int(p["cumulative"]), terms, ctx)

    async def _verify_voucher(self, kind: VoucherKind, channel_id: str, tx_hex: str, cumulative: int, terms: BatchTerms,
                              ctx: ChainContext) -> VerifiedVoucher:
        # 1. known and open
        if parse_channel_id(channel_id) is None:
            raise BatchSettlementError(BatchError.UNKNOWN_CHANNEL, channel_id)
        before = await self.ledger.get(channel_id)
        if before is None:
            raise BatchSettlementError(BatchError.UNKNOWN_CHANNEL, channel_id)
        if before.state != CHANNEL_OPEN:
            raise BatchSettlementError(BatchError.CHANNEL_CLOSING, "the channel is closing or closed")
        _check_same_terms(before, terms)
        channel = _channel_of(before.terms)
        # 2. margin: refuse and close (a client close is still welcome until t)
        margin_height = int(before.terms["refundHeight"]) - int(before.terms["closeMarginBlocks"])
        if kind != "close" and ctx.tip >= margin_height:
            try:
                await self.close(channel_id, "margin")
            except Exception as e:  # noqa: BLE001  # the refusal stands whatever the close did
                log.warning("margin close of %s failed: %s", channel_id, e)
            raise BatchSettlementError(BatchError.CHANNEL_CLOSING, f"tip {ctx.tip} ≥ t − margin = {margin_height}")
        token = await self.ledger.acquire(channel_id)
        if token is None:
            raise BatchSettlementError(BatchError.CHANNEL_BUSY, "another voucher of this channel is in flight")
        try:
            # Read the state again under the lock: a settle may have landed since.
            ch = await self.ledger.get(channel_id)
            assert ch is not None
            if ch.state != CHANNEL_OPEN:
                raise BatchSettlementError(BatchError.CHANNEL_CLOSING, "the channel is closing or closed")
            # 3. unspent, and at the funding policy depth
            out = await self.chain.get_tx_out(channel.outpoint.txid, channel.outpoint.vout, True)
            if not out:
                raise BatchSettlementError(BatchError.CHANNEL_CLOSING, "the channel output is spent")
            if int(out["confirmations"]) < required_depth(int(ch.terms["confirmations"])):
                raise BatchSettlementError(BatchError.FUNDING_DEPTH, f"funding {channel.outpoint.txid} has {out['confirmations']} confirmations")
            tx = decode_tx(tx_hex, BatchError.VOUCHER_SHAPE)
            deposit = int(ch.terms["deposit"])
            asset = ch.terms["asset"]
            bounds: dict[str, Any] = {"deposit": deposit, "branch_id": ctx.branch_id, "layout": layout_for(asset, deposit),
                                      "floor": cumulative_floor(asset)}
            # every voucher returns the client's remainder to the open's returnAddress
            if isinstance(ch.terms.get("returnScript"), str):
                bounds["return_script"] = bytes.fromhex(ch.terms["returnScript"])
            if kind == "close":
                # At the charged total, or the pre-paid $1.00 for YED (the dollar floor).
                want = close_cumulative(asset, ch.charged_cumulative)
                if cumulative != want:
                    raise BatchSettlementError(BatchError.CUMULATIVE_MISMATCH, f"a close must be at {want}")
                check_voucher(tx, channel, cumulative, charged=ch.charged_cumulative, amount=0, **bounds)
            else:
                # 8 (early): a voucher below the stored one is stale whatever else it is
                if cumulative < ch.signed_cumulative:
                    raise BatchSettlementError(BatchError.STALE_VOUCHER, f"{cumulative} < stored {ch.signed_cumulative}")
                # 4–6
                check_voucher(tx, channel, cumulative, charged=ch.charged_cumulative, amount=terms.amount, **bounds)
            # 7. completed with sigS, the node's script verifier accepts it
            completed = await check_completed(self.chain, complete_voucher(tx, channel, self._priv, ctx.branch_id))
            # YED: the overlay registers the completed voucher's split and burns nothing (yedIn = D)
            if asset == ASSET_YED:
                await check_yed_voucher(self.chain, completed, deposit, cumulative)
            # 8. compare-and-set store (a close is broadcast at settle, never stored)
            if kind != "close" and await self.ledger.store_voucher(channel_id, cumulative, tx_hex) == "stale":
                raise BatchSettlementError(BatchError.STALE_VOUCHER, "a higher voucher was stored concurrently")
            self._last_activity[channel_id] = time.monotonic()
            return VerifiedVoucher(kind, channel_id, cumulative, terms.amount, token, terms.network, channel.outpoint.txid,
                                   completed if kind == "close" else None)
        except BaseException:
            await self.ledger.release(channel_id, token)
            raise

    # ------------------------------------------------------------------ settle

    async def settle(self, v: VerifiedVoucher, actual_charge: int) -> SettleResponse:
        """After the handler: charges the actual price (≤ the ceiling) and releases the lock; a client
        ``close`` is broadcast instead. Closes the channel when the next request would not fit."""
        if v.kind == "close":
            return await self._settle_client_close(v)
        try:
            if not 0 <= actual_charge <= v.ceiling:
                raise BatchSettlementError(BatchError.CUMULATIVE_MISMATCH, f"charge {actual_charge} is above the ceiling {v.ceiling}")
            charged = await self.ledger.add_charge(v.channel_id, actual_charge)
        finally:
            await self.ledger.release(v.channel_id, v.token)
        self._last_activity[v.channel_id] = time.monotonic()
        state = await self.channel_state(v.channel_id)
        response = SettleResponse(success=True, transaction=v.funding_txid if v.kind == "open" else "", network=v.network,
                                  payer=v.channel_id, amount="",
                                  extra={"commitmentId": commitment_id_of(v.channel_id, v.cumulative),
                                         "chargedAmount": str(actual_charge), "channelState": state})
        ch = await self.ledger.get(v.channel_id)
        asset = ch.terms["asset"] if ch else ""
        if is_exhausted(asset, int(state["deposit"]), charged, v.ceiling, v.cumulative):
            try:
                await self.close(v.channel_id, "exhausted")
            except Exception as e:  # noqa: BLE001  # the charge stands; a later trigger retries the close
                log.warning("exhausted close of %s failed: %s", v.channel_id, e)
        return response

    async def release(self, v: VerifiedVoucher) -> None:
        """A verified request that will not be settled (the handler failed): charged is unchanged."""
        await self.ledger.release(v.channel_id, v.token)

    async def _settle_client_close(self, v: VerifiedVoucher) -> SettleResponse:
        try:
            if not await self.ledger.claim_close(v.channel_id):
                raise BatchSettlementError(BatchError.CHANNEL_CLOSING, "already closing")
            assert v.completed_hex is not None
            close_txid = await self._broadcast_close(v.channel_id, v.completed_hex)
            if self._on_close:
                self._on_close(CloseEvent(v.channel_id, "client", close_txid, v.cumulative))
            return SettleResponse(success=True, transaction=close_txid or "", network=v.network, payer=v.channel_id, amount="",
                                  extra={"commitmentId": commitment_id_of(v.channel_id, v.cumulative), "chargedAmount": "0",
                                         "channelState": await self.channel_state(v.channel_id)})
        finally:
            await self.ledger.release(v.channel_id, v.token)

    # ------------------------------------------------------------------ close

    async def close(self, channel_id: str, reason: CloseReason = "demand") -> str | None:
        """Completes the highest stored voucher with sigS and broadcasts it. Idempotent: a channel
        already closing or closed returns its close txid (None while another close is running, or when
        the channel was spent by something else, such as the client's refund)."""
        if not await self.ledger.claim_close(channel_id):
            ch = await self.ledger.get(channel_id)
            return ch.close_txid if ch else None
        ch = await self.ledger.get(channel_id)
        if ch is None:
            raise BatchSettlementError(BatchError.UNKNOWN_CHANNEL, channel_id)
        if ch.voucher_tx is None:
            await self.ledger.mark_closed(channel_id, None)
            return None
        channel = _channel_of(ch.terms)
        try:
            ctx = await chain_context(self.chain, ch.terms["network"])
            hex_tx = await check_completed(self.chain, complete_voucher(parse_tx(ch.voucher_tx), channel, self._priv, ctx.branch_id))
        except Exception:
            if not await self.chain.get_tx_out(channel.outpoint.txid, channel.outpoint.vout, True):
                await self.ledger.mark_closed(channel_id, None)  # spent by a refund or an earlier close
                return None
            await self.ledger.reopen(channel_id)
            raise
        close_txid = await self._broadcast_close(channel_id, hex_tx)
        log.info("close %s (%s) at %s: %s", channel_id, reason, ch.signed_cumulative, close_txid or "channel already spent")
        if self._on_close:
            self._on_close(CloseEvent(channel_id, reason, close_txid, ch.signed_cumulative))
        return close_txid

    async def _broadcast_close(self, channel_id: str, hex_tx: str) -> str | None:
        close_txid = txid(bytes.fromhex(hex_tx))
        try:
            await self.chain.send_raw_transaction(hex_tx)
        except Exception as e:
            if not (isinstance(e, SendRawTransactionError) and e.kind == "already-in-chain"):
                ch = await self.ledger.get(channel_id)
                assert ch is not None
                if not await self.chain.get_tx_out(ch.terms["fundingTxid"], int(ch.terms["vout"]), True):
                    # Spent already: by this very close (resubmission) or by the client's refund.
                    ours = await self.chain.get_tx_out(close_txid, 0, True)
                    await self.ledger.mark_closed(channel_id, close_txid if ours else None)
                    return close_txid if ours else None
                await self.ledger.reopen(channel_id)
                raise
        await self.ledger.mark_closed(channel_id, close_txid)
        return close_txid

    async def sweep(self, tip: int | None = None, now: float | None = None) -> list[ClosedChannel]:
        """Runs the close triggers for every tracked open channel: margin (tip ≥ t − margin) and idle."""
        height = await self.chain.get_block_count() if tip is None else tip
        now = time.monotonic() if now is None else now
        closed: list[ClosedChannel] = []
        for cid in self.tracked():
            ch = await self.ledger.get(cid)
            if ch is None or ch.state != CHANNEL_OPEN:
                self._last_activity.pop(cid, None)
                continue
            reason: CloseReason | None = None
            if height >= int(ch.terms["refundHeight"]) - int(ch.terms["closeMarginBlocks"]):
                reason = "margin"
            elif now - self._last_activity.get(cid, now) >= self._idle:
                reason = "idle"
            if reason:
                closed.append(ClosedChannel(cid, reason, await self.close(cid, reason)))
        return closed

    def watcher(self, poll: float = 15.0, warn: Callable[[str], None] | None = None) -> ChannelWatcher:
        """The server's watcher: closes at t − margin, and sweeps idle channels each tick. The first
        tick re-tracks the store's open channels (tracked() is in memory only)."""
        resumed = False

        async def channels() -> list[WatchedChannel]:
            nonlocal resumed
            if not resumed:
                await self.resume()
                resumed = True
            out: list[WatchedChannel] = []
            for cid in self.tracked():
                ch = await self.ledger.get(cid)
                if ch is not None and ch.state == CHANNEL_OPEN:
                    out.append(WatchedChannel(cid, int(ch.terms["refundHeight"]), int(ch.terms["closeMarginBlocks"])))
            return out

        async def on_margin(ch: WatchedChannel, tip: int) -> None:
            _ = tip
            await self.close(ch.channel_id, "margin")

        async def on_tick(tip: int) -> None:
            await self.sweep(tip)

        return ChannelWatcher(self.chain.get_block_count, channels, on_margin, on_tick, warn, poll)

    async def channel_state(self, channel_id: str) -> dict[str, Any]:
        """``channelState`` of a settle response or a corrective 402."""
        ch = await self.ledger.get(channel_id)
        if ch is None:
            raise BatchSettlementError(BatchError.UNKNOWN_CHANNEL, channel_id)
        return {"channelId": channel_id, "deposit": ch.terms["deposit"], "chargedCumulative": str(ch.charged_cumulative),
                "signedCumulative": str(ch.signed_cumulative), "refundHeight": ch.terms["refundHeight"],
                "closeMarginBlocks": ch.terms["closeMarginBlocks"]}

    # ------------------------------------------------------------------ helpers

    async def _relay_funding(self, hex_tx: str, funding_txid: str, vout: int) -> None:
        try:
            await self.chain.send_raw_transaction(hex_tx)
        except Exception as e:
            if isinstance(e, SendRawTransactionError) and e.kind == "already-in-chain":
                return
            if await self.chain.get_tx_out(funding_txid, vout, True):
                return
            raise BatchSettlementError(BatchError.FUNDING, f"relay failed: {e}") from e

    async def _wait_for_depth(self, channel_id: str) -> None:
        ch = await self.ledger.get(channel_id)
        assert ch is not None
        want = required_depth(int(ch.terms["confirmations"]))
        deadline = time.monotonic() + self._funding_wait
        while True:
            out = await self.chain.get_tx_out(ch.terms["fundingTxid"], int(ch.terms["vout"]), True)
            if out and int(out["confirmations"]) >= want:
                return
            if time.monotonic() >= deadline:
                have = out["confirmations"] if out else "no"
                raise BatchSettlementError(BatchError.FUNDING_DEPTH, f"funding {ch.terms['fundingTxid']} has {have} confirmations, {want} required")
            await asyncio.sleep(self._funding_poll)


def _terms_of(ch: Channel, channel_id: str, funding_tx: str, t: BatchTerms, deposit: int) -> dict[str, Any]:
    """The channel's fixed terms, JSON (integers of unbounded size as decimal strings)."""
    return {"channelId": channel_id, "network": t.network, "asset": t.asset, "fundingTxid": ch.outpoint.txid, "vout": ch.outpoint.vout,
            "fundingTx": funding_tx, "redeemScript": ch.redeem_script.hex(), "value": str(ch.value), "closeFee": str(ch.close_fee),
            "deposit": str(deposit), "payTo": t.pay_to, "refundHeight": ch.refund_height, "closeMarginBlocks": t.close_margin_blocks,
            "confirmations": t.confirmations, "amount": str(t.amount)}


def _channel_of(t: dict[str, Any]) -> Channel:
    return Channel.from_script(OutPoint(t["fundingTxid"], int(t["vout"])), bytes.fromhex(t["redeemScript"]), int(t["value"]),
                               int(t["closeFee"]), address_to_script(t["payTo"], t["network"]))


def _check_same_terms(ch: LedgerChannel, t: BatchTerms) -> None:
    """A voucher is checked under the terms the channel was opened with."""
    if ch.terms["network"] != t.network or ch.terms["asset"] != t.asset or ch.terms["payTo"] != t.pay_to \
            or int(ch.terms["closeFee"]) != t.close_fee:
        raise BatchSettlementError(BatchError.REQUIREMENTS, "the requirements differ from the channel's terms")


