// The paying client: the same wiring as the agent example (examples/agent-client/src/schemes.ts),
// with the channel records in a file so `channel status|close|refund` find what `pay` opened.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { BatchYcashClientScheme, exact, FileClientChannelStorage, FileCoinReservationStore, rpcWalletFunder, ShieldedExactClient, tx, utxoSourceFunder } from "x402-ycash-mechanism";
import type { CliConfig } from "./config.js";

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
  const funder = config.wif && source ? utxoSourceFunder(tx.decodeWif(config.wif, config.network).privKey, source) : rpcWalletFunder(node, held);
  const deposit = config.depositZat;
  const batch = new BatchYcashClientScheme({
    chain: node,
    funder,
    storage,
    ...(deposit !== undefined ? { deposit: (t) => (deposit < t.maxDeposit ? deposit : t.maxDeposit) } : {}),
    ...(config.maxDepositZat !== undefined ? { maxDeposit: { YEC: config.maxDepositZat } } : {}),
  });
  const client = new x402Client()
    .register(config.network, new exact.ExactYcashMethodRouter({ transparent, ...(shielded ? { shielded } : {}) }))
    .register(config.network, batch);
  // YEC is not USD-pegged, so it needs an explicit allowance with an atomic cap (spec "Assets and Amounts").
  client.setSpendControls({ allowedAssets: [exact.yecSpendControl(config.network, config.maxPaymentZat)] });
  return { client, http: new x402HTTPClient(client), batch, storage };
}
