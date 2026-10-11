# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""Post-quantum keys, signatures and script pieces of the vault upgrade's quantum line; mirrors
packages/ycash/src/pq (quantum spec §0, §2; the node's src/crypto/pq/scheme.h).

- Schemes: 0x01 SLH-DSA-SHA2-128s (FIPS 205 pure, empty context, deterministic), 0x02 FN-DSA-512
  (PQClean falcon-padded-512; verification only in Python: there is no conformant Python signer).
- A key is named on chain by SHA256(scheme || pk). TX_PQPKH is ``20 <hash> 51|52 c2`` (35 bytes).
- The chunked spend: ``<sig_1>..<sig_s> <s> <pk_1>..<pk_p> <p>``, the hash type on the signature's
  last byte; every chunk but the last exactly 520 bytes; s and p as OP_1..OP_16.

The message is the 32-byte ZIP-243 sighash in memory order, the bytes an ECDSA input signs.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from ..tx.script import OP, ScriptChunk, ScriptItem, build_script, push_data
from . import _crypto

SCHEME_SLH_DSA_SHA2_128S = 0x01
SCHEME_FN_DSA_512 = 0x02
KEYHASH_SIZE = 32
MAX_CHUNK = 520
SEED_SIZE = 48
PQPKH_SCRIPT_SIZE = 35

_PUBKEY_SIZE = {SCHEME_SLH_DSA_SHA2_128S: 32, SCHEME_FN_DSA_512: 897}
_SIG_SIZE = {SCHEME_SLH_DSA_SHA2_128S: 7856, SCHEME_FN_DSA_512: 666}
_MAX_P2PKH_SCRIPTSIG = 1 + 73 + 1 + 33
_MIN_RELAY_FEE_PER_KB = 100


@dataclass(frozen=True)
class PQKeyId:
    """A post-quantum key as the chain names it (the node's CPQKeyID)."""

    scheme: int
    hash: bytes


@dataclass(frozen=True)
class PQKeyPair:
    """A post-quantum key pair (``keygen``'s output with its scheme)."""

    scheme: int
    pk: bytes
    sk: bytes

    @classmethod
    def from_seed(cls, scheme: int, seed: bytes) -> PQKeyPair:
        pk, sk = keygen(scheme, seed)
        return cls(scheme, pk, sk)

    @property
    def key_id(self) -> PQKeyId:
        return key_id_of(self.scheme, self.pk)


@dataclass(frozen=True)
class PQSpend:
    """A parsed chunked spend: the scheme, the public key and the signature with its hash-type byte."""

    scheme: int
    pk: bytes
    sig: bytes


def is_known_scheme(s: int) -> bool:
    return s in _PUBKEY_SIZE


def pubkey_size(s: int) -> int:
    return _PUBKEY_SIZE.get(s, 0)


def sig_size(s: int) -> int:
    """Without the hash-type byte."""
    return _SIG_SIZE.get(s, 0)


def key_hash(scheme: int, pk: bytes) -> bytes:
    """pq::KeyHash: SHA256(scheme || pk)."""
    if len(pk) != pubkey_size(scheme):
        raise ValueError(f"a scheme {scheme} public key is {pubkey_size(scheme)} bytes, not {len(pk)}")
    return hashlib.sha256(bytes([scheme]) + bytes(pk)).digest()


def key_id_of(scheme: int, pk: bytes) -> PQKeyId:
    return PQKeyId(scheme, key_hash(scheme, pk))


def keygen(scheme: int, seed: bytes) -> tuple[bytes, bytes]:
    """pq::KeyGen from the 48-byte seed: ``(pk, sk)``. SLH-DSA only (no Python Falcon key generation)."""
    if len(seed) != SEED_SIZE:
        raise ValueError(f"a post-quantum seed is {SEED_SIZE} bytes")
    if scheme != SCHEME_SLH_DSA_SHA2_128S:
        raise NotImplementedError("only SLH-DSA keys are generated in Python; FN-DSA has no conformant Python signer")
    pk, sk = _crypto.slh_keygen(seed)
    return bytes(pk), bytes(sk)


def sign(scheme: int, sk: bytes, msg32: bytes) -> bytes:
    """pq::Sign, deterministic SLH-DSA (opt_rand = PK.seed); the signature without a hash-type byte."""
    if len(msg32) != 32:
        raise ValueError("the signed message is a 32-byte sighash")
    if scheme != SCHEME_SLH_DSA_SHA2_128S:
        raise NotImplementedError("only SLH-DSA signs in Python; FN-DSA has no conformant Python signer")
    return bytes(_crypto.slh_sign(sk, msg32))


def verify(scheme: int, pk: bytes, sig: bytes, msg32: bytes) -> bool:
    """pq::Verify: ``sig`` without the hash-type byte. Never raises."""
    if len(msg32) != 32 or len(pk) != pubkey_size(scheme) or len(sig) != sig_size(scheme):
        return False
    try:
        if scheme == SCHEME_SLH_DSA_SHA2_128S:
            return bool(_crypto.slh_verify(pk, msg32, sig))
        return bool(_crypto.falcon_verify(pk, msg32, sig))
    except Exception:  # noqa: BLE001 - a malformed encoding is an invalid signature, as in the node
        return False


def chunk(data: bytes) -> list[bytes]:
    return [data[i:i + MAX_CHUNK] for i in range(0, len(data), MAX_CHUNK)]


def pq_spend_items(pk: bytes, sig_with_hashtype: bytes) -> list[ScriptItem]:
    """build_script items: the signature chunks, s, the key chunks, p."""
    sigs, pks = chunk(sig_with_hashtype), chunk(pk)
    return [*sigs, int(OP.OP_1) + len(sigs) - 1, *pks, int(OP.OP_1) + len(pks) - 1]


def pq_spend_script(pk: bytes, sig_with_hashtype: bytes) -> bytes:
    """The TX_PQPKH scriptSig (the pushes alone)."""
    return build_script(pq_spend_items(pk, sig_with_hashtype))


def pq_spend_size(scheme: int) -> int:
    """The bytes the chunked spend takes (SLH-DSA 7,938, Falcon 1,577; the node's PQSpendInputSize less the input framing)."""
    return len(pq_spend_script(bytes(pubkey_size(scheme)), bytes(sig_size(scheme) + 1)))


def pqpkh_script(kid: PQKeyId) -> bytes:
    if not is_known_scheme(kid.scheme):
        raise ValueError(f"unknown post-quantum scheme {kid.scheme}")
    if len(kid.hash) != KEYHASH_SIZE:
        raise ValueError("a post-quantum key hash is 32 bytes")
    return push_data(kid.hash) + bytes([OP.OP_1 + kid.scheme - 1, OP.OP_CHECKPQSIG])


def pqpkh_key_id(spk: bytes) -> PQKeyId | None:
    """The Solver's exact TX_PQPKH match."""
    if len(spk) != PQPKH_SCRIPT_SIZE or spk[0] != 0x20 or spk[34] != OP.OP_CHECKPQSIG or spk[33] not in (OP.OP_1, OP.OP_2):
        return None
    return PQKeyId(spk[33] - OP.OP_1 + 1, bytes(spk[1:33]))


def _small_int(c: ScriptChunk | None) -> int | None:
    if c is None or c.data is not None or not OP.OP_1 <= c.op <= OP.OP_16:
        return None
    return c.op - OP.OP_1 + 1


def _join(cs: list[ScriptChunk]) -> bytes | None:
    out = b""
    for i, c in enumerate(cs):
        d = c.data
        if not d or len(d) > MAX_CHUNK or (i < len(cs) - 1 and len(d) != MAX_CHUNK):
            return None
        out += d
    return out


def parse_pq_spend(cs: list[ScriptChunk]) -> PQSpend | None:
    """Exactly ``<sig_1>..<sig_s> <s> <pk_1>..<pk_p> <p>`` (nothing before or after), canonical
    chunks, the scheme by key and signature size. Push minimality is the caller's (a canonical rebuild)."""
    p = _small_int(cs[-1] if cs else None)
    if p is None or len(cs) < p + 3:
        return None
    s = _small_int(cs[len(cs) - 2 - p])
    if s is None or len(cs) != s + p + 2:
        return None
    pk = _join(cs[len(cs) - 1 - p:len(cs) - 1])
    sig = _join(cs[:s])
    if pk is None or sig is None:
        return None
    scheme = next((k for k, v in _PUBKEY_SIZE.items() if v == len(pk)), None)
    if scheme is None or len(sig) != sig_size(scheme) + 1 or s != len(chunk(sig)) or p != len(chunk(pk)):
        return None
    return PQSpend(scheme, pk, sig)


def spend_matches(sp: PQSpend, kid: PQKeyId) -> bool:
    return sp.scheme == kid.scheme and key_hash(sp.scheme, sp.pk) == kid.hash


def max_script_sig_size_of(spk: bytes) -> int:
    """The scriptSig to reserve when sizing a draft: a TX_PQPKH's chunked spend, else a P2PKH spend."""
    kid = pqpkh_key_id(spk)
    return pq_spend_size(kid.scheme) if kid else _MAX_P2PKH_SCRIPTSIG


def pq_dust_threshold(scheme: int) -> int:
    """GetPQDustThreshold at the default relay fee: SLH-DSA 2,406, Falcon 498 zatoshis."""
    ss = pq_spend_size(scheme)
    spend_input = 40 + (3 if ss > 252 else 1) + ss
    return 3 * ((_MIN_RELAY_FEE_PER_KB * (spend_input + 8 + 1 + PQPKH_SCRIPT_SIZE)) // 1000)


__all__ = [
    "KEYHASH_SIZE",
    "MAX_CHUNK",
    "PQPKH_SCRIPT_SIZE",
    "SCHEME_FN_DSA_512",
    "SCHEME_SLH_DSA_SHA2_128S",
    "SEED_SIZE",
    "PQKeyId",
    "PQKeyPair",
    "PQSpend",
    "chunk",
    "is_known_scheme",
    "key_hash",
    "key_id_of",
    "keygen",
    "max_script_sig_size_of",
    "parse_pq_spend",
    "pq_dust_threshold",
    "pq_spend_items",
    "pq_spend_script",
    "pq_spend_size",
    "pqpkh_key_id",
    "pqpkh_script",
    "pubkey_size",
    "sig_size",
    "sign",
    "spend_matches",
    "verify",
]
