# Regression of record

## 2026-11-16: beta3 (rpcversion 10), both C++ lines

Every suite against the beta3 release candidates of both C++ lines, one devnet at a time, on the vault-upgrade
devnet (`scripts/devnet.sh up <line> <seed>`, upgrade `6d5b7a31` active, Falcon active):

| | |
|---|---|
| x402-ycash | `upgrade/vault` at `4681d1b` plus the two test fixes below (branch `up/b3-compat`) |
| 6.22 line | ycash6 `up/b3-cut` at `611469fd2`: `Ycash Daemon version v6.22.0-beta3-611469fd2`, `rpcversion` 10; seed 587 |
| v4.5.0 line | ycash-dd `up/b3-cut` at `7084dbabf`: `v4.5.0-7084dbabf`, `rpcversion` 10; seed 589 |
| lightwalletd | lightwalletd-dd `up/b3-clients-final` at `345da1e` (accepts `rpcversion` 9 and 10), `--yellowback` |
| toolchain | node 23.3.0, vitest 3.2.7, Python 3.13.2 (the workspace `.venv`), x402-light `cargo build --release` |

| Suite | Tests | ycash6 beta3 | ycash-dd beta3 |
|---|---|---|---|
| unit, `npm test` (all workspaces) | 958 | pass (no node) | |
| unit, `pytest python/tests/unit` | 600 | pass (no node) | |
| package devnet, `npm run test:devnet` with `X402_X4M=1` | 74 | 59 pass, 15 skipped (`yed_pq` rerun after its fix) | 59 pass, 15 skipped |
| `test:devnet:http`, all six files (lightwalletd and x402-light set) | 30 | 30 pass (`lwd`, `light` rerun after the fixes below) | 30 pass, first time |
| Python `python/tests/devnet` | 8 | pass | pass |

The 15 skipped are by design: `yed_falcon` (9) runs only when the Falcon height is at least 60 blocks
above the tip (this devnet activates Falcon), `kogany` (5) needs `X402_KOGANY_JSON`
(`scripts/kogany-leg.sh`), and one `yed_pq` case runs only before the Falcon height.

Found and fixed (tests only; no SDK change):

- `yed_pq`'s first case required `rpcversion` to be exactly 9; it now checks at least 9, as the SDKs
  do (`FEES_RPC_VERSION` 8 is the only version the SDKs read). Against a beta3 node it failed with
  `expected 10 to be 9`.
- `light.http` did not tell x402-light the devnet's vault activation height, so its sync stopped at
  the first Vault block (`branch id mismatch … lightwalletd says Vault (6d5b7a31), our parameters say
  Canopy`). It now passes `X402_LIGHT_UPGRADES=vault=<h>` from `getblockchaininfo`. Not a beta3 change:
  every vault-upgrade devnet has it, and the suite had not run on one since this record's 2026-10-04 run.

Not a defect of x402: lightwalletd-dd `upgrade/vault` (`6b7a28f`) accepts exactly `rpcversion` 9, so
against a beta3 node its Yellowback service does not start and `lwd.http`'s YED case fails (the light
agent cannot read the Falcon height). With lightwalletd-dd `up/b3-clients-final` it passes.

Not run: `light/scripts/regtest.sh` (its own devnet) and the kogany leg (`scripts/kogany-leg.sh`,
which needs a `koganyd` build).

## 2026-10-04: both lines, before the vault upgrade

Every devnet suite on both node lines, run one devnet at a time on 2026-10-04, now including the
shielded `sapling` suites (`light.http`, `sapling.http`) and the light client's own regtest test.
Each line is a fresh light five-node devnet (`scripts/devnet.sh up <line> <seed>`), with the suites
run in the order below against the same devnet. This record was taken on 2026-10-04, before the
vault upgrade line existed, so its devnets ran without the upgrade (node 0 then started Yellowback
with a node flag). Today `scripts/devnet.sh` needs a node tree built from `upgrade/vault`
(`YCASH_DD` / `YCASH6`) and brings up the vault-upgrade devnet: the upgrade (`6d5b7a31`) active
and the YED attestor set created on every node, node 0 the funded wallet (`-insightexplorer
-txindex`), node 1 without the attestor set, nodes 2-4 pools. The vault-line results are the
transaction vectors in `ycash-dd-vault.json` and the devnet suites' Vault-branch signing; a full
rerun of this record on that line has not been written up here. The light client's regtest test brings up its own devnet
(`light/scripts/regtest.sh`), so it ran after that devnet was down.

### What was tested

| | |
|---|---|
| x402-ycash | `main` at `f0a8815` plus `89d754f` (the one harness fix, below) for the package, HTTP and Python suites; the light client at `main` `d4db4c3` (the spend review merge: `light/` only) for `light/scripts/regtest.sh` and a second `light.http` run with that build. Recorded on branch `x402/final2`. Two later test-only commits there, `40c8dbe` (the harness reads P2P ports lazily) and `ec52b4e` (`exact_yec`'s YED mint retries on an empty price window), ran in the staged package's devnet suites on both lines (`docs/upstream.md`), not in a rerun of this record |
| v4.5.0 line | `ycash-dd/src/ycashd`: `Ycash Daemon version v4.5.0-cdfc4945f-dirty`; devnet seed 391 |
| 6.21.0 line | `ycash6/src/ycashd`: `Ycash Daemon version v6.21.0-rc1-94bafa4fd-dirty`; devnet seed 393 |
| lightwalletd | lightwalletd-dd at `0b3448e` (has `YellowbackStreamer.GetChainInfo`), built with `CGO_ENABLED=0 go build -mod=vendor`, run `--yellowback` on node 0 at port 9458 (dd) and 9460 (6) |
| x402-light | `cargo build --release` of `light/`, at `f0a8815` for the HTTP run and at `d4db4c3` for the regtest test and the `light.http` rerun; Sapling parameters from `~/Library/Application Support/ZcashParams` |
| toolchain | node 23.3.0, Python 3.11.15 (`python/.venv`), vitest 3.2.7, cargo (release profile) |

Commands, from the worktree, with `X402_SCRATCH` set and `X402_DEVNET_JSON` pointing at the line's
`devnet.json`:

```bash
npm run test:devnet -w x402-ycash-mechanism -- <suite>        # node, assumptions, exact_yec, channel_yec, shielded, yed
X402_X4M=1 npm run test:devnet -w x402-ycash-mechanism -- x4m
yellowback-devnet lightwalletd start --port 94xx --bin <lightwalletd-dd> --extra=--yellowback
X402_LWD_URL=127.0.0.1:94xx X402_LIGHT_BIN=<x402-light> X402_LIGHT_PARAMS=<params dir> \
  npm run test:devnet:http                                    # http, yed.http, lwd.http, viewkey.http, light.http, sapling.http
python/.venv/bin/python -m pytest python/tests/devnet          # test_interop, test_parity
X402_LIGHT_LWD_BIN=<lightwalletd-dd> X402_LIGHT_PARAMS=<params dir> light/scripts/regtest.sh <line> <seed>
```

### Results

Durations are wall time for the whole command (vitest start-up and the suite's own setup
included); the HTTP files are vitest's per-file times inside the one `test:devnet:http` command.

| Suite | Tests | v4.5.0 (ycash-dd) | 6.21.0 (ycash6) |
|---|---|---|---|
| `node` | 8 | pass, 12 s | pass, 17 s |
| `assumptions` | 7 | pass, 17 s | pass, 27 s |
| `exact_yec` | 16 | pass, 44 s | pass, 82 s |
| `channel_yec` | 7 | pass, 33 s | pass, 53 s |
| `shielded` | 6 | pass, 30 s | pass, 43 s |
| `yed` | 9 | pass, 25 s | pass, 42 s |
| `x4m` (`X402_X4M=1`) | 2 | pass, 134 s | pass, 104 s |
| `test:devnet:http`, all six files | 30 | pass, 256 s | pass, 270 s |
| &nbsp;&nbsp;`http.http` | 6 | pass, 48.0 s | pass, 58.0 s |
| &nbsp;&nbsp;`yed.http` | 6 | pass, 38.4 s | pass, 43.3 s |
| &nbsp;&nbsp;`lwd.http` (lightwalletd) | 5 | pass, 44.3 s | pass, 50.1 s |
| &nbsp;&nbsp;`viewkey.http` | 4 | pass, 39.5 s | pass, 39.5 s |
| &nbsp;&nbsp;`light.http` (private agent: x402-light + lightwalletd-dd, `sapling` and `sapling-proof`) | 5 | pass, 36.5 s | pass, 40.5 s |
| &nbsp;&nbsp;`sapling.http` (`sapling` on node-built transactions) | 4 | pass, 41.7 s | pass, 31.7 s |
| Python `python/tests/devnet` | 8 | pass, 45 s | pass, 66 s |
| `light/scripts/regtest.sh` (`pays_a_merchant_through_lightwalletd`) | 1 | pass, test 46.9 s (278 s with devnet up and build) | pass, test 90.1 s (523 s) |
| **Total** | **94** | **94 pass** | **94 pass** |

`light.http` again with the `d4db4c3` build of x402-light, on the devnet the regtest test left
running (`KEEP=1`): 5/5 on both lines, 38 s (dd) and 42 s (6). The first `light/scripts/regtest.sh`
on v4.5.0 at `f0a8815` also passed (306 s wall); the table has the `d4db4c3` run.

The 6.21.0 line still takes longer for most suites (its Sapling proving and block assembly are
slower on this machine). Other agents' devnets (two eight-node yew-core devnets and a ycash6 one)
ran on the machine throughout, so durations are looser than in the previous record.

### The one failure: v4.5.0 drops peers that relay expired transactions, and the mesh split

The first full run on v4.5.0 (seed 371) passed every package suite and four of the six HTTP files,
then failed `sapling.http`'s last test and all of `viewkey.http` with `timed out waiting for
mempools to agree` (in the harness's `mine`). The devnet's five nodes had split into two islands,
{0, 1, 4} and {2, 3}: nodes 2 and 3 were not seeing the transactions the others relayed.

Cause: ycash-dd's `ContextualCheckTransaction` scores 10 against a peer that relays a transaction
already expired by two blocks (`ycash-dd/src/main.cpp:876-883`), and 4.5.0 disconnects a peer at
100 (it only declines to *ban* a local one). The suites mine many blocks a second past short
expiries, so relays of expired transactions are routine: 177 rejections over that run (the first
during the `shielded` suite), and the previous record's v4.5.0 devnet shows the same (122
rejections, 5 disconnects). The devnet connects its nodes once (`addnode … onetry`), so dropped
links never come back. With the two new HTTP suites the run is long enough for enough links to go
that the mesh splits. 6.21.0 logs none of these rejections.

Fixed in the harness (`89d754f`, `packages/ycash/test/devnet/harness.ts`): when the mempools still
disagree after 5 s, `syncMempools` re-adds every peer (`addnode <p2p port> onetry`, ports from the
devnet's `node<i>/ycash.conf`) and hands each node the mempool transactions it lacks
(`sendrawtransaction`; a refusal stays the node's), once per call. On the damaged devnet the two
failed files then passed (8/8); on a fresh devnet the whole order passed (the table above), with
disconnects on nodes 1-3 again. Not a defect in the mechanism or the node: a node relaying
expired transactions to its peers is ordinary on a regtest that mines this fast. The Python
suite's `Devnet.mine` (`python/tests/devnet/test_interop.py`) waits only for the pool and the stock
node and has no such heal; it passed, running last.

### A run lost to a port-seed collision

The second v4.5.0 run (seed 371 again) was cut off during `x4m`: the parallel review chunk
(`x402-spendreview`) was also given seed 371, started its devnet on the same ports, and its
cleanup stopped this devnet's nodes (all five logged a clean shutdown at the same second). The
record above uses seeds 391 and 393 instead. Not a test defect; seeds handed to parallel chunks
must differ.

### Notes

- The OP-3 case (one payment mined through the yolo stratum pool) ran on both lines (2 stratum
  blocks each).
- `yellowback-devnet down` reports "5 node process(es) did not stop over RPC and were terminated"
  on both lines, as before; no process was left behind.
- Building `light/` regenerates `librustzcash6/zcash_client_backend/src/proto/*.rs` when protoc is
  on PATH (light/README.md); the fork's working tree was restored after each build.
- No flaky test besides the mesh split above: every other suite passed first time on both lines.
