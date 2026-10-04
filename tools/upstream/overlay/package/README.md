# @x402/ycash

x402 Payment Protocol — Ycash implementation of the `exact` and `batch-settlement` schemes.

This package implements the [`exact` scheme on Ycash](../../../../specs/schemes/exact/scheme_exact_ycash.md) and the [`batch-settlement` scheme on Ycash](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_ycash.md). Ycash is a Zcash-lineage UTXO chain with a transparent pool and a Sapling shielded pool; it has no smart contracts, no account nonces and no signed-transfer authorization, and the binding needs none of them. Every transaction it produces is a standard transparent v4 or Sapling transaction, so node and pool operators change nothing. It provides:

- A **client scheme** (`@x402/ycash/exact/client`) that builds and signs a complete transparent v4 transaction paying `payTo` exactly, and never broadcasts it. Signers are pluggable: `LocalKeySigner` (a WIF key with a UTXO source such as `RpcUtxoSource`) or `RpcWalletSigner` (a `ycashd` wallet).
- A **facilitator scheme** (`@x402/ycash/exact/facilitator`) that verifies the transaction against its own node per the spec's rules (recipient and amount, `SIGHASH_ALL` on every input, unspent inputs, fee floor, expiry window, the node's script verifier), relays it, and deduplicates settlements by txid in a `SettlementStore` shared by every process serving `/settle`. The facilitator holds no keys and pays no fee.
- A **server scheme** (`@x402/ycash/exact/server`) that parses YEC prices (`"0.0025 YEC"`, or `{ amount, asset: "YEC" }` in zatoshis), YED prices in cents, and `"$0.10"` through an optional price source, and fills in `extra` (`assetTransferMethod`, `confirmationPolicy`).
- **Payment channels** (`@x402/ycash/batch-settlement/{client,server,facilitator}`): a one-way channel in a 2-of-2 P2SH output with a CLTV refund. The client locks a deposit once and signs a cumulative voucher per request; the server verifies vouchers itself, serves immediately, and closes with one transaction for the whole session.

## Networks

| Network | Identifier      | `getblockchaininfo.chain` |
| ------- | --------------- | ------------------------- |
| Mainnet | `ycash:mainnet` | `main`                    |
| Testnet | `ycash:testnet` | `test`                    |
| Regtest | `ycash:regtest` | `regtest`                 |

These identifiers are CAIP-2 syntax over the unregistered `ycash` namespace, following Cardano's `cardano:mainnet` form. A genesis-hash form cannot be used: Ycash forked from Zcash and shares its genesis blocks. The facilitator checks `network` against the chain its node reports, and the ZIP-243 signature hash binds the consensus branch id, so a transaction signed for one network never validates on another.

Transparent addresses are `s1…` (P2PKH) and `s2…`/`s3…` (P2SH) on mainnet; testnet and regtest share `sm…` (P2PKH) and `s2…` (P2SH), so the network always comes from the payment requirements.

## Assets

| Asset | Unit                    | Notes                                                                                                                                                                                                         |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YEC` | zatoshis (10⁻⁸ YEC)     | The native coin. Not USD-pegged: an `x402Client` needs a `spendControls.allowedAssets` entry (`yecSpendControl(network, maxZat)`).                                                                             |
| `YED` | cents (2 decimals)      | The dollar of Ycash Yellowback, an overlay on the node. Needs a facilitator node run with `-experimentalfeatures -yellowback`. One YED output holds at least $1.00, so YED below $1.00 per request uses channels. |

`findDefaultAsset` reports YED as the network's dollar asset, so core's default spend controls apply to it.

## Usage

```typescript
import { YcashRpc } from "@x402/ycash";
import { ExactYcashScheme, LocalKeySigner, RpcUtxoSource, yecSpendControl } from "@x402/ycash/exact/client";
import { ExactYcashServerScheme } from "@x402/ycash/exact/server";
import { ExactYcashFacilitatorScheme } from "@x402/ycash/exact/facilitator";

const rpc = new YcashRpc({ url: "http://127.0.0.1:8232/", user: "rpcuser", password: "rpcpassword" });

// Client (payer): its own key; a node it trusts lists the key's coins and reports the tip.
const signer = new LocalKeySigner(process.env.YCASH_WIF!, new RpcUtxoSource(rpc, { importAddress: "rescan" }));
const client = x402Client.fromConfig({
  schemes: [{ network: "ycash:*", client: new ExactYcashScheme(signer) }],
  spendControls: { allowedAssets: [yecSpendControl("ycash:mainnet", 1_000_000n)] }, // ≤ 0.01 YEC per payment
});

// Resource server: payments up to 0.01 YEC settle at the mempool (confirmation policy -1).
server.register("ycash:mainnet", new ExactYcashServerScheme({ zeroConfCapZat: 1_000_000n }));

// Facilitator: verify against its own node, relay, deduplicate by txid.
facilitator.register("ycash:mainnet", new ExactYcashFacilitatorScheme(rpc, { settlementStore }));
```

Use a file- or database-backed `SettlementStore` (`FileSettlementStore` ships here) when more than one process serves `/settle`.

## Confirmation policy

`extra.confirmationPolicy.confirmations` runs from `-1` (accepted into the facilitator's mempool) to `20`. Blocks come every 75 seconds. The server's `zeroConfCapZat` sets the default: up to the cap, `-1`; above it, `1`. A zero-confirmation payment can still be double-spent by its payer after the handler has run; neither node line replaces a mempool transaction, and the facilitator re-checks inputs at settle, so the window is a direct conflicting broadcast. Use channels for volume.

## Asset transfer methods

- `transparent` (default) — facilitator-submitted: the payer signs, the facilitator relays during settle (`authorization` flow).
- `sapling-proof` — client-submitted, shielded YEC: the client pays a per-request diversified Sapling address and presents the txid (`upfront` flow). It needs a self-hosted facilitator on the merchant's own node (it holds the merchant's viewing key) and returns an `offer-and-receipt` JWS receipt. See `SaplingProofHandler`.
- `sapling` — facilitator-submitted, shielded YEC: the client builds and signs a complete Sapling transaction to a per-request diversified address and hands it over unbroadcast (`authorization` flow); the merchant's own facilitator trial-decrypts the payment with the merchant's incoming viewing key before the resource runs (`SaplingExactFacilitator`, `SaplingHandler`; `ShieldedMethodRouter` serves both shielded methods) and broadcasts it at settle. Neither node line builds a shielded transaction without broadcasting it, so the client side (`SaplingExactClient`) takes a `SaplingTransactionBuilder`: `JsonRpcSaplingBuilder` or `LightClient` for any process that answers the JSON-RPC `build` method, `CommandSaplingBuilder` for a command. The reference builder is the Rust Sapling light client `x402-light` in [`boyfromcave/x402-ycash`](https://github.com/boyfromcave/x402-ycash) (`light/`, its JSON-RPC in `light/schema.json`). Facilitators SHOULD NOT offer `sapling` on `ycash:mainnet` until it has run there (spec, `sapling`, Pending).

## Payment channels

The client funds `D + closeFee` into the channel output; every voucher is a complete transaction spending it, signed by the client, paying the server the cumulative charge and the remainder to the client's `returnAddress`. The server adds its signature and broadcasts the latest voucher to close; the client can refund alone from the refund height. YED channels carry a Yellowback TRANSFER on every spend and follow a dollar floor: the first voucher pre-pays at least $1.00, and a client remainder below $1.00 goes to the server.

## Testing

```bash
pnpm test               # unit tests, including vectors produced by both Ycash node lines
pnpm test:integration   # in-process client/server/facilitator flows; devnet suites when configured
```

The integration config also runs `test/integrations/*.devnet.test.ts` against a Ycash regtest network when `X402_DEVNET_JSON` names its node list (a JSON file with `num_nodes` and `rpc.<n> = { url, user, password }`; node 0 holds a funded wallet), and skips them otherwise. Ycash testnet had no reachable seeds when this package was written, so live runs use regtest; see `e2e/README.md`, "Ycash (regtest)".

Comments cite node behaviour by the ids of the specs' Appendix A (R-1, S-5, Y-9, …), and node source as `Ycash 4.5.0 src/…` or `Ycash 6.21.0 src/…` at the commits that appendix names.
