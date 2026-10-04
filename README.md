# x402-ycash

x402 (HTTP-402, protocol v2, [x402.org](https://x402.org)) agent payments on the Ycash network, in
**YEC** and **YED** (Ycash Yellowback, the dollar on Ycash).

- **Pay-per-request** (`exact`): the agent signs a complete transparent transaction, the facilitator
  verifies it and relays it (the pattern of x402's Cardano binding).
- **Payment channels** (`batch-settlement`): a one-way CLTV channel, so per-request payments stay
  off chain until one close; YEC, then YED.
- **Private payments**: shielded (Sapling) YEC to a fresh diversified address per request.

No consensus change and no node change: it runs against stock `ycashd` RPCs (plus the read-only
`yed_*` RPCs for YED) on both Ycash node lines, 4.5.0 and 6.21.0, and node and pool operators need
to do nothing.

The plan is `docs/plans/x402-agent-payments-plan.md` in the
[Yellowback workspace](https://github.com/boyfromcave/yellowback); the binding specs are in
[`specs/`](specs/), language-neutral test vectors in [`vectors/`](vectors/).

## Layout

```
packages/ycash/   the x402 mechanism (TypeScript, on @x402/core v2): tx, yed, channel, exact, batch, node, store, lwd
packages/facilitator/  the standalone facilitator service: /verify, /settle, /supported, /healthz
packages/cli/     the `x402-ycash` command: pay a route, open, list, close and refund channels
examples/         merchant-express (an @x402/express server) and agent-client (an @x402/fetch agent)
specs/            the binding specifications (x402 Foundation templates)
vectors/          JSON test vectors every implementation must reproduce
```

## Develop

```
nvm use            # Node 22 (see .nvmrc); >= 20 works
npm install
npm run typecheck
npm test           # unit tests
npm run test:devnet   # against a running yellowback-devnet (see the plan, §6)
npm run test:devnet:http   # the HTTP path only: facilitator, merchant, agent and CLI as processes
                           # (+ X402_LWD_URL=host:port of a lightwalletd on node 0: the light-agent suite)
```

## Quick start on the devnet

Four terminals, one command each, from the repository root of a
[Yellowback workspace](https://github.com/boyfromcave/yellowback) checkout (the devnet script needs
its built `ycash-dd` or `ycash6`). Use `6` instead of `dd` for the 6.21.0 line.

```
# 1. a five-node regtest devnet (node 0 funded wallet, node 1 stock, nodes 2-4 pools)
X402_SCRATCH=$PWD/scratch scripts/devnet.sh up dd 181

# 2. the facilitator on node 0 (the merchant's own wallet): exact, channels, and sapling-proof with receipts
X402_NETWORK=ycash:regtest X402_DEVNET_JSON=$PWD/scratch/dd-181/devnet.json X402_CONFIRMATIONS_MIN=-1 X402_RECEIPT_KEY=$(openssl rand -hex 32) X402_ISSUED_REGISTRY=$PWD/scratch/issued.json X402_SETTLEMENT_STORE=$PWD/scratch/settlements.json X402_CHANNEL_STORE=$PWD/scratch/fac-channels.json npm run dev -w x402-ycash-facilitator

# 3. the merchant on :4021, paid to a node-1 address, all four routes live
FACILITATOR_URL=http://127.0.0.1:4022 MERCHANT_PAY_TO=$(X402_SCRATCH=$PWD/scratch scripts/devnet.sh cli dd 181 --node 1 -- getnewaddress) MERCHANT_DEVNET_JSON=$PWD/scratch/dd-181/devnet.json MERCHANT_CHANNEL_KEY=$(openssl rand -hex 32) MERCHANT_CHANNEL_STORE=$PWD/scratch/merchant-channels.json MERCHANT_ISSUED_REGISTRY=$PWD/scratch/issued.json MERCHANT_CHANNEL_CONFIRMATIONS=-1 MERCHANT_SHIELDED_CONFIRMATIONS=-1 npm start -w x402-ycash-example-merchant-express

# 4. the agent: ten paid requests from node 0's wallet (RESOURCE_URL …/exact/quote needs a block: scripts/devnet.sh cli dd 181 -- generate 1)
RESOURCE_URL=http://127.0.0.1:4021/exact/ticker REQUESTS=10 AGENT_DEVNET_JSON=$PWD/scratch/dd-181/devnet.json npm start -w x402-ycash-example-agent-client
```

Then try the other routes: `RESOURCE_URL=…/channel/search REQUESTS=100` pays on one channel
(close it with `npm start -s -w x402-ycash-cli -- channel close http://127.0.0.1:4021/channel/search
--devnet $PWD/scratch/dd-181/devnet.json --channels …` after setting `AGENT_CHANNEL_STORE` to the
same file), and `RESOURCE_URL=…/shielded/report AGENT_SHIELDED_FROM=<a Sapling address of the
agent's wallet with a confirmed note>` pays privately and prints the merchant's signed receipt.
`scripts/devnet.sh down dd 181` stops the devnet. Every block the payments need can come from
node 1, the stock seat: no node runs anything for x402.

### YED

Ycash Yellowback (YED) is paid on two more merchant routes, served only when the facilitator lists
YED in `/supported` (its node runs `-experimentalfeatures -yellowback`, as node 0 does) and the
merchant has a Yellowback address: `GET /yed/report` (exact, `PRICE_YED_REPORT`, default `$2`;
never below $1.00, since a smaller YED output burns) and `GET /yed/stream` (a YED channel,
`PRICE_YED_STREAM` per request, default `$0.01`, deposits up to `MERCHANT_MAX_DEPOSIT_CENTS`). The
merchant re-reads the facilitator's `/supported` every minute and when a request reaches a YED
route that is off, so the routes come on when the facilitator starts after the merchant. A
YED channel's funding must be in a block, so run the merchant of step 3 without
`MERCHANT_CHANNEL_CONFIRMATIONS=-1` and add, for example,
`MERCHANT_YED_PAY_TO=$(X402_SCRATCH=$PWD/scratch scripts/devnet.sh cli dd 181 -- yed_getnewaddress)`.
Node 0 needs YED first: `scripts/devnet.sh cli dd 181 -- yed_mint 20000 48 "" "" false`, then a
block from a pool, whose blocks carry the price (`scripts/devnet.sh cli dd 181 --node 2 -- generate 1`).

```
# YED exact at $2 from node 0's wallet (YED is a default asset with a $1.00 cap: raise the agent's)
RESOURCE_URL=http://127.0.0.1:4021/yed/report MAX_PAYMENT_YED_CENTS=200 AGENT_DEVNET_JSON=$PWD/scratch/dd-181/devnet.json npm start -w x402-ycash-example-agent-client

# a YED channel of 150 one-cent requests with D = $5.00, then the CLI's close (the merchant gets max($1.00, charged))
RESOURCE_URL=http://127.0.0.1:4021/yed/stream REQUESTS=150 AGENT_YED_CHANNEL_DEPOSIT_CENTS=500 AGENT_CHANNEL_STORE=$PWD/scratch/yed.json AGENT_DEVNET_JSON=$PWD/scratch/dd-181/devnet.json npm start -w x402-ycash-example-agent-client
npm start -s -w x402-ycash-cli -- channel close http://127.0.0.1:4021/yed/stream --asset YED --devnet $PWD/scratch/dd-181/devnet.json --channels $PWD/scratch/yed.json
```

The agent pays YED from `AGENT_WIF` (the key's `ye…` token outputs) or the node's wallet, with
`MAX_PAYMENT_YED_CENTS` (default 100), `AGENT_YED_CHANNEL_DEPOSIT_CENTS` and
`AGENT_YED_CHANNEL_MAX_DEPOSIT_CENTS` (default $50). The CLI takes `--asset YED` on `pay` and
`channel open|close` (`--deposit` is then in cents), `--max-payment-yed` and `--max-deposit-yed`;
`channel refund` of a YED channel carries a TRANSFER of all of D, by default to the channel's
return address. Every channel's remainder (its vouchers, the close, the refund) returns to the
`returnAddress` the client names at open: the WIF key's address (its `ye…` form for YED) or a new
address of the node's wallet, never the channel key, which no wallet watches.

## Facilitator

`packages/facilitator` (`x402-ycash-facilitator`) is a self-hostable x402 facilitator for one Ycash
network, served over HTTP as the x402 v2 specification's §7 describes:

| Route | What it does |
|---|---|
| `POST /verify` | Checks a `{x402Version, paymentPayload, paymentRequirements}` request and writes nothing. It answers 200 with a `VerifyResponse`, or 400 for a malformed request. |
| `POST /settle` | Settles the payment and answers with a `SettleResponse`. A `settlement_pending` response always carries the txid. |
| `GET /supported` | Lists `kinds`, `extensions` and `signers` (empty, since the facilitator signs nothing). Each Ycash kind carries the operator's `extra.confirmations: {minimum, maximum}`. |
| `GET /healthz` | Reports the node's `chain`, `line` (`v4`/`v6`), `subversion`, `yellowback` and `height`. It answers 503 when the node is unreachable or reports a chain that does not match the network. |

Extension outcomes travel in the `EXTENSION-RESPONSES` header (§7.2.1), never in the body. A
mechanism's internal error is logged and is answered only with `unexpected_verify_error` or
`unexpected_settle_error`. Logs are JSON lines on stdout. On SIGTERM the service stops accepting
new requests and finishes in-flight settles first.

The schemes are registered in `packages/facilitator/src/schemes.ts`, one
`facilitator.register(network, scheme)` call each: `exact` (`transparent`, plus `sapling-proof`
when the receipt key and the issued-address registry are configured) and `batch-settlement`.
`sapling-proof` is self-hosted: the facilitator's node must be the merchant's wallet, and the
registry file the one the merchant's server issues into.

```
npm run build
X402_NETWORK=ycash:regtest X402_DEVNET_JSON=…/devnet.json \
X402_SETTLEMENT_STORE=./settlements.json node packages/facilitator/dist/main.js
# or: docker build -f packages/facilitator/Dockerfile -t x402-ycash-facilitator .
```

Configuration comes from the environment. A JSON file named by `X402_FACILITATOR_CONFIG` can also
be used, with the same keys in camelCase; the environment wins over the file.

| Variable | Default | |
|---|---|---|
| `X402_NETWORK` | (required) | `ycash:mainnet`, `ycash:testnet` or `ycash:regtest`. The service refuses to start if the node reports another chain. |
| `X402_RPC_URL` + `X402_RPC_USER` / `X402_RPC_PASSWORD`, or `X402_RPC_COOKIE_FILE` | | The node's RPC. Credentials are sent as UTF-8 basic auth. |
| `X402_DEVNET_JSON`, `X402_DEVNET_NODE` | node `0` | A `yellowback-devnet` node, used instead of `X402_RPC_*`. |
| `X402_SETTLEMENT_STORE` | `x402-ycash-settlements.json` | The txid claim file, shared by every process that settles. |
| `X402_CONFIRMATIONS_MIN`, `X402_CONFIRMATIONS_MAX` | `0`, `20` | The confirmation range this facilitator settles. Settling from the mempool (−1) is an opt-in. |
| `X402_HOST`, `X402_PORT` | `127.0.0.1`, `4022` | The Docker image sets the host to `0.0.0.0`. |
| `X402_CHANNEL_STORE` | `x402-ycash-channels.json` | batch-settlement's record of the channels it relayed (audit). |
| `X402_RECEIPT_KEY` + `X402_ISSUED_REGISTRY` | (unset) | Both turn on `sapling-proof`: the receipt key (64 hex, a secp256k1 private key; never logged) and the issued-address registry file shared with the merchant. |
| `X402_SAPLING_BASE_ADDRESS`, `X402_SAPLING_NOTE_WAIT_MS` | (wallet's), `10000` | The merchant's base Sapling address; how long settle waits for a just-sent note to reach the wallet. |
| `X402_API_KEY` | (unset) | When set, `/verify` and `/settle` require `Authorization: Bearer <key>`. |
| `X402_BODY_LIMIT`, `X402_LOG_LEVEL`, `X402_SHUTDOWN_TIMEOUT_MS`, `X402_NODE_WAIT_MS`, `X402_RPC_TIMEOUT_MS` | `512kb`, `info`, `30000`, `60000`, `30000` | |

### Examples

- `examples/merchant-express` sells its routes through `@x402/express`: `GET /exact/quote` and
  `GET /exact/ticker` (exact, transparent YEC; the ticker is priced under the zero-confirmation cap
  `MERCHANT_ZERO_CONF_CAP_ZAT`, so it is served on mempool acceptance), `GET /channel/search` (a YEC
  channel) and `GET /shielded/report` (shielded YEC to a fresh diversified address per request).
  Exact needs only `FACILITATOR_URL` and `MERCHANT_PAY_TO`. The channel route needs the merchant's
  node (`MERCHANT_DEVNET_JSON` or `MERCHANT_RPC_*`) and `MERCHANT_CHANNEL_KEY` (the server key S,
  64 hex), with `MERCHANT_MAX_DEPOSIT_ZAT`, `MERCHANT_CHANNEL_STORE`, `MERCHANT_MIN_LOCK_BLOCKS`,
  `MERCHANT_CLOSE_MARGIN_BLOCKS`, `MERCHANT_CHANNEL_CONFIRMATIONS` and `MERCHANT_CHANNEL_IDLE_MS`.
  The shielded route needs the node's wallet and `MERCHANT_ISSUED_REGISTRY` (the facilitator's
  `X402_ISSUED_REGISTRY`), with `MERCHANT_SAPLING_BASE_ADDRESS` and
  `MERCHANT_SHIELDED_CONFIRMATIONS`. A route whose mode is not configured answers 501.
- `examples/agent-client` calls a paid route `REQUESTS` times with `@x402/fetch` and pays each 402
  automatically, capped at `MAX_PAYMENT_ZAT` per payment (YEC is allowed explicitly; it is not a
  USD asset). It reads its node (`AGENT_DEVNET_JSON` or `AGENT_RPC_*`) and signs with a key it
  holds (`AGENT_WIF`, its coins listed by the node, or by lightwalletd with `AGENT_LWD_URL` and no
  node at all) or with the node's wallet. It pays exact
  routes, channels (`AGENT_CHANNEL_STORE`, `AGENT_CHANNEL_DEPOSIT_ZAT`) and, with
  `AGENT_SHIELDED_FROM`, sapling-proof routes. Run it with `npm start -w x402-ycash-example-agent-client`.

  Two limits protect the agent's funds, and they are independent of anything the merchant says:
  - **`MAX_PAYMENT_ZAT`**, the spend control, caps each payment's `amount` (and so each channel
    voucher's per-request ceiling).
  - **`AGENT_CHANNEL_MAX_DEPOSIT_ZAT`** (default `100000000`, 1 YEC) caps the deposit D a channel
    locks until its refund height. Spend controls never see D, and the server alone chooses its
    `maxDeposit`, so the client caps it too. The default deposit (`amount` × 100) is capped at both
    limits; an explicit `AGENT_CHANNEL_DEPOSIT_ZAT` above the client's cap refuses the `open`. In
    code: `new BatchYcashClientScheme({ maxDeposit: { YEC: … , YED: … } })`, whose defaults are
    `DEFAULT_CLIENT_MAX_DEPOSIT` (1 YEC and $50).
  - **`AGENT_CHANNEL_MAX_CLOSE_FEE_ZAT`** (default `5000`) caps the server-chosen `closeFee`, which
    is also locked in the channel and paid to miners at close; an offer above it refuses the
    `open` (`maxCloseFee` in code, default `DEFAULT_CLIENT_MAX_CLOSE_FEE`).

  A local-key agent hands its signed transactions to the facilitator or the channel server, which
  broadcast them, often through another node. Until the agent's own node sees such a spend, the
  coin still looks unspent there, so the agent keeps the coins of its signed, unconfirmed spends in
  a reservation file (`AGENT_RESERVATIONS`; default a per-payer file in the OS temp directory). Every
  agent process of the same payer shares it, and a coin is released when its spend confirms or
  expires. A channel funding expires at tip + 3 + 40 blocks (`fundingExpiryBlocks`), so a funding
  the server never relays frees its coins by height. The node-wallet
  signer uses the same file for its YED outputs, which `lockunspent` cannot mark (the Yellowback
  wallet keeps every YED output locked).

### Light agents: lightwalletd instead of a node

An agent that holds a WIF key needs no node of its own: with `AGENT_LWD_URL` (the agent) or
`--lwd host:port` / `X402_LWD_URL` (the CLI) it reads its coins, its YED outputs, the tip and the
branch id from a lightwalletd server and broadcasts its refunds through it. That covers transparent
YEC and YED `exact` payments, channel funding (YEC and YED), `channel status|close|refund`. The
address forms are `grpc://host:port` (plaintext), `grpcs://host:port` (TLS), or a bare `host:port`,
which is TLS unless the host is loopback.

```
# after `yellowback-devnet lightwalletd start --extra=--yellowback` (port 9067) on the devnet:
RESOURCE_URL=http://127.0.0.1:4021/exact/quote AGENT_WIF=<key> AGENT_LWD_URL=127.0.0.1:9067 npm start -w x402-ycash-example-agent-client
npm start -s -w x402-ycash-cli -- channel refund <channelId> --lwd 127.0.0.1:9067 --wif <key> --channels $PWD/scratch/c.json
```

The server must be lightwalletd-dd (`packages/ycash/proto/` is vendored from it) run with
`--yellowback` for YED: `GetAddressTokens` answers the token lookups, and without it YED outputs
cannot be told apart from plain coins, as on a stock node. Its node needs `-insightexplorer` and
`-txindex` (the devnet sets both on node 0). Three things differ from a node:

- **Shielded payments still need a node wallet.** `sapling-proof` pays with `z_sendmany`;
  lightwalletd holds no wallet, and this SDK has no Sapling builder, so `AGENT_SHIELDED_FROM` and
  `--shielded-from` need `AGENT_DEVNET_JSON`/`AGENT_RPC_*` or `--devnet`/`--rpc-url`.
- **Mempool spends are invisible.** `GetAddressUtxos` and `GetAddressTokens` read the node's
  indexes, which hold confirmed outputs and are not updated by mempool spends, and `GetMempoolTx`
  sends only transactions with Sapling parts. The agent's reservation file is what keeps it off a
  coin it already spent; a spend of the same key from elsewhere shows up only as the facilitator's
  broadcast refusal. Change of an unconfirmed payment is spendable once it is mined.
- **The branch id is the tip's.** `GetLightdInfo` reports `consensus.chaintip`, not `nextblock`, so
  on the one block before a network upgrade activates a payment signed now would be refused.

## CLI

`packages/cli` is the `x402-ycash` command (`npm start -s -w x402-ycash-cli -- <args>` with absolute paths, or `x402-ycash`
after `npm run build`):

```
x402-ycash pay <url> [--count N]                 pay a route N times (exact, sapling-proof or a channel voucher)
x402-ycash channel open <url> [--deposit ZAT]    open a channel on the route (pays its first request)
x402-ycash channel status [channelId]            every channel in the store, or one, against the node
x402-ycash channel close <url> [channelId]       the client's close at the charged total; the server broadcasts it
x402-ycash channel refund <channelId> [--to A]   the client alone, from the refund height t
```

It reads its node from `--devnet devnet.json [--node N]` or `--rpc-url` with `--rpc-user` and
`--rpc-password` (or `--rpc-cookie`), or a lightwalletd server from `--lwd host:port` (with `--wif`;
see "Light agents" above), and pays with `--wif` or the node's wallet; the same
settings come from `X402_DEVNET_JSON`, `X402_RPC_*`, `X402_LWD_URL`, `X402_WIF`, `X402_SHIELDED_FROM`,
`X402_CHANNEL_STORE` (default `~/.x402-ycash/channels.json`, a wallet file: it holds channel keys),
`X402_MAX_PAYMENT_ZAT`, `X402_MAX_DEPOSIT_ZAT` (`--max-deposit`, the most one channel may lock;
default 1 YEC), `X402_MAX_CLOSE_FEE_ZAT` (`--max-close-fee`, the largest server `closeFee` a channel
may lock; default 5000) and `X402_RESERVATIONS` (`--reservations`, the coin reservation file; default
`reservations.json` next to the channel store).

MIT licensed.
