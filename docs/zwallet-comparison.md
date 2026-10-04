# YWallet (zwallet) sync core versus the librustzcash6 light client

Research of record, 2026-10-04 (read-only clones under `wt/scratch/x402-zwallet/`). Verdict: stay on `librustzcash6`; adopt zwallet's download/scan overlap, birthday `GetTreeState` bootstrap and checkpoint reorg handling. Its Rust core is unlicensed, on `zcash_primitives` 0.10, mainnet-only and deprecated upstream.

# x402 chunk `zwallet`: YWallet's sync core versus the `lightcore` path

Read-only research, 2026-10-04. No workspace repo touched. Clones live under `wt/scratch/x402-zwallet/` (`zwallet/`, `zcash-sync/`, `librustzcash-hhanh00/`). NOTE: the harness refused to let me write `REPORT.md` (subagent policy: return findings as text), so this message is the report; the coordinator may save it.

## 1. What was cloned

| Repo | Commit | Date | Licence |
|---|---|---|---|
| `hhanh00/zwallet` (YWallet, Flutter app) | `865dc0e533276d3426c3778f82082cefc1612fec` | 2026-08-23 | MIT (`LICENSE.md`, (c) 2023 Hanh Huynh Huu) |
| `hhanh00/zcash-sync` (Rust core, crate `zcash-warpsync` 1.2.15, lib `warp_api_ffi`) | `8a3956c8c009032cf69a57d52bfd88988fc2a6c9` (zwallet's submodule pin) | 2026-06-04 | **none**: no LICENSE file, no `license` field in `Cargo.toml`, GitHub API reports `null` |
| `hhanh00/librustzcash` (patched fork pinned by zcash-sync) | `243e18f6162d5f2f2a35eb45822c5ddc092da5df` | 2026-06-03 | MIT/Apache-2.0 as upstream (GitHub shows NOASSERTION) |
| `hhanh00/zcash-params` (Pedersen generator tables + Sapling params) | `de063c4â¦` (not cloned; API: no licence) | | **none** |

zcash-sync's default branch (`master`, HEAD `d91b603`, 2023) is far behind the pin; the pin had to be fetched by hash. YWallet's README (lines 1â13) says the project is **deprecated** ("not going to receive further updates besides security fixes, protocol updates"), no longer supports Zcash after NU6.2; "Ycash remains supported". Successor zkool2 is Zcash-only.

## 2. Sync architecture (citations are in the scratch clones)

**Fetching.** One streaming `GetBlockRange` from `db height+1` to `latest - target_height_offset` (`zcash-sync/src/chain.rs:143-251`, `src/scan.rs:136-155`). Blocks are grouped into chunks by an output budget: `free_memory / 5` outputs (`/250` under CUDA), capped at 200,000 outputs per chunk (`chain.rs:108-114, 139, 156-157`), sent over an `mpsc` channel of depth 1 so download and decryption overlap. Each chunk is committed in one SQLite `IMMEDIATE` transaction and its last block becomes a checkpoint (`scan.rs:183-226`, `blocks` table). It also sets `BlockRange.spamFilterThreshold` (`proto/service.proto:23`), a hhanh00 lightwalletd extension that blanks `epk`/`ciphertext` of transactions with more than `max_cost` outputs; the client skips them but still counts their commitments (`chain.rs:202-218`, `sync/trial_decrypt.rs:171-191`). **Neither `ref/lightwalletd` nor `lightwalletd-dd` has that field** (0 hits in `walletrpc/service.proto`); proto3 ignores it, so no filtering happens against our servers.

**Checkpoints / `GetTreeState`.** Used only to bootstrap or rescan: `rescan_from` fetches `GetBlock` + `GetTreeState` at `height-1` and stores the Sapling (and Orchard) frontier as the starting `CTree` (`src/api/sync.rs:101-148`). Rewind snaps to the nearest earlier checkpoint row in `blocks` and deletes everything above (`src/db.rs:346-368`).

**Trial decryption.** Per block, all compact outputs are collected and passed once to `zcash_note_encryption::batch::try_compact_note_decryption(&ivks, &outputs)`; blocks run in parallel with rayon `par_iter` (`sync/trial_decrypt.rs:160-222`, `sync.rs:96-100`). That is the same batched primitive `librustzcash6` uses (`zcash_client_backend/src/scan.rs:97`, `scanning/compact.rs:310`). There is **no "first bytes only" trick**: compact outputs are already the 52-byte compact ciphertext; the work per output is one Jubjub ECDH + KDF + ChaCha20 either way. Optional GPU paths (CUDA PTX, Apple Metal) do the ECDH/decrypt on device (`src/gpu/cuda.rs`, `src/gpu/metal.rs`; features `cuda`, `apple_metal`); the Flutter builds do not enable them.

**The real "warp" idea: deferred, bulk Merkle work.** Instead of appending each commitment to a `CommitmentTree` and to every `IncrementalWitness` (O(outputs Ã witnesses) Pedersen hashes), zcash-sync collects a chunk's commitments into a flat list and rebuilds level by level (`sync/tree.rs:632-663`): at each depth it hashes pairs in parallel, and for levels with more than 100 nodes computes Pedersen hashes as Jubjub `ExtendedPoint`s and converts them with one `batch_normalize` (one field inversion per level instead of one per hash: `sync/tree.rs:402-440`, `sapling/hash.rs:128-136`). The Pedersen hash is re-implemented over a precomputed 3-bit-window generator table loaded from the `zcash_params` crate (`sapling/hash.rs:17-112`, `hash.rs:12-16`). Witnesses are `{tree (frozen path at insertion), filled (siblings that became final), cursor (the still-growing sibling subtree)}` (`commitment.rs:30-76`, `sync/tree.rs:136-201`) and are advanced in the same pass by `WitnessBuilder` (`sync/tree.rs:461-586`). Owned nullifiers sit in a `HashMap<Nf,â¦>`; spends are matched per chunk (`sync.rs:151-171`). Docs: `docs/index.md`, `docs/merkle.md` (2021).

**Storage.** SQLite via rusqlite/r2d2, optional SQLCipher. Tables: `accounts`, `blocks(height, hash, timestamp)`, `transactions`, `received_notes(position, diversifier, value, rcm, nf, rho, orchard, spent, excluded)`, `sapling_witnesses(note, height, witness BLOB)`, `sapling_tree(height, tree BLOB)`, Orchard twins, `taddrs`, `utxos`, `messages`, `contacts`, prices (`src/db/migration.rs:49-125, 218-282`). Witness checkpoints are thinned to hourly/daily/monthly after each sync (`db.rs:792-830`). Memos/addresses are fetched afterwards with `GetTransaction` (`scan.rs:242-244`, `transaction.rs:33`).

**Reorgs.** `prev_hash` mismatch in the stream raises `ChainError::Reorg`; the caller drops the last checkpoint and the next sync restarts from there (`chain.rs:189-197`, `scan.rs:103-110`, `db.rs:337-343`). Block hashes are trusted from lightwalletd.

**Mempool.** `GetMempoolStream` gives raw transactions; each is parsed and trial-decrypted with the non-batched `try_sapling_note_decryption`, nullifiers matched against owned notes, a running unconfirmed balance emitted (`mempool.rs:99-108, 252-297`).

**Ycash parts.** Ycash is `CoinType::Ycash` = coin 1 with `Network::YCashMainNetwork` only (`src/coin.rs:4-12, 51-62`); Dart lists only `lite.ycash.xyz:9067` (`zwallet/lib/coin/ycash.dart:17`) plus a test app pointing at `testlite.ycash.xyz` (`ycashtest.dart`). Parameters come from the patched librustzcash, `zcash_primitives/src/consensus/ycash.rs`: Overwinter â Sapling â Ycash(570,000) â YBlossom(1,100,000) â YHeartwood(1,100,003) â YCanopy(1,100,006), coin type 347, HRP `ys`, `[0x1c,0x28]`/`[0x1c,0x2c]` mainnet; testnet `ytestsapling`, `[0x1c,0x95]`/`[0x1c,0x2a]`. **No regtest network and no `yregtestsapling` exist in zwallet's stack**; the testnet struct exists but zcash-sync never instantiates it. `librustzcash6` has all three (`components/zcash_protocol/src/constants/{mainnet,testnet,regtest}.rs`, `consensus.rs:489-532, 770`) with the same heights and branch ids. Latent Ycash bug: the mempool watcher asks for `branch_id(NetworkUpgrade::Nu5)` (`mempool.rs:255`), which the Ycash `Parameters` impl answers with `unreachable!()` (`ycash.rs:28`), so the Ycash mempool stream appears to panic in its task. The bundled TLS anchor is the DST-cross-signed ISRG Root X1 (`src/ca.pem`, notAfter 2024-09-30); webpki does not check anchor expiry so it probably still validates, but it is a maintenance hazard.

## 3. Performance

Published (Zcash, not Ycash): README claims "~10,000 blocks per second" on a Snapdragon 855+. The 2021 write-up (`docs/index.md`) shows a desktop run from Sapling activation: 675,844 outputs trial-decrypted in 5,983 ms in parallel (**8.9 Âµs/output across all cores**); tree + 9 witnesses rebuilt in 2,234 ms (**3.3 Âµs/commitment**). No benchmark harness exists at the pin (`benches/` dropped).

X4-M (`x402-ycash/docs/x4m-measurements.md`, Apple M5, real Ycash compact outputs): 66.6 Âµs/output one core per-output API, **56.4 Âµs batched**, **11.4 Âµs/output on 10 threads**, `CommitmentTree::append` 24.4 Âµs/output single-threaded; 122 B/output; Ycash mainnet holds 872,030 Sapling outputs total, ~154/day now.

Reading across machines: trial decryption is the same primitive in both stacks, so zwallet's edge there is only parallelism (which `zcash_client_backend`'s `BatchRunners` also provide). Its tree work is roughly an order of magnitude cheaper per commitment than naive appends. At Ycash volume that is small in absolute terms: full restore â 872k commitments, ~21 s naive vs ~3 s warp; one day is 154 commitments, milliseconds either way.

## 4. Comparison with the librustzcash6 path

| Axis | zcash-sync (YWallet core) | `librustzcash6` (`zcash_client_backend` 0.22 + `zcash_client_sqlite`) |
|---|---|---|
| Sync speed | Batched decryption + rayon; bulk tree with batch normalisation | Same batched decryption; `ShardTree` keeps the frontier plus shards holding owned notes, with checkpoints, so per-output tree cost is already far below naive append |
| Memory | Chunks â¤200k outputs (~25 MB compact data) | Range-based `scan_cached_blocks` over a block cache, tunable |
| Ycash maturity | Shipped to users on Ycash mainnet for years; the only field-tested Ycash Sapling light client | Ycash constants present and verified against both node lines (X4-M), but no assembled client has run yet |
| Ycash networks | mainnet only (no regtest, so untestable on devnets) | mainnet, testnet, regtest |
| Proving | `zcash_proofs::LocalTxProver::from_bytes` with the same Sapling params (`coinconfig.rs:183-186`); builder on `zcash_primitives` 0.10 | `zcash_proofs` / `sapling-crypto` 0.7, same params |
| Crate generations | `zcash_primitives` 0.10.2, `zcash_client_backend` 0.7, `orchard` 0.3, `tonic` 0.7 | `zcash_primitives` 0.28, `zcash_client_backend` 0.22: **incompatible type systems; cannot link in one binary without duplicating every crate** |
| Licence | Core and params repos carry **no licence**; only the Flutter app is MIT. Embedding in MIT `x402-ycash` needs the author's grant | MIT/Apache-2.0 |
| Build for an agent binary | No Flutter needed for the core (`cargo b --features rpc --bin warp-rpc` gives a Rocket HTTP server, `README.md:1-20`), but 28.8k lines of Rust, flatbuffers pinned to a git tag, patched librustzcash/orchard/halo2 git pins, 1.5k-line Dart FFI surface, global mutable `COIN_CONFIG`/`PROVER` statics | Plain workspace already building here |
| Embeddable as library | Technically yes (`rlib`), but the API is a wallet-app API (coins, accounts, progress callbacks) with global state, not a scanner you drive | Yes: `scan_cached_blocks`, `propose_transfer`, `create_proposed_transactions` |
| Maintenance | Deprecated upstream; one maintainer | Active upstream; our fork tracks it |

zwallet has no constants librustzcash6 lacks. librustzcash6 has regtest parameters, `ShardTree`, a maintained note-selection/fee stack, and the `GetSubtreeRoots` design, which **no Ycash server offers**: `GetSubtreeRoots` is absent from both lightwalletd pins and `z_getsubtreesbyindex` exists only on `ycash6` (`src/rpc/blockchain.cpp:2009`), behind an experimental flag.

## 5. Recommendation: (a) stay on librustzcash6; adopt three zwallet techniques

Embedding (b) is ruled out by licence (no grant on `zcash-sync` or `zcash-params`), by the crate-generation wall (0.10 vs 0.28 primitives), by the missing regtest network (untestable on devnets), and by upstream deprecation. A hybrid (c) calling zcash-sync for history and librustzcash6 for spending would carry both stacks and two SQLite schemas for a gain measured in seconds once per key.

For a CPO: the fastest Ycash wallet ever shipped got its speed from doing Merkle bookkeeping in bulk and in parallel, not from a cryptographic shortcut. Those ideas are portable; its code is not, legally or technically. Ycash's shielded volume (154 outputs/day, 872k ever) is small enough that the modern library restores a key in minutes and keeps up in milliseconds.

For the `lightcore` engineer, adopt:

1. **Overlap download with scanning** as `chain.rs`/`scan.rs` do: stream `GetBlockRange` into a bounded channel and run `scan_cached_blocks` on chunks sized by output count (not block count) while the next chunk downloads. Ycash blocks hold 0.14 outputs on average, so chunk by outputs with a block cap.
2. **Bootstrap from `GetTreeState` at the birthday**, as `rescan_from` does; never scan before the birthday. `lightwalletd-dd` serves `GetTreeState` (`frontend/service.go:196`). Do not plan on `GetSubtreeRoots`: unavailable on both lines' servers, so `ShardTree` runs frontier-only and spend-before-fully-synced is not possible; document that.
3. **Reorg handling by checkpoint**: compare each block's `prev_hash` with the last stored hash; on mismatch truncate to the previous checkpoint and resume (`chain.rs:189-197`, `db.rs:346-368`); `zcash_client_sqlite::truncate_to_height` is the equivalent.

Optional, only if profiling shows tree work dominating: zwallet's batch-normalised Pedersen level hashing (`sync/tree.rs:422-440`) can be ported as an independent MIT-clean rewrite against `sapling-crypto`'s `Node::combine` (accumulate `ExtendedPoint`s, one `batch_normalize` per level; a dozen lines). At Ycash volume I would not do it now.

Do not adopt: the spam filter (our servers lack the field; Ycash has no such spam problem), GPU paths, global-static coin configuration, or the bundled TLS anchor (use system roots via `tonic` `tls-roots`).

## Findings for the coordinator (X-F? placeholders)

1. `zcash-sync` and `zcash-params` carry no licence; only the Flutter app is MIT. Any embedding needs an explicit grant.
2. zwallet's stack has no Ycash regtest network (`yregtestsapling` absent); mainnet only in zcash-sync.
3. zcash-sync's Ycash mempool watcher calls `branch_id(Nu5)`, which the Ycash params answer with `unreachable!()` (`mempool.rs:255`, `ycash.rs:28`).
4. `GetSubtreeRoots` / `z_getsubtreesbyindex` are absent from the Ycash light stack on both lines (experimental RPC on `ycash6` only), which bounds what `zcash_client_backend` 0.22 can do on Ycash: frontier-only `ShardTree`, no spend-before-sync.
5. Both lightwalletd pins lack hhanh00's `BlockRange.spamFilterThreshold`; zwallet's filtering is a no-op against them.

Open item: `REPORT.md` was not written (harness policy); coordinator should save this text to `wt/scratch/x402-zwallet/REPORT.md` if a file is wanted.
