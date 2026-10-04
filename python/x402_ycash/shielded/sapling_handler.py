"""The ``sapling`` method's server half and self-hosted handler, and the router that puts both shielded
methods behind the exact scheme's one ``shielded`` hook. Mirrors packages/ycash/src/shielded/saplingHandler.ts.

    router = ShieldedMethodRouter({"sapling-proof": SaplingProofHandler(...), "sapling": SaplingHandler(...)})
    register_exact_ycash_facilitator(x402Facilitator(), rpc, "ycash:regtest", shielded=router)

``sapling`` is refused on ``ycash:mainnet`` unless ``mainnet_ok=True`` (or X402_SAPLING_MAINNET_OK=1),
as the facilitator service does: the spec says a facilitator SHOULD NOT list it there until the
end-to-end proof against the Rust light client's transactions exists ("sapling", Pending).
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from typing import Any, Protocol

from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse

from ..constants import YCASH_MAINNET
from ..store import SettlementStore
from .constants import (
    ASSET_TRANSFER_METHOD_SAPLING,
    ASSET_TRANSFER_METHOD_SAPLING_PROOF,
    CHAIN_OF,
    DEFAULT_SAPLING_PROOF_CONFIRMATIONS,
    ERR_ASSET_TRANSFER_METHOD,
    ERR_NETWORK_MISMATCH,
    ERR_PAYMENT_FLOW,
    PAYMENT_FLOW_UPFRONT,
)
from .receipt import JwsSigner, es256k_signer
from .registry import IssuedAddressRegistry
from .sapling import SaplingIncomingKey
from .sapling_facilitator import PAYMENT_FLOW_AUTHORIZATION, SaplingExactFacilitator, SaplingFacilitatorRpc, SaplingLimits
from .server import ShieldedExactServer, ShieldedServerRpc, confirmations_of


def sapling_mainnet_allowed(mainnet_ok: bool | None = None) -> bool:
    """The explicit argument, else X402_SAPLING_MAINNET_OK=1."""
    return mainnet_ok if mainnet_ok is not None else os.environ.get("X402_SAPLING_MAINNET_OK") == "1"


class SaplingExactServer:
    """Issues ``sapling`` requirements: the same per-request address, record and memo as ``sapling-proof``
    (the record does not name the method, so one registry serves both), with ``assetTransferMethod``
    "sapling" and no ``paymentFlow`` (authorization)."""

    def __init__(self, inner: ShieldedExactServer) -> None:
        self.inner = inner

    @property
    def registry(self) -> IssuedAddressRegistry:
        return self.inner.registry

    async def enhance_requirements(self, requirements: PaymentRequirements, resource_url: str) -> PaymentRequirements:
        extra = dict(requirements.extra or {})
        if extra.get("assetTransferMethod") != ASSET_TRANSFER_METHOD_SAPLING:
            raise ValueError(f"assetTransferMethod {extra.get('assetTransferMethod')} is not sapling")
        if extra.get("paymentFlow") not in (None, PAYMENT_FLOW_AUTHORIZATION):
            raise ValueError("sapling is an authorization-flow method")
        extra["assetTransferMethod"] = ASSET_TRANSFER_METHOD_SAPLING_PROOF
        extra.pop("paymentFlow", None)
        issued = await self.inner.enhance_requirements(requirements.model_copy(update={"extra": extra}), resource_url)
        out = dict(issued.extra or {})
        out["assetTransferMethod"] = ASSET_TRANSFER_METHOD_SAPLING
        out.pop("paymentFlow", None)
        return issued.model_copy(update={"extra": out})


class SaplingRpc(ShieldedServerRpc, SaplingFacilitatorRpc, Protocol):
    """The merchant's node: wallet (issuance, note observation) and chain reads."""


class SaplingHandler:
    """The self-hosted ``sapling`` handler for one network: a SaplingExactServer issuing the instrument
    and a SaplingExactFacilitator verifying and settling against the same registry."""

    def __init__(self, network: str, rpc: SaplingRpc, settlement_store: SettlementStore, *,
                 viewing_key: str | SaplingIncomingKey, receipt_key: bytes | str | JwsSigner,
                 registry: IssuedAddressRegistry | None = None, confirmations: tuple[int, int] | None = None,
                 capabilities: Any = None, base_address: str | None = None,
                 default_confirmations: int = DEFAULT_SAPLING_PROOF_CONFIRMATIONS, limits: SaplingLimits | None = None,
                 observe_wait: float = 10.0, observe_poll: float = 0.5, mainnet_ok: bool | None = None,
                 now: Callable[[], int] | None = None) -> None:
        if network == YCASH_MAINNET and not sapling_mainnet_allowed(mainnet_ok):
            raise ValueError("sapling is not offered on ycash:mainnet until its end-to-end proof exists "
                             "(spec, \"sapling\", Pending); pass mainnet_ok=True or set X402_SAPLING_MAINNET_OK=1")
        if capabilities is not None and capabilities.chain != CHAIN_OF[network]:
            raise ValueError(f"the merchant node is on {capabilities.chain}, not {network}")
        self.network = network
        self._range = confirmations
        self.receipt_signer: JwsSigner = es256k_signer(receipt_key) if isinstance(receipt_key, (bytes, str)) else receipt_key
        self.server = SaplingExactServer(ShieldedExactServer(rpc, registry=registry, base_address=base_address,
                                                             default_confirmations=default_confirmations, now=now))
        self.facilitator = SaplingExactFacilitator(rpc, viewing_key=viewing_key, network=network, registry=self.server.registry,
                                                   store=settlement_store, receipt_signer=self.receipt_signer, limits=limits, now=now,
                                                   observe_wait=observe_wait, observe_poll=observe_poll)

    async def enhance_requirements(self, requirements: PaymentRequirements, resource_url: str) -> PaymentRequirements:
        if requirements.network != self.network:
            raise ValueError(f"this handler serves {self.network}, not {requirements.network}")
        out = await self.server.enhance_requirements(requirements, resource_url)
        c = confirmations_of(out.extra)
        if self._range is not None and c is not None and not self._range[0] <= c <= self._range[1]:
            raise ValueError(f"confirmations {c} is outside the operator's range [{self._range[0]}, {self._range[1]}]")
        return out

    async def averify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse:
        if requirements.network != self.network:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, invalid_message=f"this handler serves {self.network}")
        return await self.facilitator.averify(payload, requirements)

    async def asettle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        if requirements.network != self.network:
            return SettleResponse(success=False, error_reason=ERR_NETWORK_MISMATCH, error_message=f"this handler serves {self.network}",
                                  transaction="", network=requirements.network)
        return await self.facilitator.asettle(payload, requirements)


class ShieldedHandler(Protocol):
    async def asettle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse: ...


class ShieldedMethodRouter:
    """Routes by ``extra.assetTransferMethod`` to the configured shielded handler; ``flows`` tells the
    exact scheme which methods to advertise (``sapling-proof`` upfront, ``sapling`` authorization)."""

    def __init__(self, handlers: Mapping[str, ShieldedHandler | None]) -> None:
        known = (ASSET_TRANSFER_METHOD_SAPLING_PROOF, ASSET_TRANSFER_METHOD_SAPLING)
        for m in handlers:
            if m not in known:
                raise ValueError(f"{m} is not a shielded method")
        self._handlers = {m: h for m, h in handlers.items() if h is not None}
        self.methods: list[str] = [m for m in known if m in self._handlers]
        self.flows: dict[str, str] = {m: PAYMENT_FLOW_AUTHORIZATION if m == ASSET_TRANSFER_METHOD_SAPLING else PAYMENT_FLOW_UPFRONT
                                      for m in self.methods}

    def _pick(self, extra: Mapping[str, Any] | None) -> tuple[str, ShieldedHandler] | str:
        method = (extra or {}).get("assetTransferMethod")
        if method not in (ASSET_TRANSFER_METHOD_SAPLING_PROOF, ASSET_TRANSFER_METHOD_SAPLING):
            return f"assetTransferMethod {method} is not a shielded method"
        h = self._handlers.get(method)
        return (method, h) if h is not None else f"{method} is not configured"

    async def enhance_requirements(self, requirements: PaymentRequirements, resource_url: str) -> PaymentRequirements:
        h = self._pick(requirements.extra)
        if isinstance(h, str):
            raise ValueError(h)  # noqa: TRY004  # an unrouted method, not a wrong argument type
        enhance = getattr(h[1], "enhance_requirements", None)
        if enhance is None:
            raise ValueError(f"{h[0]} cannot issue requirements here")
        result: PaymentRequirements = await enhance(requirements, resource_url)
        return result

    async def averify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse:
        h = self._pick(requirements.extra)
        if isinstance(h, str):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_ASSET_TRANSFER_METHOD, invalid_message=h)
        averify = getattr(h[1], "averify", None)
        if averify is None:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_PAYMENT_FLOW, invalid_message=f"{h[0]} is upfront: settle, not verify")
        result: VerifyResponse = await averify(payload, requirements)
        return result

    async def asettle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        h = self._pick(requirements.extra)
        if isinstance(h, str):
            return SettleResponse(success=False, error_reason=ERR_ASSET_TRANSFER_METHOD, error_message=h, transaction="",
                                  network=requirements.network)
        return await h[1].asettle(payload, requirements)
