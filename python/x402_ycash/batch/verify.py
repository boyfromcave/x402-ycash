"""The stateless verification rules shared by the server and a facilitator
(specs/scheme_batch_settlement_ycash.md, "Verification"). State (charged total, stored voucher,
in-flight lock) lives in the server's ledger. Mirrors packages/ycash/src/batch/verify.ts."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar

from ..channel import (
    Channel,
    VoucherLayout,
    channel_id_of,
    channel_script_pubkey,
    check_voucher_shape,
    parse_channel_script,
    verify_voucher_signature,
    yec_voucher_outputs,
)
from ..channel.yed import YED_TRANSFER_VOUT, yed_channel_value, yed_voucher_assignments, yed_voucher_layout
from ..constants import (
    ASSET_YEC,
    ASSET_YED,
    TX_EXPIRING_SOON_THRESHOLD,
    YED_MAX_OUTPUT_CENTS,
    YED_MIN_OUTPUT_CENTS,
    chain_of_network,
)
from ..node import RPC_METHOD_NOT_FOUND, RpcError, VerifyScriptsResult
from ..tx import OutPoint, Tx, address_to_script, fee_floor, parse_tx, tx_fee, txid
from ..yed import (
    FindPayloadFailure,
    assigned_to,
    check_transfer_verdict,
    decoded_transfer_of,
    find_payload,
    same_assignments,
    validate_transfer_assignments,
)
from .errors import BatchError, BatchSettlementError
from .return_address import return_script_of
from .types import BatchTerms, required_depth

T = TypeVar("T")


class ChainView(Protocol):
    """The node calls verification needs; YcashRpc satisfies it (and the overlay's, for YED)."""

    async def get_block_count(self) -> int: ...
    async def get_blockchain_info(self) -> dict[str, Any]: ...
    async def get_tx_out(self, txid: str, n: int, include_mempool: bool) -> dict[str, Any] | None: ...
    async def verify_scripts(self, hex_tx: str) -> VerifyScriptsResult: ...
    async def send_raw_transaction(self, hex_tx: str) -> str: ...


def yed_chain(chain: Any) -> Any:
    """The chain as a Yellowback node (its overlay RPCs exist), or YED_NODE_REQUIRED."""
    if not callable(getattr(chain, "yed_validate_raw_transaction", None)) or not callable(getattr(chain, "yed_decode_payload", None)):
        raise BatchSettlementError(BatchError.YED_NODE_REQUIRED, "YED channels need a Yellowback node")
    return chain


async def _overlay(call: Callable[[], Awaitable[T]]) -> T:
    """A stock node answers the overlay's RPCs with −32601: that is YED_NODE_REQUIRED, not a verdict."""
    try:
        return await call()
    except RpcError as e:
        if e.code == RPC_METHOD_NOT_FOUND and not e.transport:
            raise BatchSettlementError(BatchError.YED_NODE_REQUIRED, "the node does not run -experimentalfeatures -yellowback") from e
        raise


def layout_for(asset: str, deposit: int) -> VoucherLayout:
    """The voucher outputs of a channel of ``asset`` holding D (YEC: zatoshis; YED: cents)."""
    if asset == ASSET_YEC:
        return yec_voucher_outputs
    if asset == ASSET_YED:
        return yed_voucher_layout(deposit)
    raise BatchSettlementError(BatchError.REQUIREMENTS, f"no channel layout for {asset}")


def cumulative_floor(asset: str) -> int:
    """The least cumulative a voucher may carry: $1.00 for YED (the dollar floor, X-7), none for YEC."""
    return YED_MIN_OUTPUT_CENTS if asset == ASSET_YED else 0


def close_cumulative(asset: str, charged: int) -> int:
    """The cumulative of a client ``close`` at the charged total: never below the floor (the pre-paid
    dollar is the server's)."""
    return max(charged, cumulative_floor(asset))


def is_exhausted(asset: str, deposit: int, charged: int, ceiling: int, latest_cumulative: int) -> bool:
    """Whether the server should close after a charge (scheme "Close triggers"): the next voucher at
    the ceiling would exceed D, or, for YED, would leave the client a remainder in (0, $1.00), or the
    latest voucher already assigns all of D to the server."""
    if asset != ASSET_YED:
        return latest_cumulative >= deposit or charged + ceiling > deposit
    nxt = max(charged + ceiling, YED_MIN_OUTPUT_CENTS)
    left = deposit - nxt
    return nxt > deposit or 0 < left < YED_MIN_OUTPUT_CENTS or deposit - latest_cumulative < YED_MIN_OUTPUT_CENTS


async def check_yed_voucher(chain: Any, hex_tx: str, deposit: int, cumulative: int, scripts: bool = True) -> None:
    """The overlay's checks of a YED voucher (scheme "Verification adds"): ``yed_decodepayload`` finds
    exactly the split at vout 2, and ``yed_validaterawtransaction`` reports a transfer, verdict ok,
    burned 0, yedIn = yedOut = D, no unconfirmed input. ``scripts`` is False for a voucher whose server
    slot is still empty (a facilitator's ``voucher``): its scripts cannot verify yet."""
    node = yed_chain(chain)
    decoded = decoded_transfer_of(await _overlay(lambda: node.yed_decode_payload(hex_tx)))
    if decoded is None or decoded.op_return_index != YED_TRANSFER_VOUT or not same_assignments(
            decoded.assignments, yed_voucher_assignments(deposit, cumulative)):
        raise BatchSettlementError(BatchError.YED_VERDICT, "yed_decodepayload does not find the voucher's split at vout 2")
    problem = check_transfer_verdict(await _overlay(lambda: node.yed_validate_raw_transaction(hex_tx)), yed_in=deposit, scripts=scripts)
    if problem is not None:
        raise BatchSettlementError(BatchError.SCRIPT if problem.problem == "scripts" else BatchError.YED_VERDICT, problem.message)


async def overlay_deposit(chain: Any, voucher_hex: str) -> int:
    """The channel's D as the overlay records it: the yedIn of a voucher spending it."""
    node = yed_chain(chain)
    v = await _overlay(lambda: node.yed_validate_raw_transaction(voucher_hex))
    if v.get("unconfirmedInputs"):
        raise BatchSettlementError(BatchError.FUNDING_DEPTH, "the channel's funding is not in a block (plan X-F14)")
    yed_in = v.get("yedIn")
    if not isinstance(yed_in, int) or yed_in < YED_MIN_OUTPUT_CENTS:
        raise BatchSettlementError(BatchError.YED_VERDICT, f"the channel output holds {yed_in} cents of YED")
    return yed_in


@dataclass(frozen=True)
class ChainContext:
    tip: int
    branch_id: int
    """The branch id the next block signs under (getblockchaininfo.consensus.nextblock)."""


async def chain_context(chain: ChainView, network: str) -> ChainContext:
    """The node's chain matches the network, and the branch id vouchers are signed under."""
    info = await chain.get_blockchain_info()
    if info["chain"] != chain_of_network(network):
        raise BatchSettlementError(BatchError.NETWORK, f"node is on {info['chain']}, not {network}")
    return ChainContext(int(info["blocks"]), int(info["consensus"]["nextblock"], 16))


def decode_tx(hex_tx: str, reason: str) -> Tx:
    """A canonical v4 transaction, or ``reason``."""
    try:
        tx = parse_tx(hex_tx)
        if tx.serialize_hex() != hex_tx:
            raise ValueError("not canonical")
    except ValueError as e:
        raise BatchSettlementError(reason, str(e)) from e
    return tx


def zat_of(out: dict[str, Any]) -> int:
    return int(out["value_zat"])


@dataclass(frozen=True)
class VerifiedOpen:
    channel: Channel
    channel_id: str
    funding_tx: Tx
    funding_txid: str
    deposit: int
    """D, in the asset's unit."""
    return_script: bytes
    """The client's output script in every voucher, from ``returnAddress``."""
    already_broadcast: bool
    """The funding output already exists (in the mempool or a block)."""


def min_funding_expiry(tip: int, confirmations: int) -> int:
    """The least funding ``nExpiryHeight`` a server accepts at ``tip`` (0, never, is also accepted): the
    funding must still relay at the next block, which refuses an expiry below next + 3
    (TX_EXPIRING_SOON_THRESHOLD; ycash-dd/src/main.cpp:742, ycash6 :799), and leave one block per
    confirmation of the policy depth."""
    return tip + TX_EXPIRING_SOON_THRESHOLD + required_depth(confirmations)


async def verify_open(p: dict[str, Any], terms: BatchTerms, chain: ChainView, ctx: ChainContext) -> VerifiedOpen:
    """Open rules 2–8, and voucher rules 4–6 for the first voucher (rule 9). Read-only: nothing is
    relayed. Rule 1 (the envelope) is the caller's."""
    yed = terms.asset == ASSET_YED
    if yed:
        yed_chain(chain)
    # 2. the redeem script
    rs = bytes.fromhex(p["redeemScript"])
    script = parse_channel_script(rs)
    if script is None:
        raise BatchSettlementError(BatchError.REDEEM_SCRIPT, "not the channel script")
    if script.server_pubkey != terms.server_pubkey:
        raise BatchSettlementError(BatchError.REDEEM_SCRIPT, "S is not extra.serverPubKey")
    if script.refund_height < ctx.tip + terms.min_lock_blocks:
        raise BatchSettlementError(BatchError.REDEEM_SCRIPT,
                                   f"t = {script.refund_height} is below tip + minLockBlocks = {ctx.tip + terms.min_lock_blocks}")
    # 3. the funding transaction
    funding = decode_tx(p["fundingTx"], BatchError.FUNDING)
    if funding.has_shielded() or funding.value_balance != 0 or funding.lock_time != 0:
        raise BatchSettlementError(BatchError.FUNDING, "the funding tx must be transparent with nLockTime 0")
    vout = int(p["vout"])
    if vout >= len(funding.vout) or funding.vout[vout].script_pubkey != channel_script_pubkey(rs):
        raise BatchSettlementError(BatchError.FUNDING, f"vout {vout} does not pay the channel script")
    funding_txid = txid(funding)
    pay_to_script = address_to_script(terms.pay_to, terms.network)
    # 7. the return address
    return_script = return_script_of(p["returnAddress"], terms.network, terms.asset, pay_to_script)
    channel = Channel.from_script(OutPoint(funding_txid, vout), rs, funding.vout[vout].value, terms.close_fee, pay_to_script)
    # 4. the deposit: V − closeFee for YEC; for YED the cents the funding TRANSFER assigns the channel
    deposit = _yed_funding_deposit(funding, vout, channel.value, terms.close_fee) if yed else channel.yec_deposit
    if deposit <= 0:
        raise BatchSettlementError(BatchError.FUNDING, "V does not cover the close fee")
    if deposit > terms.max_deposit:
        raise BatchSettlementError(BatchError.DEPOSIT_TOO_LARGE, f"D = {deposit} > {terms.max_deposit}")
    # 5–6. unspent inputs, fee floor, scripts — or the funding output already exists
    existing = await chain.get_tx_out(funding_txid, vout, True)
    # 8. the funding expiry: until the funding is in a block, it must be able to land and reach the
    # policy depth before it expires (an unrelayed funding then frees the client's coins by height).
    least = min_funding_expiry(ctx.tip, terms.confirmations)
    if (not existing or int(existing["confirmations"]) == 0) and funding.expiry_height != 0 and funding.expiry_height < least:
        raise BatchSettlementError(BatchError.FUNDING, f"the funding expires at {funding.expiry_height}, before {least}")
    if not existing:
        values: list[int] = []
        for i in funding.vin:
            confirmed = await chain.get_tx_out(i.prevout.txid, i.prevout.vout, False)
            live = await chain.get_tx_out(i.prevout.txid, i.prevout.vout, True)
            if not confirmed or not live:
                raise BatchSettlementError(BatchError.FUNDING, f"input {i.prevout.txid}:{i.prevout.vout} is spent or unconfirmed")
            values.append(zat_of(confirmed))
        fee = tx_fee(funding, values)
        if fee < fee_floor(funding):
            raise BatchSettlementError(BatchError.FUNDING, f"fee {fee} is below the floor {fee_floor(funding)}")
        scripts = await chain.verify_scripts(p["fundingTx"])
        if not scripts.complete or scripts.errors:
            raise BatchSettlementError(BatchError.FUNDING, "the funding scripts do not verify")
    # The overlay's view of the funding TRANSFER while its inputs are still in the UTXO set (not
    # broadcast, or in the mempool). Once mined, the first voucher's yedIn = D is the check.
    if yed and (not existing or int(existing["confirmations"]) == 0):
        await _check_yed_funding(chain, p["fundingTx"], vout, deposit)
    # 9. the first voucher, rules 4–6 (charged is 0), its client output paying returnAddress
    cumulative = int(p["voucher"]["cumulative"])
    check_voucher(decode_tx(p["voucher"]["tx"], BatchError.VOUCHER_SHAPE), channel, cumulative, charged=0, amount=terms.amount,
                  deposit=deposit, branch_id=ctx.branch_id, layout=layout_for(terms.asset, deposit), floor=cumulative_floor(terms.asset),
                  return_script=return_script)
    return VerifiedOpen(channel, channel_id_of(channel.outpoint), funding, funding_txid, deposit, return_script, existing is not None)


def _yed_funding_deposit(funding: Tx, vout: int, value: int, close_fee: int) -> int:
    """D of a YED channel from its funding transaction (scheme "YED Channels", Funding): V is exactly
    2 × TOKEN_VALUE + closeFee, and the one TRANSFER assigns the channel output D cents in
    [$1.00, $100,000], with assignments the overlay registers."""
    if value != yed_channel_value(close_fee):
        raise BatchSettlementError(BatchError.FUNDING, f"a YED channel output carries 2 × TOKEN_VALUE + closeFee = "
                                                       f"{yed_channel_value(close_fee)} zatoshis, not {value}")
    found = find_payload([o.script_pubkey for o in funding.vout])
    if found is None or isinstance(found, FindPayloadFailure) or found.payload.type != "transfer":
        raise BatchSettlementError(BatchError.FUNDING, "the funding transaction carries no TRANSFER")
    check = validate_transfer_assignments(found.payload.assignments, len(funding.vout), found.index)
    if not check.valid:
        raise BatchSettlementError(BatchError.FUNDING, f"the funding TRANSFER would burn ({check.error})")
    d = assigned_to(found.payload.assignments, vout)
    if d is None or not YED_MIN_OUTPUT_CENTS <= d <= YED_MAX_OUTPUT_CENTS:
        raise BatchSettlementError(BatchError.FUNDING, f"the funding TRANSFER does not assign the channel output (vout {vout})")
    return d


async def _check_yed_funding(chain: Any, hex_tx: str, vout: int, deposit: int) -> None:
    """The overlay agrees: the funding TRANSFER decodes the same and burns nothing (verdict ok)."""
    node = yed_chain(chain)
    decoded = decoded_transfer_of(await _overlay(lambda: node.yed_decode_payload(hex_tx)))
    if decoded is None or assigned_to(decoded.assignments, vout) != deposit:
        raise BatchSettlementError(BatchError.FUNDING, "yed_decodepayload does not assign D to the channel output")
    problem = check_transfer_verdict(await _overlay(lambda: node.yed_validate_raw_transaction(hex_tx)))
    if problem is not None:
        code = BatchError.FUNDING if problem.problem == "unconfirmed_input" else BatchError.YED_VERDICT
        raise BatchSettlementError(code, f"funding: {problem.message}")


def check_voucher(tx: Tx, channel: Channel, cumulative: int, *, charged: int, amount: int, deposit: int, branch_id: int,
                  layout: VoucherLayout = yec_voucher_outputs, allow_completed: bool = False, floor: int | None = None,
                  return_script: bytes | None = None) -> None:
    """Voucher rules 4 (shape), 5 (charged + amount ≤ cumulative ≤ D, plan X-F16) and 6 (sigC); YED adds
    the floor (cumulative ≥ $1.00, X-7). ``return_script`` is the channel's bound client script (from
    ``returnAddress``); only a verifier that never saw the open leaves it out."""
    if cumulative > deposit:
        raise BatchSettlementError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT, f"{cumulative} > D = {deposit}")
    if floor is not None and cumulative < floor:
        raise BatchSettlementError(BatchError.YED_FLOOR, f"cumulative {cumulative} is below the $1.00 floor")
    shape = check_voucher_shape(tx, channel, cumulative, layout, allow_completed, return_script)
    if shape is not None:
        raise BatchSettlementError(BatchError.VOUCHER_SHAPE, shape)
    if cumulative < charged + amount:
        raise BatchSettlementError(BatchError.CUMULATIVE_MISMATCH, f"{cumulative} < charged {charged} + amount {amount}")
    if not verify_voucher_signature(tx, channel, branch_id):
        raise BatchSettlementError(BatchError.VOUCHER_SIGNATURE)


async def check_completed(chain: ChainView, completed: Tx) -> str:
    """Rule 7: the completed voucher passes the node's script verifier (signrawtransaction hex [] [])."""
    hex_tx = completed.serialize_hex()
    r = await chain.verify_scripts(hex_tx)
    if not r.complete or r.errors:
        raise BatchSettlementError(BatchError.SCRIPT, str(r.errors[0].get("error")) if r.errors else "incomplete")
    return hex_tx
