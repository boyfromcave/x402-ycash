// The `sapling` method's server half and handler, and the router that puts both shielded methods
// behind the exact scheme's one `shielded` hook: `sapling-proof` (client-submitted, upfront) and
// `sapling` (facilitator-submitted, authorization) share the registry, the per-request address and
// the memo commitment; they differ in who broadcasts and in what the facilitator checks.
import type { PaymentPayload, PaymentRequirements, ResourceInfo, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { YcashNetwork } from "../constants.js";
import type { NodeCapabilities } from "../node/index.js";
import type { SettlementStore } from "../store/index.js";
import { ASSET_TRANSFER_METHOD_SAPLING, ASSET_TRANSFER_METHOD_SAPLING_PROOF, CHAIN_OF, ERR, PAYMENT_FLOW_UPFRONT } from "./constants.js";
import type { ShieldedExactHandlerShape, ShieldedLogger } from "./handler.js";
import { es256kSigner, type JwsSigner } from "./receipt.js";
import { PAYMENT_FLOW_AUTHORIZATION, SaplingExactFacilitator, type SaplingFacilitatorRpc, type SaplingVerifyLimits } from "./saplingFacilitator.js";
import type { SaplingIncomingKey } from "./sapling/index.js";
import { ShieldedExactServer, type ShieldedExactServerConfig, type ShieldedServerRpc } from "./server.js";

/**
 * Issues `sapling` requirements: the same per-request diversified address, request record and memo
 * as `sapling-proof` (the record does not name the method, so one registry serves both), with
 * `assetTransferMethod: "sapling"` and no `paymentFlow` (authorization).
 */
export class SaplingExactServer {
  readonly inner: ShieldedExactServer;

  /**
   * Wraps a `sapling-proof` server, whose issuance is reused.
   *
   * @param config - As ShieldedExactServerConfig.
   */
  constructor(config: ShieldedExactServerConfig) {
    this.inner = new ShieldedExactServer(config);
  }

  /**
   * The registry shared with the facilitator.
   *
   * @returns The issued-address registry.
   */
  get registry(): ShieldedExactServer["registry"] {
    return this.inner.registry;
  }

  /**
   * Issues the per-request instrument for a `sapling` requirement.
   *
   * @param requirements - The route's requirements, `extra.assetTransferMethod` "sapling".
   * @param resource - The resource being paid for.
   * @returns The requirements with the issued payTo, memo and expiresAt.
   * @throws Error when the method is not `sapling`, or the inner server refuses to issue.
   */
  async enhanceRequirements(requirements: PaymentRequirements, resource: ResourceInfo | string): Promise<PaymentRequirements> {
    const extra = { ...(requirements.extra ?? {}) };
    if (extra.assetTransferMethod !== ASSET_TRANSFER_METHOD_SAPLING) throw new Error(`assetTransferMethod ${String(extra.assetTransferMethod)} is not sapling`);
    if (extra.paymentFlow !== undefined && extra.paymentFlow !== PAYMENT_FLOW_AUTHORIZATION) throw new Error("sapling is an authorization-flow method");
    extra.assetTransferMethod = ASSET_TRANSFER_METHOD_SAPLING_PROOF;
    const issued = await this.inner.enhanceRequirements({ ...requirements, extra }, resource);
    const out = { ...(issued.extra ?? {}) };
    out.assetTransferMethod = ASSET_TRANSFER_METHOD_SAPLING;
    delete out.paymentFlow;
    return { ...issued, extra: out };
  }
}

export interface SaplingHandlerConfig extends Omit<ShieldedExactServerConfig, "rpc" | "baseAddress"> {
  network: YcashNetwork;
  /** The merchant's node: wallet (issuance, note observation) and chain reads. */
  rpc: ShieldedServerRpc & SaplingFacilitatorRpc;
  /** The merchant's `zxview…` key, or its decoded incoming half. */
  viewingKey: string | SaplingIncomingKey;
  settlementStore: SettlementStore;
  confirmations?: { minimum: number; maximum: number };
  capabilities?: NodeCapabilities;
  logger?: ShieldedLogger;
  baseAddress?: string;
  receiptKey: Uint8Array | string | JwsSigner;
  limits?: Partial<SaplingVerifyLimits>;
  observeWaitMs?: number;
  observePollMs?: number;
}

/**
 * The self-hosted `sapling` handler for one network: a {@link SaplingExactServer} issuing the
 * instrument and a {@link SaplingExactFacilitator} verifying and settling against the same registry.
 */
export class SaplingHandler implements ShieldedExactHandlerShape {
  readonly network: YcashNetwork;
  readonly server: SaplingExactServer;
  readonly facilitator: SaplingExactFacilitator;
  readonly receiptSigner: JwsSigner;
  private readonly logger: ShieldedLogger | undefined;

  /**
   * Builds both halves, sharing the registry.
   *
   * @param config - The network, node, viewing key, stores, confirmation range and receipt key.
   * @throws Error when `capabilities` reports another chain, or the viewing key another network.
   */
  constructor(config: SaplingHandlerConfig) {
    this.network = config.network;
    if (config.capabilities && config.capabilities.chain !== CHAIN_OF[config.network]) {
      throw new Error(`the merchant node is on ${config.capabilities.chain}, not ${config.network}`);
    }
    this.logger = config.logger;
    const k = config.receiptKey;
    this.receiptSigner = typeof k === "object" && "sign" in k ? k : es256kSigner(typeof k === "string" ? Uint8Array.from(Buffer.from(k, "hex")) : k);
    this.server = new SaplingExactServer({
      ...config,
      ...(config.baseAddress ? { baseAddress: config.baseAddress } : {}),
      ...(config.confirmations ? { confirmationRange: config.confirmations } : {}),
    });
    this.facilitator = new SaplingExactFacilitator({
      rpc: config.rpc,
      viewingKey: config.viewingKey,
      network: config.network,
      registry: this.server.registry,
      store: config.settlementStore,
      receiptSigner: this.receiptSigner,
      ...(config.limits ? { limits: config.limits } : {}),
      ...(config.now ? { now: config.now } : {}),
      ...(config.observeWaitMs !== undefined ? { observeWaitMs: config.observeWaitMs } : {}),
      ...(config.observePollMs !== undefined ? { observePollMs: config.observePollMs } : {}),
    });
  }

  /**
   * Issues the instrument.
   *
   * @param requirements - The route's requirements.
   * @param resource - The resource being paid for.
   * @returns The issued requirements.
   * @throws Error for another network, or when the server refuses to issue.
   */
  async enhanceRequirements(requirements: PaymentRequirements, resource: ResourceInfo | string): Promise<PaymentRequirements> {
    if (requirements.network !== this.network) throw new Error(`this handler serves ${this.network}, not ${requirements.network}`);
    return this.server.enhanceRequirements(requirements, resource);
  }

  /**
   * Read-only verification of a presented transaction.
   *
   * @param payload - The client's payload.
   * @param requirements - The issued requirements.
   * @returns The facilitator's answer.
   */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    if (requirements.network !== this.network) return { isValid: false, invalidReason: ERR.networkMismatch, invalidMessage: `this handler serves ${this.network}` };
    return this.facilitator.verify(payload, requirements);
  }

  /**
   * Settles (claims, broadcasts, observes) and logs the outcome.
   *
   * @param payload - The client's payload.
   * @param requirements - The issued requirements.
   * @returns The facilitator's settle response.
   */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    if (requirements.network !== this.network) {
      return { success: false, errorReason: ERR.networkMismatch, errorMessage: `this handler serves ${this.network}`, transaction: "", network: requirements.network };
    }
    const res = await this.facilitator.settle(payload, requirements);
    if (res.success) this.logger?.info?.("sapling settled", { transaction: res.transaction, extra: res.extra });
    else this.logger?.warn?.("sapling settle refused", { reason: res.errorReason, transaction: res.transaction });
    return res;
  }
}

/** The two shielded methods behind one hook. */
export interface ShieldedMethodHandlers {
  [ASSET_TRANSFER_METHOD_SAPLING_PROOF]?: ShieldedExactHandlerShape;
  [ASSET_TRANSFER_METHOD_SAPLING]?: ShieldedExactHandlerShape;
}

/**
 * Routes by `extra.assetTransferMethod` to the configured shielded handler. The exact scheme sees one
 * `ShieldedExactHandler`; `methods` tells it which flows to advertise (`sapling-proof` upfront,
 * `sapling` authorization).
 */
export class ShieldedMethodRouter implements ShieldedExactHandlerShape {
  /** The methods configured, for the server's `paymentFlows`. */
  readonly methods: readonly string[];
  /** Flow per configured method. */
  readonly flows: Readonly<Record<string, typeof PAYMENT_FLOW_AUTHORIZATION | typeof PAYMENT_FLOW_UPFRONT>>;

  /**
   * Keeps the handlers.
   *
   * @param handlers - The handlers per method; a missing one refuses its method.
   */
  constructor(private readonly handlers: ShieldedMethodHandlers) {
    this.methods = (Object.keys(handlers) as (keyof ShieldedMethodHandlers)[]).filter((m) => handlers[m] !== undefined);
    this.flows = Object.fromEntries(this.methods.map((m) => [m, m === ASSET_TRANSFER_METHOD_SAPLING ? PAYMENT_FLOW_AUTHORIZATION : PAYMENT_FLOW_UPFRONT] as const));
  }

  /**
   * Issues the instrument through the method's handler.
   *
   * @param requirements - The route's requirements.
   * @param resource - The resource being paid for.
   * @returns The issued requirements.
   * @throws Error when the method has no handler.
   */
  async enhanceRequirements(requirements: PaymentRequirements, resource: ResourceInfo | string): Promise<PaymentRequirements> {
    const h = this.pick(requirements.extra);
    if (!h.ok) throw new Error(h.message);
    return h.handler.enhanceRequirements(requirements, resource);
  }

  /**
   * Verifies through the method's handler; `sapling-proof` has no verify (upfront).
   *
   * @param payload - The client's payload.
   * @param requirements - The issued requirements.
   * @returns The handler's answer.
   */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const h = this.pick(requirements.extra);
    if (!h.ok) return { isValid: false, invalidReason: ERR.assetTransferMethod, invalidMessage: h.message };
    if (!h.handler.verify) return { isValid: false, invalidReason: ERR.paymentFlow, invalidMessage: `${h.method} is upfront: settle, not verify` };
    return h.handler.verify(payload, requirements);
  }

  /**
   * Settles through the method's handler.
   *
   * @param payload - The client's payload.
   * @param requirements - The issued requirements.
   * @returns The handler's answer.
   */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const h = this.pick(requirements.extra);
    if (!h.ok) return { success: false, errorReason: ERR.assetTransferMethod, errorMessage: h.message, transaction: "", network: requirements.network };
    return h.handler.settle(payload, requirements);
  }

  /**
   * The handler for a requirement's method.
   *
   * @param extra - The requirement's `extra`.
   * @returns The handler and method, or why none applies.
   */
  private pick(extra: Record<string, unknown> | undefined): { ok: true; method: string; handler: ShieldedExactHandlerShape } | { ok: false; message: string } {
    const method = extra?.assetTransferMethod;
    if (method !== ASSET_TRANSFER_METHOD_SAPLING_PROOF && method !== ASSET_TRANSFER_METHOD_SAPLING) return { ok: false, message: `assetTransferMethod ${String(method)} is not a shielded method` };
    const handler = this.handlers[method];
    if (!handler) return { ok: false, message: `${method} is not configured` };
    return { ok: true, method, handler };
  }
}
