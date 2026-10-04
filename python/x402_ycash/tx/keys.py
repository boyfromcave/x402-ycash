"""secp256k1 keys, transparent signatures and WIF.

The node signs with libsecp256k1, RFC 6979 and no extra entropy (ycash-dd/src/key.cpp:201-214,
ycash6 :204-217). coincurve binds the same library, so a signature made here is byte-identical to
``signrawtransaction``'s, and libsecp256k1 always emits low-S (SCRIPT_VERIFY_LOW_S, standard on both
lines) and refuses high-S when verifying.
"""

from __future__ import annotations

from dataclasses import dataclass

import coincurve

from ..constants import YCASH_MAINNET, YCASH_TESTNET
from .address import base58check_decode, base58check_encode
from .sighash import SIGHASH_ALL

# SECRET_KEY prefixes: mainnet 0x80, testnet and regtest 0xEF
# (ycash-dd/src/chainparams.cpp:153,413,615; ycash6 :165,460,691).
_WIF_MAINNET = 0x80
_WIF_TEST = 0xEF


def pubkey_from_priv(priv: bytes, compressed: bool = True) -> bytes:
    """The 33-byte compressed public key (or 65-byte uncompressed)."""
    return coincurve.PrivateKey(priv).public_key.format(compressed=compressed)


def random_priv_key() -> bytes:
    return coincurve.PrivateKey().secret


def is_strict_der(sig: bytes) -> bool:
    """IsValidSignatureEncoding (BIP66, src/script/interpreter.cpp) for DER without the hash type."""
    n = len(sig)
    if n < 8 or n > 72 or sig[0] != 0x30 or sig[1] != n - 2:
        return False
    len_r = sig[3]
    if sig[2] != 0x02 or len_r == 0 or 5 + len_r >= n:
        return False
    len_s = sig[5 + len_r]
    if sig[4 + len_r] != 0x02 or len_s == 0 or len_r + len_s + 6 != n:
        return False
    for off, length in ((4, len_r), (6 + len_r, len_s)):
        if sig[off] & 0x80:
            return False
        if length > 1 and sig[off] == 0 and not sig[off + 1] & 0x80:
            return False
    return True


def sign_input(sighash: bytes, priv: bytes, hash_type: int = SIGHASH_ALL) -> bytes:
    """Sign a sighash: low-S strict DER followed by the hash-type byte, ready to push in a scriptSig."""
    if len(sighash) != 32:
        raise ValueError("sighash must be 32 bytes")
    der = coincurve.PrivateKey(priv).sign(sighash, hasher=None)
    return der + bytes([hash_type & 0xFF])


def verify_input_sig(sig: bytes, sighash: bytes, pubkey: bytes) -> bool:
    """Verify a scriptSig signature (DER ‖ hash type) as the node's policy would: strict DER, low S.
    Returns False rather than raising on malformed input."""
    if len(sig) < 9 or not is_strict_der(sig[:-1]):
        return False
    try:
        return coincurve.PublicKey(pubkey).verify(sig[:-1], sighash, hasher=None)
    except (ValueError, TypeError):
        return False


def sig_hash_type(sig: bytes) -> int:
    """The hash-type byte a scriptSig signature ends with."""
    if not sig:
        raise ValueError("empty signature")
    return sig[-1]


@dataclass(frozen=True)
class DecodedWif:
    priv_key: bytes
    compressed: bool
    network: str
    """ycash:mainnet, or ycash:testnet for both testnet and regtest (they share 0xEF)."""


def encode_wif(priv: bytes, network: str, compressed: bool = True) -> str:
    if len(priv) != 32:
        raise ValueError("private key must be 32 bytes")
    version = _WIF_MAINNET if network == YCASH_MAINNET else _WIF_TEST
    return base58check_encode(bytes([version]) + priv + (b"\x01" if compressed else b""))


def decode_wif(wif: str, network: str | None = None) -> DecodedWif:
    """Decode a WIF key; with ``network``, also require that network's prefix."""
    b = base58check_decode(wif)
    version = b[0] if b else -1
    if version not in (_WIF_MAINNET, _WIF_TEST):
        raise ValueError("not a Ycash WIF key")
    if len(b) == 34 and b[33] == 1:
        compressed = True
    elif len(b) == 33:
        compressed = False
    else:
        raise ValueError("bad WIF length")
    if network is not None and (network == YCASH_MAINNET) != (version == _WIF_MAINNET):
        raise ValueError(f"WIF key is not for {network}")
    decoded_net = YCASH_MAINNET if version == _WIF_MAINNET else YCASH_TESTNET
    return DecodedWif(b[1:33], compressed, network or decoded_net)
