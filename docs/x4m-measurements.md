# X4-M first measurements

Plan reference: `docs/plans/x402-agent-payments-plan.md` §5.10 and the X4 checklist, in the Yellowback
workspace. This file records measurements only. Interpreting them is left to the plan's X4-M verdict.

Taken on 2026-10-03 on an Apple M5 laptop, on two regtest devnets started one after the other:

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
  could not be separated from noise. The plan's "replayed over mainnet's shielded volume" item is
  still open: it needs mainnet output counts, which this devnet run does not have.

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
  full viewing key. No RPC on either line offers that derivation.
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
