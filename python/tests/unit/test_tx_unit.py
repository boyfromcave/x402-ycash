"""Unit rules of x402_ycash.tx beyond the vectors: hashes, scripts, addresses, keys, the client builder."""

import hashlib

import pytest

from tests.unit.fake_node import BRANCH_ID, NETWORK, FakeNode, Key, payment_payload, requirements
from x402_ycash.exact import ExactYcashFacilitatorScheme, Utxo, build_exact_payment
from x402_ycash.tx import (
    OP,
    Num,
    address_to_script,
    base58check_decode,
    base58check_encode,
    build_script,
    decode_address,
    decode_script_num,
    decode_wif,
    encode_address,
    encode_wif,
    fee_floor,
    is_strict_der,
    p2pkh_script,
    p2sh_script,
    parse_script,
    push_data,
    script_num,
    sign_input,
    verify_input_sig,
)
from x402_ycash.tx.hashes import _ripemd160_py


@pytest.mark.parametrize("msg", [b"", b"abc", b"a" * 55, b"a" * 56, b"a" * 64, b"x" * 1000])
def test_ripemd160_fallback_matches(msg):
    if "ripemd160" not in hashlib.algorithms_available:
        pytest.skip("this Python's OpenSSL has no RIPEMD-160 to compare with")
    assert _ripemd160_py(msg) == hashlib.new("ripemd160", msg).digest()


def test_ripemd160_fallback_reference_vectors():
    assert _ripemd160_py(b"").hex() == "9c1185a5c5e9fc54612808977ee8f548b2258d31"
    assert _ripemd160_py(b"abc").hex() == "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"


def test_minimal_pushes_and_numbers():
    assert push_data(b"") == b"\x00" and push_data(b"\x05") == b"\x55"
    assert push_data(b"\x81") == bytes([OP.OP_1NEGATE])
    assert push_data(bytes(76))[:2] == b"\x4c\x4c" and push_data(bytes(256))[:3] == b"\x4d\x00\x01"
    for n in (0, 1, -1, 127, 128, -128, 255, 32767, -32768, 2**31, 500000):
        assert decode_script_num(script_num(n)) == n
    assert build_script([Num(17)]) == b"\x01\x11" and build_script([Num(16)]) == bytes([OP.OP_16])
    assert build_script([OP.OP_DUP]) == b"\x76"
    with pytest.raises(ValueError):
        parse_script(b"\x05\x00")


def test_addresses_take_the_network_from_the_caller():
    h = bytes(range(20))
    sm = encode_address(NETWORK, "p2pkh", h)
    assert sm.startswith("sm") and encode_address("ycash:mainnet", "p2pkh", h).startswith("s1")
    assert encode_address("ycash:mainnet", "yed", h).startswith("ye")
    assert encode_address(NETWORK, "yed", h).startswith("yr")
    assert decode_address(sm).network == "ycash:testnet"  # shared prefix: X-F1
    assert decode_address(sm, NETWORK).network == NETWORK
    with pytest.raises(ValueError):
        decode_address(sm, "ycash:mainnet")
    assert address_to_script(encode_address(NETWORK, "p2sh", h)) == p2sh_script(h)
    assert address_to_script(encode_address(NETWORK, "yed", h)) == p2pkh_script(h)
    with pytest.raises(ValueError):
        base58check_decode(sm[:-1] + ("1" if sm[-1] != "1" else "2"))
    assert base58check_decode(base58check_encode(b"\x00\x00\xff")) == b"\x00\x00\xff"


def test_keys_low_s_der_and_wif():
    k = Key(5)
    sig = sign_input(bytes(range(32)), k.priv)
    assert is_strict_der(sig[:-1]) and sig[-1] == 1
    s_len = sig[5 + sig[3]]
    s = int.from_bytes(sig[6 + sig[3]: 6 + sig[3] + s_len], "big")
    assert s <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0  # low S
    assert verify_input_sig(sig, bytes(range(32)), k.pub)
    assert not verify_input_sig(sig, bytes(32), k.pub)
    assert not verify_input_sig(b"\x30" + sig[1:], bytes(range(32)), b"\x02" + bytes(32))
    w = encode_wif(k.priv, NETWORK)
    assert decode_wif(w).priv_key == k.priv and decode_wif(w).compressed
    with pytest.raises(ValueError):
        decode_wif(w, "ycash:mainnet")


async def test_client_builder_passes_the_facilitator():
    node = FakeNode()
    payer, merchant = Key(1), Key(2)
    coins = [Utxo(node.add_coin(v, payer.script), v) for v in (300_000, 50_000, 9_000_000)]
    req = requirements(merchant.address)
    tx = build_exact_payment(req, coins, payer.priv, node.tip, BRANCH_ID)
    assert len(tx.vin) == 1 and tx.vout[0].value == 250_000 and tx.lock_time == 0
    assert 9_000_000 - sum(o.value for o in tx.vout) == fee_floor(tx)
    r = await ExactYcashFacilitatorScheme(node).averify(payment_payload(req, tx.serialize_hex()), req)
    assert r.is_valid and r.payer == payer.address
    with pytest.raises(ValueError, match="do not cover"):
        build_exact_payment(requirements(merchant.address, "99000000"), coins, payer.priv, node.tip, BRANCH_ID)
