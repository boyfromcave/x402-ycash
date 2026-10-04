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
| `x402_ycash.exact` | the `exact` scheme for `transparent` YEC: facilitator (verification rules 1–10, settlement), server (prices, requirements) and a small client |
| `x402_ycash.store` | settlement stores: in-memory, and SQLite (atomic and restart-durable across processes) |
| `x402_ycash.channel` | the YEC payment channel's builders: redeem script, funding, vouchers, server completion, refund |

Not covered yet: the `exact` YED facilitator (rules 4Y/9Y in YED form), `sapling-proof`, and the
`batch-settlement` facilitator and server. The TypeScript package has them.

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

## Server

```python
from x402 import x402ResourceServer
from x402_ycash.exact import FixedPriceSource, register_exact_ycash_server

server = register_exact_ycash_server(x402ResourceServer(facilitator_client), "ycash:mainnet",
                                     price_source=FixedPriceSource(50_000_000))  # $50 per YEC
```

`parse_price` takes `"0.0025 YEC"`, `"25 YED"`, `"$0.10"` (converted to YEC at the price source's
rate, rounded up) or an `AssetAmount`. `YedGetPriceSource(rpc)` reads the overlay's own price from
`yed_getprice` on a Yellowback node. The requirements get `assetTransferMethod: "transparent"`,
`areFeesSponsored: false` and a confirmation policy: −1 up to the zero-confirmation cap (default
$1.00 through the price source), else 1.

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

`tests/unit/test_*_vectors.py` and `test_channel.py` replay `../vectors/tx`, `../vectors/yed` and
`../vectors/channel` exactly as the TypeScript vector tests do.

The devnet suite proves interop with the TypeScript mechanism on a live devnet of either node line:
a payment built by the TypeScript client is verified and settled by the Python facilitator (on the
Yellowback node and on the stock node), and a payment built by the Python client is verified and
settled by the TypeScript facilitator. It needs `npm install` at the repo root.

```bash
export X402_SCRATCH=/path/to/scratch
scripts/devnet.sh up dd 221             # or: up 6 223
X402_DEVNET_JSON=$X402_SCRATCH/dd-221/devnet.json python/.venv/bin/python -m pytest python/tests/devnet
scripts/devnet.sh down dd 221
```
