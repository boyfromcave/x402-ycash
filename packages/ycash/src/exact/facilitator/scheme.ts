// The exact facilitator for Ycash: verification rules 1–10 and settlement of `transparent` YEC
// (specs/scheme_exact_ycash.md), modelled on upstream's Cardano facilitator. It signs nothing and
// pays nothing; it reads the node, and in settle it claims the txid and broadcasts.
import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { RpcError, SendRawTransactionError } from "../../node/index.js";
import { InMemorySettlementStore, retainUntilForExpiry, type SettlementStore } from "../../store/index.js";
import {
  ERR_ASSET_TRANSFER_METHOD,
  ERR_DUPLICATE_SETTLEMENT,
  ERR_EXPIRY,
  ERR_INPUT_SPENT,
  ERR_PAYMENT_FLOW,
  ERR_SETTLEMENT_FAILED,
  ERR_SETTLEMENT_PENDING,
  ERR_TRANSACTION,
} from "../errors.js";
import { confirmationsSatisfy, isShieldedMethod, MAX_CONFIRMATIONS, MIN_CONFIRMATIONS } from "../policy.js";
import { addressOfScriptSig } from "../script.js";
import { decodeAddress, encodeAddress } from "../../tx/index.js";
import { ATM_SAPLING_PROOF, ATM_TRANSPARENT, SCHEME_EXACT, type ExactYcashSettleExtra, type ShieldedExactHandler } from "../types.js";
import { resolvePayment, verifyTransparent, type ExactFacilitatorRpc, type ResolvedPayment, type VerifyLimits } from "./verify.js";

export interface ExactYcashFacilitatorConfig {
  /** Shared by every process serving /settle (Duplicate Settlement Mitigation). Default: in-process. */
  settlementStore?: SettlementStore;
  /**
   * The confirmation range this facilitator settles, advertised in `/supported`; a policy outside
   * it is refused. Default −1..20. A minimum of 0 is the operator refusing mempool settlement.
   */
  confirmations?: { minimum: number; maximum: number };
  /** Shorthand for `confirmations.minimum` −1 (true) or 0 (false). */
  acceptMempool?: boolean;
  logger?: ExactLogger;
  /** How long one settle waits for the policy depth before `settlement_pending`. Default 75 s, never more than maxTimeoutSeconds. */
  confirmationTimeoutMs?: number;
  confirmationPollMs?: number;
  maxTransactionBytes?: number;
  maxInputs?: number;
  /** Rule 7's cap, zatoshis. Default 100,000. */
  feeCapZat?: bigint;
  /** Policy for requirements that carry none. Default 1 (the spec's default above the server's zero-conf cap). */
  defaultConfirmations?: number;
  /** The `sapling-proof` method (plan X4a), implemented in src/shielded. */
  shielded?: ShieldedExactHandler;
  /**
   * The node runs `-experimentalfeatures -yellowback`, so `/supported` lists YED (spec "/supported").
   * Verification asks the node itself either way; this only shapes the advertisement.
   */
  yellowback?: boolean;
}

/** The facilitator service's logger shape (packages/facilitator/src/logger.ts). */
export interface ExactLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** What the facilitator service hands each mechanism (packages/facilitator/src/schemes.ts SchemeDeps). */
export interface ExactYcashFacilitatorDeps extends Omit<ExactYcashFacilitatorConfig, "acceptMempool"> {
  rpc: ExactFacilitatorRpc;
  network?: string;
  /** `yellowback` lists YED in `/supported`. */
  capabilities?: { yellowback: boolean };
}

/** One settle call must finish inside core's 90 s facilitator timeout; core retries once on pending. */
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 75_000;
const DEFAULT_CONFIRMATION_POLL_MS = 1_000;

/** Evidence of the payTo output: −1 in the mempool, the depth when mined, null when not seen. */
type Evidence = number | null;

/**
 * The exact-scheme facilitator for Ycash networks: verifies a client's signed transparent payment
 * against the node, and settles it by claiming its txid, broadcasting once and waiting for the
 * requirements' confirmation depth. It holds no keys and pays no fees.
 */
export class ExactYcashFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME_EXACT;
  readonly caipFamily = "ycash:*";

  private readonly store: SettlementStore;
  private readonly limits: VerifyLimits;
  private readonly confirmationTimeoutMs: number;
  private readonly confirmationPollMs: number;
  private readonly shielded: ShieldedExactHandler | undefined;
  private readonly rpc: ExactFacilitatorRpc;
  private readonly logger: ExactLogger | undefined;
  private readonly yellowback: boolean;

  /**
   * Accepts `new ExactYcashFacilitatorScheme(rpc, config)`, or the facilitator service's
   * `new ExactYcashFacilitatorScheme(deps)`; explicit `config` fields override `deps`.
   *
   * @param rpcOrDeps - The node RPC, or the service's dependency bundle carrying it.
   * @param config - Store, confirmation range, limits and optional shielded handler.
   */
  constructor(rpcOrDeps: ExactFacilitatorRpc | ExactYcashFacilitatorDeps, config: ExactYcashFacilitatorConfig = {}) {
    if ("rpc" in rpcOrDeps) {
      this.rpc = rpcOrDeps.rpc;
      config = { ...rpcOrDeps, ...(rpcOrDeps.capabilities ? { yellowback: rpcOrDeps.capabilities.yellowback } : {}), ...config };
    } else {
      this.rpc = rpcOrDeps;
    }
    this.store = config.settlementStore ?? new InMemorySettlementStore();
    const range = config.confirmations ?? { minimum: config.acceptMempool === false ? 0 : MIN_CONFIRMATIONS, maximum: MAX_CONFIRMATIONS };
    this.limits = {
      maxTransactionBytes: config.maxTransactionBytes ?? 100_000,
      maxInputs: config.maxInputs ?? 50,
      feeCapZat: config.feeCapZat ?? 100_000n,
      minConfirmations: Math.max(MIN_CONFIRMATIONS, range.minimum),
      maxConfirmations: Math.min(MAX_CONFIRMATIONS, range.maximum),
      defaultConfirmations: config.defaultConfirmations ?? 1,
    };
    this.logger = config.logger;
    this.confirmationTimeoutMs = config.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    this.confirmationPollMs = config.confirmationPollMs ?? DEFAULT_CONFIRMATION_POLL_MS;
    this.shielded = config.shielded;
    this.yellowback = config.yellowback ?? false;
  }

  /**
   * The `/supported` capability block: assets (YED only on a Yellowback node), transfer methods,
   * and the confirmation range this facilitator settles.
   *
   * @param _network - The network (the block is the same for every Ycash network).
   * @returns The `extra` object advertised for this scheme.
   */
  getExtra(_network: Network): Record<string, unknown> | undefined {
    void _network;
    return {
      assets: this.yellowback ? ["YEC", "YED"] : ["YEC"],
      assetTransferMethods: this.shielded ? [ATM_TRANSPARENT, ATM_SAPLING_PROOF] : [ATM_TRANSPARENT],
      areFeesSponsored: false,
      confirmations: { minimum: this.limits.minConfirmations, maximum: this.limits.maxConfirmations },
    };
  }

  /**
   * No sponsorship: the facilitator holds no keys, so it has no signer addresses.
   *
   * @param _network - The network (unused).
   * @returns An empty list.
   */
  getSigners(_network: string): string[] {
    void _network;
    return [];
  }

  /**
   * Verifies a payment without broadcasting: `sapling-proof` goes to the shielded handler,
   * everything else runs rules 1–10. A node lookup that throws becomes an invalid response.
   *
   * @param payload - The client's payment payload.
   * @param requirements - The server's payment requirements.
   * @param context - Optional facilitator context, passed to the shielded handler.
   * @returns Whether the payment is valid, the reason if not, and the payer.
   */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements, context?: FacilitatorContext): Promise<VerifyResponse> {
    if (isShieldedMethod(requirements.extra)) {
      if (!this.shielded) return { isValid: false, invalidReason: ERR_ASSET_TRANSFER_METHOD, invalidMessage: "no shielded method is configured", payer: "" };
      if (!this.shielded.verify) return { isValid: false, invalidReason: ERR_PAYMENT_FLOW, invalidMessage: "sapling-proof is upfront: settle, not verify", payer: "" };
      return this.shielded.verify(payload, requirements, context);
    }
    try {
      const r = await verifyTransparent(this.rpc, this.store, payload, requirements, this.limits);
      if (!r.ok) return { isValid: false, invalidReason: r.reason, invalidMessage: r.message, payer: r.payer ?? "" };
      return { isValid: true, payer: r.state.payer };
    } catch (e) {
      return { isValid: false, invalidReason: ERR_SETTLEMENT_FAILED, invalidMessage: `node lookup failed: ${(e as Error).message}`, payer: "" };
    }
  }

  /**
   * Settlement (spec "Settlement"): re-run the rules, claim the txid atomically, broadcast once,
   * then observe the payTo outpoint with `gettxout(…, true)` until the policy depth or the wait
   * ends. A settle of an already-claimed txid never broadcasts: it resumes observing.
   *
   * @param payload - The client's payment payload.
   * @param requirements - The server's payment requirements.
   * @param context - Optional facilitator context, passed to the shielded handler.
   * @returns Success with the txid and confirmation status, `settlement_pending`, or a failure.
   */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements, context?: FacilitatorContext): Promise<SettleResponse> {
    if (isShieldedMethod(requirements.extra)) {
      if (!this.shielded) return failure(ERR_ASSET_TRANSFER_METHOD, requirements.network, "", "no shielded method is configured");
      return this.shielded.settle(payload, requirements, context);
    }
    const network = requirements.network;
    const resolved = resolvePayment(payload, requirements, this.limits);
    if (!resolved.ok) return failure(resolved.reason, network, "", resolved.message);
    const s = resolved.state;
    try {
      if (await this.store.isClaimed(s.key)) return this.observe(s, requirements, this.resumedPayer(s));

      const v = await verifyTransparent(this.rpc, this.store, payload, requirements, this.limits);
      if (!v.ok && v.reason === ERR_DUPLICATE_SETTLEMENT) return this.observe(s, requirements, v.payer ?? this.resumedPayer(s));
      if (!v.ok) return failure(v.reason, network, s.txid, v.message, v.payer);
      // The claim is taken before the first await on submission; losing the race means another
      // settle owns the broadcast, so this one only observes.
      if (!(await this.store.claim(s.key, retainUntilForExpiry(s.tx.expiryHeight)))) return this.observe(s, requirements, v.state.payer);
      await this.store.prune(await this.rpc.getBlockCount()); // drops claims past expiry + 10 blocks

      const rejected = await this.submit(s);
      this.logger?.info("exact settle broadcast", { txid: s.txid, rejected: rejected?.reason });
      if (rejected) {
        await this.store.release(s.key); // the node answered and did not accept it
        return failure(rejected.reason, network, s.txid, rejected.message, v.state.payer);
      }
      return this.observe(s, requirements, v.state.payer);
    } catch (e) {
      this.logger?.warn("exact settle failed", { txid: s.txid, error: (e as Error).message });
      return failure(ERR_SETTLEMENT_FAILED, network, s.txid, (e as Error).message);
    }
  }

  /**
   * `sendrawtransaction`. Returns a terminal rejection only when the node certainly did not take
   * the tx; −27 and transport failures continue to observation, keeping the claim (X-F6).
   *
   * @param s - The resolved payment to broadcast.
   * @returns A terminal rejection reason and message, or null to proceed to observation.
   */
  private async submit(s: ResolvedPayment): Promise<{ reason: string; message: string } | null> {
    try {
      const sent = await this.rpc.sendRawTransaction(s.hex);
      if (sent !== s.txid) throw new Error(`node returned txid ${sent}, expected ${s.txid}`);
      return null;
    } catch (e) {
      if (!(e instanceof SendRawTransactionError)) {
        if (e instanceof RpcError && e.transport) return null; // unknown outcome: keep the claim, observe
        throw e;
      }
      if (e.kind === "already-in-chain") return null;
      // Someone else may have relayed the same payload first; its payTo output proves it.
      if (await this.rpc.getTxOut(s.txid, s.payToVout, true)) return null;
      const reason = e.kind === "mempool-conflict" || e.kind === "missing-inputs" ? ERR_INPUT_SPENT : e.kind === "expiring-soon" ? ERR_EXPIRY : ERR_TRANSACTION;
      return { reason, message: `sendrawtransaction ${e.code}: ${e.message}` };
    }
  }

  /**
   * Polls the payTo outpoint until the policy depth is reached or the wait (the configured timeout,
   * capped by `maxTimeoutSeconds`) runs out; a tx unmined past its nExpiryHeight fails as expired.
   *
   * @param s - The resolved payment being settled.
   * @param req - The payment requirements (network and timeout).
   * @param payer - The payer address to report.
   * @returns Success, `settlement_pending`, or an expiry failure.
   */
  private async observe(s: ResolvedPayment, req: PaymentRequirements, payer: string): Promise<SettleResponse> {
    const deadline = Date.now() + Math.min(this.confirmationTimeoutMs, req.maxTimeoutSeconds * 1000);
    let seen: Evidence = null;
    for (;;) {
      seen = await this.evidence(s);
      if (seen !== null && confirmationsSatisfy(seen, s.required)) {
        const extra: ExactYcashSettleExtra = { status: seen < 0 ? "mempool" : "confirmed", confirmations: seen };
        return { success: true, transaction: s.txid, network: req.network, payer, extra: { ...extra } };
      }
      if (Date.now() + this.confirmationPollMs >= deadline) break;
      await new Promise((r) => setTimeout(r, this.confirmationPollMs));
    }
    // Past nExpiryHeight and not in a block, the tx can never land (X-F8: valid through expiry).
    if ((seen === null || seen < 0) && (await this.rpc.getBlockCount()) > s.tx.expiryHeight) {
      return failure(ERR_EXPIRY, req.network, s.txid, `the chain passed nExpiryHeight ${s.tx.expiryHeight} without the transaction`, payer);
    }
    const extra: ExactYcashSettleExtra = { status: "pending", confirmations: seen };
    return {
      success: false,
      errorReason: ERR_SETTLEMENT_PENDING,
      errorMessage: `awaiting ${s.required} confirmation(s)`,
      transaction: s.txid,
      network: req.network,
      payer,
      extra: { ...extra },
    };
  }

  /**
   * Reads the payTo output from the node including the mempool; a transient RPC error counts as
   * "not seen" rather than as absence.
   *
   * @param s - The resolved payment.
   * @returns −1 if in the mempool, the confirmation count if mined, or null if not seen.
   */
  private async evidence(s: ResolvedPayment): Promise<Evidence> {
    try {
      const out = await this.rpc.getTxOut(s.txid, s.payToVout, true);
      if (!out) return null;
      return out.confirmations > 0 ? out.confirmations : -1;
    } catch {
      return null; // a transient node error is not evidence of absence; keep polling
    }
  }

  /**
   * Recovers the payer from input 0's scriptSig when settle resumes a claimed txid without
   * re-verifying; for a YED payment a P2PKH address is re-encoded in the `ye…` form.
   *
   * @param s - The resolved payment.
   * @returns The payer address, or "" when the scriptSig reveals none.
   */
  private resumedPayer(s: ResolvedPayment): string {
    const address = addressOfScriptSig(s.tx.vin[0]?.scriptSig ?? new Uint8Array(), s.network);
    if (!s.yed || !address) return address;
    const d = decodeAddress(address, s.network);
    return d.kind === "p2pkh" ? encodeAddress(s.network, "yed", d.hash) : address;
  }
}

/**
 * Builds a failed settle response, omitting `payer` when it is unknown.
 *
 * @param errorReason - The x402 error reason code.
 * @param network - The requirements' network.
 * @param transaction - The txid, or "" before one is known.
 * @param errorMessage - Human-readable detail.
 * @param payer - The payer address, if known.
 * @returns The settle response.
 */
function failure(errorReason: string, network: Network, transaction: string, errorMessage: string, payer?: string): SettleResponse {
  return { success: false, errorReason, errorMessage, transaction, network, ...(payer ? { payer } : {}) };
}
