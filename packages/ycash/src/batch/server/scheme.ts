// The resource server's `batch-settlement` scheme on Ycash, on @x402/core's SchemeNetworkServer.
// As in the SVM binding, the server owns the voucher watermark: its hooks verify locally before the
// handler (skipping the facilitator), and commit the actual charge after it. The actual charge is
// the settle-time `requirements.amount`, which core sets from `settlementOverrides.amount`.
import type {
  AssetAmount,
  DeepReadonly,
  Network,
  PaymentFlowConfig,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SchemeServerHooks,
  SettleContext,
  SettleResponse,
  SupportedKind,
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyResultContext,
} from "@x402/core/types";
import { DEFAULT_CLOSE_FEE, DEFAULT_CLOSE_MARGIN_BLOCKS, DEFAULT_MIN_LOCK_BLOCKS } from "../../channel/constants.js";
import { closeFeeFloor } from "../../channel/outputs.js";
import { ASSET_YEC, ASSET_YED, YED_MAX_OUTPUT_CENTS } from "../../constants.js";
import { yecToZat } from "../../node/amount.js";
import { bytesToHex } from "../../tx/bytes.js";
import { BatchError, reasonOf } from "../errors.js";
import { BATCH_SETTLEMENT_SCHEME, isBatchPayload } from "../types.js";
import { ChannelManager, type ChannelManagerConfig, type VerifiedVoucher } from "./manager.js";

export interface BatchYcashServerConfig extends ChannelManagerConfig {
  /** the largest D accepted, in the asset's unit */
  maxDeposit: bigint;
  minLockBlocks?: number;
  closeMarginBlocks?: number;
  /** zatoshis; at least the close's fee floor */
  closeFee?: bigint;
  /** the funding policy depth (−1 = mempool, a YEC-only opt-in); default 1 */
  confirmations?: number;
  /** the largest D of a YED channel, cents; default $100,000 (the largest YED output) */
  maxDepositCents?: bigint;
  /**
   * Prices "$0.01" / "0.01 USD" as YED cents at par (YED channels). Without it a USD price is
   * refused: YEC channels take YEC prices.
   */
  usdAsset?: typeof ASSET_YED;
}

/** A decimal dollar amount in whole cents ("0.01" → "1"); a fraction of a cent is refused. */
function centsOf(s: string): string {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`a YED price is a whole number of cents: ${s}`);
  const cents = BigInt(m[1] as string) * 100n + BigInt(((m[2] ?? "") + "00").slice(0, 2));
  if (cents <= 0n) throw new Error("a price must be positive");
  return cents.toString();
}

/** A 115-byte channel script stand-in, for the close-fee floor (C, S and t do not change its size). */
const CLOSE_FLOOR_SCRIPT = new Uint8Array(115);
const CLOSE_FLOOR_OUTPUTS = [
  { value: 0n, scriptPubKey: new Uint8Array(25) },
  { value: 0n, scriptPubKey: new Uint8Array(25) },
];
/** A YED close adds its TRANSFER (two assignments: OP_RETURN, push, 15 payload bytes). */
const CLOSE_FLOOR_OUTPUTS_YED = [...CLOSE_FLOOR_OUTPUTS, { value: 0n, scriptPubKey: new Uint8Array(17) }];

export class BatchYcashScheme implements SchemeNetworkServer {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  /** The binding has one method, so no on-wire assetTransferMethod. */
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { default: "authorization", supported: ["authorization"] },
  } as const satisfies Record<string, PaymentFlowConfig>;
  readonly schemeHooks: SchemeServerHooks;
  readonly manager: ChannelManager;

  private readonly verified = new WeakMap<DeepReadonly<PaymentPayload>, VerifiedVoucher>();
  private readonly cfg: Required<Pick<BatchYcashServerConfig, "minLockBlocks" | "closeMarginBlocks" | "closeFee" | "confirmations" | "maxDepositCents">> & {
    maxDeposit: bigint;
    usdAsset: typeof ASSET_YED | undefined;
  };

  constructor(config: BatchYcashServerConfig) {
    this.cfg = {
      maxDeposit: config.maxDeposit,
      minLockBlocks: config.minLockBlocks ?? DEFAULT_MIN_LOCK_BLOCKS,
      closeMarginBlocks: config.closeMarginBlocks ?? DEFAULT_CLOSE_MARGIN_BLOCKS,
      closeFee: config.closeFee ?? DEFAULT_CLOSE_FEE,
      confirmations: config.confirmations ?? 1,
      maxDepositCents: config.maxDepositCents ?? BigInt(YED_MAX_OUTPUT_CENTS),
      usdAsset: config.usdAsset,
    };
    if (this.cfg.closeMarginBlocks >= this.cfg.minLockBlocks) throw new Error("closeMarginBlocks must be below minLockBlocks");
    const floor = closeFeeFloor(CLOSE_FLOOR_SCRIPT, CLOSE_FLOOR_OUTPUTS_YED); // ≥ the YEC close's floor
    if (this.cfg.closeFee < floor) throw new Error(`closeFee ${this.cfg.closeFee} is below the close's fee floor ${floor}`);
    this.manager = new ChannelManager(config);
    this.schemeHooks = {
      onBeforeVerify: (ctx) => this.beforeVerify(ctx),
      onAfterVerify: (ctx) => this.afterVerify(ctx),
      onBeforeSettle: (ctx) => this.beforeSettle(ctx),
      onVerifiedPaymentCanceled: (ctx) => this.onCanceled(ctx),
    };
  }

  /**
   * YEC prices: a decimal YEC amount ("0.0002", 0.0002) or an AssetAmount in zatoshis. YED prices:
   * "0.01 YED", "$0.01" with `usdAsset: "YED"`, or an AssetAmount in cents. A YED ceiling may be
   * below $1.00: the dollar floor applies to the voucher's cumulative, not to one request (X-7).
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (price.asset !== ASSET_YEC && price.asset !== ASSET_YED) throw new Error(`batch-settlement on ${network}: asset ${price.asset} is not supported here`);
      if (!/^[1-9][0-9]*$/.test(price.amount)) throw new Error(`amount must be a positive canonical integer: ${price.amount}`);
      return { amount: price.amount, asset: price.asset };
    }
    const s = typeof price === "number" ? price.toFixed(8) : price.trim();
    const yed = /\s*YED$/i.test(s) || (s.startsWith("$") && this.cfg.usdAsset === ASSET_YED) || (/\s*USD$/i.test(s) && this.cfg.usdAsset === ASSET_YED);
    if (yed) return { amount: centsOf(s.replace(/^\$/, "").replace(/\s*(YED|USD)$/i, "")), asset: ASSET_YED };
    if (s.startsWith("$")) throw new Error("USD prices need a price source; give the price in YEC");
    return { amount: yecToZat(s.replace(/\s*YEC$/i, "")).toString(), asset: ASSET_YEC };
  }

  async enhancePaymentRequirements(req: PaymentRequirements, _kind: SupportedKind, _ext: string[]): Promise<PaymentRequirements> {
    const yed = req.asset === ASSET_YED;
    // YED vouchers are checkable only against confirmed token records (plan X-F14).
    if (yed && this.cfg.confirmations < 0) throw new Error("YED channels require a funding depth of at least 0 (in a block)");
    return {
      ...req,
      extra: {
        ...req.extra,
        serverPubKey: bytesToHex(this.manager.serverPubKey),
        minLockBlocks: this.cfg.minLockBlocks,
        closeMarginBlocks: this.cfg.closeMarginBlocks,
        maxDeposit: (yed ? this.cfg.maxDepositCents : this.cfg.maxDeposit).toString(),
        closeFee: this.cfg.closeFee.toString(),
        areFeesSponsored: false,
        confirmationPolicy: { confirmations: this.cfg.confirmations },
      },
    };
  }

  /** The corrective 402 of a cumulative mismatch or a stale voucher carries `channelState`. */
  enrichPaymentRequiredResponse = async (ctx: SchemePaymentRequiredContext): Promise<PaymentRequirements[] | void> => {
    if (ctx.error !== BatchError.CUMULATIVE_MISMATCH && ctx.error !== BatchError.STALE_VOUCHER) return;
    const raw = ctx.paymentPayload?.payload;
    if (!isBatchPayload(raw) || raw.type === "open" || raw.type === "claim") return;
    let state;
    try {
      state = await this.manager.channelState(raw.channelId);
    } catch {
      return;
    }
    const accept = ctx.requirements.find((r) => r.scheme === this.scheme && r.network === ctx.paymentPayload?.accepted.network);
    if (!accept) return;
    accept.extra = { ...accept.extra, channelState: state };
    return ctx.requirements;
  };

  // ------------------------------------------------------------------ hooks

  private async beforeVerify(ctx: VerifyContext) {
    if (ctx.requirements.scheme !== this.scheme) return;
    try {
      const v = await this.manager.verify(ctx.paymentPayload as PaymentPayload, ctx.requirements);
      this.verified.set(ctx.paymentPayload, v);
      return { skip: true as const, result: { isValid: true, payer: v.channelId, extra: { channelId: v.channelId, cumulative: v.cumulative.toString() } } };
    } catch (e) {
      return { abort: true as const, reason: reasonOf(e), message: (e as Error).message };
    }
  }

  private async afterVerify(ctx: VerifyResultContext) {
    const v = this.verified.get(ctx.paymentPayload);
    // A client close runs no handler: settle broadcasts it.
    if (v?.kind === "close") return { skipHandler: true as const, response: { body: { channelId: v.channelId, message: "closing" } } };
    return undefined;
  }

  private async beforeSettle(ctx: SettleContext) {
    const v = this.verified.get(ctx.paymentPayload);
    if (!v) return;
    this.verified.delete(ctx.paymentPayload);
    try {
      const result: SettleResponse = await this.manager.settle(v, BigInt(ctx.requirements.amount));
      return { skip: true as const, result };
    } catch (e) {
      return { abort: true as const, reason: reasonOf(e), message: (e as Error).message };
    }
  }

  private async onCanceled(ctx: VerifiedPaymentCanceledContext): Promise<void> {
    const v = this.verified.get(ctx.paymentPayload);
    if (!v) return;
    this.verified.delete(ctx.paymentPayload);
    await this.manager.release(v);
  }
}
