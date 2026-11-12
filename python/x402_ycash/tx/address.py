"""Base58Check and Ycash transparent and YED addresses (version bytes ‖ payload).

Transparent prefixes (identical on both lines):
  mainnet P2PKH 1C 28 "s1…", P2SH 1C 2C "s2…"/"s3…" (ycash-dd/src/chainparams.cpp:149-151, ycash6 :161-163)
  testnet and regtest share P2PKH 1C 95 "sm…", P2SH 1C 2A "s2…" (ycash-dd :409-411,613-614; ycash6 :456-458,689-690)
YED addresses, one version per network and form (ycash-dd/src/yellowback/params.cpp, address.cpp):
  20-byte key hash (P2PKH holder): mainnet 1F DD "yb…" (D-Q-21; 1F E4 "ye…" before the quantum line),
  testnet 20 07 "yt…", regtest 20 02 "yr…"; 35 characters.
Post-quantum addresses (decision D-9, quantum spec §4.1, rpcversion 9): base58check(version(3) ‖ keyHash(32)),
53 characters, one 3-byte version per network, form and scheme, so the prefix names the scheme (f FN-DSA-512 =
scheme 2, s SLH-DSA-SHA2-128s = scheme 1); the node's key_io PlainPQAddressVersions / Yellowback pqAddressVersions:
  yedpq (TX_PQPKH YED holder or vault owner): mainnet 56 AE DE "ybf…" / 56 B0 44 "ybs…", testnet 57 21 C9 "ytf…" /
  57 23 30 "yts…", regtest 57 14 44 "yrf…" / 57 15 AA "yrs…".
  pq (plain YEC, the same TX_PQPKH script, D-Q-20): mainnet 4D DD 04 "sqf…" / 4D DE 6A "sqs…", testnet 4F 65 19
  "tqf…" / 4F 66 7F "tqs…", regtest 4C 54 EF "rqf…" / 4C 56 55 "rqs…".
  The pre-D-9 form (2-byte version ‖ scheme ‖ keyHash) is neither produced nor accepted.
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
    YCASH_MAINNET: {"p2pkh": b"\x1c\x28", "p2sh": b"\x1c\x2c", "yed": b"\x1f\xdd"},
    YCASH_TESTNET: {"p2pkh": b"\x1c\x95", "p2sh": b"\x1c\x2a", "yed": b"\x20\x07"},
    YCASH_REGTEST: {"p2pkh": b"\x1c\x95", "p2sh": b"\x1c\x2a", "yed": b"\x20\x02"},
}
# Every post-quantum version (D-9) -> (network, kind, scheme): the one table both directions read.
PQ_VERSIONS: dict[bytes, tuple[str, str, int]] = {
    bytes.fromhex("4ddd04"): (YCASH_MAINNET, "pq", 2),  # sqf…
    bytes.fromhex("4dde6a"): (YCASH_MAINNET, "pq", 1),  # sqs…
    bytes.fromhex("4f6519"): (YCASH_TESTNET, "pq", 2),  # tqf…
    bytes.fromhex("4f667f"): (YCASH_TESTNET, "pq", 1),  # tqs…
    bytes.fromhex("4c54ef"): (YCASH_REGTEST, "pq", 2),  # rqf…
    bytes.fromhex("4c5655"): (YCASH_REGTEST, "pq", 1),  # rqs…
    bytes.fromhex("56aede"): (YCASH_MAINNET, "yedpq", 2),  # ybf…
    bytes.fromhex("56b044"): (YCASH_MAINNET, "yedpq", 1),  # ybs…
    bytes.fromhex("5721c9"): (YCASH_TESTNET, "yedpq", 2),  # ytf…
    bytes.fromhex("572330"): (YCASH_TESTNET, "yedpq", 1),  # yts…
    bytes.fromhex("571444"): (YCASH_REGTEST, "yedpq", 2),  # yrf…
    bytes.fromhex("5715aa"): (YCASH_REGTEST, "yedpq", 1),  # yrs…
}
_PQ_VERSION_OF = {row: v for v, row in PQ_VERSIONS.items()}
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
    """``h``: the 20-byte hash, or for yedpq/pq the 33 bytes scheme ‖ key hash (encoded as the scheme's 3-byte
    version ‖ key hash, D-9)."""
    if is_pq_kind(kind):
        if len(h) != 33:
            raise ValueError("a post-quantum address payload is scheme ‖ 32-byte key hash")
        if h[0] not in _KNOWN_SCHEMES:
            raise ValueError(f"unknown post-quantum scheme {h[0]}")
        return base58check_encode(_PQ_VERSION_OF[(network, kind, h[0])] + h[1:])
    if len(h) != 20:
        raise ValueError("address hash must be 20 bytes")
    return base58check_encode(_VERSIONS[network][kind] + h)


def encode_pq_address(network: str, kind: AddressKind, scheme: int, key_hash: bytes) -> str:
    return encode_address(network, kind, bytes([scheme]) + key_hash)


def decode_address(addr: str, network: str | None = None) -> DecodedAddress:
    """Decode an address. A ``sm…``/``s2…`` address decodes as ycash:testnet unless ``network`` says
    which is meant; with ``network``, an address of another network is refused. A post-quantum address
    is 35 bytes under one of PQ_VERSIONS; the pre-D-9 form is refused."""
    b = base58check_decode(addr)
    if len(b) not in (22, 35):
        raise ValueError("not a Ycash address (bad length)")
    if network is not None and network not in _VERSIONS:
        raise ValueError(f"unsupported network {network}")
    if len(b) == 35:
        row = PQ_VERSIONS.get(b[:3])
        if row is None:
            raise ValueError("not a Ycash address (unknown post-quantum version)")
        if network is not None and row[0] != network:
            raise ValueError(f"not a {network} address")
        return DecodedAddress(row[0], row[1], b[3:], row[2])  # type: ignore[arg-type]  # row[1] is "yedpq" or "pq"
    for net in [network] if network is not None else YCASH_NETWORKS:
        for kind, v in _VERSIONS[net].items():
            if b[:2] == v:
                return DecodedAddress(net, kind, b[2:])  # type: ignore[arg-type]  # kind is an AddressKind key
    raise ValueError(f"not a {network} address" if network else "not a Ycash address (unknown version)")


def address_to_script(addr: str, network: str | None = None) -> bytes:
    """The scriptPubKey an address pays: a ``yed`` address is a P2PKH key hash, a ``yedpq``/``pq``
    address a TX_PQPKH (``20 <hash> 51|52 c2``)."""
    d = decode_address(addr, network)
    if d.scheme is not None:
        return push_data(d.hash) + bytes([OP.OP_1 + d.scheme - 1, OP.OP_CHECKPQSIG])
    return p2sh_script(d.hash) if d.kind == "p2sh" else p2pkh_script(d.hash)
