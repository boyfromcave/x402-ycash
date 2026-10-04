"""Facilitator verification rules 1–10 for ``transparent`` YEC (specs/scheme_exact_ycash.md,
"Facilitator Verification Rules"), in the spec's order, read-only: nothing here broadcasts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Protocol

from x402.schemas import PaymentPayload, PaymentRequirements

from ..constants import ASSET_YED, chain_of_network
from ..node import NodeCapabilities, VerifyScriptsResult
from ..store import SettlementStore, txid_key
from ..tx import Tx, address_to_script, fee_floor, parse_tx, tx_fee, txid
from .constants import (
    ERR_AMOUNT_MISMATCH,
    ERR_ASSET_TRANSFER_METHOD,
    ERR_DUPLICATE_SETTLEMENT,
    ERR_EXPIRY,
    ERR_FEE_TOO_HIGH,
    ERR_FEE_TOO_LOW,
    ERR_INPUT_SPENT,
    ERR_NETWORK_MISMATCH,
    ERR_PAYMENT_FLOW,
    ERR_RECIPIENT_MISMATCH,
    ERR_REQUIREMENTS_MISMATCH,
    ERR_SCRIPT,
    ERR_SIGHASH,
    ERR_TRANSACTION,
    ERR_YED_INPUT,
    ERR_YED_NODE_REQUIRED,
    SCHEME_EXACT,
)
from .policy import (
    asset_transfer_method_of,
    check_transparent_method,
    check_transparent_yec_requirements,
    expiry_window,
    json_equal,
    resolve_confirmation_policy,
)
from .script import address_of_script, address_of_script_sig, check_sighash_all


class ExactFacilitatorRpc(Protocol):
    """The RPCs the facilitator reads (and, in settle, ``sendrawtransaction``). YcashRpc fits."""

    async def get_blockchain_info(self) -> dict[str, Any]: ...
    async def get_block_count(self) -> int: ...
    async def get_tx_out(self, txid: str, n: int, include_mempool: bool) -> dict[str, Any] | None: ...
    async def verify_scripts(self, hex_tx: str) -> VerifyScriptsResult: ...
    async def send_raw_transaction(self, hex_tx: str) -> str: ...
    async def capabilities(self) -> NodeCapabilities: ...
    async def yed_validate_raw_transaction(self, hex_tx: str) -> dict[str, Any]: ...


@dataclass(frozen=True)
class VerifyLimits:
    max_transaction_bytes: int = 100_000
    """Rule 3's size limit (MAX_STANDARD_TX_SIZE on both lines)."""
    max_inputs: int = 50
    """Bounds rule 6's gettxout calls (Implementation limits)."""
    fee_cap_zat: int = 100_000
    """Rule 7's sanity cap (RECOMMENDED 100,000)."""
    min_confirmations: int = -1
    """The settled range; −1 needs the operator's opt-in (Confirmation policy)."""
    max_confirmations: int = 20
    default_confirmations: int = 1
    """Policy assumed when the requirements carry none."""


@dataclass(frozen=True)
class Failure:
    reason: str
    message: str
    payer: str | None = None


@dataclass(frozen=True)
class ResolvedPayment:
    """What the pure checks (rules 1, 3, 4, 5) resolved, before any chain lookup."""

    network: str
    hex: str
    tx: Tx
    txid: str
    key: str
    pay_to_vout: int
    required: int

    def resumed_payer(self) -> str:
        return address_of_script_sig(self.tx.vin[0].script_sig if self.tx.vin else b"", self.network)


@dataclass(frozen=True)
class VerifiedPayment:
    payment: ResolvedPayment
    payer: str
    fee_zat: int


_HEX = re.compile(r"^(?:[0-9a-f]{2})+$")
_ENVELOPE_FIELDS = ("scheme", "network", "asset", "amount", "pay_to", "max_timeout_seconds")


def resolve_payment(payload: PaymentPayload, req: PaymentRequirements, limits: VerifyLimits) -> ResolvedPayment | Failure:
    """Rule 1, the requirement forms, and the pure part of the transaction: rules 3, 4 and 5."""
    # Rule 1: envelope.
    if payload.x402_version != 2:
        return Failure(ERR_REQUIREMENTS_MISMATCH, f"x402Version {payload.x402_version} is not 2")
    acc = payload.accepted
    if req.scheme != SCHEME_EXACT:
        return Failure(ERR_REQUIREMENTS_MISMATCH, f"scheme {req.scheme} is not exact")
    for f in _ENVELOPE_FIELDS:
        if not json_equal(getattr(acc, f), getattr(req, f)):
            return Failure(ERR_REQUIREMENTS_MISMATCH, f"accepted.{f} differs from the requirements")
    if asset_transfer_method_of(acc.extra) != asset_transfer_method_of(req.extra):
        return Failure(ERR_REQUIREMENTS_MISMATCH, "accepted names another assetTransferMethod")
    for k, v in (req.extra or {}).items():
        if k != "assetTransferMethod" and (k not in (acc.extra or {}) or not json_equal(acc.extra[k], v)):
            return Failure(ERR_REQUIREMENTS_MISMATCH, f"accepted.extra.{k} differs from the requirements")
    method = check_transparent_method(req.extra)
    if method is not None:
        code = {"method": ERR_ASSET_TRANSFER_METHOD, "flow": ERR_PAYMENT_FLOW}.get(method[0], ERR_REQUIREMENTS_MISMATCH)
        return Failure(code, method[1])
    if req.asset == ASSET_YED:
        return Failure(ERR_YED_NODE_REQUIRED, "YED exact payments are not served by this facilitator (plan X3)")
    form = check_transparent_yec_requirements(req.network, req.asset, req.amount, req.pay_to, req.max_timeout_seconds)
    if form:
        return Failure(ERR_REQUIREMENTS_MISMATCH, form)
    policy = resolve_confirmation_policy(req.extra, limits.default_confirmations)
    if policy is None:
        return Failure(ERR_REQUIREMENTS_MISMATCH, "confirmationPolicy must be {confirmations} with an integer in [-1, 20]")
    if not limits.min_confirmations <= policy <= limits.max_confirmations:
        return Failure(ERR_REQUIREMENTS_MISMATCH,
                       f"this facilitator settles confirmations {limits.min_confirmations}..{limits.max_confirmations}, not {policy}")

    # Rule 3: decoding.
    hex_tx = payload.payload.get("transaction")
    if not isinstance(hex_tx, str) or not _HEX.match(hex_tx):
        return Failure(ERR_TRANSACTION, "payload.transaction must be lowercase hex")
    if len(hex_tx) // 2 > limits.max_transaction_bytes:
        return Failure(ERR_TRANSACTION, f"transaction exceeds {limits.max_transaction_bytes} bytes")
    try:
        tx = parse_tx(hex_tx)  # v4 Sapling group only, no trailing bytes
    except ValueError as e:
        return Failure(ERR_TRANSACTION, str(e))
    if tx.has_shielded() or tx.value_balance != 0:
        return Failure(ERR_TRANSACTION, "a transparent payment carries no Sapling or JoinSplit component")
    if tx.lock_time != 0:
        return Failure(ERR_TRANSACTION, "nLockTime must be 0")
    if not tx.vin or not tx.vout:
        return Failure(ERR_TRANSACTION, "transaction has no inputs or no outputs")
    if len(tx.vin) > limits.max_inputs:
        return Failure(ERR_TRANSACTION, f"more than {limits.max_inputs} inputs")

    # Rule 4: recipient and amount.
    pay_to_script = address_to_script(req.pay_to, req.network)
    hits = [n for n, o in enumerate(tx.vout) if o.script_pubkey == pay_to_script]
    if len(hits) != 1:
        return Failure(ERR_RECIPIENT_MISMATCH, f"{len(hits)} outputs pay payTo; exactly one must")
    if tx.vout[hits[0]].value != int(req.amount):
        return Failure(ERR_AMOUNT_MISMATCH, f"the payTo output is not exactly {req.amount} zatoshis")

    # Rule 5: signature hash types.
    for i, inp in enumerate(tx.vin):
        bad = check_sighash_all(inp.script_sig)
        if bad:
            return Failure(ERR_SIGHASH, f"input {i}: {bad}")
    tid = txid(bytes.fromhex(hex_tx))
    return ResolvedPayment(req.network, hex_tx, tx, tid, txid_key(req.network, tid), hits[0], policy)


async def check_network(rpc: ExactFacilitatorRpc, network: str) -> int | Failure:
    """Rule 2; returns the tip height."""
    info = await rpc.get_blockchain_info()
    if info["chain"] != chain_of_network(network):
        return Failure(ERR_NETWORK_MISMATCH, f"the node runs {info['chain']}, the requirements name {network}")
    return int(info["blocks"])


async def verify_transparent(
    rpc: ExactFacilitatorRpc,
    store: SettlementStore,
    payload: PaymentPayload,
    req: PaymentRequirements,
    limits: VerifyLimits,
) -> VerifiedPayment | Failure:
    """Rules 1–10 in order. A tx this facilitator already claimed has spent its inputs, so rules
    6–9Y no longer apply and the answer is rule 10's ``duplicate_settlement`` (checked right after
    rule 3, per the spec), with ``payer`` from input 0."""
    s = resolve_payment(payload, req, limits)
    if isinstance(s, Failure):
        return s
    tip = await check_network(rpc, s.network)
    if isinstance(tip, Failure):
        return tip
    if await store.is_claimed(s.key):
        return Failure(ERR_DUPLICATE_SETTLEMENT, f"{s.txid} is already claimed", s.resumed_payer())

    # Rule 6: every input confirmed and unspent, and not spent in the mempool (plan R-6, X-F10).
    values: list[int] = []
    payer = ""
    for i, inp in enumerate(s.tx.vin):
        prev = inp.prevout
        confirmed = await rpc.get_tx_out(prev.txid, prev.vout, False)
        if not confirmed:
            return Failure(ERR_INPUT_SPENT, f"input {i} ({prev.txid}:{prev.vout}) is unknown, unconfirmed or spent")
        if not await rpc.get_tx_out(prev.txid, prev.vout, True):
            return Failure(ERR_INPUT_SPENT, f"input {i} ({prev.txid}:{prev.vout}) is spent by a mempool transaction")
        values.append(int(confirmed["value_zat"]))
        if i == 0:
            payer = address_of_script(bytes.fromhex(confirmed["scriptPubKey"]["hex"]), s.network)

    # Rule 7: fee floor (SDK and facilitator policy, X-F3) and sanity cap.
    fee = tx_fee(s.tx, values)
    floor = fee_floor(s.tx)
    if fee < floor:
        return Failure(ERR_FEE_TOO_LOW, f"fee {fee} is below the floor {floor}", payer)
    if fee > limits.fee_cap_zat:
        return Failure(ERR_FEE_TOO_HIGH, f"fee {fee} is above the cap {limits.fee_cap_zat}", payer)

    # Rule 8: expiry window, read against the tip rule 2 saw.
    lo, hi = expiry_window(tip, req.max_timeout_seconds)
    e = s.tx.expiry_height
    if e == 0 or not lo <= e <= hi:
        return Failure(ERR_EXPIRY, f"nExpiryHeight {e} is outside [{lo}, {hi}]", payer)

    # Rule 9: the node's script verifier, signing nothing (plan R-5).
    scripts = await rpc.verify_scripts(s.hex)
    if not scripts.complete or scripts.errors:
        detail = "; ".join(f"{x.get('txid')}:{x.get('vout')} {x.get('error')}" for x in scripts.errors)
        return Failure(ERR_SCRIPT, detail or "incomplete", payer)

    # Rule 9Y: on a Yellowback node, a YEC payment must not spend a YED-bearing coin (plan Y-4).
    if (await rpc.capabilities()).yellowback:
        yed = await rpc.yed_validate_raw_transaction(s.hex)
        if int(yed.get("yedIn", 0)) != 0:
            return Failure(ERR_YED_INPUT, f"the transaction spends {yed['yedIn']} YED cents, which a YEC payment would burn", payer)

    # Rule 10: not claimed (re-read: the claim may have landed while the lookups ran).
    if await store.is_claimed(s.key):
        return Failure(ERR_DUPLICATE_SETTLEMENT, f"{s.txid} is already claimed", payer)
    return VerifiedPayment(s, payer, fee)
