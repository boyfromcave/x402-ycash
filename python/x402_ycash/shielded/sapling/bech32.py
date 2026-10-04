"""Bech32 (BIP 173, not bech32m) with no length limit: Sapling viewing keys and regtest addresses are
longer than BIP 173's 90 characters, and ycashd encodes them anyway. Mirrors
packages/ycash/src/shielded/sapling/bech32.ts."""

from __future__ import annotations

from collections.abc import Iterable

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_GEN = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)


def _polymod(values: Iterable[int]) -> int:
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            if (top >> i) & 1:
                chk ^= _GEN[i]
    return chk


def _hrp_expand(hrp: str) -> list[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _convert(data: Iterable[int], frm: int, to: int, pad: bool) -> list[int]:
    acc = bits = 0
    out: list[int] = []
    maxv = (1 << to) - 1
    for v in data:
        acc = (acc << frm) | v
        bits += frm
        while bits >= to:
            bits -= to
            out.append((acc >> bits) & maxv)
        acc &= (1 << bits) - 1
    if pad:
        if bits:
            out.append((acc << (to - bits)) & maxv)
    elif bits >= frm or ((acc << (to - bits)) & maxv):
        raise ValueError("bech32: invalid padding")
    return out


def bech32_encode(hrp: str, data: bytes) -> str:
    five = _convert(data, 8, 5, True)
    mod = _polymod(_hrp_expand(hrp) + five + [0] * 6) ^ 1
    return hrp + "1" + "".join(CHARSET[d] for d in five + [(mod >> (5 * (5 - i))) & 31 for i in range(6)])


def bech32_decode(s: str) -> tuple[str, bytes]:
    """(hrp, payload). Raises ValueError on mixed case, a bad character, checksum or padding."""
    if s != s.lower() and s != s.upper():
        raise ValueError("bech32: mixed case")
    s = s.lower()
    sep = s.rfind("1")
    if sep < 1 or sep + 7 > len(s):
        raise ValueError("bech32: no separator or checksum")
    hrp = s[:sep]
    try:
        data = [CHARSET.index(c) for c in s[sep + 1:]]
    except ValueError:
        raise ValueError("bech32: invalid character") from None
    if _polymod(_hrp_expand(hrp) + data) != 1:
        raise ValueError("bech32: bad checksum")
    return hrp, bytes(_convert(data[:-6], 5, 8, False))
