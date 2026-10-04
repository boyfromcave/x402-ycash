"""The ``sapling-proof`` resource server: per request, a fresh diversified address, the request record
and its memo commitment (spec, "sapling-proof", Requirements; plan §5.9 X4a). Mirrors
packages/ycash/src/shielded/server.ts and the merchant example's route issuer."""

from __future__ import annotations

import base64
import json
import re
import secrets
import time
from collections.abc import Callable
from typing import Any, Protocol

from x402.schemas import PaymentRequirements

from .._sync import run_sync
from ..constants import ASSET_YEC, YCASH_NETWORKS
from .constants import (
    ASSET_TRANSFER_METHOD_SAPLING_PROOF,
    DEFAULT_SAPLING_PROOF_CONFIRMATIONS,
    MAX_CONFIRMATIONS,
    MIN_CONFIRMATIONS,
    PAYMENT_FLOW_UPFRONT,
    SAPLING_HRP,
    SCHEME_EXACT,
)
from .price import PriceRpc, current_price, quote_zat
from .registry import InMemoryIssuedAddressRegistry, IssuedAddressRegistry, IssuedRequest, record_retain_until
from .request import RequestRecord, memo_for_record

EXTRA_PRICE_USD = "priceUsd"
"""A requirement template may carry ``extra.priceUsd`` instead of an amount; the server quotes it."""

_AMOUNT = re.compile(r"^[1-9]\d*$")


class ShieldedServerRpc(PriceRpc, Protocol):
    """The merchant wallet calls the server makes. YcashRpc satisfies it."""

    async def z_get_new_address(self) -> str: ...
    async def z_get_new_diversified_address(self, base: str) -> str: ...


def confirmations_of(extra: dict[str, Any] | None) -> int | None:
    """extra.confirmationPolicy.confirmations, when declared as an integer."""
    policy = (extra or {}).get("confirmationPolicy")
    c = policy.get("confirmations") if isinstance(policy, dict) else None
    return c if isinstance(c, int) and not isinstance(c, bool) else None


class ShieldedExactServer:
    def __init__(self, rpc: ShieldedServerRpc, *, registry: IssuedAddressRegistry | None = None,
                 base_address: str | None = None, default_confirmations: int = DEFAULT_SAPLING_PROOF_CONFIRMATIONS,
                 retention_grace_seconds: int = 3600, max_outstanding: int | None = None,
                 fallback_price_micro_usd: int | None = None, now: Callable[[], int] | None = None) -> None:
        """``base_address`` is the merchant's Sapling address whose spending key the wallet holds (both
        lines refuse a diversified address without it: ycash-dd/src/wallet/rpcdump.cpp:869-870,
        ycash6/src/wallet/rpcdump.cpp:1425-1427); default one ``z_getnewaddress sapling``, made once.
        The registry is shared with the facilitator (default in memory: a restart forgets open requests)."""
        self.rpc = rpc
        self.registry: IssuedAddressRegistry = registry or InMemoryIssuedAddressRegistry()
        self._base = base_address
        self._default_confirmations = default_confirmations
        self._grace = retention_grace_seconds
        self._max_outstanding = max_outstanding
        self._fallback_price = fallback_price_micro_usd
        self._now = now or (lambda: int(time.time()))

    async def _base_address(self) -> str:
        # No lock: the server may run on the caller's loop and the bridge's; two concurrent first
        # calls would make two base addresses, both the wallet's, and keep the first.
        if self._base is None:
            base = await self.rpc.z_get_new_address()
            if self._base is None:
                self._base = base
        return self._base

    async def enhance_requirements(self, requirements: PaymentRequirements, resource_url: str) -> PaymentRequirements:
        """Turns a route's ``sapling-proof`` template into the requirements of one request: a fresh
        payTo, extra.memo, extra.expiresAt, paymentFlow "upfront" and the confirmation policy. The
        record is in the registry before the requirements are returned, so a 402 never names an
        address the facilitator would not recognise."""
        if not resource_url:
            raise ValueError("sapling-proof needs the resource URL: it is part of the request hash")
        network = requirements.network
        if network not in YCASH_NETWORKS:
            raise ValueError(f"not a Ycash network: {network}")
        if requirements.scheme != SCHEME_EXACT:
            raise ValueError(f"scheme {requirements.scheme} is not exact")
        if requirements.asset != ASSET_YEC:
            raise ValueError("sapling-proof pays YEC only")
        extra = dict(requirements.extra or {})
        if extra.get("assetTransferMethod") != ASSET_TRANSFER_METHOD_SAPLING_PROOF:
            raise ValueError(f"assetTransferMethod {extra.get('assetTransferMethod')} is not sapling-proof")
        timeout = requirements.max_timeout_seconds
        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:
            raise ValueError(f"maxTimeoutSeconds must be a positive integer: {timeout}")
        c = confirmations_of(extra)
        confirmations = self._default_confirmations if c is None else c
        if not MIN_CONFIRMATIONS <= confirmations <= MAX_CONFIRMATIONS:
            raise ValueError(f"confirmations {confirmations} is outside [{MIN_CONFIRMATIONS}, {MAX_CONFIRMATIONS}]")

        amount = requirements.amount
        usd = extra.pop(EXTRA_PRICE_USD, None)
        if isinstance(usd, str):
            quote = await current_price(self.rpc, self._fallback_price)
            amount = str(quote_zat(usd, quote.price_micro_usd))
            extra["quote"] = {"usd": usd, "priceMicroUsd": quote.price_micro_usd, "source": quote.source,
                              **({} if quote.height is None else {"height": quote.height})}
        if not isinstance(amount, str) or not _AMOUNT.match(amount):
            raise ValueError(f"amount must be a positive integer of zatoshis: {amount}")

        now = self._now()
        if self._max_outstanding is not None and await self.registry.outstanding(now) >= self._max_outstanding:
            raise ValueError(f"issuance limit: {self._max_outstanding} sapling-proof requests already held")
        pay_to = await self._fresh_address(network)
        expires_at = now + timeout
        record: RequestRecord = {"v": 1, "network": network, "asset": ASSET_YEC, "amount": amount, "payTo": pay_to,
                                 "resource": resource_url, "expiresAt": expires_at, "nonce": secrets.token_hex(32)}
        memo = memo_for_record(record)
        issued = IssuedRequest(record, memo, confirmations, now, record_retain_until(expires_at, confirmations, self._grace))
        if not await self.registry.issue(pay_to, issued):
            raise ValueError(f"address {pay_to} was already issued")
        extra.update({"assetTransferMethod": ASSET_TRANSFER_METHOD_SAPLING_PROOF, "paymentFlow": PAYMENT_FLOW_UPFRONT,
                      "areFeesSponsored": False, "memo": memo, "expiresAt": expires_at,
                      "confirmationPolicy": {"confirmations": confirmations}})
        return requirements.model_copy(update={"amount": amount, "pay_to": pay_to, "extra": extra})

    async def request_record(self, pay_to: str) -> RequestRecord | None:
        """The request record behind an issued address (the spec lets the server expose it to the client)."""
        held = await self.registry.get(pay_to)
        return held.record if held else None

    async def _fresh_address(self, network: str) -> str:
        """A diversified address never issued before, of the network's Sapling HRP (which also catches
        a merchant node on another chain). A repeat would be a wallet fault: refused, not reused."""
        base = await self._base_address()
        hrp = SAPLING_HRP[network] + "1"
        if not base.startswith(hrp):
            raise ValueError(f"base address {base} is not a {network} Sapling address")
        for _ in range(3):
            addr = await self.rpc.z_get_new_diversified_address(base)
            if not addr.startswith(hrp):
                raise ValueError(f"diversified address {addr} is not a {network} Sapling address")
            if not await self.registry.was_issued(addr):
                return addr
        raise ValueError("the wallet keeps returning addresses already issued")


def _accepted_pay_to(header: str | None) -> str | None:
    """The ``accepted.payTo`` of a PAYMENT-SIGNATURE header, if it decodes as a v2 payload."""
    if not header:
        return None
    try:
        p = json.loads(base64.b64decode(header))
    except ValueError:
        return None  # a malformed header fails matching downstream
    pay_to = p.get("accepted", {}).get("payTo") if isinstance(p, dict) and isinstance(p.get("accepted"), dict) else None
    return pay_to if isinstance(pay_to, str) else None


class ShieldedRouteIssuer:
    """A ``sapling-proof`` route over HTTP. Core treats payTo as fixed once requirements are built, so
    the address is issued where core resolves payTo, the route's dynamic ``pay_to(context)``, which
    sees the request URL; ``enhance_requirements`` (the exact server's ``shielded`` handler) then
    fills ``extra`` from the issued record. On the paid retry the accepted address is reused, so the
    rebuilt requirements match it exactly."""

    def __init__(self, server: ShieldedExactServer, network: str, amount: str, max_timeout_seconds: int,
                 confirmations: int = DEFAULT_SAPLING_PROOF_CONFIRMATIONS) -> None:
        self.server = server
        self._template = PaymentRequirements(
            scheme=SCHEME_EXACT, network=network, asset=ASSET_YEC, amount=amount, pay_to="", max_timeout_seconds=max_timeout_seconds,
            extra={"assetTransferMethod": ASSET_TRANSFER_METHOD_SAPLING_PROOF, "confirmationPolicy": {"confirmations": confirmations}})

    async def issue(self, resource_url: str) -> PaymentRequirements:
        return await self.server.enhance_requirements(self._template.model_copy(deep=True), resource_url)

    async def pay_to(self, context: Any) -> str:
        """The route's DynamicPayTo (x402.http.types.HTTPRequestContext)."""
        url = context.adapter.get_url()
        retry = _accepted_pay_to(context.payment_header)
        if retry:
            held = await self.server.registry.get(retry)
            # Only an address issued for this very resource and still unexpired is reused.
            if held and held.record["resource"] == url and held.record["expiresAt"] > int(time.time()):
                return retry
        return (await self.issue(url)).pay_to

    def enhance_requirements(self, requirements: PaymentRequirements) -> PaymentRequirements:
        """The requirement of an issued address: its memo, expiry and policy, from the registry."""
        held = run_sync(self.server.registry.get(requirements.pay_to))
        if held is None:
            raise ValueError(f"{requirements.pay_to} was not issued by this server")
        if held.record["amount"] != requirements.amount:
            raise ValueError("the route's price differs from the issued request's amount")
        extra = {**(requirements.extra or {}), "assetTransferMethod": ASSET_TRANSFER_METHOD_SAPLING_PROOF,
                 "paymentFlow": PAYMENT_FLOW_UPFRONT, "areFeesSponsored": False, "memo": held.memo,
                 "expiresAt": held.record["expiresAt"], "confirmationPolicy": {"confirmations": held.confirmations}}
        return requirements.model_copy(update={"extra": extra})
