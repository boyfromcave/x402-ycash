"""The exact facilitator for Ycash: verification rules 1–10 and settlement of ``transparent`` YEC
(specs/scheme_exact_ycash.md), implementing upstream's ``SchemeNetworkFacilitator``. It signs
nothing and pays nothing; it reads the node, and in settle it claims the txid and broadcasts once.

Upstream's protocol is sync, so ``verify``/``settle`` run the async ``averify``/``asettle`` on the
bridge loop (x402_ycash._sync); asyncio callers can await the async methods directly.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from x402.interfaces import FacilitatorContext
from x402.schemas import Network, PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse

from .._sync import run_sync
from ..constants import YCASH_CAIP_FAMILY
from ..node import RpcError, SendRawTransactionError
from ..store import InMemorySettlementStore, SettlementStore, retain_until_for_expiry
from .constants import (
    ATM_TRANSPARENT,
    ERR_ASSET_TRANSFER_METHOD,
    ERR_DUPLICATE_SETTLEMENT,
    ERR_EXPIRY,
    ERR_INPUT_SPENT,
    ERR_SETTLEMENT_FAILED,
    ERR_SETTLEMENT_PENDING,
    ERR_TRANSACTION,
    MAX_CONFIRMATIONS,
    MIN_CONFIRMATIONS,
    SCHEME_EXACT,
)
from .policy import confirmations_satisfy, is_shielded_method
from .verify import ExactFacilitatorRpc, Failure, ResolvedPayment, VerifyLimits, resolve_payment, verify_transparent

log = logging.getLogger("x402_ycash.exact")

DEFAULT_CONFIRMATION_TIMEOUT = 75.0
"""One settle must finish inside core's facilitator timeout; core retries once on pending."""
DEFAULT_CONFIRMATION_POLL = 1.0


class ExactYcashFacilitatorScheme:
    """``x402Facilitator().register(["ycash:regtest"], ExactYcashFacilitatorScheme(rpc))``."""

    scheme = SCHEME_EXACT
    caip_family = YCASH_CAIP_FAMILY

    def __init__(
        self,
        rpc: ExactFacilitatorRpc,
        *,
        settlement_store: SettlementStore | None = None,
        confirmations: tuple[int, int] | None = None,
        accept_mempool: bool = True,
        confirmation_timeout: float = DEFAULT_CONFIRMATION_TIMEOUT,
        confirmation_poll: float = DEFAULT_CONFIRMATION_POLL,
        max_transaction_bytes: int = 100_000,
        max_inputs: int = 50,
        fee_cap_zat: int = 100_000,
        default_confirmations: int = 1,
    ) -> None:
        """``confirmations`` is the (minimum, maximum) range this facilitator settles, advertised in
        ``/supported``; default −1..20, or 0..20 with ``accept_mempool=False`` (the operator refusing
        mempool settlement). ``confirmation_timeout`` (seconds) bounds one settle's wait for the
        policy depth before ``settlement_pending``; never more than maxTimeoutSeconds."""
        self._rpc = rpc
        self._store: SettlementStore = settlement_store or InMemorySettlementStore()
        lo, hi = confirmations or (MIN_CONFIRMATIONS if accept_mempool else 0, MAX_CONFIRMATIONS)
        self.limits = VerifyLimits(
            max_transaction_bytes=max_transaction_bytes,
            max_inputs=max_inputs,
            fee_cap_zat=fee_cap_zat,
            min_confirmations=max(MIN_CONFIRMATIONS, lo),
            max_confirmations=min(MAX_CONFIRMATIONS, hi),
            default_confirmations=default_confirmations,
        )
        self._timeout = confirmation_timeout
        self._poll = confirmation_poll

    # ------------------------------------------------------------------ SchemeNetworkFacilitator

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """The ``/supported`` capability block. YED (plan X3) and sapling-proof are not served here."""
        _ = network
        return {
            "assets": ["YEC"],
            "assetTransferMethods": [ATM_TRANSPARENT],
            "areFeesSponsored": False,
            "confirmations": {"minimum": self.limits.min_confirmations, "maximum": self.limits.max_confirmations},
        }

    def get_signers(self, network: Network) -> list[str]:
        """No sponsorship: the facilitator holds no keys."""
        _ = network
        return []

    def verify(self, payload: PaymentPayload, requirements: PaymentRequirements,
               context: FacilitatorContext | None = None) -> VerifyResponse:
        return run_sync(self.averify(payload, requirements, context))

    def settle(self, payload: PaymentPayload, requirements: PaymentRequirements,
               context: FacilitatorContext | None = None) -> SettleResponse:
        return run_sync(self.asettle(payload, requirements, context))

    # ------------------------------------------------------------------ async core

    async def averify(self, payload: PaymentPayload, requirements: PaymentRequirements,
                      context: FacilitatorContext | None = None) -> VerifyResponse:
        _ = context
        if is_shielded_method(requirements.extra):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_ASSET_TRANSFER_METHOD,
                                  invalid_message="sapling-proof is not served by this facilitator", payer="")
        try:
            r = await verify_transparent(self._rpc, self._store, payload, requirements, self.limits)
        except Exception as e:  # a node or transport failure says nothing about the payment
            return VerifyResponse(is_valid=False, invalid_reason=ERR_SETTLEMENT_FAILED,
                                  invalid_message=f"node lookup failed: {e}", payer="")
        if isinstance(r, Failure):
            return VerifyResponse(is_valid=False, invalid_reason=r.reason, invalid_message=r.message, payer=r.payer or "")
        return VerifyResponse(is_valid=True, payer=r.payer)

    async def asettle(self, payload: PaymentPayload, requirements: PaymentRequirements,
                      context: FacilitatorContext | None = None) -> SettleResponse:
        """Settlement (spec "Settlement"): re-run the rules, claim the txid atomically, broadcast
        once, then observe the payTo outpoint with ``gettxout(…, true)`` until the policy depth or the
        wait ends. A settle of an already-claimed txid never broadcasts: it resumes observing."""
        _ = context
        network = requirements.network
        if is_shielded_method(requirements.extra):
            return _failure(ERR_ASSET_TRANSFER_METHOD, network, "", "sapling-proof is not served by this facilitator")
        s = resolve_payment(payload, requirements, self.limits)
        if isinstance(s, Failure):
            return _failure(s.reason, network, "", s.message)
        try:
            if await self._store.is_claimed(s.key):  # step 1
                return await self._observe(s, requirements, s.resumed_payer())
            v = await verify_transparent(self._rpc, self._store, payload, requirements, self.limits)  # step 2
            if isinstance(v, Failure):
                if v.reason == ERR_DUPLICATE_SETTLEMENT:
                    return await self._observe(s, requirements, v.payer or s.resumed_payer())
                return _failure(v.reason, network, s.txid, v.message, v.payer)
            # The claim is taken before the first await on submission; losing the race means another
            # settle owns the broadcast, so this one only observes.
            if not await self._store.claim(s.key, retain_until_for_expiry(s.tx.expiry_height)):
                return await self._observe(s, requirements, v.payer)
            await self._store.prune(await self._rpc.get_block_count())  # drops claims past expiry + 10

            rejected = await self._submit(s)  # step 3
            log.info("exact settle broadcast txid=%s rejected=%s", s.txid, rejected and rejected[0])
            if rejected:
                await self._store.release(s.key)  # the node answered and did not accept it
                return _failure(rejected[0], network, s.txid, rejected[1], v.payer)
            return await self._observe(s, requirements, v.payer)  # steps 4, 5
        except Exception as e:
            log.warning("exact settle failed txid=%s error=%s", s.txid, e)
            return _failure(ERR_SETTLEMENT_FAILED, network, s.txid, str(e))

    async def _submit(self, s: ResolvedPayment) -> tuple[str, str] | None:
        """``sendrawtransaction``. A terminal rejection only when the node certainly did not take the
        tx; −27 and transport failures continue to observation, keeping the claim (X-F6)."""
        try:
            sent = await self._rpc.send_raw_transaction(s.hex)
        except SendRawTransactionError as e:
            if e.kind == "already-in-chain":
                return None
            # Someone else may have relayed the same payload first; its payTo output proves it.
            if await self._rpc.get_tx_out(s.txid, s.pay_to_vout, True):
                return None
            reason = {"mempool-conflict": ERR_INPUT_SPENT, "missing-inputs": ERR_INPUT_SPENT,
                      "expiring-soon": ERR_EXPIRY}.get(e.kind, ERR_TRANSACTION)
            return reason, f"sendrawtransaction {e.code}: {e.message}"
        except RpcError as e:
            if e.transport:
                return None  # unknown outcome: keep the claim, observe
            raise
        if sent != s.txid:
            raise RuntimeError(f"node returned txid {sent}, expected {s.txid}")
        return None

    async def _observe(self, s: ResolvedPayment, req: PaymentRequirements, payer: str) -> SettleResponse:
        """Waits (bounded) for the policy depth; success, ``settlement_pending``, or expiry."""
        deadline = time.monotonic() + min(self._timeout, float(req.max_timeout_seconds))
        seen: int | None = None
        while True:
            seen = await self._evidence(s)
            if seen is not None and confirmations_satisfy(seen, s.required):
                return SettleResponse(success=True, transaction=s.txid, network=req.network, payer=payer,
                                      extra={"status": "mempool" if seen < 0 else "confirmed", "confirmations": seen})
            if time.monotonic() + self._poll >= deadline:
                break
            await asyncio.sleep(self._poll)
        # Past nExpiryHeight and not in a block, the tx can never land (X-F8: valid through expiry).
        if (seen is None or seen < 0) and await self._rpc.get_block_count() > s.tx.expiry_height:
            return _failure(ERR_EXPIRY, req.network, s.txid,
                            f"the chain passed nExpiryHeight {s.tx.expiry_height} without the transaction", payer)
        return SettleResponse(success=False, error_reason=ERR_SETTLEMENT_PENDING,
                              error_message=f"awaiting {s.required} confirmation(s)", transaction=s.txid,
                              network=req.network, payer=payer, extra={"status": "pending", "confirmations": seen})

    async def _evidence(self, s: ResolvedPayment) -> int | None:
        """−1 in the mempool, the depth when mined, None when not seen."""
        try:
            out = await self._rpc.get_tx_out(s.txid, s.pay_to_vout, True)
        except Exception:
            return None  # a transient node error is not evidence of absence; keep polling
        if not out:
            return None
        return int(out["confirmations"]) if int(out["confirmations"]) > 0 else -1


def _failure(reason: str, network: str, transaction: str, message: str, payer: str | None = None) -> SettleResponse:
    return SettleResponse(success=False, error_reason=reason, error_message=message, transaction=transaction,
                          network=network, payer=payer or None)
