"""sapling-proof (spec "sapling-proof"): issuance, the nine settle steps, the bounded note wait, the
consumption key, receipts, the registries and the exact scheme's routing. Mirrors the TypeScript
shielded unit tests, against an in-memory merchant wallet."""

import asyncio
from types import SimpleNamespace

import pytest
from x402.schemas import PaymentPayload, PaymentRequirements, SupportedKind

from tests.unit.fake_node import NETWORK, FakeNode, encode_sapling
from x402_ycash.exact import ExactYcashFacilitatorScheme, ExactYcashServerScheme
from x402_ycash.shielded import (
    InMemoryIssuedAddressRegistry,
    IssuedRequest,
    SaplingProofHandler,
    SqliteIssuedAddressRegistry,
    es256k_signer,
    meets_policy,
    memo_for_record,
    memo_to_hex,
    payment_key,
    quote_zat,
    usd_to_micro,
    verify_receipt,
)
from x402_ycash.shielded import constants as C
from x402_ycash.store import InMemorySettlementStore, SqliteSettlementStore

KEY = "44" * 32
RESOURCE = "https://merchant.test/report"
TXID = "ab" * 32


def template(confirmations: int = 1, **extra) -> PaymentRequirements:
    return PaymentRequirements(scheme="exact", network=NETWORK, asset="YEC", amount="1500000", pay_to="", max_timeout_seconds=900,
                               extra={"assetTransferMethod": "sapling-proof", "confirmationPolicy": {"confirmations": confirmations}, **extra})


class Clock:
    def __init__(self) -> None:
        self.t = 1_800_000_000

    def __call__(self) -> int:
        return self.t


@pytest.fixture
def env():
    node = FakeNode()
    clock = Clock()
    store = InMemorySettlementStore()
    h = SaplingProofHandler(NETWORK, node, store, receipt_key=KEY, note_wait=0.3, note_poll=0.05, now=clock,
                            fallback_price_micro_usd=50_000_000)
    return node, h, store, clock


def payload(req: PaymentRequirements, txid: str = TXID) -> PaymentPayload:
    return PaymentPayload(x402_version=2, accepted=req.model_copy(deep=True), payload={"txid": txid})


def note(req: PaymentRequirements, zat: int | None = None, confirmations: int = 1, memo: str | None = None, txid: str = TXID) -> None:
    """The merchant wallet receives a note of ``txid`` at payTo (the memo padded to 512 bytes as both lines return it)."""
    m = (memo if memo is not None else req.extra["memo"]).encode().ljust(512, b"\0").hex()
    zat = int(req.amount) if zat is None else zat
    NODE_OF[id(req)].z_notes.setdefault(req.pay_to, []).append(
        {"txid": txid, "amount": zat / 1e8, "amountZat": zat, "memo": m, "confirmations": confirmations})


NODE_OF: dict[int, FakeNode] = {}


async def issue(h: SaplingProofHandler, node: FakeNode, confirmations: int = 1, **extra) -> PaymentRequirements:
    req = await h.enhance_requirements(template(confirmations, **extra), RESOURCE)
    NODE_OF[id(req)] = node
    return req


# --- issuance --------------------------------------------------------------------------------------

async def test_issue_fresh_address_memo_and_record(env):
    node, h, _, clock = env
    a, b = await issue(h, node), await issue(h, node)
    assert a.pay_to != b.pay_to and a.pay_to.startswith("yregtestsapling1")
    assert a.extra["paymentFlow"] == "upfront" and a.extra["areFeesSponsored"] is False
    assert a.extra["expiresAt"] == clock.t + 900 and a.extra["confirmationPolicy"] == {"confirmations": 1}
    rec = await h.server.request_record(a.pay_to)
    assert rec is not None and rec["resource"] == RESOURCE and rec["payTo"] == a.pay_to and len(rec["nonce"]) == 64
    assert a.extra["memo"] == memo_for_record(rec) and C.MEMO_REGEX.match(a.extra["memo"])


async def test_issue_quotes_a_usd_price(env):
    node, h, _, _ = env
    node.yellowback = True  # yed_getprice: pMid 50,000,000 micro-USD
    req = await issue(h, node, priceUsd="0.10")
    assert req.amount == str(quote_zat("0.10", 50_000_000)) == "200000"
    assert req.extra["quote"] == {"usd": "0.10", "priceMicroUsd": 50_000_000, "source": "yed_getprice:pMid", "height": node.tip}
    assert "priceUsd" not in req.extra
    node.yellowback = False  # a stock node: the configured fallback
    assert (await issue(h, node, priceUsd="0.10")).extra["quote"]["source"] == "configured"
    assert usd_to_micro("1.234567") == 1_234_567
    with pytest.raises(ValueError):
        usd_to_micro("1.2345678")


async def test_issue_refusals(env):
    node, h, _, _ = env
    with pytest.raises(ValueError, match="resource URL"):
        await h.enhance_requirements(template(), "")
    with pytest.raises(ValueError, match="YEC only"):
        await h.enhance_requirements(template().model_copy(update={"asset": "YED"}), RESOURCE)
    with pytest.raises(ValueError, match="outside"):
        await h.enhance_requirements(template(21), RESOURCE)
    ranged = SaplingProofHandler(NETWORK, node, InMemorySettlementStore(), receipt_key=KEY, confirmations=(0, 20))
    with pytest.raises(ValueError, match="operator's range"):
        await ranged.enhance_requirements(template(-1), RESOURCE)
    bounded = SaplingProofHandler(NETWORK, node, InMemorySettlementStore(), receipt_key=KEY, max_outstanding=1)
    await bounded.enhance_requirements(template(1), RESOURCE)
    with pytest.raises(ValueError, match="issuance limit"):
        await bounded.enhance_requirements(template(1), RESOURCE)
    with pytest.raises(ValueError, match="is on main"):
        SaplingProofHandler(NETWORK, node, InMemorySettlementStore(), receipt_key=KEY, capabilities=SimpleNamespace(chain="main"))


async def test_a_reissued_address_is_refused(env, monkeypatch):
    node, h, _, _ = env
    first = await issue(h, node)

    async def faulty(base):  # a wallet repeating its diversifier index
        return first.pay_to
    monkeypatch.setattr(node, "z_get_new_diversified_address", faulty)
    with pytest.raises(ValueError, match="already issued"):
        await h.enhance_requirements(template(), RESOURCE)


# --- settle ----------------------------------------------------------------------------------------

async def test_settle_success_carries_a_receipt_and_claims_txid_at_payto(env):
    node, h, store, clock = env
    req = await issue(h, node)
    note(req)
    r = await h.asettle(payload(req), req)
    assert r.success and r.transaction == TXID and r.payer is None
    assert r.extra == {"status": "confirmed", "confirmations": 1, "receivedZat": "1500000"}
    rc = verify_receipt(r.extensions["offer-receipt"]["info"]["receipt"], [es256k_signer(KEY).public_key])
    assert rc == {"version": 1, "network": NETWORK, "resourceUrl": RESOURCE, "payer": "anonymous", "issuedAt": clock.t, "transaction": TXID}
    assert await store.is_claimed(payment_key(NETWORK, TXID, req.pay_to))
    assert payment_key(NETWORK, TXID, req.pay_to) == f"ycash:regtest:{TXID}@{req.pay_to}"
    again = await h.asettle(payload(req), req)
    assert again.error_reason == C.ERR_DUPLICATE_SETTLEMENT
    assert (await h.averify(payload(req), req)).invalid_reason == C.ERR_DUPLICATE_SETTLEMENT


async def test_one_txid_paying_two_requests_settles_both(env):
    node, h, _, _ = env
    a, b = await issue(h, node), await issue(h, node)
    note(a)
    note(b)
    assert (await h.asettle(payload(a), a)).success
    assert (await h.asettle(payload(b), b)).success


def test_meets_policy_only_minus_one_accepts_mempool():
    assert meets_policy(-1, -1) and meets_policy(1, -1)
    assert not meets_policy(-1, 0) and meets_policy(1, 0)
    assert not meets_policy(-1, 1) and meets_policy(1, 1)
    assert not meets_policy(2, 3) and meets_policy(3, 3)


async def test_depth_pending_holds_nothing_then_settles(env):
    node, h, store, _ = env
    req = await issue(h, node, confirmations=0)
    note(req, confirmations=0)
    r = await h.asettle(payload(req), req)
    assert r.error_reason == C.ERR_SETTLEMENT_PENDING and r.transaction == TXID
    assert r.extra == {"status": "pending", "confirmations": -1}
    assert not await store.is_claimed(payment_key(NETWORK, TXID, req.pay_to))
    node.z_notes[req.pay_to][0]["confirmations"] = 1
    assert (await h.asettle(payload(req), req)).success
    zero = await issue(h, node, confirmations=-1)
    note(zero, confirmations=0)
    assert (await h.asettle(payload(zero), zero)).extra == {"status": "mempool", "confirmations": -1, "receivedZat": "1500000"}


async def test_bounded_note_wait(env):
    node, h, _, _ = env
    req = await issue(h, node)

    async def arrive():
        await asyncio.sleep(0.12)
        note(req)
    task = asyncio.create_task(arrive())
    r = await h.asettle(payload(req), req)
    await task
    assert r.success
    polls = node.calls.count("z_listreceivedbyaddress")
    assert 2 <= polls <= 6
    other = await issue(h, node)
    t0 = asyncio.get_running_loop().time()
    r2 = await h.asettle(payload(other), other)
    assert r2.error_reason == C.ERR_NOT_RECEIVED
    assert asyncio.get_running_loop().time() - t0 < 0.6  # note_wait 0.3 s


@pytest.mark.parametrize(("case", "reason"), [
    ("under", C.ERR_UNDERPAID), ("memo", C.ERR_MEMO_MISMATCH), ("txid", C.ERR_TXID_MALFORMED),
    ("unknown", C.ERR_UNKNOWN_INSTRUMENT), ("flow", C.ERR_PAYMENT_FLOW), ("method", C.ERR_ASSET_TRANSFER_METHOD),
    ("memo-extra", C.ERR_REQUIREMENTS_MISMATCH), ("accepted", C.ERR_REQUIREMENTS_MISMATCH), ("chain", C.ERR_NETWORK_MISMATCH),
    ("amount", C.ERR_UNKNOWN_INSTRUMENT),
])
async def test_settle_refusals(env, case, reason):
    node, h, store, _ = env
    req = await issue(h, node)
    p = payload(req)
    if case == "under":
        note(req, zat=1_499_999)
    elif case == "memo":
        note(req, memo="x402:" + "00" * 32)
    elif case == "txid":
        p.payload = {"txid": TXID.upper()}
    elif case == "unknown":
        req = req.model_copy(update={"pay_to": encode_sapling(NETWORK, 99)})
        p = payload(req)
    elif case == "flow":
        req.extra["paymentFlow"] = "authorization"
        p = payload(req)
    elif case == "method":
        req.extra["assetTransferMethod"] = "sapling"
        p = payload(req)
    elif case == "memo-extra":
        req.extra["memo"] = "nope"
        p = payload(req)
    elif case == "accepted":
        p.accepted.extra["expiresAt"] = float(req.extra["expiresAt"])  # JSON-type equality: 1.0 is not 1
    elif case == "chain":
        node.chain = "main"
    elif case == "amount":
        req = req.model_copy(update={"amount": "1"})
        p = payload(req)
    r = await h.asettle(p, req)
    assert r.error_reason == reason, r
    assert not await store.is_claimed(payment_key(NETWORK, TXID, req.pay_to))


async def test_overpayment_and_split_notes_are_accepted(env):
    node, h, _, _ = env
    req = await issue(h, node)
    note(req, zat=1_000_000)
    note(req, zat=600_000, memo="")  # two outputs of one tx; one carries the memo
    r = await h.asettle(payload(req), req)
    assert r.success and r.extra["receivedZat"] == "1600000"


# --- registries and stores -------------------------------------------------------------------------

@pytest.mark.parametrize("kind", ["memory", "sqlite"])
async def test_registry_never_reissues_and_prunes_records_only(kind, tmp_path):
    reg = InMemoryIssuedAddressRegistry() if kind == "memory" else SqliteIssuedAddressRegistry(tmp_path / "r.db")
    rec = {"v": 1, "network": NETWORK, "asset": "YEC", "amount": "1", "payTo": "z1", "resource": "u", "expiresAt": 10, "nonce": "00"}
    req = IssuedRequest(rec, memo_for_record(rec), 1, 0, 100)
    assert await reg.issue("z1", req) and not await reg.issue("z1", req)
    assert await reg.get("z1") == req and await reg.outstanding(50) == 1
    assert await reg.prune(101) == 1 and await reg.get("z1") is None
    assert await reg.was_issued("z1") and not await reg.issue("z1", req)
    assert await reg.outstanding(0) == 0
    if kind == "sqlite":
        assert await SqliteIssuedAddressRegistry(tmp_path / "r.db").was_issued("z1")  # restart-durable


async def test_sqlite_handler_shared_by_server_and_facilitator(tmp_path):
    node = FakeNode()
    reg_path, store_path = tmp_path / "issued.db", tmp_path / "claims.db"
    server_side = SaplingProofHandler(NETWORK, node, SqliteSettlementStore(store_path), receipt_key=KEY,
                                      registry=SqliteIssuedAddressRegistry(reg_path), note_wait=0)
    req = await server_side.enhance_requirements(template(), RESOURCE)
    NODE_OF[id(req)] = node
    note(req)
    facilitator_side = SaplingProofHandler(NETWORK, node, SqliteSettlementStore(store_path), receipt_key=KEY,
                                           registry=SqliteIssuedAddressRegistry(reg_path), note_wait=0)
    assert (await facilitator_side.asettle(payload(req), req)).success
    assert (await server_side.asettle(payload(req), req)).error_reason == C.ERR_DUPLICATE_SETTLEMENT


# --- exact routing ---------------------------------------------------------------------------------

async def test_exact_facilitator_routes_sapling_proof(env):
    node, h, _, _ = env
    f = ExactYcashFacilitatorScheme(node, shielded=h)
    assert f.get_extra(NETWORK)["assetTransferMethods"] == ["transparent", "sapling-proof"]
    req = await issue(h, node)
    note(req)
    assert (await f.averify(payload(req), req)).is_valid
    assert (await f.asettle(payload(req), req)).success
    bare = ExactYcashFacilitatorScheme(node)
    assert (await bare.asettle(payload(req), req)).error_reason == "invalid_exact_ycash_asset_transfer_method"


def test_exact_server_fills_an_issued_route(env):
    _, h, _, _ = env
    issuer = h.route_issuer("1500000", 900, confirmations=2)
    s = ExactYcashServerScheme(shielded=issuer)
    assert s.payment_flows["sapling-proof"] == {"supported": ("upfront",), "default": "upfront"}

    async def mint():
        ctx = SimpleNamespace(adapter=SimpleNamespace(get_url=lambda: RESOURCE), payment_header=None)
        return await issuer.pay_to(ctx)
    pay_to = asyncio.run(mint())
    base = PaymentRequirements(scheme="exact", network=NETWORK, asset="YEC", amount="1500000", pay_to=pay_to, max_timeout_seconds=900,
                               extra={"assetTransferMethod": "sapling-proof"})
    out = s.enhance_payment_requirements(base, SupportedKind(x402_version=2, scheme="exact", network=NETWORK), [])
    assert out.extra["paymentFlow"] == "upfront" and out.extra["confirmationPolicy"] == {"confirmations": 2}
    assert C.MEMO_REGEX.match(out.extra["memo"])
    with pytest.raises(ValueError, match="not issued"):
        s.enhance_payment_requirements(base.model_copy(update={"pay_to": "yregtestsapling1zz"}), SupportedKind(
            x402_version=2, scheme="exact", network=NETWORK), [])
    assert memo_to_hex("x402:") == "783430323a"
