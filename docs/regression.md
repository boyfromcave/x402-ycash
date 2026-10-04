# Regression of record

Every devnet suite on both node lines, run one devnet at a time on 2026-10-03/04. Each line is a
fresh light five-node devnet (`scripts/devnet.sh up <line> <seed>`: node 0 funded wallet with
`-yellowback`, node 1 stock, nodes 2-4 pools), with the suites run in the order below against the
same devnet.

## What was tested

| | |
|---|---|
| x402-ycash | `main` at `add0578`, plus `c87bdf6` (the one regression fixed, below). Rerun at `47db56e` (comment, test-title and record-label changes only) for the six package suites: same counts on both lines |
| v4.5.0 line | `ycash-dd/src/ycashd`: `Ycash Daemon version v4.5.0-cdfc4945f-dirty`; devnet seed 301 |
| 6.21.0 line | `ycash6/src/ycashd`: `Ycash Daemon version v6.21.0-rc1-94bafa4fd-dirty`; devnet seed 303 |
| lightwalletd | `wt/lightwalletd-dd-bin/lightwalletd` (lightwalletd-dd), `--yellowback`, on node 0 at port 34301 (dd) and 34303 (6) |
| toolchain | node 23.3.0, Python 3.11.15 (`python/.venv`), vitest 3.2.7 |

Commands, from the worktree, with `X402_SCRATCH` set and `X402_DEVNET_JSON` pointing at the line's
`devnet.json`:

```bash
npm run test:devnet -w x402-ycash-mechanism -- <suite>        # node, assumptions, exact_yec, channel_yec, shielded, yed
X402_X4M=1 npm run test:devnet -w x402-ycash-mechanism -- x4m
yellowback-devnet lightwalletd start --port 343xx --bin <lightwalletd> --extra=--yellowback
X402_LWD_URL=127.0.0.1:343xx npm run test:devnet:http          # http, yed.http, lwd.http, viewkey.http
python/.venv/bin/python -m pytest python/tests/devnet          # test_interop, test_parity
```

## Results

Durations are wall time for the whole command (vitest start-up and the suite's own setup included).

| Suite | Tests | v4.5.0 (ycash-dd) | 6.21.0 (ycash6) |
|---|---|---|---|
| `node` | 8 | pass, 7 s | pass, 14 s |
| `assumptions` | 7 | pass, 15 s | pass, 30 s |
| `exact_yec` | 16 | pass, 36 s | pass, 83 s |
| `channel_yec` | 7 | pass, 24 s | pass, 53 s |
| `shielded` | 6 | pass, 27 s | pass, 45 s |
| `yed` | 9 | pass, 21 s | pass, 49 s |
| `x4m` (`X402_X4M=1`) | 2 | pass, 75 s | pass, 82 s |
| `test:devnet:http`, all four files | 21 | pass, 108 s | pass, 205 s |
| &nbsp;&nbsp;`http.http` | 6 | pass, 28.5 s | pass, 58.0 s |
| &nbsp;&nbsp;`yed.http` | 6 | pass, 25.3 s | pass, 48.1 s |
| &nbsp;&nbsp;`lwd.http` (lightwalletd) | 5 | pass, 31.7 s | pass, 55.3 s |
| &nbsp;&nbsp;`viewkey.http` | 4 | pass, 19.7 s | pass, 40.9 s |
| Python `python/tests/devnet` | 8 | **fail 1 of 8** at `add0578` (35 s); pass at `c87bdf6`, 26 s | pass, 53 s |
| **Total** | **84** | **84 pass** | **84 pass** |

The rerun at `47db56e` (six package suites): v4.5.0 9/16/39/31/31/23 s, 6.21.0 15/37/92/56/51/57 s
(node, assumptions, exact_yec, channel_yec, shielded, yed), all counts as above.

6.21.0 takes about twice as long throughout: its Sapling proving and block assembly are slower on
this machine, not a behaviour difference.

## The one failure: the YED mint helpers did not survive the low-participation halt

At `add0578` the Python suite's last test (`test_ts_batch_client_yed_channel_20_one_cent_requests`)
failed on the v4.5.0 devnet in `ensure_yed`: `yed_mint` refused with `mintpol-participation:
minting is halted while miner participation is low (ACT-4)` (`ycash-dd/src/yellowback/txbuilder.cpp:812`).
Cause: the suites before it mine most of their blocks on node 1, the stock seat, whose blocks do not
participate; after a few hundred of them the overlay halts minting until pool blocks restore
participation (eight pool blocks did, checked by hand). The helper retried only the empty price
window (`mintpol-no-price`), so it gave up. It passes on a fresh devnet, which is why each suite was
green in its own chunk: an order dependency in the harness, not a defect in the mechanism or the node.

Fixed in `c87bdf6`: the four mint helpers (`packages/ycash/test/devnet/yed.devnet.test.ts`,
`examples/merchant-express/test/devnet/{yed,lwd}.http.devnet.test.ts`, `python/tests/devnet/test_parity.py`)
mine on a pool and retry on `participation` as they already did on `price`. The Python suite then
passed on v4.5.0 and, in the same suite order, on 6.21.0.

## Notes

- The OP-3 case (one payment mined through the yolo stratum pool) ran on both lines (2 stratum
  blocks each). In `yed`'s burning-voucher test the strict pool's template left the voucher out
  (`strictPoolTemplate: "skipped"`) and only stock node 1 mined it, on both lines, as intended.
- `yellowback-devnet down` reports "5 node process(es) did not stop over RPC and were terminated"
  on both lines; the devnet CLI handles it, and no process was left behind.
- No flaky test besides the order dependency above: every other suite passed first time on both lines.
