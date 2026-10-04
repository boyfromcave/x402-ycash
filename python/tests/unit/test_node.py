"""The async JSON-RPC client against httpx.MockTransport: auth, errors, devnet.json, amounts."""

import base64
import json
from decimal import Decimal

import httpx
import pytest

from x402_ycash.node import (
    RpcError,
    SendRawTransactionError,
    YcashRpc,
    classify_send_error,
    line_of,
    strip_userinfo,
    yec_to_zat,
    zat_to_yec_string,
)

USER, PASSWORD = "x402🦀", "pässwörd🔑"


def mock(handler):
    seen = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(json.loads(request.content), request)

    return httpx.MockTransport(wrapped), seen


def ok(result):
    return lambda body, req: httpx.Response(200, json={"result": result, "error": None, "id": body["id"]})


async def test_utf8_basic_auth_and_json_rpc_1():
    transport, seen = mock(ok(42))
    rpc = YcashRpc("http://127.0.0.1:1/", USER, PASSWORD, transport=transport)
    assert await rpc.call("getblockcount") == 42
    auth = seen[0].headers["authorization"]
    assert base64.b64decode(auth.split()[1]).decode() == f"{USER}:{PASSWORD}"
    body = json.loads(seen[0].content)
    assert body["jsonrpc"] == "1.0" and body["method"] == "getblockcount" and body["params"] == []


async def test_from_devnet_json_strips_userinfo(tmp_path):
    from urllib.parse import quote
    url = f"http://{quote(USER)}:{quote(PASSWORD)}@127.0.0.1:22101/"
    (tmp_path / "devnet.json").write_text(json.dumps({"rpc": {"0": {"url": url, "port": 22101, "user": USER, "password": PASSWORD}}}),
                                          encoding="utf-8")
    transport, seen = mock(ok("regtest"))
    rpc = YcashRpc.from_devnet_json(tmp_path / "devnet.json", 0, transport=transport)
    assert rpc.url == "http://127.0.0.1:22101/"
    await rpc.call("x")
    assert "@" not in str(seen[0].url)
    assert base64.b64decode(seen[0].headers["authorization"].split()[1]).decode() == f"{USER}:{PASSWORD}"
    with pytest.raises(ValueError):
        YcashRpc.from_devnet_json(tmp_path / "devnet.json", 7)
    assert strip_userinfo(url) == ("http://127.0.0.1:22101/", USER, PASSWORD)


async def test_node_errors_whatever_the_status():
    transport, _ = mock(lambda b, r: httpx.Response(500, json={"result": None, "error": {"code": -5, "message": "No such tx"}}))
    with pytest.raises(RpcError) as e:
        await YcashRpc("http://n/", "u", "p", transport=transport).call("gettransaction")
    assert e.value.code == -5 and e.value.method == "gettransaction" and not e.value.transport


@pytest.mark.parametrize("resp", [httpx.Response(401), httpx.Response(200, text="<html>")])
async def test_unauthorised_and_non_json_are_transport_errors(resp):
    transport, _ = mock(lambda b, r: resp)
    with pytest.raises(RpcError) as e:
        await YcashRpc("http://n/", "u", "p", transport=transport).call("x")
    assert e.value.transport


async def test_cookie_reread_after_401(tmp_path):
    cookie = tmp_path / ".cookie"
    cookie.write_text("__cookie__:old")
    calls = []

    def handler(body, req):
        calls.append(req.headers["authorization"])
        if base64.b64decode(req.headers["authorization"].split()[1]).decode() != "__cookie__:new":
            return httpx.Response(401)
        return httpx.Response(200, json={"result": 1, "error": None})
    transport, _ = mock(handler)
    rpc = YcashRpc("http://n/", cookie_file=cookie, transport=transport)
    with pytest.raises(RpcError):
        await rpc.call("x")
    cookie.write_text("__cookie__:new")
    assert await rpc.call("x") == 1


async def test_amounts_are_exact_decimals():
    transport, seen = mock(ok({"value": 0.1, "confirmations": 3, "scriptPubKey": {"hex": ""}}))
    rpc = YcashRpc("http://n/", "u", "p", transport=transport)
    out = await rpc.get_tx_out("ab" * 32, 0, True)
    assert out["value"] == Decimal("0.1") and out["value_zat"] == 10_000_000
    await rpc.send_to_address("smX", 250_000)
    assert json.loads(seen[-1].content)["params"] == ["smX", "0.00250000"]
    assert zat_to_yec_string(1) == "0.00000001" and zat_to_yec_string(-150_000_000) == "-1.50000000"
    assert yec_to_zat("21000000.00000000") == 21_000_000 * 10**8 and yec_to_zat(0.00000001) == 1
    assert yec_to_zat(Decimal("1E-8")) == 1
    with pytest.raises(ValueError):
        yec_to_zat("0.000000001")


async def test_verify_scripts_signs_nothing():
    transport, seen = mock(ok({"hex": "00", "complete": False, "errors": [{"txid": "t", "vout": 0, "error": "bad"}]}))
    r = await YcashRpc("http://n/", "u", "p", transport=transport).verify_scripts("00")
    assert json.loads(seen[0].content)["params"] == ["00", [], []]
    assert not r.complete and r.errors[0]["error"] == "bad"


async def test_send_raw_transaction_classifies():
    transport, _ = mock(lambda b, r: httpx.Response(500, json={"error": {"code": -26, "message": "18: txn-mempool-conflict"}}))
    with pytest.raises(SendRawTransactionError) as e:
        await YcashRpc("http://n/", "u", "p", transport=transport).send_raw_transaction("00")
    assert e.value.kind == "mempool-conflict" and e.value.reject_code == 18


@pytest.mark.parametrize(("code", "reason", "kind"), [
    (-27, "transaction already in block chain", "already-in-chain"),
    (-25, "", "mempool-conflict"),
    (-25, "Missing inputs", "missing-inputs"),
    (-26, "bad-txns-inputs-spent", "missing-inputs"),
    (-26, "tx-expiring-soon", "expiring-soon"),
    (-26, "tx-overwinter-expired", "expiring-soon"),
    (-26, "mandatory-script-verify-flag-failed", "rejected"),
    (-22, "TX decode failed", "failed"),
])
def test_classify(code, reason, kind):
    assert classify_send_error(code, reason) == kind


async def test_capabilities_once():
    def handler(body, req):
        m = body["method"]
        if m == "getnetworkinfo":
            return httpx.Response(200, json={"result": {"subversion": "/YcashCpp:6.21.0-rc1/", "version": 6210050}})
        if m == "getblockchaininfo":
            return httpx.Response(200, json={"result": {"chain": "regtest"}})
        return httpx.Response(404, json={"error": {"code": -32601, "message": "Method not found"}})
    transport, seen = mock(handler)
    rpc = YcashRpc("http://n/", "u", "p", transport=transport)
    caps = await rpc.capabilities()
    assert (caps.line, caps.yellowback, caps.chain) == ("v6", False, "regtest")
    await rpc.capabilities()
    assert len(seen) == 3


def test_line_of():
    assert line_of("/YcashCpp:4.5.0/") == "v4" and line_of("/YcashCpp:6.21.0-rc1/") == "v6" and line_of("/x/") == "unknown"
