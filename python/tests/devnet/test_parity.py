"""Parity interop with the TypeScript mechanism on a live devnet of either node line (plan X5):

- a TS agent pays a YED exact requirement built by the Python server, settled by the Python
  facilitator (rules 4Y/9Y live on node 0, mined by the strict Yellowback pool);
- a TS client pays sapling-proof requirements issued by the Python server and settled by the Python
  facilitator (bounded note wait, policy −1 and 1), the receipts verified in TS;
- a TS batch client runs a 50-request YEC channel against the Python batch server (upstream's
  x402ResourceServer with the scheme's hooks), closed by Python;
- one YED channel of 20 one-cent requests, closed by Python.

Both channels check the open's ``returnAddress`` (a node 0 wallet address): the close pays the
client's remainder there, node 0's wallet sees it, and nothing pays the channel key C.

    scripts/devnet.sh up dd 241      (or: up 6 243), with X402_SCRATCH set
    X402_DEVNET_JSON=$X402_SCRATCH/dd-241/devnet.json python/.venv/bin/python -m pytest python/tests/devnet/test_parity.py
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest
from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse, SupportedKind

from tests.devnet.test_interop import BRIDGE, DEVNET_JSON, NETWORK, REPO, WALLET, Devnet, Key, ts, wait_for
from x402_ycash.exact import ExactYcashFacilitatorScheme, ExactYcashServerScheme
from x402_ycash.node import RpcError, YcashRpc
from x402_ycash.shielded import SaplingProofHandler, SqliteIssuedAddressRegistry, es256k_signer
from x402_ycash.shielded import constants as SC
from x402_ycash.store import SqliteChannelStore, SqliteSettlementStore
from x402_ycash.tx import encode_address, hash160, pubkey_from_priv, random_priv_key, txid

pytestmark = pytest.mark.skipif(not DEVNET_JSON, reason="X402_DEVNET_JSON is not set")

STOCK, POOL = 1, 2
RESOURCE = "https://merchant.test/x402/report"


def yr_of(k: Key) -> str:
    """The key's Yellowback (yr…) address: YED is held at the same key hash."""
    return encode_address(NETWORK, "yed", hash160(pubkey_from_priv(k.priv)))


def record(line: str, item: str, value: Any) -> None:
    """One greppable line per result, as the TS harness logs findings."""
    print(f"FINDING {line} {item}: {json.dumps(value, default=str)}")


@pytest.fixture
async def devnet():
    d = Devnet()
    assert (await d.wallet.get_blockchain_info())["chain"] == "regtest"
    yield d


async def line_of(d: Devnet) -> str:
    return (await d.wallet.capabilities()).line


# --- YED helpers ------------------------------------------------------------------------------------

async def supply(d: Devnet) -> int:
    return int((await d.wallet.call("yed_getstats"))["supplyCents"])


async def tokens_of(d: Devnet, address: str) -> list[dict[str, Any]]:
    return await d.wallet.call("yed_listtokens", [[address]])


async def ensure_yed(d: Devnet, cents: int) -> None:
    """Node 0's confirmed YED, minting more when short (the lean devnet mints; pool blocks carry the quotes)."""
    async def balance() -> int:
        return int((await d.wallet.call("yed_getbalance"))["confirmedCents"])
    if await balance() >= cents:
        return
    deadline = time.monotonic() + 180
    while True:
        try:
            await d.wallet.call("yed_mint", [max(cents, 10_000), 48, "", "", False])  # MINT is $100..$10,000
            break
        except RpcError as e:
            if "price" not in e.message.lower() or time.monotonic() > deadline:
                raise
            await d.pool.generate(4)
            await asyncio.sleep(1)
    await wait_for(lambda: _mine_then(d, balance, cents), timeout=180, what="the MINT")


async def _mine_then(d: Devnet, balance: Any, cents: int) -> bool:
    await d.mine()
    return await balance() >= cents


async def yed_send(d: Devnet, to: str, cents: int) -> str:
    deadline = time.monotonic() + 60
    while True:
        try:
            return await d.wallet.call("yed_send", [to, cents])
        except RpcError:
            if time.monotonic() > deadline:
                raise
            await d.mine()


async def mine_with(d: Devnet, t: str) -> None:
    """One block on the Yellowback pool (node 2, strict) once ``t`` reached it; checks it carries ``t``."""
    await wait_for(lambda: _in_mempool(d.pool, t), what=f"{t} at the pool")
    await d.mine()
    out = await d.wallet.call("getrawtransaction", [t, 1])
    assert int(out.get("confirmations", 0)) >= 1, f"{t} was not mined"


async def _in_mempool(node: YcashRpc, t: str) -> bool:
    return t in await node.get_raw_mempool()


# --- 1. YED exact -----------------------------------------------------------------------------------

async def test_ts_agent_pays_yed_exact_settled_by_python(devnet: Devnet, tmp_path: Path):
    d = devnet
    line = await line_of(d)
    assert (await d.wallet.capabilities()).yellowback
    await ensure_yed(d, 20_000)
    payer = await d.funded_key()
    merchant = Key()
    await yed_send(d, yr_of(payer), 600)
    await d.mine()
    before = await supply(d)

    facilitator = ExactYcashFacilitatorScheme(d.wallet, yellowback=True, confirmation_timeout=60, confirmation_poll=0.5)
    stock = ExactYcashFacilitatorScheme(d.stock, yellowback=False)
    assert facilitator.get_extra(NETWORK)["assets"] == ["YEC", "YED"] and stock.get_extra(NETWORK)["assets"] == ["YEC"]
    server = ExactYcashServerScheme(usd_asset="YED")
    priced = server.parse_price("$1", NETWORK)
    assert (priced.amount, priced.asset) == ("100", "YED")
    base = PaymentRequirements(scheme="exact", network=NETWORK, asset=priced.asset, amount=priced.amount, pay_to=yr_of(merchant),
                               max_timeout_seconds=600, extra={})
    req = server.enhance_payment_requirements(base, SupportedKind(x402_version=2, scheme="exact", network=NETWORK,
                                                                  extra=facilitator.get_extra(NETWORK)), [])
    assert req.extra["confirmationPolicy"] == {"confirmations": 1}
    with pytest.raises(ValueError, match="does not settle YED"):
        server.enhance_payment_requirements(base, SupportedKind(x402_version=2, scheme="exact", network=NETWORK,
                                                                extra=stock.get_extra(NETWORK)), [])
    p = tmp_path / "yed-req.json"
    p.write_text(req.model_dump_json(by_alias=True, exclude_none=True))
    hex_tx = ts("pay", d.json, str(WALLET), payer.wif, str(p))["transaction"]
    payload = PaymentPayload(x402_version=2, accepted=req.model_copy(deep=True), payload={"transaction": hex_tx})
    decoded = await d.wallet.yed_decode_payload(hex_tx)

    v = await facilitator.averify(payload, req)
    assert v.is_valid, v
    assert v.payer == yr_of(payer)
    assert (await stock.averify(payload, req)).invalid_reason == "invalid_exact_ycash_yed_node_required"
    settling = asyncio.create_task(facilitator.asettle(payload, req))
    await mine_with(d, txid(hex_tx))
    s = await settling
    assert s.success, s
    assert s.transaction == txid(hex_tx) and s.payer == yr_of(payer) and s.extra == {"status": "confirmed", "confirmations": 1}
    assert [t["cents"] for t in await tokens_of(d, yr_of(merchant))] == [100]
    assert sum(t["cents"] for t in await tokens_of(d, yr_of(payer))) == 500
    assert await supply(d) == before
    record(line, "pyparity YED exact", {"txid": s.transaction, "assignments": decoded.get("assignments"), "payer": s.payer})


# --- 2. sapling-proof -------------------------------------------------------------------------------

async def test_ts_client_pays_sapling_proof_issued_and_settled_by_python(devnet: Devnet, tmp_path: Path):
    d = devnet
    line = await line_of(d)
    key = random_priv_key()
    handler = SaplingProofHandler(NETWORK, d.wallet, SqliteSettlementStore(tmp_path / "claims.db"), receipt_key=key,
                                  registry=SqliteIssuedAddressRegistry(tmp_path / "issued.db"), capabilities=await d.wallet.capabilities(),
                                  note_wait=20, note_poll=0.5, fallback_price_micro_usd=50_000_000)
    facilitator = ExactYcashFacilitatorScheme(d.wallet, shielded=handler)
    assert facilitator.get_extra(NETWORK)["assetTransferMethods"] == ["transparent", "sapling-proof"]
    # The payer: transparent coins on the pool's wallet (tier P0: the payee stays private).
    t_from = await d.pool.get_new_address()
    for _ in range(3):
        await d.wallet.send_to_address(t_from, 50_000_000)
    await d.mine()
    pub = es256k_signer(key).public_key.hex()
    results: dict[str, Any] = {}
    for confirmations in (-1, 1):
        issuer = handler.route_issuer("1500000", 900, confirmations=confirmations)
        issued = await issuer.issue(RESOURCE)
        server = ExactYcashServerScheme(shielded=issuer)
        base = PaymentRequirements(scheme="exact", network=NETWORK, asset="YEC", amount="1500000", pay_to=issued.pay_to,
                                   max_timeout_seconds=900, extra={"assetTransferMethod": "sapling-proof"})
        req = server.enhance_payment_requirements(base, SupportedKind(x402_version=2, scheme="exact", network=NETWORK), [])
        assert req.extra == issued.extra and req.pay_to.startswith("yregtestsapling1")
        p = tmp_path / f"sp-{confirmations}.json"
        p.write_text(req.model_dump_json(by_alias=True, exclude_none=True))
        paid = ts("shielded-pay", d.json, str(POOL), t_from, str(p))
        payload = PaymentPayload(x402_version=2, accepted=req.model_copy(deep=True), payload={"txid": paid["txid"]})
        # presented at once: the bounded note wait covers the hop from the pool to the merchant's node
        t0 = time.monotonic()
        s = await facilitator.asettle(payload, req)
        first_settle = round(time.monotonic() - t0, 2)
        if confirmations == 1:
            assert s.error_reason == SC.ERR_SETTLEMENT_PENDING and s.extra == {"status": "pending", "confirmations": -1}, s
            await mine_with(d, paid["txid"])
            s = await facilitator.asettle(payload, req)
        assert s.success, s
        assert s.transaction == paid["txid"] and s.payer is None
        assert s.extra["receivedZat"] == "1500000"
        assert s.extra["status"] == ("mempool" if confirmations == -1 else "confirmed")
        receipt = s.extensions["offer-receipt"]["info"]["receipt"]
        rp = tmp_path / f"receipt-{confirmations}.json"
        rp.write_text(json.dumps(receipt))
        verified = ts("verify-receipt", str(rp), pub)["payload"]
        assert verified["transaction"] == paid["txid"] and verified["payer"] == "anonymous" and verified["resourceUrl"] == RESOURCE
        replay = await facilitator.asettle(payload, req)
        assert replay.error_reason == SC.ERR_DUPLICATE_SETTLEMENT
        results[str(confirmations)] = {"txid": paid["txid"], "status": s.extra["status"], "firstSettleSeconds": first_settle,
                                       "receiptVerifiedInTs": True}
    await d.mine()
    record(line, "pyparity sapling-proof", results)


# --- 3 and 4. batch-settlement ----------------------------------------------------------------------

class BatchSession:
    """A long-lived TS BatchYcashClientScheme (ts_bridge.ts batch-client) driven over JSON lines."""

    def __init__(self, devnet_json: str, node: int, deposit: int) -> None:
        cmd = (f'source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; exec "{REPO}/node_modules/.bin/tsx" "{BRIDGE}" '
               f"batch-client '{devnet_json}' {node} {deposit}")
        self.proc = subprocess.Popen(["bash", "-c", cmd], cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def _ask(self, msg: dict[str, Any]) -> dict[str, Any]:
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("batch-client exited")
        r = json.loads(line)
        if "error" in r:
            raise RuntimeError(f"batch-client {msg['op']}: {r['error']}")
        return r

    def pay(self, req: PaymentRequirements) -> dict[str, Any]:
        return self._ask({"op": "pay", "req": req.model_dump(by_alias=True, exclude_none=True)})["payload"]

    def apply(self, settle: SettleResponse) -> None:
        self._ask({"op": "apply", "settle": settle.model_dump(by_alias=True, exclude_none=True)})

    def close(self) -> None:
        if self.proc.poll() is None:
            assert self.proc.stdin
            try:
                self.proc.stdin.write('{"op":"exit"}\n')
                self.proc.stdin.flush()
                self.proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.kill()


class LocalFacilitatorClient:
    """An in-process FacilitatorClient over upstream's x402Facilitator."""

    def __init__(self, facilitator: Any) -> None:
        self.f = facilitator

    async def verify(self, payload: Any, requirements: Any) -> Any:
        return await self.f.verify(payload, requirements)

    async def settle(self, payload: Any, requirements: Any) -> Any:
        return await self.f.settle(payload, requirements)

    def get_supported(self) -> Any:
        return self.f.get_supported()


async def python_batch_server(node: YcashRpc, tmp_path: Path, **config: Any) -> tuple[Any, Any, list[Any]]:
    """Upstream's x402ResourceServer with the Python batch scheme; its facilitator client fronts an
    x402Facilitator with the Python batch facilitator (registration as for exact)."""
    from x402 import x402Facilitator, x402ResourceServer

    from x402_ycash.batch import register_batch_ycash_facilitator, register_batch_ycash_server

    closes: list[Any] = []
    fac = register_batch_ycash_facilitator(x402Facilitator(), node, NETWORK)
    server = x402ResourceServer(LocalFacilitatorClient(fac))
    scheme = register_batch_ycash_server(server, node, random_priv_key(), NETWORK, min_lock_blocks=30, close_margin_blocks=5,
                                         confirmations=1, store=SqliteChannelStore(tmp_path / "channels.db"), on_close=closes.append,
                                         **config)
    server.initialize()
    return server, scheme, closes


async def run_channel(d: Devnet, server: Any, session: BatchSession, req: PaymentRequirements, n: int) -> tuple[str, dict[str, Any]]:
    """The open (refused below the funding depth, accepted once mined), then n − 1 vouchers, each
    verified by the Python server's hooks before the handler and settled after it. Returns the
    channel id and the open payload."""
    from x402.schemas import PaymentAbortedError

    def wrap(payload: dict[str, Any]) -> PaymentPayload:
        return PaymentPayload(x402_version=2, accepted=req.model_copy(deep=True), payload=payload)

    first = wrap(session.pay(req))
    assert first.payload["type"] == "open" and first.payload["returnAddress"]
    with pytest.raises(PaymentAbortedError, match="funding_depth"):
        await server.verify_payment(first, req)
    await mine_with(d, txid(first.payload["fundingTx"]))
    channel_id = ""
    for i in range(n):
        p = first if i == 0 else wrap(session.pay(req))
        v = await server.verify_payment(p, req)
        assert v.is_valid, v
        channel_id = v.payer
        s = await server.settle_payment(p, req)
        assert s.success, s
        session.apply(s)
    return channel_id, first.payload


def c_hash_of(open_payload: dict[str, Any]) -> bytes:
    """The channel key C's key hash, from the open's redeem script: no output may pay it."""
    from x402_ycash.channel import parse_channel_script

    script = parse_channel_script(bytes.fromhex(open_payload["redeemScript"]))
    assert script is not None
    return hash160(script.client_pubkey)


async def remainder_home(d: Devnet, open_payload: dict[str, Any], close_txid: str, want: int) -> dict[str, Any]:
    """YEC: the close pays ``want`` zatoshis to the open's returnAddress, node 0's wallet received
    them there, and no output pays C."""
    from x402_ycash.tx import address_to_script, p2pkh_script, parse_tx

    home = open_payload["returnAddress"]
    tx = parse_tx(await d.stock.call("getrawtransaction", [close_txid]))
    assert all(o.script_pubkey != p2pkh_script(c_hash_of(open_payload)) for o in tx.vout)
    assert sum(o.value for o in tx.vout if o.script_pubkey == address_to_script(home, NETWORK)) == want
    got = await wait_for(lambda: _received(d.wallet, home, want), timeout=30, what=f"node 0 to receive {want} at {home}")
    return {"returnAddress": home, "remainderZat": got}


async def yed_home(d: Devnet, open_payload: dict[str, Any], close_txid: str, cents: int) -> dict[str, Any]:
    """YED: the open's returnAddress (yr…, node 0's yed_getnewaddress) holds the close's vout 1 with
    the client's cents, node 0's YED wallet lists it, and nothing sits at C's Yellowback address."""
    home = open_payload["returnAddress"]
    assert home.startswith("yr")
    assert await tokens_of(d, encode_address(NETWORK, "yed", c_hash_of(open_payload))) == []
    held = await tokens_of(d, home)
    assert [(t["txid"], t["vout"], t["cents"]) for t in held] == [(close_txid, 1, cents)]

    async def listed() -> bool | None:
        rows = await d.wallet.call("yed_listunspent")
        return True if any((u["txid"], u["vout"], u["cents"]) == (close_txid, 1, cents) for u in rows) else None
    await wait_for(listed, timeout=30, what=f"node 0's YED wallet to list {close_txid}:1")
    return {"returnAddress": home, "cents": cents}


async def test_ts_batch_client_50_yec_requests_against_python_server(devnet: Devnet, tmp_path: Path):
    d = devnet
    line = await line_of(d)
    for _ in range(3):  # fresh confirmed non-coinbase coins for the TS funder
        await d.wallet.send_to_address(await d.wallet.get_new_address(), 500_000_000)
    await d.mine()
    server, scheme, closes = await python_batch_server(d.stock, tmp_path, max_deposit=100_000_000)  # a YEC channel needs no overlay
    pay_to = await d.stock.get_new_address()
    req = scheme.enhance_payment_requirements(
        PaymentRequirements(scheme="batch-settlement", network=NETWORK, asset="YEC", amount=scheme.parse_price("0.00001", NETWORK).amount,
                            pay_to=pay_to, max_timeout_seconds=300, extra={}),
        SupportedKind(x402_version=2, scheme="batch-settlement", network=NETWORK), [])
    session = BatchSession(d.json, WALLET, 100_000)
    try:
        channel_id, opened = await run_channel(d, server, session, req, 50)
    finally:
        session.close()
    state = await scheme.manager.channel_state(channel_id)
    assert state["chargedCumulative"] == "50000" and state["signedCumulative"] == "50000"
    close_txid = await scheme.manager.close(channel_id, "demand")
    assert close_txid and [c.reason for c in closes] == ["demand"]
    await mine_with(d, close_txid)
    received = await wait_for(lambda: _received(d.stock, pay_to, 50_000), timeout=30, what="payTo to receive the close")
    out = await d.stock.get_tx_out(close_txid, 0, False)
    assert out is not None and out["value_zat"] == 50_000
    home = await remainder_home(d, opened, close_txid, int(state["deposit"]) - 50_000)
    record(line, "pyparity YEC channel", {"requests": 50, "charged": state["chargedCumulative"], "closeTxid": close_txid, "received": received,
                                          **home})


async def _received(node: YcashRpc, address: str, want: int) -> int | None:
    from x402_ycash.node import yec_to_zat
    got = yec_to_zat(await node.call("getreceivedbyaddress", [address, 1]))
    return got if got == want else None


async def test_ts_batch_client_yed_channel_20_one_cent_requests(devnet: Devnet, tmp_path: Path):
    d = devnet
    line = await line_of(d)
    await ensure_yed(d, 20_000)
    before = await supply(d)
    server, scheme, closes = await python_batch_server(d.wallet, tmp_path, max_deposit=100_000_000, max_deposit_cents=10_000,
                                                       usd_asset="YED")
    pay_to = yr_of(Key())
    priced = scheme.parse_price("$0.01", NETWORK)
    assert (priced.amount, priced.asset) == ("1", "YED")
    req = scheme.enhance_payment_requirements(
        PaymentRequirements(scheme="batch-settlement", network=NETWORK, asset="YED", amount=priced.amount, pay_to=pay_to,
                            max_timeout_seconds=300, extra={}),
        SupportedKind(x402_version=2, scheme="batch-settlement", network=NETWORK), [])
    session = BatchSession(d.json, WALLET, 500)
    try:
        channel_id, opened = await run_channel(d, server, session, req, 20)
    finally:
        session.close()
    state = await scheme.manager.channel_state(channel_id)
    # 20 one-cent charges; every voucher carries the pre-paid dollar (the floor, X-7)
    assert state["chargedCumulative"] == "20" and state["signedCumulative"] == "100" and state["deposit"] == "500"
    close_txid = await scheme.manager.close(channel_id, "demand")
    assert close_txid and [c.reason for c in closes] == ["demand"]
    decoded = await d.wallet.yed_decode_payload(await d.wallet.call("getrawtransaction", [close_txid]))
    assert decoded["opReturnIndex"] == 2 and decoded["assignments"] == [{"vout": 0, "cents": 100}, {"vout": 1, "cents": 400}]
    await mine_with(d, close_txid)
    assert [t["cents"] for t in await tokens_of(d, pay_to)] == [100]
    home = await yed_home(d, opened, close_txid, 400)
    assert await supply(d) == before
    record(line, "pyparity YED channel", {"requests": 20, "charged": state["chargedCumulative"], "signed": state["signedCumulative"],
                                          "closeTxid": close_txid, "closeAssignments": decoded["assignments"], **home})
