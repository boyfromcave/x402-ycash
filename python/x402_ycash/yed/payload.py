"""The Yellowback payload codec, version 3: "YB" || 0x03 || type || body, the data of a
transaction's only OP_RETURN output.

Translation source: ycash-dd/src/yellowback/payload.{h,cpp} (identical on ycash6), through the
TypeScript twin packages/ycash/src/yed/payload.ts. The decoder never raises: it returns a payload or
a PayloadError. A decoded payload is for building and checking a client's transaction only; the
verdict on a transaction (OK, BURNED, ...) comes from the node (``yed_validaterawtransaction``).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Literal

PAYLOAD_MAGIC = b"YB"
"""PAYLOAD_MAGIC_0, PAYLOAD_MAGIC_1 (ycash-dd/src/yellowback/params.h:44-45)."""
PAYLOAD_VERSION = 0x03
"""params.h:46. Versions 1, 2 and later than 3 are non-Yellowback (V23)."""
MIN_PAYLOAD = 4
MAX_PAYLOAD = 80
MAX_ASSIGNMENTS = 15
"""payload.h:82-83: TRANSFER, 5 + 5 * count <= 80."""
MAX_REDEEM_ASSIGNMENTS = 13
FEE_VOUT_NONE = 0xFF

TYPE_MINT = 0x01
TYPE_TRANSFER = 0x02
TYPE_REDEEM = 0x03
TYPE_ATTESTOR_REGISTER = 0x05
TYPE_CLAIM_NOTICE = 0x06
TYPE_EQUIVOCATION = 0x07
TYPE_ATTESTOR_REVIVE = 0x08

_TYPE_NAMES = {
    TYPE_MINT: "mint", TYPE_TRANSFER: "transfer", TYPE_REDEEM: "redeem", TYPE_ATTESTOR_REGISTER: "register",
    TYPE_CLAIM_NOTICE: "notice", TYPE_EQUIVOCATION: "equivocation", TYPE_ATTESTOR_REVIVE: "revive",
}

_KEY_SIZE = 33
_MINT_BODY_SIZE = 1 + 4 + 4 + 4 + _KEY_SIZE + 1 + 1  # 48 (payload.cpp:17)
_REDEEM_HEAD_SIZE = 4 + 1 + 1 + 1
_REGISTER_BODY_SIZE = _KEY_SIZE + _KEY_SIZE + 4 + 1
_NOTICE_BODY_SIZE = 32 + 1 + 4
_REVIVE_BODY_SIZE = 2 + 4 + 4 + 64
_U32_MAX = 0xFFFFFFFF

PayloadDecodeError = Literal[
    "payload_too_short", "payload_too_long", "payload_bad_magic", "payload_unsupported_version",
    "payload_reserved_type", "payload_bad_length", "payload_too_many_assignments", "payload_zero_cents",
    "payload_duplicate_vout",
]


def payload_type_name(type_byte: int) -> str | None:
    """PayloadTypeName (payload.cpp:432-444), or None for a reserved type."""
    return _TYPE_NAMES.get(type_byte)


@dataclass(frozen=True)
class Assignment:
    vout: int
    cents: int


@dataclass(frozen=True)
class PayloadError:
    """Why a byte string is not a Yellowback payload. Every case is "non-Yellowback" to the node."""

    error: PayloadDecodeError


@dataclass(frozen=True)
class Payload:
    """A decoded payload. ``type`` is the node's name; ``fields`` holds the body, byte strings as
    bytes (``vaultTxid`` as display-order hex), exactly the keys the vector file uses."""

    type: str
    fields: dict[str, object]

    @property
    def assignments(self) -> tuple[Assignment, ...]:
        a = self.fields.get("assignments", ())
        return tuple(a)  # type: ignore[arg-type]  # set only by the TRANSFER and REDEEM decoders

    def to_json(self) -> dict[str, object]:
        """The payload as the vector file writes it: byte fields as hex, assignments as objects."""
        out: dict[str, object] = {"type": self.type}
        for k, v in self.fields.items():
            if isinstance(v, bytes):
                out[k] = v.hex()
            elif k == "assignments":
                out[k] = [{"vout": a.vout, "cents": a.cents} for a in v]  # type: ignore[attr-defined]
            else:
                out[k] = v
        return out


def _assignments_error(assignments: list[Assignment]) -> PayloadDecodeError | None:
    """ValidAssignments (payload.cpp:90-99): no zero cents, no duplicate vout, in that order."""
    seen: set[int] = set()
    for a in assignments:
        if a.cents == 0:
            return "payload_zero_cents"
        if a.vout in seen:
            return "payload_duplicate_vout"
        seen.add(a.vout)
    return None


def _read_assignments(data: bytes, off: int, count: int) -> list[Assignment]:
    return [Assignment(data[off + 5 * i], struct.unpack_from("<I", data, off + 5 * i + 1)[0]) for i in range(count)]


def _decode_body(data: bytes, type_byte: int) -> Payload | PayloadError:
    """DecodeBodyV3 (payload.cpp:239-301). The body starts at byte 4."""
    size = len(data)
    bad = PayloadError
    if type_byte == TYPE_MINT:
        if size != 4 + _MINT_BODY_SIZE:
            return bad("payload_bad_length")
        term, cents, lock_h, ref_h = struct.unpack_from("<BIII", data, 4)
        return Payload("mint", {
            "termClass": term, "cents": cents, "lockHeight": lock_h, "refHeight": ref_h,
            "ownerKey": data[17:50], "feeVout": data[50], "attestFeeVout": data[51],
        })
    if type_byte == TYPE_TRANSFER:
        if size < 5:
            return bad("payload_bad_length")
        count = data[4]
        if count > MAX_ASSIGNMENTS:
            return bad("payload_too_many_assignments")
        if size != 5 + 5 * count:
            return bad("payload_bad_length")
        assignments = _read_assignments(data, 5, count)
        e = _assignments_error(assignments)
        return bad(e) if e else Payload("transfer", {"assignments": assignments})
    if type_byte == TYPE_REDEEM:
        if size < 4 + _REDEEM_HEAD_SIZE:
            return bad("payload_bad_length")
        ref_h, fee_vout, attest_vout, count = struct.unpack_from("<IBBB", data, 4)
        if count > MAX_REDEEM_ASSIGNMENTS:
            return bad("payload_too_many_assignments")
        if size != 4 + _REDEEM_HEAD_SIZE + 5 * count:
            return bad("payload_bad_length")
        assignments = _read_assignments(data, 11, count)
        e = _assignments_error(assignments)
        if e:
            return bad(e)
        return Payload("redeem", {"refHeight": ref_h, "feeVout": fee_vout, "attestFeeVout": attest_vout,
                                  "assignments": assignments})
    if type_byte == TYPE_ATTESTOR_REGISTER:
        if size != 4 + _REGISTER_BODY_SIZE:
            return bad("payload_bad_length")
        return Payload("register", {"attestorKey": data[4:37], "bondKey": data[37:70],
                                    "bondLocktime": struct.unpack_from("<I", data, 70)[0], "flags": data[74]})
    if type_byte == TYPE_CLAIM_NOTICE:
        if size != 4 + _NOTICE_BODY_SIZE:
            return bad("payload_bad_length")
        return Payload("notice", {"vaultTxid": data[4:36][::-1].hex(), "vaultVout": data[36],
                                  "refHeight": struct.unpack_from("<I", data, 37)[0]})
    if type_byte == TYPE_EQUIVOCATION:
        return Payload("equivocation", {}) if size == 4 else bad("payload_bad_length")
    if type_byte == TYPE_ATTESTOR_REVIVE:
        if size != 4 + _REVIVE_BODY_SIZE:
            return bad("payload_bad_length")
        seq, price, cited = struct.unpack_from("<HII", data, 4)
        return Payload("revive", {"seq": seq, "priceMicroUsd": price, "citedHeight": cited, "sig": data[14:78]})
    return bad("payload_reserved_type")  # forward-compatibility rule: non-Yellowback


def decode_payload(data: bytes) -> Payload | PayloadError:
    """DecodePayload (payload.cpp:365-381): the payload, or why the bytes are non-Yellowback.
    Checks that need the transaction (the vout exists, is not the OP_RETURN) are in find_payload."""
    if len(data) < MIN_PAYLOAD:
        return PayloadError("payload_too_short")
    if len(data) > MAX_PAYLOAD:
        return PayloadError("payload_too_long")
    if data[:2] != PAYLOAD_MAGIC:
        return PayloadError("payload_bad_magic")
    if data[2] != PAYLOAD_VERSION:
        return PayloadError("payload_unsupported_version")
    return _decode_body(data, data[3])


def encode_transfer_payload(assignments: list[Assignment] | tuple[Assignment, ...]) -> bytes:
    """EncodePayload for a TRANSFER (payload.cpp:324-327); mirrors ``encode_transfer_v3``
    (ycash-dd/qa/rpc-tests/test_framework/yellowback_attest.py:360). Raises where the node's encoder
    returns an empty vector. The overlay's range rule (XFER-1) is not a codec rule: see
    validate_transfer_assignments."""
    assignments = list(assignments)
    if len(assignments) > MAX_ASSIGNMENTS:
        raise ValueError(f"a TRANSFER holds at most {MAX_ASSIGNMENTS} assignments, got {len(assignments)}")
    for i, a in enumerate(assignments):
        if not 0 <= a.vout <= 0xFF:
            raise ValueError(f"assignment {i}: vout {a.vout} is not a u8")
        if not 0 <= a.cents <= _U32_MAX:
            raise ValueError(f"assignment {i}: cents {a.cents} is not a u32")
    e = _assignments_error(assignments)
    if e:
        raise ValueError(f"TRANSFER not encodable: {e}")
    body = b"".join(struct.pack("<BI", a.vout, a.cents) for a in assignments)
    return PAYLOAD_MAGIC + bytes([PAYLOAD_VERSION, TYPE_TRANSFER, len(assignments)]) + body
