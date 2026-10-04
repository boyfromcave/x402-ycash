"""Base58Check and Ycash transparent and YED addresses (version bytes ‖ 20-byte hash).

Transparent prefixes (identical on both lines):
  mainnet P2PKH 1C 28 "s1…", P2SH 1C 2C "s2…"/"s3…" (ycash-dd/src/chainparams.cpp:149-151, ycash6 :161-163)
  testnet and regtest share P2PKH 1C 95 "sm…", P2SH 1C 2A "s2…" (ycash-dd :409-411,613-614; ycash6 :456-458,689-690)
YED addresses are P2PKH only, one version per network (ycash-dd/src/yellowback/params.cpp:142,162,195,
address.cpp:11-27; same on ycash6): mainnet 1F E4 "ye…", testnet 20 07 "yt…", regtest 20 02 "yr…".
Testnet and regtest share transparent prefixes, so the network always comes from the requirements
(plan X-F1), never from the address.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..constants import YCASH_MAINNET, YCASH_NETWORKS, YCASH_REGTEST, YCASH_TESTNET
from .hashes import sha256d
from .script import p2pkh_script, p2sh_script

_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

AddressKind = Literal["p2pkh", "p2sh", "yed"]

_VERSIONS: dict[str, dict[str, bytes]] = {
    YCASH_MAINNET: {"p2pkh": b"\x1c\x28", "p2sh": b"\x1c\x2c", "yed": b"\x1f\xe4"},
    YCASH_TESTNET: {"p2pkh": b"\x1c\x95", "p2sh": b"\x1c\x2a", "yed": b"\x20\x07"},
    YCASH_REGTEST: {"p2pkh": b"\x1c\x95", "p2sh": b"\x1c\x2a", "yed": b"\x20\x02"},
}


def base58_encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = _ALPHABET[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\x00"))) + s


def base58_decode(s: str) -> bytes:
    n = 0
    for c in s:
        v = _ALPHABET.find(c)
        if v < 0:
            raise ValueError(f"invalid base58 character {c!r}")
        n = n * 58 + v
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + body


def base58check_encode(payload: bytes) -> str:
    return base58_encode(payload + sha256d(payload)[:4])


def base58check_decode(s: str) -> bytes:
    b = base58_decode(s)
    if len(b) < 4:
        raise ValueError("base58check too short")
    payload, check = b[:-4], b[-4:]
    if sha256d(payload)[:4] != check:
        raise ValueError("bad base58check checksum")
    return payload


@dataclass(frozen=True)
class DecodedAddress:
    network: str
    kind: AddressKind
    hash: bytes
    """The 20-byte key hash (p2pkh, yed) or script hash (p2sh)."""


def encode_address(network: str, kind: AddressKind, h: bytes) -> str:
    if len(h) != 20:
        raise ValueError("address hash must be 20 bytes")
    return base58check_encode(_VERSIONS[network][kind] + h)


def decode_address(addr: str, network: str | None = None) -> DecodedAddress:
    """Decode an address. A ``sm…``/``s2…`` address decodes as ycash:testnet unless ``network`` says
    which is meant; with ``network``, an address of another network is refused."""
    b = base58check_decode(addr)
    if len(b) != 22:
        raise ValueError("not a Ycash address (bad length)")
    if network is not None and network not in _VERSIONS:
        raise ValueError(f"unsupported network {network}")
    for net in [network] if network is not None else YCASH_NETWORKS:
        for kind, v in _VERSIONS[net].items():
            if b[:2] == v:
                return DecodedAddress(net, kind, b[2:])  # type: ignore[arg-type]  # kind is an AddressKind key
    raise ValueError(f"not a {network} address" if network else "not a Ycash address (unknown version)")


def address_to_script(addr: str, network: str | None = None) -> bytes:
    """The scriptPubKey an address pays. A YED address is a P2PKH key hash."""
    d = decode_address(addr, network)
    return p2sh_script(d.hash) if d.kind == "p2sh" else p2pkh_script(d.hash)
