"""``offer-and-receipt`` artifacts in JWS format (upstream specs/extensions/extension-offer-and-receipt.md
§3.3, §4, §5), signed ES256K: ECDSA over secp256k1 with SHA-256, the JWS signature being r ‖ s
(RFC 8812 §3.2). The payload is JCS (§10). The key id is a did:jwk, so a verifier can resolve the
public key from the receipt alone; whether that key may sign for the merchant is a separate check
(§4.5.1), which ``verify_receipt`` makes against the trusted keys its caller passes.

Byte-compatible with packages/ycash/src/shielded/receipt.ts: both sign with RFC 6979 nonces and no
extra entropy (libsecp256k1 here, noble there) and emit low-S, so the same key, payload and
issuedAt give the same JWS (vectors/shielded/shielded.json).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import coincurve

from .constants import ANONYMOUS_PAYER, OFFER_RECEIPT
from .jcs import jcs

_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_B64U = re.compile(r"^[A-Za-z0-9_-]*$")
_DID_JWK = re.compile(r"^did:jwk:([A-Za-z0-9_-]+)(#.*)?$")


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def unb64u(s: str) -> bytes:
    if not _B64U.match(s):
        raise ValueError("JWS: not base64url")
    try:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"JWS: not base64url: {e}") from e


class JwsSigner(Protocol):
    """The upstream extension's JWS signer shape (typescript/packages/extensions/src/offer-receipt/types.ts)."""

    @property
    def algorithm(self) -> str: ...
    @property
    def kid(self) -> str: ...
    def sign(self, signing_input: bytes) -> str:
        """Signs the JWS signing input; returns the base64url signature."""
        ...


def did_jwk_for(public_key: bytes) -> str:
    """``did:jwk:`` of a secp256k1 public key (compressed or uncompressed)."""
    p = coincurve.PublicKey(public_key).format(compressed=False)
    jwk = {"crv": "secp256k1", "kty": "EC", "x": b64u(p[1:33]), "y": b64u(p[33:65])}
    return "did:jwk:" + b64u(jcs(jwk).encode("utf-8"))


def public_key_from_did_jwk(kid: str) -> bytes:
    """The compressed public key a ``did:jwk:`` secp256k1 kid names (an optional ``#0`` fragment is ignored)."""
    m = _DID_JWK.match(kid)
    if not m:
        raise ValueError(f"not a did:jwk key id: {kid}")
    jwk = json.loads(unb64u(m.group(1)).decode("utf-8"))
    if not isinstance(jwk, dict) or jwk.get("kty") != "EC" or jwk.get("crv") != "secp256k1" \
            or not isinstance(jwk.get("x"), str) or not isinstance(jwk.get("y"), str):
        raise ValueError("did:jwk is not a secp256k1 EC key")
    x, y = unb64u(jwk["x"]), unb64u(jwk["y"])
    if len(x) != 32 or len(y) != 32:
        raise ValueError("did:jwk coordinates are not 32 bytes")
    return coincurve.PublicKey(b"\x04" + x + y).format(compressed=True)  # raises if not on the curve


@dataclass(frozen=True)
class Es256kSigner:
    """An ES256K signer from a 32-byte secp256k1 private key; its kid defaults to the key's did:jwk."""

    private_key: bytes
    kid: str = ""
    algorithm: str = "ES256K"
    format: str = "jws"

    def __post_init__(self) -> None:
        if len(self.private_key) != 32:
            raise ValueError("the receipt key must be 32 bytes")
        if not self.kid:
            object.__setattr__(self, "kid", did_jwk_for(self.public_key))

    @property
    def public_key(self) -> bytes:
        return coincurve.PrivateKey(self.private_key).public_key.format(compressed=True)

    def sign(self, signing_input: bytes) -> str:
        digest = hashlib.sha256(signing_input).digest()
        # r ‖ s of the recoverable form: the same RFC 6979 nonce as plain signing, already low-S.
        rs = coincurve.PrivateKey(self.private_key).sign_recoverable(digest, hasher=None)[:64]
        return b64u(rs)


def es256k_signer(private_key: bytes | str, kid: str | None = None) -> Es256kSigner:
    key = bytes.fromhex(private_key) if isinstance(private_key, str) else private_key
    return Es256kSigner(key, kid or "")


def create_jws(payload: Mapping[str, Any], signer: JwsSigner) -> str:
    """JWS Compact Serialization of a JCS payload."""
    header = b64u(jcs({"alg": signer.algorithm, "kid": signer.kid}).encode("utf-8"))
    body = b64u(jcs(payload).encode("utf-8"))
    return f"{header}.{body}.{signer.sign(f'{header}.{body}'.encode('ascii'))}"


def _der_int(x: int) -> bytes:
    b = x.to_bytes(32, "big").lstrip(b"\x00") or b"\x00"
    if b[0] & 0x80:
        b = b"\x00" + b
    return b"\x02" + bytes([len(b)]) + b


def _compact_to_der(sig: bytes) -> bytes:
    """r ‖ s to DER, with s normalised to low-S (libsecp256k1 verifies low-S only; noble's verify
    here runs with lowS: false, so a high-S signature is accepted on both sides)."""
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (0 < r < _N and 0 < s < _N):
        raise ValueError("JWS: ES256K signature out of range")
    if s > _N // 2:
        s = _N - s
    body = _der_int(r) + _der_int(s)
    return b"\x30" + bytes([len(body)]) + body


def _compressed(k: bytes | str) -> bytes:
    return coincurve.PublicKey(bytes.fromhex(k) if isinstance(k, str) else k).format(compressed=True)


@dataclass(frozen=True)
class VerifiedJws:
    header: dict[str, str]
    payload: Any


def verify_jws(token: str, trusted_public_keys: Sequence[bytes | str]) -> VerifiedJws:
    """Verifies an ES256K JWS whose kid is a did:jwk, signed by one of ``trusted_public_keys`` (the
    keys authorised to sign for the merchant, §4.5.1); returns its header and payload."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("JWS: not compact serialization")
    h, p, s = parts
    header = json.loads(unb64u(h).decode("utf-8"))
    if not isinstance(header, dict) or header.get("alg") != "ES256K":
        raise ValueError(f"JWS: unsupported alg {header.get('alg') if isinstance(header, dict) else header}")
    kid = header.get("kid")
    if not isinstance(kid, str):
        raise ValueError("JWS: header has no kid")  # noqa: TRY004  # one error type for any malformed input
    public_key = public_key_from_did_jwk(kid)
    sig = unb64u(s)
    if len(sig) != 64:
        raise ValueError("JWS: ES256K signature is not 64 bytes")
    digest = hashlib.sha256(f"{h}.{p}".encode("ascii")).digest()
    if not coincurve.PublicKey(public_key).verify(_compact_to_der(sig), digest, hasher=None):
        raise ValueError("JWS: bad signature")
    if public_key not in {_compressed(k) for k in trusted_public_keys}:
        raise ValueError("JWS: signing key is not authorised for this merchant")
    return VerifiedJws({"alg": "ES256K", "kid": kid}, json.loads(unb64u(p).decode("utf-8")))


def sign_receipt(network: str, resource_url: str, transaction: str, signer: JwsSigner,
                 issued_at: int | None = None, payer: str = ANONYMOUS_PAYER) -> dict[str, str]:
    """The receipt of a settled ``sapling-proof`` payment (spec, "Receipts"): ``{format, signature}``."""
    payload = {"version": 1, "network": network, "resourceUrl": resource_url, "payer": payer,
               "issuedAt": int(time.time()) if issued_at is None else issued_at, "transaction": transaction}
    return {"format": "jws", "signature": create_jws(payload, signer)}


def verify_receipt(receipt: Mapping[str, Any], trusted_public_keys: Sequence[bytes | str],
                   max_age_seconds: int | None = None, now: int | None = None) -> dict[str, Any]:
    """Verifies a JWS receipt (§5.5): signature, signer authorisation, version, and optionally its age."""
    if receipt.get("format") != "jws":
        raise ValueError(f"receipt format {receipt.get('format')} is not jws")
    payload = verify_jws(str(receipt.get("signature")), trusted_public_keys).payload
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("receipt version is not 1")
    for f in ("network", "resourceUrl", "payer"):
        if not isinstance(payload.get(f), str):
            raise ValueError(f"receipt {f} is missing")  # noqa: TRY004  # one error type for any malformed input
    issued = payload.get("issuedAt")
    if not isinstance(issued, int) or isinstance(issued, bool):
        raise ValueError("receipt issuedAt is missing")  # noqa: TRY004  # one error type for any malformed input
    current = int(time.time()) if now is None else now
    if max_age_seconds is not None and current - issued > max_age_seconds:
        raise ValueError("receipt is too old")
    return payload


def sign_offer(offer: Mapping[str, Any], signer: JwsSigner) -> dict[str, str]:
    """A signed offer for one ``accepts[]`` entry (§4), so a verifier can learn the amount a receipt paid."""
    return {"format": "jws", "signature": create_jws({"version": 1, **offer}, signer)}


def receipt_extension(receipt: Mapping[str, str]) -> dict[str, Any]:
    """``extensions["offer-receipt"]`` of a settle response carrying ``receipt``."""
    return {OFFER_RECEIPT: {"info": {"receipt": dict(receipt)}}}
