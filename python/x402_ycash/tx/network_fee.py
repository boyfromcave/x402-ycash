"""The network fee of post-quantum and Yellowback transactions (rpcversion 8, the fee structure;
docs/plans/yellowback-quantum-fees-spec.md §3.1 in the workspace). Policy, not consensus: the node
publishes dollar-per-KB rates at the attested price in ``yed_getinfo.params.fees.network``
(ycash-dd src/policy/policy.cpp PlainPQFeeRate / YedFeeRate / YedMaxTxFee), and its wallets pay
``max(flat floor, min(rate × size / 1000, cap))`` with the plain PQ rate for a transaction spending a
post-quantum input, the Yellowback rate for a YED or vault transaction, and the Yellowback cap for both
(owner D-Q-26). Every other transaction keeps the S-6 floor (fee.py). Mirrors packages/ycash/src/tx/networkFee.ts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .fee import fee_floor
from .transaction import Tx

FeeKind = Literal["plain", "pq", "yellowback"]

FEES_RPC_VERSION = 8
"""The rpcversion that introduced ``params.fees``."""


@dataclass(frozen=True)
class NetworkFees:
    """``yed_getinfo.params.fees.network`` as the SDK uses it, amounts in zatoshis."""

    price_micro_usd: int | None
    """The attested price the rates were computed at (µUSD per YEC); None when none ("fallback")."""
    price_source: str
    plain_zat_per_kb: int
    """The plain post-quantum rate ($0.02/KB at the price)."""
    yellowback_zat_per_kb: int
    """The vault/Yellowback rate ($0.05/KB at the price)."""
    flat_zat: int
    """The wallet's flat floor (DEFAULT_FEE on v4.5.0)."""
    max_tx_fee_zat: int
    """-maxtxfee: what sendrawtransaction accepts without allowhighfees."""
    yellowback_max_tx_fee_zat: int
    """The cap of a PQ or Yellowback transaction: min(max(-maxtxfee, $2 at the price), -yellowbackmaxtxfee)."""


def _zat(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def network_fees_of(info: dict[str, Any]) -> NetworkFees | None:
    """The rates from a ``yed_getinfo`` result; None from a node older than rpcversion 8 or without them."""
    version = info.get("rpcversion")
    if not isinstance(version, int) or version < FEES_RPC_VERSION:
        return None
    n = ((info.get("params") or {}).get("fees") or {}).get("network")
    if not isinstance(n, dict):
        return None
    plain = _zat((n.get("plain") or {}).get("zatPerKB"))
    yellowback = _zat((n.get("yellowback") or {}).get("zatPerKB"))
    flat = _zat(n.get("flatZat"))
    max_fee = _zat(n.get("maxTxFeeZat"))
    cap = _zat((n.get("yellowback") or {}).get("maxTxFeeZat"))
    if plain is None or yellowback is None or flat is None or max_fee is None or cap is None:
        return None
    p = n.get("priceMicroUsd")
    price = p if isinstance(p, int) and not isinstance(p, bool) and p > 0 else None
    source = n.get("priceSource")
    return NetworkFees(price, source if isinstance(source, str) else ("fallback" if price is None else "tip"),
                       plain, yellowback, flat, max_fee, cap)


async def read_network_fees(chain: Any) -> NetworkFees | None:
    """The node's current rates (never cached: they follow the attested price); None from a node
    without the overlay or older than rpcversion 8."""
    get = getattr(chain, "yed_get_info", None)
    if not callable(get):
        return None
    try:
        return network_fees_of(await get())
    except Exception:  # noqa: BLE001 - a node without the Yellowback overlay
        return None


def size_fee(zat_per_kb: int, size: int) -> int:
    """CFeeRate::GetFee: rate × size / 1000, rounded down, never 0 for a positive rate."""
    fee = zat_per_kb * size // 1000
    return zat_per_kb if fee == 0 and zat_per_kb > 0 else fee


def network_fee(tx: Tx, kind: FeeKind, fees: NetworkFees | None) -> int:
    """The fee the SDK pays for a draft (signatures at their largest): the S-6 floor for a plain
    transaction or without rates, else max(S-6 floor, flatZat, min(rate × size / 1000, cap))."""
    floor = fee_floor(tx)
    if kind == "plain" or fees is None:
        return floor
    rate = fees.plain_zat_per_kb if kind == "pq" else fees.yellowback_zat_per_kb
    priced = min(size_fee(rate, len(tx.serialize())), fees.yellowback_max_tx_fee_zat)
    return max(priced, fees.flat_zat, floor)


def network_fee_cap(kind: FeeKind, plain_cap: int, fees: NetworkFees | None) -> int:
    """The highest fee a facilitator accepts: its own cap for a plain transaction, at least the
    node's PQ/Yellowback cap for the others."""
    if kind == "plain" or fees is None:
        return plain_cap
    return max(plain_cap, fees.yellowback_max_tx_fee_zat)


def needs_high_fees(fee: int, kind: FeeKind, fees: NetworkFees | None) -> bool:
    """Whether sendrawtransaction must be told ``allowhighfees``: a PQ/YED fee above -maxtxfee and
    within the node's PQ/Yellowback cap."""
    return kind != "plain" and fees is not None and fees.max_tx_fee_zat < fee <= fees.yellowback_max_tx_fee_zat
