"""Offline replay of the node-generated vectors in vectors/tx (plan X-2), as the TypeScript
tx.vectors.test.ts does: every case was accepted by sendrawtransaction and mined on its line."""

import pytest

from tests.conftest import load_vector
from x402_ycash.tx import (
    OP,
    decode_wif,
    encode_address,
    fee_floor,
    hash160,
    logical_actions,
    p2pkh_script_sig,
    p2sh_script_sig,
    parse_tx,
    pubkey_from_priv,
    sighash_v4,
    sign_input,
    tx_fee,
    txid,
    verify_input_sig,
)

NODE_FILES = ["ycash-dd.json", "ycash-dd-canopy.json", "ycash6.json"]
NODE_CASES = [(f, c) for f in NODE_FILES for c in load_vector(f"tx/{f}")["cases"]]


def test_node_vectors_cover_both_lines():
    files = [load_vector(f"tx/{f}") for f in NODE_FILES]
    assert [f["subversion"] for f in files] == ["/YcashCpp:4.5.0/", "/YcashCpp:4.5.0/", "/YcashCpp:6.21.0-rc1/"]
    for f in files:
        assert len(f["cases"]) == 13
        assert all(c["accepted"] and c["mined"] for c in f["cases"])
        assert sum(1 for c in f["cases"] if c["nodeSignedIdentical"] is True) == 9


@pytest.mark.parametrize(("fname", "case"), NODE_CASES, ids=[f"{f}:{c['name']}" for f, c in NODE_CASES])
def test_node_case(fname, case):
    branch = int(case["branchId"], 16)
    tx = parse_tx(case["unsignedHex"])
    assert tx.serialize_hex() == case["unsignedHex"]
    for i, inp in enumerate(case["inputs"]):
        p = case["prevouts"][i]
        assert inp["scriptCode"] == p.get("redeemScript", p["scriptPubKey"])
        sh = sighash_v4(tx, i, bytes.fromhex(inp["scriptCode"]), int(p["value"]), inp["hashType"], branch)
        assert sh.hex() == inp["sighash"]
        keys = [decode_wif(w).priv_key for w in inp["wifs"]]
        sigs = [sign_input(sh, k, inp["hashType"]) for k in keys]
        for s, k in zip(sigs, keys, strict=True):
            assert verify_input_sig(s, sh, pubkey_from_priv(k))
        rs = bytes.fromhex(p.get("redeemScript", ""))
        if inp["kind"] == "p2pkh":
            tx.vin[i].script_sig = p2pkh_script_sig(sigs[0], pubkey_from_priv(keys[0]))
        elif inp["kind"] == "p2sh-channel-close":
            tx.vin[i].script_sig = p2sh_script_sig([OP.OP_0, sigs[0], sigs[1], OP.OP_1], rs)
        else:
            tx.vin[i].script_sig = p2sh_script_sig([sigs[0], OP.OP_0], rs)
    assert tx.serialize_hex() == case["signedHex"]
    assert txid(tx) == case["txid"] == txid(case["signedHex"])
    assert str(tx_fee(tx, [int(p["value"]) for p in case["prevouts"]])) == case["feeZat"]
    assert logical_actions(tx) == case["logicalActions"]
    assert int(case["feeZat"]) == fee_floor(tx)  # every case paid exactly the S-6 floor and relayed


@pytest.mark.parametrize("fname", NODE_FILES)
def test_negatives_parse(fname):
    negs = load_vector(f"tx/{fname}")["negatives"]
    assert "non-final" in negs[0]["error"]
    assert "Locktime requirement not satisfied" in negs[1]["error"]
    for n in negs:
        parse_tx(n["signedHex"])


YEW = load_vector("tx/yew-transparent.json")["transactions"]


@pytest.mark.parametrize("t", YEW, ids=[t["txid"][:12] for t in YEW])
def test_yew_vector(t):
    tx = parse_tx(t["unsignedHex"])
    for i, p in enumerate(t["prevouts"]):
        sh = sighash_v4(tx, i, bytes.fromhex(p["scriptPubKeyHex"]), p["valueZat"], 1, int(t["branchId"], 16))
        assert sh.hex() == t["sighashPerInput"][i]
        priv = decode_wif(t["keys"][i]["wif"]).priv_key
        assert pubkey_from_priv(priv).hex() == t["keys"][i]["pubkeyHex"]
        tx.vin[i].script_sig = p2pkh_script_sig(sign_input(sh, priv), pubkey_from_priv(priv))
    assert tx.serialize_hex() == t["signedHex"]
    assert txid(tx) == t["txid"]
    assert tx_fee(tx, [p["valueZat"] for p in t["prevouts"]]) == t["feeZat"]


def test_yew_addresses_match_the_node():
    for k in (k for t in YEW for k in t["keys"]):
        pkh = hash160(pubkey_from_priv(decode_wif(k["wif"]).priv_key))
        assert pkh.hex() == k["hash160Hex"]
        assert encode_address("ycash:regtest", "p2pkh", pkh) == k["address"]
        assert encode_address("ycash:regtest", "yed", pkh) == k["address_ye"]


SIGHASH_ROWS = load_vector("tx/sighash-node-tests.json")["cases"]


def test_sighash_rows_from_both_lines():
    assert {c["line"] for c in SIGHASH_ROWS} == {"ycash-dd", "ycash6"}
    shielded = 0
    for c in SIGHASH_ROWS:
        raw, script, idx, hash_type, branch_id, expected = c["row"]
        tx = parse_tx(raw)
        shielded += tx.has_shielded()
        assert tx.serialize_hex() == raw
        sh = sighash_v4(tx, idx, bytes.fromhex(script), 0, hash_type & 0xFFFFFFFF, branch_id & 0xFFFFFFFF)
        assert sh[::-1].hex() == expected
    assert shielded > 100


SHIELDED = [(f, c) for f in ("ycash-dd-shielded.json", "ycash6-shielded.json") for c in load_vector(f"tx/{f}")["cases"]]


@pytest.mark.parametrize(("fname", "c"), SHIELDED, ids=[f"{f}:{c['name']}" for f, c in SHIELDED])
def test_wallet_built_shielded(fname, c):
    tx = parse_tx(c["hex"])
    assert tx.serialize_hex() == c["hex"]
    assert txid(tx) == c["txid"]
    assert [len(tx.vin), len(tx.vout), len(tx.shielded_spends), len(tx.shielded_outputs), len(tx.join_splits)] == [
        c["nVin"], c["nVout"], c["nShieldedSpend"], c["nShieldedOutput"], c["nJoinSplit"]]
    assert str(tx.value_balance) == c["valueBalanceZat"]
    assert tx.binding_sig is not None and len(tx.binding_sig) == 64
    # decoderawtransaction prints cv, cmu and ephemeralKey as uint256 (reversed).
    for o, exp in zip(tx.shielded_outputs, c["outputs"], strict=True):
        assert o.cv[::-1].hex() == exp["cv"]
        assert o.cmu[::-1].hex() == exp["cmu"]
        assert o.ephemeral_key[::-1].hex() == exp["ephemeralKey"]
    fee = tx_fee(tx, [int(v) for v in c["inputValuesZat"]])
    assert fee > 0
    if c["feeZat"] is not None:
        assert str(fee) == c["feeZat"]
