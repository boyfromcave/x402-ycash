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
packages/ycash/   the x402 mechanism (TypeScript, on @x402/core v2): tx, yed, channel, exact, batch, node, store
packages/facilitator/  the standalone facilitator service: /verify, /settle, /supported, /healthz
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
```

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
`facilitator.register(network, scheme)` call each: `exact` (`transparent`, `sapling-proof`) and
`batch-settlement`. Until those are wired, `/supported` lists no kinds.

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
| `X402_API_KEY` | (unset) | When set, `/verify` and `/settle` require `Authorization: Bearer <key>`. |
| `X402_BODY_LIMIT`, `X402_LOG_LEVEL`, `X402_SHUTDOWN_TIMEOUT_MS`, `X402_NODE_WAIT_MS`, `X402_RPC_TIMEOUT_MS` | `512kb`, `info`, `30000`, `60000`, `30000` | |

### Examples

- `examples/merchant-express` sells one route per payment mode through `@x402/express`:
  `GET /exact/quote` (exact, transparent YEC), `GET /channel/search` (a YEC channel) and
  `GET /shielded/report` (shielded YEC). Set `FACILITATOR_URL`, `MERCHANT_PAY_TO` and
  `X402_NETWORK`, then run `npm start -w x402-ycash-example-merchant-express`. A route answers 501
  until its scheme is registered in `src/schemes.ts`.
- `examples/agent-client` calls a paid route `REQUESTS` times with `@x402/fetch` and pays each 402
  automatically, capped at `MAX_PAYMENT_ZAT` per payment. It signs with a key it holds
  (`AGENT_WIF`) or with its node's wallet (`AGENT_SIGNER=node` plus `AGENT_RPC_*` or
  `AGENT_DEVNET_JSON`). Run it with `npm start -w x402-ycash-example-agent-client`.

MIT licensed.
