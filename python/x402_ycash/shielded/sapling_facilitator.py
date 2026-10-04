"""The ``sapling`` facilitator (specs/scheme_exact_ycash.md, "sapling"; plan §5.9 X4b): the client hands
over a signed Sapling v4 transaction it has not broadcast; verify trial-decrypts the payment output with
the merchant's incoming viewing key and checks it offline (rules 1–11), settle claims the txid,
broadcasts and observes the note in the merchant's wallet. Mirrors
packages/ycash/src/shielded/saplingFacilitator.ts."""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse

from ..constants import ASSET_YEC, YCASH_NETWORKS
from ..exact.policy import expiry_window, json_equal
from ..exact.script import check_sighash_all
from ..node import yec_to_zat
from ..node.errors import RPC_INVALID_ADDRESS_OR_KEY, RpcError, SendRawTransactionError
from ..node.rpc import VerifyScriptsResult
from ..store import SettlementStore, retain_until_for_expiry, txid_key
from ..tx import Tx, fee_floor, parse_tx, tx_fee, txid
from .constants import (
    ASSET_TRANSFER_METHOD_SAPLING,
    CHAIN_OF,
    ERR_ASSET_TRANSFER_METHOD,
    ERR_DUPLICATE_SETTLEMENT,
    ERR_MEMO_MISMATCH,
    ERR_NETWORK_MISMATCH,
    ERR_PAYMENT_FLOW,
    ERR_REQUIREMENTS_MISMATCH,
    ERR_SETTLEMENT_PENDING,
    ERR_UNDERPAID,
    ERR_UNEXPECTED,
    ERR_UNKNOWN_INSTRUMENT,
    MEMO_REGEX,
    SCHEME_EXACT,
)
from .facilitator import meets_policy
from .receipt import JwsSigner, receipt_extension, sign_receipt
from .registry import IssuedAddressRegistry, IssuedRequest
from .request import memo_for_record
from .sapling import (
    LEAD_BYTE_ZIP212,
    DecryptedNote,
    SaplingIncomingKey,
    decode_sapling_viewing_key,
    memo_bytes,
    trial_decrypt_output,
)

PAYMENT_FLOW_AUTHORIZATION = "authorization"

ERR_SAPLING_OUTPUT = "invalid_exact_ycash_sapling_output"
ERR_SAPLING_REJECTED = "invalid_exact_ycash_sapling_rejected"
ERR_TRANSACTION = "invalid_exact_ycash_transaction"
ERR_SIGHASH = "invalid_exact_ycash_sighash"
ERR_INPUT_SPENT = "invalid_exact_ycash_input_spent"
ERR_FEE_TOO_LOW = "invalid_exact_ycash_fee_too_low"
ERR_FEE_TOO_HIGH = "invalid_exact_ycash_fee_too_high"
ERR_EXPIRY = "invalid_exact_ycash_expiry"
ERR_SCRIPT = "invalid_exact_ycash_script"

_HEX = re.compile(r"^(?:[0-9a-f]{2})+$")


class SaplingFacilitatorRpc(Protocol):
    """The node calls the facilitator makes; YcashRpc satisfies it. z_list_received_by_address runs on
    the node holding the merchant's viewing key (settle step 4)."""

    async def get_blockchain_info(self) -> dict[str, Any]: ...
    async def get_block_count(self) -> int: ...
    async def get_tx_out(self, txid: str, n: int, include_mempool: bool) -> dict[str, Any] | None: ...
    async def verify_scripts(self, hex_tx: str) -> VerifyScriptsResult: ...
    async def send_raw_transaction(self, hex_tx: str) -> str: ...
    async def z_list_received_by_address(self, address: str, minconf: int = 1) -> list[dict[str, Any]]: ...


@dataclass(frozen=True)
class SaplingLimits:
    max_transaction_bytes: int = 100_000
    """Rule 3: MAX_STANDARD_TX_SIZE on both lines."""
    max_components: int = 50
    """Rule 3: Sapling spends + outputs + transparent inputs."""
    fee_cap_zat: int = 100_000
    """Rule 8's sanity cap (RECOMMENDED)."""


@dataclass(frozen=True)
class _Resolved:
    network: str
    hex: str
    tx: Tx
    txid: str
    key: str


@dataclass(frozen=True)
class _Verified:
    resolved: _Resolved
    issued: IssuedRequest
    note: DecryptedNote
    fee_zat: int


@dataclass(frozen=True)
class _Refused:
    reason: str
    message: str
    txid: str = ""


class SaplingExactFacilitator:
    def __init__(self, rpc: SaplingFacilitatorRpc, *, viewing_key: str | SaplingIncomingKey, network: str,
                 registry: IssuedAddressRegistry, store: SettlementStore, receipt_signer: JwsSigner,
                 limits: SaplingLimits | None = None, now: Callable[[], int] | None = None,
                 observe_wait: float = 10.0, observe_poll: float = 0.5) -> None:
        """``viewing_key`` is the merchant's ``zxview…`` key (``z_exportviewingkey``) or its decoded
        incoming half; its HRP must be ``network``'s (rule 2, checked once, here)."""
        self._rpc = rpc
        self._key = decode_sapling_viewing_key(viewing_key, network) if isinstance(viewing_key, str) else viewing_key
        if self._key.network != network:
            raise ValueError(f"the viewing key is a {self._key.network} key, the facilitator serves {network}")
        self.network = network
        self._registry = registry
        self._store = store
        self._signer = receipt_signer
        self._limits = limits or SaplingLimits()
        self._now = now or (lambda: int(time.time()))
        self._observe_wait = observe_wait
        self._observe_poll = observe_poll
        self._chain_checked = False

    async def averify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse:
        """Rules 1 to 11, read-only. A claimed txid answers duplicate_settlement."""
        try:
            r = await self._check(payload, requirements)
        except Exception as e:  # noqa: BLE001  # a node lookup failed: nothing is known about the payment
            return VerifyResponse(is_valid=False, invalid_reason=ERR_UNEXPECTED, invalid_message=f"node lookup failed: {e}")
        if isinstance(r, _Refused):
            return VerifyResponse(is_valid=False, invalid_reason=r.reason, invalid_message=r.message)
        return VerifyResponse(is_valid=True, extra={"receivedZat": str(r.note.value), "feeZat": str(r.fee_zat)})

    async def asettle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        """A claimed txid is only observed; otherwise the rules re-run, the txid is claimed, the
        transaction broadcast and the note observed. A node rejection releases the claim."""
        network = requirements.network

        def failure(reason: str, t: str, message: str) -> SettleResponse:
            return SettleResponse(success=False, error_reason=reason, error_message=message, transaction=t, network=network)

        pure = self._resolve(payload, requirements)
        if isinstance(pure, _Refused):
            return failure(pure.reason, pure.txid, pure.message)
        try:
            if await self._store.is_claimed(pure.key):
                return await self._observe_claimed(pure, requirements)
            r = await self._check(payload, requirements)
            if isinstance(r, _Refused):
                if r.reason == ERR_DUPLICATE_SETTLEMENT:
                    return await self._observe_claimed(pure, requirements)
                return failure(r.reason, r.txid, r.message)
            # The claim is taken before submission; losing it means another settle owns the broadcast.
            if not await self._store.claim(pure.key, retain_until_for_expiry(pure.tx.expiry_height)):
                return await self._observe(pure, r.issued, requirements)
            rejected = await self._submit(r)
            if rejected is not None:
                await self._store.release(pure.key)  # the node answered and did not accept it
                return failure(rejected[0], pure.txid, rejected[1])
            return await self._observe(pure, r.issued, requirements)
        except Exception as e:  # noqa: BLE001  # the claim, if taken, stands: a retry resumes observing
            return failure(ERR_UNEXPECTED, pure.txid, f"settle failed: {e}")

    def _resolve(self, payload: PaymentPayload, req: PaymentRequirements) -> _Resolved | _Refused:
        """Rules 1 and 3 and the txid: the checks that need no node."""
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
        if network != self.network:
            return _Refused(ERR_NETWORK_MISMATCH, f"this facilitator serves {self.network}")
        if req.asset != ASSET_YEC:
            return _Refused(ERR_REQUIREMENTS_MISMATCH, "sapling pays YEC only")
        ex, ax = req.extra or {}, acc.extra or {}
        for x in (ex, ax):
            if x.get("assetTransferMethod") != ASSET_TRANSFER_METHOD_SAPLING:
                return _Refused(ERR_ASSET_TRANSFER_METHOD, f"assetTransferMethod {x.get('assetTransferMethod')} is not sapling")
            if x.get("paymentFlow") not in (None, PAYMENT_FLOW_AUTHORIZATION):
                return _Refused(ERR_PAYMENT_FLOW, f"paymentFlow {x.get('paymentFlow')} is not authorization")
            if x.get("areFeesSponsored") not in (None, False):
                return _Refused(ERR_REQUIREMENTS_MISMATCH, "areFeesSponsored must be false")
        memo = ex.get("memo")
        if not isinstance(memo, str) or not MEMO_REGEX.match(memo):
            return _Refused(ERR_REQUIREMENTS_MISMATCH, "extra.memo is missing or malformed")
        expires_at = ex.get("expiresAt")
        if not isinstance(expires_at, int) or isinstance(expires_at, bool):
            return _Refused(ERR_REQUIREMENTS_MISMATCH, "extra.expiresAt is missing")
        for k, v in ex.items():
            if not json_equal(ax.get(k), v):
                return _Refused(ERR_REQUIREMENTS_MISMATCH, f"accepted.extra.{k} differs from the requirements")

        # 3. Decoding: one v4 Sapling-group transaction with a Sapling bundle, within the limits.
        hex_tx = (payload.payload or {}).get("transaction")
        if not isinstance(hex_tx, str) or not _HEX.match(hex_tx):
            return _Refused(ERR_TRANSACTION, "payload.transaction is not lowercase hex")
        if len(hex_tx) // 2 > self._limits.max_transaction_bytes:
            return _Refused(ERR_TRANSACTION, f"transaction exceeds {self._limits.max_transaction_bytes} bytes")
        try:
            tx = parse_tx(hex_tx)
        except ValueError as e:
            return _Refused(ERR_TRANSACTION, f"not a v4 transaction: {e}")
        if not tx.shielded_outputs or tx.binding_sig is None:
            return _Refused(ERR_TRANSACTION, "no Sapling outputs")
        if tx.join_splits:
            return _Refused(ERR_TRANSACTION, "JoinSplits are not accepted")
        if tx.lock_time != 0:
            return _Refused(ERR_TRANSACTION, f"nLockTime {tx.lock_time} is not 0")
        if len(tx.shielded_spends) + len(tx.shielded_outputs) + len(tx.vin) > self._limits.max_components:
            return _Refused(ERR_TRANSACTION, f"more than {self._limits.max_components} spends, outputs and inputs")
        nullifiers = [s.nullifier for s in tx.shielded_spends]
        if len(set(nullifiers)) != len(nullifiers):
            return _Refused(ERR_TRANSACTION, "a nullifier is repeated")
        t = txid(tx)
        return _Resolved(network, hex_tx, tx, t, txid_key(network, t))

    async def _check(self, payload: PaymentPayload, req: PaymentRequirements) -> _Verified | _Refused:
        """Rules 1 to 11 in order (spec, "sapling", Facilitator verification rules)."""
        pure = self._resolve(payload, req)
        if isinstance(pure, _Refused):
            return pure
        tx, t, network = pure.tx, pure.txid, pure.network
        ex = req.extra or {}

        # 2. Network: the node is on the requirements' chain (the key's HRP was checked at construction).
        if not self._chain_checked:
            chain = (await self._rpc.get_blockchain_info())["chain"]
            if chain != CHAIN_OF[network]:
                return _Refused(ERR_NETWORK_MISMATCH, f"the facilitator node is on {chain}, not {network}")
            self._chain_checked = True

        # 4. The instrument: issued here, record still held, memo and terms those of the record.
        issued = await self._registry.get(req.pay_to)
        if issued is None:
            return _Refused(ERR_UNKNOWN_INSTRUMENT, f"{req.pay_to} is not an address issued for a held request", t)
        rec = issued.record
        if issued.memo != ex["memo"] or memo_for_record(rec) != ex["memo"]:
            return _Refused(ERR_UNKNOWN_INSTRUMENT, "extra.memo is not the memo issued for this address", t)
        if rec["network"] != network or rec["amount"] != req.amount or rec["expiresAt"] != ex["expiresAt"] or rec["payTo"] != req.pay_to:
            return _Refused(ERR_UNKNOWN_INSTRUMENT, "the requirements are not the ones issued for this address", t)

        # 11 (early): a claimed txid is on its way; the input checks no longer describe it.
        if await self._store.is_claimed(pure.key):
            return _Refused(ERR_DUPLICATE_SETTLEMENT, f"{t} is already claimed", t)

        # 5. Recipient: exactly one output decrypts under the merchant's key, to payTo, as a ZIP 212 note.
        decrypted = (trial_decrypt_output(o, self._key.ivk, network) for o in tx.shielded_outputs)
        notes = [dn for dn in decrypted if dn is not None]
        if not notes:
            return _Refused(ERR_SAPLING_OUTPUT, "no output decrypts under the merchant's viewing key", t)
        if len(notes) > 1:
            return _Refused(ERR_SAPLING_OUTPUT, f"{len(notes)} outputs decrypt under the merchant's viewing key, one is required", t)
        note = notes[0]
        if note.address != req.pay_to:
            return _Refused(ERR_SAPLING_OUTPUT, f"the output pays {note.address}, not payTo", t)
        if note.lead_byte != LEAD_BYTE_ZIP212:
            return _Refused(ERR_SAPLING_OUTPUT, "the note is not a ZIP 212 note (lead byte 0x02); the merchant wallet would not accept it", t)

        # 6. Amount.  7. Memo.
        if note.value < int(req.amount):
            return _Refused(ERR_UNDERPAID, f"the output carries {note.value} zatoshis, {req.amount} required", t)
        if memo_bytes(note.memo) != str(ex["memo"]).encode("utf-8"):
            return _Refused(ERR_MEMO_MISMATCH, "the note's memo is not extra.memo", t)

        # 9. Transparent inputs, if any: SIGHASH_ALL, confirmed, unspent, not spent in the mempool.
        values: list[int] = []
        for i, inp in enumerate(tx.vin):
            problem = check_sighash_all(inp.script_sig)
            if problem:
                return _Refused(ERR_SIGHASH, f"input {i}: {problem}", t)
            prev, n = inp.prevout.txid, inp.prevout.vout
            confirmed = await self._rpc.get_tx_out(prev, n, False)
            if not confirmed:
                return _Refused(ERR_INPUT_SPENT, f"input {i} ({prev}:{n}) is unknown, unconfirmed or spent", t)
            if not await self._rpc.get_tx_out(prev, n, True):
                return _Refused(ERR_INPUT_SPENT, f"input {i} ({prev}:{n}) is spent by a mempool transaction", t)
            values.append(yec_to_zat(confirmed["value"]))

        # 8. Fee: valueBalance + transparent inputs − outputs, within [floor, cap].
        fee = tx_fee(tx, values)
        floor = fee_floor(tx)
        if fee < floor:
            return _Refused(ERR_FEE_TOO_LOW, f"fee {fee} is below the floor {floor}", t)
        if fee > self._limits.fee_cap_zat:
            return _Refused(ERR_FEE_TOO_HIGH, f"fee {fee} is above the cap {self._limits.fee_cap_zat}", t)

        # 10. Expiry window, against the node's tip.
        lo, hi = expiry_window(await self._rpc.get_block_count(), req.max_timeout_seconds)
        e = tx.expiry_height
        if e == 0 or e < lo or e > hi:
            return _Refused(ERR_EXPIRY, f"nExpiryHeight {e} is outside [{lo}, {hi}]", t)

        # 9, the node's half: transparent scripts only; Sapling proofs and signatures are checked at relay.
        if tx.vin:
            s = await self._rpc.verify_scripts(pure.hex)
            if not s.complete or s.errors:
                return _Refused(ERR_SCRIPT, "; ".join(f"{x.get('txid')}:{x.get('vout')} {x.get('error')}" for x in s.errors) or "incomplete", t)

        # 11. Not claimed (re-read).
        if await self._store.is_claimed(pure.key):
            return _Refused(ERR_DUPLICATE_SETTLEMENT, f"{t} is already claimed", t)
        return _Verified(pure, issued, note, fee)

    async def _submit(self, v: _Verified) -> tuple[str, str] | None:
        """Settle step 3: a rejection is terminal; -27, a duplicate or a transport failure observe."""
        try:
            sent = await self._rpc.send_raw_transaction(v.resolved.hex)
            if sent != v.resolved.txid:
                raise ValueError(f"node returned txid {sent}, expected {v.resolved.txid}")
            return None
        except SendRawTransactionError as e:
            if e.kind == "already-in-chain" or await self._notes_of(v.resolved.txid, v.issued.record["payTo"]):
                return None
            reason = ERR_INPUT_SPENT if e.kind in ("mempool-conflict", "missing-inputs") else ERR_EXPIRY if e.kind == "expiring-soon" else ERR_SAPLING_REJECTED
            return reason, f"sendrawtransaction {e.code}: {e.message}"
        except RpcError as e:
            if e.transport:
                return None  # unknown outcome: keep the claim, observe
            raise

    async def _notes_of(self, t: str, pay_to: str) -> list[dict[str, Any]]:
        """The merchant wallet's notes of ``t`` at payTo, mempool included. A viewing-key wallet answers
        -5 at an address it has seen no note at (X-F78): no note yet; any other error is not evidence."""
        try:
            return [n for n in await self._rpc.z_list_received_by_address(pay_to, 0) if n.get("txid") == t]
        except RpcError as e:
            if not e.transport and e.code == RPC_INVALID_ADDRESS_OR_KEY:
                return []  # not seen yet
            return []  # a transient node error is not evidence of absence: keep polling

    async def _observe_claimed(self, pure: _Resolved, req: PaymentRequirements) -> SettleResponse:
        issued = await self._registry.get(req.pay_to)
        if issued is None:
            return SettleResponse(success=False, error_reason=ERR_UNKNOWN_INSTRUMENT, error_message=f"{req.pay_to} is no longer held",
                                  transaction=pure.txid, network=req.network)
        return await self._observe(pure, issued, req)

    async def _observe(self, pure: _Resolved, issued: IssuedRequest, req: PaymentRequirements) -> SettleResponse:
        """Settle steps 4 and 5: poll the merchant wallet for the note until the policy depth or the
        wait ends; past nExpiryHeight with no note, the transaction can never land."""
        network, t = req.network, pure.txid
        deadline = time.monotonic() + min(self._observe_wait, req.max_timeout_seconds)
        observed: int | None = None
        received = 0
        while True:
            notes = await self._notes_of(t, req.pay_to)
            if notes:
                min_conf = min(int(n.get("confirmations") or 0) for n in notes)
                observed = -1 if min_conf <= 0 else min_conf
                received = sum(int(n["amountZat"]) if isinstance(n.get("amountZat"), int) else yec_to_zat(n["amount"]) for n in notes)
                if meets_policy(observed, issued.confirmations):
                    break
            if time.monotonic() + self._observe_poll >= deadline:
                break
            await asyncio.sleep(self._observe_poll)
        if observed is not None and meets_policy(observed, issued.confirmations):
            try:
                receipt = sign_receipt(network, issued.record["resource"], t, self._signer, issued_at=self._now())
            except Exception as e:  # noqa: BLE001  # on its way, claim stands: the retry resumes here
                return SettleResponse(success=False, error_reason=ERR_SETTLEMENT_PENDING, error_message=f"receipt signing failed: {e}",
                                      transaction=t, network=network, extra={"status": "pending", "confirmations": observed})
            return SettleResponse(success=True, transaction=t, network=network,
                                  extra={"status": "mempool" if observed < 0 else "confirmed", "confirmations": observed, "receivedZat": str(received)},
                                  extensions=receipt_extension(receipt))
        if (observed is None or observed < 0) and await self._rpc.get_block_count() > pure.tx.expiry_height:
            return SettleResponse(success=False, error_reason=ERR_EXPIRY, error_message=f"the chain passed nExpiryHeight {pure.tx.expiry_height} without the transaction",
                                  transaction=t, network=network)
        return SettleResponse(success=False, error_reason=ERR_SETTLEMENT_PENDING, error_message=f"awaiting {max(issued.confirmations, 1)} confirmation(s)",
                              transaction=t, network=network, extra={"status": "pending", "confirmations": observed})
