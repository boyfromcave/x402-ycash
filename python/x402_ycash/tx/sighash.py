"""ZIP-243 signature hash, bound to the consensus branch id.

Source: ycash-dd/src/script/interpreter.cpp:1099-1250 (SignatureHash, SIGVERSION_SAPLING; same on
ycash6), qa/rpc-tests/test_framework/script.py:829-935, yew/core/src/tx.rs:347.
"""

from __future__ import annotations

from collections.abc import Sequence

from .encoding import i64, u32, var_bytes
from .hashes import blake2b256
from .transaction import Tx, TxOut

SIGHASH_ALL = 0x01
SIGHASH_NONE = 0x02
SIGHASH_SINGLE = 0x03
SIGHASH_ANYONECANPAY = 0x80

_ZERO = bytes(32)


def _prevouts_hash(tx: Tx) -> bytes:
    return blake2b256("ZcashPrevoutHash", b"".join(i.prevout.serialize() for i in tx.vin))


def _sequence_hash(tx: Tx) -> bytes:
    return blake2b256("ZcashSequencHash", b"".join(u32(i.sequence) for i in tx.vin))


def _outputs_hash(outs: Sequence[TxOut]) -> bytes:
    return blake2b256("ZcashOutputsHash", b"".join(o.serialize() for o in outs))


def _join_splits_hash(tx: Tx) -> bytes:
    if not tx.join_splits:
        return _ZERO
    return blake2b256("ZcashJSplitsHash", b"".join(tx.join_splits) + (tx.join_split_pubkey or bytes(32)))


def _shielded_spends_hash(tx: Tx) -> bytes:
    # spendAuthSig is not committed (interpreter.cpp:1108-1118).
    if not tx.shielded_spends:
        return _ZERO
    return blake2b256("ZcashSSpendsHash", b"".join(s.serialize(with_sig=False) for s in tx.shielded_spends))


def _shielded_outputs_hash(tx: Tx) -> bytes:
    if not tx.shielded_outputs:
        return _ZERO
    return blake2b256("ZcashSOutputHash", b"".join(o.serialize() for o in tx.shielded_outputs))


def sighash_v4(
    tx: Tx,
    input_index: int | None,
    script_code: bytes,
    amount: int,
    hash_type: int,
    consensus_branch_id: int,
) -> bytes:
    """The ZIP-243 sighash for a transparent input (or, with ``input_index`` None, the hash the
    joinSplitSig and Sapling signatures cover). ``script_code`` is the spent scriptPubKey for P2PKH
    and the redeem script for P2SH; ``amount`` is the spent output's value in zatoshi."""
    if input_index is not None and not 0 <= input_index < len(tx.vin):
        raise ValueError(f"input index {input_index} out of range")
    base = hash_type & 0x1F
    anyone_can_pay = bool(hash_type & SIGHASH_ANYONECANPAY)
    single_or_none = base in (SIGHASH_SINGLE, SIGHASH_NONE)

    h_prevouts = _ZERO if anyone_can_pay else _prevouts_hash(tx)
    h_sequence = _ZERO if anyone_can_pay or single_or_none else _sequence_hash(tx)
    h_outputs = _ZERO
    if not single_or_none:
        h_outputs = _outputs_hash(tx.vout)
    elif base == SIGHASH_SINGLE and input_index is not None and input_index < len(tx.vout):
        h_outputs = _outputs_hash([tx.vout[input_index]])

    parts = [
        u32(tx.header), u32(tx.version_group_id), h_prevouts, h_sequence, h_outputs,
        _join_splits_hash(tx), _shielded_spends_hash(tx), _shielded_outputs_hash(tx),
        u32(tx.lock_time), u32(tx.expiry_height), i64(tx.value_balance), u32(hash_type),
    ]
    if input_index is not None:
        i = tx.vin[input_index]
        parts += [i.prevout.serialize(), var_bytes(script_code), i64(amount), u32(i.sequence)]
    person = b"ZcashSigHash" + u32(consensus_branch_id)
    return blake2b256(person, b"".join(parts))
