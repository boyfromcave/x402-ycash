// The self-hosted `sapling-proof` handler the `exact` scheme routes to when
// `assetTransferMethod === "sapling-proof"`: the server half (issuing per-request addresses) and the
// facilitator half (settling against the same wallet and registry) in one object.
import type { PaymentPayload, PaymentRequirements, ResourceInfo, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { SettlementStore } from "../store/index.js";
import { ShieldedExactFacilitator, type ShieldedFacilitatorRpc } from "./facilitator.js";
import type { JwsSigner } from "./receipt.js";
import { ShieldedExactServer, type ShieldedExactServerConfig, type ShieldedServerRpc } from "./server.js";

/**
 * The shape `src/exact/types.ts` defines as `ShieldedExactHandler`, restated structurally so this
 * module compiles without it. `verify` is optional because the flow is `upfront`.
 */
export interface ShieldedExactHandlerShape {
  verify?(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  enhanceRequirements(requirements: PaymentRequirements, resource: ResourceInfo | string): Promise<PaymentRequirements>;
}

export interface SaplingProofHandlerConfig extends Omit<ShieldedExactServerConfig, "rpc"> {
  /** The merchant's wallet node. */
  rpc: ShieldedServerRpc & ShieldedFacilitatorRpc;
  store: SettlementStore;
  receiptSigner: JwsSigner;
}

export class SaplingProofHandler implements ShieldedExactHandlerShape {
  readonly server: ShieldedExactServer;
  readonly facilitator: ShieldedExactFacilitator;

  constructor(config: SaplingProofHandlerConfig) {
    this.server = new ShieldedExactServer(config);
    this.facilitator = new ShieldedExactFacilitator({
      rpc: config.rpc,
      registry: this.server.registry,
      store: config.store,
      receiptSigner: config.receiptSigner,
      ...(config.now ? { now: config.now } : {}),
    });
  }

  enhanceRequirements(requirements: PaymentRequirements, resource: ResourceInfo | string): Promise<PaymentRequirements> {
    return this.server.enhanceRequirements(requirements, resource);
  }

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(payload, requirements);
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(payload, requirements);
  }
}
