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
  rpcWalletFunder,
  ShieldedExactClient,
  type YcashNetwork,
  type YcashRpc,
} from "x402-ycash-mechanism";
import type { AgentSigner } from "./config.js";
import { wifChannelFunder } from "./funder.js";

export interface ClientSchemeDeps {
  network: YcashNetwork;
  node: YcashRpc;
  signer: AgentSigner;
  shieldedFrom?: string;
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

export const registerClientSchemes: RegisterClientSchemes = (client, deps) => {
  // A WIF signer reads its coins from the node, which watches its address (importaddress).
  const reservations = deps.reservationsPath ? new FileCoinReservationStore(deps.reservationsPath) : undefined;
  const held = reservations ? { reservations } : {};
  const source = deps.signer.kind === "wif" ? new exact.RpcUtxoSource(deps.node, { importAddress: true, ...held }) : undefined;

  // exact: transparent (the client signs a complete v4 tx and does not broadcast) and, with a
  // Sapling source, sapling-proof (z_sendmany to the per-request address, then the txid).
  const transparent = new exact.ExactYcashScheme(
    deps.signer.kind === "wif" && source ? new exact.LocalKeySigner(deps.signer.wif, source) : new exact.RpcWalletSigner(deps.node, held),
  );
  const shielded = deps.shieldedFrom ? new ShieldedExactClient({ rpc: deps.node, from: deps.shieldedFrom }) : undefined;
  const router = new exact.ExactYcashMethodRouter({ transparent, ...(shielded ? { shielded } : {}) });
  client.register(deps.network, router);

  // batch-settlement: opens a channel on the first 402, then one voucher per request.
  // YEC or YED, as the route's 402 asks: the WIF funder spends the key's token outputs for YED.
  const funder = deps.signer.kind === "wif" && source ? wifChannelFunder(deps.signer.privKey, source) : rpcWalletFunder(deps.node, held);
  const deposits = {
    ...(deps.channelDepositZat !== undefined ? { [ASSET_YEC]: deps.channelDepositZat } : {}),
    ...(deps.yedChannelDepositCents !== undefined ? { [ASSET_YED]: deps.yedChannelDepositCents } : {}),
  };
  const maxDeposit = {
    ...(deps.channelMaxDepositZat !== undefined ? { [ASSET_YEC]: deps.channelMaxDepositZat } : {}),
    ...(deps.yedChannelMaxDepositCents !== undefined ? { [ASSET_YED]: deps.yedChannelMaxDepositCents } : {}),
  };
  const channels = new BatchYcashClientScheme({
    chain: deps.node,
    funder,
    ...(deps.channelStorePath ? { storage: new FileClientChannelStorage(deps.channelStorePath) } : {}),
    // A deposit is in its asset's unit (zatoshis or cents), so it applies to that asset's channels only.
    ...(Object.keys(deposits).length > 0 ? { deposit: channelDeposit(deposits, maxDeposit) } : {}),
    ...(Object.keys(maxDeposit).length > 0 ? { maxDeposit } : {}),
  });
  client.register(deps.network, channels);

  return { names: [`exact (${router.methods.join(", ")})`, "batch-settlement"], batch: channels };
};
