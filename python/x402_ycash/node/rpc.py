"""An async ycashd JSON-RPC client for both node lines (v4.5.0 ``ycash-dd``, 6.21.0 ``ycash6``), on
httpx. It wraps the RPCs the x402 facilitator, server and client use; anything else goes through
``call``. Mirrors packages/ycash/src/node/rpc.ts.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import weakref
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlsplit, urlunsplit

import httpx

from .amount import yec_to_zat, zat_to_yec_string
from .errors import RPC_METHOD_NOT_FOUND, RpcError, SendRawTransactionError

NodeLine = Literal["v4", "v6", "unknown"]


def basic_auth_header(user: str, password: str) -> str:
    """Basic auth over UTF-8. The devnet's credentials contain emoji (chain-viz finding C-F1), so
    the header is built by hand from the decoded strings."""
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode("ascii")


def strip_userinfo(raw: str) -> tuple[str, str | None, str | None]:
    """Removes ``user:pass@`` from a URL; returns the bare URL and the userinfo it held, decoded."""
    u = urlsplit(raw)
    user = unquote(u.username) if u.username else None
    password = unquote(u.password) if u.password else None
    host = u.hostname or ""
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    netloc = f"{host}:{u.port}" if u.port else host
    return urlunsplit((u.scheme, netloc, u.path or "/", u.query, u.fragment)), user, password


def line_of(subversion: str) -> NodeLine:
    """``/YcashCpp:4.5.0/`` -> v4; ``/YcashCpp:6.21.0/`` -> v6."""
    m = re.search(r":(\d+)\.\d+", subversion)
    if not m:
        return "unknown"
    return {"4": "v4", "6": "v6"}.get(m.group(1), "unknown")  # type: ignore[return-value]  # literal values


@dataclass(frozen=True)
class NodeCapabilities:
    line: NodeLine
    subversion: str
    version: int
    yellowback: bool
    """Whether the ``yed_*`` RPCs exist (``-experimentalfeatures -yellowback``)."""
    chain: str


@dataclass(frozen=True)
class VerifyScriptsResult:
    complete: bool
    errors: list[dict[str, Any]]


class YcashRpc:
    """One node's JSON-RPC 1.0 endpoint. ycashd answers errors with HTTP 500 (404 for an unknown
    method) and a JSON body, so the body is read whatever the status. One httpx.AsyncClient is kept
    per event loop, so the client is usable from the caller's loop and from the sync bridge's."""

    def __init__(self, url: str, user: str | None = None, password: str | None = None, *,
                 cookie_file: str | Path | None = None, timeout: float = 30.0,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        """``transport`` is httpx's hook, for tests (httpx.MockTransport) or custom networking."""
        bare, url_user, url_password = strip_userinfo(url)
        self.url = bare
        self._timeout = timeout
        self._transport = transport
        self._cookie_file = Path(cookie_file) if cookie_file else None
        user = user if user is not None else url_user
        password = password if password is not None else url_password
        self._auth: str | None = None
        if self._cookie_file is None:
            if user is None or password is None:
                raise ValueError("RPC credentials are required (user and password, or cookie_file)")
            self._auth = basic_auth_header(user, password)
        self._clients: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient] = weakref.WeakKeyDictionary()
        self._next_id = 1
        self._capabilities: NodeCapabilities | None = None

    @classmethod
    def from_devnet_json(cls, path: str | Path, node_index: int, *, timeout: float = 30.0,
                         transport: httpx.AsyncBaseTransport | None = None) -> YcashRpc:
        """A node of a Yellowback devnet. The URL in ``devnet.json`` carries the credentials as
        userinfo; they are stripped and sent from the ``user``/``password`` fields as UTF-8 basic auth."""
        state = json.loads(Path(path).read_text(encoding="utf-8"))
        entry = (state.get("rpc") or {}).get(str(node_index))
        if not entry:
            raise ValueError(f"{path} has no rpc.{node_index}")
        return cls(strip_userinfo(entry["url"])[0], entry["user"], entry["password"], timeout=timeout, transport=transport)

    def _client(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        c = self._clients.get(loop)
        if c is None or c.is_closed:
            c = httpx.AsyncClient(timeout=self._timeout, transport=self._transport)
            self._clients[loop] = c
        return c

    async def aclose(self) -> None:
        c = self._clients.pop(asyncio.get_running_loop(), None)
        if c is not None:
            await c.aclose()

    def _authorization(self) -> str:
        if self._auth is None:
            assert self._cookie_file is not None
            cookie = self._cookie_file.read_text(encoding="utf-8").strip()
            user, sep, secret = cookie.partition(":")
            if not sep:
                raise RpcError(0, f"malformed cookie file {self._cookie_file}", "auth", transport=True)
            self._auth = basic_auth_header(user, secret)
        return self._auth

    async def _post(self, method: str, params: list[Any], timeout: float | None) -> httpx.Response:
        body = {"jsonrpc": "1.0", "id": self._next_id, "method": method, "params": params}
        self._next_id += 1
        try:
            return await self._client().post(
                self.url,
                content=json.dumps(body, default=_json_default),
                headers={"content-type": "application/json", "authorization": self._authorization()},
                timeout=timeout if timeout is not None else self._timeout,
            )
        except httpx.TimeoutException as e:
            raise RpcError(0, f"timed out: {e}", method, transport=True) from e
        except httpx.HTTPError as e:
            raise RpcError(0, f"request failed: {e}", method, transport=True) from e

    async def call(self, method: str, params: list[Any] | None = None, *, timeout: float | None = None) -> Any:
        params = params or []
        res = await self._post(method, params, timeout)
        if res.status_code == 401 and self._cookie_file is not None:
            self._auth = None  # the node restarted and wrote a new cookie
            res = await self._post(method, params, timeout)
        if res.status_code in (401, 403):
            raise RpcError(0, f"HTTP {res.status_code}: unauthorised", method, http_status=res.status_code, transport=True)
        try:
            # Decimal keeps the node's 8-decimal amounts exact.
            payload = json.loads(res.text, parse_float=Decimal)
        except ValueError as e:
            raise RpcError(0, f"HTTP {res.status_code}: not JSON: {res.text[:200]}", method,
                           http_status=res.status_code, transport=True) from e
        err = payload.get("error")
        if err:
            raise RpcError(int(err.get("code", 0)), str(err.get("message", "")), method, http_status=res.status_code)
        return payload.get("result")

    # ------------------------------------------------------------------ capabilities

    async def capabilities(self) -> NodeCapabilities:
        """Detected once per client: which line, and whether the Yellowback RPCs exist."""
        if self._capabilities is None:
            net = await self.get_network_info()
            chain = await self.get_blockchain_info()
            yellowback = True
            try:
                await self.yed_get_info()
            except RpcError as e:
                # Only "no such method" means a stock node; an unhealthy index still has the RPCs.
                if e.transport:
                    raise
                if e.code == RPC_METHOD_NOT_FOUND:
                    yellowback = False
            self._capabilities = NodeCapabilities(line_of(net["subversion"]), net["subversion"], int(net["version"]),
                                                  yellowback, chain["chain"])
        return self._capabilities

    # ------------------------------------------------------------------ chain

    async def get_network_info(self) -> dict[str, Any]:
        return await self.call("getnetworkinfo")

    async def get_blockchain_info(self) -> dict[str, Any]:
        return await self.call("getblockchaininfo")

    async def get_block_count(self) -> int:
        return int(await self.call("getblockcount"))

    async def get_raw_mempool(self) -> list[str]:
        return await self.call("getrawmempool")

    async def get_tx_out(self, txid: str, n: int, include_mempool: bool) -> dict[str, Any] | None:
        """None when the output is spent, unknown, or (include_mempool) spent by a mempool tx (plan R-6).
        ``value`` is a Decimal; ``value_zat`` is added in zatoshis."""
        out = await self.call("gettxout", [txid, n, include_mempool])
        if out is not None:
            out["value_zat"] = yec_to_zat(out["value"])
        return out

    async def decode_raw_transaction(self, hex_tx: str) -> dict[str, Any]:
        return await self.call("decoderawtransaction", [hex_tx])

    async def verify_scripts(self, hex_tx: str) -> VerifyScriptsResult:
        """Script verification on any node, wallet or not: ``signrawtransaction hex [] []`` signs
        nothing and runs VerifyScript on every input (plan R-5; ycash-dd/src/rpc/rawtransaction.cpp:1069-1079,
        ycash6 :1226-1231; deprecated but enabled by default on 6.21.0)."""
        r = await self.call("signrawtransaction", [hex_tx, [], []])
        return VerifyScriptsResult(bool(r["complete"]), list(r.get("errors") or []))

    async def send_raw_transaction(self, hex_tx: str) -> str:
        """Relay a signed tx. A resubmission of a mempool tx returns its txid with no error (plan R-3),
        so callers deduplicate by txid. Node refusals raise SendRawTransactionError with a ``kind``."""
        try:
            return await self.call("sendrawtransaction", [hex_tx])
        except RpcError as e:
            if e.transport:
                raise
            raise SendRawTransactionError(e) from e

    # ------------------------------------------------------------------ Yellowback (YED)

    async def yed_validate_raw_transaction(self, hex_tx: str) -> dict[str, Any]:
        return await self.call("yed_validaterawtransaction", [hex_tx])

    async def yed_decode_payload(self, hex_tx: str) -> dict[str, Any]:
        return await self.call("yed_decodepayload", [hex_tx])

    async def yed_get_price(self, height: int | None = None) -> dict[str, Any]:
        return await self.call("yed_getprice", [] if height is None else [height])

    async def yed_get_info(self) -> dict[str, Any]:
        return await self.call("yed_getinfo")

    # ------------------------------------------------------------------ wallet and regtest helpers

    async def list_unspent(self, minconf: int = 1, maxconf: int = 9_999_999,
                           addresses: list[str] | None = None) -> list[dict[str, Any]]:
        return await self.call("listunspent", [minconf, maxconf, addresses] if addresses else [minconf, maxconf])

    async def get_new_address(self) -> str:
        return await self.call("getnewaddress")

    async def dump_priv_key(self, address: str) -> str:
        return await self.call("dumpprivkey", [address])

    async def send_to_address(self, address: str, zat: int) -> str:
        return await self.call("sendtoaddress", [address, zat_to_yec_string(zat)])

    async def generate(self, n: int) -> list[str]:
        return await self.call("generate", [n], timeout=120 + 10 * n)


def _json_default(o: object) -> object:
    if isinstance(o, Decimal):
        return str(o)
    raise TypeError(f"not JSON serialisable: {type(o).__name__}")
