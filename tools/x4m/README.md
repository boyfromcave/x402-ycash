# tools/x4m: the X4-M measurement tools

These tools produced sections (d)–(f) of `docs/x4m-measurements.md`. None of them is part of the SDK,
and none touches `packages/`.

| Tool | What it measures |
|---|---|
| `sync_cost.py` | Agent full-node sync cost on a `scripts/devnet.sh` devnet. It extends the chain at a mainnet-like Sapling density, syncs fresh nodes from genesis (an agent wallet, and `-disablewallet` for comparison), reads per-block connect times from `debug.log`, and times restart → first z→z payment, at the tip and after a stretch offline |
| `viewkey_split.py` | The viewing-key split. It derives diversified addresses offline from an exported viewing key (`rust` `divaddr`), pays them, and checks what a viewing-key-only node and the spending-key wallet see and can spend |
| `mainnet_block_sizes.py` | A stratified sample of mainnet block sizes from `explorer.ycash.xyz`, used to estimate the chain size |
| `lwdprobe/` (Go) | A read-only lightwalletd client. `info`; `tree <h>` gives the Sapling tree size, which is the count of Sapling outputs up to `h`; `range <a> <b> [dump]` gives compact-block bytes, outputs and spends, and can dump the compact outputs |
| `rust/` | `trialdec` runs Sapling compact trial decryption over a `lwdprobe` dump: one core, batched, and all cores. It also times commitment-tree appends, and lists the outputs a key owns. `divaddr` derives diversified addresses from a `zxview…` key, offline |
| `rpc.py` | A minimal JSON-RPC client for `devnet.json`. It sends UTF-8 basic auth, because the devnet's credentials contain emoji |
| `results/` | The raw outputs behind the numbers in the doc |

## Build

```sh
# Rust (sapling-crypto 0.7, the version librustzcash6 pins)
cargo build --release --manifest-path tools/x4m/rust/Cargo.toml

# Go: builds against lightwalletd-dd's walletrpc through the go.mod replace
# (../../../../lightwalletd-dd, the path from the x402-ycash main tree; from a wt/ worktree use
# `go mod edit -replace github.com/zcash/lightwalletd=<abs path to lightwalletd-dd>` first).
cd tools/x4m/lwdprobe && go build -o <scratch>/lwdprobe .

# lightwalletd itself, outside its repository tree:
(cd lightwalletd-dd && go build -mod=vendor -o <scratch>/lightwalletd .)
```

## Run

The Python tools need the workspace venv, and they must be run from this directory, because
`viewkey_split.py` imports `sync_cost.py` and `rpc.py`.

```sh
X402_SCRATCH=<scratch> scripts/devnet.sh up dd 201     # or: up 6 203
cd tools/x4m
python sync_cost.py --devnet <scratch>/dd-201/devnet.json --line dd --work <scratch>/sync-dd \
  --p2p 13470 --rpcport 18470            # defaults: 2000 plain blocks, 20 × 50-output t→z, 200 offline
python viewkey_split.py --devnet <scratch>/dd-201/devnet.json --line dd --divaddr rust/target/release/divaddr

# a devnet lightwalletd, using node 0's RPC credentials from devnet.json
<scratch>/lightwalletd --rpcuser U --rpcpassword P --rpchost 127.0.0.1 --rpcport <node0 rpc> \
  --no-tls-very-insecure --grpc-bind-addr 127.0.0.1:19201 --http-bind-addr 127.0.0.1:21201 \
  --data-dir <scratch>/lwd/data --log-file <scratch>/lwd/lightwalletd.log
lwdprobe -addr 127.0.0.1:19201 range 1 <tip> all.bin
trialdec all.bin <zxview… key from z_exportviewingkey> 3    # HIT lines = the key's notes

# mainnet, read-only
lwdprobe -addr lite.ycash.xyz:9067 -tls tree 3053679
lwdprobe -addr lite.ycash.xyz:9067 -tls range 2633199 3053679 year.bin
trialdec year.bin random 5
python mainnet_block_sizes.py 3053679 300 sample.json
```

`sync_cost.py` stops the nodes it starts, even when a run fails. Bring the devnet down afterwards
with `scripts/devnet.sh down <line> <seed>`.
