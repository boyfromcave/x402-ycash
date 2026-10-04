"""Settlement (spec "Settlement", "Duplicate Settlement Mitigation"): claim, broadcast once, observe
the payTo outpoint, pending without rebroadcast, release only on a certain rejection. Mirrors the
TypeScript facilitator.settle.test.ts, plus the upstream x402Facilitator registration path."""

import asyncio

import pytest
from x402 import x402Facilitator, x402FacilitatorSync

from tests.unit.fake_node import NETWORK, FakeNode, Key, build_signed, payment_payload, requirements, standard_payment
from x402_ycash.exact import ExactYcashFacilitatorScheme, register_exact_ycash_facilitator
from x402_ycash.exact import constants as C
from x402_ycash.node import RpcError
from x402_ycash.store import InMemorySettlementStore, SqliteSettlementStore, txid_key
from x402_ycash.tx import TxOut, txid

payer = Key(1)
merchant = Key(2)


def make(node, store=None, timeout=0.06):
    return ExactYcashFacilitatorScheme(node, settlement_store=store or InMemorySettlementStore(),
                                       confirmation_timeout=timeout, confirmation_poll=0.01)


def policy(c):
    return requirements(merchant.address, confirmationPolicy={"confirmations": c})


def sends(node):
    return node.calls.count("sendrawtransaction")


async def settle(f, hex_tx, req):
    return await f.asettle(payment_payload(req, hex_tx), req)


async def test_mempool_policy_succeeds_on_own_acceptance():
    node, store = FakeNode(), InMemorySettlementStore()
    f = make(node, store)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    r = await settle(f, hex_tx, policy(-1))
    assert r.success and r.transaction == txid(hex_tx) and r.network == NETWORK and r.payer == payer.address
    assert r.extra == {"status": "mempool", "confirmations": -1}
    assert sends(node) == 1
    assert await store.is_claimed(txid_key(NETWORK, txid(hex_tx)))


@pytest.mark.parametrize("c", [0, 1])
async def test_block_policies_pend_then_settle_without_rebroadcast(c):
    node = FakeNode()
    f = make(node)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    first = await settle(f, hex_tx, policy(c))
    assert not first.success and first.error_reason == C.ERR_SETTLEMENT_PENDING
    assert first.transaction == txid(hex_tx) and first.extra == {"status": "pending", "confirmations": -1}
    node.mine()
    retry = await settle(f, hex_tx, policy(c))
    assert retry.success and retry.payer == payer.address and retry.extra == {"status": "confirmed", "confirmations": 1}
    assert sends(node) == 1


async def test_reports_the_actual_depth():
    node = FakeNode()
    f = make(node)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    assert (await settle(f, hex_tx, policy(3))).error_reason == C.ERR_SETTLEMENT_PENDING
    node.mine(4)
    assert (await settle(f, hex_tx, policy(3))).extra == {"status": "confirmed", "confirmations": 4}


async def test_observes_while_it_waits():
    node = FakeNode()
    f = make(node, timeout=2.0)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    asyncio.get_running_loop().call_later(0.05, node.mine)
    assert (await settle(f, hex_tx, policy(1))).success


async def test_reruns_verification_and_stays_unclaimed():
    node, store = FakeNode(), InMemorySettlementStore()
    f = make(node, store)
    hex_tx, coin = standard_payment(node, payer, merchant.address)
    req = policy(-1)
    assert (await f.averify(payment_payload(req, hex_tx), req)).is_valid
    node.accept_to_mempool(build_signed([(coin, 10_000_000, payer.script)], payer.priv, [TxOut(9_990_000, payer.script)], node.tip + 10))
    r = await settle(f, hex_tx, req)
    assert r.error_reason == C.ERR_INPUT_SPENT and sends(node) == 0
    assert not await store.is_claimed(txid_key(NETWORK, txid(hex_tx)))


@pytest.mark.parametrize(("code", "msg", "reason"), [
    (-26, "18: txn-mempool-conflict", C.ERR_INPUT_SPENT),
    (-25, "", C.ERR_INPUT_SPENT),  # v4.5.0's empty conflict (X-F7)
    (-25, "Missing inputs", C.ERR_INPUT_SPENT),
    (-26, "tx-expiring-soon", C.ERR_EXPIRY),
    (-26, "16: mandatory-script-verify-flag-failed", C.ERR_TRANSACTION),
])
async def test_certain_rejection_releases_the_claim(code, msg, reason):
    node, store = FakeNode(), InMemorySettlementStore()
    f = make(node, store)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    node.send_error = node.send_error_of(code, msg)
    r = await settle(f, hex_tx, policy(-1))
    assert not r.success and r.error_reason == reason
    assert not await store.is_claimed(txid_key(NETWORK, txid(hex_tx)))


async def test_already_in_chain_continues_to_observation():
    node = FakeNode()
    f = make(node)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    node.send_error = node.send_error_of(-27, "transaction already in block chain")
    assert (await settle(f, hex_tx, policy(-1))).error_reason == C.ERR_SETTLEMENT_PENDING


async def test_transport_failure_keeps_the_claim_and_never_rebroadcasts():
    node, store = FakeNode(), InMemorySettlementStore()
    f = make(node, store)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    node.send_error = RpcError(0, "socket hang up", "sendrawtransaction", transport=True)
    assert (await settle(f, hex_tx, policy(-1))).error_reason == C.ERR_SETTLEMENT_PENDING
    assert await store.is_claimed(txid_key(NETWORK, txid(hex_tx)))
    await node.send_raw_transaction(hex_tx)  # it had in fact reached the node
    before = sends(node)
    assert (await settle(f, hex_tx, policy(-1))).success
    assert sends(node) == before


async def test_concurrent_settles_broadcast_once():
    node = FakeNode()
    f = make(node)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    a, b = await asyncio.gather(settle(f, hex_tx, policy(-1)), settle(f, hex_tx, policy(-1)))
    assert sends(node) == 1 and a.success and b.success


async def test_after_expiry_an_unmined_claim_is_terminal():
    node, store = FakeNode(), InMemorySettlementStore()
    f = make(node, store)
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    await store.claim(txid_key(NETWORK, txid(hex_tx)), 1000)  # claimed, never broadcast (a crash)
    node.tip += 20
    r = await settle(f, hex_tx, policy(1))
    assert r.error_reason == C.ERR_EXPIRY and r.transaction == txid(hex_tx) and sends(node) == 0


async def test_invalid_payload_fails_first():
    node = FakeNode()
    r = await settle(make(node), "00", policy(-1))
    assert r.error_reason == C.ERR_TRANSACTION and r.transaction == "" and node.calls == []


def test_extra_and_signers():
    f = make(FakeNode())
    assert f.get_extra(NETWORK) == {"assets": ["YEC"], "assetTransferMethods": ["transparent"], "areFeesSponsored": False,
                                    "confirmations": {"minimum": -1, "maximum": 20}}
    assert f.get_signers(NETWORK) == []


async def test_sqlite_store_is_durable(tmp_path):
    a = SqliteSettlementStore(tmp_path / "claims.db")
    assert await a.claim("ycash:regtest:x", 10)
    b = SqliteSettlementStore(tmp_path / "claims.db")  # another process, same file
    assert not await b.claim("ycash:regtest:x", 10)
    assert await b.is_claimed("ycash:regtest:x")
    assert await b.claim("ycash:regtest:forever", float("inf"))
    assert await a.prune(11) == 1
    assert not await a.is_claimed("ycash:regtest:x") and await a.is_claimed("ycash:regtest:forever")


# --- through upstream's x402Facilitator (sync protocol, async and sync facilitators) --------------

async def test_upstream_async_facilitator_routes_to_the_scheme():
    node = FakeNode()
    fac = register_exact_ycash_facilitator(x402Facilitator(), node, NETWORK, confirmation_timeout=0.06,
                                           confirmation_poll=0.01)
    supported = fac.get_supported()
    assert supported.kinds[0].network == NETWORK and supported.kinds[0].scheme == "exact"
    assert supported.signers == {"ycash:*": []}
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    req = policy(-1)
    assert (await fac.verify(payment_payload(req, hex_tx), req)).is_valid
    r = await fac.settle(payment_payload(req, hex_tx), req)
    assert r.success and r.extra == {"status": "mempool", "confirmations": -1}
    dup = await fac.verify(payment_payload(req, hex_tx), req)
    assert dup.invalid_reason == C.ERR_DUPLICATE_SETTLEMENT


def test_upstream_sync_facilitator():
    node = FakeNode()
    fac = register_exact_ycash_facilitator(x402FacilitatorSync(), node, [NETWORK])
    hex_tx, _ = standard_payment(node, payer, merchant.address)
    req = policy(-1)
    assert fac.verify(payment_payload(req, hex_tx), req).is_valid
    assert fac.settle(payment_payload(req, hex_tx), req).success
    assert sends(node) == 1
