// Where the Ycash client-side schemes plug into the agent. One `client.register` call per scheme;
// which one pays is the route's choice (its 402 offers one scheme and method).
import type { x402Client } from "@x402/fetch";
import {
  BatchYcashClientScheme,
  exact,
  FileClientChannelStorage,
  FileCoinReservationStore,
  rpcWalletFunder,
  ShieldedExactClient,
  utxoSourceFunder,
  type YcashNetwork,
  type YcashRpc,
} from "x402-ycash-mechanism";
import type { AgentSigner } from "./config.js";

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
  const funder = deps.signer.kind === "wif" && source ? utxoSourceFunder(deps.signer.privKey, source) : rpcWalletFunder(deps.node, held);
  const deposit = deps.channelDepositZat;
  const batch = new BatchYcashClientScheme({
    chain: deps.node,
    funder,
    ...(deps.channelStorePath ? { storage: new FileClientChannelStorage(deps.channelStorePath) } : {}),
    ...(deposit !== undefined ? { deposit: (t) => (deposit < t.maxDeposit ? deposit : t.maxDeposit) } : {}),
    ...(deps.channelMaxDepositZat !== undefined ? { maxDeposit: { YEC: deps.channelMaxDepositZat } } : {}),
  });
  client.register(deps.network, batch);

  return { names: [`exact (${router.methods.join(", ")})`, "batch-settlement"], batch };
};
