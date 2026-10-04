"""vectors/yed: transfer_v3.json (from the node's qa framework) and dollar_floor.json."""

import pytest

from tests.conftest import load_vector
from x402_ycash.yed import (
    Assignment,
    FindPayloadFailure,
    PayloadError,
    decode_payload,
    encode_transfer_payload,
    find_payload,
    is_valid_yed_voucher_cumulative,
    transfer_op_return_script,
    yed_channel_split,
)

V = load_vector("yed/transfer_v3.json")


def _assignments(raw):
    return [Assignment(a["vout"], a["cents"]) for a in raw]


@pytest.mark.parametrize("v", V["encode"], ids=[v["name"] for v in V["encode"]])
def test_encode(v):
    assert encode_transfer_payload(_assignments(v["assignments"])).hex() == v["data"]
    assert transfer_op_return_script(_assignments(v["assignments"])).hex() == v["script"]


@pytest.mark.parametrize("v", V["decode"], ids=[v["name"] for v in V["decode"]])
def test_decode(v):
    p = decode_payload(bytes.fromhex(v["data"]))
    if v["payload"] is None:
        assert isinstance(p, PayloadError)
    else:
        assert not isinstance(p, PayloadError)
        assert p.to_json() == v["payload"]


@pytest.mark.parametrize("v", V["find"], ids=[v["name"] for v in V["find"]])
def test_find(v):
    r = find_payload([bytes.fromhex(s) for s in v["outputs"]])
    if v["payload"] is None:
        if v["opReturnIndex"] is None:
            assert r is None or (isinstance(r, FindPayloadFailure) and r.index is None)
        else:
            assert isinstance(r, FindPayloadFailure) and r.index == v["opReturnIndex"]
    else:
        assert r is not None and not isinstance(r, FindPayloadFailure)
        assert r.index == v["opReturnIndex"]
        assert r.payload.to_json() == v["payload"]


SPLIT = load_vector("yed/dollar_floor.json")["split"]


@pytest.mark.parametrize("c", SPLIT, ids=[f"D={c['depositCents']} c={c['cumulativeCents']}" for c in SPLIT])
def test_dollar_floor(c):
    if c.get("throws"):
        with pytest.raises(ValueError):
            yed_channel_split(c["depositCents"], c["cumulativeCents"])
        assert not is_valid_yed_voucher_cumulative(c["depositCents"], c["cumulativeCents"])
    else:
        s = yed_channel_split(c["depositCents"], c["cumulativeCents"])
        assert (s.server_cents, s.client_cents) == (c["serverCents"], c["clientCents"])
        assert is_valid_yed_voucher_cumulative(c["depositCents"], c["cumulativeCents"])
