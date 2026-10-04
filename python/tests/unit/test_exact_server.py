"""The exact resource-server side: prices and the 402's extra (spec "PaymentRequirements")."""

import pytest
from x402 import x402ResourceServerSync
from x402.schemas import AssetAmount, SupportedKind

from tests.unit.fake_node import NETWORK, Key, requirements
from x402_ycash.exact import ExactYcashServerScheme, FixedPriceSource, YedGetPriceSource, register_exact_ycash_server
from x402_ycash.exact.policy import client_expiry_height, confirmations_satisfy, expiry_window

merchant = Key(2)
P50 = FixedPriceSource(50_000_000)


def kind(extra=None):
    return SupportedKind(x402_version=2, scheme="exact", network=NETWORK, extra=extra)


def base(amount="250000", **extra):
    r = requirements(merchant.address, amount)
    return r.model_copy(update={"extra": extra})


def aa(amount, asset):
    return AssetAmount(amount=amount, asset=asset, extra={})


def test_parse_price_money():
    s = ExactYcashServerScheme(P50)
    assert s.parse_price("0.0025 YEC", NETWORK) == aa("250000", "YEC")
    assert s.parse_price("25 YED", NETWORK) == aa("2500", "YED")
    assert s.parse_price("$0.10", NETWORK) == aa("200000", "YEC")
    assert s.parse_price("0.10 USD", NETWORK) == aa("200000", "YEC")
    assert ExactYcashServerScheme(FixedPriceSource(30_000_000)).parse_price("$0.01", NETWORK).amount == "33334"


def test_parse_price_asset_amounts():
    s = ExactYcashServerScheme(P50)
    assert s.parse_price({"amount": "1000", "asset": "YEC"}, NETWORK) == aa("1000", "YEC")
    assert s.parse_price(aa("1000", "YEC"), NETWORK).amount == "1000"
    for amount, asset, msg in (("53", "YEC", "dust"), ("99", "YED", "cents"), ("1", "USDC", "asset")):
        with pytest.raises(ValueError, match=msg):
            s.parse_price({"amount": amount, "asset": asset}, NETWORK)


def test_parse_price_needs_source_networks_tickers():
    with pytest.raises(ValueError, match="price source"):
        ExactYcashServerScheme().parse_price("$1", NETWORK)
    with pytest.raises(ValueError, match="network"):
        ExactYcashServerScheme(P50).parse_price("1 YEC", "eip155:1")
    with pytest.raises(ValueError, match="unknown asset"):
        ExactYcashServerScheme(P50).parse_price("1 ZEC", NETWORK)
    t = ExactYcashServerScheme().register_money_parser(lambda amount, net: aa(str(int(float(amount) * 1000)), "YEC"))
    assert t.parse_price("$2", NETWORK).amount == "2000"


def test_yed_get_price_source():
    class Rpc:
        def __init__(self, p):
            self.p = p

        async def yed_get_price(self):
            return self.p
    assert YedGetPriceSource(Rpc({"pMid": 40_000_000, "pFast": 1})).micro_usd_per_yec(NETWORK) == 40_000_000
    assert YedGetPriceSource(Rpc({"pMid": None, "pSlow": 30_000_000})).micro_usd_per_yec(NETWORK) == 30_000_000
    with pytest.raises(ValueError, match="pMid"):
        YedGetPriceSource(Rpc({"pMid": None, "pSlow": None})).micro_usd_per_yec(NETWORK)


def test_enhance_defaults():
    s = ExactYcashServerScheme(P50)
    assert s.enhance_payment_requirements(base("2000000"), kind(), []).extra == {
        "assetTransferMethod": "transparent", "areFeesSponsored": False, "confirmationPolicy": {"confirmations": -1}}
    assert s.enhance_payment_requirements(base("2000001"), kind(), []).extra["confirmationPolicy"] == {"confirmations": 1}

    class NoPrice:
        def micro_usd_per_yec(self, network):
            raise RuntimeError("no price")
    assert ExactYcashServerScheme(NoPrice()).enhance_payment_requirements(base("100"), kind(), []).extra["confirmationPolicy"] == {"confirmations": 1}
    assert ExactYcashServerScheme(zero_conf_cap_zat=10**6).enhance_payment_requirements(
        base("1000000"), kind(), []).extra["confirmationPolicy"] == {"confirmations": -1}
    assert ExactYcashServerScheme().enhance_payment_requirements(base("100"), kind(), []).extra["confirmationPolicy"] == {"confirmations": 1}
    yed = base("2500").model_copy(update={"asset": "YED"})
    assert s.enhance_payment_requirements(yed, kind(), []).extra["confirmationPolicy"] == {"confirmations": 1}


def test_enhance_respects_route_and_facilitator_range():
    s = ExactYcashServerScheme(P50)
    r = s.enhance_payment_requirements(base("100", confirmationPolicy={"confirmations": 3}), kind(), [])
    assert r.extra["confirmationPolicy"] == {"confirmations": 3}
    adv = kind({"assetTransferMethods": ["transparent"], "confirmations": {"minimum": 0, "maximum": 20}})
    assert s.enhance_payment_requirements(base("100"), adv, []).extra["confirmationPolicy"] == {"confirmations": 0}
    with pytest.raises(ValueError, match="settles confirmations"):
        s.enhance_payment_requirements(base("100", confirmationPolicy={"confirmations": -1}), adv, [])
    with pytest.raises(ValueError, match="does not support"):
        s.enhance_payment_requirements(base("100"), kind({"assetTransferMethods": ["sapling-proof"]}), [])
    with pytest.raises(ValueError, match="shielded handler"):
        s.enhance_payment_requirements(base("100", assetTransferMethod="sapling-proof"), kind(), [])


def test_declarations_and_registration():
    s = ExactYcashServerScheme()
    assert s.default_asset_transfer_method == "transparent"
    assert s.payment_flows == {"transparent": {"supported": ("authorization",), "default": "authorization"}}
    assert (s.get_asset_decimals("YEC", NETWORK), s.get_asset_decimals("YED", NETWORK)) == (8, 2)
    server = register_exact_ycash_server(x402ResourceServerSync(), NETWORK, P50)
    assert isinstance(server._schemes[NETWORK]["exact"], ExactYcashServerScheme)


def test_policy_helpers():
    for t in (1, 75, 76, 300, 3600):
        e = client_expiry_height(1000, t)
        lo, hi = expiry_window(1000, t)
        assert lo <= e and e + 1 <= hi  # one block of slack between client and facilitator
    assert not confirmations_satisfy(-1, 0) and confirmations_satisfy(1, 0) and confirmations_satisfy(-1, -1)
