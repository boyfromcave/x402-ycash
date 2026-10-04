"""vectors/channel/channel_yec.json, plus the channel builders' rules."""

import pytest

from tests.conftest import load_vector
from x402_ycash.channel import (
    Channel,
    ChannelScript,
    FundingInput,
    build_channel_script,
    build_funding_tx,
    build_refund,
    build_voucher,
    channel_id_of,
    channel_script_pubkey,
    check_voucher_shape,
    close_fee_floor,
    complete_voucher,
    find_channel_vout,
    parse_channel_id,
    parse_channel_script,
    sign_funding_tx,
    verify_voucher_signature,
    voucher_sighash,
    yec_voucher_outputs,
)
from x402_ycash.tx import OutPoint, address_to_script, hash160, p2pkh_script, parse_tx, pubkey_from_priv, txid

DOC = load_vector("channel/channel_yec.json")
BRANCH = int(DOC["branchId"], 16)
CH = DOC["channel"]
C_PRIV, S_PRIV = bytes.fromhex(CH["clientPriv"]), bytes.fromhex(CH["serverPriv"])
RS = build_channel_script(ChannelScript(pubkey_from_priv(C_PRIV), pubkey_from_priv(S_PRIV), CH["refundHeight"]))
CHANNEL = Channel.from_script(OutPoint(CH["outpoint"]["txid"], CH["outpoint"]["vout"]), RS, int(CH["value"]),
                              int(CH["closeFee"]), address_to_script(CH["payTo"], "ycash:regtest"))
CLIENT_SCRIPT = bytes.fromhex(CH["clientScript"])


def test_spec_example_and_channel_script():
    e = DOC["specExample"]
    ers = build_channel_script(ChannelScript(bytes.fromhex(e["clientPubKey"]), bytes.fromhex(e["serverPubKey"]), e["refundHeight"]))
    assert ers.hex() == e["redeemScript"] and hash160(ers).hex() == e["hash160"]
    assert RS.hex() == CH["redeemScript"]
    assert channel_script_pubkey(RS).hex() == CH["scriptPubKey"]


@pytest.mark.parametrize("v", DOC["vouchers"], ids=[v["cumulative"] for v in DOC["vouchers"]])
def test_voucher_and_close(v):
    voucher = build_voucher(CHANNEL, int(v["cumulative"]), C_PRIV, BRANCH, CLIENT_SCRIPT)
    assert voucher.serialize_hex() == v["voucher"]
    assert voucher_sighash(voucher, CHANNEL, BRANCH).hex() == v["sighash"]
    for got, want in zip(voucher.vout, v["outputs"], strict=True):
        assert (str(got.value), got.script_pubkey.hex()) == (want["value"], want["scriptPubKey"])
    close = complete_voucher(parse_tx(v["voucher"]), CHANNEL, S_PRIV, BRANCH)
    assert close.serialize_hex() == v["close"] and txid(close) == v["closeTxid"]
    assert check_voucher_shape(parse_tx(v["voucher"]), CHANNEL, int(v["cumulative"])) is None
    assert check_voucher_shape(close, CHANNEL, int(v["cumulative"])) == "script_sig"
    assert check_voucher_shape(close, CHANNEL, int(v["cumulative"]), allow_completed=True) is None
    assert verify_voucher_signature(parse_tx(v["voucher"]), CHANNEL, BRANCH)


def test_refund():
    r = build_refund(CHANNEL, C_PRIV, CLIENT_SCRIPT, BRANCH)
    assert r.serialize_hex() == DOC["refund"]["tx"] and txid(r) == DOC["refund"]["txid"]
    assert r.lock_time == DOC["refund"]["lockTime"] and r.vin[0].sequence == DOC["refund"]["sequence"]
    with pytest.raises(ValueError):
        build_refund(CHANNEL, C_PRIV, CLIENT_SCRIPT, BRANCH, lock_time=CHANNEL.refund_height - 1)


def test_script_parse_is_exact():
    p = parse_channel_script(RS)
    assert p is not None and p.refund_height == CH["refundHeight"]
    assert parse_channel_script(RS + b"\x51") is None
    small = build_channel_script(ChannelScript(pubkey_from_priv(C_PRIV), pubkey_from_priv(S_PRIV), 16))
    assert parse_channel_script(small).refund_height == 16
    with pytest.raises(ValueError):
        build_channel_script(ChannelScript(pubkey_from_priv(C_PRIV), pubkey_from_priv(C_PRIV), 100))
    with pytest.raises(ValueError):
        build_channel_script(ChannelScript(pubkey_from_priv(C_PRIV, False), pubkey_from_priv(S_PRIV), 100))


def test_voucher_rules():
    d = CHANNEL.yec_deposit
    assert len(yec_voucher_outputs(CHANNEL, d - 53, CLIENT_SCRIPT)) == 1  # dust remainder folded into payTo
    with pytest.raises(ValueError):
        yec_voucher_outputs(CHANNEL, 53, CLIENT_SCRIPT)
    with pytest.raises(ValueError):
        yec_voucher_outputs(CHANNEL, d + 1, CLIENT_SCRIPT)
    v = build_voucher(CHANNEL, 1000, C_PRIV, BRANCH, CLIENT_SCRIPT)
    assert check_voucher_shape(v, CHANNEL, 1001) == "outputs"
    v.lock_time = 1
    assert check_voucher_shape(v, CHANNEL, 1000) == "lock_time"
    assert not verify_voucher_signature(v, CHANNEL, BRANCH)  # the signature no longer covers it
    assert close_fee_floor(RS, yec_voucher_outputs(CHANNEL, 1000, CLIENT_SCRIPT)) <= CHANNEL.close_fee
    assert parse_channel_id(channel_id_of(CHANNEL.outpoint)) == CHANNEL.outpoint
    assert parse_channel_id("xyz:1") is None


def test_funding():
    priv = bytes([7]) * 32
    script = p2pkh_script(hash160(pubkey_from_priv(priv)))
    inp = FundingInput(OutPoint("ab" * 32, 1), 1_000_000, script)
    tx = build_funding_tx([inp], RS, 500_000, script)
    assert find_channel_vout(tx, RS) == 0 and tx.vout[1].value == 1_000_000 - 500_000 - 1000
    signed = sign_funding_tx(tx, [inp], [priv], BRANCH)
    assert signed.vin[0].script_sig and not tx.vin[0].script_sig
    with pytest.raises(ValueError):
        sign_funding_tx(tx, [inp], [bytes([8]) * 32], BRANCH)
    assert len(build_funding_tx([inp], RS, 1_000_000 - 1000 - 53, script).vout) == 1
