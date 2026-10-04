// The paying client: the same wiring as the agent example (examples/agent-client/src/schemes.ts),
// with the channel records in a file so `channel status|close|refund` find what `pay` opened.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import {
  ASSET_YEC,
  ASSET_YED,
  BatchYcashClientScheme,
  exact,
  FileClientChannelStorage,
  FileCoinReservationStore,
  LightClientShieldedPayer,
  LwdChain,
  LwdUtxoSource,
  rpcWalletFunder,
  SaplingExactClient,
  saplingBuilderFrom,
  ShieldedExactClient,
  tx,
  utxoSourceFunder,
  batch as B,
} from "x402-ycash-mechanism";
import type { CliConfig } from "./config.js";

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

/** loadCliConfig guarantees a node wherever there is no WIF key and lightwalletd. */
function mustNode<T>(node: T | undefined): T {
  if (node === undefined) throw new Error("this needs a node (--devnet or --rpc-url)");
  return node;
}

export interface PayingClient {
  client: x402Client;
  http: x402HTTPClient;
  /** Absent when the only payer is the light client (shielded methods only). */
  batch?: BatchYcashClientScheme;
  storage: FileClientChannelStorage;
}

export function buildClient(config: CliConfig): PayingClient {
  mkdirSync(dirname(config.channelStorePath), { recursive: true });
  const storage = new FileClientChannelStorage(config.channelStorePath);
  const node = config.node;
  const held = { reservations: new FileCoinReservationStore(config.reservationsPath) };
  // A WIF key reads its coins from lightwalletd (--lwd) or from the node, which watches its address.
  const source = config.wif ? (config.lwd ? new LwdUtxoSource(config.lwd, held) : new exact.RpcUtxoSource(mustNode(node), { importAddress: true, ...held })) : undefined;
  // A light-client-only CLI (--sapling-builder http://… alone) has no transparent payer and no channels.
  const privateOnly = !node && !config.wif;
  const transparent = privateOnly ? undefined : new exact.ExactYcashScheme(config.wif && source ? new exact.LocalKeySigner(config.wif, source) : new exact.RpcWalletSigner(mustNode(node), held));
  // sapling-proof: the node wallet's z_sendmany from --shielded-from, else the light client's send.
  const shielded = config.shieldedFrom ? new ShieldedExactClient({ rpc: mustNode(node), from: config.shieldedFrom }) : config.light ? new LightClientShieldedPayer({ light: config.light }) : undefined;
  // sapling: the external builder signs, nothing is broadcast here; the tip for nExpiryHeight comes
  // from the node, else from the light client.
  const chain = node ?? config.light;
  const sapling = config.saplingBuilder ? new SaplingExactClient({ builder: config.light ?? saplingBuilderFrom(config.saplingBuilder), ...(chain ? { chain } : {}) }) : undefined;
  const router = new exact.ExactYcashMethodRouter({ ...(transparent ? { transparent } : {}), ...(shielded ? { shielded } : {}), ...(sapling ? { sapling } : {}) });
  if (privateOnly) {
    const client = new x402Client().register(config.network, router);
    client.setSpendControls({ allowedAssets: [exact.yecSpendControl(config.network, config.maxPaymentZat)] });
    return { client, http: new x402HTTPClient(client), storage };
  }
  // Both assets; the channel's remainder returns to the WIF key's address or a new wallet address.
  const funder = config.wif && source ? utxoSourceFunder(tx.decodeWif(config.wif, config.network).privKey, source) : rpcWalletFunder(mustNode(node), held);
  const deposit = depositFor(config);
  const maxDeposit = {
    ...(config.maxDepositZat !== undefined ? { [ASSET_YEC]: config.maxDepositZat } : {}),
    ...(config.maxDepositCents !== undefined ? { [ASSET_YED]: config.maxDepositCents } : {}),
  };
  const channels = new BatchYcashClientScheme({
    // The tip, the channel output's state and the refund's broadcast: lightwalletd or the node.
    chain: config.lwd ? new LwdChain(config.lwd) : mustNode(node),
    funder,
    storage,
    ...(deposit ? { deposit } : {}),
    ...(Object.keys(maxDeposit).length > 0 ? { maxDeposit } : {}),
    ...(config.maxCloseFeeZat !== undefined ? { maxCloseFee: { [ASSET_YEC]: config.maxCloseFeeZat, [ASSET_YED]: config.maxCloseFeeZat } } : {}),
  });
  const client = new x402Client()
    .register(config.network, router)
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
