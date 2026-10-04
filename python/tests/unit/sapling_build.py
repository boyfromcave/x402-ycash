"""Builds ``sapling`` payloads for the unit tests (a port of packages/ycash/test/unit/shielded/saplingBuild.ts):
v4 transactions whose Sapling note ciphertexts are real (encrypted to a test ivk with the package's own
primitives, so trial decryption, cmu and epk checks run for real) and whose proofs, value commitments
and signatures are placeholders (the node checks those at relay; the fake node accepts them)."""

from __future__ import annotations

from dataclasses import dataclass, field

from x402_ycash.shielded.constants import SAPLING_HRP
from x402_ycash.shielded.sapling import (
    bech32_encode,
    encrypt_note_plaintext,
    extract_u,
    kdf_sapling,
    note_commitment,
    note_rcm,
    prf_expand_to_scalar,
)
from x402_ycash.shielded.sapling.jubjub import BASE, encode, group_hash, mul
from x402_ycash.tx import Tx, TxIn, TxOut
from x402_ycash.tx.transaction import OutPoint, OutputDescription, SpendDescription

NETWORK = "ycash:regtest"
TEST_IVK = int("04a" + "4a" * 30 + "7", 16)
OTHER_IVK = TEST_IVK + 12345
GD = b"Zcash_gd"


def diversifier(n: int = 0) -> bytes:
    """The n-th 11-byte diversifier with a valid g_d (test diversifiers need no FF1)."""
    found = -1
    for i in range(1 << 16):
        d = i.to_bytes(2, "little") + bytes(9)
        if group_hash(d, GD) is not None:
            found += 1
            if found == n:
                return d
    raise AssertionError("no diversifier")


def address(ivk: int, d: bytes, network: str = NETWORK) -> str:
    gd = group_hash(d, GD)
    assert gd is not None
    return bech32_encode(SAPLING_HRP[network], d + encode(mul(gd, ivk)))


@dataclass
class Note:
    ivk: int
    d: bytes
    value: int
    memo: str
    lead: int = 2
    rseed: bytes = field(default_factory=lambda: bytes((i * 11 + 5) & 0xFF for i in range(32)))


def encrypt_note(n: Note) -> OutputDescription:
    gd = group_hash(n.d, GD)
    assert gd is not None
    pkd = mul(gd, n.ivk)
    esk = prf_expand_to_scalar(n.rseed, 0x05) if n.lead == 2 else 777
    epk = encode(mul(gd, esk))
    shared = encode(mul(mul(pkd, esk), 8))
    pt = bytes([n.lead]) + n.d + n.value.to_bytes(8, "little") + n.rseed + n.memo.encode().ljust(512, b"\0")
    rcm = note_rcm(n.lead, n.rseed)
    assert rcm is not None
    cmu = extract_u(note_commitment(encode(gd), encode(pkd), n.value, rcm))
    return OutputDescription(cv=encode(mul(BASE, 1000 + n.value % 997)), cmu=cmu, ephemeral_key=epk,
                             enc_ciphertext=encrypt_note_plaintext(kdf_sapling(shared, epk), pt), out_ciphertext=bytes(80),
                             zkproof=bytes([0x7E]) * 192)


def payment_tx(notes: list[Note], *, value_balance: int, expiry_height: int, spends: int = 1, lock_time: int = 0,
               vin: list[tuple[str, int, bytes]] | None = None, vout: list[tuple[int, bytes]] | None = None,
               nullifiers: list[bytes] | None = None) -> Tx:
    tx = Tx(vin=[TxIn(OutPoint(t, n), s) for t, n, s in vin or []], vout=[TxOut(v, s) for v, s in vout or []],
            lock_time=lock_time, expiry_height=expiry_height, value_balance=value_balance)
    tx.shielded_outputs = [encrypt_note(n) for n in notes]
    tx.shielded_spends = [SpendDescription(cv=encode(mul(BASE, 2000 + i)), anchor=bytes([0x11]) * 32,
                                           nullifier=(nullifiers or [])[i] if nullifiers else bytes((k * 31 + i) & 0xFF for k in range(32)),
                                           rk=encode(mul(BASE, 3000 + i)), zkproof=bytes([0x33]) * 192, spend_auth_sig=bytes([0x44]) * 64)
                          for i in range(spends)]
    tx.binding_sig = bytes([0x66]) * 64
    return tx
