"""The client's return address, the funding expiry and closed-channel retention (spec "``open``" rules
7–9, voucher rule 4, "Storage behaviour"; plan X-F51, X-F52). Mirrors the TypeScript
test/unit/batch/{returnAddress,fundingExpiry,prune}.test.ts and store/channelStore.test.ts."""

import asyncio
import sqlite3

import pytest

from tests.conftest import load_vector
from tests.unit.channel_sim import ClientSim, wrap
from tests.unit.fake_node import NETWORK, Key
from tests.unit.test_batch import MERCHANT, SERVER, Env, refused
from x402_ycash.batch import (
    CHANNEL_CLOSED,
    BatchError,
    BatchSettlementError,
    BatchYcashFacilitatorScheme,
    check_voucher,
    is_batch_payload,
    min_funding_expiry,
    return_script_of,
)
from x402_ycash.batch.ledger import now_ms
from x402_ycash.channel import (
    Channel,
    ChannelScript,
    build_channel_script,
    check_voucher_shape,
    complete_voucher,
    yed_channel_value,
    yed_voucher_layout,
)
from x402_ycash.store import ChannelRecord, InMemoryChannelStore, SqliteChannelStore
from x402_ycash.tx import OutPoint, address_to_script, encode_address, hash160, p2sh_script, parse_tx, pubkey_from_priv, txid

E = BatchError
OTHER = encode_address(NETWORK, "p2pkh", bytes.fromhex("bb" * 20))
P2SH = encode_address(NETWORK, "p2sh", bytes.fromhex("cc" * 20))
MAINNET = encode_address("ycash:mainnet", "p2pkh", bytes.fromhex("dd" * 20))


def reason(f) -> str:
    try:
        f()
    except BatchSettlementError as e:
        return e.reason
    return "accepted"


async def opened(asset: str = "YEC", **kw) -> Env:
    env = Env(asset=asset, **kw) if asset == "YEC" else Env(asset="YED", amount="1", deposit=2_000, **kw)
    await env.open(None if asset == "YEC" else 100)
    return env


# --- rule 7: the address ---------------------------------------------------------------------------

def test_return_script_of_accepts_what_each_asset_holds():
    pay_to = address_to_script(MERCHANT.address, NETWORK)
    w = Key(8)
    assert return_script_of(w.address, NETWORK, "YEC", pay_to) == w.script
    assert return_script_of(P2SH, NETWORK, "YEC", pay_to) == p2sh_script(bytes.fromhex("cc" * 20))
    ye = encode_address(NETWORK, "yed", hash160(w.pub))
    assert return_script_of(ye, NETWORK, "YED", pay_to) == w.script  # a ye… address is the same key hash
    assert return_script_of(w.address, NETWORK, "YED", pay_to) == w.script


def test_return_script_of_refuses():
    pay_to = address_to_script(MERCHANT.address, NETWORK)
    assert reason(lambda: return_script_of(P2SH, NETWORK, "YED", pay_to)) == E.RETURN_ADDRESS
    assert reason(lambda: return_script_of(encode_address(NETWORK, "yed", bytes(20)), NETWORK, "YEC", pay_to)) == E.RETURN_ADDRESS
    assert reason(lambda: return_script_of(MAINNET, NETWORK, "YEC", pay_to)) == E.RETURN_ADDRESS
    assert reason(lambda: return_script_of("not-an-address", NETWORK, "YEC", pay_to)) == E.RETURN_ADDRESS
    assert reason(lambda: return_script_of("x", NETWORK, "YEC", pay_to)) == E.RETURN_ADDRESS
    assert reason(lambda: return_script_of(MERCHANT.address, NETWORK, "YEC", pay_to)) == E.RETURN_ADDRESS
    yed_pay_to = encode_address(NETWORK, "yed", hash160(MERCHANT.pub))
    assert reason(lambda: return_script_of(yed_pay_to, NETWORK, "YED", pay_to)) == E.RETURN_ADDRESS  # payTo's key hash as ye…


async def test_open_without_or_with_a_bad_return_address_is_refused():
    env = Env()
    p = env.client.open(1000)
    without = {k: v for k, v in p.payload.items() if k != "returnAddress"}
    assert not is_batch_payload(without) and not is_batch_payload({**p.payload, "returnAddress": ""})
    await refused(env.m.verify(wrap(env.req, without), env.req), E.PAYLOAD_TYPE)
    for addr in (MERCHANT.address, MAINNET, "x"):
        await refused(env.m.verify(wrap(env.req, {**p.payload, "returnAddress": addr}), env.req), E.RETURN_ADDRESS)
    f = BatchYcashFacilitatorScheme(env.node)
    r = await f.averify(wrap(env.req, {**p.payload, "returnAddress": MERCHANT.address}), env.req)
    assert r.invalid_reason == E.RETURN_ADDRESS


async def test_yed_open_refuses_p2sh_and_accepts_a_transparent_p2pkh():
    env = Env(asset="YED", amount="1", deposit=2_000)
    p = env.client.open(100)
    await refused(env.m.verify(wrap(env.req, {**p.payload, "returnAddress": P2SH}), env.req), E.RETURN_ADDRESS)
    ok = Env(asset="YED", amount="1", deposit=2_000)
    ok.client.return_address = ok.client.wallet.address  # s… P2PKH: a YED holder too
    await ok.open(100)


# --- rule 9 and voucher rule 4: the binding --------------------------------------------------------

async def test_the_server_records_and_binds_the_return_address():
    env = Env()
    p = env.client.open(1000)
    # the open says OTHER, its voucher pays the wallet: the first voucher fails rule 4
    await refused(env.m.verify(wrap(env.req, {**p.payload, "returnAddress": OTHER}), env.req), E.VOUCHER_SHAPE)
    v, _ = await env.open()
    ch = await env.m.ledger.get(v.channel_id)
    assert ch.terms["returnScript"] == env.client.return_script.hex()
    elsewhere = env.client.voucher(3000, tx=env.client.voucher_hex(3000, to=address_to_script(OTHER, NETWORK)))
    await refused(env.m.verify(elsewhere, env.req), E.VOUCHER_SHAPE)
    to_c = env.client.voucher(3000, tx=env.client.voucher_hex(3000, to=env.client.key.script))  # C's key hash: no wallet watches it
    await refused(env.m.verify(to_c, env.req), E.VOUCHER_SHAPE)
    _, s = await env.request(2000)
    assert s.success


async def test_the_close_pays_the_remainder_to_the_return_address():
    env = await opened()
    c = await env.m.verify(env.client.voucher(1000, "close"), env.req)
    s = await env.m.settle(c, 0)
    close = parse_tx(env.node.txs[s.transaction]["hex"])
    assert (close.vout[1].value, close.vout[1].script_pubkey) == (100_000 - 1000, env.client.return_script)
    yed = await opened("YED")
    c = await yed.m.verify(yed.client.voucher(100, "close"), yed.req)
    close = parse_tx(yed.node.txs[(await yed.m.settle(c, 0)).transaction]["hex"])
    assert close.vout[1].script_pubkey == yed.client.return_script


def test_the_yed_layout_refuses_a_p2sh_client_output():
    ch = Channel.from_script(OutPoint("ab" * 32, 0), build_channel_script(ChannelScript(Key(7).pub, SERVER.pub, 1000)),
                             yed_channel_value(1500), 1500, MERCHANT.script)
    layout = yed_voucher_layout(2_000)
    with pytest.raises(ValueError, match="P2PKH"):
        layout(ch, 100, p2sh_script(bytes(20)))
    assert len(layout(ch, 100, Key(8).script)) == 3


async def test_the_facilitator_binds_the_return_address_of_an_open_it_relayed():
    env = Env()
    f = BatchYcashFacilitatorScheme(env.node)
    p = env.client.open(1000)
    assert (await f.asettle(p, env.req)).error_reason == E.SETTLEMENT_PENDING
    env.node.mine()
    assert (await f.asettle(p, env.req)).success
    assert (await f.channels.get(env.client.channel_id)).data["returnScript"] == env.client.return_script.hex()
    elsewhere_hex = env.client.voucher_hex(4000, to=address_to_script(OTHER, NETWORK))
    elsewhere = env.client.voucher(4000, tx=elsewhere_hex)
    assert (await f.averify(elsewhere, env.req)).invalid_reason == E.VOUCHER_SHAPE
    assert (await f.averify(env.client.voucher(4000), env.req)).is_valid
    # a claim paying elsewhere is refused too
    claimed = complete_voucher(parse_tx(elsewhere_hex), env.client.channel, SERVER.priv, 0x19BD2D2F).serialize_hex()
    claim = wrap(env.req, {"type": "claim", "channelId": env.client.channel_id, "tx": claimed, "cumulative": "4000"})
    assert (await f.averify(claim, env.req)).invalid_reason == E.VOUCHER_SHAPE
    # a facilitator that never saw the open reads vout 1: it cannot know the address
    assert (await BatchYcashFacilitatorScheme(env.node).averify(elsewhere, env.req)).is_valid


@pytest.mark.parametrize("name", ["channel/channel_yec.json", "yed-channel/channel_yed.json"])
def test_vectors_carry_the_return_address(name):
    doc = load_vector(name)
    ch = doc["channel"]
    yed = "depositCents" in ch
    # the generators' returnAddress: the funder's key (YED, as ye…) or key 0x33… (YEC), never C's
    priv = bytes.fromhex(ch["funderPriv"]) if yed else bytes.fromhex("33" * 32)
    assert ch["returnAddress"] == encode_address(NETWORK, "yed" if yed else "p2pkh", hash160(pubkey_from_priv(priv)))
    script = address_to_script(ch["returnAddress"], NETWORK)
    assert script.hex() == ch["clientScript"]
    assert script != address_to_script(encode_address(NETWORK, "p2pkh", hash160(pubkey_from_priv(bytes.fromhex(ch["clientPriv"])))), NETWORK)
    rs = build_channel_script(ChannelScript(pubkey_from_priv(bytes.fromhex(ch["clientPriv"])),
                                            pubkey_from_priv(bytes.fromhex(ch["serverPriv"])), ch["refundHeight"]))
    outpoint = OutPoint(doc["funding"]["txid"], 0) if yed else OutPoint(ch["outpoint"]["txid"], ch["outpoint"]["vout"])
    value = yed_channel_value(int(ch["closeFee"])) if yed else int(ch["value"])
    channel = Channel.from_script(outpoint, rs, value, int(ch["closeFee"]), address_to_script(ch["payTo"], NETWORK))
    deposit = int(ch["depositCents"]) if yed else channel.yec_deposit
    kw = {"deposit": deposit, "branch_id": int(doc["branchId"], 16), "floor": 100 if yed else 0,
          **({"layout": yed_voucher_layout(deposit)} if yed else {})}
    assert return_script_of(ch["returnAddress"], NETWORK, "YED" if yed else "YEC", channel.pay_to_script) == script
    for v in doc["vouchers"]:
        tx = parse_tx(v["voucher"])
        if len(tx.vout) > 1:
            assert tx.vout[1].script_pubkey == script
        cum = int(v["cumulative"])
        check_voucher(tx, channel, cum, charged=0, amount=cum, return_script=script, **kw)
        if len(tx.vout) == 1:
            continue  # a YEC voucher with no client output (remainder below dust) binds no script
        with pytest.raises(BatchSettlementError) as e:
            check_voucher(tx, channel, cum, charged=0, amount=cum, return_script=address_to_script(OTHER, NETWORK), **kw)
        assert e.value.reason == E.VOUCHER_SHAPE
    refund = parse_tx(doc["refund"]["tx"])
    assert refund.vout[-1 if not yed else 1].script_pubkey == script


def test_check_voucher_shape_prefers_the_bound_script():
    doc = load_vector("channel/channel_yec.json")
    ch = doc["channel"]
    rs = bytes.fromhex(ch["redeemScript"])
    channel = Channel.from_script(OutPoint(ch["outpoint"]["txid"], ch["outpoint"]["vout"]), rs, int(ch["value"]), int(ch["closeFee"]),
                                  address_to_script(ch["payTo"], NETWORK))
    v = doc["vouchers"][0]
    tx = parse_tx(v["voucher"])
    assert check_voucher_shape(tx, channel, int(v["cumulative"])) is None
    assert check_voucher_shape(tx, channel, int(v["cumulative"]), client_script=bytes.fromhex(ch["clientScript"])) is None
    assert check_voucher_shape(tx, channel, int(v["cumulative"]), client_script=Key(5).script) == "outputs"


# --- rule 8: the funding expiry --------------------------------------------------------------------

def test_min_funding_expiry():
    assert min_funding_expiry(1000, 1) == 1004
    assert min_funding_expiry(1000, -1) == 1003
    assert min_funding_expiry(1000, 0) == 1004
    assert min_funding_expiry(1000, 6) == 1009


async def test_a_funding_that_expires_too_soon_is_refused():
    tip = 300
    env = Env(confirmations=3)
    env.client.expiry_height = tip + 3 + 3 - 1  # one block short
    await refused(env.m.verify(env.client.open(1000), env.req), E.FUNDING)
    assert (await BatchYcashFacilitatorScheme(env.node).averify(env.client.open(1000), env.req)).invalid_reason == E.FUNDING
    ok = Env(confirmations=3)
    ok.client.expiry_height = tip + 3 + 3
    await refused(ok.m.verify(ok.client.open(1000), ok.req), E.FUNDING_DEPTH)  # relayed, waiting for the depth
    never = Env()
    await never.open()  # nExpiryHeight 0 never expires


async def test_the_expiry_is_not_checked_once_the_funding_is_in_a_block():
    env = Env()
    env.client.expiry_height = 300 + 3 + 1
    env.client.lock_blocks = 60
    p = env.client.open(1000)
    await refused(env.m.verify(p, env.req), E.FUNDING_DEPTH)
    env.node.mine()
    env.node.tip += 5  # past the expiry: the funding is mined, so it no longer matters
    f = BatchYcashFacilitatorScheme(env.node)
    assert (await f.averify(p, env.req)).is_valid


# --- retention: stores, ledger, facilitator ---------------------------------------------------------

STORES = [("memory", lambda tmp: InMemoryChannelStore()), ("sqlite", lambda tmp: SqliteChannelStore(tmp / "c.db"))]


@pytest.mark.parametrize("make", [m for _, m in STORES], ids=[n for n, _ in STORES])
async def test_store_retires_and_prunes(make, tmp_path):
    s = make(tmp_path)
    for cid in ("a", "a#state", "b"):
        await s.open(ChannelRecord(cid, 0))
    now = now_ms()
    await s.retire(["a", "a#state", "unknown"], now + 60_000)
    assert (await s.get("a")) == ChannelRecord("a", 0, None, now + 60_000)
    assert await s.prune(now) == 0
    assert sorted(await s.list()) == ["a", "a#state", "b"]
    assert await s.prune(now + 60_000) == 2
    assert await s.list() == ["b"]
    assert await s.get("b") == ChannelRecord("b", 0)


@pytest.mark.parametrize("make", [m for _, m in STORES], ids=[n for n, _ in STORES])
async def test_store_treats_an_expired_record_as_pruned(make, tmp_path):
    s = make(tmp_path)
    await s.open(ChannelRecord("a", 7, {"k": 1}))
    await s.retire(["a"], now_ms() - 1)
    assert await s.get("a") is None
    assert not await s.compare_and_set_cumulative("a", 7, 8)
    assert await s.open(ChannelRecord("a", 0))  # its id can open again, with no retention
    assert await s.get("a") == ChannelRecord("a", 0)
    await s.retire(["a"], now_ms() - 1)
    assert await s.list() == []


def test_sqlite_store_migrates_an_old_database(tmp_path):
    db = tmp_path / "old.db"
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE channels (id TEXT PRIMARY KEY, cumulative TEXT NOT NULL, data TEXT)")
        c.execute("INSERT INTO channels VALUES ('a', '5', NULL)")
    s = SqliteChannelStore(db)
    assert asyncio.run(s.get("a")) == ChannelRecord("a", 5)
    asyncio.run(s.retire(["a"], 1))
    assert asyncio.run(s.list()) == []


async def test_a_closed_channels_records_are_pruned_after_the_window_never_an_open_ones():
    store = InMemoryChannelStore()
    env = Env(store=store)
    env.m.ledger._retention = 60_000
    a, _ = await env.open()
    await env.request(2000)
    c = await env.m.verify(env.client.voucher(2000, "close"), env.req)
    await env.m.settle(c, 0)
    env.client = ClientSim(env.node, env.req, 100_000)  # channel B, from the same wallet
    b, _ = await env.open()

    def of_a(ids: list[str]) -> list[str]:
        return [i for i in ids if i.startswith(a.channel_id)]
    assert len(of_a(await store.list())) >= 5
    assert await store.prune(now_ms()) == 0  # within the window: kept for audit
    closed = await env.m.ledger.get(a.channel_id)
    assert closed.state == CHANNEL_CLOSED and closed.close_txid and len(closed.close_txid) == 64
    assert await store.prune(now_ms() + 60_001) >= 5
    assert of_a(await store.list()) == []
    assert await env.m.ledger.get(a.channel_id) is None
    assert await env.m.resume() == [b.channel_id]
    assert (await env.m.ledger.get(b.channel_id)).charged_cumulative == 1000


async def test_the_facilitator_retires_a_claimed_channel():
    env = await opened()
    f = BatchYcashFacilitatorScheme(env.node, closed_retention_ms=60_000)
    closed = complete_voucher(parse_tx(env.client.voucher_hex(5000)), env.client.channel, SERVER.priv, 0x19BD2D2F).serialize_hex()
    s = await f.asettle(wrap(env.req, {"type": "claim", "channelId": env.client.channel_id, "tx": closed, "cumulative": "5000"}), env.req)
    assert s.success and s.transaction == txid(parse_tx(closed))
    r = await f.channels.get(env.client.channel_id)
    assert r is not None and r.cumulative == 5000 and r.retain_until_ms is not None
    assert await f.channels.prune(now_ms() + 60_001) == 1
