// Where the Ycash scheme mechanisms plug into the service. Each scheme is one `facilitator.register`
// call on the configured network; the HTTP layer (app.ts) is generic over whatever is registered.
import type { x402Facilitator } from "@x402/core/facilitator";
import type { NodeCapabilities, SettlementStore, YcashNetwork, YcashRpc } from "x402-ycash-mechanism";
import type { ConfirmationLimits } from "./config.js";
import type { Logger } from "./logger.js";

/** Everything a Ycash facilitator mechanism needs, built once at startup (server.ts). */
export interface SchemeDeps {
  /** The one network this facilitator serves; its node's chain was checked at startup. */
  network: YcashNetwork;
  rpc: YcashRpc;
  /** Cross-process txid / consumption claims (plan §5.6 "Duplicate submission"). */
  settlementStore: SettlementStore;
  /** The range this facilitator settles; a mechanism advertises it in getExtra (`/supported`). */
  confirmations: ConfirmationLimits;
  /** Line and Yellowback flag: YED is offered only when `capabilities.yellowback` (spec `/supported`). */
  capabilities: NodeCapabilities;
  logger: Logger;
}

/**
 * Registers the Ycash schemes on `facilitator` and returns the names it registered (for the
 * startup log). Until the mechanism chunks are merged it registers nothing, and `/supported`
 * answers `kinds: []`.
 */
export function registerSchemes(facilitator: x402Facilitator, deps: SchemeDeps): string[] {
  const registered: string[] = [];
  void facilitator;
  void deps;

  // ── SLOT 1: exact (scheme_exact_ycash.md) ─────────────────────────────────────────────────────
  // One facilitator mechanism covering both facilitator-handled transfer methods:
  //   - `transparent` (YEC; YED when deps.capabilities.yellowback): verify per §5.6, settle by
  //     sendrawtransaction with the txid claim in deps.settlementStore;
  //   - `sapling-proof` (YEC, client-submitted): the merchant's own wallet checks receipt; offer it
  //     only on a self-hosted facilitator (spec "Viewing-key custody").
  // Wire it as:
  //   facilitator.register(deps.network, new ExactYcashScheme({ rpc: deps.rpc, store: deps.settlementStore,
  //     confirmations: deps.confirmations, yed: deps.capabilities.yellowback }));
  //   registered.push("exact");

  // ── SLOT 2: batch-settlement (scheme_batch_settlement_ycash.md) ───────────────────────────────
  // Payment channels, YEC (X2) then YED (X3): open, voucher, close and refund.
  // Wire it as:
  //   facilitator.register(deps.network, new BatchSettlementYcashScheme({ rpc: deps.rpc,
  //     store: deps.settlementStore, confirmations: deps.confirmations, yed: deps.capabilities.yellowback }));
  //   registered.push("batch-settlement");

  return registered;
}
