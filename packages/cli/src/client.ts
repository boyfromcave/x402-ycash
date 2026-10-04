// The paying client: the same wiring as the agent example (examples/agent-client/src/schemes.ts),
// with the channel records in a file so `channel status|close|refund` find what `pay` opened.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ASSET_YEC, ASSET_YED, BatchYcashClientScheme, exact, FileClientChannelStorage, FileCoinReservationStore, rpcWalletFunder, ShieldedExactClient, tx, batch as B } from "x402-ycash-mechanism";
import type { CliConfig } from "./config.js";
import { wifChannelFunder } from "./funder.js";

/**
 * D for a new channel: the configured deposit of its asset (zatoshis or cents), within the
 * server's maxDeposit. Without one the scheme's default applies (amount × 100, clipped at both caps).
 */
export function depositFor(config: Pick<CliConfig, "depositZat" | "depositCents" | "maxDepositZat" | "maxDepositCents">): ((t: B.BatchTerms) => bigint) | undefined {
  const byAsset: Partial<Record<string, bigint>> = { [ASSET_YEC]: config.depositZat, [ASSET_YED]: config.depositCents };
  const caps: Partial<Record<string, bigint>> = { [ASSET_YEC]: config.maxDepositZat, [ASSET_YED]: config.maxDepositCents };
  if (config.depositZat === undefined && config.depositCents === undefined) return undefined;
  return (t) => {
    let d = byAsset[t.asset];
    if (d === undefined) {
      // the scheme's own default, which a deposit callback replaces: amount × 100 clipped at the client's cap
      d = t.amount * 100n;
      const cap = caps[t.asset] ?? B.client.DEFAULT_CLIENT_MAX_DEPOSIT[t.asset];
      if (cap !== undefined && d > cap) d = cap;
    }
    return d < t.maxDeposit ? d : t.maxDeposit;
  };
}

export interface PayingClient {
  client: x402Client;
  http: x402HTTPClient;
  batch: BatchYcashClientScheme;
  storage: FileClientChannelStorage;
}

export function buildClient(config: CliConfig): PayingClient {
  mkdirSync(dirname(config.channelStorePath), { recursive: true });
  const storage = new FileClientChannelStorage(config.channelStorePath);
  const node = config.node;
  const held = { reservations: new FileCoinReservationStore(config.reservationsPath) };
  const source = config.wif ? new exact.RpcUtxoSource(node, { importAddress: true, ...held }) : undefined;
  const transparent = new exact.ExactYcashScheme(config.wif && source ? new exact.LocalKeySigner(config.wif, source) : new exact.RpcWalletSigner(node, held));
  const shielded = config.shieldedFrom ? new ShieldedExactClient({ rpc: node, from: config.shieldedFrom }) : undefined;
  const funder = config.wif && source ? wifChannelFunder(tx.decodeWif(config.wif, config.network).privKey, source) : rpcWalletFunder(node, held);
  const deposit = depositFor(config);
  const maxDeposit = {
    ...(config.maxDepositZat !== undefined ? { [ASSET_YEC]: config.maxDepositZat } : {}),
    ...(config.maxDepositCents !== undefined ? { [ASSET_YED]: config.maxDepositCents } : {}),
  };
  const channels = new BatchYcashClientScheme({
    chain: node,
    funder,
    storage,
    ...(deposit ? { deposit } : {}),
    ...(Object.keys(maxDeposit).length > 0 ? { maxDeposit } : {}),
  });
  const client = new x402Client()
    .register(config.network, new exact.ExactYcashMethodRouter({ transparent, ...(shielded ? { shielded } : {}) }))
    .register(config.network, channels);
  // YEC is not USD-pegged, so it needs an explicit allowance with an atomic cap (spec "Assets and
  // Amounts"); YED is a default asset with core's $1 cap (X-F43), replaced by the CLI's own in cents.
  client.setSpendControls({
    allowedAssets: [
      exact.yecSpendControl(config.network, config.maxPaymentZat),
      { network: config.network, asset: ASSET_YED, maxAmountPerPayment: config.maxPaymentYedCents.toString() },
    ],
  });
  const asset = config.asset;
  if (asset) client.registerPolicy((_v, reqs) => reqs.filter((r) => r.asset === asset));
  return { client, http: new x402HTTPClient(client), batch: channels, storage };
}
