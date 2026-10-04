# Test vectors

Language-neutral JSON vectors (plan X-2): serialised transactions, ZIP-243 sighashes, scriptSigs,
TRANSFER payloads and facilitator verdicts, generated against real nodes of both lines (ycash-dd
4.5.0 and ycash6 6.21.0). Every implementation must reproduce them.

## `sapling/`

The Zcash Sapling test vectors the `sapling` method's offline primitives are checked against
(`packages/ycash/src/shielded/sapling/{pedersen,decrypt}.ts`): `sapling_pedersen.json` (the Pedersen
hash), `sapling_note_encryption.json` (KA, KDF, ChaCha20-Poly1305, the note plaintext; lead byte
0x01) and `sapling_key_components.json` (ivk, default address, note commitment). They are reproduced
from zcash-hackworks/zcash-test-vectors as sapling-crypto 0.7.0 and Ycash 4.5.0 carry them, under
the licence in `sapling/LICENSE`. `sapling/generate.ts` adds `sapling_devnet.json`, wallet-built
ZIP 212 notes (lead byte 0x02) from both node lines with their viewing key: a t→z and a z→z payment
each, generated on ycash-dd 4.5.0 and ycash6 6.21.0-rc1 devnets (2026-10-04). The TypeScript
(`decrypt.test.ts`) and Python (`test_sapling_vectors.py`) suites both decrypt them. The lines differ in
shape only: 6.21.0 pads a t→z to two Sapling outputs (2171 bytes; 4.5.0 sends one, 1222 bytes); the
payment note is output 0 on both.
