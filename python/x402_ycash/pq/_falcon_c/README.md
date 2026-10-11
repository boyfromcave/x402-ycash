# `_falcon_c/`: the node's Falcon-512 (padded) C, for the Python SDK's signer

Byte-identical copies of ycash-dd `src/crypto/pq/falcon/` at `upgrade/quantum-vaults` `4eabbeead`
(unchanged since `aa0fd3812`, the commit `vectors/pq/pq_vectors.json` was copied from). Do not edit
them here; re-copy from the node when it changes, and keep `x402_ycash/pq/falcon.py`'s `SOURCES`
in step.

* PQClean `crypto_sign/falcon-padded-512/clean/` and `common/fips202.{c,h}`, commit
  `0586a824fc0d49df0b6b6e9179d8d15d06d0974f` (2026-08-04): `inner.h fpr.h codec.c common.c vrfy.c
  keygen.c sign.c fft.c fpr.c rng.c LICENSE` unmodified; `fips202.{c,h}` carry ycash-dd's local patch
  P1 (the SHAKE256 incremental context on the stack, every changed line marked `YCASH LOCAL PATCH`;
  see ycash-dd `src/crypto/pq/README.md`).
* `ycash_falcon.h`, `ycash_falcon_sign.c`, `ycash_falcon_verify.c`: Ycash files (MIT) replacing
  PQClean's `pqclean.c`, with the randomness (keygen seed; signing nonce 40 + sampler seed 48) as
  parameters.
* Licence: MIT (the Falcon Project, `LICENSE` unchanged, with its patent note); `fips202.{c,h}` public
  domain (header notice unchanged).

`clean` Falcon emulates floating point in integers (`fpr.h`: `typedef uint64_t fpr`), so the output
does not depend on the platform's FPU. `x402_ycash/pq/falcon.py` compiles these files with
`$CC -O2 -shared -fPIC` into a cached shared library and calls `ycash_falcon512_keygen_from_seed` and
`ycash_falcon512_sign` through ctypes. Verification in the SDK stays the stdlib-only Python port.
