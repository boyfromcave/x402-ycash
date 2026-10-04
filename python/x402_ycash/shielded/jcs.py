"""RFC 8785 JSON Canonicalization Scheme (JCS), for the ``sapling-proof`` request hash and the
``offer-and-receipt`` JWS payloads (the extension's §10 requires JCS for JWS payloads). Mirrors
packages/ycash/src/shielded/jcs.ts, whose output it must match byte for byte:

- members sorted by the UTF-16 code units of their names (JavaScript's default sort);
- numbers in ECMAScript Number::toString form; the values hashed here are integers, so a float
  with a fraction is refused rather than risk a form the counterparty would not reproduce;
- strings with JSON escaping, the short forms for \\b \\t \\n \\f \\r, other controls as \\u00xx,
  everything else (non-ASCII included) literal, as JSON.stringify does.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

_SHORT = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r"}
_MAX_SAFE = 2**53 - 1


def _string(s: str) -> str:
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch in _SHORT:
            out.append(_SHORT[ch])
        elif o < 0x20:
            out.append(f"\\u{o:04x}")
        elif 0xD800 <= o <= 0xDFFF:
            raise ValueError("JCS: unpaired surrogate in string")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(k: str) -> bytes:
    return k.encode("utf-16-be")


def _number(v: float) -> str:
    if isinstance(v, float):
        if not math.isfinite(v):
            raise ValueError(f"JCS: non-finite number {v}")
        if not v.is_integer():
            raise ValueError(f"JCS: a non-integer number is not supported: {v}")
        v = int(v)
    if abs(v) > _MAX_SAFE:
        raise ValueError(f"JCS: {v} is outside the IEEE 754 safe integer range")
    return str(v)


def jcs(value: Any) -> str:
    """The canonical JSON text of a JSON value. A member whose value is None is serialized as null
    (JSON has no undefined); callers omit absent members."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, Mapping):
        for k in value:
            if not isinstance(k, str):
                raise ValueError(f"JCS: member name {k!r} is not a string")  # noqa: TRY004  # one error type for any malformed input
        keys = sorted(value.keys(), key=_utf16_key)
        return "{" + ",".join(f"{_string(k)}:{jcs(value[k])}" for k in keys) + "}"
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    raise ValueError(f"JCS: cannot serialize a {type(value).__name__}")


def jcs_bytes(value: Any) -> bytes:
    """UTF-8 bytes of the canonical text."""
    return jcs(value).encode("utf-8")
