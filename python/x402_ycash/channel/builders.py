"""The YEC payment channel's pure builders (specs/scheme_batch_settlement_ycash.md): the channel's
fixed parameters, voucher outputs, funding, vouchers, server completion and the client refund.
Mirrors packages/ycash/src/channel/{channel,outputs,funding,voucher,refund}.ts.

Voucher and close scriptSigs are assembled here because the stock signer cannot sign a
non-template script (plan R-8, src/script/sign.cpp:84-86), as atomic swap does
(ycash-dd/src/script/atomicswap.cpp:151-185).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace

from ..pq import (
    SCHEME_FN_DSA_512,
    SCHEME_SLH_DSA_SHA2_128S,
    PQKeyId,
    PQKeyPair,
    PQSpend,
    parse_pq_spend,
    pq_spend_items,
    pubkey_size,
    sig_size,
    spend_matches,
)
from ..pq import sign as pq_sign
from ..pq import verify as pq_verify
from ..tx import (
    OP,
    SIGHASH_ALL,
    NetworkFees,
    OutPoint,
    Tx,
    TxIn,
    TxOut,
    build_script,
    fee_floor,
    hash160,
    network_fee,
    p2pkh_hash,
    p2pkh_script_sig,
    p2sh_script_sig,
    parse_script,
    pubkey_from_priv,
    sig_hash_type,
    sighash_v4,
    sign_input,
    verify_input_sig,
)
from .pq_script import parse_pq_channel_script
from .script import DUST_THRESHOLD, LOCKTIME_THRESHOLD, REFUND_SEQUENCE, channel_script_pubkey, parse_channel_script

_MAX_SIG = bytes(73)
"""A DER signature at its longest (72 bytes) plus the hash type."""


@dataclass(frozen=True)
class Channel:
    """Everything a voucher, close or refund of one channel needs, fixed at open."""

    outpoint: OutPoint
    redeem_script: bytes
    value: int
    """V, the channel output's value, zatoshis."""
    close_fee: int
    """The fee every voucher reserves inside V (``extra.closeFee``)."""
    pay_to_script: bytes
    """The server's output script (``payTo``)."""
    client_pubkey: bytes
    """C (P2SH channel); empty for a TX_PQCHANNEL, whose client is ``client_pq``."""
    server_pubkey: bytes
    refund_height: int
    template: str = "p2sh"
    """``p2sh``: the 2-of-2 secp256k1 channel (deprecated for YED on the quantum line: valid only before
    the Falcon height). ``pq``: the bare hybrid TX_PQCHANNEL (D-Q-19); ``redeem_script`` is then the
    channel script itself, also the funding output's scriptPubKey."""
    client_pq: PQKeyId | None = None

    @classmethod
    def from_script(cls, outpoint: OutPoint, redeem_script: bytes, value: int, close_fee: int, pay_to_script: bytes) -> Channel:
        """Raises ValueError when the script is neither channel script."""
        q = parse_pq_channel_script(redeem_script)
        if q is not None:
            return cls(outpoint, redeem_script, value, close_fee, pay_to_script, b"", q.server_pubkey, q.refund_height, "pq", q.client)
        p = parse_channel_script(redeem_script)
        if p is None:
            raise ValueError("not the channel redeem script")
        return cls(outpoint, redeem_script, value, close_fee, pay_to_script, p.client_pubkey, p.server_pubkey, p.refund_height)

    @property
    def yec_deposit(self) -> int:
        """D for a YEC channel: V − closeFee."""
        return self.value - self.close_fee

    @property
    def channel_id(self) -> str:
        return channel_id_of(self.outpoint)


def channel_id_of(p: OutPoint) -> str:
    """``"<funding txid>:<vout>"``, txid in display order."""
    return f"{p.txid}:{p.vout}"


def parse_channel_id(ident: str) -> OutPoint | None:
    m = re.fullmatch(r"([0-9a-f]{64}):(\d{1,10})", ident)
    if not m or int(m.group(2)) > 0xFFFFFFFF:
        return None
    return OutPoint(m.group(1), int(m.group(2)))


def commitment_id_of(channel_id: str, cumulative: int) -> str:
    """The commitment id of a stored voucher: ``"<channelId>@<cumulative>"``."""
    return f"{channel_id}@{cumulative}"


VoucherLayout = Callable[[Channel, int, bytes | None], list[TxOut]]
"""(channel, cumulative, client script) -> the voucher's exact outputs; raises when it cannot carry it."""


def yec_voucher_outputs(channel: Channel, cumulative: int, client_script: bytes | None) -> list[TxOut]:
    """YEC: vout 0 pays ``payTo`` the cumulative, vout 1 returns V − closeFee − cumulative to the
    client. A client remainder below dust is folded into vout 0 and vout 1 is omitted (plan X-F15)."""
    deposit = channel.yec_deposit
    if cumulative < DUST_THRESHOLD:
        raise ValueError(f"cumulative {cumulative} is below the {DUST_THRESHOLD}-zatoshi dust threshold")
    if cumulative > deposit:
        raise ValueError(f"cumulative {cumulative} exceeds the deposit {deposit}")
    remainder = deposit - cumulative
    if remainder < DUST_THRESHOLD:
        return [TxOut(deposit, channel.pay_to_script)]
    if client_script is None:
        raise ValueError("a client output script is required")
    if client_script == channel.pay_to_script:
        raise ValueError("the client output must not pay payTo")
    return [TxOut(cumulative, channel.pay_to_script), TxOut(remainder, client_script)]


def close_fee_floor(redeem_script: bytes, outputs: Sequence[TxOut]) -> int:
    """The fee floor of a close with these outputs, at maximum signature length (a TX_PQCHANNEL's
    by its client scheme: 27,000 with an SLH-DSA client)."""
    q = parse_pq_channel_script(redeem_script)
    if q is not None:
        return pq_close_fee_floor(q.client.scheme, outputs)
    script_sig = build_script([OP.OP_0, _MAX_SIG, _MAX_SIG, OP.OP_1, redeem_script])
    return fee_floor(Tx(vin=[TxIn(OutPoint("00" * 32, 0), script_sig)], vout=list(outputs)))


def pq_close_fee_floor(scheme: int, outputs: Sequence[TxOut]) -> int:
    """The fee floor of a TX_PQCHANNEL close: ``<sigS> <sigC chunks> <s> <pk chunks> <p> OP_1``."""
    script_sig = pq_close_script_sig(_MAX_SIG, bytes(pubkey_size(scheme)), bytes(sig_size(scheme) + 1))
    return fee_floor(Tx(vin=[TxIn(OutPoint("00" * 32, 0), script_sig)], vout=list(outputs)))


def pq_close_network_fee(scheme: int, outputs: Sequence[TxOut], fees: NetworkFees | None) -> int:
    """The network fee of a YED channel's TX_PQCHANNEL close (rpcversion 8): the Yellowback rate by the
    close's size, capped; the fee floor when the node gave no rates."""
    script_sig = pq_close_script_sig(_MAX_SIG, bytes(pubkey_size(scheme)), bytes(sig_size(scheme) + 1))
    return network_fee(Tx(vin=[TxIn(OutPoint("00" * 32, 0), script_sig)], vout=list(outputs)), "yellowback", fees)


def yed_close_network_fee(falcon: bool, fees: NetworkFees | None) -> int:
    """A YED close's network fee at the node's rates: a Falcon client with two Falcon TX_PQPKH outputs
    from the Falcon height, an SLH-DSA client with two P2PKH outputs before; plus the TRANSFER."""
    if falcon:
        return pq_close_network_fee(SCHEME_FN_DSA_512, [TxOut(0, bytes(35)), TxOut(0, bytes(35)), TxOut(0, bytes(17))], fees)
    return pq_close_network_fee(SCHEME_SLH_DSA_SHA2_128S, [TxOut(0, bytes(25)), TxOut(0, bytes(25)), TxOut(0, bytes(17))], fees)


# --- funding -----------------------------------------------------------------------------------

@dataclass(frozen=True)
class FundingInput:
    outpoint: OutPoint
    value: int
    script_pubkey: bytes
    """The coin's P2PKH scriptPubKey."""


FUNDING_VOUT = 0
_P2PKH_SCRIPTSIG_MAX = 1 + 73 + 1 + 33


def build_funding_tx(inputs: Sequence[FundingInput], redeem_script: bytes, value: int, change_script: bytes,
                     fee: int | None = None, expiry_height: int = 0) -> Tx:
    """The unsigned funding transaction: V to the channel's P2SH script at vout 0, change (dropped
    below dust) to the client. Inputs keep empty scriptSigs until sign_funding_tx."""
    if not inputs:
        raise ValueError("funding needs at least one input")
    total = sum(i.value for i in inputs)
    channel_out = TxOut(value, channel_script_pubkey(redeem_script))
    tx = Tx(vin=[TxIn(i.outpoint, bytes(_P2PKH_SCRIPTSIG_MAX)) for i in inputs],
            vout=[channel_out, TxOut(0, change_script)], expiry_height=expiry_height)
    fee = fee_floor(tx) if fee is None else fee  # sized with the change output and full-size scriptSigs
    change = total - value - fee
    if change < 0:
        raise ValueError(f"inputs {total} cannot pay {value} plus fee {fee}")
    tx.vout = [channel_out, TxOut(change, change_script)] if change >= DUST_THRESHOLD else [channel_out]
    for i in tx.vin:
        i.script_sig = b""
    return tx


def sign_funding_tx(tx: Tx, inputs: Sequence[FundingInput], priv_keys: Sequence[bytes], branch_id: int) -> Tx:
    """Signs every P2PKH input SIGHASH_ALL; ``priv_keys[i]`` owns ``inputs[i]``."""
    if not len(inputs) == len(priv_keys) == len(tx.vin):
        raise ValueError("one input and key per vin")
    signed = replace(tx, vin=[replace(i) for i in tx.vin])
    for n, (inp, priv) in enumerate(zip(inputs, priv_keys, strict=True)):
        pub = pubkey_from_priv(priv)
        if p2pkh_hash(inp.script_pubkey) != hash160(pub):
            raise ValueError(f"input {n} is not a P2PKH coin of its key")
        sig = sign_input(sighash_v4(signed, n, inp.script_pubkey, inp.value, SIGHASH_ALL, branch_id), priv)
        signed.vin[n].script_sig = p2pkh_script_sig(sig, pub)
    return signed


def find_channel_vout(tx: Tx, redeem_script: bytes) -> int:
    spk = channel_script_pubkey(redeem_script)
    return next((n for n, o in enumerate(tx.vout) if o.script_pubkey == spk), -1)


# --- vouchers ----------------------------------------------------------------------------------

def voucher_sighash(tx: Tx, channel: Channel, branch_id: int) -> bytes:
    """The ZIP-243 hash both voucher signatures cover: script code the redeem script, amount V."""
    return sighash_v4(tx, 0, channel.redeem_script, channel.value, SIGHASH_ALL, branch_id)


def pq_close_script_sig(sig_s: bytes, pk: bytes, sig_c: bytes) -> bytes:
    """The cooperative TX_PQCHANNEL scriptSig ``<sigS | OP_0> <sig_1>..<sig_s> <s> <pk_1>..<pk_p> <p> OP_1``
    (s + p + 4 pushes; D-Q-19)."""
    return build_script([sig_s if sig_s else OP.OP_0, *pq_spend_items(pk, sig_c), OP.OP_1])


def pq_refund_script_sig(pk: bytes, sig_c: bytes) -> bytes:
    """The TX_PQCHANNEL refund scriptSig ``<sig_1>..<sig_s> <s> <pk_1>..<pk_p> <p> OP_0`` (s + p + 3 pushes)."""
    return build_script([*pq_spend_items(pk, sig_c), OP.OP_0])


def _pq_key(channel: Channel, key: bytes | PQKeyPair) -> PQKeyPair:
    if not isinstance(key, PQKeyPair):
        raise TypeError("a post-quantum channel needs the client's post-quantum key pair")
    if channel.client_pq is None or not spend_matches(PQSpend(key.scheme, key.pk, b""), channel.client_pq):
        raise ValueError("the post-quantum key is not the channel's client key")
    return key


def _pq_sign_all(sighash: bytes, key: PQKeyPair) -> bytes:
    return pq_sign(key.scheme, key.sk, sighash) + bytes([SIGHASH_ALL])


def build_voucher(channel: Channel, cumulative: int, client_priv: bytes | PQKeyPair, branch_id: int,
                  client_script: bytes | None = None, layout: VoucherLayout = yec_voucher_outputs) -> Tx:
    """One input (the channel outpoint), the layout's outputs, nLockTime 0 and nExpiryHeight 0 (it
    must stay valid until the server closes), signed SIGHASH_ALL by C with the server's slot empty:
    ``OP_0 <sigC> OP_0 OP_1 <redeemScript>`` (P2SH; ``client_priv`` C's key), or
    ``OP_0 <sigC chunks> <s> <pk> <p> OP_1`` (TX_PQCHANNEL; ``client_priv`` the PQKeyPair)."""
    tx = Tx(vin=[TxIn(channel.outpoint)], vout=layout(channel, cumulative, client_script))
    sh = voucher_sighash(tx, channel, branch_id)
    if channel.template == "pq":
        key = _pq_key(channel, client_priv)
        tx.vin[0].script_sig = pq_close_script_sig(b"", key.pk, _pq_sign_all(sh, key))
        return tx
    if isinstance(client_priv, PQKeyPair):
        raise TypeError("a P2SH channel needs the client's secp256k1 key")
    sig_c = sign_input(sh, client_priv)
    tx.vin[0].script_sig = p2sh_script_sig([OP.OP_0, sig_c, OP.OP_0, OP.OP_1], channel.redeem_script)
    return tx


@dataclass(frozen=True)
class CloseScriptSig:
    sig_c: bytes
    sig_s: bytes
    """Empty in a voucher (the server's slot), the server's signature in a completed close."""
    redeem_script: bytes


def parse_close_script_sig(script_sig: bytes) -> CloseScriptSig | None:
    """Parses ``OP_0 <sigC> <sigS | OP_0> OP_1 <redeemScript>``, minimal pushes only."""
    try:
        chunks = parse_script(script_sig)
    except ValueError:
        return None
    if len(chunks) != 5:
        return None
    dummy, c, s, branch, rs = chunks
    if dummy.op != OP.OP_0 or branch.op != OP.OP_1 or branch.data is not None:
        return None
    if not c.data or s.data is None or rs.data is None:
        return None
    parsed = CloseScriptSig(c.data, s.data, rs.data)
    canonical = p2sh_script_sig([OP.OP_0, parsed.sig_c, parsed.sig_s or OP.OP_0, OP.OP_1], parsed.redeem_script)
    return parsed if canonical == script_sig else None


@dataclass(frozen=True)
class PQCloseScriptSig:
    sig_s: bytes
    """Empty in a voucher (the server's slot), the server's signature in a completed close."""
    spend: PQSpend


def parse_pq_close_script_sig(script_sig: bytes) -> PQCloseScriptSig | None:
    """Parses ``<sigS | OP_0> <client spend> OP_1``, minimal pushes and canonical chunks only."""
    try:
        chunks = parse_script(script_sig)
    except ValueError:
        return None
    if len(chunks) < 2 or chunks[0].data is None or chunks[-1].op != OP.OP_1 or chunks[-1].data is not None:
        return None
    sp = parse_pq_spend(chunks[1:-1])
    if sp is None:
        return None
    parsed = PQCloseScriptSig(chunks[0].data, sp)
    return parsed if pq_close_script_sig(parsed.sig_s, sp.pk, sp.sig) == script_sig else None


def check_voucher_shape(tx: Tx, channel: Channel, cumulative: int, layout: VoucherLayout = yec_voucher_outputs,
                        allow_completed: bool = False, client_script: bytes | None = None) -> str | None:
    """Voucher rule 4: one input spending the channel outpoint with the close skeleton, nLockTime 0,
    nExpiryHeight 0, transparent only, exactly the layout's outputs at ``cumulative``. The client's
    script is the channel's bound return script (``client_script``, from the open's returnAddress);
    only a verifier that never saw the open (a stateless facilitator) leaves it out, and then it is
    read from vout 1. Returns inputs, script_sig, redeem_script, lock_time, expiry, shielded or
    outputs; None when well formed."""
    if len(tx.vin) != 1 or tx.vin[0].prevout != channel.outpoint:
        return "inputs"
    if channel.template == "pq":
        ps = parse_pq_close_script_sig(tx.vin[0].script_sig)
        if ps is None or (ps.sig_s and not allow_completed):
            return "script_sig"
    else:
        ss = parse_close_script_sig(tx.vin[0].script_sig)
        if ss is None or (ss.sig_s and not allow_completed):
            return "script_sig"
        if ss.redeem_script != channel.redeem_script:
            return "redeem_script"
    if tx.lock_time != 0:
        return "lock_time"
    if tx.expiry_height != 0:
        return "expiry"
    if tx.has_shielded() or tx.value_balance != 0:
        return "shielded"
    try:
        if client_script is None and len(tx.vout) > 1:
            client_script = tx.vout[1].script_pubkey
        expected = layout(channel, cumulative, client_script)
    except ValueError:
        return "outputs"
    if [(o.value, o.script_pubkey) for o in expected] != [(o.value, o.script_pubkey) for o in tx.vout]:
        return "outputs"
    return None


def verify_voucher_signature(tx: Tx, channel: Channel, branch_id: int) -> bool:
    """Voucher rule 6: sigC is a valid strict-DER low-S SIGHASH_ALL signature by C (P2SH), or a valid
    SIGHASH_ALL post-quantum signature by the key the channel names (TX_PQCHANNEL)."""
    if channel.template == "pq":
        ps = parse_pq_close_script_sig(tx.vin[0].script_sig) if len(tx.vin) == 1 else None
        if ps is None or channel.client_pq is None or not spend_matches(ps.spend, channel.client_pq) or ps.spend.sig[-1] != SIGHASH_ALL:
            return False
        return pq_verify(ps.spend.scheme, ps.spend.pk, ps.spend.sig[:-1], voucher_sighash(tx, channel, branch_id))
    ss = parse_close_script_sig(tx.vin[0].script_sig) if len(tx.vin) == 1 else None
    if ss is None or sig_hash_type(ss.sig_c) != SIGHASH_ALL:
        return False
    return verify_input_sig(ss.sig_c, voucher_sighash(tx, channel, branch_id), channel.client_pubkey)


def complete_voucher(tx: Tx, channel: Channel, server_priv: bytes, branch_id: int) -> Tx:
    """Server completion: adds sigS in its slot, giving ``OP_0 <sigC> <sigS> OP_1 <redeemScript>``.
    The outputs cannot change: the client signed SIGHASH_ALL. A TX_PQCHANNEL's sigS replaces the OP_0
    that opens its scriptSig."""
    if channel.template == "pq":
        ps = parse_pq_close_script_sig(tx.vin[0].script_sig) if len(tx.vin) == 1 else None
        if ps is None:
            raise ValueError("not a voucher")
        sig_s = sign_input(voucher_sighash(tx, channel, branch_id), server_priv)
        return replace(tx, vin=[replace(tx.vin[0], script_sig=pq_close_script_sig(sig_s, ps.spend.pk, ps.spend.sig))])
    ss = parse_close_script_sig(tx.vin[0].script_sig) if len(tx.vin) == 1 else None
    if ss is None:
        raise ValueError("not a voucher")
    sig_s = sign_input(voucher_sighash(tx, channel, branch_id), server_priv)
    vin0 = replace(tx.vin[0], script_sig=p2sh_script_sig([OP.OP_0, ss.sig_c, sig_s, OP.OP_1], channel.redeem_script))
    return replace(tx, vin=[vin0])


# --- refund ------------------------------------------------------------------------------------

def build_refund(channel: Channel, client_priv: bytes | PQKeyPair, to_script: bytes, branch_id: int, lock_time: int | None = None,
                 fee: int | None = None, extra_outputs: Sequence[TxOut] = ()) -> Tx:
    """The CLTV branch from height t: ``<sigC> OP_0 <redeemScript>`` (P2SH) or
    ``<sigC chunks> <s> <pk> <p> OP_0`` (TX_PQCHANNEL), nSequence 0xFFFFFFFE, nLockTime ≥ t, expiry 0
    (ycash-dd/src/script/interpreter.cpp:1307-1338; ycash6 :1416)."""
    lock_time = channel.refund_height if lock_time is None else lock_time
    if not channel.refund_height <= lock_time < LOCKTIME_THRESHOLD:
        raise ValueError(f"refund lock time must be a height ≥ t = {channel.refund_height}: {lock_time}")
    pq = channel.template == "pq" and channel.client_pq is not None
    placeholder = (pq_refund_script_sig(bytes(pubkey_size(channel.client_pq.scheme)), bytes(sig_size(channel.client_pq.scheme) + 1))
                   if pq and channel.client_pq is not None else p2sh_script_sig([_MAX_SIG, OP.OP_0], channel.redeem_script))
    tx = Tx(vin=[TxIn(channel.outpoint, placeholder, REFUND_SEQUENCE)],
            vout=[*extra_outputs, TxOut(0, to_script)], lock_time=lock_time)
    fee = fee_floor(tx) if fee is None else fee
    amount = channel.value - sum(o.value for o in extra_outputs) - fee
    if amount < DUST_THRESHOLD:
        raise ValueError(f"refund output {amount} is below dust")
    tx.vout[-1].value = amount
    sh = sighash_v4(tx, 0, channel.redeem_script, channel.value, SIGHASH_ALL, branch_id)
    if pq:
        key = _pq_key(channel, client_priv)
        tx.vin[0].script_sig = pq_refund_script_sig(key.pk, _pq_sign_all(sh, key))
        return tx
    if isinstance(client_priv, PQKeyPair):
        raise TypeError("a P2SH channel needs the client's secp256k1 key")
    tx.vin[0].script_sig = p2sh_script_sig([sign_input(sh, client_priv), OP.OP_0], channel.redeem_script)
    return tx
