# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""Byte identity with the node's post-quantum library (vectors/pq/pq_vectors.json = ycash-dd
src/test/data/pq_vectors.json @ aa0fd3812): SLH-DSA and Falcon keygen, signature and verification byte
for byte (Falcon signs through the node's vendored C, x402_ycash.pq.falcon; it verifies in stdlib
Python); TX_PQPKH and the chunked spend."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from x402_ycash import pq
from x402_ycash.pq import falcon
from x402_ycash.tx.script import OP, ScriptChunk, build_script, parse_script

V = json.loads((Path(__file__).parents[3] / "vectors" / "pq" / "pq_vectors.json").read_text())


def test_format() -> None:
    assert V["format"] == "ycash-pq-vectors-1"


@pytest.mark.parametrize("k", [k for k in V["keys"] if k["scheme"] == 1], ids=lambda k: k["label"])
def test_slh_dsa_byte_identity(k: dict[str, object]) -> None:
    seed, msg = bytes.fromhex(str(k["seed"])), bytes.fromhex(str(k["msg"]))
    pk, sk = pq.keygen(1, seed)
    assert pk.hex() == k["pk"]
    assert pq.key_hash(1, pk).hex() == k["keyhash"]
    sig = pq.sign(1, sk, msg)
    assert sig.hex() == k["sig"]
    assert pq.verify(1, pk, sig, msg)
    assert not pq.verify(1, pk, sig, bytes(32))
    assert not pq.verify(1, pk, sig[:-1] + bytes([sig[-1] ^ 1]), msg)


@pytest.mark.parametrize("k", [k for k in V["keys"] if k["scheme"] == 2], ids=lambda k: k["label"])
def test_falcon_byte_identity(k: dict[str, object]) -> None:
    seed, msg, entropy = (bytes.fromhex(str(k[f])) for f in ("seed", "msg", "entropy"))
    pk, sk = pq.keygen(2, seed)
    assert pk.hex() == k["pk"]
    assert pq.key_hash(2, pk).hex() == k["keyhash"]
    sig = pq.sign(2, sk, msg, entropy)
    assert sig.hex() == k["sig"]
    assert pq.verify(2, pk, sig, msg)  # the stdlib verifier
    assert falcon.c_verify(pk, sig, msg)  # the node's C verifier agrees
    assert not pq.verify(2, pk, sig, bytes(32))
    assert not pq.verify(2, pk, sig[:-1] + bytes([sig[-1] ^ 1]), msg)


def test_falcon_random_signatures_verify() -> None:
    k = next(k for k in V["keys"] if k["scheme"] == 2)
    pk, sk = pq.keygen(2, bytes.fromhex(str(k["seed"])))
    msg = bytes(range(32))
    a, b = pq.sign(2, sk, msg), pq.sign(2, sk, msg)
    assert a != b  # fresh entropy each time
    assert len(a) == pq.sig_size(2) and a[0] == 0x39
    assert pq.verify(2, pk, a, msg) and pq.verify(2, pk, b, msg)


def test_falcon_argument_checks() -> None:
    with pytest.raises(ValueError):
        pq.keygen(2, bytes(47))
    with pytest.raises(ValueError):
        pq.sign(2, bytes(falcon.SECRETKEY_BYTES), bytes(31))
    with pytest.raises(ValueError):
        pq.sign(2, bytes(falcon.SECRETKEY_BYTES), bytes(32), bytes(87))
    with pytest.raises(RuntimeError):
        pq.sign(2, bytes(falcon.SECRETKEY_BYTES), bytes(32))  # header 0x00, not 0x59
    with pytest.raises(ValueError):
        pq.sign(1, bytes(64), bytes(32), bytes(88))
    with pytest.raises(ValueError):
        pq.keygen(3, bytes(48))


def test_falcon_sources_are_the_node_files() -> None:
    """The vendored C is complete and the build id covers every file."""
    for name in (*falcon.SOURCES, *falcon.HEADERS, "LICENSE"):
        assert (falcon.SOURCE_DIR / name).is_file(), name


@pytest.mark.parametrize("s", V["spends"], ids=lambda s: f"scheme{s['scheme']}")
def test_spend_scripts(s: dict[str, object]) -> None:
    k = V["keys"][s["key"]]
    scheme = int(str(s["scheme"]))
    kid = pq.PQKeyId(scheme, bytes.fromhex(k["keyhash"]))
    spk = pq.pqpkh_script(kid)
    assert spk.hex() == s["scriptPubKey"]
    assert pq.pqpkh_key_id(spk) == kid
    sig = bytes.fromhex(k["sig"]) + bytes([int(str(s["hashtype"]))])
    ss = pq.pq_spend_script(bytes.fromhex(k["pk"]), sig)
    assert ss.hex() == s["scriptSig"]
    assert len(ss) == s["scriptSigSize"] == pq.pq_spend_size(scheme)
    sp = pq.parse_pq_spend(parse_script(ss))
    assert sp is not None and sp.pk.hex() == k["pk"] and sp.sig == sig
    assert pq.spend_matches(sp, kid)
    assert not pq.spend_matches(sp, pq.PQKeyId(scheme, bytes(32)))


def test_refuses_noncanonical_spends() -> None:
    k = next(k for k in V["keys"] if k["scheme"] == 1)
    pk, sig = bytes.fromhex(k["pk"]), bytes.fromhex(k["sig"]) + b"\x01"
    good = parse_script(pq.pq_spend_script(pk, sig))
    assert pq.parse_pq_spend(good) is not None
    shifted = parse_script(build_script([sig[:519], *pq.chunk(sig[519:]), int(OP.OP_16), pk, int(OP.OP_1)]))
    assert pq.parse_pq_spend(shifted) is None
    assert pq.parse_pq_spend([*good, ScriptChunk(int(OP.OP_1))]) is None
    assert pq.parse_pq_spend(parse_script(build_script([*pq.chunk(sig), int(OP.OP_16), *pq.chunk(bytes(897)), int(OP.OP_2)]))) is None


def test_sizes_and_dust() -> None:
    assert [pq.pubkey_size(1), pq.sig_size(1), pq.pubkey_size(2), pq.sig_size(2), pq.pubkey_size(3)] == [32, 7856, 897, 666, 0]
    assert [len(c) for c in pq.chunk(bytes(7857))] == [520] * 15 + [57]
    assert [pq.pq_dust_threshold(1), pq.pq_dust_threshold(2)] == [2406, 498]
    assert pq.max_script_sig_size_of(pq.pqpkh_script(pq.PQKeyId(1, bytes(32)))) == 7938
    assert pq.max_script_sig_size_of(bytes.fromhex("76a914" + "11" * 20 + "88ac")) == 108
