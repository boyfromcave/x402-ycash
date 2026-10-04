"""Interop with the TypeScript mechanism on a live devnet of either node line:

- a payment built by the TypeScript client (ExactYcashScheme + LocalKeySigner) is verified and
  settled by the Python facilitator, on the Yellowback node (rule 9Y live) and on the stock node;
- a payment built by the Python client is verified and settled by the TypeScript facilitator.

    scripts/devnet.sh up dd 221      (or: up 6 223), with X402_SCRATCH set
    X402_DEVNET_JSON=$X402_SCRATCH/dd-221/devnet.json python/.venv/bin/python -m pytest python/tests/devnet
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from pathlib import Path

import pytest
from x402.schemas import PaymentPayload, PaymentRequirements

from x402_ycash.exact import ExactYcashClientScheme, ExactYcashFacilitatorScheme
from x402_ycash.exact import constants as C
from x402_ycash.node import RpcError, YcashRpc
from x402_ycash.tx import encode_address, encode_wif, hash160, pubkey_from_priv, random_priv_key, txid

DEVNET_JSON = os.environ.get("X402_DEVNET_JSON")
pytestmark = pytest.mark.skipif(not DEVNET_JSON, reason="X402_DEVNET_JSON is not set")

REPO = Path(__file__).resolve().parents[3]
BRIDGE = Path(__file__).with_name("ts_bridge.ts")
NETWORK = "ycash:regtest"
WALLET, STOCK, POOL = 0, 1, 2


def ts(*args: str) -> dict:
    """Runs the TypeScript bridge with tsx from the repo's npm workspace."""
    cmd = f'source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; exec "{REPO}/node_modules/.bin/tsx" "{BRIDGE}" ' + " ".join(
        f"'{a}'" for a in args)
    out = subprocess.run(["bash", "-c", cmd], cwd=REPO, capture_output=True, text=True, timeout=180, check=False)
    if out.returncode != 0:
        raise RuntimeError(f"ts_bridge {args[0]} failed: {out.stderr[-2000:]}")
    return json.loads(out.stdout)


class Key:
    def __init__(self) -> None:
        self.priv = random_priv_key()
        self.address = encode_address(NETWORK, "p2pkh", hash160(pubkey_from_priv(self.priv)))
        self.wif = encode_wif(self.priv, NETWORK)


async def wait_for(cond, timeout: float = 60.0, what: str = "condition"):
    deadline = time.monotonic() + timeout
    while True:
        v = await cond()
        if v:
            return v
        if time.monotonic() > deadline:
            raise TimeoutError(f"timed out waiting for {what}")
        await asyncio.sleep(0.25)


class Devnet:
    def __init__(self) -> None:
        assert DEVNET_JSON
        self.json = DEVNET_JSON
        self.wallet = YcashRpc.from_devnet_json(DEVNET_JSON, WALLET)
        self.stock = YcashRpc.from_devnet_json(DEVNET_JSON, STOCK)
        self.pool = YcashRpc.from_devnet_json(DEVNET_JSON, POOL)

    async def mine(self, n: int = 1) -> None:
        """Mines on the pool once every node's mempool holds the wallet's txs, then waits for all."""
        want = set(await self.wallet.get_raw_mempool())
        for node in (self.pool, self.stock):
            await wait_for(lambda node=node: _has(node, want), what="mempool sync")
        hashes = await self.pool.generate(n)
        tip = await self.pool.get_block_count()
        for node in (self.wallet, self.stock):
            await wait_for(lambda node=node: _at(node, tip), what="block sync")
        # Both lines notify the wallet of a block asynchronously: until it catches up, a wallet tx
        # just mined looks unspent-from and sendtoaddress double spends it (the TS harness's syncWallets).
        for h in hashes:
            for t in (await self.wallet.call("getblock", [h]))["tx"]:
                await wait_for(lambda t=t: _wallet_confirmed(self.wallet, t), what=f"wallet to see {t}")

    async def funded_key(self, coins: int = 3, zat: int = 5_000_000) -> Key:
        """A key outside the wallet (no coin-selection race, X-F13), watched so listunspent sees it."""
        k = Key()
        await self.wallet.call("importaddress", [k.address, "", False])
        for _ in range(coins):
            await self.wallet.send_to_address(k.address, zat)
        await self.mine()
        return k


async def _has(node: YcashRpc, want: set[str]) -> bool:
    return want <= set(await node.get_raw_mempool())


async def _wallet_confirmed(node: YcashRpc, t: str) -> bool:
    try:
        return int((await node.call("gettransaction", [t]))["confirmations"]) > 0
    except RpcError as e:
        if e.code == -5:  # not a wallet tx of this node
            return True
        raise


async def _at(node: YcashRpc, tip: int) -> bool:
    return await node.get_block_count() >= tip


def requirements(pay_to: str, amount: str = "250000", confirmations: int = -1) -> PaymentRequirements:
    return PaymentRequirements(scheme="exact", network=NETWORK, asset="YEC", amount=amount, pay_to=pay_to,
                               max_timeout_seconds=300,
                               extra={"assetTransferMethod": "transparent", "areFeesSponsored": False,
                                      "confirmationPolicy": {"confirmations": confirmations}})


def payload(req: PaymentRequirements, hex_tx: str) -> PaymentPayload:
    return PaymentPayload(x402_version=2, accepted=req.model_copy(deep=True), payload={"transaction": hex_tx})


def ts_pay(d: Devnet, key: Key, req: PaymentRequirements, tmp: Path) -> str:
    p = tmp / f"req-{time.monotonic_ns()}.json"
    p.write_text(req.model_dump_json(by_alias=True, exclude_none=True))
    return ts("pay", d.json, str(WALLET), key.wif, str(p))["transaction"]


@pytest.fixture
async def devnet():
    d = Devnet()
    info = await d.wallet.get_blockchain_info()
    assert info["chain"] == "regtest"
    yield d


async def test_ts_client_payment_python_facilitator_mempool(devnet: Devnet, tmp_path: Path):
    d = devnet
    caps = await d.wallet.capabilities()
    assert caps.yellowback  # node 0 runs -yellowback: rule 9Y is exercised live
    payer = await d.funded_key()
    merchant = await d.wallet.get_new_address()
    req = requirements(merchant)
    hex_tx = ts_pay(d, payer, req, tmp_path)

    f = ExactYcashFacilitatorScheme(d.wallet, confirmation_timeout=5, confirmation_poll=0.25)
    v = await f.averify(payload(req, hex_tx), req)
    assert v.is_valid, v
    assert v.payer == payer.address

    # the stock node verifies the same payment (rule 9Y skipped there)
    stock = ExactYcashFacilitatorScheme(d.stock)
    assert not (await d.stock.capabilities()).yellowback
    assert (await stock.averify(payload(req, hex_tx), req)).is_valid

    s = await f.asettle(payload(req, hex_tx), req)
    assert s.success, s
    assert s.transaction == txid(hex_tx) and s.extra == {"status": "mempool", "confirmations": -1}
    assert txid(hex_tx) in await d.wallet.get_raw_mempool()

    again = await f.asettle(payload(req, hex_tx), req)  # duplicate delivery: observes, never rebroadcasts
    assert again.success and again.transaction == s.transaction
    dup = await f.averify(payload(req, hex_tx), req)
    assert dup.invalid_reason == C.ERR_DUPLICATE_SETTLEMENT and dup.payer == payer.address

    # a second facilitator (no shared store) sees the inputs spent in the mempool: rule 6
    other = ExactYcashFacilitatorScheme(d.wallet)
    assert (await other.averify(payload(req, hex_tx), req)).invalid_reason == C.ERR_INPUT_SPENT
    await d.mine()


async def test_ts_client_payment_python_facilitator_one_confirmation(devnet: Devnet, tmp_path: Path):
    d = devnet
    payer = await d.funded_key()
    merchant = await d.wallet.get_new_address()
    req = requirements(merchant, "123456", confirmations=1)
    hex_tx = ts_pay(d, payer, req, tmp_path)
    f = ExactYcashFacilitatorScheme(d.wallet, confirmation_timeout=1, confirmation_poll=0.25)
    first = await f.asettle(payload(req, hex_tx), req)
    assert first.error_reason == C.ERR_SETTLEMENT_PENDING and first.transaction == txid(hex_tx)
    assert first.extra == {"status": "pending", "confirmations": -1}
    await d.mine()
    retry = await f.asettle(payload(req, hex_tx), req)
    assert retry.success and retry.extra == {"status": "confirmed", "confirmations": 1}


async def test_python_client_payment_ts_facilitator(devnet: Devnet, tmp_path: Path):
    d = devnet
    payer = await d.funded_key()
    merchant = await d.wallet.get_new_address()
    req = requirements(merchant, "777777")
    client = ExactYcashClientScheme(d.wallet, payer.priv)
    assert client.address(NETWORK) == payer.address
    hex_tx = (await client.acreate_payment_payload(req))["transaction"]

    # the Python facilitator agrees before the TypeScript one settles
    assert (await ExactYcashFacilitatorScheme(d.wallet).averify(payload(req, hex_tx), req)).is_valid
    p = tmp_path / "req.json"
    p.write_text(req.model_dump_json(by_alias=True, exclude_none=True))
    r = ts("facilitate", d.json, str(WALLET), str(p), hex_tx)
    assert r["verify"]["isValid"], r
    assert r["verify"]["payer"] == payer.address
    assert r["settle"]["success"], r
    assert r["settle"]["transaction"] == txid(hex_tx)
    assert r["settle"]["extra"] == {"status": "mempool", "confirmations": -1}
    out = await d.wallet.get_tx_out(txid(hex_tx), 0, True)
    assert out is not None and out["value_zat"] == 777_777
    await d.mine()
    assert (await d.wallet.get_tx_out(txid(hex_tx), 0, True))["confirmations"] == 1


async def test_upstream_x402_facilitator_over_the_sync_bridge(devnet: Devnet, tmp_path: Path):
    """Upstream's x402Facilitator calls the scheme synchronously from inside its event loop; the
    bridge runs the node calls on its own loop with its own httpx client."""
    from x402 import x402Facilitator

    from x402_ycash.exact import register_exact_ycash_facilitator

    d = devnet
    payer = await d.funded_key()
    req = requirements(await d.wallet.get_new_address(), "100000")
    hex_tx = ts_pay(d, payer, req, tmp_path)
    fac = register_exact_ycash_facilitator(x402Facilitator(), d.wallet, NETWORK, confirmation_timeout=5)
    assert fac.get_supported().kinds[0].extra["assetTransferMethods"] == ["transparent"]
    assert (await fac.verify(payload(req, hex_tx), req)).is_valid
    s = await fac.settle(payload(req, hex_tx), req)
    assert s.success and s.transaction == txid(hex_tx)
    await d.mine()
