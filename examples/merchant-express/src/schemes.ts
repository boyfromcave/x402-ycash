// Where the Ycash server-side schemes plug into the merchant. One `server.register` call per scheme;
// a payment mode's route is served only once its scheme is registered (app.ts).
import type { HTTPRequestContext } from "@x402/core/server";
import type { x402ResourceServer } from "@x402/express";
import { ASSET_YED, BatchYcashServerScheme, exact, FileChannelStore, FileIssuedAddressRegistry, shielded, type YcashNetwork, type YcashRpc } from "x402-ycash-mechanism";
import type { ChannelConfig, ShieldedConfig } from "./config.js";
import { ShieldedRouteIssuer } from "./shielded.js";

/** The three payment modes this example sells. */
export interface PaymentModes {
  /** `exact`, `transparent` YEC: pay-per-request, facilitator-submitted (plan X1). */
  exact: boolean;
  /** `batch-settlement`: a YEC payment channel, one voucher per request (plan X2). */
  channel: boolean;
  /** `exact`, `sapling-proof` YEC: a shielded payment to a fresh address per request (plan X4a). */
  shielded: boolean;
  /** `exact`, `transparent` YED at ≥ $1.00 (plan X3); only when the facilitator lists YED. */
  yedExact: boolean;
  /** `batch-settlement`: a YED channel under the dollar floor (plan X3); only when the facilitator lists YED. */
  yedChannel: boolean;
}

/** Which YED modes the merchant may serve (yed.ts probes the facilitator and the node at startup). */
export interface YedModes {
  exact: boolean;
  channel: boolean;
  /** The largest YED channel deposit accepted, cents. */
  maxDepositCents: bigint;
}

export interface ServerSchemeDeps {
  network: YcashNetwork;
  /** The merchant's own node: the channel server's chain view and the shielded wallet. */
  wallet?: YcashRpc;
  /** exact YEC payments up to this many zatoshis default to policy −1. */
  zeroConfCapZat?: bigint;
  channel?: ChannelConfig;
  shielded?: ShieldedConfig & { amount: string; maxTimeoutSeconds: number };
  yed?: YedModes;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface ServerSchemes {
  modes: PaymentModes;
  /** The shielded route's dynamic payTo (a fresh diversified address per request). */
  shieldedPayTo?: (context: HTTPRequestContext) => Promise<string>;
  /** Stops background work (the channel close watcher). */
  close?: () => Promise<void>;
}

export type RegisterServerSchemes = (server: x402ResourceServer, deps: ServerSchemeDeps) => ServerSchemes;

export const registerServerSchemes: RegisterServerSchemes = (server, deps) => {
  const modes: PaymentModes = { exact: false, channel: false, shielded: false, yedExact: false, yedChannel: false };
  const out: ServerSchemes = { modes };

  // exact: transparent YEC always; sapling-proof when the merchant's wallet or viewing key issues addresses.
  let issuer: ShieldedRouteIssuer | undefined;
  const off = deps.shielded?.offline;
  if (deps.shielded && (deps.wallet || off)) {
    const server = new shielded.ShieldedExactServer({
      ...(deps.wallet ? { rpc: deps.wallet } : {}),
      // The viewing-key setup: addresses derived offline, no spending key on the request path.
      ...(off ? { issuer: new shielded.OfflineAddressIssuer({ viewingKey: off.viewingKey, network: deps.network, startIndex: off.startIndex, indexPath: off.indexPath }) } : {}),
      registry: new FileIssuedAddressRegistry(deps.shielded.registryPath),
      defaultConfirmations: deps.shielded.confirmations,
      ...(deps.shielded.baseAddress ? { baseAddress: deps.shielded.baseAddress } : {}),
    });
    issuer = new ShieldedRouteIssuer(server, { network: deps.network, amount: deps.shielded.amount, maxTimeoutSeconds: deps.shielded.maxTimeoutSeconds, confirmations: deps.shielded.confirmations });
    out.shieldedPayTo = issuer.payTo;
    modes.shielded = true;
  }
  server.register(
    deps.network,
    new exact.ExactYcashServerScheme({
      ...(deps.zeroConfCapZat !== undefined ? { zeroConfCapZat: deps.zeroConfCapZat } : {}),
      ...(issuer ? { shielded: issuer } : {}),
      // "$2" on the YED route means 200 YED cents; the YEC routes price in zatoshis, so they are unaffected.
      ...(deps.yed?.exact ? { usdAsset: ASSET_YED } : {}),
    }),
  );
  modes.exact = true;
  modes.yedExact = deps.yed?.exact === true;

  // batch-settlement: the server holds S and the channel state, verifies each voucher before the
  // handler, and closes on idle, margin, exhaustion or the client's close.
  if (deps.channel && deps.wallet) {
    const c = deps.channel;
    const scheme = new BatchYcashServerScheme({
      chain: deps.wallet,
      serverPrivKey: c.serverPrivKey,
      store: new FileChannelStore(c.storePath),
      maxDeposit: c.maxDeposit,
      confirmations: c.confirmations,
      fundingWaitMs: c.fundingWaitMs,
      ...(c.minLockBlocks !== undefined ? { minLockBlocks: c.minLockBlocks } : {}),
      ...(c.closeMarginBlocks !== undefined ? { closeMarginBlocks: c.closeMarginBlocks } : {}),
      ...(c.idleMs !== undefined ? { idleMs: c.idleMs } : {}),
      ...(deps.yed?.channel ? { usdAsset: ASSET_YED, maxDepositCents: deps.yed.maxDepositCents } : {}),
      onClose: (e) => deps.log?.("channel closed", { channelId: e.channelId, reason: e.reason, txid: e.txid, cumulative: e.cumulative.toString() }),
    });
    server.register(deps.network, scheme);
    const watcher = scheme.manager.watcher({ pollMs: c.watcherPollMs, warn: (m) => deps.log?.("channel watcher", { warning: m }) });
    watcher.start();
    out.close = () => watcher.stop();
    modes.channel = true;
    // YED vouchers are checkable only against confirmed token records (plan X-F14): no mempool funding.
    if (deps.yed?.channel && c.confirmations < 0) deps.log?.("YED channel route off", { reason: "MERCHANT_CHANNEL_CONFIRMATIONS is -1; YED channels need funding in a block" });
    modes.yedChannel = deps.yed?.channel === true && c.confirmations >= 0;
  }

  return out;
};
