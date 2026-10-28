# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""The hybrid TX_PQCHANNEL (quantum spec D-Q-19) in the Python mirror: the template against the node's
matcher vectors (vectors/pq/yellowback_pq_vectors.json "scripts", ycash-dd @ 8af82551b), the spends
(cooperative close: client PQ chunks + server ECDSA + OP_1; refund: client PQ chunks + OP_0 after t),
and a YED channel on it through the server's manager and a stateless facilitator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.unit.channel_sim import ClientSim, batch_requirements
from tests.unit.fake_node import BRANCH_ID, NETWORK, FakeNode, Key
from x402_ycash.batch import BatchError, BatchSettlementError, BatchYcashFacilitatorScheme, BatchYcashServerScheme
from x402_ycash.channel import (
    Channel,
    PQChannelScript,
    build_pq_channel_script,
    build_voucher,
    build_yed_refund,
    channel_script_pubkey,
    check_voucher_shape,
    close_fee_floor,
    complete_voucher,
    parse_pq_channel_script,
    parse_pq_close_script_sig,
    verify_voucher_signature,
    voucher_sighash,
    yed_voucher_layout,
)
from x402_ycash.pq import SCHEME_SLH_DSA_SHA2_128S, PQKeyId, PQKeyPair, parse_pq_spend, pqpkh_key_id, pqpkh_script
from x402_ycash.pq import verify as pq_verify
from x402_ycash.tx import (
    OutPoint,
    encode_address,
    encode_pq_address,
    hash160,
    p2pkh_script,
    parse_script,
    parse_tx,
    verify_input_sig,
)

VEC = json.loads((Path(__file__).parents[3] / "vectors" / "pq" / "yellowback_pq_vectors.json").read_text())["scripts"]
G = bytes.fromhex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
SERVER = Key(9)
MERCHANT = Key(2)
KP = PQKeyPair.from_seed(SCHEME_SLH_DSA_SHA2_128S, bytes(range(48)))


def test_matcher_vectors() -> None:
    assert len(VEC) > 300
    for s in VEC:
        spk = bytes.fromhex(s["hex"])
        ch = parse_pq_channel_script(spk)
        pkh = pqpkh_key_id(spk)
        kind = "pqchannel" if ch else "pqpubkeyhash" if pkh else "other"
        assert (s["name"], kind) == (s["name"], s["type"])
        kid = ch.client if ch else pkh
        holder = (bytes([kid.scheme]) + kid.hash).hex() if kid else ""
        assert (s["name"], holder) == (s["name"], s["holder"])
        if ch:
            assert build_pq_channel_script(ch).hex() == s["hex"]
            assert channel_script_pubkey(spk) == spk


def test_template_bytes() -> None:
    h = bytes([7]) * 32
    s = build_pq_channel_script(PQChannelScript(PQKeyId(1, h), G, 1_000_000))
    assert s.hex() == f"6320{h.hex()}51c26921{G.hex()}ac670340420fb17520{h.hex()}51c268"
    assert len(build_pq_channel_script(PQChannelScript(PQKeyId(2, h), G, 1))) == 112
    with pytest.raises(ValueError, match="block height"):
        build_pq_channel_script(PQChannelScript(PQKeyId(1, h), G, 500_000_000))
    with pytest.raises(ValueError, match="valid compressed"):
        build_pq_channel_script(PQChannelScript(PQKeyId(1, h), b"\x02" + bytes(32), 5))


def test_spends() -> None:
    rs = build_pq_channel_script(PQChannelScript(KP.key_id, SERVER.pub, 1200))
    ch = Channel.from_script(OutPoint("ab" * 32, 0), rs, 50_000, 30_000, p2pkh_script(bytes([0xAA]) * 20))
    assert ch.template == "pq" and ch.client_pq == KP.key_id and ch.server_pubkey == SERVER.pub and ch.refund_height == 1200
    ret = pqpkh_script(PQKeyId(1, bytes([0xBB]) * 32))
    layout = yed_voucher_layout(2_000)
    v = build_voucher(ch, 100, KP, BRANCH_ID, ret, layout)
    assert check_voucher_shape(v, ch, 100, layout, client_script=ret) is None
    assert verify_voucher_signature(v, ch, BRANCH_ID) and not verify_voucher_signature(v, ch, BRANCH_ID ^ 1)
    assert len(parse_script(v.vin[0].script_sig)) == 16 + 1 + 4
    done = complete_voucher(v, ch, SERVER.priv, BRANCH_ID)
    ps = parse_pq_close_script_sig(done.vin[0].script_sig)
    assert ps is not None
    sh = voucher_sighash(done, ch, BRANCH_ID)
    assert verify_input_sig(ps.sig_s, sh, SERVER.pub) and pq_verify(1, ps.spend.pk, ps.spend.sig[:-1], sh)
    assert check_voucher_shape(done, ch, 100, layout, client_script=ret) == "script_sig"
    assert check_voucher_shape(done, ch, 100, layout, allow_completed=True, client_script=ret) is None
    assert close_fee_floor(rs, done.vout) == 27_000
    with pytest.raises(TypeError):
        build_voucher(ch, 100, SERVER.priv, BRANCH_ID, ret, layout)
    r = build_yed_refund(ch, 2_000, KP, ret, BRANCH_ID)
    chunks = parse_script(r.vin[0].script_sig)
    assert len(chunks) == 16 + 1 + 3 and chunks[-1].op == 0 and r.lock_time == 1200
    sp = parse_pq_spend(chunks[:-1])
    assert sp is not None and pq_verify(1, sp.pk, sp.sig[:-1], voucher_sighash(r, ch, BRANCH_ID))


class Env:
    def __init__(self, deposit: int = 2_000, amount: str = "1") -> None:
        self.node = FakeNode()
        self.node.yellowback = True
        self.closes: list = []
        pay_to = encode_address(NETWORK, "yed", hash160(MERCHANT.pub))
        self.server = BatchYcashServerScheme(self.node, SERVER.priv, max_deposit=100_000_000, max_deposit_cents=10_000,
                                             min_lock_blocks=30, close_margin_blocks=5, on_close=self.closes.append)
        self.m = self.server.manager
        self.req = batch_requirements(SERVER.pub, pay_to, amount, "YED", 1, max_deposit="10000", close_fee="30000")
        # the client returns its YED to a post-quantum holder (the 53-character yr… form)
        self.client = ClientSim(self.node, self.req, deposit, pq=True, pq_key=KP,
                                return_address=encode_pq_address(NETWORK, "yedpq", 1, KP.key_id.hash))


async def test_yed_channel_on_tx_pqchannel_open_pay_close_and_facilitator() -> None:
    env = Env()
    p = env.client.open(100)
    assert parse_pq_channel_script(bytes.fromhex(p.payload["redeemScript"])) is not None
    with pytest.raises(BatchSettlementError) as e:
        await env.m.verify(p, env.req)
    assert e.value.reason == BatchError.FUNDING_DEPTH
    env.node.mine()
    v = await env.m.verify(p, env.req)
    s = await env.m.settle(v, 1)
    assert s.success and s.extra["channelState"]["deposit"] == "2000"
    funding = parse_tx(env.client.funding_hex)
    assert funding.vout[0].script_pubkey == env.client.channel.redeem_script  # bare, not P2SH
    f = BatchYcashFacilitatorScheme(env.node)
    assert (await f.averify(env.client.voucher(100), env.req)).is_valid
    # the client's close at the charged total: the server completes with its ECDSA signature and broadcasts
    c = await env.m.verify(env.client.voucher(100, "close"), env.req)
    await env.m.settle(c, 0)
    assert len(env.closes) == 1
    close = parse_tx(env.node.txs[env.closes[0].txid]["hex"])
    ps = parse_pq_close_script_sig(close.vin[0].script_sig)
    assert ps is not None and ps.sig_s
    assert (await env.node.verify_scripts(close.serialize_hex())).complete


async def test_yec_on_tx_pqchannel_is_refused() -> None:
    node = FakeNode()
    pay_to = MERCHANT.address
    server = BatchYcashServerScheme(node, SERVER.priv, max_deposit=100_000_000, min_lock_blocks=30, close_margin_blocks=5)
    req = batch_requirements(SERVER.pub, pay_to, "1000", "YEC", 1)
    client = ClientSim(node, req, 100_000, pq=True, pq_key=KP)
    with pytest.raises(BatchSettlementError) as e:
        await server.manager.verify(client.open(1000), req)
    assert e.value.reason == BatchError.REDEEM_SCRIPT


def test_server_yed_close_fee_floor() -> None:
    node = FakeNode()
    with pytest.raises(ValueError, match="post-quantum close"):
        BatchYcashServerScheme(node, SERVER.priv, max_deposit=1, yed_close_fee=5_999)
