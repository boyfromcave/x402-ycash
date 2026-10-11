# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""Writes a Falcon-512 padded differential set from the node's C (x402_ycash.pq.falcon): N key pairs
from deterministic 48-byte seeds, each signing a 32-byte message with deterministic 88-byte entropy.
The TypeScript KAT run (packages/ycash/test/kat, FALCON_DIFF_JSON=<file>) checks that noble reproduces
every key and signature, and this script checks the stdlib verifier accepts each one.

    python/.venv/bin/python python/tests/kat/gen_falcon_differential.py 1000 /path/out.json
"""

from __future__ import annotations

import hashlib
import json
import sys

from x402_ycash import pq
from x402_ycash.pq import falcon


def expand(label: str, n: int) -> bytes:
    out, i = b"", 0
    while len(out) < n:
        out += hashlib.sha512(label.encode() + bytes([i])).digest()
        i += 1
    return out[:n]


def main(n: int, path: str) -> None:
    rows = []
    for i in range(n):
        seed, msg, entropy = expand(f"x402 falcon diff {i} seed", 48), expand(f"x402 falcon diff {i} msg", 32), expand(f"x402 falcon diff {i} entropy", 88)
        pk, sk = falcon.keygen(seed)
        sig = falcon.sign(sk, msg, entropy)
        assert pq.verify(2, pk, sig, msg), i
        rows.append({"seed": seed.hex(), "msg": msg.hex(), "entropy": entropy.hex(), "pk": pk.hex(), "sig": sig.hex()})
    with open(path, "w") as f:
        json.dump({"format": "x402-falcon-differential-1", "source": "ycash-dd src/crypto/pq/falcon (C)", "rows": rows}, f)
    print(f"{n} Falcon key pairs and signatures from the node's C, all accepted by the stdlib verifier: {path}")


if __name__ == "__main__":
    main(int(sys.argv[1]), sys.argv[2])
