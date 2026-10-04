"""Script building: opcodes, minimal pushes, the standard templates, and hand-assembled P2SH
scriptSigs.

The stock signer cannot sign a non-template redeem script (plan R-8, src/script/sign.cpp:84-86),
so channel scriptSigs are assembled here, as atomic swap does (src/script/atomicswap.cpp:151-185).
Pushes are minimal because SCRIPT_VERIFY_MINIMALDATA is a standard flag on both lines
(ycash-dd/src/policy/policy.h:32-40, ycash6 :45-53).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import IntEnum

from .encoding import ByteReader


class OP(IntEnum):
    """Opcodes used by the bindings (src/script/script.h)."""

    OP_0 = 0x00
    OP_PUSHDATA1 = 0x4C
    OP_PUSHDATA2 = 0x4D
    OP_PUSHDATA4 = 0x4E
    OP_1NEGATE = 0x4F
    OP_1 = 0x51
    OP_2 = 0x52
    OP_3 = 0x53
    OP_16 = 0x60
    OP_NOP = 0x61
    OP_IF = 0x63
    OP_NOTIF = 0x64
    OP_ELSE = 0x67
    OP_ENDIF = 0x68
    OP_VERIFY = 0x69
    OP_RETURN = 0x6A
    OP_DROP = 0x75
    OP_DUP = 0x76
    OP_SIZE = 0x82
    OP_EQUAL = 0x87
    OP_EQUALVERIFY = 0x88
    OP_SHA256 = 0xA8
    OP_HASH160 = 0xA9
    OP_CHECKSIG = 0xAC
    OP_CHECKSIGVERIFY = 0xAD
    OP_CHECKMULTISIG = 0xAE
    OP_CHECKMULTISIGVERIFY = 0xAF
    OP_CHECKLOCKTIMEVERIFY = 0xB1


class Num(int):
    """A number push (CScript << int64), to tell it apart from an opcode in ``build_script``."""


ScriptItem = int | Num | bytes
"""A script element: an int (or OP) is an opcode, bytes are a data push, a Num is a number push."""


def push_data(data: bytes) -> bytes:
    """The minimal push of ``data`` (CheckMinimalPush, src/script/interpreter.cpp)."""
    n = len(data)
    if n == 0:
        return bytes([OP.OP_0])
    if n == 1:
        v = data[0]
        if 1 <= v <= 16:
            return bytes([OP.OP_1 + v - 1])
        if v == 0x81:
            return bytes([OP.OP_1NEGATE])
    if n <= 75:
        head = bytes([n])
    elif n <= 0xFF:
        head = bytes([OP.OP_PUSHDATA1, n])
    elif n <= 0xFFFF:
        head = bytes([OP.OP_PUSHDATA2]) + n.to_bytes(2, "little")
    else:
        head = bytes([OP.OP_PUSHDATA4]) + n.to_bytes(4, "little")
    return head + data


def script_num(n: int) -> bytes:
    """CScriptNum serialisation: little-endian magnitude with a sign bit."""
    if n == 0:
        return b""
    neg, v = n < 0, abs(n)
    out = bytearray()
    while v:
        out.append(v & 0xFF)
        v >>= 8
    if out[-1] & 0x80:
        out.append(0x80 if neg else 0)
    elif neg:
        out[-1] |= 0x80
    return bytes(out)


def decode_script_num(b: bytes) -> int:
    if not b:
        return 0
    v = int.from_bytes(b, "little")
    if b[-1] & 0x80:
        return -(v & ~(0x80 << (8 * (len(b) - 1))))
    return v


def push_int(n: int) -> bytes:
    """Push a number as CScript << int64 does: OP_0, OP_1NEGATE, OP_1..OP_16, else a CScriptNum push."""
    if n == 0:
        return bytes([OP.OP_0])
    if n == -1:
        return bytes([OP.OP_1NEGATE])
    if 1 <= n <= 16:
        return bytes([OP.OP_1 + n - 1])
    return push_data(script_num(n))


def build_script(items: Sequence[ScriptItem]) -> bytes:
    out = bytearray()
    for it in items:
        if isinstance(it, (bytes, bytearray)):
            out += push_data(bytes(it))
        elif isinstance(it, Num):
            out += push_int(int(it))
        else:
            if not 0 <= it <= 0xFF:
                raise ValueError(f"invalid opcode {it}")
            out.append(int(it))
    return bytes(out)


@dataclass(frozen=True)
class ScriptChunk:
    op: int
    data: bytes | None = None
    """Set for data pushes (including OP_0, as b"")."""


def parse_script(script: bytes) -> list[ScriptChunk]:
    """Split a script into opcodes and pushes; raises ValueError on a truncated push."""
    r = ByteReader(script)
    out: list[ScriptChunk] = []
    while r.remaining:
        op = r.u8()
        if op == OP.OP_0:
            out.append(ScriptChunk(op, b""))
        elif op <= 75:
            out.append(ScriptChunk(op, r.take(op)))
        elif op == OP.OP_PUSHDATA1:
            out.append(ScriptChunk(op, r.take(r.u8())))
        elif op == OP.OP_PUSHDATA2:
            out.append(ScriptChunk(op, r.take(r.u16())))
        elif op == OP.OP_PUSHDATA4:
            out.append(ScriptChunk(op, r.take(r.u32())))
        else:
            out.append(ScriptChunk(op))
    return out


def _check20(h: bytes, what: str) -> bytes:
    if len(h) != 20:
        raise ValueError(f"{what} must be 20 bytes")
    return h


def p2pkh_script(pkh: bytes) -> bytes:
    """OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG"""
    return build_script([OP.OP_DUP, OP.OP_HASH160, _check20(pkh, "key hash"), OP.OP_EQUALVERIFY, OP.OP_CHECKSIG])


def p2sh_script(script_hash: bytes) -> bytes:
    """OP_HASH160 <scriptHash> OP_EQUAL"""
    return build_script([OP.OP_HASH160, _check20(script_hash, "script hash"), OP.OP_EQUAL])


def op_return_script(data: bytes) -> bytes:
    """OP_RETURN <data>; standard up to 80 data bytes, one per tx (src/script/standard.h:34)."""
    return build_script([OP.OP_RETURN, data])


def p2pkh_hash(spk: bytes) -> bytes | None:
    """The key hash of a P2PKH scriptPubKey, or None."""
    if len(spk) == 25 and spk[:3] == b"\x76\xa9\x14" and spk[23:] == b"\x88\xac":
        return spk[3:23]
    return None


def p2sh_hash(spk: bytes) -> bytes | None:
    """The script hash of a P2SH scriptPubKey, or None."""
    if len(spk) == 23 and spk[:2] == b"\xa9\x14" and spk[22] == OP.OP_EQUAL:
        return spk[2:22]
    return None


def p2pkh_script_sig(sig: bytes, pubkey: bytes) -> bytes:
    """<sig> <pubkey>"""
    return build_script([sig, pubkey])


def p2sh_script_sig(items: Sequence[ScriptItem], redeem_script: bytes) -> bytes:
    """A P2SH scriptSig: the items followed by a push of the redeem script. The channel close is
    ``p2sh_script_sig([OP.OP_0, sig_c, sig_s, OP.OP_1], rs)`` and the refund
    ``p2sh_script_sig([sig_c, OP.OP_0], rs)``."""
    return build_script([*items, redeem_script])
