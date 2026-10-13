# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or https://www.opensource.org/licenses/mit-license.php .
"""The server closes every channel before the next network-upgrade activation height (spec "Network
upgrades"; audit 06/X-1). Mirrors packages/ycash/test/unit/batch/upgradeClose.test.ts. Env: tip 300,
the client's lock 40 blocks (t = 340 at open), closeMarginBlocks 5."""

from tests.unit.test_batch import SERVER, Env, refused
from x402_ycash.batch import BatchError, BatchYcashServerScheme
from x402_ycash.batch.upgrade import next_activation_height_of
from x402_ycash.store import SqliteChannelStore

E = BatchError


def pending(h: int) -> dict:
    return {"0badc0de": {"name": "Next", "activationheight": h, "status": "pending"}}


def test_next_activation_height_of():
    assert next_activation_height_of(None, 100) is None
    assert next_activation_height_of({}, 100) is None
    assert next_activation_height_of({
        "a": {"activationheight": 1, "status": "active"},
        "b": {"activationheight": 400, "status": "pending"},
        "c": {"activationheight": 300, "status": "pending"},
        "d": {"activationheight": 90, "status": "pending"},  # at or below the tip: ignored
        "e": {"activationheight": 200, "status": "disabled"},
    }, 100) == 300
    assert next_activation_height_of(pending(101), 100) == 101
    assert next_activation_height_of(pending(100), 100) is None


async def test_open_with_activation_pending_closes_at_activation_minus_margin():
    env = Env()
    env.node.upgrades = pending(320)
    v, _ = await env.open()
    ch = await env.m.ledger.get(v.channel_id)
    assert ch.terms["refundHeight"] > 320 and ch.terms["closeBy"] == 320 and ch.upgrade_close_by == 320
    assert await env.m.sweep(tip=314) == []
    assert [c.reason for c in await env.m.sweep(tip=315)] == ["upgrade"]


async def test_activation_scheduled_after_open_lowers_the_bound_at_the_next_sweep():
    env = Env()
    v, _ = await env.open()
    assert "closeBy" not in (await env.m.ledger.get(v.channel_id)).terms
    env.node.upgrades = pending(320)
    assert await env.m.sweep(tip=305) == []
    assert (await env.m.ledger.get(v.channel_id)).terms["closeBy"] == 320
    env.node.upgrades = pending(330)  # a later height never raises it
    await env.m.sweep(tip=306)
    assert (await env.m.ledger.get(v.channel_id)).terms["closeBy"] == 320
    assert [c.reason for c in await env.m.sweep(tip=315)] == ["upgrade"]


async def test_voucher_inside_the_activation_margin_is_refused_and_closes():
    env = Env()
    await env.open()
    env.node.upgrades = pending(320)
    env.node.tip = 316
    e = await refused(env.request(2000), E.CHANNEL_CLOSING)
    assert "next network upgrade" in str(e)
    assert [c.reason for c in env.closes] == ["upgrade"]


async def test_open_inside_the_activation_margin_is_refused():
    env = Env()
    env.node.upgrades = pending(303)
    await refused(env.m.verify(env.client.open(1000), env.req), E.REDEEM_SCRIPT)


async def test_lowered_bound_survives_a_restart(tmp_path):
    db = tmp_path / "channels.db"
    env = Env(store=SqliteChannelStore(db))
    v, _ = await env.open()
    env.node.upgrades = pending(320)
    await env.m.sweep(tip=305)
    env.node.upgrades = {}
    restarted = BatchYcashServerScheme(env.node, SERVER.priv, max_deposit=100_000_000, min_lock_blocks=30, close_margin_blocks=5,
                                       store=SqliteChannelStore(db), on_close=env.closes.append)
    w = restarted.manager.watcher(poll=0.01, warn=lambda m: None)
    env.node.tip = 314
    assert await w.check() == []
    env.node.tip = 315
    assert [d.channel_id for d in await w.check()] == [v.channel_id]
    assert [c.reason for c in env.closes] == ["upgrade"]
