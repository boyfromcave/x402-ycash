"""The exact resource-server side for Ycash: prices in YEC (or USD through a price source), and the
``extra`` the 402 carries (specs/scheme_exact_ycash.md, "PaymentRequirements"). Implements upstream's
``SchemeNetworkServer``; packages/ycash/src/exact/server/scheme.ts is the TypeScript twin."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any, ClassVar, Protocol

from x402.interfaces import PaymentFlowConfig
from x402.schemas import AssetAmount, Network, PaymentRequirements, Price, SupportedKind
from x402.schemas.helpers import convert_to_token_amount, parse_money

from .._sync import run_sync
from ..constants import ASSET_YEC, ASSET_YED, DUST_ZAT, YED_MAX_OUTPUT_CENTS, YED_MIN_OUTPUT_CENTS, is_ycash_network
from .constants import ATM_SAPLING_PROOF, ATM_TRANSPARENT, MAX_CONFIRMATIONS, MIN_CONFIRMATIONS, SCHEME_EXACT
from .policy import CANONICAL_AMOUNT, asset_transfer_method_of, is_int, is_shielded_method, resolve_confirmation_policy

MoneyParser = Callable[[str, str], AssetAmount | None]
"""(decimal amount, network) -> AssetAmount, or None to defer to the next parser."""


class YecPriceSource(Protocol):
    def micro_usd_per_yec(self, network: str) -> int:
        """micro-USD per YEC (1 YEC = $50 is 50_000_000), positive."""
        ...


class ShieldedServerHandler(Protocol):
    """The ``sapling-proof`` server half: fills a requirement whose ``payTo`` was issued for one
    request (x402_ycash.shielded.ShieldedRouteIssuer)."""

    def enhance_requirements(self, requirements: PaymentRequirements) -> PaymentRequirements: ...


class FixedPriceSource:
    """A fixed price, for tests and for merchants with their own feed."""

    def __init__(self, micro_usd: int) -> None:
        if micro_usd <= 0:
            raise ValueError("price must be positive")
        self._micro_usd = micro_usd

    def micro_usd_per_yec(self, network: str) -> int:
        _ = network
        return self._micro_usd


class YedGetPriceSource:
    """The Yellowback overlay's own price, ``yed_getprice`` (plan Y-9), on a Yellowback node: the
    first available of ``fields`` (pMid, steadier than pFast and fresher than pSlow, then pSlow).
    A window is null until enough recent blocks carry pool quotes."""

    def __init__(self, rpc: Any, fields: Sequence[str] = ("pMid", "pSlow")) -> None:
        self._rpc = rpc
        self._fields = tuple(fields)

    def micro_usd_per_yec(self, network: str) -> int:
        _ = network
        p = run_sync(self._rpc.yed_get_price())
        for f in self._fields:
            v = p.get(f)
            if is_int(v) and v > 0:
                return int(v)
        raise ValueError(f"yed_getprice has no {'/'.join(self._fields)} price")


def micro_usd_to_zat(micro_usd: int, micro_usd_per_yec: int) -> int:
    """USD (micro-USD) to zatoshis, rounded up so the merchant never receives less than the price."""
    return -(-micro_usd * 100_000_000 // micro_usd_per_yec)


_ONE_DOLLAR_MICRO_USD = 1_000_000


class ExactYcashServerScheme:
    """``x402ResourceServer().register("ycash:regtest", ExactYcashServerScheme(...))``."""

    scheme = SCHEME_EXACT
    default_asset_transfer_method = ATM_TRANSPARENT
    _TRANSPARENT_FLOWS: ClassVar[PaymentFlowConfig] = {"supported": ("authorization",), "default": "authorization"}
    _UPFRONT_FLOWS: ClassVar[PaymentFlowConfig] = {"supported": ("upfront",), "default": "upfront"}

    def __init__(self, price_source: YecPriceSource | None = None, zero_conf_cap_zat: int | None = None, *,
                 usd_asset: str = ASSET_YEC, shielded: ShieldedServerHandler | None = None) -> None:
        """``zero_conf_cap_zat``: a YEC payment up to this many zatoshis defaults to policy −1, larger
        ones to 1. Default: $1.00 through the price source (the spec's suggestion), or no
        zero-confirmation default without a price source. ``usd_asset`` is the asset a USD price
        ("$2.50") is asked in: YEC at the price source's rate (default), or YED cents at par; a YED
        price below $1.00 is refused either way (a YED output below $1.00 burns, plan Y-3).
        ``shielded`` serves ``sapling-proof`` requirements."""
        if usd_asset not in (ASSET_YEC, ASSET_YED):
            raise ValueError(f"usd_asset must be {ASSET_YEC} or {ASSET_YED}")
        self._price_source = price_source
        self._zero_conf_cap = zero_conf_cap_zat
        self._usd_asset = usd_asset
        self._shielded = shielded
        self._money_parsers: list[MoneyParser] = []
        # literals, not FLOW_AUTHORIZATION: PaymentFlowConfig's fields are Literal-typed
        flows: dict[str, PaymentFlowConfig] = {ATM_TRANSPARENT: self._TRANSPARENT_FLOWS}
        if shielded is not None:
            flows[ATM_SAPLING_PROOF] = self._UPFRONT_FLOWS
        self.payment_flows: Mapping[str, PaymentFlowConfig] = flows

    def register_money_parser(self, parser: MoneyParser) -> ExactYcashServerScheme:
        """Custom parsers run first, in registration order; None defers to the next."""
        self._money_parsers.append(parser)
        return self

    def get_asset_decimals(self, asset: str, network: Network) -> int | None:
        _ = network
        return {ASSET_YEC: 8, ASSET_YED: 2}.get(asset)

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        """An AssetAmount passes through after validation. Money: "0.0025 YEC" in YEC, "25 YED" in YED,
        and "$0.10" (or "0.10", "0.10 USD") in YEC at the price source's rate."""
        if not is_ycash_network(network):
            raise ValueError(f"unsupported network {network}")
        if isinstance(price, AssetAmount):
            return _validate(price)
        if isinstance(price, dict) and "amount" in price:
            return _validate(AssetAmount(amount=price["amount"], asset=price.get("asset", ""), extra=price.get("extra") or {}))
        parsed = parse_money(price)
        amount, symbol = parsed["amount"], parsed.get("symbol")
        for parser in self._money_parsers:
            r = parser(amount, network)
            if r is not None:
                return _validate(r)
        if symbol == ASSET_YEC:
            return _validate(AssetAmount(amount=convert_to_token_amount(amount, 8), asset=ASSET_YEC, extra={}))
        if symbol == ASSET_YED or (symbol is None and self._usd_asset == ASSET_YED):
            return _validate(AssetAmount(amount=yed_cents(amount), asset=ASSET_YED, extra={}))
        if symbol is not None:
            raise ValueError(f"unknown asset {symbol} on {network}")
        if self._price_source is None:
            raise ValueError("a USD price needs a price source (or price in YEC)")
        rate = self._price_source.micro_usd_per_yec(network)
        zat = micro_usd_to_zat(int(convert_to_token_amount(amount, 6)), rate)
        return _validate(AssetAmount(amount=str(zat), asset=ASSET_YEC, extra={}))

    def enhance_payment_requirements(self, requirements: PaymentRequirements, supported_kind: SupportedKind,
                                     extensions: list[str]) -> PaymentRequirements:
        """Adds ``assetTransferMethod``, ``areFeesSponsored: false`` and ``confirmationPolicy`` (−1 up
        to the zero-confirmation cap, else 1). Fields the route set are kept. The facilitator's
        advertised method and confirmation range must cover them."""
        _ = extensions
        if not is_ycash_network(supported_kind.network):
            raise ValueError(f"unsupported network {supported_kind.network}")
        if is_shielded_method(requirements.extra):
            if self._shielded is None:
                raise ValueError("sapling-proof requirements need a shielded handler")
            return self._shielded.enhance_requirements(requirements)
        method = asset_transfer_method_of(requirements.extra)
        if method != ATM_TRANSPARENT:
            raise ValueError(f"unsupported assetTransferMethod {method}")
        adv = supported_kind.extra or {}
        conf = adv.get("confirmations") or {}
        lo = conf["minimum"] if is_int(conf.get("minimum")) else MIN_CONFIRMATIONS
        hi = conf["maximum"] if is_int(conf.get("maximum")) else MAX_CONFIRMATIONS
        methods = adv.get("assetTransferMethods")
        if isinstance(methods, list) and ATM_TRANSPARENT not in methods:
            raise ValueError("the facilitator does not support assetTransferMethod transparent")
        # A facilitator lists YED only when its node runs the overlay (spec "/supported").
        assets = adv.get("assets")
        if requirements.asset == ASSET_YED and isinstance(assets, list) and ASSET_YED not in assets:
            raise ValueError("the facilitator does not settle YED (it needs a Yellowback node)")
        policy = resolve_confirmation_policy(requirements.extra, max(lo, self._default_confirmations(requirements)))
        if policy is None:
            raise ValueError("invalid confirmationPolicy")
        if not lo <= policy <= hi:
            raise ValueError(f"the facilitator settles confirmations {lo}..{hi}, not {policy}")
        extra = {**(requirements.extra or {}), "assetTransferMethod": ATM_TRANSPARENT, "areFeesSponsored": False,
                 "confirmationPolicy": {"confirmations": policy}}
        return requirements.model_copy(update={"extra": extra})

    def _default_confirmations(self, req: PaymentRequirements) -> int:
        """−1 for YEC up to the zero-confirmation cap; 1 otherwise and for YED (Confirmation policy)."""
        if req.asset != ASSET_YEC:
            return 1
        cap = self._zero_conf_cap
        if cap is None and self._price_source is not None:
            try:
                cap = micro_usd_to_zat(_ONE_DOLLAR_MICRO_USD, self._price_source.micro_usd_per_yec(req.network))
            except Exception:  # noqa: BLE001  # any price failure means no zero-conf default
                cap = None  # no price, no zero-confirmation default: 1 is the safe side
        return -1 if cap is not None and int(req.amount) <= cap else 1


def yed_cents(amount: str) -> str:
    """A decimal dollar amount in whole cents; a fraction of a cent is refused, never truncated."""
    _, _, frac = amount.partition(".")
    if any(c != "0" for c in frac[2:]):
        raise ValueError(f"a YED price is a whole number of cents: {amount}")
    return convert_to_token_amount(amount, 2)


def _validate(v: AssetAmount) -> AssetAmount:
    if not CANONICAL_AMOUNT.match(v.amount):
        raise ValueError(f"amount must be a positive canonical integer: {v.amount}")
    if v.asset == ASSET_YEC:
        if int(v.amount) < DUST_ZAT:
            raise ValueError(f"a YEC amount must be at least {DUST_ZAT} zatoshis (dust)")
    elif v.asset == ASSET_YED:
        if not YED_MIN_OUTPUT_CENTS <= int(v.amount) <= YED_MAX_OUTPUT_CENTS:
            raise ValueError(f"a YED amount must be {YED_MIN_OUTPUT_CENTS}..{YED_MAX_OUTPUT_CENTS} cents ($1.00 to $100,000): "
                             "a smaller YED output burns; use batch-settlement below $1.00")
    else:
        raise ValueError(f"asset must be {ASSET_YEC} or {ASSET_YED}: {v.asset}")
    return v
