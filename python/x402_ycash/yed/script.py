"""Finding a transaction's Yellowback payload in its output scripts: ExtractOpReturnData,
FindOpReturn and FindPayload (ycash-dd/src/yellowback/payload.cpp:383-430, identical on ycash6)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .payload import MAX_PAYLOAD, MIN_PAYLOAD, Assignment, Payload, PayloadError, decode_payload, encode_transfer_payload

OP_RETURN = 0x6A
_OP_PUSHDATA1 = 0x4C
_OP_PUSHDATA2 = 0x4D
_OP_PUSHDATA4 = 0x4E


def payload_script(data: bytes) -> bytes:
    """PayloadScript (payload.cpp:383-386): OP_RETURN <minimal push>. A non-minimal push of 80 bytes
    would make the script 84 bytes, over the 83-byte relay limit (MAX_OP_RETURN_RELAY,
    ycash-dd/src/script/standard.h:34, ycash6 :26), although the overlay accepts it."""
    n = len(data)
    if n == 0 or n > 0xFF:
        raise ValueError(f"payload push of {n} bytes")  # payloads are 4..80
    head = bytes([n]) if n < _OP_PUSHDATA1 else bytes([_OP_PUSHDATA1, n])
    return bytes([OP_RETURN]) + head + data


def transfer_op_return_script(assignments: Sequence[Assignment]) -> bytes:
    """The OP_RETURN output script carrying a TRANSFER payload for these assignments."""
    return payload_script(encode_transfer_payload(list(assignments)))


def extract_op_return_data(script: bytes) -> bytes | None:
    """ExtractOpReturnData (payload.cpp:388-401): the pushed bytes when ``script`` is exactly
    OP_RETURN followed by one data push (direct, PUSHDATA1, 2 or 4) of 4..80 bytes ending the script."""
    if len(script) < 2 or script[0] != OP_RETURN:
        return None
    op, pc = script[1], 2
    if op > _OP_PUSHDATA4:
        return None
    if op < _OP_PUSHDATA1:
        size = op
    else:
        width = {_OP_PUSHDATA1: 1, _OP_PUSHDATA2: 2, _OP_PUSHDATA4: 4}[op]
        if len(script) - pc < width:
            return None
        size = int.from_bytes(script[pc : pc + width], "little")
        pc += width
    if len(script) - pc < size:  # GetOp fails on a truncated push
        return None
    if size == 0 or pc + size != len(script):  # no data, or a second op follows
        return None
    if not MIN_PAYLOAD <= size <= MAX_PAYLOAD:
        return None
    return script[pc : pc + size]


@dataclass(frozen=True)
class FoundPayload:
    index: int
    """The OP_RETURN output's index."""
    payload: Payload


@dataclass(frozen=True)
class FindPayloadFailure:
    """The tx has an OP_RETURN but no Yellowback payload: the node treats it as non-Yellowback."""

    error: str
    index: int | None
    """The OP_RETURN's index; None when there is more than one."""


def find_payload(output_scripts: Sequence[bytes]) -> FoundPayload | FindPayloadFailure | None:
    """FindPayload (payload.cpp:416-430). None when no output is an OP_RETURN (FindOpReturn counts any
    script starting with OP_RETURN); a failure when there is one but it carries no Yellowback
    payload; otherwise the payload and the OP_RETURN's index. Either non-success outcome means any
    YED the transaction spends burns (state.cpp:860-865)."""
    idx = [i for i, s in enumerate(output_scripts) if s[:1] == bytes([OP_RETURN])]
    if not idx:
        return None
    if len(idx) > 1:
        return FindPayloadFailure("multiple_op_return", None)
    index = idx[0]
    data = extract_op_return_data(output_scripts[index])
    if data is None:
        return FindPayloadFailure("op_return_shape", index)
    p = decode_payload(data)
    if isinstance(p, PayloadError):
        return FindPayloadFailure(p.error, index)
    if p.type in ("transfer", "redeem"):
        for a in p.assignments:
            if a.vout >= len(output_scripts):
                return FindPayloadFailure("assignment_vout_out_of_range", index)
            if a.vout == index:
                return FindPayloadFailure("assignment_vout_is_op_return", index)
    return FoundPayload(index, p)
