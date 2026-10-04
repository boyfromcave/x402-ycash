"""Verification rules 1–10 (specs/scheme_exact_ycash.md): one failing case per rule and reason,
against an in-memory node. Mirrors the TypeScript facilitator.verify.test.ts."""

import pytest

from tests.unit.fake_node import NETWORK, FakeNode, Key, build_signed, payment_payload, requirements, standard_payment
from x402_ycash.exact import ExactYcashFacilitatorScheme
from x402_ycash.exact import constants as C
from x402_ycash.store import InMemorySettlementStore, txid_key
from x402_ycash.tx import (
    SIGHASH_ALL,
    SIGHASH_ANYONECANPAY,
    TxOut,
    address_to_script,
    encode_address,
    hash160,
    parse_tx,
    txid,
)
from x402_ycash.tx.transaction import OutputDescription

payer = Key(1)
merchant = Key(2)


@pytest.fixture
def env():
    node = FakeNode()
    store = InMemorySettlementStore()
    return node, store, ExactYcashFacilitatorScheme(node, settlement_store=store)


async def verify(f, hex_tx, req=None, mutate=None):
    req = req or requirements(merchant.address)
    p = payment_payload(req, hex_tx)
    if mutate:
        mutate(p)
    return await f.averify(p, req)


async def test_valid_payment_names_the_payer_and_is_read_only(env):
    node, store, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    r = await verify(f, hex_tx)
    assert r.is_valid and r.payer == payer.address
    assert "sendrawtransaction" not in node.calls
    assert not await store.is_claimed(txid_key(NETWORK, txid(hex_tx)))


# --- rule 1 ----------------------------------------------------------------------------------------

@pytest.mark.parametrize(("field", "value"), [
    ("scheme", "upto"), ("network", "ycash:mainnet"), ("asset", "YED"), ("amount", "1"),
    ("pay_to", payer.address), ("max_timeout_seconds", 60),
])
async def test_rule1_accepted_field_must_equal(env, field, value):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    r = await verify(f, hex_tx, mutate=lambda p: setattr(p.accepted, field, value))
    assert r.invalid_reason == C.ERR_REQUIREMENTS_MISMATCH


async def test_rule1_version_and_extra(env):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    assert (await verify(f, hex_tx, mutate=lambda p: setattr(p, "x402_version", 1))).invalid_reason == C.ERR_REQUIREMENTS_MISMATCH
    r = await verify(f, hex_tx, mutate=lambda p: p.accepted.extra.update(confirmationPolicy={"confirmations": 1}))
    assert r.invalid_reason == C.ERR_REQUIREMENTS_MISMATCH
    # false is not 0: JSON types are compared, not Python truthiness
    r = await verify(f, hex_tx, mutate=lambda p: p.accepted.extra.update(areFeesSponsored=0))
    assert r.invalid_reason == C.ERR_REQUIREMENTS_MISMATCH


async def test_rule1_omitted_method_resolves_to_transparent(env):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    req = requirements(merchant.address)
    del req.extra["assetTransferMethod"]
    r = await verify(f, hex_tx, req, mutate=lambda p: p.accepted.extra.update(assetTransferMethod="transparent"))
    assert r.is_valid


@pytest.mark.parametrize(("extra", "reason"), [
    ({"assetTransferMethod": "sapling"}, C.ERR_ASSET_TRANSFER_METHOD),
    ({"assetTransferMethod": "lightning"}, C.ERR_ASSET_TRANSFER_METHOD),
    ({"paymentFlow": "upfront"}, C.ERR_PAYMENT_FLOW),
    ({"areFeesSponsored": True}, C.ERR_REQUIREMENTS_MISMATCH),
    ({"confirmationPolicy": {"confirmations": 21}}, C.ERR_REQUIREMENTS_MISMATCH),
    ({"confirmationPolicy": {"confirmations": True}}, C.ERR_REQUIREMENTS_MISMATCH),
    ({"confirmationPolicy": {"confirmations": 1, "x": 1}}, C.ERR_REQUIREMENTS_MISMATCH),
])
async def test_rule1_method_flow_fees_policy(env, extra, reason):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    assert (await verify(f, hex_tx, requirements(merchant.address, **extra))).invalid_reason == reason


async def test_rule1_mempool_policy_needs_opt_in(env):
    node, store, _ = env
    f = ExactYcashFacilitatorScheme(node, settlement_store=store, accept_mempool=False)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_REQUIREMENTS_MISMATCH
    assert f.get_extra(NETWORK)["confirmations"] == {"minimum": 0, "maximum": 20}


async def test_rule1_forms(env):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    yed = requirements(merchant.address)
    yed.asset = "YED"
    assert (await verify(f, hex_tx, yed)).invalid_reason == C.ERR_YED_NODE_REQUIRED
    for amount in ("53", "0250000", "1.5"):
        assert (await verify(f, hex_tx, requirements(merchant.address, amount))).invalid_reason == C.ERR_REQUIREMENTS_MISMATCH
    ye = encode_address(NETWORK, "yed", hash160(merchant.pub))
    assert (await verify(f, hex_tx, requirements(ye))).invalid_reason == C.ERR_REQUIREMENTS_MISMATCH


# --- rules 2-5 -------------------------------------------------------------------------------------

async def test_rule2_network(env):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    node.chain = "test"
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_NETWORK_MISMATCH


async def test_rule3_decoding(env):
    node, _, f = env
    hex_tx, coin = standard_payment(node, payer, merchant.address)
    assert (await verify(f, hex_tx.upper())).invalid_reason == C.ERR_TRANSACTION
    assert (await verify(f, hex_tx + "00")).invalid_reason == C.ERR_TRANSACTION
    assert (await verify(f, "01000000" + hex_tx[8:])).invalid_reason == C.ERR_TRANSACTION
    outs = parse_tx(hex_tx).vout
    locked = build_signed([(coin, 10_000_000, payer.script)], payer.priv, outs, node.tip + 7, lock_time=1)
    assert (await verify(f, locked)).invalid_reason == C.ERR_TRANSACTION

    def shield(tx):
        tx.shielded_outputs = [OutputDescription(bytes(32), bytes(32), bytes(32), bytes(580), bytes(80), bytes(192))]
        tx.binding_sig = bytes(64)
    shielded = build_signed([(coin, 10_000_000, payer.script)], payer.priv, outs, node.tip + 7, mutate=shield)
    assert (await verify(f, shielded)).invalid_reason == C.ERR_TRANSACTION
    small = ExactYcashFacilitatorScheme(node, max_transaction_bytes=100)
    assert (await verify(small, hex_tx)).invalid_reason == C.ERR_TRANSACTION


async def test_rule4_recipient_and_amount(env):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, Key(3).address)
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_RECIPIENT_MISMATCH
    twice, _ = standard_payment(node, payer, merchant.address,
                                extra_outputs=[TxOut(250_000, address_to_script(merchant.address, NETWORK))])
    assert (await verify(f, twice)).invalid_reason == C.ERR_RECIPIENT_MISMATCH
    wrong, _ = standard_payment(node, payer, merchant.address, amount=250_001)
    assert (await verify(f, wrong)).invalid_reason == C.ERR_AMOUNT_MISMATCH


async def test_rule4_p2sh_pay_to(env):
    node, _, f = env
    p2sh = encode_address(NETWORK, "p2sh", bytes(range(20)))
    hex_tx, _ = standard_payment(node, payer, p2sh)
    assert (await verify(f, hex_tx, requirements(p2sh))).is_valid


async def test_rule5_sighash_all_only(env):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address, hash_type=SIGHASH_ALL | SIGHASH_ANYONECANPAY)
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_SIGHASH
    tx = parse_tx(standard_payment(node, payer, merchant.address)[0])
    tx.vin[0].script_sig = b""
    assert (await verify(f, tx.serialize_hex())).invalid_reason == C.ERR_SIGHASH


# --- rules 6-10 ------------------------------------------------------------------------------------

async def test_rule6_inputs(env):
    node, _, f = env
    hex_tx, coin = standard_payment(node, payer, merchant.address)
    del node.utxos[f"{coin.txid}:0"]
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_INPUT_SPENT
    unconfirmed, _ = standard_payment(node, payer, merchant.address, confirmations=0)
    assert (await verify(f, unconfirmed)).invalid_reason == C.ERR_INPUT_SPENT
    hex_tx, coin = standard_payment(node, payer, merchant.address)
    node.accept_to_mempool(build_signed([(coin, 10_000_000, payer.script)], payer.priv,
                                        [TxOut(9_990_000, payer.script)], node.tip + 10))
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_INPUT_SPENT


async def test_rule7_fee(env):
    node, _, f = env
    assert (await verify(f, standard_payment(node, payer, merchant.address, fee=999)[0])).invalid_reason == C.ERR_FEE_TOO_LOW
    assert (await verify(f, standard_payment(node, payer, merchant.address, fee=100_001)[0])).invalid_reason == C.ERR_FEE_TOO_HIGH
    assert (await verify(f, standard_payment(node, payer, merchant.address, fee=1_000)[0])).is_valid
    assert (await verify(f, standard_payment(node, payer, merchant.address, fee=100_000)[0])).is_valid


async def test_rule8_expiry_window(env):
    node, _, f = env
    tip = node.tip  # window for 300 s: [tip + 4, tip + 4 + 4 + 1]
    for expiry, ok in ((0, False), (tip + 3, False), (tip + 4, True), (tip + 9, True), (tip + 10, False)):
        r = await verify(f, standard_payment(node, payer, merchant.address, expiry=expiry)[0])
        assert r.is_valid is ok, expiry
        if not ok:
            assert r.invalid_reason == C.ERR_EXPIRY


async def test_rule9_scripts(env):
    node, _, f = env
    tx = parse_tx(standard_payment(node, payer, merchant.address)[0])
    sig = bytearray(tx.vin[0].script_sig)
    sig[10] ^= 1
    tx.vin[0].script_sig = bytes(sig)
    assert (await verify(f, tx.serialize_hex())).invalid_reason == C.ERR_SCRIPT
    coin = node.add_coin(10_000_000, payer.script)
    outs = [TxOut(250_000, address_to_script(merchant.address, NETWORK)), TxOut(9_749_000, payer.script)]
    other = build_signed([(coin, 10_000_000, payer.script)], Key(9).priv, outs, node.tip + 7)
    assert (await verify(f, other)).invalid_reason == C.ERR_SCRIPT


async def test_rule9y_yed_inputs(env):
    node, _, f = env
    hex_tx, coin = standard_payment(node, payer, merchant.address)
    node.yellowback = True
    assert (await verify(f, hex_tx)).is_valid
    node.yed_cents[f"{coin.txid}:0"] = 500
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_YED_INPUT


async def test_rule9y_not_asked_on_a_stock_node(env):
    node, _, f = env
    await verify(f, standard_payment(node, payer, merchant.address)[0])
    assert "yed_validaterawtransaction" not in node.calls


async def test_rule10_claimed_is_duplicate(env):
    node, store, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    await store.claim(txid_key(NETWORK, txid(hex_tx)), 400)
    await node.send_raw_transaction(hex_tx)
    r = await verify(f, hex_tx)
    assert r.invalid_reason == C.ERR_DUPLICATE_SETTLEMENT and r.payer == payer.address


async def test_rule_order(env):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address, amount=1, fee=1)
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_AMOUNT_MISMATCH


async def test_node_failure_is_settlement_failed(env):
    node, _, f = env
    hex_tx, _ = standard_payment(node, payer, merchant.address)

    async def boom():
        raise OSError("connection refused")
    node.get_blockchain_info = boom
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_SETTLEMENT_FAILED
