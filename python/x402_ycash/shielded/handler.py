"""The self-hosted ``sapling-proof`` handler the ``exact`` scheme routes to when
``assetTransferMethod == "sapling-proof"``: the server half (issuing per-request addresses) and the
facilitator half (settling against the same wallet and registry) in one object. Mirrors
packages/ycash/src/shielded/handler.ts.

    handler = SaplingProofHandler("ycash:mainnet", rpc, SqliteSettlementStore(...), receipt_key=key,
                                  registry=SqliteIssuedAddressRegistry(...))
    register_exact_ycash_facilitator(x402Facilitator(), rpc, "ycash:mainnet", shielded=handler)
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol

from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse

from ..store import SettlementStore
from .constants import CHAIN_OF, DEFAULT_SAPLING_PROOF_CONFIRMATIONS, ERR_NETWORK_MISMATCH
from .facilitator import DEFAULT_NOTE_POLL, DEFAULT_NOTE_WAIT, ShieldedExactFacilitator, ShieldedFacilitatorRpc
from .receipt import JwsSigner, es256k_signer
from .registry import IssuedAddressRegistry
from .server import ShieldedExactServer, ShieldedRouteIssuer, ShieldedServerRpc, confirmations_of


class SaplingProofRpc(ShieldedServerRpc, ShieldedFacilitatorRpc, Protocol):
    """The merchant's wallet node: it must hold the base address's spending key."""


class SaplingProofHandler:
    def __init__(self, network: str, rpc: SaplingProofRpc, settlement_store: SettlementStore, *,
                 receipt_key: bytes | str | JwsSigner, registry: IssuedAddressRegistry | None = None,
                 confirmations: tuple[int, int] | None = None, capabilities: Any = None, base_address: str | None = None,
                 default_confirmations: int = DEFAULT_SAPLING_PROOF_CONFIRMATIONS, retention_grace_seconds: int = 3600,
                 max_outstanding: int | None = None, fallback_price_micro_usd: int | None = None,
                 note_wait: float = DEFAULT_NOTE_WAIT, note_poll: float = DEFAULT_NOTE_POLL,
                 now: Callable[[], int] | None = None) -> None:
        """``confirmations`` is the (minimum, maximum) the operator settles: an issued policy outside
        it is refused. ``capabilities`` (NodeCapabilities), when given, must be on the network's
        chain. ``receipt_key`` is a 32-byte secp256k1 key (bytes or hex) or a ready JWS signer."""
        self.network = network
        if capabilities is not None and capabilities.chain != CHAIN_OF[network]:
            raise ValueError(f"the merchant node is on {capabilities.chain}, not {network}")
        self._range = confirmations
        self.receipt_signer: JwsSigner = es256k_signer(receipt_key) if isinstance(receipt_key, (bytes, str)) else receipt_key
        self.server = ShieldedExactServer(rpc, registry=registry, base_address=base_address, default_confirmations=default_confirmations,
                                          retention_grace_seconds=retention_grace_seconds, max_outstanding=max_outstanding,
                                          fallback_price_micro_usd=fallback_price_micro_usd, now=now)
        self.facilitator = ShieldedExactFacilitator(rpc, self.server.registry, settlement_store, self.receipt_signer,
                                                    note_wait=note_wait, note_poll=note_poll, now=now)

    async def enhance_requirements(self, requirements: PaymentRequirements, resource_url: str) -> PaymentRequirements:
        if requirements.network != self.network:
            raise ValueError(f"this handler serves {self.network}, not {requirements.network}")
        out = await self.server.enhance_requirements(requirements, resource_url)
        c = confirmations_of(out.extra)
        if self._range is not None and c is not None and not self._range[0] <= c <= self._range[1]:
            raise ValueError(f"confirmations {c} is outside the operator's range [{self._range[0]}, {self._range[1]}]")
        return out

    def route_issuer(self, amount: str, max_timeout_seconds: int, confirmations: int = DEFAULT_SAPLING_PROOF_CONFIRMATIONS) -> ShieldedRouteIssuer:
        """The exact server's ``shielded`` handler and the route's dynamic payTo, on this handler's registry."""
        return ShieldedRouteIssuer(self.server, self.network, amount, max_timeout_seconds, confirmations)

    async def averify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse:
        if requirements.network != self.network:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, invalid_message=f"this handler serves {self.network}")
        return await self.facilitator.averify(payload, requirements)

    async def asettle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        if requirements.network != self.network:
            return SettleResponse(success=False, error_reason=ERR_NETWORK_MISMATCH, error_message=f"this handler serves {self.network}",
                                  transaction="", network=requirements.network)
        return await self.facilitator.asettle(payload, requirements)
