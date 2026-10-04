"""Byte helpers: display-order hashes and the Bitcoin wire primitives (little-endian integers,
CompactSize) the v4 transaction format is built from."""

from __future__ import annotations

import struct

# MAX_SIZE in serialize.h: 0x02000000.
MAX_COMPACT_SIZE = 0x02000000


def reversed_hex(b: bytes) -> str:
    """A display-order hash (txid, block hash) is the internal byte order reversed."""
    return b[::-1].hex()


def from_reversed_hex(h: str, length: int = 32) -> bytes:
    b = bytes.fromhex(h)
    if len(b) != length:
        raise ValueError(f"expected {length} bytes, got {len(b)}")
    return b[::-1]


def compact_size(n: int) -> bytes:
    if n < 0:
        raise ValueError("invalid CompactSize")
    if n < 253:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    if n <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", n)
    return b"\xff" + struct.pack("<Q", n)


def var_bytes(b: bytes) -> bytes:
    return compact_size(len(b)) + b


def u32(n: int) -> bytes:
    return struct.pack("<I", n & 0xFFFFFFFF)


def i64(n: int) -> bytes:
    """64-bit little-endian; negative values as two's complement (int64)."""
    return struct.pack("<Q", n & 0xFFFFFFFFFFFFFFFF)


class ByteReader:
    def __init__(self, data: bytes) -> None:
        self._b = data
        self.pos = 0

    @property
    def remaining(self) -> int:
        return len(self._b) - self.pos

    def take(self, n: int) -> bytes:
        if n < 0 or self.pos + n > len(self._b):
            raise ValueError(f"truncated at byte {self.pos}")
        s = self._b[self.pos : self.pos + n]
        self.pos += n
        return s

    def u8(self) -> int:
        return self.take(1)[0]

    def u16(self) -> int:
        return struct.unpack("<H", self.take(2))[0]

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def i64(self) -> int:
        return struct.unpack("<q", self.take(8))[0]

    def compact_size(self) -> int:
        """CompactSize, refusing non-canonical encodings as the node's ReadCompactSize does."""
        first = self.u8()
        if first < 253:
            return first
        if first == 253:
            n = self.u16()
            if n < 253:
                raise ValueError("non-canonical CompactSize")
        elif first == 254:
            n = self.u32()
            if n <= 0xFFFF:
                raise ValueError("non-canonical CompactSize")
        else:
            n = struct.unpack("<Q", self.take(8))[0]
            if n <= 0xFFFFFFFF:
                raise ValueError("non-canonical CompactSize")
        if n > MAX_COMPACT_SIZE:
            raise ValueError("CompactSize too large")
        return n

    def var_bytes(self) -> bytes:
        return self.take(self.compact_size())
