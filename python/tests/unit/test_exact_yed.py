"""YED exact (rules 4Y and 9Y, spec "Assets and Amounts"): the facilitator against an in-memory
Yellowback node, and the server's YED prices. Mirrors the YED cases of the TypeScript
facilitator.verify.test.ts and server.test.ts."""

import pytest
from x402.schemas import AssetAmount, PaymentRequirements, SupportedKind

from tests.unit.fake_node import NETWORK, FakeNode, Key, build_signed, payment_payload
from x402_ycash.exact import ExactYcashFacilitatorScheme, ExactYcashServerScheme
from x402_ycash.exact import constants as C
from x402_ycash.store import InMemorySettlementStore
from x402_ycash.tx import TxOut, encode_address, hash160, txid
from x402_ycash.yed import Assignment, transfer_op_return_script

payer = Key(1)
merchant = Key(2)
MERCHANT_YE = encode_address(NETWORK, "yed", hash160(merchant.pub))
PAYER_YE = encode_address(NETWORK, "yed", hash160(payer.pub))


def yed_requirements(amount: str = "250", **extra) -> PaymentRequirements:
    return PaymentRequirements(scheme="exact", network=NETWORK, asset="YED", amount=amount, pay_to=MERCHANT_YE,
                               max_timeout_seconds=300,
                               extra={"assetTransferMethod": "transparent", "areFeesSponsored": False,
                                      "confirmationPolicy": {"confirmations": 1}, **extra})


def yed_payment(node: FakeNode, assignments: list[Assignment] | None = None, token_cents: int = 1_000,
                op_return: bool = True, pay_value: int = 10_000) -> str:
    """Input 0 the payer's token output, input 1 a YEC coin; outputs payTo, the payer's YED change,
    the TRANSFER and YEC change (the SDK's layout)."""
    token = node.add_coin(10_000, payer.script)
    node.yed_cents[f"{token.txid}:0"] = token_cents
    fee_coin = node.add_coin(1_000_000, payer.script)
    assignments = assignments if assignments is not None else [Assignment(0, 250), Assignment(1, token_cents - 250)]
    outs = [TxOut(pay_value, merchant.script), TxOut(10_000, payer.script)]
    if op_return:
        outs.append(TxOut(0, transfer_op_return_script(assignments)))
    outs.append(TxOut(10_000 + 1_000_000 - pay_value - 10_000 - 2_000, payer.script))
    return build_signed([(token, 10_000, payer.script), (fee_coin, 1_000_000, payer.script)], payer.priv, outs, node.tip + 7)


@pytest.fixture
def env():
    node = FakeNode()
    node.yellowback = True
    f = ExactYcashFacilitatorScheme(node, settlement_store=InMemorySettlementStore(), yellowback=True,
                                    confirmation_timeout=0.5, confirmation_poll=0.05)
    return node, f


async def verify(f, hex_tx, req=None):
    req = req or yed_requirements()
    return await f.averify(payment_payload(req, hex_tx), req)


async def test_valid_yed_payment_names_the_ye_payer_and_settles(env):
    node, f = env
    hex_tx = yed_payment(node)
    r = await verify(f, hex_tx)
    assert r.is_valid, r
    assert r.payer == PAYER_YE
    assert node.calls.count("yed_decodepayload") == 1 and "yed_validaterawtransaction" in node.calls
    req = yed_requirements()
    node.mine()  # the settle's broadcast lands in the next block
    first = await f.asettle(payment_payload(req, hex_tx), req)
    assert first.error_reason == C.ERR_SETTLEMENT_PENDING  # policy 1, still in the mempool
    node.mine()
    s = await f.asettle(payment_payload(req, hex_tx), req)
    assert s.success and s.transaction == txid(hex_tx) and s.payer == PAYER_YE
    assert node.yed_cents[f"{txid(hex_tx)}:0"] == 250  # the merchant's token record


async def test_a_stock_node_refuses_yed_first():
    stock = FakeNode()
    hex_tx = yed_payment(stock)
    r = await verify(ExactYcashFacilitatorScheme(stock), hex_tx)
    assert r.invalid_reason == C.ERR_YED_NODE_REQUIRED
    assert stock.calls == []  # refused before any chain lookup beyond capabilities


async def test_supported_lists_yed_only_for_a_yellowback_node(env):
    _, f = env
    assert f.get_extra(NETWORK)["assets"] == ["YEC", "YED"]
    assert ExactYcashFacilitatorScheme(FakeNode()).get_extra(NETWORK)["assets"] == ["YEC"]


@pytest.mark.parametrize(("amount", "pay_to"), [("50", None), ("10000001", None), ("250", "yec")])
async def test_requirement_forms(env, amount, pay_to):
    node, f = env
    req = yed_requirements(amount)
    if pay_to == "yec":
        req.pay_to = merchant.address  # a YED payTo must be ye…/yr…
    assert (await verify(f, yed_payment(node), req)).invalid_reason == C.ERR_REQUIREMENTS_MISMATCH


async def test_rule4y_no_payload_and_wrong_assignment(env):
    node, f = env
    assert (await verify(f, yed_payment(node, op_return=False))).invalid_reason == C.ERR_YED_PAYLOAD
    two = yed_payment(node, [Assignment(0, 300), Assignment(1, 700)])
    assert (await verify(f, two)).invalid_reason == C.ERR_AMOUNT_MISMATCH
    burns = yed_payment(node, [Assignment(0, 250), Assignment(1, 50)])  # XFER-1: an output below $1.00
    assert (await verify(f, burns)).invalid_reason == C.ERR_YED_PAYLOAD
    dust = yed_payment(node, pay_value=53)
    assert (await verify(f, dust)).invalid_reason == C.ERR_RECIPIENT_MISMATCH


async def test_rule4y_node_half_disagreement(env, monkeypatch):
    node, f = env
    hex_tx = yed_payment(node)

    async def other(_hex):
        return {"valid": True, "type": "transfer", "opReturnIndex": 2, "assignments": [{"vout": 0, "cents": 250}]}
    monkeypatch.setattr(node, "yed_decode_payload", other)
    r = await verify(f, hex_tx)
    assert r.invalid_reason == C.ERR_YED_PAYLOAD and r.payer == PAYER_YE


async def test_rule9y_under_assigned_burns_and_unconfirmed_token(env):
    node, f = env
    under = yed_payment(node, [Assignment(0, 250)])  # the other 750 cents would burn
    assert (await verify(f, under)).invalid_reason == C.ERR_YED_VERDICT
    hex_tx = yed_payment(node)
    from x402_ycash.tx import parse_tx
    tok = parse_tx(hex_tx).vin[0].prevout
    node.unconfirmed_tokens.add(f"{tok.txid}:{tok.vout}")
    assert (await verify(f, hex_tx)).invalid_reason == C.ERR_YED_UNCONFIRMED_INPUT


async def test_resumed_payer_is_the_ye_form(env):
    node, f = env
    hex_tx = yed_payment(node)
    req = yed_requirements()
    await f.asettle(payment_payload(req, hex_tx), req)
    dup = await verify(f, hex_tx)
    assert dup.invalid_reason == C.ERR_DUPLICATE_SETTLEMENT and dup.payer == PAYER_YE


# --- server ----------------------------------------------------------------------------------------

def kind(extra=None) -> SupportedKind:
    return SupportedKind(x402_version=2, scheme="exact", network=NETWORK, extra=extra)


def test_parse_price_usd_in_yed_cents():
    s = ExactYcashServerScheme(usd_asset="YED")
    assert s.parse_price("$1", NETWORK) == AssetAmount(amount="100", asset="YED", extra={})
    assert s.parse_price("$25.10", NETWORK).amount == "2510"
    assert s.parse_price("2.5 YED", NETWORK).amount == "250"
    assert s.parse_price("0.0025 YEC", NETWORK) == AssetAmount(amount="250000", asset="YEC", extra={})
    with pytest.raises(ValueError, match="100..10000000 cents"):
        s.parse_price("$0.50", NETWORK)
    with pytest.raises(ValueError, match="whole number of cents"):
        s.parse_price("$1.005", NETWORK)
    with pytest.raises(ValueError, match="usd_asset"):
        ExactYcashServerScheme(usd_asset="USDC")


def test_enhance_yed_needs_a_facilitator_listing_yed():
    s = ExactYcashServerScheme(usd_asset="YED")
    req = yed_requirements()
    req.extra = {}
    out = s.enhance_payment_requirements(req, kind({"assets": ["YEC", "YED"]}), [])
    assert out.extra == {"assetTransferMethod": "transparent", "areFeesSponsored": False, "confirmationPolicy": {"confirmations": 1}}
    with pytest.raises(ValueError, match="does not settle YED"):
        s.enhance_payment_requirements(req, kind({"assets": ["YEC"]}), [])
