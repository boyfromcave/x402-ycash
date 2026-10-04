# X4-M measurements and verdict

Plan reference: `docs/plans/x402-agent-payments-plan.md` §5.10 and the X4 checklist, in the Yellowback
workspace. Sections (a) to (f) record measurements and code reading only. The **Verdict** section at
the end is where they are interpreted, and it keeps facts and recommendations apart.

Sections (a) to (c) were taken on 2026-10-03 on an Apple M5 laptop, on two regtest devnets started one after the other:

- v4.5.0: `ycash-dd` at `f78a5f8bb`, port seed 151.
- 6.21.0: `ycash6` at `a862a8a06`, port seed 153.

Both used `scripts/devnet.sh up {dd|6} <seed>`, the light five-node form. Canopy is active from height 1.

To reproduce (raw `FINDING` lines go to stdout):

```
X402_X4M=1 X402_DEVNET_JSON=<dir>/devnet.json npx vitest run test/devnet/x4m.devnet.test.ts \
  --no-file-parallelism --testTimeout=1500000
```

The suite is `packages/ycash/test/devnet/x4m.devnet.test.ts`.

## (a) Merchant wallet scan cost

**Question.** How long does a node take to connect N blocks holding M Sapling outputs it cannot
decrypt? How does that change when its wallet holds Sapling keys?

**Method.**

- The measured node is devnet node 1, a stock `ycashd` with a wallet that starts with no Sapling key.
- The pool's wallet (node 2) builds the blocks:
  - a **shielded segment** of 5 blocks, each holding one t→z transaction with 50 Sapling outputs to
    the pool's own diversified addresses, so 250 outputs node 1 cannot decrypt;
  - then a **control segment** of 5 blocks, each holding one small transparent transaction. The last
    control block also carries a marker transaction paying node 1's wallet.
- One measurement goes like this:
  1. `invalidateblock <first block>` on node 1.
  2. Wait until the wallet has processed the disconnect, that is, until the marker's
     `gettransaction.confirmations` is 0 or less.
  3. Call `reconsiderblock`.
  4. Stop the clock when the wallet reports the marker in its original block
     (`gettransaction.blockhash`), polling every 5 ms.
- The time therefore covers block connection, including Sapling proof verification, plus the
  wallet's chain-tip processing. On both lines the wallet does that processing in
  `ThreadNotifyWallets`, which polls every 50 ms (`src/validationinterface.cpp`, `MilliSleep(50)`).
  `-debug=bench` does not time it: bench's "Connect block" lines stop before the wallet is notified.
- Two reconnects are timed:
  - **S+C**: from the first shielded block, so 10 blocks are reconnected.
  - **C**: from the first control block, so 5 blocks.
- **S+C − C** estimates the cost of the 250 shielded outputs. Each value below is the median of 3
  runs, in milliseconds. `rpc` is the time until `reconsiderblock` returned.
- The four wallet states are measured in this order, all on the same node:
  - no Sapling key;
  - 1 key (`z_getnewaddress sapling`);
  - that key plus 50 diversified addresses (`z_getnewdiversifiedaddress`);
  - 10 keys (9 more `z_getnewaddress`).

  The `z_listaddresses` count column counts diversified addresses too, so it reads 51 and 60.

**Proving cost (payer side, for scale).** One 50-output t→z `z_sendmany` took:

- 5.7–6.1 s on v4.5.0;
- 4.8–5.2 s on 6.21.0.

**v4.5.0**

| Wallet | `z_listaddresses` | S+C wallet (samples) | S+C rpc | C wallet (samples) | S+C − C |
|---|---|---|---|---|---|
| no Sapling key | 0 | 33 (32, 36, 33) | 33 | 12 (10, 12, 12) | 22 |
| 1 key | 1 | 39 (43, 34, 39) | 39 | 11 (11, 11, 11) | 28 |
| 1 key + 50 diversified | 51 | 34 (44, 34, 34) | 33 | 10 (15, 10, 10) | 23 |
| 10 keys | 60 | 63 (60, 63, 99) | 63 | 12 (12, 10, 20) | 51 |

**6.21.0**

| Wallet | `z_listaddresses` | S+C wallet (samples) | S+C rpc | C wallet (samples) | S+C − C |
|---|---|---|---|---|---|
| no Sapling key | 0 | 85 (80, 85, 96) | 84 | 19 (16, 19, 24) | 66 |
| 1 key | 1 | 83 (83, 81, 89) | 82 | 17 (17, 18, 17) | 65 |
| 1 key + 50 diversified | 51 | 75 (84, 60, 75) | 74 | 15 (15, 15, 17) | 59 |
| 10 keys | 60 | 83 (83, 61, 88) | 82 | 15 (13, 15, 16) | 67 |

**Observations.**

- On both lines the wallet was done within about 1 ms of `reconsiderblock` returning (the wallet and
  rpc columns). At this volume the wallet's share of the work is below the method's resolution.
- **Diversified addresses add nothing measurable.** On both lines, 1 key with 50 diversified
  addresses matched 1 key. This is what the protocol predicts: each output is trial-decrypted once
  per incoming viewing key, not once per address.
- **v4.5.0: the key count shows.** With 10 keys the 250 outputs took about 51 ms, against 22–28 ms
  with 0 or 1 key. That is about 0.012 ms per output per additional key.
- **6.21.0: the key count does not show.** All four states fall within 59–67 ms. 6.21.0 scans
  through a batch scanner (`GetBatchScanner` in `ThreadNotifyWallets`), whose per-key cost was not
  measurable here.
- 6.21.0 connects the shielded segment more slowly than v4.5.0 even with no key (about 65 ms against
  about 22 ms for 250 outputs). That cost is block validation, which happens with or without a key.
- **Scale, by linear extrapolation** (not measured): 1,000 shielded outputs per day would cost the
  merchant's v4.5.0 wallet about 12 ms per day per extra key. The cost of one Sapling key itself
  could not be separated from noise. The replay over mainnet's shielded volume is in (e).

## (b) A viewing-key-only wallet

**Method.**

1. On the merchant (node 0), create a base address `B` with `z_getnewaddress sapling`, and a
   diversified address `D1` before the export.
2. Run `z_exportviewingkey B`, then `z_importviewingkey <key> "no"` into node 3's wallet, which
   holds no key of `B`.
3. Create a second diversified address `D2` on the merchant, after the import.
4. The pool pays `D1` and `D2` (t→z, with a memo).
5. Query node 3 with `z_listreceivedbyaddress` at minconf 0, then mine one block and query again
   at minconf 1.

| Check | v4.5.0 | 6.21.0 |
|---|---|---|
| `z_importviewingkey` | `{type: "sapling", address: B}` | same, plus `address_type` |
| `z_getnewdiversifiedaddress B` on the viewing-key wallet | **refused**: `-4 Wallet does not hold private zkey for this zaddr` (`ycash-dd/src/wallet/rpcdump.cpp:869-870`) | **refused**: `-4 Wallet does not hold the spending key for this zaddr` (`ycash6/src/wallet/rpcdump.cpp:1425-1427`) |
| `z_validateaddress D1` on the viewing-key wallet before any payment | `ismine: false` | `ismine: false` |
| mempool receipt at `D1` (issued before the import), minconf 0, within 3 s | **seen**: amount, memo, `confirmations: 0` | **seen** |
| mempool receipt at `D2` (issued after the import), minconf 0 | **seen** | **seen** |
| the same after one block, minconf 1 | seen, `confirmations: 1` | seen, `confirmations: 1` |
| `z_listreceivedbyaddress B` (the base address) | `[]`: notes are listed under the diversified address that received them | `[]` |
| `z_viewtransaction <tx>` on the viewing-key wallet | output decrypted: address `D1`, value, memo | same, plus `memoStr` |

**Observations.**

- A viewing-key wallet cannot issue diversified addresses through RPC on either line. Both
  `z_getnewdiversifiedaddress` implementations require the spending key.
- Once a payment arrives, such a wallet sees it at any diversified address of the key, including
  addresses it never generated, both in the mempool and when mined. So a settlement-only node holding
  only the viewing key can run the facilitator half of `sapling-proof`. The server half, which issues
  addresses, needs the spending-key wallet, or an off-node diversified-address derivation from the
  full viewing key. No RPC on either line offers that derivation. Section (f) shows it works offline
  with `sapling-crypto`.
- The import is an extended full viewing key (`zxviews…`), which reveals outgoing notes too. Neither
  line imports an incoming-viewing-key-only Sapling key through RPC: `z_importviewingkey` takes the
  full viewing key (`ycash-dd/src/wallet/rpcdump.cpp:1018`, `ycash6/src/wallet/rpcdump.cpp:924`).

## (c) Can either line disclose a single Sapling output? (code reading)

**Payment disclosure is Sprout-only on both lines and needs an experimental flag.**

- **The RPCs.** `z_getpaymentdisclosure` and `z_validatepaymentdisclosure` are registered:
  - `ycash-dd/src/wallet/rpcwallet.cpp:5340-5341`;
  - `ycash6/src/wallet/rpcwallet.cpp:6567-6568`.

  They refuse to run unless `-experimentalfeatures -paymentdisclosure` is set (`fExperimentalPaymentDisclosure`):
  - `src/experimental_features.cpp:23` on v4.5.0, `:24` on 6.21.0;
  - `src/wallet/rpcdisclosure.cpp:48`, `:70`, `:153`, `:170` on both lines.
- **The disclosure format is Sprout's.** `PaymentDisclosurePayload` carries:
  - `esk`, the JoinSplit ephemeral secret;
  - `js`, the index into `vJoinSplit`;
  - `n`, the JoinSplit output index;
  - a `libzcash::SproutPaymentAddress`.

  Sources: `ycash-dd/src/wallet/paymentdisclosure.h:81-101`, `ycash6/src/wallet/paymentdisclosure.h:78-98`.
- **Sapling transactions are refused.** `z_getpaymentdisclosure` throws "Transaction is not a
  shielded transaction" when `wtx.vJoinSplit.empty()`. A Sapling-only transaction has no JoinSplits,
  so it is refused. The `js_index` is checked against `vJoinSplit.size()`. Sources:
  `src/wallet/rpcdisclosure.cpp:103`, `:109` on both lines. `z_validatepaymentdisclosure` makes the
  same check, at `:223` on both lines.
- **Nothing writes disclosure data on 6.21.0.** The disclosure database is written only by the async
  operations that build JoinSplits:
  - v4.5.0: `asyncrpcoperation_sendmany.cpp:189-197`, `asyncrpcoperation_mergetoaddress.cpp:196`,
    `asyncrpcoperation_shieldcoinbase.cpp:168`;
  - 6.21.0: no writer. `PaymentDisclosureDB::sharedInstance()` appears only in the reader at
    `src/wallet/rpcdisclosure.cpp:129`.

  So `z_getpaymentdisclosure` can never find an entry on 6.21.0.
- **Sprout is not a practical disclosure path either.** Since Canopy, which is active on both
  lines' networks, no value may enter the Sprout pool: a JoinSplit with `vpub_old > 0` is invalid
  (`ycash-dd/src/main.cpp:1033-1039`, `ycash6/src/main.cpp:1086-1092`). A merchant's Sapling
  address cannot receive through a JoinSplit, so a `sapling-proof` payment can never be disclosed
  this way, on either line.
- **What exists instead.**
  - `z_viewtransaction` shows the decrypted Sapling outputs of a wallet transaction:
    - `ycash-dd/src/wallet/rpcwallet.cpp:3702`;
    - `ycash6/src/wallet/rpcwallet.cpp:4792`.

    For the sender it recovers its own outgoing outputs with its outgoing viewing keys:
    - `ycash-dd/src/wallet/rpcwallet.cpp:3840-3904` (`ovkForShieldingFromTaddr`,
      `RecoverSaplingNoteWithoutLeadByteCheck`);
    - `ycash6/src/wallet/rpcwallet.cpp:4923-5032`.

    This shows the sender's own view. It is not a transferable proof: the result cannot be checked
    by a third party without the key.
  - The Rust primitive a Sapling disclosure would need (recovering a single output from its
    outgoing cipher key) exists in the patched librustzcash. Its changelog says the
    `OutgoingCipherKey` "will eventually be used to implement Sapling payment disclosures"
    (`librustzcash6/zcash_primitives/CHANGELOG.md:1330-1332`). Neither node exposes it over RPC,
    and there is no ZIP-311 implementation in either tree.
- **Conclusion from code.** Neither line can disclose a single Sapling output through RPC. The only
  selective disclosure available today is off chain: the `offer-and-receipt` JWS receipt that
  `sapling-proof` settlement returns, or handing over a viewing key, which discloses every payment
  to that key.

## Second run: setup and sources (sections (d) to (f))

Taken on 2026-10-03 on the same Apple M5 laptop (10 cores), one devnet at a time:

- v4.5.0: `ycash-dd` binary `v4.5.0-cdfc4945f-dirty`, port seed 201;
- 6.21.0: `ycash6` binary `v6.21.0-rc1-94bafa4fd-dirty`, port seed 203;
- `lightwalletd-dd` at `32be188`, built with `go build -mod=vendor` outside the repository tree.

**Mainnet sources, read-only.** Every mainnet number below comes from one of these, at tip 3,053,679
(block time 1791080784):

- **The public lightwalletd `lite.ycash.xyz:9067`** (TLS). It reports `0.4.6-4-g187a267`, which is
  this workspace's lightwalletd pin, in front of `ycashd v4.5.0-624c12814`. It was used for:
  - `GetTreeState` at chosen heights. The Sapling commitment tree's size is the exact count of Sapling
    outputs mined up to that height. `lwdprobe tree` parses zcashd's serialized tree to get it.
  - `GetBlockRange` over four ranges: the last day, the last 30 days, the last year, and the densest
    early period. It gave compact-block bytes, output and spend counts, and dumps of the real compact
    outputs, which the trial-decryption benchmark runs on.
  - The tree state at 2,250,000 returned hash `000003f9…21e7`. That is the last mainnet checkpoint on
    both lines (`ycash-dd/src/chainparams.cpp:247`, `ycash6/src/chainparams.cpp:271`), so the source
    agrees with the nodes.
- **The explorer API `https://explorer.ycash.xyz/api/v1/`**:
  - `network/info` and `network/blockchain`: height, total transactions (8,884,853) and pool supplies.
    Its `commitments` field is the **Sprout** tree size (`ycash-dd/src/rpc/blockchain.cpp:1148-1150`),
    so it is not used for Sapling.
  - `blocks/{height}`: block sizes. The explorer cannot page through history, so chain size is
    **estimated from a sample** of 600 random heights, 300 below the Ycash fork at 570,000 and 300 above
    it (`tools/x4m/mainnet_block_sizes.py`, seed 4021). The sample's mean transactions per block
    reproduce the explorer's total transaction count to within 5% (9.3 M against 8.88 M).

**Mainnet shielded volume** (Sapling tree sizes; output counts are exact):

| Range | Blocks | Sapling outputs | Per day |
|---|---|---|---|
| Sapling activation (419,200) → tip | 2,634,479 | 872,030 | — |
| Ycash fork (570,000) → 700,000, the densest period | 130,000 | 206,628 | 911 |
| last checkpoint (2,250,000) → tip | 803,679 | 130,088 (and 123,104 spends) | — |
| last year (2,633,199 → tip, 367.5 days) | 420,480 | 59,188 (and 55,734 spends) | 161 |
| last 30 days | 34,560 | 5,323 | 177 |
| last day (1,152 blocks) | 1,152 | 154 | 154 |

Blocks arrive at about 1,144 a day, so a block holds 0.14 Sapling outputs on average now and 0.33 over
the whole Sapling era.

**Mainnet chain size (estimate from the sample).**

| Stratum | Mean block size | Estimated data |
|---|---|---|
| heights 1 – 569,999 (Zcash history before the fork) | 37,469 B | 21.4 GB |
| heights 570,000 – tip | 1,624 B | 4.0 GB |
| **total block data** | | **≈ 25.4 GB** |

The undo files, the chainstate and the block index come on top of this and were not measured. A
v4.5.0 node also needs all three parameter files before it starts (`ycash-dd/src/init.cpp:782-799`):
`sprout-groth16.params` (725.5 MB), `sapling-spend.params` (48.0 MB) and `sapling-output.params`
(3.6 MB). A 6.21.0 binary bundles the Sapling parameters and fetches the Sprout file only if needed
(`ycash6/src/init.cpp:913-921`).

## (d) Agent (payer) sync cost

### (d1) A full-node wallet

**Method** (`tools/x4m/sync_cost.py`):

1. An agent wallet is created on a fresh, offline node, with one Sapling key whose birthday is before
   the chain below.
2. The devnet chain is extended on the pool by 2,021 blocks at a mainnet-like density:
   - mostly coinbase-only blocks;
   - 20 blocks that each carry one t→z transaction with 50 Sapling outputs, one of which pays the
     agent 1 YEC;
   - 19 z→z transactions, each with 1 spend and 2 outputs.

   That is 1,038 Sapling outputs, or 0.51 per block. This density sits between mainnet's Sapling-era
   average (0.33) and its densest period (1.59).
3. Fresh nodes sync from genesis over P2P from node 0:
   - **agent**: the agent wallet;
   - **no wallet**: the same, with `-disablewallet`.

   Per-block connect times come from each node's `debug.log` `UpdateTip` lines, at millisecond
   resolution.
4. **Time to first payment.** The agent restarts and pays a merchant `ys…` address with a z→z
   `z_sendmany` (1 spend, 2 outputs, proved on the agent's node). The clock runs from process start
   until the merchant's node lists the payment in its mempool. This is done once at the tip, and
   again after the agent has been offline for 201 blocks.

| | v4.5.0 | 6.21.0 |
|---|---|---|
| sync from genesis, agent wallet (3,043 / 2,253 blocks) | 21.4 s to tip, balance visible at 21.6 s | 14.1 s to tip, balance at 14.6 s |
| sync from genesis, `-disablewallet` | 21.1 s | 16.7 s |
| connect, coinbase-only block (median) | 3.0 ms (wallet), 3.0 ms (no wallet) | 2.3 ms, 2.4 ms |
| connect, shielded block: 50-output t→z + 1-spend z→z (median) | 185 ms, 191.5 ms | 40.8 ms, 42.3 ms |
| so per Sapling description (53 per block) | ≈ 3.4 ms | ≈ 0.73 ms |
| disk after sync (regtest; blocks + chainstate + wallet) | 22.0 MiB (wallet.dat 1 MiB) | 21.7 MiB |
| restart at tip: RPC ready / payment proved and accepted / merchant sees it at 0-conf | 1.35 s / 2.73 s / 2.84 s | 4.70 s / 6.41 s / 6.85 s |
| restart after 201 blocks offline: node and wallet at tip / payment accepted / merchant sees it | 2.60 s / 3.79 s / 4.25 s | 4.68 s / 5.76 s / 7.07 s |
| `z_sendmany` z→z proving (1 spend, 2 outputs) | 1.2–1.4 s | 1.1–1.7 s |

**Observations.**

- The wallet's trial decryption does not show in sync time on either line. Agent and no-wallet runs
  connect blocks equally fast. Proof verification and per-block work dominate.
- During sync, 6.21.0 verifies Sapling blocks about 4.5× faster than v4.5.0 (0.73 ms against 3.4 ms
  per description). Section (a) measured the opposite order when blocks were *reconnected* after
  `invalidateblock`. That is a different path, in which the transactions return to the mempool
  first. For a node syncing from genesis, this IBD figure is the one that applies.
- 6.21.0 takes 3–5 s to answer RPC after a restart, against about 1 s on v4.5.0. That start-up delay
  dominates its time to first payment.
- The 0.5–1.4 s between "accepted by the agent's node" and "the merchant lists it" is the relay delay.

**Mainnet estimate for a full-node agent (not measured; arithmetic on the numbers above).**

- **Disk:** about 25.4 GB of block data, plus undo, chainstate and index. On v4.5.0, add 777 MB of
  parameters.
- **Download:** 25.4 GB takes about 34 min at 100 Mbit/s and about 2.8 h at 20 Mbit/s.
- **Up to the last checkpoint (2,250,000), neither line verifies proofs or scripts.** This is the
  expensive-checks switch:
  - v4.5.0: `ycash-dd/src/main.cpp:2862-2870`, `IsAncestorOfLastCheckpoint`;
  - 6.21.0: `ycash6/src/main.cpp:3276`, `IsBelowOrAtLastCheckpointHeight`.
- **Per-block work:** with regtest's per-block cost (3.0 / 2.3 ms) over 3,053,679 blocks, this comes
  to about 2.5 h (v4.5.0) or 2.0 h (6.21.0). Two things are not modelled here: mainnet's Equihash
  (192,7) header checks, and the larger pre-fork blocks (37 KB on average against regtest's empty
  ones).
- **Above the checkpoint:** 253,192 Sapling descriptions (130,088 outputs and 123,104 spends) at the
  measured cost take about 14.5 min on v4.5.0 and about 3 min on 6.21.0.
- **Wallet trial decryption of the whole Sapling era:** about 1 min at most. This uses the (d2)
  microbenchmark: 872,030 outputs × 66.6 µs on one core.
- **Total:** a few hours, probably 3 to 6 on this laptop, bound by per-block work and bandwidth, not by
  shielded volume. It is paid once per agent node.
- **Catching up per day offline:** about 1,144 blocks and 160 outputs plus a similar number of
  spends, which takes about 4.5 s on v4.5.0 and about 3 s on 6.21.0, on top of the restart times in
  the table.

### (d2) A light-wallet path: lightwalletd compact blocks plus trial decryption

**Method.**

- **The server.** `lightwalletd-dd` was built with `go build -mod=vendor -o <scratch>`. It serves:
  - each devnet's node 0, on both lines;
  - and, read-only, the public mainnet server above.
- **The client is two small tools, not a full light client.** A complete client would be
  `zcash_client_backend` 0.22 with storage, witnesses and a transaction builder; building one was out
  of proportion for a measurement. The two tools measure the parts of a light client's sync that cost
  something:
  - `tools/x4m/lwdprobe` (Go, on lightwalletd-dd's `walletrpc`) streams `GetBlockRange`. It counts
    compact-block bytes (`proto.Size`), transactions, outputs and spends, and dumps every compact
    Sapling output (cmu, epk, 52-byte ciphertext).
  - `tools/x4m/rust` `trialdec` (on `sapling-crypto` 0.7, the version `librustzcash6` pins) runs over
    a dump. It times `try_sapling_compact_note_decryption` per output on one core, the batched API, and
    a 10-thread split (the way `zcash_client_backend`'s batch runners spread work). It also times
    appending every cmu to a Sapling `CommitmentTree`, which a wallet does to witness its own notes.
- **The check that the method is right.** On each devnet, the dump of every compact block was
  trial-decrypted with each viewing key of the pool's wallet. The number of notes found matches what
  the node wallet itself lists in `z_listreceivedbyaddress`:
  - v4.5.0: 1,124 of 1,124 (9 keys);
  - 6.21.0: 1,018 of 1,018 (1 key).

  Compact-block scanning through lightwalletd finds exactly the notes a full node finds.
- **Mainnet scan cost.** Mainnet ranges were scanned with a random key: no hits, which is the
  realistic case for nearly every output.

**Compact-block size.**

| Source | Blocks | Outputs | Bytes | Per output | Per block (all) | Time to stream |
|---|---|---|---|---|---|---|
| mainnet, last day | 1,153 | 155 | 121 KB | 122 B | 105 B | 0.22 s |
| mainnet, last 30 days | 34,561 | 5,324 | 3.81 MB | 122 B | 110 B | 0.72 s |
| mainnet, last year | 420,481 | 59,188 | 44.9 MB | 122 B | 107 B (90 B without outputs) | 3.3 s |
| mainnet, 570,001 – 700,000 (densest) | 130,000 | 206,628 | 47.4 MB | 122 B | 364 B | 2.7 s |
| mainnet, 2,250,000 – 2,633,198 | 383,199 | 70,901 | 44.7 MB | 122 B | 117 B | 3.2 s |
| devnet v4.5.0, extension | 2,022 | 1,040 | 287 KB | 122 B | 142 B | 4 ms (local) |
| devnet 6.21.0, whole chain | 2,454 | 1,040 | 320 KB | 122 B | 130 B | 6–10 ms (local) |

The public server streamed at about 14 MB/s.

**A full restore from Sapling activation (estimate).** The ranges above cover 933,680 blocks and
137 MB. Filling the unmeasured 1.70 M blocks at 90–170 B each, plus 535,314 outputs × 122 B, gives
**0.36–0.49 GB in total**. That is about 30 s of download at the observed rate.

**Trial decryption and tree upkeep** (best of 5, on real mainnet compact outputs, with none of this run's devnets up; another chunk's idle devnet was running on the same machine):

| Dump | Outputs | 1 core, per output | batched API, 1 core | 10 threads, per output | `CommitmentTree` append, per output |
|---|---|---|---|---|---|
| last 30 days | 5,324 | 66.6 µs | 56.4 µs | 11.4 µs | 24.4 µs |
| last year | 59,188 | 66.8 µs | 58.1 µs | 12.6 µs | 27.3 µs |
| densest period | 206,628 | 66.7 µs | 56.4 µs | 11.6 µs | 24.6 µs |

ZIP-212 enforcement was set to `On` for every dump. The dense-period dump predates Canopy, but the
cost of trying to decrypt an output that is not the wallet's does not depend on that setting.

**What it adds up to for an agent.**

| Agent situation | Download | Trial decryption | Tree appends |
|---|---|---|---|
| **new key** (birthday = now) | nothing historical. One `GetTreeState` at the birthday gives the tree it builds on (it works on both lines' devnets and on mainnet) | — | — |
| per day of running, mainnet now | ≈ 121 KB | 154 outputs: ≈ 10 ms on one core | ≈ 4 ms |
| restore a one-year-old key | 44.9 MB (≈ 3 s) | 59,188 outputs: 4.0 s on one core, 0.75 s on 10 | 1.6 s |
| restore from Sapling activation | ≈ 0.36–0.49 GB (≈ 30 s) | 872,030 outputs: 58 s on one core, 10 s on 10 | 22 s |

On top of the scan, an agent proving its own z→z payment needs the Sapling parameters (51.6 MB), and
1–1.7 s per payment for a 1-spend, 2-output transaction (measured through the nodes above).

**Other observations.**

- **lightwalletd-dd 0.4.6 serves a 6.21.0 node.** `GetLightdInfo`, `GetBlockRange` and
  `GetTreeState` all worked against the 6.21.0 devnet, as they do against v4.5.0. `SendTransaction`
  and `GetMempoolTx` were not exercised on either line.
- **The library has Ycash parameters, but no Ycash light client exists for agents today.**
  - `librustzcash6` carries them: HRPs `ys`, `ytestsapling` and `yregtestsapling`, coin type 347 and
    Ycash branch ids (`librustzcash6` commit `02d42df5`;
    `components/zcash_protocol/src/constants/mainnet.rs:30`).
  - YEW does not do Sapling (plan C-2). YecLite is a GUI wallet.
  - No agent-usable Sapling light client exists for Ycash today.
- **Protocol compatibility (code reading, not tested).**
  - `zcash_client_backend` 0.22's proto keeps the field numbers lightwalletd 0.4.6 uses, for
    `TreeState.saplingTree = 5` and for `CompactTx` spends and outputs.
  - lightwalletd 0.4.6 sends no `chainMetadata` and has no `GetSubtreeRoots`. The scanner falls back to
    the previous block's tree size, which a wallet has from its birthday tree state. It returns
    `TreeSizeUnknown` only when both are missing (`librustzcash6/zcash_client_backend/src/scanning/compact.rs:426-443`).
  - So a linear scan from a birthday should work against 0.4.6. Fast "spend before sync" through
    subtree roots does not.
- **What the lightwalletd operator learns.**
  - Downloading every compact block reveals nothing about which notes are the agent's.
  - `SendTransaction` ties the agent's IP to its payment transaction.
  - Fetching full transactions with `GetTransaction`, to read memos, shows which transactions interest
    the wallet. A payer does not need to read memos.

### (d3) Tier P0 (t→z) needs no shielded sync. What it gives up

A P0 agent pays from a transparent `s1…` address straight to the merchant's `ys…` address. It needs only
a transparent key and a UTXO source, so it works with stateless keys and no shielded sync. On chain,
the transaction shows:

- **Revealed:**
  - the payer's transparent input address or addresses, and so its whole public UTXO history and
    funding source;
  - the transparent change output, if any (normally back to the payer);
  - the transparent fee;
  - the total value entering the Sapling pool (`valueBalance`). With one shielded output and no
    shielded change, that total is **the price paid**, to the zatoshi;
  - the block time.

  Every P0 payment from the same `s1…` address is linked to the others.
- **Hidden:**
  - the recipient: the merchant's address, and whether two payments went to the same merchant (each
    request gets its own diversified address);
  - the memo, and with it the request binding;
  - how the shielded value splits among outputs.
- **What remains.** An observer can still guess the merchant from the amount, where the price list is
  public and the prices distinctive, and from timing. P0 hides the payee, not the payer or the amount.

## (e) Mainnet replay of the merchant scan cost

This applies the per-output costs in (a) and (d2) to the mainnet output rates above. It is arithmetic,
not a new measurement.

| | last-year rate, 161 outputs a day | densest period, 911 a day | whole Sapling era, 872,030 outputs |
|---|---|---|---|
| v4.5.0, each extra Sapling key: 0.012 ms per output, from (a) | 1.9 ms a day | 10.9 ms a day | 10.5 s |
| any line, upper bound for the first key: 66.6 µs per output, one core, from (d2) | 10.7 ms a day | 61 ms a day | 58 s (10 s on 10 threads) |
| 6.21.0, per extra key | not visible in (a) (batch scanner) | — | — |
| diversified addresses, per address | 0 (one trial decryption per output per key, (a)) | 0 | 0 |

**Facts.**

- At today's mainnet volume, a merchant's wallet spends milliseconds a day on trial decryption.
- The block validation a merchant's node does anyway costs far more. At (d1)'s IBD costs, a day's
  ~160 outputs and ~150 spends take about 1 s to verify on v4.5.0, against 0.002–0.011 s for the
  wallet.
- Importing a viewing key with a rescan costs at most about a minute of decryption over the whole
  Sapling era, plus the node re-reading its blocks, which was not measured.

## (f) The viewing-key split: diversified addresses from a full viewing key, offline

**Question.** Can the host that issues per-request addresses hold no spending key?

**Code reading.**

- In `sapling-crypto` 0.7, the version `librustzcash6` pins (`librustzcash6/Cargo.toml:68`),
  `DiversifiableFullViewingKey` has `address(j)` and `find_address(j)`. Both go through
  `to_external_ivk()` (`sapling-crypto-0.7.0/src/zip32.rs:756-770`).
  `ExtendedFullViewingKey::find_address` does the same (`zip32.rs:610`).
- A Sapling address is `(d, pk_d = [ivk]·G_d)`, and the ZIP-32 diversifier `d` comes from the
  diversifier key `dk`. So deriving the address at any index needs only `ivk` and `dk`, both part of
  the `zxview…` key that `z_exportviewingkey` prints. It needs neither the spending key nor the
  outgoing viewing key.
- How the nodes pick an index:
  - On 6.21.0, `z_getnewdiversifiedaddress` walks upward from the base address's own index
    (`ycash6/src/wallet/rpcdump.cpp:1432-1468`).
  - On v4.5.0, it walks upward from index 1, skipping addresses already in the wallet
    (`ycash-dd/src/wallet/rpcdump.cpp:877-905`).

  An offline issuer therefore uses a disjoint range, such as indices from 2^40, so that it never
  hands out an address the node also issues.

**The proof of concept** (`tools/x4m/rust` `divaddr`, `tools/x4m/viewkey_split.py`, run on both lines):

1. The merchant's spending-key wallet (node 0) runs `z_getnewaddress sapling` → `B`, then
   `z_exportviewingkey B`.
2. A settlement node (node 3) imports only that key: `z_importviewingkey <key> "no"`.
3. `divaddr <key> 0 1` reproduces `B` exactly, so the tool and the node agree on ZIP-32. Then
   `divaddr <key> 1099511627776 2` derives two addresses offline.
4. The pool pays both, t→z, with a memo on the first.

| Check | v4.5.0 | 6.21.0 |
|---|---|---|
| index 0 from the viewing key equals the node's `B` | yes | yes |
| `z_validateaddress` of an offline address, before any payment | valid, `ismine: false` on both nodes | same |
| viewing-key node sees both payments in the mempool | yes: 0.65 s for the first, memo intact | yes: 1.08 s |
| viewing-key node sees them after one block | yes, `confirmations: 1` | yes |
| `z_viewtransaction` on the viewing-key node | both outputs decrypted to the offline addresses | same |
| spending-key wallet sees them and **spends** the note at the offline address (`z_sendmany` from it) | yes | yes |
| viewing-key node tries to spend | refused: "zaddr spending key not found" | refused: "no payment source found" |

**Result.** A merchant can keep the spending key off every online host:

- the web server issues addresses from the viewing key with a few lines of `sapling-crypto`, or from
  just its `ivk` and `dk`;
- the settlement node verifies with the imported viewing key;
- the spending-key wallet stays offline and still sees and spends every payment.

## Verdict

### Facts this rests on

1. **The agent's full-node wallet.**
   - Its one-time cost is dominated by the chain itself, not by shielded volume: about 25 GB of
     blocks, a few hours of sync, and 777 MB of parameters on v4.5.0. Shielded work is minor: proof
     checks above the checkpoint take about 15 min on v4.5.0 and 3 min on 6.21.0, and the wallet's
     scan of the whole Sapling era takes about 1 min.
   - Once synced, from restart to a payment the merchant sees takes 3–4 s on v4.5.0 and 7 s on 6.21.0
     (d1).
2. **The light-wallet path is cheap in every measured dimension.**
   - A new key scans no history.
   - Running costs about 121 KB and 15 ms of CPU a day at today's mainnet volume.
   - A full restore from Sapling activation is about 0.4 GB and under 2 min of CPU (d2).
   - lightwalletd-dd serves both node lines, and the public `lite.ycash.xyz` runs the same pin.
3. **The light client itself does not exist.** No agent-usable Ycash Sapling light client exists today.
   The library pieces are in `librustzcash6`, with Ycash parameters, but nobody has assembled them or
   run them against lightwalletd 0.4.6 (d2).
4. **The merchant's scan cost is negligible on mainnet:** milliseconds a day per key, and nothing per
   diversified address (e).
5. **Diversified addresses derive offline from the viewing key** on both lines, and a viewing-key-only
   node sees the payments in its mempool and after a block (f, and (b)).
6. **No RPC on either line discloses a single Sapling output** (c).
7. **P0 hides the payee only.** It reveals the payer, the amount and the time (d3).

### Recommendations

**(i) Tier P1 for agents now: yes, on a full-node wallet. On a light wallet: later.**

- **Full-node wallet.** P1 is practical today for any agent operator that can keep one synced ycashd
  wallet running, on either line, and hold the agents' shielded keys in it. Syncing is a one-time cost
  of hours, not a per-agent or per-payment one. Per payment, about 1.5 s of proving plus relay. Prefer
  v4.5.0 where restart latency matters (1 s against 3–5 s to RPC), and 6.21.0 where sync time matters
  (its Sapling verification is 4.5× faster).
- **Stateless or ephemeral agents** should use **P0** now. They accept that the payer and the amount
  are public.
- **The light path.** It is the right P1 path for stateless agents, and the numbers in (d2) show sync
  is no blocker. What blocks it is that the client does not exist: `zcash_client_backend` +
  `zcash_client_sqlite` with `librustzcash6`'s Ycash parameters, packaged for agents (N-API or a
  sidecar). Once it exists, P1 for stateless agents is practical.

**(ii) Recommended defaults for merchants.**

- **One dedicated Sapling key for x402 revenue**, separate from treasury funds. A viewing key, if it
  ever has to be shared, then reveals only that revenue.
- **Issue per-request addresses from the viewing key, offline** (f), in an index range the node never
  walks (from 2^40). Alternatively, issue them from the merchant's own wallet with
  `z_getnewdiversifiedaddress`.
- **Settle on a node that holds only the viewing key.** Keep the spending key in a wallet that is not
  on the request path, and sweep from it.
- **A self-hosted facilitator** for `sapling-proof`. A hosted facilitator would need the viewing key and
  would learn every payment, so offer hosted facilitators for transparent methods only (as §5.10 says).
- **Receipts for disclosure:** the `offer-and-receipt` JWS that settlement returns. No on-chain Sapling
  disclosure exists on either line (c). Never hand over a viewing key to prove one payment.

**(iii) X4b (facilitator-submitted Sapling, with a Rust builder): no-go for now. Revisit together with
the agent light client.**

- **What X4b adds over X4a.** The merchant verifies the transaction before it is broadcast, so the
  merchant controls broadcast and can refuse a payment without it reaching the chain. Settlement no
  longer depends on the client broadcasting.
- **What it does not add:**
  - **It does not remove the agent's sync blocker.** A payer under X4b still needs a synced note set,
    which is exactly what limits P1 today.
  - The nullifier gap stays until N-3: `/verify` cannot tell whether the notes are already spent.
  - Under X4a the merchant already sees a client-broadcast payment in its mempool within about 1 s
    (d1, (b)).
- **What X4b costs:**
  - a Rust transaction builder from `librustzcash6` (`zcash_primitives` builder, `sapling-crypto`
    prover, Ycash branch ids), packaged as WASM or N-API for the TypeScript client;
  - 51.6 MB of Sapling parameters in every agent;
  - WASM proving, which is single-threaded and slower than the 1–1.7 s native figure;
  - facilitator trial decryption of the submitted transaction;
  - tests on both lines.

  As a standalone build, that is roughly two to three chunks.
- **When the cost falls.** A light client for agents (recommendation (i)) has to contain the same
  builder and prover. Once that exists, X4b's extra cost is small: the facilitator side plus the
  verify-before-broadcast flow. So build X4b *with* the light client, not before it.

**(iv) The work that would remove the blocker.** This is library and server work, not node work; no
node change is in scope (X-10).

- **N-ask A, the main one: an agent-ready Ycash light client.**
  - Assemble it from `librustzcash6` (`zcash_client_backend` 0.22 + `zcash_client_sqlite`) with the
    Ycash parameters already there.
  - Prove it against lightwalletd-dd 0.4.6: a linear scan from a birthday tree state, then
    `SendTransaction`.
  - Package it for the TypeScript SDK.

  This turns P1 into "new key, no sync" for stateless agents. It also carries the X4b builder.
- **N-ask B: a newer lightwalletd protocol in lightwalletd-dd** (a server change): `chainMetadata` in
  compact blocks and `GetSubtreeRoots`. With them, a restored wallet can spend before its scan
  finishes. It is not needed for new keys.
- **N-ask C: a viewing-key path for issuing addresses on the node.** Either
  `z_getnewdiversifiedaddress` accepts a viewing-key-only wallet, or `z_importviewingkey` accepts an
  incoming viewing key (`zivk…`), so the settlement node does not learn outgoing notes:
  - v4.5.0: `ycash-dd/src/wallet/rpcdump.cpp:869-870`, `:1018`;
  - 6.21.0: `ycash6/src/wallet/rpcdump.cpp:1425-1427`, `:924`.

  This is a node change, so it is only an ask. It is not needed, because (f) works offline today.
- **N-ask D: Sapling payment disclosure (ZIP-311)** on either line. It is absent (c), and receipts
  cover the need for now.
- **N-3 (already in the plan):** a nullifier-spent check for `/verify`. It closes X4b's declared gap.
- **Operational, not code: faster full-node bootstrap for agent operators**, from a published,
  verifiable block-data snapshot. A newer checkpoint than 2,250,000 would skip proof checks for
  803,679 more blocks, but that saves only about 15 min on v4.5.0. Per-block work and bandwidth
  dominate.

### Reproduce

The scripts are under `tools/x4m/` (see its README). They run against a `scripts/devnet.sh` devnet and
the public mainnet sources:

```
scripts/devnet.sh up dd 201
python tools/x4m/sync_cost.py --devnet <dir>/devnet.json --line dd --work <scratch>/sync-dd --p2p 13470 --rpcport 18470
python tools/x4m/viewkey_split.py --devnet <dir>/devnet.json --line dd --divaddr tools/x4m/rust/target/release/divaddr
lwdprobe -addr lite.ycash.xyz:9067 -tls tree <height>
lwdprobe -addr lite.ycash.xyz:9067 -tls range <a> <b> out.bin
trialdec out.bin random 5
python tools/x4m/mainnet_block_sizes.py 3053679 300
```
