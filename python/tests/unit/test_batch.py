"""batch-settlement (specs/scheme_batch_settlement_ycash.md): the server's voucher checks and
compare-and-set ledger, the close triggers, the watcher's resume from the store, the facilitator, and
YED channels (overlay checks, the dollar floor). Mirrors the TypeScript batch unit tests, against an
in-memory node."""

import asyncio

import pytest
from x402.schemas import AssetAmount, SupportedKind

from tests.conftest import load_vector
from tests.unit.channel_sim import ClientSim, batch_requirements, wrap
from tests.unit.fake_node import NETWORK, FakeNode, Key
from x402_ycash.batch import (
    CHANNEL_CLOSED,
    BatchError,
    BatchSettlementError,
    BatchYcashFacilitatorScheme,
    BatchYcashServerScheme,
    ChannelManager,
    check_voucher,
    close_cumulative,
    is_exhausted,
    parse_terms,
    required_depth,
)
from x402_ycash.channel import Channel, ChannelScript, build_channel_script, yed_channel_value, yed_voucher_layout
from x402_ycash.store import InMemorySettlementStore, SqliteChannelStore
from x402_ycash.tx import OutPoint, address_to_script, encode_address, hash160, parse_tx, pubkey_from_priv, txid
from x402_ycash.yed import Assignment, transfer_op_return_script

SERVER = Key(9)
MERCHANT = Key(2)
E = BatchError


class Env:
    def __init__(self, asset: str = "YEC", amount: str = "1000", deposit: int = 100_000, confirmations: int = 1, store=None,
                 idle: float = 600.0) -> None:
        self.node = FakeNode()
        self.node.yellowback = asset == "YED"
        self.closes: list = []
        pay_to = encode_address(NETWORK, "yed", hash160(MERCHANT.pub)) if asset == "YED" else MERCHANT.address
        self.server = BatchYcashServerScheme(self.node, SERVER.priv, max_deposit=100_000_000, max_deposit_cents=10_000,
                                             min_lock_blocks=30, close_margin_blocks=5, confirmations=confirmations, store=store,
                                             idle=idle, on_close=self.closes.append)
        self.m: ChannelManager = self.server.manager
        self.req = batch_requirements(SERVER.pub, pay_to, amount, asset, confirmations,
                                      max_deposit="10000" if asset == "YED" else "100000000")
        self.client = ClientSim(self.node, self.req, deposit)

    async def request(self, cumulative: int, charge: int | None = None, kind: str = "voucher"):
        v = await self.m.verify(self.client.voucher(cumulative, kind), self.req)
        return v, await self.m.settle(v, int(self.req.amount) if charge is None else charge)

    async def open(self, cumulative: int | None = None, charge: int | None = None):
        cumulative = int(self.req.amount) if cumulative is None else cumulative
        p = self.client.open(cumulative)
        with pytest.raises(BatchSettlementError) as e:  # relayed at the first verify, accepted at the policy depth
            await self.m.verify(p, self.req)
        assert e.value.reason == E.FUNDING_DEPTH
        self.node.mine()
        v = await self.m.verify(p, self.req)
        return v, await self.m.settle(v, int(self.req.amount) if charge is None else charge)


async def refused(coro, reason: str):
    with pytest.raises(BatchSettlementError) as e:
        await coro
    assert e.value.reason == reason, e.value
    return e.value


# --- terms -----------------------------------------------------------------------------------------

def test_parse_terms_and_depth():
    t = parse_terms(batch_requirements(SERVER.pub, MERCHANT.address))
    assert (t.amount, t.close_fee, t.min_lock_blocks, t.close_margin_blocks, t.confirmations) == (1000, 1500, 30, 5, 1)
    assert [required_depth(c) for c in (-1, 0, 1, 3)] == [0, 1, 1, 3]
    bad = batch_requirements(SERVER.pub, MERCHANT.address, asset="YED", confirmations=-1)
    with pytest.raises(BatchSettlementError, match="YED channels require"):
        parse_terms(bad)
    for k, v in (("minLockBlocks", 0), ("closeMarginBlocks", 30), ("serverPubKey", "02" + "00" * 32), ("maxDeposit", 5),
                 ("areFeesSponsored", True), ("minLockBlocks", True)):
        r = batch_requirements(SERVER.pub, MERCHANT.address)
        r.extra[k] = v
        with pytest.raises(BatchSettlementError) as e:
            parse_terms(r)
        assert e.value.reason == E.REQUIREMENTS


# --- open and the eight voucher checks -------------------------------------------------------------

async def test_open_charges_and_reports_channel_state():
    env = Env()
    v, s = await env.open()
    assert s.success and s.transaction == v.funding_txid and s.payer == v.channel_id
    assert s.extra["channelState"] == {"channelId": v.channel_id, "deposit": "100000", "chargedCumulative": "1000",
                                       "signedCumulative": "1000", "refundHeight": env.client.channel.refund_height, "closeMarginBlocks": 5}
    assert s.extra["commitmentId"] == f"{v.channel_id}@1000"
    _, s2 = await env.request(2000, charge=400)  # the actual charge may be below the ceiling
    assert s2.extra["channelState"]["chargedCumulative"] == "1400" and s2.extra["chargedAmount"] == "400"
    _, s3 = await env.request(2400)  # charged 1400 + amount 1000
    assert s3.extra["channelState"]["signedCumulative"] == "2400"
    # a retried open is checked as a voucher of the known channel
    retry = env.client.open(3400)
    v4 = await env.m.verify(retry, env.req)
    assert v4.kind == "open" and v4.channel_id == v.channel_id
    await env.m.release(v4)


async def test_open_rules():
    env = Env()
    env.client.lock_blocks = 10  # t below tip + minLockBlocks
    await refused(env.m.verify(env.client.open(1000), env.req), E.REDEEM_SCRIPT)
    big = Env(deposit=200_000_000)
    await refused(big.m.verify(big.client.open(1000), big.req), E.DEPOSIT_TOO_LARGE)
    other = Env()
    p = other.client.open(1000)
    p.payload["vout"] = 1
    await refused(other.m.verify(p, other.req), E.FUNDING)


async def test_voucher_checks_one_by_one():
    env = Env()
    v, _ = await env.open()
    cid = v.channel_id
    # 1. unknown channel
    unknown = env.client.voucher(2000)
    unknown.payload["channelId"] = "00" * 32 + ":0"
    await refused(env.m.verify(unknown, env.req), E.UNKNOWN_CHANNEL)
    # 4. shape (another layout), 5. cumulative mismatch and above D, 6. signature
    await refused(env.m.verify(env.client.voucher(1500), env.req), E.CUMULATIVE_MISMATCH)
    await refused(env.m.verify(env.client.voucher(100_001, tx=env.client.voucher_hex(100_000)), env.req), E.CUMULATIVE_EXCEEDS_DEPOSIT)
    tx = parse_tx(env.client.voucher_hex(2000))
    tx.vout[0].value += 1
    await refused(env.m.verify(env.client.voucher(2000, tx=tx.serialize_hex()), env.req), E.VOUCHER_SHAPE)
    forged = parse_tx(env.client.voucher_hex(2000))
    sig_tx = parse_tx(env.client.voucher_hex(3000))
    forged.vin[0].script_sig = sig_tx.vin[0].script_sig  # a signature over another voucher
    await refused(env.m.verify(env.client.voucher(2000, tx=forged.serialize_hex()), env.req), E.VOUCHER_SIGNATURE)
    # one voucher in flight per channel
    held = await env.m.verify(env.client.voucher(2000), env.req)
    await refused(env.m.verify(env.client.voucher(3000), env.req), E.CHANNEL_BUSY)
    await env.m.settle(held, 1000)
    # 8. stale: below the stored voucher
    await env.request(5000)
    await refused(env.m.verify(env.client.voucher(4000), env.req), E.STALE_VOUCHER)
    # 7. the completed voucher must pass the node's script verifier
    real = env.node.verify_scripts

    async def failing(hex_tx):
        r = await real(hex_tx)
        return type(r)(False, [{"txid": "x", "vout": 0, "error": "Script failed an OP_CHECKMULTISIGVERIFY"}])
    env.node.verify_scripts = failing  # type: ignore[method-assign]
    await refused(env.m.verify(env.client.voucher(6000), env.req), E.SCRIPT)
    env.node.verify_scripts = real  # type: ignore[method-assign]
    # 2. margin: refused and closed
    env.node.tip = env.client.channel.refund_height - 5
    await refused(env.m.verify(env.client.voucher(7000), env.req), E.CHANNEL_CLOSING)
    assert [c.reason for c in env.closes] == ["margin"]
    assert (await env.m.ledger.get(cid)).state == CHANNEL_CLOSED
    # 3. after the close: the channel is closing/closed
    await refused(env.m.verify(env.client.voucher(7000), env.req), E.CHANNEL_CLOSING)


async def test_terms_must_be_the_channels():
    env = Env()
    await env.open()
    other = env.req.model_copy(deep=True)
    other.extra["closeFee"] = "2000"
    await refused(env.m.verify(env.client.voucher(2000, req=other), other), E.REQUIREMENTS)
    await refused(env.m.verify(wrap(env.req, {"type": "claim", "channelId": env.client.channel_id, "tx": "00", "cumulative": "1"}),
                               env.req), E.PAYLOAD_TYPE)
    bad_accept = env.client.voucher(2000)
    bad_accept.accepted.extra["minLockBlocks"] = 30.0  # JSON-type equality
    await refused(env.m.verify(bad_accept, env.req), E.REQUIREMENTS)


async def test_store_voucher_compare_and_set_under_concurrency():
    env = Env()
    v, _ = await env.open()
    hexes = {c: env.client.voucher_hex(c) for c in (3000, 4000, 5000)}
    results = await asyncio.gather(*(env.m.ledger.store_voucher(v.channel_id, c, h) for c, h in hexes.items()))
    assert results.count("stored") >= 1
    ch = await env.m.ledger.get(v.channel_id)
    assert ch.signed_cumulative == 5000 and ch.voucher_tx == hexes[5000]
    assert await env.m.ledger.store_voucher(v.channel_id, 4000, hexes[4000]) == "stale"
    assert await env.m.ledger.store_voucher(v.channel_id, 5000, hexes[3000]) == "stale"  # same cumulative, another voucher
    assert await env.m.ledger.store_voucher(v.channel_id, 5000, hexes[5000]) == "stored"


# --- close triggers --------------------------------------------------------------------------------

async def test_exhausted_close_carries_the_highest_voucher():
    env = Env(deposit=3_000)
    v, _ = await env.open()
    await env.request(2000)
    _, s = await env.request(3000)  # charged 3,000 = D: the next request cannot fit
    assert s.success
    assert [(c.reason, c.cumulative) for c in env.closes] == [("exhausted", 3000)]
    close = env.node.txs[env.closes[0].txid]
    assert parse_tx(close["hex"]).vout[0].value == 3000
    assert await env.m.close(v.channel_id) == env.closes[0].txid  # idempotent


async def test_client_close_at_the_charged_total():
    env = Env()
    _v, _ = await env.open()
    await env.request(2000, charge=300)  # charged 1,300
    await refused(env.m.verify(env.client.voucher(2000, "close"), env.req), E.CUMULATIVE_MISMATCH)
    c = await env.m.verify(env.client.voucher(1300, "close"), env.req)
    s = await env.m.settle(c, 0)
    assert s.success and s.transaction == env.closes[0].txid and env.closes[0].reason == "client"
    assert parse_tx(env.node.txs[s.transaction]["hex"]).vout[0].value == 1300


async def test_idle_and_margin_sweep_and_demand():
    env = Env(idle=60)
    v, _ = await env.open()
    assert await env.m.sweep(now=asyncio.get_running_loop().time() + 0) == []
    closed = await env.m.sweep(now=10**9)
    assert [(c.channel_id, c.reason) for c in closed] == [(v.channel_id, "idle")]
    env2 = Env()
    v2, _ = await env2.open()
    closed2 = await env2.m.sweep(tip=env2.client.channel.refund_height - 5)
    assert [(c.channel_id, c.reason) for c in closed2] == [(v2.channel_id, "margin")]
    env3 = Env()
    v3, _ = await env3.open()
    assert await env3.m.close(v3.channel_id) == env3.closes[0].txid and env3.closes[0].reason == "demand"


async def test_close_of_a_channel_spent_by_the_refund():
    env = Env()
    v, _ = await env.open()
    env.node.utxos.pop(f"{v.funding_txid}:0")  # the client's refund spent it
    env.node.send_error = FakeNode.send_error_of(-25, "Missing inputs")
    assert await env.m.close(v.channel_id) is None
    assert (await env.m.ledger.get(v.channel_id)).state == CHANNEL_CLOSED


async def test_watcher_resumes_from_the_store_after_a_restart(tmp_path):
    db = tmp_path / "channels.db"
    env = Env(store=SqliteChannelStore(db))
    v, _ = await env.open()
    await env.request(2000)
    # a new process: a fresh manager over the same store and node
    restarted = BatchYcashServerScheme(env.node, SERVER.priv, max_deposit=100_000_000, min_lock_blocks=30, close_margin_blocks=5,
                                       store=SqliteChannelStore(db), on_close=env.closes.append)
    assert restarted.manager.tracked() == []
    w = restarted.manager.watcher(poll=0.01, warn=lambda m: None)
    assert await w.check() == []  # first tick: resumed, nothing due yet
    assert restarted.manager.tracked() == [v.channel_id]
    env.node.tip = env.client.channel.refund_height - 5
    due = await w.check()
    assert [d.channel_id for d in due] == [v.channel_id]
    assert [(c.reason, c.cumulative) for c in env.closes] == [("margin", 2000)]
    assert await SqliteChannelStore(db).list()  # list() sees every record
    # the background loop starts and stops cleanly
    w.start()
    await asyncio.sleep(0.03)
    await w.stop()


async def test_sqlite_channel_store(tmp_path):
    from x402_ycash.store import ChannelRecord
    s = SqliteChannelStore(tmp_path / "c.db")
    assert await s.open(ChannelRecord("a", 0, {"k": [1, "x"]})) and not await s.open(ChannelRecord("a", 5))
    assert await s.compare_and_set_cumulative("a", 0, 2**70) and not await s.compare_and_set_cumulative("a", 0, 1)
    assert (await s.get("a")).cumulative == 2**70 and (await s.get("a")).data == {"k": [1, "x"]}
    assert not await s.compare_and_set_cumulative("missing", 0, 1)
    await s.delete("a")
    assert await s.get("a") is None and await s.list() == []


def test_exhaustion_and_close_rules():
    assert is_exhausted("YEC", 3000, 3000, 1000, 3000) and not is_exhausted("YEC", 3000, 2000, 1000, 2000)
    assert is_exhausted("YED", 300, 200, 50, 200)  # the next voucher (250) would leave $0.50
    assert not is_exhausted("YED", 300, 100, 50, 100)
    assert is_exhausted("YED", 2000, 200, 1750, 200)  # 1,950 leaves $0.50
    assert is_exhausted("YED", 2000, 200, 1, 1950)  # the latest voucher assigns all of D
    assert close_cumulative("YED", 50) == 100 and close_cumulative("YEC", 50) == 50


# --- the facilitator -------------------------------------------------------------------------------

async def test_facilitator_verifies_relays_and_dedups_claims():
    env = Env()
    store = InMemorySettlementStore()
    f = BatchYcashFacilitatorScheme(env.node, settlement_store=store)
    assert f.get_extra(NETWORK) == {"confirmations": {"minimum": -1, "maximum": 20}}
    p = env.client.open(1000)
    assert (await f.averify(p, env.req)).is_valid
    pending = await f.asettle(p, env.req)
    assert pending.error_reason == E.SETTLEMENT_PENDING  # relayed, not yet at depth 1
    env.node.mine()
    s = await f.asettle(p, env.req)
    assert s.success and s.payer == env.client.channel_id
    v = env.client.voucher(5000)
    assert (await f.averify(v, env.req)).is_valid
    assert (await f.asettle(v, env.req)).extra == {"commitmentId": f"{env.client.channel_id}@5000"}
    # the server completes its voucher and asks the facilitator to broadcast it
    from x402_ycash.channel import complete_voucher
    closed = complete_voucher(parse_tx(env.client.voucher_hex(5000)), env.client.channel, SERVER.priv, 0x19BD2D2F).serialize_hex()
    claim = wrap(env.req, {"type": "claim", "channelId": env.client.channel_id, "tx": closed, "cumulative": "5000"})
    assert (await f.averify(claim, env.req)).is_valid
    c = await f.asettle(claim, env.req)
    assert c.success and c.transaction == txid(closed)
    assert (await f.channels.get(env.client.channel_id)).cumulative == 5000
    again = await f.asettle(claim, env.req)
    assert not again.success  # the channel output is spent in the mempool, or the claim is a duplicate
    # an unclaimed voucher as a claim fails rule 7; a client close needs S
    raw = wrap(env.req, {"type": "claim", "channelId": env.client.channel_id, "tx": env.client.voucher_hex(6000), "cumulative": "6000"})
    assert not (await f.averify(raw, env.req)).is_valid
    narrow = BatchYcashFacilitatorScheme(env.node, confirmations=(2, 20))
    assert (await narrow.averify(env.client.voucher(5000), env.req)).invalid_reason == E.REQUIREMENTS


async def test_facilitator_refuses_a_client_close():
    env = Env()
    await env.open()
    f = BatchYcashFacilitatorScheme(env.node)
    r = await f.asettle(env.client.voucher(1000, "close"), env.req)
    assert r.error_reason == E.PAYLOAD_TYPE


# --- YED channels ----------------------------------------------------------------------------------

async def test_yed_channel_the_first_voucher_prepays_a_dollar():
    env = Env(asset="YED", amount="1", deposit=2_000)
    _v, s = await env.open(cumulative=100)  # $0.01 ceiling, but no voucher below $1.00 (X-7)
    assert s.success and s.extra["channelState"]["deposit"] == "2000"
    for c in (100, 100, 100):  # the pre-paid dollar is consumed first
        await env.request(c)
    await refused(env.m.verify(env.client.voucher(99, tx=env.client.voucher_hex(100)), env.req), E.STALE_VOUCHER)
    # the facilitator reads D from the overlay and accepts the voucher with its server slot empty
    f = BatchYcashFacilitatorScheme(env.node)
    assert (await f.averify(env.client.voucher(99, tx=env.client.voucher_hex(100)), env.req)).invalid_reason == E.YED_FLOOR
    assert (await f.averify(env.client.voucher(100), env.req)).is_valid
    # charged 4; a $17.50 ceiling request leaves $0.50 at 1,754 + ...: the remainder rule closes
    big = env.req.model_copy(deep=True)
    big.amount = "1946"
    vv = await env.m.verify(env.client.voucher(1950, req=big), big)
    await env.m.settle(vv, 1946)
    assert [c.reason for c in env.closes] == ["exhausted"]
    close = parse_tx(env.node.txs[env.closes[0].txid]["hex"])
    assert close.vout[2].script_pubkey == transfer_op_return_script([Assignment(0, 2000)])


async def test_yed_overlay_refusals():
    env = Env(asset="YED", amount="1", deposit=500)
    _v, _ = await env.open(cumulative=100)
    ch = env.client.channel
    burning = yed_voucher_layout(500)

    def burns(channel, cumulative, client_script):
        outs = burning(channel, cumulative, client_script)
        outs[2].script_pubkey = transfer_op_return_script([Assignment(0, 100)])  # $4.00 would burn
        return outs
    tx = env.client.voucher_hex(101, layout=burns)
    await refused(env.m.verify(env.client.voucher(101, tx=tx), env.req), E.VOUCHER_SHAPE)
    f = BatchYcashFacilitatorScheme(env.node)
    r = await f.averify(env.client.voucher(101, tx=tx), env.req)
    assert not r.is_valid
    # a stock node cannot serve YED
    stock = Env(asset="YED", amount="1", deposit=500)
    stock.node.yellowback = False
    await refused(stock.m.verify(stock.client.open(100), stock.req), E.YED_NODE_REQUIRED)
    assert (await BatchYcashFacilitatorScheme(stock.node).averify(stock.client.open(100), stock.req)).invalid_reason \
        == E.YED_NODE_REQUIRED
    # an unconfirmed token record (X-F14) is funding_depth for the overlay
    env.node.unconfirmed_tokens.add(f"{ch.outpoint.txid}:0")
    assert (await f.averify(env.client.voucher(101), env.req)).invalid_reason == E.FUNDING_DEPTH


async def test_yed_client_close_pays_the_prepaid_dollar():
    env = Env(asset="YED", amount="25", deposit=500)
    await env.open(cumulative=100)  # charged 25
    await env.request(100)  # charged 50
    c = await env.m.verify(env.client.voucher(100, "close"), env.req)
    s = await env.m.settle(c, 0)
    close = parse_tx(env.node.txs[s.transaction]["hex"])
    assert close.vout[2].script_pubkey == transfer_op_return_script([Assignment(0, 100), Assignment(1, 400)])


async def test_yed_funding_must_carry_the_transfer():
    env = Env(asset="YED", amount="1", deposit=500)
    env.client.fund()
    p = env.client.open(100)
    tx = parse_tx(p.payload["fundingTx"])
    tx.vout[0].value += 1  # V must be 2 × TOKEN_VALUE + closeFee
    p.payload["fundingTx"] = tx.serialize_hex()
    await refused(env.m.verify(p, env.req), E.FUNDING)


# --- vectors: the stateless checks on the TypeScript vouchers --------------------------------------

@pytest.mark.parametrize("name", ["channel/channel_yec.json", "yed-channel/channel_yed.json"])
def test_vector_vouchers_pass_check_voucher(name):
    doc = load_vector(name)
    ch = doc["channel"]
    branch = int(doc["branchId"], 16)
    yed = "depositCents" in ch
    rs = build_channel_script(ChannelScript(pubkey_from_priv(bytes.fromhex(ch["clientPriv"])),
                                            pubkey_from_priv(bytes.fromhex(ch["serverPriv"])), ch["refundHeight"]))
    outpoint = OutPoint(doc["funding"]["txid"], 0) if yed else OutPoint(ch["outpoint"]["txid"], ch["outpoint"]["vout"])
    value = yed_channel_value(int(ch["closeFee"])) if yed else int(ch["value"])
    channel = Channel.from_script(outpoint, rs, value, int(ch["closeFee"]), address_to_script(ch["payTo"], NETWORK))
    deposit = int(ch["depositCents"]) if yed else channel.yec_deposit
    layout = yed_voucher_layout(deposit) if yed else None
    for v in doc["vouchers"]:
        cum = int(v["cumulative"])
        kw = {"deposit": deposit, "branch_id": branch, "floor": 100 if yed else 0, **({"layout": layout} if layout else {})}
        check_voucher(parse_tx(v["voucher"]), channel, cum, charged=0, amount=cum, **kw)
        check_voucher(parse_tx(v["close"]), channel, cum, charged=0, amount=0, allow_completed=True, **kw)
        with pytest.raises(BatchSettlementError) as e:
            check_voucher(parse_tx(v["voucher"]), channel, cum, charged=1, amount=cum, **kw)
        assert e.value.reason == E.CUMULATIVE_MISMATCH


# --- the server scheme -----------------------------------------------------------------------------

def test_parse_price_and_enhance():
    env = Env()
    s = env.server
    assert s.parse_price("0.0002", NETWORK) == AssetAmount(amount="20000", asset="YEC", extra={})
    assert s.parse_price("0.0002 YEC", NETWORK).amount == "20000"
    assert s.parse_price(0.0002, NETWORK).amount == "20000"
    assert s.parse_price("0.01 YED", NETWORK) == AssetAmount(amount="1", asset="YED", extra={})
    with pytest.raises(ValueError, match="price source"):
        s.parse_price("$0.01", NETWORK)
    yed = BatchYcashServerScheme(env.node, SERVER.priv, max_deposit=1, usd_asset="YED")
    assert yed.parse_price("$0.01", NETWORK).amount == "1" and yed.parse_price("0.25 USD", NETWORK).amount == "25"
    with pytest.raises(ValueError, match="whole number of cents"):
        yed.parse_price("$0.001", NETWORK)
    with pytest.raises(ValueError, match="close's fee floor"):
        BatchYcashServerScheme(env.node, SERVER.priv, max_deposit=1, close_fee=100)
    base = env.req.model_copy(update={"extra": {}})
    out = s.enhance_payment_requirements(base, SupportedKind(x402_version=2, scheme="batch-settlement", network=NETWORK), [])
    assert out.extra == env.req.extra
    yreq = base.model_copy(update={"asset": "YED"})
    assert s.enhance_payment_requirements(yreq, SupportedKind(x402_version=2, scheme="batch-settlement", network=NETWORK),
                                          []).extra["maxDeposit"] == "10000"


# --- upstream x402ResourceServer and x402Facilitator -----------------------------------------------

class LocalFacilitatorClient:
    """An in-process FacilitatorClient over upstream's x402Facilitator (what HTTPFacilitatorClient fronts)."""

    def __init__(self, facilitator) -> None:
        self.f = facilitator

    async def verify(self, payload, requirements):
        return await self.f.verify(payload, requirements)

    async def settle(self, payload, requirements):
        return await self.f.settle(payload, requirements)

    def get_supported(self):
        return self.f.get_supported()


async def test_registered_with_upstream_server_and_facilitator():
    from x402 import x402Facilitator, x402ResourceServer
    from x402.schemas import PaymentAbortedError

    from x402_ycash.batch import register_batch_ycash_facilitator, register_batch_ycash_server

    node = FakeNode()
    fac = register_batch_ycash_facilitator(x402Facilitator(), node, NETWORK)
    kinds = fac.get_supported().kinds
    assert [(k.scheme, k.network) for k in kinds] == [("batch-settlement", NETWORK)]
    server = x402ResourceServer(LocalFacilitatorClient(fac))
    scheme = register_batch_ycash_server(server, node, SERVER.priv, NETWORK, max_deposit=100_000_000, min_lock_blocks=30,
                                         close_margin_blocks=5)
    server.initialize()
    req = scheme.enhance_payment_requirements(batch_requirements(SERVER.pub, MERCHANT.address).model_copy(update={"extra": {}}),
                                              kinds[0], [])
    client = ClientSim(node, req, 50_000)
    p = client.open(1000)
    with pytest.raises(PaymentAbortedError, match="funding_depth"):  # relayed at the first verify, below the policy depth
        await server.verify_payment(p, req)
    node.mine()
    r = await server.verify_payment(p, req)
    assert r.is_valid and r.payer == client.channel_id
    s = await server.settle_payment(p, req)
    assert s.success and s.extra["channelState"]["chargedCumulative"] == "1000"
    for c in (2000, 3000):
        v = client.voucher(c)
        assert (await server.verify_payment(v, req)).is_valid
        assert (await server.settle_payment(v, req)).success
    # the corrective 402 of a cumulative mismatch carries the channel state
    from x402.interfaces import SchemePaymentRequiredContext
    from x402.schemas import PaymentRequired
    bad = client.voucher(3500)
    enriched = await scheme.enrich_payment_required_response(SchemePaymentRequiredContext(
        requirements=[req], resource_info=None, error=E.CUMULATIVE_MISMATCH,
        payment_required_response=PaymentRequired(x402_version=2, accepts=[req]), payment_payload=bad))
    assert enriched[0].extra["channelState"]["chargedCumulative"] == "3000"
