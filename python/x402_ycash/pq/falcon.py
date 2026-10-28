# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""The FN-DSA-512 (Falcon-512, PQClean padded) key generator and signer of the Python SDK.

Falcon signing samples a discrete Gaussian in floating point. A pure-Python port would use the
platform's doubles and would have to reproduce PQClean's emulated arithmetic bit for bit to match the
node; instead this module runs the node's own C: the files in ``_falcon_c/`` are byte-identical copies
of ycash-dd ``src/crypto/pq/falcon/`` (PQClean ``falcon-padded-512/clean`` at 0586a824fc0d, ycash-dd's
local patch P1 to ``fips202.{c,h}``, and the Ycash entry points ``ycash_falcon_*.c`` that take the
randomness as parameters), whose ``clean`` arithmetic is integer-only. They are compiled once into a
shared library with the system C compiler and called through ctypes:

- ``X402_YCASH_FALCON_LIB``: a prebuilt library to load (no compiler needed at run time);
- otherwise the library is built on first use into ``$X402_YCASH_FALCON_CACHE`` (default
  ``~/.cache/x402-ycash``), named by the SHA-256 of the sources and the compiler command, with
  ``$CC`` (default ``cc``) ``-O2 -shared -fPIC``;
- ``python -m x402_ycash.pq.falcon [--out PATH]`` builds it ahead of time and checks it against the
  node's vectors (the documented build step for a deployment without a compiler at run time).

Verification never uses this library: ``x402_ycash.pq.verify`` stays the stdlib-only port of the node
test framework's verifier. The C is the wallet half of the node's library (``pq::KeyGen``/``pq::Sign``):
it never runs on a consensus path.
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import shlex
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

PUBLICKEY_BYTES = 897
SECRETKEY_BYTES = 1281
SIG_BYTES = 666
SEED_BYTES = 48
NONCE_BYTES = 40
SIGN_SEED_BYTES = 48
SIGN_ENTROPY_BYTES = NONCE_BYTES + SIGN_SEED_BYTES

SOURCES = (
    "codec.c", "common.c", "fft.c", "fips202.c", "fpr.c", "keygen.c", "rng.c", "sign.c", "vrfy.c",
    "ycash_falcon_sign.c", "ycash_falcon_verify.c",
)
HEADERS = ("fips202.h", "fpr.h", "inner.h", "ycash_falcon.h")
SOURCE_DIR = Path(__file__).with_name("_falcon_c")

_lock = threading.Lock()
_lib: ctypes.CDLL | None = None


class FalconUnavailable(RuntimeError):
    """The Falcon library could not be loaded or built (no C compiler, or a bad X402_YCASH_FALCON_LIB)."""


def _suffix() -> str:
    return ".dylib" if sys.platform == "darwin" else ".dll" if sys.platform == "win32" else ".so"


def _cc() -> list[str]:
    return shlex.split(os.environ.get("CC", "cc"))


def _build_id() -> str:
    h = hashlib.sha256()
    for name in (*SOURCES, *HEADERS):
        h.update(name.encode() + b"\0" + (SOURCE_DIR / name).read_bytes() + b"\0")
    h.update(" ".join(_cc()).encode())
    return h.hexdigest()[:16]


def build_library(out: str | os.PathLike[str] | None = None) -> Path:
    """Compiles ``_falcon_c/`` into a shared library and returns its path.

    Args:
        out: Where to write it; default the cache directory, named by the build id.

    Raises:
        FalconUnavailable: When the compiler fails or is missing.
    """
    if out is None:
        cache = Path(os.environ.get("X402_YCASH_FALCON_CACHE") or Path.home() / ".cache" / "x402-ycash")
        target = cache / f"libycashfalcon-{_build_id()}{_suffix()}"
    else:
        target = Path(out)
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    # Build into a temporary name in the same directory, then rename: concurrent builders never load a
    # half-written library.
    fd, tmp = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
    os.close(fd)
    cmd = [*_cc(), "-O2", "-shared", "-fPIC", "-o", tmp, *(str(SOURCE_DIR / s) for s in SOURCES)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except OSError as e:
        os.unlink(tmp)
        raise FalconUnavailable(f"cannot run the C compiler {cmd[0]!r} to build the Falcon signer: {e}") from e
    if r.returncode != 0:
        os.unlink(tmp)
        raise FalconUnavailable(f"building the Falcon signer failed ({' '.join(cmd)}):\n{r.stderr}")
    os.replace(tmp, target)
    return target


def _load() -> ctypes.CDLL:
    global _lib
    with _lock:
        if _lib is not None:
            return _lib
        path = os.environ.get("X402_YCASH_FALCON_LIB") or str(build_library())
        try:
            lib = ctypes.CDLL(path)
        except OSError as e:
            raise FalconUnavailable(f"cannot load the Falcon library {path}: {e}") from e
        lib.ycash_falcon512_keygen_from_seed.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t]
        lib.ycash_falcon512_keygen_from_seed.restype = ctypes.c_int
        lib.ycash_falcon512_sign.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
        lib.ycash_falcon512_sign.restype = ctypes.c_int
        lib.ycash_falcon512_verify.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p]
        lib.ycash_falcon512_verify.restype = ctypes.c_int
        _lib = lib
        return lib


def available() -> bool:
    """Whether the signer can be loaded (building it if needed)."""
    try:
        _load()
        return True
    except FalconUnavailable:
        return False


def keygen(seed: bytes) -> tuple[bytes, bytes]:
    """pq::KeyGen for scheme 2: ``(pk, sk)`` from the 48-byte seed (SHAKE256-seeded, as PQClean's keypair)."""
    if len(seed) != SEED_BYTES:
        raise ValueError(f"a Falcon seed is {SEED_BYTES} bytes")
    lib = _load()
    pk = ctypes.create_string_buffer(PUBLICKEY_BYTES)
    sk = ctypes.create_string_buffer(SECRETKEY_BYTES)
    if lib.ycash_falcon512_keygen_from_seed(pk, sk, bytes(seed), len(seed)) != 0:
        raise RuntimeError("Falcon key generation failed")
    out = pk.raw, sk.raw
    ctypes.memset(sk, 0, SECRETKEY_BYTES)
    return out


def sign(sk: bytes, msg: bytes, entropy: bytes | None = None) -> bytes:
    """pq::Sign for scheme 2: the 666-byte padded signature (no hash-type byte).

    Args:
        sk: The 1,281-byte secret key.
        msg: The message (a 32-byte sighash for a Ycash input).
        entropy: 88 bytes, the 40-byte nonce then the sampler's 48-byte seed (PQClean's randombytes
            order), for reproducible vectors; default ``os.urandom(88)``.
    """
    if len(sk) != SECRETKEY_BYTES:
        raise ValueError(f"a Falcon secret key is {SECRETKEY_BYTES} bytes")
    if entropy is None:
        entropy = os.urandom(SIGN_ENTROPY_BYTES)
    if len(entropy) != SIGN_ENTROPY_BYTES:
        raise ValueError(f"Falcon signing entropy is {SIGN_ENTROPY_BYTES} bytes")
    lib = _load()
    sig = ctypes.create_string_buffer(SIG_BYTES)
    if lib.ycash_falcon512_sign(sig, bytes(msg), len(msg), bytes(sk), entropy[:NONCE_BYTES], entropy[NONCE_BYTES:]) != 0:
        raise RuntimeError("Falcon signing failed (a malformed secret key?)")
    return sig.raw


def c_verify(pk: bytes, sig: bytes, msg: bytes) -> bool:
    """The node's C verifier, for differential tests only (the SDK verifies with the stdlib port)."""
    if len(pk) != PUBLICKEY_BYTES or len(sig) != SIG_BYTES:
        return False
    return _load().ycash_falcon512_verify(bytes(sig), len(sig), bytes(msg), len(msg), bytes(pk)) == 0


def _main(argv: list[str]) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(prog="python -m x402_ycash.pq.falcon", description="Build the Falcon signer and check it against the node's vectors.")
    ap.add_argument("--out", help="write the library here (then point X402_YCASH_FALCON_LIB at it); default: the cache")
    ap.add_argument("--vectors", help="a pq_vectors.json to check against (default: the repository's vectors/pq/pq_vectors.json, when present)")
    a = ap.parse_args(argv)
    path = build_library(a.out)
    os.environ.setdefault("X402_YCASH_FALCON_LIB", str(path))
    print(f"Falcon signer: {path}")
    vec = Path(a.vectors) if a.vectors else Path(__file__).parents[3] / "vectors" / "pq" / "pq_vectors.json"
    if vec.exists():
        from . import verify as stdlib_verify

        keys = [k for k in json.loads(vec.read_text())["keys"] if k["scheme"] == 2]
        for k in keys:
            pk, sk = keygen(bytes.fromhex(k["seed"]))
            sig = sign(sk, bytes.fromhex(k["msg"]), bytes.fromhex(k["entropy"]))
            if pk.hex() != k["pk"] or sig.hex() != k["sig"] or not stdlib_verify(2, pk, sig, bytes.fromhex(k["msg"])):
                print(f"MISMATCH on {k['label']}")
                return 1
        print(f"{len(keys)}/{len(keys)} Falcon vectors byte-identical ({vec})")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
