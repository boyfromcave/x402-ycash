"""Minimal JSON-RPC client for a yellowback-devnet devnet.json (UTF-8 basic auth: the devnet's
credentials contain emoji, chain-viz finding C-F1)."""
import base64
import json
import time
import urllib.request
from urllib.error import HTTPError, URLError


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


class Rpc:
    def __init__(self, port, user, password, host="127.0.0.1", timeout=600):
        self.url = f"http://{host}:{port}/"
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode("utf-8")).decode()
        self.timeout = timeout

    @classmethod
    def from_devnet(cls, devnet_json, n):
        r = json.load(open(devnet_json))["rpc"][str(n)]
        return cls(r["port"], r["user"], r["password"])

    def __call__(self, method, *params):
        body = json.dumps({"jsonrpc": "1.0", "id": method, "method": method, "params": list(params)}).encode()
        req = urllib.request.Request(self.url, body, {"Authorization": self.auth, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                out = json.load(resp)
        except HTTPError as e:
            out = json.load(e)
        if out.get("error"):
            raise RpcError(out["error"]["code"], out["error"]["message"])
        return out["result"]

    def wait_ready(self, timeout=120):
        """Poll until the node answers RPC (warmup -28 and connection refusals are retried)."""
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            try:
                return self("getblockcount")
            except (URLError, ConnectionError, RpcError, OSError):
                time.sleep(0.05)
        raise TimeoutError(f"{self.url} not ready after {timeout}s")

    def wait_op(self, opid, timeout=1200):
        """Wait for an async z_* operation; returns its txid (raises on failure)."""
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            st = self("z_getoperationstatus", [opid])
            if st and st[0]["status"] in ("success", "failed", "cancelled"):
                self("z_getoperationresult", [opid])
                if st[0]["status"] != "success":
                    raise RpcError(-1, json.dumps(st[0].get("error")))
                return st[0]["result"]["txid"]
            time.sleep(0.1)
        raise TimeoutError(opid)
