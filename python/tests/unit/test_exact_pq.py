# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""Addresses and `exact` on the quantum line, mirroring the TypeScript tests: the 53-character YED
post-quantum form (yb/yt/yr) and plain-YEC sq/tq/rq (quantum spec §4, D-Q-20, D-Q-21); a YED payTo that is
a TX_PQPKH holder; rule 5 and `payer` for a payer spending a TX_PQPKH coin."""

from __future__ import annotations

from x402_ycash import pq
from x402_ycash.constants import YCASH_NETWORKS
from x402_ycash.exact.policy import check_transparent_yec_requirements, check_transparent_yed_requirements
from x402_ycash.exact.script import address_of_script, address_of_script_sig, check_sighash_all
from x402_ycash.exact.verify import ResolvedPayment, YedTransfer, payer_of
from x402_ycash.tx import (
    Tx,
    address_to_script,
    base58check_decode,
    base58check_encode,
    decode_address,
    encode_address,
    encode_pq_address,
)

NET = "ycash:regtest"
KP = pq.PQKeyPair.from_seed(pq.SCHEME_SLH_DSA_SHA2_128S, bytes(range(48)))


def test_pq_address_forms() -> None:
    h = bytes([0x22]) * 32
    for scheme in (1, 2):
        got = [[encode_pq_address(n, k, scheme, h) for k in ("yedpq", "pq")] for n in YCASH_NETWORKS]
        assert [[a[:2] for a in r] for r in got] == [["yb", "sq"], ["yt", "tq"], ["yr", "rq"]]
        assert all(len(a) == 53 for r in got for a in r)
        versions = [[base58check_decode(a)[:3].hex() for a in r] for r in got]
        assert versions == [[f"56ab0{scheme}", f"4dd90{scheme}"], [f"571e0{scheme}", f"4f610{scheme}"], [f"57100{scheme}", f"4c510{scheme}"]]
        for n, row in zip(YCASH_NETWORKS, got, strict=True):
            for k, a in zip(("yedpq", "pq"), row, strict=True):
                d = decode_address(a)
                assert (d.network, d.kind, d.hash, d.scheme) == (n, k, h, scheme)
                assert address_to_script(a, n) == pq.pqpkh_script(pq.PQKeyId(scheme, h))
    assert encode_address("ycash:mainnet", "yed", bytes(20)).startswith("yb")
    bad = base58check_encode(bytes([0x57, 0x10, 0x03]) + bytes(32))
    try:
        decode_address(bad)
        raise AssertionError("scheme 3 decoded")
    except ValueError as e:
        assert "scheme 3" in str(e)


def test_policy() -> None:
    yr_pq = encode_pq_address(NET, "yedpq", 2, bytes([0x5A]) * 32)
    rq = encode_pq_address(NET, "pq", 1, KP.key_id.hash)
    assert check_transparent_yed_requirements(NET, "YED", "2500", yr_pq, 300) is None
    assert "Yellowback" in (check_transparent_yed_requirements(NET, "YED", "2500", rq, 300) or "")
    assert check_transparent_yec_requirements(NET, "YEC", "250000", rq, 300) is None
    assert "2406" in (check_transparent_yec_requirements(NET, "YEC", "2405", rq, 300) or "")
    assert "transparent" in (check_transparent_yec_requirements(NET, "YEC", "250000", yr_pq, 300) or "")


def test_rule5_and_payer_for_a_pq_coin() -> None:
    msg = bytes(32)
    sig = pq.sign(1, KP.sk, msg)
    ss = pq.pq_spend_script(KP.pk, sig + b"\x01")
    assert check_sighash_all(ss) is None
    assert "0x81" in (check_sighash_all(pq.pq_spend_script(KP.pk, sig + b"\x81")) or "")
    rq = encode_pq_address(NET, "pq", 1, KP.key_id.hash)
    assert address_of_script_sig(ss, NET) == rq
    spk = pq.pqpkh_script(KP.key_id)
    assert address_of_script(spk, NET) == rq
    s = ResolvedPayment(NET, "", Tx(), "", "", 0, 1, YedTransfer(2, []))
    assert payer_of(spk, s) == encode_pq_address(NET, "yedpq", 1, KP.key_id.hash)
