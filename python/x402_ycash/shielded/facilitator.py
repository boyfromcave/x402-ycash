"""The ``sapling-proof`` facilitator, self-hosted with the merchant's wallet: ``asettle`` runs the
spec's nine steps in order (specs/scheme_exact_ycash.md, "sapling-proof", Settlement). The claim is
the last step, so a payment below its policy depth, or any failure before the claim, holds nothing.
Mirrors packages/ycash/src/shielded/facilitator.ts and the service's bounded note wait
(packages/facilitator/src/schemes.ts ``facilitatorHalf``)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse

from ..constants import ASSET_YEC, YCASH_NETWORKS
from ..exact.policy import json_equal
from ..node import yec_to_zat
from ..node.errors import RPC_INVALID_ADDRESS_OR_KEY, RpcError
from ..store import RETAIN_FOREVER, SettlementStore, consumption_key
from .constants import (
    ASSET_TRANSFER_METHOD_SAPLING_PROOF,
    CHAIN_OF,
    ERR_ASSET_TRANSFER_METHOD,
    ERR_DUPLICATE_SETTLEMENT,
    ERR_MEMO_MISMATCH,
    ERR_NETWORK_MISMATCH,
    ERR_NOT_RECEIVED,
    ERR_PAYMENT_FLOW,
    ERR_REQUIREMENTS_MISMATCH,
    ERR_SETTLEMENT_PENDING,
    ERR_TXID_MALFORMED,
    ERR_UNDERPAID,
    ERR_UNEXPECTED,
    ERR_UNKNOWN_INSTRUMENT,
    MEMO_REGEX,
    PAYMENT_FLOW_UPFRONT,
    SCHEME_EXACT,
    TXID_REGEX,
)
from .receipt import JwsSigner, receipt_extension, sign_receipt
from .registry import IssuedAddressRegistry, IssuedRequest
from .request import memo_for_record, note_memo_equals

DEFAULT_NOTE_WAIT = 10.0
"""Seconds settle waits for the note to reach the merchant's wallet before not_received (spec step 4:
a SHOULD, a few seconds well inside the resource server's settle timeout)."""
DEFAULT_NOTE_POLL = 0.5


def payment_key(network: str, txid: str, pay_to: str) -> str:
    """The consumption key ``ycash:<net>:<txid>@<payTo>``: payTo is issued for exactly one request, so
    one transaction paying two requests buys both, and a proof still binds to one request."""
    return consumption_key(network, f"{txid}@{pay_to}")


def meets_policy(observed: int, policy: int) -> bool:
    """``observed`` (−1 mempool, N ≥ 1 depth) meets ``policy``: only −1 accepts a mempool note; 0 and
    1 need a block; N needs N."""
    if policy < 0:
        return True
    return observed >= max(policy, 1)


class ShieldedFacilitatorRpc(Protocol):
    """The merchant wallet calls the facilitator makes. YcashRpc satisfies it."""

    async def z_list_received_by_address(self, address: str, minconf: int = 1) -> list[dict[str, Any]]: ...
    async def get_blockchain_info(self) -> dict[str, Any]: ...


@dataclass(frozen=True)
class _Checked:
    network: str
    txid: str
    issued: IssuedRequest
    received_zat: int
    observed: int


@dataclass(frozen=True)
class _Refused:
    reason: str
    message: str
    txid: str = ""
    observed: int | None = None


def _status_extra(observed: int, received_zat: int) -> dict[str, Any]:
    """``extra`` of a response: the strongest evidence observed (spec, "Confirmation policy")."""
    return {"status": "mempool" if observed < 0 else "confirmed", "confirmations": observed, "receivedZat": str(received_zat)}


def _note_zat(n: dict[str, Any]) -> int:
    z = n.get("amountZat")
    return int(z) if isinstance(z, int) and not isinstance(z, bool) else yec_to_zat(n["amount"])


class ShieldedExactFacilitator:
    def __init__(self, rpc: ShieldedFacilitatorRpc, registry: IssuedAddressRegistry, store: SettlementStore,
                 receipt_signer: JwsSigner, *, note_wait: float = DEFAULT_NOTE_WAIT, note_poll: float = DEFAULT_NOTE_POLL,
                 now: Callable[[], int] | None = None) -> None:
        """``registry`` is the server's (the same object or the same SQLite file); ``store`` is the
        restart-durable consumption store, keys kept forever (spec, "Retention bound")."""
        self._rpc = rpc
        self._registry = registry
        self._store = store
        self._signer = receipt_signer
        self._note_wait = note_wait
        self._note_poll = note_poll
        self._now = now or (lambda: int(time.time()))
        self._chain_checked: str | None = None

    async def averify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse:
        """Read-only: every settle check but the claim. ``upfront`` never calls /verify; this exists for
        a resource server that wants to look before it settles."""
        r = await self._check(payload, requirements)
        if isinstance(r, _Refused):
            return VerifyResponse(is_valid=False, invalid_reason=r.reason, invalid_message=r.message)
        if await self._store.is_claimed(payment_key(r.network, r.txid, requirements.pay_to)):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_DUPLICATE_SETTLEMENT, invalid_message=f"{r.txid} was already settled")
        return VerifyResponse(is_valid=True, extra=_status_extra(r.observed, r.received_zat))

    async def asettle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        """Steps 1–9; while the wallet has no note of the txid yet (not_received) the checks are
        retried for at most ``note_wait`` seconds, holding nothing."""
        deadline = time.monotonic() + self._note_wait
        while True:
            r = await self._check(payload, requirements)
            if not (isinstance(r, _Refused) and r.reason == ERR_NOT_RECEIVED and time.monotonic() + self._note_poll <= deadline):
                break
            await asyncio.sleep(self._note_poll)
        network = requirements.network
        if isinstance(r, _Refused):
            extra = {"status": "pending", "confirmations": -1 if r.observed is None else r.observed} \
                if r.reason == ERR_SETTLEMENT_PENDING else None
            return SettleResponse(success=False, error_reason=r.reason, error_message=r.message, transaction=r.txid,
                                  network=network, extra=extra)
        # Step 9: the claim, atomically, last. Of two concurrent presentations exactly one gets here.
        key = payment_key(r.network, r.txid, requirements.pay_to)
        if not await self._store.claim(key, RETAIN_FOREVER):
            return SettleResponse(success=False, error_reason=ERR_DUPLICATE_SETTLEMENT, error_message=f"{r.txid} was already settled",
                                  transaction=r.txid, network=network)
        try:
            receipt = sign_receipt(network, r.issued.record["resource"], r.txid, self._signer, issued_at=self._now())
        except Exception as e:  # noqa: BLE001  # the resource has not run: an abnormal end must not hold the claim
            await self._store.release(key)
            return SettleResponse(success=False, error_reason=ERR_UNEXPECTED, error_message=f"receipt signing failed: {e}",
                                  transaction=r.txid, network=network)
        return SettleResponse(success=True, transaction=r.txid, network=network, extra=_status_extra(r.observed, r.received_zat),
                              extensions=receipt_extension(receipt))

    async def _check(self, payload: PaymentPayload, req: PaymentRequirements) -> _Checked | _Refused:
        """Steps 1 to 8."""
        # 1. Envelope.
        acc = payload.accepted
        if payload.x402_version != 2:
            return _Refused(ERR_REQUIREMENTS_MISMATCH, f"x402Version {payload.x402_version} is not 2")
        for f in ("scheme", "network", "asset", "amount", "pay_to", "max_timeout_seconds"):
            if not json_equal(getattr(acc, f), getattr(req, f)):
                return _Refused(ERR_REQUIREMENTS_MISMATCH, f"accepted.{f} differs from the requirements")
        if req.scheme != SCHEME_EXACT:
            return _Refused(ERR_REQUIREMENTS_MISMATCH, f"scheme {req.scheme} is not exact")
        network = req.network
        if network not in YCASH_NETWORKS:
            return _Refused(ERR_REQUIREMENTS_MISMATCH, f"{network} is not a Ycash network")
        if req.asset != ASSET_YEC:
            return _Refused(ERR_REQUIREMENTS_MISMATCH, "sapling-proof pays YEC only")
        ex, ax = req.extra or {}, acc.extra or {}
        for x in (ex, ax):
            if x.get("assetTransferMethod") != ASSET_TRANSFER_METHOD_SAPLING_PROOF:
                return _Refused(ERR_ASSET_TRANSFER_METHOD, f"assetTransferMethod {x.get('assetTransferMethod')} is not sapling-proof")
            if x.get("paymentFlow") != PAYMENT_FLOW_UPFRONT:
                return _Refused(ERR_PAYMENT_FLOW, f"paymentFlow {x.get('paymentFlow')} is not upfront")
        memo = ex.get("memo")
        if not isinstance(memo, str) or not MEMO_REGEX.match(memo):
            return _Refused(ERR_REQUIREMENTS_MISMATCH, "extra.memo is missing or malformed")
        expires_at = ex.get("expiresAt")
        if not isinstance(expires_at, int) or isinstance(expires_at, bool):
            return _Refused(ERR_REQUIREMENTS_MISMATCH, "extra.expiresAt is missing")
        # Every server-declared extra field, memo and expiresAt included, has the same value in accepted.
        for k, v in ex.items():
            if not json_equal(ax.get(k), v):
                return _Refused(ERR_REQUIREMENTS_MISMATCH, f"accepted.extra.{k} differs from the requirements")

        # Rule 2: the merchant node is on the requirements' chain.
        if self._chain_checked != network:
            chain = (await self._rpc.get_blockchain_info())["chain"]
            if chain != CHAIN_OF[network]:
                return _Refused(ERR_NETWORK_MISMATCH, f"the merchant node is on {chain}, not {network}")
            self._chain_checked = network

        # 2. The instrument: issued here, record still held, memo and terms those of the record.
        issued = await self._registry.get(req.pay_to)
        if issued is None:
            return _Refused(ERR_UNKNOWN_INSTRUMENT, f"{req.pay_to} is not an address issued for a held request")
        rec = issued.record
        if issued.memo != memo or memo_for_record(rec) != memo:
            return _Refused(ERR_UNKNOWN_INSTRUMENT, "extra.memo is not the memo issued for this address")
        if rec["network"] != network or rec["amount"] != req.amount or rec["expiresAt"] != expires_at or rec["payTo"] != req.pay_to:
            return _Refused(ERR_UNKNOWN_INSTRUMENT, "the requirements are not the ones issued for this address")

        # 3. The proof.
        txid = (payload.payload or {}).get("txid")
        if not isinstance(txid, str) or not TXID_REGEX.match(txid):
            return _Refused(ERR_TXID_MALFORMED, "payload.txid is not 64 lowercase hex characters")

        # 4. Notes of this txid at payTo, mempool included (minconf 0).
        # A viewing-key-only wallet refuses (-5) an offline-issued address until it has decrypted a
        # note to it (ycash-dd/src/wallet/rpcwallet.cpp:3514-3515, ycash6 :4278-4279): no note yet.
        try:
            received = await self._rpc.z_list_received_by_address(req.pay_to, 0)
        except RpcError as e:
            if e.transport or e.code != RPC_INVALID_ADDRESS_OR_KEY:
                raise
            received = []
        notes = [n for n in received if n.get("txid") == txid]
        if not notes:
            return _Refused(ERR_NOT_RECEIVED, f"the merchant wallet has no note of {txid} at payTo (yet)", txid)

        # 5. Memo: at least one note carries the commitment.
        if not any(note_memo_equals(n, memo) for n in notes):
            return _Refused(ERR_MEMO_MISMATCH, f"no note of {txid} carries extra.memo", txid)

        # 6. Amount: the sum covers it. Overpayment is accepted and kept (spec, "Amount acceptance").
        received_zat = sum(_note_zat(n) for n in notes)
        if received_zat < int(req.amount):
            return _Refused(ERR_UNDERPAID, f"received {received_zat} zatoshis, {req.amount} required; the funds stay at payTo", txid)

        # 7. Depth: every note meets the policy. Below it: pending, nothing claimed.
        min_conf = min(int(n.get("confirmations") or 0) for n in notes)
        observed = -1 if min_conf <= 0 else min_conf
        if not meets_policy(observed, issued.confirmations):
            need = max(issued.confirmations, 1)
            return _Refused(ERR_SETTLEMENT_PENDING, f"{txid} has {max(min_conf, 0)} confirmations, the policy needs {need}", txid, observed)

        # 8. Window: the record is still held (step 2 found it); pruning honours the retention bound.
        return _Checked(network, txid, issued, received_zat, observed)
