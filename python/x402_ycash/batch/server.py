"""The resource server's ``batch-settlement`` scheme on Ycash, on upstream's SchemeNetworkServer. As in
the SVM binding, the server owns the voucher watermark: its hooks verify locally before the handler
(skipping the facilitator) and commit the actual charge after it. The actual charge is the
settle-time ``requirements.amount``. Mirrors packages/ycash/src/batch/server/scheme.ts.

The hooks are coroutines, so register the scheme on the async ``x402ResourceServer``.
"""

from __future__ import annotations

import re
import weakref
from collections.abc import Mapping
from typing import Any, ClassVar

from x402.interfaces import PaymentFlowConfig, SchemePaymentRequiredContext
from x402.schemas import (
    AbortResult,
    AssetAmount,
    Network,
    PaymentPayload,
    PaymentRequirements,
    Price,
    SettleContext,
    SkipHandlerDirective,
    SkipHandlerResult,
    SkipSettleResult,
    SkipVerifyResult,
    SupportedKind,
    VerifiedPaymentCanceledContext,
    VerifyContext,
    VerifyResponse,
    VerifyResultContext,
)

from ..channel import DEFAULT_CLOSE_FEE, DEFAULT_CLOSE_MARGIN_BLOCKS, DEFAULT_MIN_LOCK_BLOCKS, close_fee_floor
from ..constants import ASSET_YEC, ASSET_YED, YED_MAX_OUTPUT_CENTS
from ..node import yec_to_zat
from ..store import ChannelStore
from ..tx import TxOut
from .errors import BatchError, reason_of
from .manager import ChannelManager, CloseEvent, VerifiedVoucher
from .types import BATCH_SETTLEMENT_SCHEME, is_batch_payload
from .verify import ChainView

_CENTS = re.compile(r"^(\d+)(?:\.(\d{1,2}))?$")
_CANONICAL = re.compile(r"^[1-9][0-9]*$")
# A 115-byte channel script stand-in and the YED close's outputs (the YEC close's plus the TRANSFER of
# two assignments: OP_RETURN, push, 15 payload bytes), for the close-fee floor.
_CLOSE_FLOOR = close_fee_floor(bytes(115), [TxOut(0, bytes(25)), TxOut(0, bytes(25)), TxOut(0, bytes(17))])


def cents_of(s: str) -> str:
    """A decimal dollar amount in whole cents ("0.01" -> "1"); a fraction of a cent is refused."""
    m = _CENTS.match(s.strip())
    if not m:
        raise ValueError(f"a YED price is a whole number of cents: {s}")
    cents = int(m.group(1)) * 100 + int((m.group(2) or "").ljust(2, "0"))
    if cents <= 0:
        raise ValueError("a price must be positive")
    return str(cents)


class BatchYcashServerScheme:
    """``x402ResourceServer().register("ycash:regtest", BatchYcashServerScheme(rpc, server_priv, max_deposit=…))``."""

    scheme = BATCH_SETTLEMENT_SCHEME
    default_asset_transfer_method = "default"
    """The binding has one method, so no on-wire assetTransferMethod."""
    payment_flows: ClassVar[Mapping[str, PaymentFlowConfig]] = {"default": {"supported": ("authorization",), "default": "authorization"}}

    def __init__(self, chain: ChainView, server_priv_key: bytes, *, max_deposit: int, min_lock_blocks: int = DEFAULT_MIN_LOCK_BLOCKS,
                 close_margin_blocks: int = DEFAULT_CLOSE_MARGIN_BLOCKS, close_fee: int = DEFAULT_CLOSE_FEE, confirmations: int = 1,
                 max_deposit_cents: int = YED_MAX_OUTPUT_CENTS, usd_asset: str | None = None, store: ChannelStore | None = None,
                 idle: float = 600.0, funding_wait: float = 0.0, funding_poll: float = 0.5, inflight_ttl_ms: int = 60_000,
                 on_close: Any = None) -> None:
        """``max_deposit`` is the largest D of a YEC channel (zatoshis), ``max_deposit_cents`` of a YED
        one; ``confirmations`` the funding policy depth (−1 = mempool, a YEC-only opt-in);
        ``usd_asset="YED"`` prices "$0.01" as YED cents at par (without it a USD price is refused)."""
        if close_margin_blocks >= min_lock_blocks:
            raise ValueError("close_margin_blocks must be below min_lock_blocks")
        if close_fee < _CLOSE_FLOOR:
            raise ValueError(f"close_fee {close_fee} is below the close's fee floor {_CLOSE_FLOOR}")
        if usd_asset not in (None, ASSET_YED):
            raise ValueError("usd_asset must be YED or None")
        self.max_deposit = max_deposit
        self.max_deposit_cents = max_deposit_cents
        self.min_lock_blocks = min_lock_blocks
        self.close_margin_blocks = close_margin_blocks
        self.close_fee = close_fee
        self.confirmations = confirmations
        self.usd_asset = usd_asset
        self.manager = ChannelManager(chain, server_priv_key, store=store, idle=idle, funding_wait=funding_wait,
                                      funding_poll=funding_poll, inflight_ttl_ms=inflight_ttl_ms, on_close=on_close)
        self._verified: dict[int, tuple[weakref.ref[PaymentPayload], VerifiedVoucher]] = {}

    # ------------------------------------------------------------------ SchemeNetworkServer

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        """YEC: a decimal YEC amount ("0.0002", 0.0002) or an AssetAmount in zatoshis. YED: "0.01 YED",
        "$0.01" with ``usd_asset="YED"``, or an AssetAmount in cents. A YED ceiling may be below $1.00:
        the dollar floor applies to the voucher's cumulative, not to one request (X-7)."""
        if isinstance(price, AssetAmount) or (isinstance(price, dict) and "amount" in price):
            amount, asset = (price.amount, price.asset) if isinstance(price, AssetAmount) else (price["amount"], price.get("asset"))
            if asset not in (ASSET_YEC, ASSET_YED):
                raise ValueError(f"batch-settlement on {network}: asset {asset} is not supported here")
            if not isinstance(amount, str) or not _CANONICAL.match(amount):
                raise ValueError(f"amount must be a positive canonical integer: {amount}")
            return AssetAmount(amount=amount, asset=asset, extra={})
        s = f"{price:.8f}" if isinstance(price, (int, float)) else str(price).strip()
        upper = s.upper()
        yed = upper.endswith("YED") or (self.usd_asset == ASSET_YED and (s.startswith("$") or upper.endswith("USD")))
        if yed:
            return AssetAmount(amount=cents_of(re.sub(r"\s*(YED|USD)$", "", s.lstrip("$"), flags=re.IGNORECASE)), asset=ASSET_YED, extra={})
        if s.startswith("$"):
            raise ValueError("USD prices need a price source; give the price in YEC")
        return AssetAmount(amount=str(yec_to_zat(re.sub(r"\s*YEC$", "", s, flags=re.IGNORECASE))), asset=ASSET_YEC, extra={})

    def enhance_payment_requirements(self, requirements: PaymentRequirements, supported_kind: SupportedKind,
                                     extensions: list[str]) -> PaymentRequirements:
        _ = (supported_kind, extensions)
        yed = requirements.asset == ASSET_YED
        # YED vouchers are checkable only against confirmed token records (plan X-F14).
        if yed and self.confirmations < 0:
            raise ValueError("YED channels require a funding depth of at least 0 (in a block)")
        extra = {**(requirements.extra or {}), "serverPubKey": self.manager.server_pubkey.hex(), "minLockBlocks": self.min_lock_blocks,
                 "closeMarginBlocks": self.close_margin_blocks, "maxDeposit": str(self.max_deposit_cents if yed else self.max_deposit),
                 "closeFee": str(self.close_fee), "areFeesSponsored": False, "confirmationPolicy": {"confirmations": self.confirmations}}
        return requirements.model_copy(update={"extra": extra})

    async def enrich_payment_required_response(self, ctx: SchemePaymentRequiredContext) -> list[PaymentRequirements] | None:
        """The corrective 402 of a cumulative mismatch or a stale voucher carries ``channelState``."""
        if ctx.error not in (BatchError.CUMULATIVE_MISMATCH, BatchError.STALE_VOUCHER) or ctx.payment_payload is None:
            return None
        raw = ctx.payment_payload.payload
        if not is_batch_payload(raw) or raw["type"] in ("open", "claim"):
            return None
        try:
            state = await self.manager.channel_state(raw["channelId"])
        except Exception:  # noqa: BLE001  # an unknown channel gets the plain 402
            return None
        out: list[PaymentRequirements] = []
        found = False
        for r in ctx.requirements:
            if not found and r.scheme == self.scheme and r.network == ctx.payment_payload.accepted.network:
                r = r.model_copy(update={"extra": {**(r.extra or {}), "channelState": state}})
                found = True
            out.append(r)
        return out if found else None

    # ------------------------------------------------------------------ hooks (collected by name by x402ResourceServer)

    def _remember(self, payload: PaymentPayload, v: VerifiedVoucher) -> None:
        self._verified[id(payload)] = (weakref.ref(payload), v)

    def _take(self, payload: PaymentPayload) -> VerifiedVoucher | None:
        entry = self._verified.get(id(payload))
        if entry is None or entry[0]() is not payload:
            return None
        del self._verified[id(payload)]
        return entry[1]

    def _peek(self, payload: PaymentPayload) -> VerifiedVoucher | None:
        entry = self._verified.get(id(payload))
        return entry[1] if entry is not None and entry[0]() is payload else None

    async def before_verify(self, ctx: VerifyContext) -> SkipVerifyResult | AbortResult | None:
        if ctx.requirements.scheme != self.scheme or not isinstance(ctx.payment_payload, PaymentPayload):
            return None
        try:
            v = await self.manager.verify(ctx.payment_payload, ctx.requirements)  # type: ignore[arg-type]  # v2 only
        except Exception as e:  # noqa: BLE001  # every refusal goes back as a wire reason
            return AbortResult(reason=reason_of(e), message=str(e))
        self._remember(ctx.payment_payload, v)
        return SkipVerifyResult(result=VerifyResponse(is_valid=True, payer=v.channel_id,
                                                      extra={"channelId": v.channel_id, "cumulative": str(v.cumulative)}))

    async def after_verify(self, ctx: VerifyResultContext) -> SkipHandlerResult | None:
        v = self._peek(ctx.payment_payload) if isinstance(ctx.payment_payload, PaymentPayload) else None
        # A client close runs no handler: settle broadcasts it.
        if v is not None and v.kind == "close":
            return SkipHandlerResult(response=SkipHandlerDirective(body={"channelId": v.channel_id, "message": "closing"}))
        return None

    async def before_settle(self, ctx: SettleContext) -> SkipSettleResult | AbortResult | None:
        v = self._take(ctx.payment_payload) if isinstance(ctx.payment_payload, PaymentPayload) else None
        if v is None or not isinstance(ctx.requirements, PaymentRequirements):
            return None
        try:
            return SkipSettleResult(result=await self.manager.settle(v, int(ctx.requirements.amount)))
        except Exception as e:  # noqa: BLE001
            return AbortResult(reason=reason_of(e), message=str(e))

    async def on_verified_payment_canceled(self, ctx: VerifiedPaymentCanceledContext) -> None:
        v = self._take(ctx.payment_payload) if isinstance(ctx.payment_payload, PaymentPayload) else None
        if v is not None:
            await self.manager.release(v)


__all__ = ["BatchYcashServerScheme", "CloseEvent", "cents_of"]
