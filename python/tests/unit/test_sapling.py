"""The ``sapling`` method in Python (spec "sapling"): verification rules 1–11 on transactions with real
note ciphertexts, claim-then-broadcast settlement, the server half, the shielded method router, the
exact scheme's advertising, and the mainnet opt-in. Mirrors packages/ycash/test/unit/shielded/saplingFacilitator.test.ts."""

from __future__ import annotations

import pytest
from x402.schemas import PaymentPayload, PaymentRequirements

from tests.conftest import load_vector
from tests.unit.fake_node import FakeNode
from tests.unit.sapling_build import NETWORK, OTHER_IVK, TEST_IVK, Note, address, diversifier, payment_tx
from x402_ycash.exact import ExactYcashFacilitatorScheme, ExactYcashServerScheme
from x402_ycash.node.errors import RpcError, SendRawTransactionError
from x402_ycash.shielded import (
    InMemoryIssuedAddressRegistry,
    IssuedRequest,
    SaplingExactFacilitator,
    SaplingExactServer,
    SaplingHandler,
    SaplingLimits,
    ShieldedExactServer,
    ShieldedMethodRouter,
    es256k_signer,
    memo_for_record,
    record_retain_until,
    verify_receipt,
)
from x402_ycash.shielded.sapling import SaplingIncomingKey, decode_sapling_viewing_key
from x402_ycash.store import InMemorySettlementStore
from x402_ycash.tx import txid

NOW = 1_800_000_000
AMOUNT = 1_500_000
RESOURCE = "https://merchant.test/private-report"
KEY = SaplingIncomingKey(NETWORK, TEST_IVK, bytes(32))
SIGNER = es256k_signer("45" * 32)
D0, D1 = diversifier(0), diversifier(1)
PAY_TO = address(TEST_IVK, D0)


def record(**over):
    r = {"v": 1, "network": NETWORK, "asset": "YEC", "amount": str(AMOUNT), "payTo": PAY_TO, "resource": RESOURCE,
         "expiresAt": NOW + 900, "nonce": "ab" * 32}
    r.update(over)
    return r


def requirements(rec=None, **extra) -> PaymentRequirements:
    rec = rec or record()
    return PaymentRequirements(scheme="exact", network=NETWORK, asset="YEC", amount=rec["amount"], pay_to=rec["payTo"], max_timeout_seconds=900,
                               extra={"assetTransferMethod": "sapling", "areFeesSponsored": False, "memo": memo_for_record(rec),
                                      "expiresAt": rec["expiresAt"], "confirmationPolicy": {"confirmations": -1}, **extra})


def payload(req: PaymentRequirements, hex_tx: str, **accepted_extra) -> PaymentPayload:
    acc = req.model_copy(deep=True)
    if accepted_extra:
        acc = acc.model_copy(update={"extra": {**acc.extra, **accepted_extra}})
    return PaymentPayload(x402_version=2, accepted=acc, payload={"transaction": hex_tx})


def ok_tx(node: FakeNode, memo: str | None = None, value: int = AMOUNT, **kw):
    return payment_tx([Note(TEST_IVK, D0, value, memo or memo_for_record(record()))], value_balance=kw.pop("value_balance", 1000),
                      expiry_height=kw.pop("expiry_height", node.tip + 10), **kw)


@pytest.fixture
def env():
    node = FakeNode()
    registry = InMemoryIssuedAddressRegistry()
    store = InMemorySettlementStore()
    f = SaplingExactFacilitator(node, viewing_key=KEY, network=NETWORK, registry=registry, store=store, receipt_signer=SIGNER,
                                now=lambda: NOW, observe_wait=0.3, observe_poll=0.05)
    return node, registry, store, f


async def issue(registry, rec=None, confirmations=-1):
    rec = rec or record()
    await registry.issue(rec["payTo"], IssuedRequest(rec, memo_for_record(rec), confirmations, NOW, record_retain_until(rec["expiresAt"], confirmations, 3600)))


def land(node: FakeNode, t: str, zat: int = AMOUNT, confirmations: int = 0) -> None:
    node.z_notes.setdefault(PAY_TO, []).append({"txid": t, "amount": zat / 1e8, "amountZat": zat, "memo": "", "confirmations": confirmations})


async def test_verify_decrypts_offline_and_never_broadcasts(env):
    node, registry, _, f = env
    await issue(registry)
    tx = ok_tx(node)
    r = await f.averify(payload(requirements(), tx.serialize_hex()), requirements())
    assert r.is_valid, r.invalid_message
    assert r.extra == {"receivedZat": str(AMOUNT), "feeZat": "1000"}
    assert "sendrawtransaction" not in node.calls


async def test_settle_claims_broadcasts_observes_and_signs_a_receipt(env):
    node, registry, _store, f = env
    await issue(registry)
    tx = ok_tx(node)
    t = txid(tx)
    req = requirements()
    land(node, t)
    s = await f.asettle(payload(req, tx.serialize_hex()), req)
    assert s.success, s.error_message
    assert s.transaction == t and s.extra == {"status": "mempool", "confirmations": -1, "receivedZat": str(AMOUNT)}
    assert node.calls.count("sendrawtransaction") == 1 and t in node.txs
    receipt = s.extensions["offer-receipt"]["info"]["receipt"]
    assert verify_receipt(receipt, [SIGNER.public_key])["transaction"] == t
    # A retry observes, never broadcasts again; verify now answers duplicate_settlement.
    assert (await f.asettle(payload(req, tx.serialize_hex()), req)).success
    assert node.calls.count("sendrawtransaction") == 1
    v = await f.averify(payload(req, tx.serialize_hex()), req)
    assert (v.is_valid, v.invalid_reason) == (False, "duplicate_settlement")


async def test_settle_pending_without_the_note_and_expiry_failure_past_it(env):
    node, registry, _, f = env
    await issue(registry, confirmations=1)
    tx = ok_tx(node)
    req = requirements(record(), confirmationPolicy={"confirmations": 1})
    s = await f.asettle(payload(req, tx.serialize_hex()), req)
    assert s.error_reason == "settlement_pending" and s.extra == {"status": "pending", "confirmations": None}
    node.tip = tx.expiry_height + 1
    s2 = await f.asettle(payload(req, tx.serialize_hex()), req)
    assert s2.error_reason == "invalid_exact_ycash_expiry"


async def test_a_node_rejection_releases_the_claim(env):
    node, registry, store, f = env
    await issue(registry)
    tx = ok_tx(node)
    req = requirements()
    node.send_error = SendRawTransactionError(RpcError(-26, "16: bad-txns-sapling-duplicate-nullifier", "sendrawtransaction"))
    s = await f.asettle(payload(req, tx.serialize_hex()), req)
    assert s.error_reason == "invalid_exact_ycash_sapling_rejected"
    assert not await store.is_claimed(f"{NETWORK}:{txid(tx)}")
    node.send_error = SendRawTransactionError(RpcError(-26, "18: txn-mempool-conflict", "sendrawtransaction"))
    assert (await f.asettle(payload(req, tx.serialize_hex()), req)).error_reason == "invalid_exact_ycash_input_spent"


@pytest.mark.parametrize("case,reason", [
    ("method", "invalid_exact_ycash_asset_transfer_method"),
    ("flow", "invalid_exact_ycash_payment_flow"),
    ("accepted-memo", "invalid_exact_ycash_requirements_mismatch"),
    ("hex", "invalid_exact_ycash_transaction"),
    ("locktime", "invalid_exact_ycash_transaction"),
    ("nullifier", "invalid_exact_ycash_transaction"),
    ("unknown", "invalid_exact_ycash_unknown_instrument"),
    ("other-key", "invalid_exact_ycash_sapling_output"),
    ("two-outputs", "invalid_exact_ycash_sapling_output"),
    ("other-address", "invalid_exact_ycash_sapling_output"),
    ("lead-01", "invalid_exact_ycash_sapling_output"),
    ("underpaid", "invalid_exact_ycash_underpaid"),
    ("memo", "invalid_exact_ycash_memo_mismatch"),
    ("fee-low", "invalid_exact_ycash_fee_too_low"),
    ("fee-high", "invalid_exact_ycash_fee_too_high"),
    ("expiry", "invalid_exact_ycash_expiry"),
    ("chain", "network_mismatch"),
])
async def test_each_rule_refuses(env, case, reason):
    node, registry, _, f = env
    await issue(registry)
    req = requirements()
    memo = memo_for_record(record())
    tx = ok_tx(node)
    pl = None
    if case == "method":
        req = requirements(assetTransferMethod="sapling-proof")
    elif case == "flow":
        req = requirements(paymentFlow="upfront")
    elif case == "accepted-memo":
        pl = payload(req, tx.serialize_hex(), memo="x402:" + "00" * 32)
    elif case == "hex":
        pl = payload(req, tx.serialize_hex().upper())
    elif case == "locktime":
        tx = ok_tx(node, lock_time=5)
    elif case == "nullifier":
        tx = ok_tx(node, spends=2, nullifiers=[bytes(32), bytes(32)])
    elif case == "unknown":
        req = requirements(record(payTo=address(TEST_IVK, D1)))
    elif case == "other-key":
        tx = payment_tx([Note(OTHER_IVK, D0, AMOUNT, memo)], value_balance=1000, expiry_height=node.tip + 10)
    elif case == "two-outputs":
        tx = payment_tx([Note(TEST_IVK, D0, AMOUNT, memo), Note(TEST_IVK, D1, 5, memo)], value_balance=1000, expiry_height=node.tip + 10)
    elif case == "other-address":
        tx = payment_tx([Note(TEST_IVK, D1, AMOUNT, memo)], value_balance=1000, expiry_height=node.tip + 10)
    elif case == "lead-01":
        tx = payment_tx([Note(TEST_IVK, D0, AMOUNT, memo, lead=1, rseed=(12345).to_bytes(32, "little"))], value_balance=1000, expiry_height=node.tip + 10)
    elif case == "underpaid":
        tx = ok_tx(node, value=AMOUNT - 1)
    elif case == "memo":
        tx = ok_tx(node, memo="x402:" + "11" * 32)
    elif case == "fee-low":
        tx = ok_tx(node, value_balance=999)
    elif case == "fee-high":
        tx = ok_tx(node, value_balance=100_001)
    elif case == "expiry":
        tx = ok_tx(node, expiry_height=node.tip + 3)
    elif case == "chain":
        node.chain = "main"
    r = await f.averify(pl or payload(req, tx.serialize_hex()), req)
    assert (r.is_valid, r.invalid_reason) == (False, reason), r.invalid_message
    assert "sendrawtransaction" not in node.calls


async def test_limits_and_viewing_key_network():
    node = FakeNode()
    registry = InMemoryIssuedAddressRegistry()
    f = SaplingExactFacilitator(node, viewing_key=KEY, network=NETWORK, registry=registry, store=InMemorySettlementStore(),
                                receipt_signer=SIGNER, limits=SaplingLimits(max_components=1))
    await issue(registry)
    tx = ok_tx(node)  # one spend and one output: two components
    req = requirements()
    assert (await f.averify(payload(req, tx.serialize_hex()), req)).invalid_reason == "invalid_exact_ycash_transaction"
    vk = load_vector("shielded/divaddr.json")["cases"][0]["viewingKey"]
    assert decode_sapling_viewing_key(vk, NETWORK).network == NETWORK
    with pytest.raises(ValueError, match="viewing key"):
        decode_sapling_viewing_key(vk, "ycash:testnet")
    with pytest.raises(ValueError, match="mainnet key|ycash:mainnet"):
        SaplingExactFacilitator(node, viewing_key=KEY, network="ycash:mainnet", registry=registry, store=InMemorySettlementStore(), receipt_signer=SIGNER)


class _Rpc(FakeNode):
    async def z_get_new_address(self) -> str:
        return PAY_TO

    async def z_get_new_diversified_address(self, base: str) -> str:
        return address(TEST_IVK, D1)


async def test_server_half_issues_sapling_requirements():
    server = SaplingExactServer(ShieldedExactServer(_Rpc(), now=lambda: NOW))
    tmpl = PaymentRequirements(scheme="exact", network=NETWORK, asset="YEC", amount=str(AMOUNT), pay_to="", max_timeout_seconds=900,
                               extra={"assetTransferMethod": "sapling", "confirmationPolicy": {"confirmations": -1}})
    out = await server.enhance_requirements(tmpl, RESOURCE)
    assert out.extra["assetTransferMethod"] == "sapling" and "paymentFlow" not in out.extra
    assert out.extra["memo"] == (await server.registry.get(out.pay_to)).memo  # type: ignore[union-attr]
    with pytest.raises(ValueError, match="authorization"):
        await server.enhance_requirements(tmpl.model_copy(update={"extra": {**tmpl.extra, "paymentFlow": "upfront"}}), RESOURCE)
    with pytest.raises(ValueError, match="not sapling"):
        await server.enhance_requirements(tmpl.model_copy(update={"extra": {"assetTransferMethod": "sapling-proof"}}), RESOURCE)


def test_mainnet_needs_the_opt_in(monkeypatch):
    def build(mainnet_ok=None):
        return SaplingHandler("ycash:mainnet", _Rpc(), InMemorySettlementStore(), viewing_key=SaplingIncomingKey("ycash:mainnet", TEST_IVK, bytes(32)),
                              receipt_key="45" * 32, mainnet_ok=mainnet_ok)
    monkeypatch.delenv("X402_SAPLING_MAINNET_OK", raising=False)
    with pytest.raises(ValueError, match="X402_SAPLING_MAINNET_OK"):
        build()
    assert build(mainnet_ok=True).network == "ycash:mainnet"
    monkeypatch.setenv("X402_SAPLING_MAINNET_OK", "1")
    assert build().network == "ycash:mainnet"
    with pytest.raises(ValueError):
        build(mainnet_ok=False)
    # testnet and regtest need none
    SaplingHandler(NETWORK, _Rpc(), InMemorySettlementStore(), viewing_key=KEY, receipt_key="45" * 32)


class _Stub:
    def __init__(self, name: str, verify: bool = True) -> None:
        self.name = name
        if not verify:
            self.averify = None  # type: ignore[assignment]

    async def averify(self, payload, requirements):  # type: ignore[no-untyped-def]
        from x402.schemas import VerifyResponse
        return VerifyResponse(is_valid=True, extra={"by": self.name})

    async def asettle(self, payload, requirements):  # type: ignore[no-untyped-def]
        from x402.schemas import SettleResponse
        return SettleResponse(success=True, transaction=self.name, network=NETWORK)


def _req(method: str) -> PaymentRequirements:
    return PaymentRequirements(scheme="exact", network=NETWORK, asset="YEC", amount="1", pay_to="x", max_timeout_seconds=60,
                               extra={"assetTransferMethod": method})


async def test_router_dispatches_and_the_exact_scheme_advertises_its_methods():
    router = ShieldedMethodRouter({"sapling-proof": _Stub("proof", verify=False), "sapling": _Stub("sapling")})
    assert router.methods == ["sapling-proof", "sapling"]
    assert router.flows == {"sapling-proof": "upfront", "sapling": "authorization"}
    pl = PaymentPayload(x402_version=2, accepted=_req("sapling"), payload={})
    assert (await router.averify(pl, _req("sapling"))).extra == {"by": "sapling"}
    assert (await router.averify(pl, _req("sapling-proof"))).invalid_reason == "invalid_exact_ycash_payment_flow"
    assert (await router.asettle(pl, _req("sapling-proof"))).transaction == "proof"
    assert (await router.asettle(pl, _req("transparent"))).error_reason == "invalid_exact_ycash_asset_transfer_method"
    only = ShieldedMethodRouter({"sapling": _Stub("sapling")})
    assert (await only.asettle(pl, _req("sapling-proof"))).error_message == "sapling-proof is not configured"
    with pytest.raises(ValueError):
        ShieldedMethodRouter({"transparent": _Stub("t")})

    fac = ExactYcashFacilitatorScheme(FakeNode(), shielded=router)
    assert fac.get_extra(NETWORK)["assetTransferMethods"] == ["transparent", "sapling-proof", "sapling"]  # type: ignore[index]
    assert (await fac.averify(pl, _req("sapling"))).extra == {"by": "sapling"}
    assert (await fac.asettle(pl, _req("sapling"))).transaction == "sapling"
    server = ExactYcashServerScheme(shielded=router)  # type: ignore[arg-type]
    assert set(server.payment_flows) == {"transparent", "sapling-proof", "sapling"}
    assert server.payment_flows["sapling"] == server.payment_flows["transparent"]
