// Where the Ycash client-side schemes plug into the agent. One `client.register` call per scheme;
// which one pays is the route's choice (its 402 offers one scheme and method).
import type { x402Client } from "@x402/fetch";
import {
  ASSET_YEC,
  ASSET_YED,
  batch,
  BatchYcashClientScheme,
  exact,
  FileClientChannelStorage,
  FileCoinReservationStore,
  LightClientShieldedPayer,
  LwdChain,
  LwdUtxoSource,
  rpcWalletFunder,
  type LightClient,
  SaplingExactClient,
  saplingBuilderFrom,
  ShieldedExactClient,
  utxoSourceFunder,
  type LwdClient,
  type YcashNetwork,
  type YcashRpc,
} from "x402-ycash-mechanism";
import type { AgentSigner } from "./config.js";

export interface ClientSchemeDeps {
  network: YcashNetwork;
  /** Absent only with `lwd` and a WIF signer (loadAgentConfig checks). */
  node?: YcashRpc;
  /** lightwalletd in place of the node for a WIF signer's coins, tip and broadcast. */
  lwd?: LwdClient;
  signer: AgentSigner;
  shieldedFrom?: string;
  /** sapling: the builder spec (AGENT_SAPLING_BUILDER). */
  saplingBuilder?: string;
  /** The light client behind an http(s) AGENT_SAPLING_BUILDER: sapling builder, tip, and sapling-proof payer. */
  light?: LightClient;
  channelStorePath?: string;
  channelDepositZat?: bigint;
  /** batch-settlement: the client's own cap on D, zatoshis (default 1 YEC). */
  channelMaxDepositZat?: bigint;
  /** Coins held by signed, unconfirmed spends, shared by every agent process of this payer. */
  reservationsPath?: string;
  /** YED channels: D of a new channel, cents. */
  yedChannelDepositCents?: bigint;
  /** YED channels: the client's cap on D, cents (default $50). */
  yedChannelMaxDepositCents?: bigint;
  /** batch-settlement: the largest server closeFee accepted, zatoshis, for both assets (default 5,000). */
  channelMaxCloseFeeZat?: bigint;
}

/**
 * D for a new channel, in the channel's asset: the configured deposit for that asset, else the
 * scheme's default (amount × 100); always within the server's maxDeposit. The client's own cap
 * (`maxDeposit`) is the scheme's check: a configured D above it is refused, the default is clipped.
 */
export function channelDeposit(byAsset: Partial<Record<string, bigint>>, caps: Partial<Record<string, bigint>>): (t: batch.BatchTerms) => bigint {
  return (t) => {
    let d = byAsset[t.asset];
    if (d === undefined) {
      d = t.amount * 100n;
      const cap = caps[t.asset] ?? batch.client.DEFAULT_CLIENT_MAX_DEPOSIT[t.asset];
      if (cap !== undefined && d > cap) d = cap;
    }
    return d < t.maxDeposit ? d : t.maxDeposit;
  };
}

export interface ClientSchemes {
  names: string[];
  /** The channel client, for status, close and refund. */
  batch?: BatchYcashClientScheme;
}

export type RegisterClientSchemes = (client: x402Client, deps: ClientSchemeDeps) => ClientSchemes;

function needNode(deps: ClientSchemeDeps): YcashRpc {
  if (!deps.node) throw new Error("this payment method needs the agent's node (AGENT_DEVNET_JSON or AGENT_RPC_URL)");
  return deps.node;
}

export const registerClientSchemes: RegisterClientSchemes = (client, deps) => {
  // A WIF signer reads its coins from lightwalletd (AGENT_LWD_URL) or from the node, which watches
  // its address (importaddress).
  const reservations = deps.reservationsPath ? new FileCoinReservationStore(deps.reservationsPath) : undefined;
  const held = reservations ? { reservations } : {};
  const wif = deps.signer.kind === "wif";
  const source = wif ? (deps.lwd ? new LwdUtxoSource(deps.lwd, held) : new exact.RpcUtxoSource(needNode(deps), { importAddress: true, ...held })) : undefined;
  // A private agent (signer "none") has no transparent payer: only its shielded methods are registered.
  const privateOnly = deps.signer.kind === "none";

  // exact: transparent (the client signs a complete v4 tx and does not broadcast) and, with a
  // Sapling source, sapling-proof (z_sendmany to the per-request address, then the txid).
  const transparent = privateOnly
    ? undefined
    : new exact.ExactYcashScheme(deps.signer.kind === "wif" && source ? new exact.LocalKeySigner(deps.signer.wif, source) : new exact.RpcWalletSigner(needNode(deps), held));
  // sapling-proof: the node wallet's z_sendmany from AGENT_SHIELDED_FROM, else the light client's send.
  const shielded = deps.shieldedFrom ? new ShieldedExactClient({ rpc: needNode(deps), from: deps.shieldedFrom }) : deps.light ? new LightClientShieldedPayer({ light: deps.light }) : undefined;
  // sapling: a signed, unbroadcast Sapling transaction from the external builder; the client sets
  // nExpiryHeight itself from the tip (the node's, else the light client's lightwalletd's).
  const chain = deps.node ?? deps.light;
  const sapling = deps.saplingBuilder ? new SaplingExactClient({ builder: deps.light ?? saplingBuilderFrom(deps.saplingBuilder), ...(chain ? { chain } : {}) }) : undefined;
  const router = new exact.ExactYcashMethodRouter({ ...(transparent ? { transparent } : {}), ...(shielded ? { shielded } : {}), ...(sapling ? { sapling } : {}) });
  client.register(deps.network, router);
  if (privateOnly) return { names: [`exact (${router.methods.join(", ")})`] };

  // batch-settlement: opens a channel on the first 402, then one voucher per request.
  // YEC or YED, as the route's 402 asks: the WIF funder spends the key's token outputs for YED.
  // The channel's remainder returns to the funder: the WIF key's address or a new wallet address.
  const funder = deps.signer.kind === "wif" && source ? utxoSourceFunder(deps.signer.privKey, source) : rpcWalletFunder(needNode(deps), held);
  const deposits = {
    ...(deps.channelDepositZat !== undefined ? { [ASSET_YEC]: deps.channelDepositZat } : {}),
    ...(deps.yedChannelDepositCents !== undefined ? { [ASSET_YED]: deps.yedChannelDepositCents } : {}),
  };
  const maxDeposit = {
    ...(deps.channelMaxDepositZat !== undefined ? { [ASSET_YEC]: deps.channelMaxDepositZat } : {}),
    ...(deps.yedChannelMaxDepositCents !== undefined ? { [ASSET_YED]: deps.yedChannelMaxDepositCents } : {}),
  };
  const channels = new BatchYcashClientScheme({
    chain: deps.lwd ? new LwdChain(deps.lwd) : needNode(deps),
    funder,
    ...(deps.channelStorePath ? { storage: new FileClientChannelStorage(deps.channelStorePath) } : {}),
    // A deposit is in its asset's unit (zatoshis or cents), so it applies to that asset's channels only.
    ...(Object.keys(deposits).length > 0 ? { deposit: channelDeposit(deposits, maxDeposit) } : {}),
    ...(Object.keys(maxDeposit).length > 0 ? { maxDeposit } : {}),
    ...(deps.channelMaxCloseFeeZat !== undefined ? { maxCloseFee: { [ASSET_YEC]: deps.channelMaxCloseFeeZat, [ASSET_YED]: deps.channelMaxCloseFeeZat } } : {}),
  });
  client.register(deps.network, channels);

  return { names: [`exact (${router.methods.join(", ")})`, "batch-settlement"], batch: channels };
};
