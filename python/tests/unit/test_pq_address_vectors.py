# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""The node lines' shared post-quantum address vectors (decision D-9): vectors/pq/pq_address_vectors.json is
ycash-dd / ycash6 src/test/data/pq_address_vectors.json byte for byte (up/b2-pq-prefix); its sha256 is pinned."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from x402_ycash.constants import YCASH_MAINNET, YCASH_NETWORKS, YCASH_REGTEST, YCASH_TESTNET
from x402_ycash.tx.address import PQ_VERSIONS, decode_address, encode_pq_address

RAW = (Path(__file__).parents[3] / "vectors" / "pq" / "pq_address_vectors.json").read_bytes()
SHA256 = "dbbd1da05d995d659e1e9f8a671197e141c272998722d6cca85cdbdb52b61797"
VEC = json.loads(RAW)
NET = {"main": YCASH_MAINNET, "test": YCASH_TESTNET, "regtest": YCASH_REGTEST}


def test_file() -> None:
    assert hashlib.sha256(RAW).hexdigest() == SHA256
    assert VEC["format"] == "ycash-pq-address-vectors-1"
    assert (len(VEC["valid"]), len(VEC["invalid"])) == (72, 60)


@pytest.mark.parametrize("c", VEC["valid"], ids=lambda c: c["address"][:6])
def test_valid(c: dict[str, object]) -> None:
    network = NET[str(c["network"])]
    kind = "yedpq" if c["coin"] == "yed" else "pq"
    scheme = int(c["scheme"])  # type: ignore[call-overload]
    key_hash = bytes.fromhex(str(c["keyhash"]))
    assert PQ_VERSIONS[bytes.fromhex(str(c["version"]))] == (network, kind, scheme)
    for net in (None, network):
        d = decode_address(str(c["address"]), net)
        assert (d.network, d.kind, d.hash, d.scheme) == (network, kind, key_hash, scheme)
    assert encode_pq_address(network, kind, scheme, key_hash) == c["address"]
    for other in YCASH_NETWORKS:
        if other != network:
            with pytest.raises(ValueError):
                decode_address(str(c["address"]), other)


@pytest.mark.parametrize("c", VEC["invalid"], ids=lambda c: f"{c['network']}-{c['coin']}-{c['reason']}")
def test_invalid(c: dict[str, object]) -> None:
    for net in (None, *YCASH_NETWORKS):
        with pytest.raises(ValueError):
            decode_address(str(c["address"]), net)
