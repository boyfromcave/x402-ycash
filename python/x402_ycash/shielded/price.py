"""Quoting a YEC amount from a dollar price (plan §5.9, "Price in dollars"): Yellowback's own attested
price (``yed_getprice``, micro-USD per YEC) when the merchant node runs the overlay, else a configured
price. Mirrors packages/ycash/src/shielded/price.ts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Protocol

from ..node import RPC_METHOD_NOT_FOUND, RpcError

YED_PRICE_FIELDS = ("pMid", "pFast", "pSlow")
"""The yed_getprice fields tried in order: the mid window first, a median with less noise than pFast."""

_USD = re.compile(r"^(\d+)(?:\.(\d{1,6}))?$")


@dataclass(frozen=True)
class PriceQuote:
    price_micro_usd: int
    """micro-USD per YEC"""
    source: str
    """"yed_getprice:pMid" etc., or "configured"."""
    height: int | None = None


def usd_to_micro(usd: str) -> int:
    """A decimal USD string ("0.05", "12", "1.234567") in micro-USD, exactly."""
    m = _USD.match(usd.strip())
    if not m:
        raise ValueError(f"not a USD amount with at most 6 decimals: {usd}")
    return int(m.group(1)) * 1_000_000 + int((m.group(2) or "").ljust(6, "0"))


def quote_zat(usd: str, price_micro_usd: int) -> int:
    """zatoshis for ``usd`` at ``price_micro_usd`` per YEC, rounded up so the merchant is never short."""
    if not isinstance(price_micro_usd, int) or isinstance(price_micro_usd, bool) or price_micro_usd <= 0:
        raise ValueError(f"bad price {price_micro_usd}")
    micro = usd_to_micro(usd)
    if micro <= 0:
        raise ValueError(f"USD amount must be positive: {usd}")
    return -(-micro * 100_000_000 // price_micro_usd)


class PriceRpc(Protocol):
    async def yed_get_price(self, height: int | None = None) -> dict[str, Any]: ...


async def current_price(rpc: PriceRpc, fallback_micro_usd: int | None = None) -> PriceQuote:
    """``yed_getprice`` when the node has the overlay and a live price, else ``fallback``. A stock node
    answers -32601; a Yellowback node with too few quote tags returns null prices."""
    try:
        p = await rpc.yed_get_price()
        for f in YED_PRICE_FIELDS:
            v = p.get(f)
            if isinstance(v, int) and not isinstance(v, bool) and v > 0:
                return PriceQuote(v, f"yed_getprice:{f}", p.get("height"))
    except RpcError as e:
        if e.transport or e.code != RPC_METHOD_NOT_FOUND:
            raise
    if fallback_micro_usd is not None:
        return PriceQuote(fallback_micro_usd, "configured")
    raise ValueError("no YEC price: the node has no live yed_getprice and no fallback price is configured")
