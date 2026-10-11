# Test vectors

Language-neutral JSON vectors (plan X-2): serialised transactions, ZIP-243 sighashes, scriptSigs,
TRANSFER payloads and facilitator verdicts, generated against real nodes of both lines (ycash-dd
4.5.0 and ycash6 6.21.0). Every implementation must reproduce them.

## `pq/` (the quantum line)

Copied byte for byte from ycash-dd `upgrade/quantum-vaults` at `aa0fd3812`, never regenerated here:

- `pq_vectors.json` = `src/test/data/pq_vectors.json`: SLH-DSA-SHA2-128s and FN-DSA-512 (PQClean
  padded) keys from 48-byte seeds, signatures over 32-byte sighashes (Falcon with its 88-byte
  entropy), key hashes, and the chunked `TX_PQPKH` spends. The TypeScript SDK (`@noble/post-quantum`
  0.7.1) reproduces every key and signature of both schemes; the Python mirror (the node test
  framework's stdlib port) every SLH-DSA key and signature and verifies the Falcon ones.
- `yellowback_pq_vectors.json` = `src/test/data/yellowback_pq_vectors.json`: its `scripts` are the node's
  `TX_PQCHANNEL` / `TX_PQPKH` matcher differential (type and YED holder per script), which both SDKs'
  parsers reproduce; its `chain` section is the module's and is not used here.

`yed/transfer_v3.json` was regenerated from the same tree's test framework: the MINT is payload
version 4 there (its owner scheme ‖ keyHash), every other type stays version 3 (C-1).

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
