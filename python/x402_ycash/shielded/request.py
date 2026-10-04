"""The request record, its hash, and the memo that commits to it (spec, "sapling-proof",
Requirements): extra.memo = "x402:" + hex(SHA-256(JCS(record))). Mirrors packages/ycash/src/shielded/request.ts."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from typing import Any, TypedDict

from .constants import MEMO_PREFIX, MEMO_REGEX
from .jcs import jcs_bytes

RequestRecord = TypedDict("RequestRecord", {
    "v": int, "network": str, "asset": str, "amount": str, "payTo": str, "resource": str, "expiresAt": int, "nonce": str,
})
"""The request-binding object the spec hashes (camelCase keys: they are its wire names). The
server keeps it as the request record."""

_HEX = re.compile(r"^(?:[0-9a-fA-F]{2})*$")


def request_hash(record: Mapping[str, Any]) -> str:
    """Lowercase hex SHA-256 of the record's JCS serialisation."""
    return hashlib.sha256(jcs_bytes(record)).hexdigest()


def memo_for_hash(h: str) -> str:
    memo = MEMO_PREFIX + h
    if not MEMO_REGEX.match(memo):
        raise ValueError(f"not a request hash: {h}")
    return memo


def memo_for_record(record: Mapping[str, Any]) -> str:
    return memo_for_hash(request_hash(record))


def memo_to_hex(memo: str) -> str:
    """The memo as ``z_sendmany`` takes it: hex of its UTF-8 bytes (both lines)."""
    return memo.encode("utf-8").hex()


def note_memo_bytes(note: Mapping[str, Any]) -> bytes:
    """A received note's memo bytes with trailing zero bytes removed. Both lines return the 512-byte
    memo as hex in ``memo`` (ycash-dd/src/wallet/rpcwallet.cpp:3557, ycash6/src/wallet/rpcwallet.cpp:4218-4219);
    6.21.0 adds ``memoStr``, used only when ``memo`` is absent."""
    memo, memo_str = note.get("memo"), note.get("memoStr")
    if isinstance(memo, str) and _HEX.match(memo):
        data = bytes.fromhex(memo)
    elif isinstance(memo_str, str):
        data = memo_str.encode("utf-8")
    else:
        return b""
    return data.rstrip(b"\x00")


def note_memo_equals(note: Mapping[str, Any], memo: str) -> bool:
    """True when the note's memo, trailing zeros removed, is exactly the UTF-8 bytes of ``memo``."""
    return note_memo_bytes(note) == memo.encode("utf-8")
