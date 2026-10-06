# x402-ycash-light: a Sapling light client for agents on Ycash

An agent that pays in shielded YEC (x402 `sapling-proof`, plan §5.10 tier P1/P2) needs a synced
Sapling wallet. Until now that meant a node wallet: YEW's core is transparent-only and no Sapling
light client existed for Ycash (X4-M, `docs/x4m-measurements.md`). This crate is one. It talks to
lightwalletd-dd, keeps its notes in a `zcash_client_sqlite` database, and builds, proves and signs
a shielded payment with a memo **without broadcasting it** (the X4b building block), or broadcasts
it through lightwalletd.

It is a library (`x402_ycash_light`: `net`, `keys`, `lwd`, `sync`, `spend`, `wallet`; the spending key is
injected) plus a thin binary, `x402-light`, that adds a loopback JSON-RPC 2.0 server, a `once` CLI
and the key file. YEW's Rust core is meant to depend on the library.

## Build

```
cd light
cargo build --release          # needs protoc (brew install protobuf / apt install protobuf-compiler)
cargo test                     # unit tests; no proving parameters needed
```

**Pinning.** The `zcash_*` crates come from `librustzcash6` as **git dependencies** on
`https://github.com/boyfromcave/librustzcash6.git` rev `4867cf85` (branch `upgrade/vault`):
miodragpop/librustzcash @ `ec525fae` (the revision `ref/ycash6/Cargo.toml:122-133` pins for ycashd
6.21.0) plus the Vault network upgrade (`NetworkUpgrade::Vault`, `BranchId::Vault` = `0x6d5b7a31`),
the same revision ycashd's upgrade/vault `Cargo.toml` `[patch.crates-io]` pins:
`zcash_client_backend` 0.22, `zcash_client_sqlite` 0.20.2, `zcash_primitives` 0.28,
`zcash_proofs` 0.28, `zcash_keys` 0.14, `zcash_protocol` 0.9, `zip321` 0.8, `sapling-crypto` 0.7.
A `[patch.crates-io]` block mirrors ycashd's so every transitive copy is the same source. Moving
the pin means changing the rev in both the dependencies and the patch block.

`zcash_client_backend`'s build script regenerates its own `src/proto/*.rs` whenever protoc is on
PATH; with git dependencies that lands in cargo's checkout cache (`~/.cargo/git/checkouts`), not
in a librustzcash6 working tree.

## Run

```
x402-light serve --data ~/.x402-light --lwd 127.0.0.1:9067 --params ~/.zcash-params --network mainnet --listen 127.0.0.1:0
# prints: listening 127.0.0.1:PORT
x402-light once  --data ~/.x402-light --lwd 127.0.0.1:9067 --network regtest status
```

- `--lwd`: `grpc://h:p` (plaintext), `grpcs://h:p` (TLS), or `h:p` (TLS unless loopback), as
  the SDK's `--lwd` (README "Light agents").
- `--tls-roots native|webpki`: the root store TLS trusts. `native` is the platform's
  (`rustls-native-certs`), `webpki` the Mozilla bundle compiled in (`webpki-roots`). Default:
  `webpki` on iOS and Android, `native` elsewhere. Both stores are always compiled in.
- `--network mainnet|testnet|regtest`; `--upgrades "canopy=1,nu5=none"` sets regtest activation
  heights (default: every upgrade through Canopy at height 1, the devnet's). The Vault upgrade
  (branch `6d5b7a31`, after Canopy; no mainnet or testnet height yet) is `vault=<h>`, the mirror of
  the node's `-nuparams=6d5b7a31:<h>` (the upgrade/vault devnet's is 103). `sync` and `build`
  refuse to run when these disagree with the server's branch id.
- `--params`: the Sapling proving parameters, `sapling-spend.params` (~48 MB) and
  `sapling-output.params` (~3.5 MB). ycashd 4.5.0's `fetch-params.sh` puts them in
  `~/.zcash-params` (Linux) or `~/Library/Application Support/ZcashParams` (macOS); ycashd 6.21.0
  bundles them in the binary and does not write them, so point `--params` at any copy (a 4.5.0
  install, or download them: the files are the Zcash Sapling MPC output, sha256
  `8e48ffd23abb3a5fd9c5589204f32d9c31285a04b78096ba40a79b75677efc13` / `2f0ebbcbb9bb0bcffe95a397e7eba89c29eb4dde6191c339db88570e3f3fb0e4`).
  Only `build`/`send` need them; `serve` starts without them.
- Environment: `X402_LIGHT_DATA`, `X402_LIGHT_LWD`, `X402_LIGHT_PARAMS`, `X402_LIGHT_NETWORK`,
  `X402_LIGHT_UPGRADES`, `X402_LIGHT_TLS_ROOTS`, `X402_LIGHT_MAX_EXPIRY_WINDOW`.
- `--max-expiry-window N` (default 1152, about a day): the most blocks a built transaction's
  `nExpiryHeight` may sit above target + 3. An unbroadcast or unmined transaction holds its notes
  until it expires, so a far expiry is refused.

`serve` syncs in the background every `--sync-every` seconds (15). All methods, params and error
codes are in [`schema.json`](schema.json); `once METHOD 'PARAMS_JSON'` runs any of them:

| method | what |
|---|---|
| `import_key` | `{key, birthday}`: `secret-extended-key-…` (`z_exportkey`) or a BIP-39 phrase (ZIP-32 m/32'/347'/0'); birthday defaults to the tip |
| `address`, `export_fvk` | the default `ys1…` address and the `zxviews…` key `z_importviewingkey` accepts |
| `sync` | one pass; returns blocks/outputs scanned, notes found, timings |
| `status` | node and cache heights, synced flag, balance by confirmations, the 0-conf mempool view |
| `list_notes` | spendable notes at `minConfirmations` |
| `build` | `{to, amountZat, memoHex|memo, expiryHeight?, maxTimeoutSeconds?, fee?, minConfirmations}` → `{txHex, txid, feeZat, branchId, expiryHeight}`, **not broadcast**; exactly the SDK's builder contract (`packages/ycash/src/shielded/builder.ts`: `amountZat` a decimal string, `expiryHeight` the spec's tip + 3 + ⌈maxTimeoutSeconds/75⌉). With `maxTimeoutSeconds` the expiry must lie in the spec's window (rule 8) and defaults to the client's value |
| `broadcast` | `{txHex}` through lightwalletd `SendTransaction` |
| `send` | build + broadcast; the agent's `sapling-proof` payment (`LightClientShieldedPayer` in the SDK) |

The key file: `<data>/spending.key` (bech32, mode 0600), written by `import_key`. The data
directory also holds `wallet.sqlite`, `cache/` and `wallet.lock`: an open wallet holds an advisory
exclusive lock on it (released by the OS when the process exits), so a `once` against the data
directory of a running `serve` fails at once ("another process holds the wallet") instead of
selecting the same notes. Use the server's `build`/`send` instead.

## Embedding: bring your own channel

A host with its own TLS policy (YEW pins the server's certificate, and iOS has no native root
store) builds the `tonic::transport::Channel` itself and injects it. Every lightwalletd call of the
wallet then goes over that channel: sync (`GetBlockRange`, `GetLatestBlock`, `GetLightdInfo`),
`GetTreeState`, `GetChainInfo`, `GetMempoolTx` and `SendTransaction`; `lwd` is not dialed and is
only the label `status` reports. `Wallet::channel()` hands the channel back for the host's own
calls (e.g. `GetTransaction`).

```rust
use x402_ycash_light::{Options, Wallet};
let channel = Endpoint::from_shared("https://lwd.example:9067")?
    .tls_config(ClientTlsConfig::new().ca_certificate(Certificate::from_pem(pin)))?
    .timeout(Duration::from_secs(600))     // a long GetBlockRange stream runs under it
    .connect_lazy();
let wallet = Wallet::open(Options {
    channel: Some(channel),
    spending_key: Some(extsk),
    ..Options::new(data_dir, "lwd.example:9067", network)
}).await?;
```

The channel type is tonic 0.14's; the crate links `tls-ring`, `tls-native-roots` and
`tls-webpki-roots`, the same features YEW's `tonic =0.14.6` enables, so one tonic is in the graph.
Without a channel, `Options::tls_roots` (`lwd::TlsRoots::{Native, Webpki}`, default per target as
above) picks the root store for the URL path; `lwd::endpoint(addr, roots)` returns that endpoint
unconnected for a host that only wants to adjust it.

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
   ten blocks (to the latest store checkpoint at or below that height) and rescans the new branch
   in the same pass.

**Reorgs near the birthday (YEW Z-9).** `zcash_client_sqlite` can only truncate to a checkpoint
among the blocks it has scanned, and it checkpoints only blocks that hold a note commitment. So it
refuses the ten-block rewind (`RequestedRewindInvalid`) whenever no such block lies between the
birthday and the rewind height: every reorg within ten blocks of the birthday, which is a new or
freshly restored wallet's first blocks, and any reorg on a stretch of chain with no Sapling output
since the birthday. Before the fix that refusal ended the sync, and every later sync hit it again.
Now `sync` answers it by rewinding to the block before the birthday with the chain state the server
reports for it now (`GetTreeState`, so a branch that replaced the birthday block is handled too),
and rescans from the birthday. When the branch also replaced Sapling outputs *below* the birthday,
the frontier saved at import conflicts with the server's; the store's tree is then truncated, in
one transaction, to the frontier 100 blocks further down (deeper than either node line reorgs,
`MAX_REORG_LENGTH` = 99), which both chains share. The rescan costs at most the blocks since the
birthday, it happens at most three times per sync (`MAX_BIRTHDAY_REWINDS`; a fourth refusal is
returned as the error), and the report counts it in `birthdayRewinds` as well as `reorgs`. Notes,
memos and sent transactions survive a rewind; their mined heights are cleared and set again by the
rescan. Unit tests: `src/sync.rs` (a forkable fake lightwalletd); devnet:
`reorg_near_the_birthday_syncs_through` in `tests/regtest.rs`, on both node lines.

`CompactBlock.chainMetadata` (the Sapling tree size after each block) is absent from 0.4.6, and
the scanner needs it to place notes and derive nullifiers: `sync.rs` computes it from the
checkpoint plus each block's outputs and attaches it before caching, which is what a newer
lightwalletd sends. Compact blocks are cached in `cache/` only for the duration of a chunk.

**Branch id.** `GetLightdInfo.consensusBranchId` is the chaintip's (X-F71), wrong on the block
before an upgrade. `build` asks `YellowbackStreamer.GetChainInfo` (lightwalletd-dd 0b3448e+) for
`nextBlockBranchId` and refuses to build unless the wallet's parameters produce that id for the
next block, falling back to the chaintip id when the server answers UNIMPLEMENTED; the result
says which (`branchIdSource`). The transaction is v4 (ZIP-243, Canopy `19bd2d2f` on both lines
today; Vault `6d5b7a31` past that upgrade, which stays v4 since Ycash activates it without NU5), fee ZIP-317 conventional (10000 zat for a one-in two-out spend) unless `fee` is given; a fee
below the x402 floor max(1000, 500 · max(2, logical actions)) is refused.

**Expiry.** `zcash_client_backend::create_proposed_transactions` fixes `nExpiryHeight` at target + 40
with no setter, and an x402 `sapling` payment must carry tip + 3 + ⌈maxTimeoutSeconds/75⌉ (the
facilitator refuses anything outside its window). So librustzcash only *proposes* (note selection,
fee, change) and `src/spend.rs` assembles the transaction: the Sapling bundle with `sapling-crypto`'s
builder from the proposal's notes and witnesses, the proofs, the ZIP-243 sighash over
`TransactionData` with the requested expiry, the signatures (the steps of `zcash_primitives`
`Builder::build_internal`, Sapling-only). The built transaction is then recorded with
`decrypt_and_store_transaction`, which marks its notes spent and recovers payment and change through
the OVKs. No librustzcash change was needed.

The expiry is bounded on both sides: at least target + 3 (the relay floor), at most target + 3 +
`max_expiry_window` (1152), below the next network upgrade, and, when the caller passes the
requirement's `maxTimeoutSeconds`, inside the spec's window (`specs/scheme_exact_ycash.md` rule 8:
tip + 4 ≤ e ≤ tip + 4 + ⌈t/75⌉ + 1), which is what the facilitator checks.

**Built at the server's tip.** `build` takes the target height, branch id and expiry from the
server's next block, so it needs the wallet's scanned tip to equal the server's (the
`GetChainInfo` height, else `GetLightdInfo`'s). If it does not, `build` runs one sync pass and asks
again; still behind or ahead, it refuses with -32001 (`NotAtServerTip`). lightwalletd's
compact-block cache trails the node by its ingestor's poll, so right after a block a retry may be
needed.

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

The second test, `reorg_near_the_birthday_syncs_through` (chunk `lightrewind`), imports a key born
at the tip and receives 1.5 YEC a few blocks above it. R1 invalidates the receipt's block on every
node, syncs while the chain stands below it, re-mines the receipt in a competing block at the same
height and syncs through (one reorg, one birthday rewind, balance unchanged, the note at its
height). R2 receives 0.25 YEC more, then replaces the chain from the birthday block itself with a
longer branch carrying both receipts, syncs through again, and spends 0.5 YEC from the rescanned
notes to prove the witnesses. Its record lands in `$X402_SCRATCH/lightrewind-<line>.json`. The
tests run one at a time (they share node 0's wallet); `X402_LIGHT_TEST=<name>` runs one.

Both Ycash networks' parameters are available in librustzcash6: mainnet (`ys`, coin type 347,
Ycash fork 570 000, Canopy latest) and testnet (`ytestsapling`, fork 510 248); regtest is
`LocalNetwork` with the heights above.
