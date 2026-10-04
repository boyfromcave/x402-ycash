// Wire types of `batch-settlement` on Ycash (specs/scheme_batch_settlement_ycash.md, "Payload Types",
// "`PaymentRequirements`", "Settlement").
import type { PaymentRequirements } from "@x402/core/types";
import { ASSET_YEC, ASSET_YED, YCASH_NETWORKS, type YcashAsset, type YcashNetwork } from "../constants.js";
import { isValidCompressedPubKey } from "../channel/script.js";
import { hexToBytes } from "../tx/bytes.js";
import { BatchError, BatchSettlementError } from "./errors.js";

export const BATCH_SETTLEMENT_SCHEME = "batch-settlement" as const;

export interface BatchVoucher {
  /** lowercase hex of the client-signed voucher transaction */
  tx: string;
  /** decimal string, the total the voucher pays the server */
  cumulative: string;
}

export interface BatchOpenPayload {
  type: "open";
  fundingTx: string;
  vout: number;
  redeemScript: string;
  /**
   * Where every voucher (and so the close) returns the client's remainder: a transparent address
   * of the client's wallet (P2PKH or P2SH for YEC; P2PKH, `s…` or `ye…`, for YED). Bound for the
   * channel's life.
   */
  returnAddress: string;
  voucher: BatchVoucher;
}

export interface BatchVoucherPayload extends BatchVoucher {
  type: "voucher";
  channelId: string;
}

/** A voucher at exactly the charged total, asking the server to close now. */
export interface BatchClosePayload extends BatchVoucher {
  type: "close";
  channelId: string;
}

/** Server to facilitator: broadcast a voucher the server completed. */
export interface BatchClaimPayload extends BatchVoucher {
  type: "claim";
  channelId: string;
}

export type BatchClientPayload = BatchOpenPayload | BatchVoucherPayload | BatchClosePayload;
export type BatchPayload = BatchClientPayload | BatchClaimPayload;

/** `PaymentRequirements.extra` as sent. */
export interface BatchYcashExtra {
  serverPubKey: string;
  minLockBlocks: number;
  closeMarginBlocks: number;
  maxDeposit: string;
  closeFee: string;
  areFeesSponsored?: false;
  confirmationPolicy?: { confirmations: number };
  /** Corrective 402 only: the server's view of the channel. */
  channelState?: BatchChannelState;
}

/** `extra.channelState` of a settle response or a corrective 402. */
export interface BatchChannelState {
  channelId: string;
  deposit: string;
  chargedCumulative: string;
  signedCumulative: string;
  refundHeight: number;
  closeMarginBlocks: number;
}

/** The parsed, validated requirements of one channel offer. */
export interface BatchTerms {
  network: YcashNetwork;
  asset: YcashAsset;
  /** the per-request ceiling */
  amount: bigint;
  payTo: string;
  maxTimeoutSeconds: number;
  serverPubKey: Uint8Array;
  minLockBlocks: number;
  closeMarginBlocks: number;
  maxDeposit: bigint;
  closeFee: bigint;
  /** −1 mempool, 0 in a block, N confirmations */
  confirmations: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isHex = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length % 2 === 0 && /^[0-9a-f]*$/.test(v);
const isDecimal = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,17})$/.test(v);

function isVoucherFields(v: Record<string, unknown>): boolean {
  return isHex(v.tx) && isDecimal(v.cumulative);
}

export function isBatchPayload(v: unknown): v is BatchPayload {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case "open":
      return isHex(v.fundingTx) && Number.isInteger(v.vout) && (v.vout as number) >= 0 && isHex(v.redeemScript) &&
        typeof v.returnAddress === "string" && v.returnAddress.length > 0 && isRecord(v.voucher) && isVoucherFields(v.voucher);
    case "voucher":
    case "close":
    case "claim":
      return typeof v.channelId === "string" && isVoucherFields(v);
    default:
      return false;
  }
}

function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new BatchSettlementError(BatchError.REQUIREMENTS, `extra.${what} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

function amount(v: unknown, what: string): bigint {
  if (!isDecimal(v) || BigInt(v) <= 0n) throw new BatchSettlementError(BatchError.REQUIREMENTS, `${what} must be a positive decimal string`);
  return BigInt(v);
}

/** Validates a `batch-settlement` requirements entry and returns its terms. */
export function parseTerms(req: PaymentRequirements): BatchTerms {
  if (req.scheme !== BATCH_SETTLEMENT_SCHEME) throw new BatchSettlementError(BatchError.REQUIREMENTS, `scheme ${req.scheme}`);
  if (!(YCASH_NETWORKS as readonly string[]).includes(req.network)) throw new BatchSettlementError("invalid_network", `network ${req.network}`);
  if (req.asset !== ASSET_YEC && req.asset !== ASSET_YED) throw new BatchSettlementError(BatchError.REQUIREMENTS, `asset ${req.asset}`);
  const x = req.extra ?? {};
  if (typeof x.serverPubKey !== "string" || !/^[0-9a-f]{66}$/.test(x.serverPubKey) || !isValidCompressedPubKey(hexToBytes(x.serverPubKey))) {
    throw new BatchSettlementError(BatchError.REQUIREMENTS, "extra.serverPubKey must be a compressed key in lowercase hex");
  }
  const minLockBlocks = int(x.minLockBlocks, "minLockBlocks", 1, 1_000_000);
  const closeMarginBlocks = int(x.closeMarginBlocks, "closeMarginBlocks", 0, minLockBlocks - 1);
  if (x.areFeesSponsored !== undefined && x.areFeesSponsored !== false) {
    throw new BatchSettlementError(BatchError.REQUIREMENTS, "extra.areFeesSponsored must be false");
  }
  let confirmations = 1;
  if (x.confirmationPolicy !== undefined) {
    if (!isRecord(x.confirmationPolicy)) throw new BatchSettlementError(BatchError.REQUIREMENTS, "extra.confirmationPolicy");
    confirmations = int(x.confirmationPolicy.confirmations, "confirmationPolicy.confirmations", -1, 20);
  }
  // YED vouchers are only checkable against confirmed token records (plan X-F14).
  if (req.asset === ASSET_YED && confirmations < 0) {
    throw new BatchSettlementError(BatchError.REQUIREMENTS, "YED channels require confirmations ≥ 0");
  }
  return {
    network: req.network as YcashNetwork,
    asset: req.asset,
    amount: amount(req.amount, "amount"),
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    serverPubKey: hexToBytes(x.serverPubKey),
    minLockBlocks,
    closeMarginBlocks,
    maxDeposit: amount(x.maxDeposit, "extra.maxDeposit"),
    closeFee: amount(x.closeFee, "extra.closeFee"),
    confirmations,
  };
}

/**
 * The `gettxout` confirmations a policy needs: −1 is mempool acceptance (gettxout with mempool
 * reports 0), 0 means in a block, which is the node's 1 (scheme_exact_ycash.md, "Confirmation policy").
 */
export function requiredDepth(confirmations: number): number {
  return confirmations < 0 ? 0 : Math.max(1, confirmations);
}

/** The fields of `accepted` that must equal the requirements (`exact` rule 1). */
const SERVER_EXTRA_FIELDS = ["serverPubKey", "minLockBlocks", "closeMarginBlocks", "maxDeposit", "closeFee", "areFeesSponsored", "confirmationPolicy"] as const;

/** Envelope rule: `accepted` matches the requirements in every field the server declared. */
export function sameOffer(accepted: PaymentRequirements, req: PaymentRequirements): boolean {
  if (accepted.scheme !== req.scheme || accepted.network !== req.network || accepted.asset !== req.asset ||
    accepted.amount !== req.amount || accepted.payTo !== req.payTo || accepted.maxTimeoutSeconds !== req.maxTimeoutSeconds) return false;
  for (const k of SERVER_EXTRA_FIELDS) {
    if (JSON.stringify(accepted.extra?.[k]) !== JSON.stringify(req.extra?.[k])) return false;
  }
  return true;
}
