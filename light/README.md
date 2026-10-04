# x402-ycash-light: a Sapling light client for agents on Ycash

An agent that pays in shielded YEC (x402 `sapling-proof`, plan §5.10 tier P1/P2) needs a synced
Sapling wallet. Until now that meant a node wallet: YEW's core is transparent-only and no Sapling
light client existed for Ycash (X4-M, `docs/x4m-measurements.md`). This crate is one. It talks to
lightwalletd-dd, keeps its notes in a `zcash_client_sqlite` database, and builds, proves and signs
a shielded payment with a memo **without broadcasting it** (the X4b building block), or broadcasts
it through lightwalletd.

It is a library (`x402_ycash_light`: `net`, `keys`, `lwd`, `sync`, `wallet`; the spending key is
injected) plus a thin binary, `x402-light`, that adds a loopback JSON-RPC 2.0 server, a `once` CLI
and the key file. YEW's Rust core is meant to depend on the library.

## Build

```
cd light
cargo build --release          # needs protoc (brew install protobuf / apt install protobuf-compiler)
cargo test                     # unit tests; no proving parameters needed
```

**Pinning.** The `zcash_*` crates come from `librustzcash6` (boyfromcave/librustzcash6 =
miodragpop/librustzcash @ `ec525fae`, the revision `ref/ycash6/Cargo.toml:122-133` pins for ycashd
6.21.0): `zcash_client_backend` 0.22, `zcash_client_sqlite` 0.20.2, `zcash_primitives` 0.28,
`zcash_proofs` 0.28, `zcash_keys` 0.14, `zcash_protocol` 0.9, `zip321` 0.8, `sapling-crypto` 0.7.
For now they are **path dependencies** on `../../../librustzcash6` (the workspace layout; CI clones
the fork there) with a `[patch.crates-io]` block mirroring ycashd's so every transitive copy is the
same source. **A release must switch every path to
`git = "https://github.com/boyfromcave/librustzcash6", rev = "ec525fae…"`** (or a later tag of
the fork) in both the dependencies and the patch block.

Note for anyone building on a machine with `protoc`: `zcash_client_backend`'s build script
regenerates its own `src/proto/*.rs` into the fork's working tree whenever protoc is on PATH, so
after a build run `git -C librustzcash6 checkout zcash_client_backend/src/proto` (finding below).

## Run

```
x402-light serve --data ~/.x402-light --lwd 127.0.0.1:9067 --params ~/.zcash-params --network mainnet --listen 127.0.0.1:0
# prints: listening 127.0.0.1:PORT
x402-light once  --data ~/.x402-light --lwd 127.0.0.1:9067 --network regtest status
```

- `--lwd`: `grpc://h:p` (plaintext), `grpcs://h:p` (TLS, system roots), or `h:p` (TLS unless
  loopback), as the SDK's `--lwd` (README "Light agents").
- `--network mainnet|testnet|regtest`; `--upgrades "canopy=1,nu5=none"` sets regtest activation
  heights (default: every upgrade through Canopy at height 1, the devnet's). `sync` and `build`
  refuse to run when these disagree with the server's branch id.
- `--params`: the Sapling proving parameters, `sapling-spend.params` (~48 MB) and
  `sapling-output.params` (~3.5 MB). ycashd 4.5.0's `fetch-params.sh` puts them in
  `~/.zcash-params` (Linux) or `~/Library/Application Support/ZcashParams` (macOS); ycashd 6.21.0
  bundles them in the binary and does not write them, so point `--params` at any copy (a 4.5.0
  install, or download them: the files are the Zcash Sapling MPC output, sha256
  `8e48ffd23abb3a5fd9c5589204f32d9c31285a04b78096ba40a79b75677efc13` / `2f0ebbcbb9bb0bcffe95a397e7eba89c29eb4dde6191c339db88570e3f3fb0e4`).
  Only `build`/`send` need them; `serve` starts without them.
- Environment: `X402_LIGHT_DATA`, `X402_LIGHT_LWD`, `X402_LIGHT_PARAMS`, `X402_LIGHT_NETWORK`,
  `X402_LIGHT_UPGRADES`.

`serve` syncs in the background every `--sync-every` seconds (15). All methods, params and error
codes are in [`schema.json`](schema.json); `once METHOD 'PARAMS_JSON'` runs any of them:

| method | what |
|---|---|
| `import_key` | `{key, birthday}`: `secret-extended-key-…` (`z_exportkey`) or a BIP-39 phrase (ZIP-32 m/32'/347'/0'); birthday defaults to the tip |
| `address`, `export_fvk` | the default `ys1…` address and the `zxviews…` key `z_importviewingkey` accepts |
| `sync` | one pass; returns blocks/outputs scanned, notes found, timings |
| `status` | node and cache heights, synced flag, balance by confirmations, the 0-conf mempool view |
| `list_notes` | spendable notes at `minConfirmations` |
| `build` | `{to, amountZat, memoHex|memo, fee?, minConfirmations}` → `{txHex, txid, feeZat, branchId, expiryHeight}`, **not broadcast** |
| `broadcast` | `{txHex}` through lightwalletd `SendTransaction` |
| `send` | build + broadcast |

The key file: `<data>/spending.key` (bech32, mode 0600), written by `import_key`. The data
directory also holds `wallet.sqlite` and `cache/`.

## How sync works, and why

lightwalletd-dd is the zcash/lightwalletd **0.4.6** lineage (yodl fork + Yellowback). Its wire
format predates two things `zcash_client_backend` 0.22's `sync::run` relies on, so this crate has
its own loop (`src/sync.rs`), shaped after hhanh00's zcash-sync (YWallet's Ycash wallet):

1. **Overlapped download and scan.** `GetBlockRange` is streamed by a producer task into a
   bounded channel of chunks cut by Sapling *output* count (1000; Ycash blocks average 0.14
   outputs) with a block cap (2000, `sync.batchSize`), and each chunk is scanned while the next
   downloads.
2. **Checkpoints from `GetTreeState`.** The account is registered with the tree state at
   birthday − 1 and nothing before the birthday is scanned. Each range starts from one
   `GetTreeState` call; the next chunk's checkpoint is computed locally from the frontier plus the
   chunk's note commitments. There is **no `GetSubtreeRoots` on Ycash** (`z_getsubtreesbyindex`
   is absent on 4.5.0), so the shard tree is frontier-only, fed by scanned blocks. Consequence:
   **no spend before the wallet is fully synced from its birthday**; a partial scan has no
   witnesses.
3. **Reorg by checkpoint.** Each chunk's first `prev_hash` is checked against the wallet's hash
   for the block before it (and the scanner re-checks every block); a mismatch rewinds the wallet
   ten blocks and resumes from the suggested ranges.

`CompactBlock.chainMetadata` (the Sapling tree size after each block) is absent from 0.4.6, and
the scanner needs it to place notes and derive nullifiers: `sync.rs` computes it from the
checkpoint plus each block's outputs and attaches it before caching, which is what a newer
lightwalletd sends. Compact blocks are cached in `cache/` only for the duration of a chunk.

**Branch id.** `GetLightdInfo.consensusBranchId` is the chaintip's (X-F71), wrong on the block
before an upgrade. `build` asks `YellowbackStreamer.GetChainInfo` (lightwalletd-dd 0b3448e+) for
`nextBlockBranchId` and refuses to build unless the wallet's parameters produce that id for the
next block, falling back to the chaintip id when the server answers UNIMPLEMENTED; the result
says which (`branchIdSource`). The transaction is v4 (ZIP-243, Canopy `19bd2d2f` on both lines
today), fee ZIP-317 conventional (10000 zat for a one-in two-out spend) unless `fee` is given.

**Not broadcasting is a wallet state.** `build` records the transaction in the store and marks
its inputs spent; if it is never broadcast they unlock when `expiryHeight` (target + 40) passes.

## Regtest proof

`scripts/regtest.sh {dd|6} <seed>` brings up a devnet of that line (`scripts/devnet.sh` of this
repo), builds lightwalletd-dd at its branch head and starts it with `--yellowback` on
`9067+seed`, runs `cargo test --release -- --ignored` (`tests/regtest.rs`) and tears down. The
test imports a fresh key, funds it t→z from node 0, syncs, builds a 0.5 YEC payment with a memo
to a merchant `yregtestsapling1…`, checks the branch id against
`getblockchaininfo.consensus.nextblock`, broadcasts via lightwalletd, sees it 0-conf in the
mempool view, mines, confirms with `z_listreceivedbyaddress` (amount + memo), syncs again, sends a
second payment with a fixed 5000-zat fee, and times a 22-block catch-up. Timings land in
`$X402_SCRATCH/lightcore-<line>.json`. Results and findings: see the x402 plan (chunk `lightcore`).

Both Ycash networks' parameters are available in librustzcash6: mainnet (`ys`, coin type 347,
Ycash fork 570 000, Canopy latest) and testnet (`ytestsapling`, fork 510 248); regtest is
`LocalNetwork` with the heights above.
