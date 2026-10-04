// Where the Ycash server-side schemes plug into the merchant. One `server.register` call per scheme;
// a payment mode's route is served only once its scheme is registered (app.ts).
import type { x402ResourceServer } from "@x402/express";
import type { YcashNetwork, YcashRpc } from "x402-ycash-mechanism";

/** The three payment modes this example sells, one route each. */
export interface PaymentModes {
  /** `exact`, `transparent` YEC: pay-per-request, facilitator-submitted (plan X1). */
  exact: boolean;
  /** `batch-settlement`: a YEC payment channel, one voucher per request (plan X2). */
  channel: boolean;
  /** `exact`, `sapling-proof` YEC: a shielded payment to a fresh address per request (plan X4a). */
  shielded: boolean;
}

export interface ServerSchemeDeps {
  network: YcashNetwork;
  /** The merchant's own node wallet; only the shielded mode needs it (fresh diversified addresses). */
  wallet?: YcashRpc;
}

export type RegisterServerSchemes = (server: x402ResourceServer, deps: ServerSchemeDeps) => PaymentModes;

export const registerServerSchemes: RegisterServerSchemes = (server, deps) => {
  const modes: PaymentModes = { exact: false, channel: false, shielded: false };
  void server;
  void deps;

  // ── SLOT 1: exact, transparent YEC ────────────────────────────────────────────────────────────
  //   server.register(deps.network, new ExactYcashScheme());   // x402-ycash-mechanism exact/server
  //   modes.exact = true;

  // ── SLOT 2: batch-settlement (YEC channel) ────────────────────────────────────────────────────
  //   server.register(deps.network, new BatchSettlementYcashScheme({ channelStore }));
  //   modes.channel = true;

  // ── SLOT 3: exact, sapling-proof YEC ──────────────────────────────────────────────────────────
  // The same exact server scheme serves this transfer method; it needs the merchant's wallet to
  // issue a fresh diversified address per request (YcashRpc.zGetNewDiversifiedAddress, X-F11).
  //   if (deps.wallet) modes.shielded = true;   // once SLOT 1 is registered with a payTo source

  return modes;
};
