# Mainnet runbook (X6)

For the owner. This is the first run of x402 payments on Ycash mainnet: a YEC `exact` payment and a
short YEC channel on each node line, with small amounts. Then YED once Yellowback is live on
mainnet, then shielded payments. Nothing here changes a node. Every step can be stopped, and
[Roll back](#roll-back) undoes it.

**YED on mainnet starts at height 3,075,000** on both lines (Yellowback's mainnet `startHeight`).
The tip was 3,052,055 on 2026-10-02. At 75 s blocks that is about 2026-10-22. Until then only YEC
runs.

## What runs where

| Piece | Runs on | Talks to |
|---|---|---|
| Node (per line) | `ycashd` 4.5.0 (`ycash-dd` build) or 6.21.0 (`ycash6` build), synced to mainnet | — |
| Facilitator | `packages/facilitator` (`/verify`, `/settle`, `/supported`, `/healthz`) | its own node over RPC |
| Merchant | `examples/merchant-express`, or your own `@x402/express` server | the facilitator; its node for channels |
| Agent | `packages/cli` (`x402-ycash`), driven by `tools/mainnet/smoke.sh` | the merchant; its own node |

Run the whole set once per line: first on the 4.5.0 node, then on the 6.21.0 node. The two lines are
the same network and accept the same transactions; running both checks that each line's build of
the facilitator's node answers as on the devnet.

The facilitator, merchant and agent can share one host and one node for the first run. A real
deployment separates them: the agent never uses the merchant's node, and the facilitator's node is
the merchant's (self-hosted) or a hosted facilitator's.

## 1. Node

| For | Flags | Why |
|---|---|---|
| YEC (`exact`, channels) | **none** | Every x402 YEC transaction is a standard transparent v4 transaction. A stock node relays and verifies it. |
| YED | **`-experimentalfeatures -yellowback`** | The facilitator verifies YED with `yed_validaterawtransaction`; the merchant and agent need `yed_getnewaddress`, `yed_listunspent` and `yed_listtokens`. |
| Shielded (`sapling-proof`) | none | The settlement node needs the merchant's viewing key (see [Keys](#4-keys)). |

RPC hygiene, on every node:

- Bind RPC to localhost (`rpcbind=127.0.0.1`, `rpcallowip=127.0.0.1`) and use the cookie file
  (`X402_RPC_COOKIE_FILE` for the facilitator and the agent, `MERCHANT_RPC_COOKIE_FILE` for the
  merchant) or `rpcauth`, never `rpcpassword` in a shared config.
- No `txindex` is needed.
- Check that the node is synced: `getblockchaininfo` shows `chain: "main"` and `blocks` equal to
  `headers`, and the tip matches a public explorer.

For YED, also check (after height 3,075,000):

```
ycash-cli yed_getinfo
# enabled: true, network: "main", healthy: true, activation.status: "active", height ≥ startHeight (3075000)
```

## 2. Facilitator

From an `x402-ycash` checkout (`npm ci`), on the facilitator's host:

```bash
export X402_NETWORK=ycash:mainnet
export X402_RPC_URL=http://127.0.0.1:8232/
export X402_RPC_COOKIE_FILE=$HOME/.ycash/.cookie
export X402_HOST=127.0.0.1 X402_PORT=4022
export X402_SETTLEMENT_STORE=/var/lib/x402/settlements.json   # persistent disk; shared by every /settle process
export X402_CHANNEL_STORE=/var/lib/x402/channels.json
export X402_API_KEY=$(openssl rand -hex 24)                    # the merchant sends it as Bearer
export X402_CONFIRMATIONS_MIN=-1                               # allow mempool settlement for small amounts (opt-in)
export X402_CONFIRMATIONS_MAX=20
npm run build -w x402-ycash-mechanism -w x402-ycash-facilitator && npm start -w x402-ycash-facilitator
# or, without a build step: npm run dev -w x402-ycash-facilitator
# or: docker build -f packages/facilitator/Dockerfile -t x402-ycash-facilitator . (same variables)
```

- `X402_CONFIRMATIONS_MIN=-1` is what lets a 0.0001 YEC payment settle in a second. Leave it at the
  default `0` to refuse mempool settlement altogether: every payment then waits for one block
  (75 s on average).
- The facilitator holds **no keys** and pays no fee. It needs no wallet balance.
- Put it behind TLS (a reverse proxy) if the merchant is on another host, and keep `X402_API_KEY`.

Check:

```bash
curl -s http://127.0.0.1:4022/healthz
curl -s http://127.0.0.1:4022/supported
# kinds: exact on ycash:mainnet with extra.assets ["YEC"] (["YEC","YED"] on a -yellowback node),
#        batch-settlement on ycash:mainnet; confirmations {minimum: -1, maximum: 20}
```

## 3. Merchant

The example merchant, with small prices. `MERCHANT_PAY_TO` is a fresh transparent address of a
wallet **you** control and watch (not the facilitator's node, not a channel key).

```bash
export X402_NETWORK=ycash:mainnet PORT=4021 HOST=127.0.0.1
export FACILITATOR_URL=http://127.0.0.1:4022 FACILITATOR_API_KEY=<the facilitator's X402_API_KEY>
export MERCHANT_PAY_TO=s1...                        # getnewaddress on the merchant's wallet
export MERCHANT_RPC_URL=http://127.0.0.1:8232/ MERCHANT_RPC_COOKIE_FILE=$HOME/.ycash/.cookie
export PRICE_TICKER_ZAT=10000                       # /exact/ticker: 0.0001 YEC
export PRICE_EXACT_ZAT=100000                       # /exact/quote:  0.001 YEC
export MERCHANT_ZERO_CONF_CAP_ZAT=10000             # up to 0.0001 YEC settles at the mempool; above, one block
# channels (/channel/search)
export MERCHANT_CHANNEL_KEY=$(cat /etc/x402/merchant-channel.key)   # 64 hex; see Keys
export MERCHANT_CHANNEL_STORE=/var/lib/x402/merchant-channels.json
export PRICE_CHANNEL_ZAT=1000                       # 0.00001 YEC per request
export MERCHANT_MAX_DEPOSIT_ZAT=1000000             # at most 0.01 YEC per channel
export MERCHANT_CHANNEL_CONFIRMATIONS=1             # the funding must be in a block
export MERCHANT_FUNDING_WAIT_MS=300000              # an open waits up to 5 min for that block
npm start -w x402-ycash-example-merchant-express
```

YED (only after height 3,075,000, and only with a `-yellowback` facilitator node):

```bash
export MERCHANT_YED_PAY_TO=ye...                    # yed_getnewaddress on the merchant's -yellowback wallet
export PRICE_YED_REPORT='$1'                        # /yed/report: exact, never below $1.00
export PRICE_YED_STREAM='$0.01'                     # /yed/stream: a YED channel
export MERCHANT_MAX_DEPOSIT_CENTS=200               # at most $2 per YED channel
```

The merchant re-reads the facilitator's `/supported` every minute, so the YED routes come on when
the facilitator's node starts listing YED.

Shielded (X4a), self-hosted, in the recommended viewing-key layout (set up as in
[Keys](#4-keys), "Shielded layout"): the merchant needs no node for this route.

```bash
export MERCHANT_ISSUED_REGISTRY=/var/lib/x402/issued.json      # the same file the facilitator reads
export MERCHANT_SAPLING_ISSUER=offline
export MERCHANT_SAPLING_VIEWING_KEY=$(cat /etc/x402/merchant.zxviews)   # zxviews1…, z_exportviewingkey
export MERCHANT_SAPLING_INDEX_FILE=/var/lib/x402/sapling-index.json     # back it up with the registry
# MERCHANT_SAPLING_START_INDEX defaults to 1099511627776 (2^40)
export PRICE_SHIELDED_ZAT=100000 MERCHANT_SHIELDED_CONFIRMATIONS=1
```

The alternative, issuing from a spending-key wallet with `z_getnewdiversifiedaddress`, is
`MERCHANT_SAPLING_BASE_ADDRESS=ys1…` plus `MERCHANT_RPC_*` pointing at that wallet (no
`MERCHANT_SAPLING_ISSUER`).

Check: `curl -si http://127.0.0.1:4021/exact/ticker` answers `402` with a `PAYMENT-REQUIRED` header;
`curl -s http://127.0.0.1:4021/` lists the routes that are on.

## 4. Keys

| Key | Where it lives | Never | If lost |
|---|---|---|---|
| **Agent payer key** (`X402_WIF`) or the agent node's wallet | the agent's host, `chmod 600` env file | in the merchant's or facilitator's node | the agent's own funds only; fund a new key |
| **Channel keys C** (one per channel, client side) | the agent's channel store (`X402_CHANNEL_STORE`, default `~/.x402-ycash/channels.json`), written by the SDK | **imported into any node wallet** (the stock signer cannot spend the channel script anyway, and an imported C is a key nobody tracks) | the client cannot refund alone; back the store up until every channel in it is closed or refunded |
| **Merchant channel key S** (`MERCHANT_CHANNEL_KEY`) | a file on the merchant's host, `chmod 600`, backed up | in a node wallet; in logs (the merchant prints `(set)`) | the merchant cannot close; open channels end by the client's refund after the refund height, and the merchant loses the charged amounts |
| **Receipt key** (`X402_RECEIPT_KEY`, `sapling-proof` only) | the self-hosted facilitator's env, `chmod 600` | shared with anyone; reused as a payment key | receipts already issued stay verifiable with the old public key; generate a new key and publish its public key |
| **Merchant Sapling spending key** (the dedicated x402 revenue key) | a wallet **off the request path**, swept to treasury | on the settlement node | the revenue at that key; keep its seed backed up like any wallet |
| **Merchant viewing key** (`zxviews…`) | the settlement node (`z_importviewingkey <key> "no"`) and the merchant's and facilitator's env (`MERCHANT_SAPLING_VIEWING_KEY`, `X402_SAPLING_VIEWING_KEY`; never logged), `chmod 600` | handed to a hosted facilitator or a customer (it reveals all revenue at the key) | rotate the revenue key |
| **Offline issuer index file** (`MERCHANT_SAPLING_INDEX_FILE`) | the merchant's host, backed up with the registry | shared between two keys (it refuses) | safe while the registry survives; with both lost, an address could be reissued |
| `X402_API_KEY` | facilitator and merchant env | in a URL or logs | rotate both sides |

Generate secrets on the host that uses them: `openssl rand -hex 32 > /etc/x402/merchant-channel.key`.

**Shielded layout (the X4-M verdict, `docs/x4m-measurements.md`).** One dedicated Sapling key for
x402 revenue, separate from treasury. Three places hold three different things:

| Host | Holds | Does |
|---|---|---|
| **Node A**, the revenue wallet | the spending key, nothing else | offline; started only to sweep |
| **Node B**, the settlement node | the viewing key only | the facilitator's node: sees every payment, mempool included |
| **The merchant server** | the viewing key (as config) and its index file | issues per-request addresses offline; no node, no spending key |

On both lines a viewing-key wallet sees payments to any diversified address of the key, in the
mempool and after a block, and cannot spend them; neither can it issue addresses through RPC, which
is why the merchant derives them itself (X4-M (b), (f)).

1. **Node A** (any wallet node, ideally a fresh one; it can stay offline afterwards):
   `z_getnewaddress sapling` → `B`, then `z_exportviewingkey B` → `zxviews1…`. Back up node A's
   wallet. Stop node A.
2. **Node B**: `z_importviewingkey <zxviews1…> "no"` (no rescan: the key is new; use `"yes"` and a
   start height for an older key). It answers `{type: "sapling", address: B}`. Check that it holds
   the viewing key and not the spending key: `z_validateaddress B` shows `ismine: false`, and
   `z_getnewdiversifiedaddress B` is refused.
3. **Facilitator on node B** (`X402_RPC_*` → node B), with the receipt key and the registry as above
   and:

   ```bash
   export X402_SAPLING_ISSUER=offline
   export X402_SAPLING_VIEWING_KEY=$(cat /etc/x402/merchant.zxviews)
   ```

   At startup it checks that node B holds the key (`z_listreceivedbyaddress B 0` answers) and logs a
   warning if node B also holds the spending key. Do not set `X402_SAPLING_BASE_ADDRESS` with it.
4. **Merchant**: the `MERCHANT_SAPLING_*` variables in [section 3](#3-merchant). It derives each
   address from the viewing key at the next valid diversifier index from `2^40`, a range neither
   wallet's `z_getnewdiversifiedaddress` walk reaches (v4.5.0 walks from 1, 6.21.0 from the base
   address's index). It writes the next index to `MERCHANT_SAPLING_INDEX_FILE` before handing an
   address out; the file is bound to the key and refuses another one. Losing the file is safe as
   long as the registry survives (an address the registry already issued is never reused); losing
   both risks reissuing an address, so back them up together.
5. **Sweep** from node A: start it, let it catch up (it finds the notes at the offline addresses
   while connecting the blocks, with no rescan, since the key predates them), `z_sendmany` from each
   address that holds notes (`z_listreceivedbyaddress <address> 1`) to treasury, stop it again.
6. Prove a payment with the `offer-and-receipt` JWS the settlement returns. Never hand over the
   viewing key to prove one payment.

Node B knows an offline-issued address only once it has decrypted a note to it: before that, both
lines answer `z_listreceivedbyaddress` for it with `-5` ("does not belong to this node"), which the
facilitator reads as "not received yet" and keeps waiting (up to `X402_SAPLING_NOTE_WAIT_MS`).

**Rehearsed on both lines (2026-10-03).** `examples/merchant-express/test/devnet/viewkey.http.devnet.test.ts`
runs this layout on a regtest devnet: node A (an extra ycashd, stopped after export), node B the
stock node 1, the merchant with no node, the facilitator on node B; an agent paid P1 (z→z) and P0
(t→z); both receipts verified; each address was the next valid index from 2^40; node A came back,
found both notes and swept them (2,960,000 zat), and node B's own attempt to spend was refused.

| | v4.5.0 (seed 291) | 6.21.0 (seed 293) |
|---|---|---|
| P1 / P0 paid and settled, agent wall time | 4.3 s / 1.5 s | 3.3 s / 2.2 s |
| node B's refusal to spend | "zaddr spending key not found" | "no payment source found for address" |
| node A's sweep fee | the node's default | the node's default (6.21.0 refuses a fee above 4× its ZIP-317 conventional fee) |

```bash
scripts/devnet.sh up dd 291   # or: up 6 293
X402_DEVNET_JSON=…/dd-291/devnet.json npx vitest run --dir test/devnet viewkey \
  --testTimeout=600000 --hookTimeout=600000      # in examples/merchant-express
```

## 5. Agent and the smoke test

`tools/mainnet/smoke.sh` pays one `exact` payment and one short channel with the CLI and checks
each step. Secrets come from the environment only:

```bash
export X402_RPC_URL=http://127.0.0.1:8232/ X402_RPC_COOKIE_FILE=$HOME/.ycash/.cookie   # the agent's node
export X402_WIF=$(cat ~/.x402-ycash/agent.wif)     # optional; without it the node's wallet pays
tools/mainnet/smoke.sh --network ycash:mainnet --merchant http://127.0.0.1:4021 \
  --facilitator http://127.0.0.1:4022 --dry-run --i-understand-this-spends-real-yec
```

`--dry-run` makes only read-only calls: the node's chain, the merchant's two offers, the
facilitator's kinds. It prints what the run can spend at most. Then drop `--dry-run`.

Defaults and caps:

| | Default | Hard cap (no flag raises it) |
|---|---|---|
| per payment / per channel request (`--max-payment-zat`) | 100,000 zat (0.001 YEC) | 1,000,000 (0.01 YEC) |
| channel deposit (`--deposit-zat`) | 1,000,000 zat (0.01 YEC) | 10,000,000 (0.1 YEC) |
| server close fee the channel may lock (`--max-close-fee-zat`) | 5,000 zat | 10,000 |
| channel requests (`--requests`) | 5 | 50 |

The script refuses to run without `--i-understand-this-spends-real-yec`, refuses a merchant whose
price is above the cap, refuses a deposit too small for the requests, and refuses a regtest devnet
file on mainnet. It keeps the channel store and a JSON-lines report in
`~/.x402-ycash/smoke-mainnet/`. Back that directory up until the channel is closed.

Fund the agent with a few separate coins (one confirmed coin per payment: a payment's change is
unconfirmed until the next block). Use a key that is **not** in the agent node's wallet, or no
`X402_WIF` at all.

Order of runs:

1. **Regtest rehearsal** on each line: `scripts/devnet.sh up dd <seed>` (and `6`), facilitator and
   merchant as above with `X402_NETWORK=ycash:regtest`, then `smoke.sh --network ycash:regtest`
   with `X402_DEVNET_JSON`. A slow miner (`generate 1` every 15 s on node 1) stands in for mainnet
   blocks. This was done on the 4.5.0 line on 2026-10-03: exact settled at the mempool in 117 ms,
   a five-request channel opened, closed and was mined, the merchant received 15,000 zat and the
   remainder (995,000 zat) returned to the agent's address. On the 6.21.0 line (seed 293, the
   same day; facilitator and merchant on node 0, the payer node 2's wallet), `--dry-run` and the
   real run passed unchanged: exact settled at the mempool in 226 ms, the channel closed with
   5,000 zat charged, the merchant received 15,000 zat at two confirmations, and 995,000 zat
   returned to the agent. No difference between the lines needed a fix.
2. **Mainnet YEC on the 4.5.0 node**: `--dry-run`, then the real run.
3. **Mainnet YEC on the 6.21.0 node**: the same, with the facilitator and merchant pointed at it.
4. **YED** after height 3,075,000: restart the facilitator's node with
   `-experimentalfeatures -yellowback`, check `yed_getinfo` and `/supported` (YED listed), set the
   merchant's YED variables, then pay `/yed/report` once ($1) and open one YED channel on
   `/yed/stream` with the CLI: `x402-ycash pay <merchant>/yed/report --asset YED` and
   `x402-ycash channel open <merchant>/yed/stream --asset YED --deposit 200`, a few
   `pay --asset YED`, then `channel close … --asset YED`. smoke.sh covers YEC only.
5. **X4a** (shielded): one `sapling-proof` payment from a Sapling address of the agent's wallet
   (`X402_SHIELDED_FROM=ys1…`, `x402-ycash pay <merchant>/shielded/report`), in the viewing-key
   layout of [Keys](#4-keys), then one sweep from node A.

## 6. What to check

After each run:

- **The payment is on chain.** The script prints each txid. On the merchant's wallet,
  `getreceivedbyaddress <MERCHANT_PAY_TO> 0` grows by the price; after a block, check the txid on an
  explorer (`gettransaction <txid>` on the merchant's wallet shows it too).
- **Mempool settlement held.** A `-1` payment shows `extra.status: "mempool"` in the settlement; it
  must be in the next block or two. If it is still unconfirmed after 10 blocks, look for a conflict
  (the payer double-spent): `gettxout <txid> <vout> true` on the facilitator's node.
- **The channel closed cleanly.** `x402-ycash channel status <id>` shows `unspent: false`. The close
  pays the merchant the charged total and the agent's remainder to the agent's own address (the
  smoke report has both). Nothing stays at the channel key C.
- **Fees.** The agent paid the transaction fees (a few thousand zatoshis); the facilitator paid
  nothing.
- **Logs.** Facilitator and merchant logs show no `settlement_pending` that never resolved and no
  `duplicate_settlement` outside a deliberate replay. The settlement store holds one claim per
  payment.
- **YED.** `yed_validaterawtransaction <hex>` on any payment shows `burned: 0`; the merchant's
  `yed_listunspent` shows the cents; a channel close returns the client's remainder (or the $1.00
  floor rule: a remainder under $1.00 goes to the merchant) and nothing burns.
- **Shielded.** The receipt verifies against the receipt key's public key, and the payment tx shows
  no transparent output to the merchant.

Record the txids and results in the plan's X6 checklist.

## Roll back

Nothing on chain needs undoing: no node changed, and every payment is an ordinary transaction.

1. **Stop new payments.** Stop the merchant (SIGTERM; it finishes in-flight requests) or remove the
   route. Then stop the facilitator (SIGTERM; in-flight settles get `X402_SHUTDOWN_TIMEOUT_MS`).
2. **Open channels.** Close them from the agent: `x402-ycash channel close <merchant-url> <id>` (the
   merchant broadcasts at once). If the merchant is gone, the agent refunds alone from the refund
   height: `x402-ycash channel status` shows `blocksToRefund`, then `x402-ycash channel refund <id>`.
   The merchant's idle close (`MERCHANT_CHANNEL_IDLE_MS`, default 10 min) also closes channels it
   still serves. Keep the channel stores until every channel is closed or refunded.
3. **Unconfirmed payments.** A signed `exact` payment that was never settled expires on its own at
   its `nExpiryHeight` (a few blocks). A settled one that is still in the mempool cannot be
   recalled; wait for it to be mined or to expire.
4. **YED off.** Restart the facilitator's node without `-yellowback`; `/supported` stops listing
   YED and the merchant's YED routes go off within a minute. YED already paid stays recorded on
   every Yellowback node.
5. **Keys.** Rotate `X402_API_KEY` and the receipt key if either was exposed. Sweep the shielded
   revenue key to treasury.
6. **Software.** Redeploy the previous `x402-ycash` commit, keeping the store files (JSON). Nodes
   need no rollback.
