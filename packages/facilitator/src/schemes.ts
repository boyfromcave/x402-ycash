// Where the Ycash scheme mechanisms plug into the service. Each scheme is one `facilitator.register`
// call on the configured network; the HTTP layer (app.ts) is generic over whatever is registered.
import type { x402Facilitator } from "@x402/core/facilitator";
import {
  BatchYcashFacilitatorScheme,
  exact,
  SaplingHandler,
  SaplingProofHandler,
  ShieldedMethodRouter,
  type ChannelStore,
  type IssuedAddressRegistry,
  type shielded,
  type NodeCapabilities,
  type SettlementStore,
  type YcashNetwork,
  type YcashRpc,
} from "x402-ycash-mechanism";
import type { ConfirmationLimits } from "./config.js";
import type { Logger } from "./logger.js";

/** The self-hosted shielded methods' inputs (config `saplingProof`, opened by server.ts). */
export interface SaplingProofDeps {
  /** The methods served (default `sapling-proof` only). */
  methods?: readonly ("sapling-proof" | "sapling")[];
  /** The merchant's `zxview…` key: `sapling` trial-decrypts the client's transaction with it. */
  viewingKey?: string;
  receiptKey: string;
  /** The issued-address registry the merchant's server writes (the same file). */
  registry: IssuedAddressRegistry;
  baseAddress?: string;
  /** How long settle waits for the note to reach the merchant's wallet before not_received (default 10 s). */
  noteWaitMs?: number;
  /** The address issuer; default: the node's wallet. The facilitator half never issues, but the handler is built whole. */
  issuer?: shielded.AddressIssuer;
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

/**
 * The facilitator half of a shielded handler, as the exact scheme's `ShieldedExactHandler`.
 * Issuing requirements is the merchant's job (its server writes the shared registry); the
 * facilitator only verifies and settles, so `enhanceRequirements` is never called here.
 * The bounded wait for the note (the client presents the txid before its payment reaches the
 * merchant's node) is the mechanism's (`noteWaitMs` on the handler), fed by X402_SAPLING_NOTE_WAIT_MS.
 */
export function facilitatorHalf(handler: SaplingProofHandler | SaplingHandler | ShieldedMethodRouter): exact.ShieldedExactHandler {
  return {
    ...(handler instanceof ShieldedMethodRouter ? { flows: handler.flows } : {}),
    verify: (payload, requirements) => handler.verify(payload, requirements),
    settle: (payload, requirements) => handler.settle(payload, requirements),
    enhanceRequirements: () => Promise.reject(new Error("a facilitator does not issue shielded requirements; the merchant's server does")),
  };
}

/** Registers the Ycash schemes on `facilitator` and returns the names it registered (for the startup log). */
export function registerSchemes(facilitator: x402Facilitator, deps: SchemeDeps): string[] {
  const registered: string[] = [];

  // exact (scheme_exact_ycash.md): `transparent` YEC, verified per the spec's rules 1–10 and
  // settled with the txid claim; plus the shielded methods when this is the merchant's own facilitator.
  let shielded: exact.ShieldedExactHandler | undefined;
  let methods: readonly string[] = [];
  if (deps.saplingProof) {
    shielded = facilitatorHalf(shieldedRouter(deps, deps.saplingProof));
    methods = shielded.flows ? Object.keys(shielded.flows) : [];
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
  registered.push(`exact (${["transparent", ...methods].join(", ")})`);

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

/**
 * The shielded methods behind the exact scheme's one hook: `sapling-proof` on the merchant's wallet
 * (SaplingProofHandler) and, opted in, `sapling` with the merchant's viewing key (SaplingHandler).
 * Both share the issued-address registry the merchant's server writes and the settlement store.
 *
 * @param deps - The service's dependencies.
 * @param sp - The shielded configuration.
 * @returns The router.
 * @throws Error when `sapling` is asked for without the viewing key, or the node is on another chain.
 */
export function shieldedRouter(deps: SchemeDeps, sp: SaplingProofDeps): ShieldedMethodRouter {
  const methods = sp.methods ?? ["sapling-proof"];
  const common = {
    network: deps.network,
    rpc: deps.rpc,
    settlementStore: deps.settlementStore,
    confirmations: deps.confirmations,
    capabilities: deps.capabilities,
    logger: deps.logger,
    receiptKey: sp.receiptKey,
    registry: sp.registry,
    ...(sp.baseAddress ? { baseAddress: sp.baseAddress } : {}),
    ...(sp.issuer ? { issuer: sp.issuer } : {}),
  };
  const proof = methods.includes("sapling-proof") ? new SaplingProofHandler({ ...common, ...(sp.noteWaitMs !== undefined ? { noteWaitMs: sp.noteWaitMs } : {}) }) : undefined;
  let sapling: SaplingHandler | undefined;
  if (methods.includes("sapling")) {
    if (!sp.viewingKey) throw new Error("sapling needs the merchant's viewing key (the offline issuer's X402_SAPLING_VIEWING_KEY)");
    // The note wait of settle step 4 is the same knob as sapling-proof's (X402_SAPLING_NOTE_WAIT_MS).
    sapling = new SaplingHandler({ ...common, viewingKey: sp.viewingKey, ...(sp.noteWaitMs !== undefined ? { observeWaitMs: sp.noteWaitMs } : {}) });
  }
  return new ShieldedMethodRouter({ ...(proof ? { "sapling-proof": proof } : {}), ...(sapling ? { sapling } : {}) });
}
