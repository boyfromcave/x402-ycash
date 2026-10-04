"""Sapling note trial decryption with an incoming viewing key, offline (Zcash protocol spec §4.19.2,
as sapling-crypto 0.7 ``note_encryption.rs`` and zcash_note_encryption 0.4 ``lib.rs:468-550`` do it),
and the ``zxview…`` key decoding it needs. Mirrors packages/ycash/src/shielded/sapling/decrypt.ts and
address.ts (decodeSaplingViewingKey); the ``sapling`` facilitator uses it on the client's transaction
before anything is broadcast (specs/scheme_exact_ycash.md, "sapling", rule 5).

ChaCha20-Poly1305 comes from the ``cryptography`` package (the only dependency added for this); the
curve arithmetic and BLAKE2 are pure Python / hashlib.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Protocol

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

from ...constants import YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET
from ..constants import SAPLING_HRP
from .bech32 import bech32_decode, bech32_encode
from .jubjub import R, decode, encode, group_hash, is_identity, mul
from .pedersen import extract_u, note_commitment

NOTE_PLAINTEXT_SIZE = 564
COMPACT_NOTE_SIZE = 52
MEMO_SIZE = 512
LEAD_BYTE_BEFORE_ZIP212 = 0x01
LEAD_BYTE_ZIP212 = 0x02

KDF_PERSONALIZATION = b"Zcash_SaplingKDF"
PRF_EXPAND_PERSONALIZATION = b"Zcash_ExpandSeed"
DIVERSIFY_PERSONALIZATION = b"Zcash_gd"
IVK_PERSONALIZATION = b"Zcashivk"
PRF_SAPLING_RCM = 0x04
PRF_SAPLING_ESK = 0x05
"""PRF^expand domain separators (zcash_spec 0.2 ``prf_expand.rs:70-71``)."""
_ZERO_NONCE = bytes(12)

SAPLING_EXTFVK_HRP: dict[str, str] = {YCASH_MAINNET: "zxviews", YCASH_TESTNET: "zxviewtestsapling", YCASH_REGTEST: "zxviewregtestsapling"}
"""Extended-full-viewing-key HRPs per network (``chainparams.cpp``: SAPLING_EXTENDED_FVK)."""
_EXTFVK_LEN = 169
_AK, _NK, _DK = 41, 73, 137


@dataclass(frozen=True)
class SaplingIncomingKey:
    network: str
    ivk: int
    """ivk as a Jubjub scalar, below 2^251."""
    dk: bytes
    """The 32-byte diversifier key (kept for parity; trial decryption does not use it)."""


@dataclass(frozen=True)
class DecryptedNote:
    lead_byte: int
    diversifier: bytes
    value: int
    """zatoshis"""
    rseed: bytes
    memo: bytes
    """The 512-byte memo field, as sent."""
    pkd: bytes
    address: str


class EncryptedOutput(Protocol):
    """The fields of an output description trial decryption reads (x402_ycash.tx OutputDescription)."""

    cmu: bytes
    ephemeral_key: bytes
    enc_ciphertext: bytes


def _le(b: bytes) -> int:
    return int.from_bytes(b, "little")


def crh_ivk(ak: bytes, nk: bytes) -> int:
    """CRH^ivk(ak, nk): BLAKE2s-256 "Zcashivk", top five bits dropped (``spec.rs:25-41``)."""
    h = bytearray(hashlib.blake2s(ak + nk, digest_size=32, person=IVK_PERSONALIZATION).digest())
    h[31] &= 0x07
    return _le(bytes(h))


def decode_sapling_viewing_key(key: str, network: str) -> SaplingIncomingKey:
    """Decodes a ``zxview…`` key (``z_exportviewingkey``) and keeps its incoming half. The HRP must be
    the network's: testnet and regtest keys differ here, though their transparent addresses do not."""
    hrp, data = bech32_decode(key)
    want = SAPLING_EXTFVK_HRP[network]
    if hrp != want:
        raise ValueError(f"not a {network} Sapling viewing key ({want}1…): {hrp}")
    if len(data) != _EXTFVK_LEN:
        raise ValueError(f"a Sapling extended full viewing key is {_EXTFVK_LEN} bytes, got {len(data)}")
    ak, nk = data[_AK:_AK + 32], data[_NK:_NK + 32]
    if decode(ak) is None or decode(nk) is None:
        raise ValueError("the viewing key's ak or nk is not a point")
    ivk = crh_ivk(ak, nk)
    if ivk == 0:
        raise ValueError("the viewing key's ivk is zero")
    return SaplingIncomingKey(network, ivk, bytes(data[_DK:_DK + 32]))


def kdf_sapling(shared_secret: bytes, epk: bytes) -> bytes:
    """KDF^Sapling = BLAKE2b-256("Zcash_SaplingKDF", repr(sharedSecret) ‖ epk)."""
    return hashlib.blake2b(shared_secret + epk, digest_size=32, person=KDF_PERSONALIZATION).digest()


def sapling_ka_agree(ivk: int, epk: bytes) -> bytes | None:
    """KA^Sapling.Agree(ivk, epk) = repr([8·ivk]·epk), or None when epk is not a point."""
    p = decode(epk)
    return None if p is None else encode(mul(mul(p, ivk), 8))


def prf_expand_to_scalar(rseed: bytes, tag: int) -> int:
    """ToScalar(PRF^expand(rseed, [tag])): BLAKE2b-512 "Zcash_ExpandSeed", LE mod r."""
    return _le(hashlib.blake2b(rseed + bytes([tag]), digest_size=64, person=PRF_EXPAND_PERSONALIZATION).digest()) % R


def decrypt_note_ciphertext(key: bytes, ciphertext: bytes) -> bytes | None:
    """ChaCha20-Poly1305, zero nonce, no associated data; a tag failure is "not ours"."""
    if len(ciphertext) != NOTE_PLAINTEXT_SIZE + 16:
        return None
    try:
        return ChaCha20Poly1305(key).decrypt(_ZERO_NONCE, ciphertext, None)
    except InvalidTag:
        return None


def encrypt_note_plaintext(key: bytes, plaintext: bytes) -> bytes:
    """The sender's side of decrypt_note_ciphertext (tests and vector checks)."""
    return ChaCha20Poly1305(key).encrypt(_ZERO_NONCE, plaintext, None)


def note_rcm(lead_byte: int, rseed: bytes) -> int | None:
    """rcm: PRF^expand(rseed, [4]) for a ZIP 212 note; the field itself before, if canonical."""
    if lead_byte == LEAD_BYTE_ZIP212:
        return prf_expand_to_scalar(rseed, PRF_SAPLING_RCM)
    r = _le(rseed)
    return r if r < R else None


def trial_decrypt_output(output: EncryptedOutput, ivk: int, network: str) -> DecryptedNote | None:
    """Trial-decrypts one output and authenticates it as a receiving wallet does: the AEAD tag, a
    known lead byte, a valid diversifier, pk_d = [ivk]·g_d, the recomputed cmu equal to the output's,
    and for a ZIP 212 note epk = [esk(rseed)]·g_d. None when it is not to this key or fails a check."""
    shared = sapling_ka_agree(ivk, output.ephemeral_key)
    if shared is None:
        return None
    pt = decrypt_note_ciphertext(kdf_sapling(shared, output.ephemeral_key), output.enc_ciphertext)
    if pt is None or len(pt) != NOTE_PLAINTEXT_SIZE:
        return None
    lead = pt[0]
    if lead not in (LEAD_BYTE_BEFORE_ZIP212, LEAD_BYTE_ZIP212):
        return None
    d, value, rseed, memo = pt[1:12], _le(pt[12:20]), pt[20:COMPACT_NOTE_SIZE], pt[COMPACT_NOTE_SIZE:]
    gd = group_hash(d, DIVERSIFY_PERSONALIZATION)
    if gd is None:
        return None
    pkd = mul(gd, ivk)
    if is_identity(pkd):
        return None
    rcm = note_rcm(lead, rseed)
    if rcm is None:
        return None
    gd_bytes, pkd_bytes = encode(gd), encode(pkd)
    if extract_u(note_commitment(gd_bytes, pkd_bytes, value, rcm)) != bytes(output.cmu):
        return None
    if lead == LEAD_BYTE_ZIP212:
        esk = prf_expand_to_scalar(rseed, PRF_SAPLING_ESK)
        if esk == 0 or encode(mul(gd, esk)) != bytes(output.ephemeral_key):
            return None
    return DecryptedNote(lead, d, value, rseed, memo, pkd_bytes, bech32_encode(SAPLING_HRP[network], d + pkd_bytes))


def memo_bytes(memo: bytes) -> bytes:
    """The memo with trailing zero bytes removed (rule 7 compares it with extra.memo)."""
    return memo.rstrip(b"\x00")
