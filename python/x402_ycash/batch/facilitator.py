"""A facilitator for ``batch-settlement`` on Ycash, on upstream's SchemeNetworkFacilitator. It holds
no channel state and no server key: it verifies what is checkable from the chain (the open rules, a
voucher's shape and client signature against the live channel output), relays the funding
transaction, and broadcasts closes the server completed (``claim``). The charged total, the stored
voucher and the in-flight lock stay with the server (specs/scheme_batch_settlement_ycash.md,
"Settlement"). It records the return address of each open it relays and binds it in that channel's
later vouchers and claims; a channel it never saw open is checked against the voucher's own vout 1.
A YED channel needs a Yellowback node: D is the channel's token record as the overlay
reports it, and every voucher must burn nothing. Mirrors packages/ycash/src/batch/facilitator/scheme.ts.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from x402.interfaces import FacilitatorContext
from x402.schemas import Network, PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse

from .._sync import run_sync
from ..channel import (
    Channel,
    channel_id_of,
    channel_script_pubkey,
    commitment_id_of,
    parse_channel_script,
    parse_close_script_sig,
)
from ..constants import ASSET_YED, YCASH_CAIP_FAMILY
from ..node import SendRawTransactionError
from ..store import (
    DEFAULT_CLOSED_RETENTION_MS,
    RETAIN_FOREVER,
    ChannelRecord,
    ChannelStore,
    InMemoryChannelStore,
    SettlementStore,
    txid_key,
)
from ..tx import Tx, address_to_script, txid
from .errors import BatchError, BatchSettlementError, reason_of
from .return_address import return_script_of
from .types import BATCH_SETTLEMENT_SCHEME, BatchTerms, is_batch_payload, parse_terms, required_depth, same_offer
from .verify import (
    ChainView,
    chain_context,
    check_completed,
    check_voucher,
    check_yed_voucher,
    cumulative_floor,
    decode_tx,
    layout_for,
    overlay_deposit,
    verify_open,
    yed_chain,
    zat_of,
)


class BatchYcashFacilitatorScheme:
    """``x402Facilitator().register(["ycash:regtest"], BatchYcashFacilitatorScheme(rpc))``."""

    scheme = BATCH_SETTLEMENT_SCHEME
    caip_family = YCASH_CAIP_FAMILY

    def __init__(self, rpc: ChainView, *, settlement_store: SettlementStore | None = None, channel_store: ChannelStore | None = None,
                 confirmations: tuple[int, int] = (-1, 20), funding_wait: float = 0.0, funding_poll: float = 0.5,
                 closed_retention_ms: int = DEFAULT_CLOSED_RETENTION_MS) -> None:
        """``settlement_store`` deduplicates relays of a close by its txid (plan X-F6); ``channel_store``
        records the channels relayed (with their return script, which later vouchers must pay) and the
        cumulative of each close; the charged total and the voucher watermark are the server's.
        ``funding_wait`` is how long settle waits for the funding depth; ``closed_retention_ms`` how
        long the record of a channel whose close it relayed is kept (default 30 days, plan X-F51)."""
        self._chain = rpc
        self._settlements = settlement_store
        self.channels: ChannelStore = channel_store or InMemoryChannelStore()
        self._limits = confirmations
        self._funding_wait = funding_wait
        self._funding_poll = funding_poll
        self._retention = closed_retention_ms

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """The funding depths it settles, as the ``exact`` facilitator advertises its range."""
        _ = network
        return {"confirmations": {"minimum": self._limits[0], "maximum": self._limits[1]}}

    def get_signers(self, network: Network) -> list[str]:
        """No sponsorship: the facilitator signs nothing."""
        _ = network
        return []

    def verify(self, payload: PaymentPayload, requirements: PaymentRequirements,
               context: FacilitatorContext | None = None) -> VerifyResponse:
        return run_sync(self.averify(payload, requirements, context))

    def settle(self, payload: PaymentPayload, requirements: PaymentRequirements,
               context: FacilitatorContext | None = None) -> SettleResponse:
        return run_sync(self.asettle(payload, requirements, context))

    async def averify(self, payload: PaymentPayload, requirements: PaymentRequirements,
                      context: FacilitatorContext | None = None) -> VerifyResponse:
        _ = context
        try:
            p, terms = self._envelope(payload, requirements)
            ctx = await chain_context(self._chain, terms.network)
            if p["type"] == "open":
                v = await verify_open(p, terms, self._chain, ctx)
                return VerifyResponse(is_valid=True, payer=v.channel_id, extra={"channelId": v.channel_id})
            channel, tx = await self._live_channel(p["tx"], p["channelId"], terms)
            yed = terms.asset == ASSET_YED
            # YED: D is the channel output's token record, read through the voucher's yedIn.
            deposit = await overlay_deposit(self._chain, p["tx"]) if yed else channel.yec_deposit
            cumulative = int(p["cumulative"])
            # The return script is bound when this facilitator relayed the open; a stateless one checks the rest.
            record = await self.channels.get(p["channelId"])
            recorded = (record.data or {}).get("returnScript") if record is not None else None
            check_voucher(tx, channel, cumulative,
                          charged=0,  # the server's charged total is not known here; it applies rule 5 in full
                          amount=terms.amount if p["type"] == "voucher" else 0, deposit=deposit, branch_id=ctx.branch_id,
                          layout=layout_for(terms.asset, deposit), allow_completed=p["type"] == "claim",
                          floor=cumulative_floor(terms.asset),
                          return_script=bytes.fromhex(recorded) if isinstance(recorded, str) else None)
            if p["type"] == "claim":
                await check_completed(self._chain, tx)
            # A voucher's server slot is empty, so only a claim's scripts can verify.
            if yed:
                await check_yed_voucher(self._chain, p["tx"], deposit, cumulative, scripts=p["type"] == "claim")
            return VerifyResponse(is_valid=True, payer=p["channelId"], extra={"channelId": p["channelId"]})
        except Exception as e:  # noqa: BLE001  # every refusal goes back as a wire reason
            return VerifyResponse(is_valid=False, invalid_reason=reason_of(e), invalid_message=str(e))

    async def asettle(self, payload: PaymentPayload, requirements: PaymentRequirements,
                      context: FacilitatorContext | None = None) -> SettleResponse:
        network = requirements.network
        check = await self.averify(payload, requirements, context)
        if not check.is_valid:
            return SettleResponse(success=False, error_reason=check.invalid_reason or BatchError.PAYLOAD,
                                  error_message=check.invalid_message or "", transaction="", network=network)
        p = payload.payload  # validated by averify
        cumulative = int(p["voucher"]["cumulative"] if p["type"] == "open" else p["cumulative"])
        try:
            if p["type"] == "open":
                funding_txid = txid(decode_tx(p["fundingTx"], BatchError.FUNDING))
                channel_id = channel_id_of_parts(funding_txid, int(p["vout"]))
                await self._relay(p["fundingTx"])
                if not await self._wait_for_depth(funding_txid, int(p["vout"]), required_depth(parse_terms(requirements).confirmations)):
                    return SettleResponse(success=False, error_reason=BatchError.SETTLEMENT_PENDING, error_message="funding below the policy depth",
                                          transaction=funding_txid, network=network, payer=channel_id)
                # The return script, so this facilitator binds it in the channel's later vouchers and claims.
                terms = parse_terms(requirements)
                return_script = return_script_of(p["returnAddress"], terms.network, terms.asset,
                                                 address_to_script(terms.pay_to, terms.network))
                await self.channels.open(ChannelRecord(channel_id, 0, {"fundingTxid": funding_txid, "vout": int(p["vout"]),
                                                                       "returnScript": return_script.hex()}))
                return SettleResponse(success=True, transaction=funding_txid, network=network, payer=channel_id, amount="",
                                      extra={"commitmentId": commitment_id_of(channel_id, cumulative)})
            if p["type"] == "voucher":
                return SettleResponse(success=True, transaction="", network=network, payer=p["channelId"], amount="",
                                      extra={"commitmentId": commitment_id_of(p["channelId"], cumulative)})
            if p["type"] == "claim":
                close_txid = txid(bytes.fromhex(p["tx"]))
                if self._settlements is not None and not await self._settlements.claim(txid_key(network, close_txid), RETAIN_FOREVER):
                    raise BatchSettlementError(BatchError.DUPLICATE_SETTLEMENT, close_txid)
                await self._relay(p["tx"])
                await self._record_claim(p["channelId"], cumulative)
                return SettleResponse(success=True, transaction=close_txid, network=network, payer=p["channelId"], amount="",
                                      extra={"commitmentId": commitment_id_of(p["channelId"], cumulative)})
            # Completing a client close needs S, which only the server holds.
            raise BatchSettlementError(BatchError.PAYLOAD_TYPE, "the server completes a client close and sends it as a claim")
        except Exception as e:  # noqa: BLE001
            return SettleResponse(success=False, error_reason=reason_of(e), error_message=str(e), transaction="", network=network)

    def _envelope(self, payload: PaymentPayload, requirements: PaymentRequirements) -> tuple[dict[str, Any], BatchTerms]:
        if payload.x402_version != 2 or not same_offer(payload.accepted, requirements):
            raise BatchSettlementError(BatchError.REQUIREMENTS, "accepted does not match the requirements")
        if not is_batch_payload(payload.payload):
            raise BatchSettlementError(BatchError.PAYLOAD, "not a batch-settlement payload")
        terms = parse_terms(requirements)
        if not self._limits[0] <= terms.confirmations <= self._limits[1]:
            raise BatchSettlementError(BatchError.REQUIREMENTS,
                                       f"confirmations {terms.confirmations} outside [{self._limits[0]}, {self._limits[1]}]")
        if terms.asset == ASSET_YED:
            yed_chain(self._chain)
        return payload.payload, terms

    async def _live_channel(self, tx_hex: str, channel_id: str, terms: BatchTerms) -> tuple[Channel, Tx]:
        """The channel a voucher spends, rebuilt from its scriptSig's redeem script and the live output."""
        tx = decode_tx(tx_hex, BatchError.VOUCHER_SHAPE)
        ss = parse_close_script_sig(tx.vin[0].script_sig) if len(tx.vin) == 1 else None
        if ss is None:
            raise BatchSettlementError(BatchError.VOUCHER_SHAPE, "inputs")
        prevout = tx.vin[0].prevout
        if channel_id_of(prevout) != channel_id:
            raise BatchSettlementError(BatchError.VOUCHER_SHAPE, "the voucher does not spend channelId")
        script = parse_channel_script(ss.redeem_script)
        if script is None or script.server_pubkey != terms.server_pubkey:
            raise BatchSettlementError(BatchError.REDEEM_SCRIPT, ss.redeem_script.hex())
        out = await self._chain.get_tx_out(prevout.txid, prevout.vout, True)
        if not out:
            raise BatchSettlementError(BatchError.CHANNEL_CLOSING, "the channel output is spent or unknown")
        if out["scriptPubKey"]["hex"] != channel_script_pubkey(ss.redeem_script).hex():
            raise BatchSettlementError(BatchError.REDEEM_SCRIPT, "not the channel output's script")
        channel = Channel.from_script(prevout, ss.redeem_script, zat_of(out), terms.close_fee, address_to_script(terms.pay_to, terms.network))
        return channel, tx

    async def _record_claim(self, channel_id: str, cumulative: int) -> None:
        """Records the relayed close's cumulative, and retires the channel's record: it is spent now."""
        if not await self.channels.open(ChannelRecord(channel_id, cumulative)):
            r = await self.channels.get(channel_id)
            if r is not None and r.cumulative < cumulative:
                await self.channels.compare_and_set_cumulative(channel_id, r.cumulative, cumulative)
        await self.channels.retire([channel_id], int(time.time() * 1000) + self._retention)

    async def _relay(self, hex_tx: str) -> None:
        try:
            await self._chain.send_raw_transaction(hex_tx)
        except SendRawTransactionError as e:
            if e.kind != "already-in-chain":
                raise

    async def _wait_for_depth(self, funding_txid: str, vout: int, want: int) -> bool:
        deadline = time.monotonic() + self._funding_wait
        while True:
            out = await self._chain.get_tx_out(funding_txid, vout, True)
            if out and int(out["confirmations"]) >= want:
                return True
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(self._funding_poll)


def channel_id_of_parts(funding_txid: str, vout: int) -> str:
    return f"{funding_txid}:{vout}"
