"""Base58Check and Ycash transparent and YED addresses (version bytes ‖ payload).

Transparent prefixes (identical on both lines):
  mainnet P2PKH 1C 28 "s1…", P2SH 1C 2C "s2…"/"s3…" (ycash-dd/src/chainparams.cpp:149-151, ycash6 :161-163)
  testnet and regtest share P2PKH 1C 95 "sm…", P2SH 1C 2A "s2…" (ycash-dd :409-411,613-614; ycash6 :456-458,689-690)
YED addresses, one version per network and form (ycash-dd/src/yellowback/params.cpp, address.cpp):
  20-byte key hash (P2PKH holder): mainnet 1F DD "yb…" (D-Q-21; 1F E4 "ye…" before the quantum line),
  testnet 20 07 "yt…", regtest 20 02 "yr…"; 35 characters.
  33-byte scheme ‖ key hash (TX_PQPKH holder or vault owner; quantum spec §4): mainnet 56 AB "yb…",
  testnet 57 1E "yt…", regtest 57 10 "yr…"; 53 characters.
Plain-YEC post-quantum addresses (D-Q-20; the same TX_PQPKH script): mainnet 4D D9 "sq…", testnet
4F 61 "tq…", regtest 4C 51 "rq…"; 53 characters.
Testnet and regtest share transparent prefixes, so the network always comes from the requirements
(plan X-F1), never from the address.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..constants import YCASH_MAINNET, YCASH_NETWORKS, YCASH_REGTEST, YCASH_TESTNET
from .hashes import sha256d
from .script import OP, p2pkh_script, p2sh_script, push_data

_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

AddressKind = Literal["p2pkh", "p2sh", "yed", "yedpq", "pq"]
"""``yed``: a YED P2PKH holder; ``yedpq``: a YED post-quantum key; ``pq``: a plain-YEC post-quantum key."""

_VERSIONS: dict[str, dict[str, bytes]] = {
    YCASH_MAINNET: {"p2pkh": b"\x1c\x28", "p2sh": b"\x1c\x2c", "yed": b"\x1f\xdd", "yedpq": b"\x56\xab", "pq": b"\x4d\xd9"},
    YCASH_TESTNET: {"p2pkh": b"\x1c\x95", "p2sh": b"\x1c\x2a", "yed": b"\x20\x07", "yedpq": b"\x57\x1e", "pq": b"\x4f\x61"},
    YCASH_REGTEST: {"p2pkh": b"\x1c\x95", "p2sh": b"\x1c\x2a", "yed": b"\x20\x02", "yedpq": b"\x57\x10", "pq": b"\x4c\x51"},
}
_PQ_KINDS = ("yedpq", "pq")
_KNOWN_SCHEMES = (1, 2)


def is_pq_kind(kind: str) -> bool:
    return kind in _PQ_KINDS


def is_yed_kind(kind: str) -> bool:
    """A Yellowback address, either form."""
    return kind in ("yed", "yedpq")


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
    """The 20-byte key hash (p2pkh, yed) or script hash (p2sh), or the 32-byte key hash (yedpq, pq)."""
    scheme: int | None = None
    """The post-quantum scheme (yedpq, pq only)."""


def encode_address(network: str, kind: AddressKind, h: bytes) -> str:
    """``h``: the 20-byte hash, or for yedpq/pq the 33 bytes scheme ‖ key hash."""
    if is_pq_kind(kind):
        if len(h) != 33:
            raise ValueError("a post-quantum address payload is scheme ‖ 32-byte key hash")
        if h[0] not in _KNOWN_SCHEMES:
            raise ValueError(f"unknown post-quantum scheme {h[0]}")
    elif len(h) != 20:
        raise ValueError("address hash must be 20 bytes")
    return base58check_encode(_VERSIONS[network][kind] + h)


def encode_pq_address(network: str, kind: AddressKind, scheme: int, key_hash: bytes) -> str:
    return encode_address(network, kind, bytes([scheme]) + key_hash)


def decode_address(addr: str, network: str | None = None) -> DecodedAddress:
    """Decode an address. A ``sm…``/``s2…`` address decodes as ycash:testnet unless ``network`` says
    which is meant; with ``network``, an address of another network is refused."""
    b = base58check_decode(addr)
    if len(b) not in (22, 35):
        raise ValueError("not a Ycash address (bad length)")
    if network is not None and network not in _VERSIONS:
        raise ValueError(f"unsupported network {network}")
    pq = len(b) == 35
    for net in [network] if network is not None else YCASH_NETWORKS:
        for kind, v in _VERSIONS[net].items():
            if is_pq_kind(kind) != pq or b[:2] != v:
                continue
            if not pq:
                return DecodedAddress(net, kind, b[2:])  # type: ignore[arg-type]  # kind is an AddressKind key
            if b[2] not in _KNOWN_SCHEMES:
                raise ValueError(f"not a Ycash address (unknown post-quantum scheme {b[2]})")
            return DecodedAddress(net, kind, b[3:], b[2])  # type: ignore[arg-type]
    raise ValueError(f"not a {network} address" if network else "not a Ycash address (unknown version)")


def address_to_script(addr: str, network: str | None = None) -> bytes:
    """The scriptPubKey an address pays: a ``yed`` address is a P2PKH key hash, a ``yedpq``/``pq``
    address a TX_PQPKH (``20 <hash> 51|52 c2``)."""
    d = decode_address(addr, network)
    if d.scheme is not None:
        return push_data(d.hash) + bytes([OP.OP_1 + d.scheme - 1, OP.OP_CHECKPQSIG])
    return p2sh_script(d.hash) if d.kind == "p2sh" else p2pkh_script(d.hash)
