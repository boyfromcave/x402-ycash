"""The network fee of PQ and Yellowback transactions (rpcversion 8): the node's
yed_getinfo.params.fees.network rates, the facilitator's cap and allowhighfees, the YED builder, the
channel close fee and relay. Mirrors packages/ycash/test/unit/tx.networkFee.test.ts. Fixture:
ycash-dd q/fees (6cb0ac5db) doc/yellowback-rpc-contract.json."""

import pytest

from tests.unit.fake_node import FakeNode, build_signed, payment_payload
from tests.unit.test_exact_yed import merchant, payer, yed_requirements
from x402_ycash.batch.relay import send_channel_transaction
from x402_ycash.channel import yed_close_network_fee
from x402_ycash.exact import ExactYcashFacilitatorScheme
from x402_ycash.exact import constants as C
from x402_ycash.node import RpcError, SendRawTransactionError, classify_send_error
from x402_ycash.store import InMemorySettlementStore
from x402_ycash.tx import (
    OutPoint,
    Tx,
    TxIn,
    TxOut,
    fee_floor,
    needs_high_fees,
    network_fee,
    network_fee_cap,
    network_fees_of,
    size_fee,
)
from x402_ycash.yed import Assignment, transfer_op_return_script
from x402_ycash.yed.build import TokenCoin, TransferRecipient, YecCoin, build_yed_transfer

NETWORK_FEES = {
    "priceMicroUsd": 400000, "priceSource": "tip",
    "plain": {"usdPerKBMicro": 20000, "zatPerKB": 5000000},
    "yellowback": {"usdPerKBMicro": 50000, "zatPerKB": 12500000, "maxTxFeeUsdMicro": 2000000,
                   "maxTxFeeCeilingZat": 1000000000, "maxTxFeeZat": 1000000000},
    "floorZatPerKB": 5000, "fallbackZatPerKB": 100, "flatZat": 1000, "maxTxFeeZat": 10000000,
}
FEES = network_fees_of({"rpcversion": 8, "params": {"fees": {"network": NETWORK_FEES}}})
assert FEES is not None


def draft(script_sig_bytes: int) -> Tx:
    return Tx(vin=[TxIn(OutPoint("00" * 32, 0), bytes(script_sig_bytes))], vout=[TxOut(1, bytes(25))])


def test_network_fees_of():
    assert FEES.plain_zat_per_kb == 5_000_000 and FEES.yellowback_zat_per_kb == 12_500_000
    assert FEES.max_tx_fee_zat == 10_000_000 and FEES.yellowback_max_tx_fee_zat == 1_000_000_000 and FEES.flat_zat == 1000
    assert network_fees_of({"rpcversion": 7, "params": {"fees": {"network": NETWORK_FEES}}}) is None
    assert network_fees_of({"rpcversion": 8, "params": {}}) is None
    fb = network_fees_of({"rpcversion": 8, "params": {"fees": {"network": {**NETWORK_FEES, "priceMicroUsd": None, "priceSource": "fallback"}}}})
    assert fb is not None and fb.price_micro_usd is None and fb.price_source == "fallback"


def test_network_fee_rule():
    assert size_fee(12_500_000, 1234) == 15_425_000 and size_fee(100, 5) == 100
    tx = draft(1650)
    size = len(tx.serialize())
    assert network_fee(tx, "plain", FEES) == fee_floor(tx)
    assert network_fee(tx, "yellowback", None) == fee_floor(tx)
    assert network_fee(tx, "pq", FEES) == 5_000_000 * size // 1000
    assert network_fee(tx, "yellowback", FEES) == 12_500_000 * size // 1000
    assert network_fee_cap("plain", 100_000, FEES) == 100_000
    assert network_fee_cap("yellowback", 100_000, FEES) == 1_000_000_000
    assert not needs_high_fees(10_000_000, "yellowback", FEES)
    assert needs_high_fees(10_000_001, "yellowback", FEES)
    assert not needs_high_fees(1_000_000_001, "yellowback", FEES)


def test_yed_builder_pays_the_yellowback_rate():
    tok = TokenCoin(OutPoint("11" * 32, 0), 5_000, 10_000, payer.script)
    yec = YecCoin(OutPoint("22" * 32, 0), 100_000_000, payer.script)
    without = build_yed_transfer([TransferRecipient(merchant.script, 2_500)], [tok], [yec], payer.script, payer.script)
    priced = build_yed_transfer([TransferRecipient(merchant.script, 2_500)], [tok], [yec], payer.script, payer.script, network_fees=FEES)
    assert without.fee >= fee_floor(without.tx)
    assert priced.fee > 1_000_000 > without.fee


def high_fee_payment(node: FakeNode, fee: int) -> str:
    token = node.add_coin(10_000, payer.script)
    node.yed_cents[f"{token.txid}:0"] = 1_000
    coin = node.add_coin(500_000_000, payer.script)
    outs = [TxOut(10_000, merchant.script), TxOut(10_000, payer.script),
            TxOut(0, transfer_op_return_script([Assignment(0, 250), Assignment(1, 750)])),
            TxOut(500_000_000 - 10_000 - fee, payer.script)]
    return build_signed([(token, 10_000, payer.script), (coin, 500_000_000, payer.script)], payer.priv, outs, node.tip + 7)


@pytest.fixture
def env():
    node = FakeNode()
    node.yellowback = True
    node.network_fees = NETWORK_FEES
    f = ExactYcashFacilitatorScheme(node, settlement_store=InMemorySettlementStore(), yellowback=True,
                                    confirmation_timeout=0.2, confirmation_poll=0.05)
    return node, f


async def test_yed_fee_above_the_plain_cap_is_settled_with_allowhighfees(env):
    node, f = env
    req = yed_requirements(confirmationPolicy={"confirmations": -1})
    hex_tx = high_fee_payment(node, 50_000_000)
    v = await f.averify(payment_payload(req, hex_tx), req)
    assert v.is_valid, v
    await f.asettle(payment_payload(req, hex_tx), req)
    assert node.allow_high_fees == [True]


async def test_yed_fee_above_the_yellowback_cap_is_refused(env):
    node, f = env
    node.network_fees = {**NETWORK_FEES, "yellowback": {**NETWORK_FEES["yellowback"], "maxTxFeeZat": 1_000_000}}
    req = yed_requirements()
    v = await f.averify(payment_payload(req, high_fee_payment(node, 5_000_000)), req)
    assert not v.is_valid and v.invalid_reason == C.ERR_FEE_TOO_HIGH


async def test_without_rates_the_plain_cap_stands(env):
    node, f = env
    node.network_fees = None
    req = yed_requirements()
    v = await f.averify(payment_payload(req, high_fee_payment(node, 5_000_000)), req)
    assert not v.is_valid and v.invalid_reason == C.ERR_FEE_TOO_HIGH


def test_close_fee_and_absurd_fee_classification():
    assert yed_close_network_fee(False, FEES) > yed_close_network_fee(True, FEES) > 12_000
    assert yed_close_network_fee(True, None) < 12_000
    assert classify_send_error(-26, "AcceptToMemoryPool: absurdly high fees ab, 50000000 > 10000000") == "absurd-fee"
    assert classify_send_error(-26, "absurdly-high-fee") == "absurd-fee"


async def test_relay_retries_a_yed_channel_transaction_with_allowhighfees():
    calls: list[bool] = []

    class Chain:
        async def send_raw_transaction(self, hex_tx: str, allow_high_fees: bool = False) -> str:
            calls.append(allow_high_fees)
            if not allow_high_fees:
                raise SendRawTransactionError(RpcError(-26, "256: absurdly-high-fee", "sendrawtransaction"))
            return hex_tx

    assert await send_channel_transaction(Chain(), "aa", True) == "aa"
    assert calls == [False, True]
    with pytest.raises(SendRawTransactionError):
        await send_channel_transaction(Chain(), "aa", False)

