// Where the Ycash scheme mechanisms plug into the service. Each scheme is one `facilitator.register`
// call on the configured network; the HTTP layer (app.ts) is generic over whatever is registered.
import type { x402Facilitator } from "@x402/core/facilitator";
import {
  BatchYcashFacilitatorScheme,
  exact,
  SaplingProofHandler,
  type ChannelStore,
  type IssuedAddressRegistry,
  type NodeCapabilities,
  type SettlementStore,
  type YcashNetwork,
  type YcashRpc,
} from "x402-ycash-mechanism";
import type { ConfirmationLimits } from "./config.js";
import type { Logger } from "./logger.js";

/** The self-hosted sapling-proof method's inputs (config `saplingProof`, opened by server.ts). */
export interface SaplingProofDeps {
  receiptKey: string;
  /** The issued-address registry the merchant's server writes (the same file). */
  registry: IssuedAddressRegistry;
  baseAddress?: string;
  /** How long settle waits for the note to reach the merchant's wallet before not_received (default 10 s). */
  noteWaitMs?: number;
}

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
  /** batch-settlement's record of the channels it relayed (audit only; the server owns the watermark). */
  channelStore?: ChannelStore;
  /** Set when the operator configured sapling-proof (a self-hosted facilitator on the merchant's wallet). */
  saplingProof?: SaplingProofDeps;
}

/** `invalid_exact_ycash_not_received`: no note of the txid at payTo yet (spec step 4: still reachable). */
const NOT_RECEIVED = "invalid_exact_ycash_not_received";
const DEFAULT_NOTE_WAIT_MS = 10_000;
const NOTE_POLL_MS = 500;

/**
 * The facilitator half of a SaplingProofHandler, as the exact scheme's `ShieldedExactHandler`.
 * Issuing requirements is the merchant's job (its server writes the shared registry); the
 * facilitator only verifies and settles, so `enhanceRequirements` is never called here.
 *
 * Over HTTP the client presents the txid as soon as its `z_sendmany` returns, before the payment
 * has crossed the network to the merchant's node; settle therefore waits a bounded time for the
 * note (nothing is claimed meanwhile), well inside core's settle timeout.
 */
export function facilitatorHalf(handler: SaplingProofHandler, opts: { noteWaitMs?: number; pollMs?: number } = {}): exact.ShieldedExactHandler {
  const waitMs = opts.noteWaitMs ?? DEFAULT_NOTE_WAIT_MS;
  const pollMs = opts.pollMs ?? NOTE_POLL_MS;
  return {
    verify: (payload, requirements) => handler.verify(payload, requirements),
    async settle(payload, requirements) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const res = await handler.settle(payload, requirements);
        if (res.success || res.errorReason !== NOT_RECEIVED || Date.now() + pollMs > deadline) return res;
        await new Promise(r => setTimeout(r, pollMs));
      }
    },
    enhanceRequirements: () => Promise.reject(new Error("a facilitator does not issue sapling-proof requirements; the merchant's server does")),
  };
}

/** Registers the Ycash schemes on `facilitator` and returns the names it registered (for the startup log). */
export function registerSchemes(facilitator: x402Facilitator, deps: SchemeDeps): string[] {
  const registered: string[] = [];

  // exact (scheme_exact_ycash.md): `transparent` YEC, verified per the spec's rules 1–10 and
  // settled with the txid claim; plus `sapling-proof` when this is the merchant's own facilitator.
  let shielded: exact.ShieldedExactHandler | undefined;
  if (deps.saplingProof) {
    const handler = new SaplingProofHandler({
      network: deps.network,
      rpc: deps.rpc,
      settlementStore: deps.settlementStore,
      confirmations: deps.confirmations,
      capabilities: deps.capabilities,
      logger: deps.logger,
      receiptKey: deps.saplingProof.receiptKey,
      registry: deps.saplingProof.registry,
      ...(deps.saplingProof.baseAddress ? { baseAddress: deps.saplingProof.baseAddress } : {}),
    });
    shielded = facilitatorHalf(handler, deps.saplingProof.noteWaitMs !== undefined ? { noteWaitMs: deps.saplingProof.noteWaitMs } : {});
  }
  facilitator.register(
    deps.network,
    new exact.ExactYcashFacilitatorScheme({
      rpc: deps.rpc,
      network: deps.network,
      settlementStore: deps.settlementStore,
      confirmations: deps.confirmations,
      capabilities: deps.capabilities,
      logger: deps.logger,
      ...(shielded ? { shielded } : {}),
    }),
  );
  registered.push(shielded ? "exact (transparent, sapling-proof)" : "exact (transparent)");

  // batch-settlement (scheme_batch_settlement_ycash.md): YEC channels. The resource server holds
  // the channel state and verifies vouchers itself; this relays funding and `claim` closes.
  facilitator.register(
    deps.network,
    new BatchYcashFacilitatorScheme({
      rpc: deps.rpc,
      settlementStore: deps.settlementStore,
      confirmations: deps.confirmations,
      ...(deps.channelStore ? { channelStore: deps.channelStore } : {}),
    }),
  );
  registered.push("batch-settlement");

  return registered;
}
