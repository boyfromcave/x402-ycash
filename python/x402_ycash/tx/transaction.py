"""The v4 (Overwinter-flagged, Sapling version group) transaction: model, parser and serialiser.

Wire order: ycash-dd/src/primitives/transaction.h:575-640 (same on ycash6). v4 is the only format
either line relays: v5 is refused by consensus while NU5 has no activation height (plan R-1).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .encoding import ByteReader, compact_size, from_reversed_hex, i64, reversed_hex, u32, var_bytes
from .hashes import sha256d

TX_VERSION = 4
"""fOverwintered | nVersion = 4."""
SAPLING_VERSION_GROUP_ID = 0x892F2085
"""SAPLING_VERSION_GROUP_ID, src/primitives/transaction.h:39."""
SEQUENCE_FINAL = 0xFFFFFFFF

# Shielded structure sizes (src/primitives/transaction.h:78-152, src/zcash/Zcash.h).
JOINSPLIT_SIZE = 1698
"""A v4 JSDescription carries a Groth16 proof (src/primitives/transaction.h:78)."""
ENC_CIPHERTEXT_SIZE = 580
OUT_CIPHERTEXT_SIZE = 80
GROTH_PROOF_SIZE = 192
MAX_MONEY = 21_000_000 * 100_000_000


@dataclass(frozen=True)
class OutPoint:
    txid: str
    """Display-order hex, as the node's RPCs print it."""
    vout: int

    def serialize(self) -> bytes:
        return from_reversed_hex(self.txid) + u32(self.vout)


@dataclass
class TxIn:
    prevout: OutPoint
    script_sig: bytes = b""
    sequence: int = SEQUENCE_FINAL

    def serialize(self) -> bytes:
        return self.prevout.serialize() + var_bytes(self.script_sig) + u32(self.sequence)


@dataclass
class TxOut:
    value: int
    """zatoshi"""
    script_pubkey: bytes

    def serialize(self) -> bytes:
        return i64(self.value) + var_bytes(self.script_pubkey)


@dataclass
class SpendDescription:
    cv: bytes
    anchor: bytes
    nullifier: bytes
    rk: bytes
    zkproof: bytes
    spend_auth_sig: bytes

    def serialize(self, with_sig: bool = True) -> bytes:
        b = self.cv + self.anchor + self.nullifier + self.rk + self.zkproof
        return b + self.spend_auth_sig if with_sig else b


@dataclass
class OutputDescription:
    cv: bytes
    cmu: bytes
    ephemeral_key: bytes
    enc_ciphertext: bytes
    out_ciphertext: bytes
    zkproof: bytes

    def serialize(self) -> bytes:
        return self.cv + self.cmu + self.ephemeral_key + self.enc_ciphertext + self.out_ciphertext + self.zkproof


@dataclass
class Tx:
    vin: list[TxIn] = field(default_factory=list)
    vout: list[TxOut] = field(default_factory=list)
    lock_time: int = 0
    expiry_height: int = 0
    """0 = never expires."""
    value_balance: int = 0
    """Sapling value balance, zatoshi (int64)."""
    shielded_spends: list[SpendDescription] = field(default_factory=list)
    shielded_outputs: list[OutputDescription] = field(default_factory=list)
    join_splits: list[bytes] = field(default_factory=list)
    """Opaque JSDescriptions, JOINSPLIT_SIZE bytes each."""
    join_split_pubkey: bytes | None = None
    join_split_sig: bytes | None = None
    binding_sig: bytes | None = None
    """Present iff there is a shielded spend or output (64 bytes)."""

    version: int = TX_VERSION
    version_group_id: int = SAPLING_VERSION_GROUP_ID

    @property
    def header(self) -> int:
        return 0x80000000 | self.version

    def has_shielded(self) -> bool:
        """True when the tx carries any Sprout or Sapling component (a transparent binding refuses it)."""
        return bool(self.shielded_spends or self.shielded_outputs or self.join_splits)

    def serialize(self) -> bytes:
        _check_shape(self)
        parts = [u32(self.header), u32(self.version_group_id), compact_size(len(self.vin))]
        parts += [i.serialize() for i in self.vin]
        parts.append(compact_size(len(self.vout)))
        parts += [o.serialize() for o in self.vout]
        parts += [u32(self.lock_time), u32(self.expiry_height), i64(self.value_balance)]
        parts.append(compact_size(len(self.shielded_spends)))
        parts += [s.serialize() for s in self.shielded_spends]
        parts.append(compact_size(len(self.shielded_outputs)))
        parts += [o.serialize() for o in self.shielded_outputs]
        parts.append(compact_size(len(self.join_splits)))
        parts += self.join_splits
        if self.join_splits:
            parts += [_fixed(self.join_split_pubkey, 32, "joinSplitPubKey"), _fixed(self.join_split_sig, 64, "joinSplitSig")]
        if self.shielded_spends or self.shielded_outputs:
            parts.append(_fixed(self.binding_sig, 64, "bindingSig"))
        return b"".join(parts)

    def serialize_hex(self) -> str:
        return self.serialize().hex()

    def txid(self) -> str:
        return txid(self.serialize())


def _fixed(b: bytes | None, length: int, what: str) -> bytes:
    if b is None or len(b) != length:
        raise ValueError(f"{what} must be {length} bytes")
    return b


def _check_shape(tx: Tx) -> None:
    if tx.version != TX_VERSION or tx.version_group_id != SAPLING_VERSION_GROUP_ID:
        raise ValueError("only v4 (Sapling version group) transactions are supported")
    for o in tx.vout:
        if o.value < 0 or o.value > MAX_MONEY:
            raise ValueError("output value out of range")
    for s in tx.shielded_spends:
        for v, n, w in ((s.cv, 32, "cv"), (s.anchor, 32, "anchor"), (s.nullifier, 32, "nullifier"), (s.rk, 32, "rk"),
                        (s.zkproof, GROTH_PROOF_SIZE, "zkproof"), (s.spend_auth_sig, 64, "spendAuthSig")):
            _fixed(v, n, w)
    for o in tx.shielded_outputs:
        for v, n, w in ((o.cv, 32, "cv"), (o.cmu, 32, "cmu"), (o.ephemeral_key, 32, "ephemeralKey"),
                        (o.enc_ciphertext, ENC_CIPHERTEXT_SIZE, "encCiphertext"),
                        (o.out_ciphertext, OUT_CIPHERTEXT_SIZE, "outCiphertext"), (o.zkproof, GROTH_PROOF_SIZE, "zkproof")):
            _fixed(v, n, w)
    for js in tx.join_splits:
        _fixed(js, JOINSPLIT_SIZE, "JSDescription")


def parse_tx(data: str | bytes) -> Tx:
    """Parse a v4 Sapling-group transaction; raises ValueError on any other format or trailing bytes."""
    r = ByteReader(bytes.fromhex(data) if isinstance(data, str) else data)
    header = r.u32()
    group = r.u32()
    if header >> 31 != 1 or header & 0x7FFFFFFF != TX_VERSION or group != SAPLING_VERSION_GROUP_ID:
        raise ValueError(f"unsupported transaction format: header {header:#x}, group {group:#x} (only v4 Sapling)")
    vin = []
    for _ in range(r.compact_size()):
        prev = OutPoint(reversed_hex(r.take(32)), r.u32())
        vin.append(TxIn(prev, r.var_bytes(), r.u32()))
    vout = [TxOut(r.i64(), r.var_bytes()) for _ in range(r.compact_size())]
    lock_time, expiry_height, value_balance = r.u32(), r.u32(), r.i64()
    spends = [
        SpendDescription(r.take(32), r.take(32), r.take(32), r.take(32), r.take(GROTH_PROOF_SIZE), r.take(64))
        for _ in range(r.compact_size())
    ]
    outputs = [
        OutputDescription(r.take(32), r.take(32), r.take(32), r.take(ENC_CIPHERTEXT_SIZE), r.take(OUT_CIPHERTEXT_SIZE),
                          r.take(GROTH_PROOF_SIZE))
        for _ in range(r.compact_size())
    ]
    join_splits = [r.take(JOINSPLIT_SIZE) for _ in range(r.compact_size())]
    js_pub = r.take(32) if join_splits else None
    js_sig = r.take(64) if join_splits else None
    binding = r.take(64) if spends or outputs else None
    if r.remaining:
        raise ValueError(f"{r.remaining} trailing bytes")
    return Tx(vin, vout, lock_time, expiry_height, value_balance, spends, outputs, join_splits, js_pub, js_sig, binding)


def txid(data: Tx | bytes | str) -> str:
    """The txid in display order: SHA256d of the serialisation, reversed."""
    if isinstance(data, Tx):
        data = data.serialize()
    elif isinstance(data, str):
        data = bytes.fromhex(data)
    return reversed_hex(sha256d(data))
