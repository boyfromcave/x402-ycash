// The self-hosted `sapling-proof` handler the `exact` scheme routes to when
// `assetTransferMethod === "sapling-proof"`: the server half (issuing per-request addresses) and the
// facilitator half (settling against the same wallet and registry) in one object.
import type { PaymentPayload, PaymentRequirements, ResourceInfo, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { YcashNetwork } from "../constants.js";
import type { NodeCapabilities } from "../node/index.js";
import type { SettlementStore } from "../store/index.js";
import { CHAIN_OF } from "./constants.js";
import { ShieldedExactFacilitator, type ShieldedFacilitatorRpc } from "./facilitator.js";
import { es256kSigner, type JwsSigner } from "./receipt.js";
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

/** The facilitator service's logger, structurally (packages/facilitator/src/logger.ts). */
export interface ShieldedLogger {
  info?(msg: string, fields?: Record<string, unknown>): void;
  warn?(msg: string, fields?: Record<string, unknown>): void;
  error?(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Built from the facilitator's `SchemeDeps` (`packages/facilitator/src/schemes.ts`:
 * network, rpc, settlementStore, confirmations, capabilities, logger) plus the merchant's base
 * Sapling address and receipt key.
 */
export interface SaplingProofHandlerConfig extends Omit<ShieldedExactServerConfig, "rpc" | "baseAddress"> {
  /** The one network this handler serves. */
  network: YcashNetwork;
  /** The merchant's wallet node (it must hold the base address's spending key). */
  rpc: ShieldedServerRpc & ShieldedFacilitatorRpc;
  /** Restart-durable consumption store; keys are kept forever. */
  settlementStore: SettlementStore;
  /** The confirmation range the operator settles; an issued policy outside it is refused. */
  confirmations?: { minimum: number; maximum: number };
  /** When given, its chain must be the network's (checked at construction, no RPC). */
  capabilities?: NodeCapabilities;
  logger?: ShieldedLogger;
  /** The merchant's base Sapling address; default: one `z_getnewaddress sapling`, made once. */
  baseAddress?: string;
  /** The receipt key: a 32-byte secp256k1 private key (bytes or hex), or a ready JWS signer. */
  receiptKey: Uint8Array | string | JwsSigner;
  /** As ShieldedExactFacilitatorConfig.noteWaitMs (default 10 s). */
  noteWaitMs?: number;
  notePollMs?: number;
}

export class SaplingProofHandler implements ShieldedExactHandlerShape {
  readonly network: YcashNetwork;
  readonly server: ShieldedExactServer;
  readonly facilitator: ShieldedExactFacilitator;
  readonly receiptSigner: JwsSigner;
  private readonly confirmations: { minimum: number; maximum: number } | undefined;
  private readonly logger: ShieldedLogger | undefined;

  constructor(config: SaplingProofHandlerConfig) {
    this.network = config.network;
    if (config.capabilities && config.capabilities.chain !== CHAIN_OF[config.network]) {
      throw new Error(`the merchant node is on ${config.capabilities.chain}, not ${config.network}`);
    }
    this.confirmations = config.confirmations;
    this.logger = config.logger;
    const k = config.receiptKey;
    this.receiptSigner = typeof k === "object" && "sign" in k ? k : es256kSigner(typeof k === "string" ? Uint8Array.from(Buffer.from(k, "hex")) : k);
    // The operator's range is checked before issuing (no address used, nothing counted toward maxOutstanding).
    this.server = new ShieldedExactServer({
      ...config,
      ...(config.baseAddress ? { baseAddress: config.baseAddress } : {}),
      ...(config.confirmations ? { confirmationRange: config.confirmations } : {}),
    });
    this.facilitator = new ShieldedExactFacilitator({
      rpc: config.rpc,
      registry: this.server.registry,
      store: config.settlementStore,
      receiptSigner: this.receiptSigner,
      ...(config.now ? { now: config.now } : {}),
      ...(config.noteWaitMs !== undefined ? { noteWaitMs: config.noteWaitMs } : {}),
      ...(config.notePollMs !== undefined ? { notePollMs: config.notePollMs } : {}),
    });
  }

  async enhanceRequirements(requirements: PaymentRequirements, resource: ResourceInfo | string): Promise<PaymentRequirements> {
    this.checkNetwork(requirements);
    return this.server.enhanceRequirements(requirements, resource);
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    if (requirements.network !== this.network) return { isValid: false, invalidReason: "network_mismatch", invalidMessage: `this handler serves ${this.network}` };
    return this.facilitator.verify(payload, requirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    if (requirements.network !== this.network) {
      return { success: false, errorReason: "network_mismatch", errorMessage: `this handler serves ${this.network}`, transaction: "", network: requirements.network };
    }
    const res = await this.facilitator.settle(payload, requirements);
    if (res.success) this.logger?.info?.("sapling-proof settled", { transaction: res.transaction, extra: res.extra });
    else this.logger?.warn?.("sapling-proof settle refused", { reason: res.errorReason, transaction: res.transaction });
    return res;
  }

  private checkNetwork(requirements: PaymentRequirements): void {
    if (requirements.network !== this.network) throw new Error(`this handler serves ${this.network}, not ${requirements.network}`);
  }
}
