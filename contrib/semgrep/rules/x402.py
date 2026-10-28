# Tests for x402.yaml (semgrep --test contrib/semgrep/rules). Not imported, not shipped.
import os
import random
import secrets


def nonce() -> bytes:
    # ruleid: x402.crypto.non-crypto-rng-python
    weak = random.getrandbits(128)
    # ruleid: x402.crypto.non-crypto-rng-python
    rng = random.Random(7)
    # ok: x402.crypto.non-crypto-rng-python
    sys_rng = random.SystemRandom()
    # ok: x402.crypto.non-crypto-rng-python
    strong = secrets.token_bytes(32) + os.urandom(8)
    return strong + bytes([weak & 1, rng.randint(0, 1), sys_rng.randint(0, 1)])


async def rpcs(node) -> None:
    # ruleid: x402.node.yed-write-rpc
    await node.call("yed_redeem")
    # ok: x402.node.yed-write-rpc
    await node.call("yed_getinfo")
