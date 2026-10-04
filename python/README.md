# x402-ycash for Python

`x402_ycash` is the Ycash mechanism for the [x402 Python SDK](https://pypi.org/project/x402/)
(plan X5, owner decision X-2: a backend SDK, facilitator and server first). It is built from the
language-neutral specs in [`../specs`](../specs) and reproduces every JSON vector in
[`../vectors`](../vectors). The TypeScript package in [`../packages/ycash`](../packages/ycash) is
the reference implementation.

It covers:

| Module | Contents |
|---|---|
| `x402_ycash.tx` | v4 (Sapling version group) codec, ZIP-243 sighash, secp256k1 signing (low-S DER), scripts, Ycash addresses (`s1…`/`sm…`/`s2…`, `ye…`/`yt…`/`yr…`), WIF, the fee floor |
| `x402_ycash.yed` | the Yellowback v3 payload codec (TRANSFER encode, every type decoded, `FindPayload`), the transfer rules and the YED dollar floor |
| `x402_ycash.node` | an async ycashd JSON-RPC client on httpx, for both node lines (4.5.0 and 6.21.0) |
| `x402_ycash.exact` | the `exact` scheme for `transparent` YEC and YED: facilitator (verification rules 1–10 with 4Y/9Y, settlement), server (prices, requirements) and a small client; routes `sapling-proof` to `x402_ycash.shielded` |
| `x402_ycash.shielded` | `sapling-proof`: per-request diversified addresses, the JCS request hash and memo, the issued-address registry (SQLite), settlement against the merchant's wallet, ES256K offer-and-receipt receipts |
| `x402_ycash.batch` | `batch-settlement`, YEC and YED channels: server (the voucher checks, compare-and-set ledger, close triggers, watcher) and facilitator |
| `x402_ycash.store` | settlement and channel stores: in-memory, and SQLite (atomic and restart-durable across processes) |
| `x402_ycash.channel` | the payment channel's builders, YEC and YED: redeem script, funding, vouchers, server completion, refund |

It has every facilitator and server binding the TypeScript package has. Clients: `exact`
transparent YEC only (agents use the TypeScript client).

## Install

```bash
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -e . pytest pytest-asyncio
```

It depends on `x402` (2.25.0 on PyPI, the Python SDK of the upstream checkout this repo follows),
`httpx` and `coincurve`.

## Facilitator

```python
from x402 import x402Facilitator
from x402_ycash.exact import register_exact_ycash_facilitator
from x402_ycash.node import YcashRpc
from x402_ycash.store import SqliteSettlementStore

rpc = YcashRpc("http://127.0.0.1:8232/", "user", "password")
facilitator = register_exact_ycash_facilitator(
    x402Facilitator(), rpc, "ycash:mainnet",
    settlement_store=SqliteSettlementStore("/var/lib/x402/claims.db"),
)
result = await facilitator.verify(payload, requirements)
settled = await facilitator.settle(payload, requirements)
```

A facilitator serves the chain its node runs (rule 2). It signs nothing and holds no keys:
`/supported` lists no signers. The settlement store must be shared by every process that serves
`/settle` (spec "Duplicate Settlement Mitigation"); the SQLite store is, on one host.
`accept_mempool=False` refuses confirmation policy −1. `confirmation_timeout` (default 75 s)
bounds one settle's wait before it answers `settlement_pending`.

For a devnet, `YcashRpc.from_devnet_json(path, node)` strips the URL's userinfo and sends the
credentials as UTF-8 basic auth (they contain emoji).

A Yellowback node (`-experimentalfeatures -yellowback`) also settles YED: pass `yellowback=True`
so `/supported` lists YED (verification asks the node either way; a stock node answers
`invalid_exact_ycash_yed_node_required`). The payer of a YED payment is reported in its `ye…` form.

## Server

```python
from x402 import x402ResourceServer
from x402_ycash.exact import FixedPriceSource, register_exact_ycash_server

server = register_exact_ycash_server(x402ResourceServer(facilitator_client), "ycash:mainnet",
                                     price_source=FixedPriceSource(50_000_000))  # $50 per YEC
```

`parse_price` takes `"0.0025 YEC"`, `"25 YED"`, `"$0.10"` (converted to YEC at the price source's
rate, rounded up; with `usd_asset="YED"`, YED cents at par, at least $1.00) or an `AssetAmount`.
A YED requirement is refused against a facilitator whose `/supported` does not list YED. `YedGetPriceSource(rpc)` reads the overlay's own price from
`yed_getprice` on a Yellowback node. The requirements get `assetTransferMethod: "transparent"`,
`areFeesSponsored: false` and a confirmation policy: −1 up to the zero-confirmation cap (default
$1.00 through the price source), else 1.

## sapling-proof

```python
from x402_ycash.shielded import SaplingProofHandler, SqliteIssuedAddressRegistry

handler = SaplingProofHandler("ycash:mainnet", merchant_wallet_rpc, SqliteSettlementStore("/var/lib/x402/claims.db"),
                              receipt_key=receipt_priv_key, registry=SqliteIssuedAddressRegistry("/var/lib/x402/issued.db"))
facilitator = register_exact_ycash_facilitator(x402Facilitator(), merchant_wallet_rpc, "ycash:mainnet", shielded=handler)
issuer = handler.route_issuer(amount="1500000", max_timeout_seconds=900, confirmations=1)
server = register_exact_ycash_server(x402ResourceServer(facilitator_client), "ycash:mainnet", shielded=issuer)
# the route: pay_to=issuer.pay_to (a DynamicPayTo: a fresh diversified address per request)
```

The facilitator is self-hosted with the merchant's wallet, which alone can decrypt the note. Settle
runs the spec's nine steps; while the wallet has no note of the txid it retries for `note_wait`
seconds (default 10), claiming nothing. The consumption key is `ycash:<net>:<txid>@<payTo>`; only
policy −1 accepts a mempool note. A success carries an ES256K JWS receipt
(`extensions["offer-receipt"].info.receipt`, kid a did:jwk), byte-identical to the TypeScript
`signReceipt` for the same key and time (`vectors/shielded`).

## batch-settlement

```python
from x402_ycash.batch import register_batch_ycash_facilitator, register_batch_ycash_server
from x402_ycash.store import SqliteChannelStore

register_batch_ycash_facilitator(facilitator, rpc, "ycash:mainnet", settlement_store=claims)
scheme = register_batch_ycash_server(server, rpc, server_priv_key, "ycash:mainnet", max_deposit=100_000_000,
                                     store=SqliteChannelStore("/var/lib/x402/channels.db"), usd_asset="YED")
watcher = scheme.manager.watcher()
watcher.start()  # on the server's event loop: closes at t − margin and on idle, resuming from the store
```

The server scheme's hooks (`before_verify`, `after_verify`, `before_settle`,
`on_verified_payment_canceled`) are coroutines: register it on the async `x402ResourceServer`. They
verify each voucher before the handler (skipping the facilitator) and commit the settle-time
`requirements.amount` after it. A YED channel needs a Yellowback node: the overlay checks every
voucher (split at vout 2, verdict `ok`, burned 0, yedIn = D), and no voucher carries less than
$1.00 (the first one pre-pays it).

Every `open` names the client's `returnAddress` (a transparent P2PKH or P2SH address for YEC, a
P2PKH `s…` or `ye…` address for YED, never `payTo`). The server records it with the channel and
refuses any voucher whose client output pays elsewhere. The facilitator records it for the opens it
relays and binds it in those channels' later vouchers and claims. For a channel it never saw open,
it takes the client script from the voucher's vout 1. The server refuses a funding transaction that
is not yet in a block and whose non-zero `nExpiryHeight` is below tip + 3 + the policy depth.

A closed channel's records are retired for `closed_retention_ms` (default 30 days) and then
pruned. `ChannelStore.list()` prunes first, so a restarted server's `resume()` only walks the open
channels and the retention window. An open or closing channel is never retired.

## Design notes

- **Sync protocols, async node client.** Upstream's Python scheme protocols are synchronous:
  `x402Facilitator.verify` calls `scheme.verify(...)` without awaiting it. The mechanism's logic
  is async (`averify`, `asettle`, `acreate_payment_payload`). The sync methods run it on one
  private event-loop thread (`x402_ycash._sync`), which works whether or not the caller is inside
  a running loop. `YcashRpc` keeps one `httpx.AsyncClient` per event loop. Asyncio callers can
  await the async methods directly and skip the bridge.
- **coincurve, not ecdsa.** coincurve binds libsecp256k1, the library both node lines sign with,
  using RFC 6979 and no extra entropy. Its signatures are therefore byte-identical to
  `signrawtransaction`'s, which the vectors check. libsecp256k1 always emits low-S and rejects high-S
  when verifying, which is the relay rule of both lines. It is also constant-time. The pure-Python
  `ecdsa` package would need its own low-S normalisation and is not constant-time.
- **Exact amounts.** JSON numbers from the node are parsed as `Decimal`, and amounts are sent as
  8-decimal strings built from integer zatoshis, never as floats.
- **RIPEMD-160.** `hashlib` provides it only where OpenSSL's legacy provider is available, so
  `tx.hashes` falls back to a pure-Python implementation, checked against reference vectors.

## Tests

```bash
.venv/bin/python -m pytest              # unit and vector tests (tests/unit)
```

`tests/unit/test_*_vectors.py`, `test_channel.py`, `test_channel_yed.py`, `test_batch.py` and `test_batch_return.py` replay
`../vectors/tx`, `../vectors/yed`, `../vectors/channel`, `../vectors/yed-channel` and
`../vectors/shielded` exactly as the TypeScript vector tests do.

The devnet suites prove interop with the TypeScript mechanism on a live devnet of either node line.
`test_interop.py`: a payment built by the TypeScript client is verified and settled by the Python
facilitator (on the Yellowback node and on the stock node), and a payment built by the Python client
is verified and settled by the TypeScript facilitator. `test_parity.py`: a TypeScript agent pays a
YED exact requirement settled in Python; a TypeScript client pays `sapling-proof` requirements
issued and settled in Python, the receipts verified in TypeScript; a TypeScript batch client runs a
50-request YEC channel and a 20-request one-cent YED channel against the Python server, closed by
Python. They need `npm install` at the repo root.

```bash
export X402_SCRATCH=/path/to/scratch
scripts/devnet.sh up dd 221             # or: up 6 223
X402_DEVNET_JSON=$X402_SCRATCH/dd-221/devnet.json python/.venv/bin/python -m pytest python/tests/devnet
scripts/devnet.sh down dd 221
```
