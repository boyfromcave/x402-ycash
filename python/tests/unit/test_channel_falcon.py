# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""YED channels across the Falcon height F on the server and facilitator (mirrors the TypeScript
unit/batch/yed.falcon.test.ts): from F a TX_PQCHANNEL with a Falcon client and Falcon TX_PQPKH holders,
signed here with the node's C (x402_ycash.pq.falcon) and verified by the stdlib verifier; before F an
SLH-DSA client whose funding expires below F, closed at F − margin."""

from __future__ import annotations

from typing import Any

import pytest

from tests.unit.channel_sim import ClientSim, batch_requirements
from tests.unit.fake_node import NETWORK, FakeNode, Key
from x402_ycash.batch import BatchError, BatchSettlementError, BatchYcashFacilitatorScheme, BatchYcashServerScheme
from x402_ycash.batch.watcher import WatchedChannel
from x402_ycash.channel import parse_pq_channel_script, parse_pq_close_script_sig
from x402_ycash.channel.falcon import (
    DEFAULT_FALCON_HEIGHT,
    channel_close_by,
    falcon_height_of,
    is_falcon_active_at,
    is_falcon_holder,
    margin_height_of,
    read_falcon_height,
    yed_holder_problem,
)
from x402_ycash.pq import SCHEME_FN_DSA_512, SCHEME_SLH_DSA_SHA2_128S, PQKeyPair
from x402_ycash.tx import address_to_script, encode_address, encode_pq_address, hash160, parse_tx

SERVER = Key(9)
MERCHANT = Key(2)
FALCON = PQKeyPair.from_seed(SCHEME_FN_DSA_512, bytes(range(48)))
SLH = PQKeyPair.from_seed(SCHEME_SLH_DSA_SHA2_128S, bytes(range(48)))
FALCON_PAYTO = encode_pq_address(NETWORK, "yedpq", 2, PQKeyPair.from_seed(SCHEME_FN_DSA_512, bytes([1]) * 48).key_id.hash)
FALCON_RETURN = encode_pq_address(NETWORK, "yedpq", 2, PQKeyPair.from_seed(SCHEME_FN_DSA_512, bytes([2]) * 48).key_id.hash)
SLH_RETURN = encode_pq_address(NETWORK, "yedpq", 1, SLH.key_id.hash)
P2PKH_PAYTO = encode_address(NETWORK, "yed", hash160(MERCHANT.pub))


class FalconNode(FakeNode):
    def __init__(self, falcon_height: int) -> None:
        super().__init__()
        self.yellowback = True
        self.falcon_height = falcon_height

    async def yed_get_info(self) -> dict[str, Any]:
        return {"rpcversion": 7, "params": {"pq": {"falconHeight": self.falcon_height}}}


class Env:
    def __init__(self, falcon_height: int, pay_to: str, key: PQKeyPair | None, return_address: str, expiry: int = 0) -> None:
        self.node = FalconNode(falcon_height)
        self.closes: list[Any] = []
        self.server = BatchYcashServerScheme(self.node, SERVER.priv, max_deposit=100_000_000, max_deposit_cents=10_000,
                                             min_lock_blocks=30, close_margin_blocks=5, on_close=self.closes.append)
        self.m = self.server.manager
        self.req = batch_requirements(SERVER.pub, pay_to, "1", "YED", 1, max_deposit="10000", close_fee="30000")
        self.client = ClientSim(self.node, self.req, 2_000, pq=key is not None, pq_key=key, return_address=return_address,
                                expiry_height=expiry)

    async def refused(self, payload: Any) -> str:
        with pytest.raises(BatchSettlementError) as e:
            await self.m.verify(payload, self.req)
        return e.value.reason

    async def open(self) -> str:
        p = self.client.open(100)
        assert await self.refused(p) == BatchError.FUNDING_DEPTH
        self.node.mine()
        v = await self.m.verify(p, self.req)
        await self.m.settle(v, 1)
        return v.channel_id


def test_helpers() -> None:
    assert not is_falcon_active_at(-1, 10) and is_falcon_active_at(0, 0) and is_falcon_active_at(100, 100) and not is_falcon_active_at(100, 99)
    assert falcon_height_of({"params": {"pq": {"falconHeight": 130}}}) == 130 and falcon_height_of({}) is None
    assert DEFAULT_FALCON_HEIGHT == {"ycash:mainnet": 0, "ycash:testnet": 0, "ycash:regtest": -1}
    falcon, slh, p2pkh = (address_to_script(a, NETWORK) for a in (FALCON_PAYTO, SLH_RETURN, P2PKH_PAYTO))
    assert is_falcon_holder(falcon) and not is_falcon_holder(slh) and not is_falcon_holder(p2pkh)
    assert yed_holder_problem(falcon, True) is None and yed_holder_problem(slh, True) and yed_holder_problem(p2pkh, True)
    assert yed_holder_problem(falcon, False) and yed_holder_problem(slh, False) is None
    assert channel_close_by("YED", None, 500, 300) == 300 and channel_close_by("YED", 1, 500, 300) == 300
    assert channel_close_by("YED", 2, 500, 300) == 500 and channel_close_by("YED", 1, 500, -1) == 500 and channel_close_by("YEC", None, 500, 300) == 500
    assert margin_height_of(500, 10, 300) == 290 and margin_height_of(500, 10) == 490
    assert WatchedChannel("x", 500, 10, 300).margin_height == 290


async def test_read_falcon_height() -> None:
    node = FalconNode(42)
    assert await read_falcon_height(node, NETWORK) == 42
    assert await read_falcon_height(object(), "ycash:mainnet") == 0
    assert await read_falcon_height(FakeNode(), NETWORK) == -1  # a stock node (no yed_get_info): the regtest default


async def test_falcon_era_channel_open_pay_close_and_facilitator() -> None:
    env = Env(0, FALCON_PAYTO, FALCON, FALCON_RETURN)
    cid = await env.open()
    assert parse_pq_channel_script(env.client.channel.redeem_script).client.scheme == SCHEME_FN_DSA_512  # type: ignore[union-attr]
    ch = await env.m.ledger.get(cid)
    assert ch is not None and "closeBy" not in ch.terms
    f = BatchYcashFacilitatorScheme(env.node)
    assert (await f.averify(env.client.voucher(100), env.req)).is_valid
    c = await env.m.verify(env.client.voucher(100, "close"), env.req)
    await env.m.settle(c, 0)
    close = parse_tx(env.node.txs[env.closes[0].txid]["hex"])
    ps = parse_pq_close_script_sig(close.vin[0].script_sig)
    assert ps is not None and ps.sig_s and ps.spend.scheme == SCHEME_FN_DSA_512
    assert len(close.vin[0].script_sig) < 1_700  # a Falcon client spend (an SLH-DSA one is ≈ 8 KB)
    assert is_falcon_holder(close.vout[0].script_pubkey) and is_falcon_holder(close.vout[1].script_pubkey)
    assert (await env.node.verify_scripts(close.serialize_hex())).complete


async def test_falcon_era_refusals() -> None:
    assert await (e := Env(0, FALCON_PAYTO, SLH, FALCON_RETURN)).refused(e.client.open(100)) == BatchError.REDEEM_SCRIPT
    assert await (e := Env(0, FALCON_PAYTO, None, encode_address(NETWORK, "yed", hash160(Key(8).pub)))).refused(e.client.open(100)) == BatchError.REDEEM_SCRIPT
    assert await (e := Env(0, FALCON_PAYTO, FALCON, SLH_RETURN)).refused(e.client.open(100)) == BatchError.RETURN_ADDRESS
    assert await (e := Env(0, P2PKH_PAYTO, FALCON, FALCON_RETURN)).refused(e.client.open(100)) == BatchError.REQUIREMENTS
    # a Falcon client before F: the node's policy would refuse the scheme-2 output
    assert await (e := Env(10_000, P2PKH_PAYTO, FALCON, SLH_RETURN)).refused(e.client.open(100)) == BatchError.REDEEM_SCRIPT


async def test_pre_falcon_channel_closes_below_f() -> None:
    f = 330  # tip 300, t = 340, margin 5: closeBy 330, the server closes from 325
    env = Env(f, P2PKH_PAYTO, SLH, SLH_RETURN, expiry=f - 1)
    cid = await env.open()
    ch = await env.m.ledger.get(cid)
    assert ch is not None and ch.terms["closeBy"] == f and ch.terms["refundHeight"] == 340
    env.node.mine(325 - env.node.tip)
    closed = await env.m.sweep()
    assert [(c.channel_id, c.reason) for c in closed] == [(cid, "margin")]


async def test_pre_falcon_refusals() -> None:
    # a funding that never expires could land at F
    assert await (e := Env(330, P2PKH_PAYTO, SLH, SLH_RETURN)).refused(e.client.open(100)) == BatchError.FUNDING
    # an open already inside F − margin
    assert await (e := Env(305, P2PKH_PAYTO, SLH, SLH_RETURN, expiry=304)).refused(e.client.open(100)) == BatchError.REDEEM_SCRIPT
    # a P2SH YED channel before F is closed below F too
    env = Env(330, P2PKH_PAYTO, None, encode_address(NETWORK, "yed", hash160(Key(8).pub)), expiry=329)
    cid = await env.open()
    ch = await env.m.ledger.get(cid)
    assert ch is not None and ch.terms["closeBy"] == 330
