// The pure rules of the exact binding: networks, confirmation policy, the expiry window, the
// requirement forms. Shared by client, server and facilitator so the three never disagree.
import type { PaymentRequirements } from "@x402/core/types";
import {
  ASSET_YEC,
  ASSET_YED,
  BLOCK_SECONDS,
  TX_EXPIRING_SOON_THRESHOLD,
  YCASH_NETWORKS,
  YCASH_MAINNET,
  YCASH_TESTNET,
  YED_MAX_OUTPUT_CENTS,
  YED_MIN_OUTPUT_CENTS,
  type YcashNetwork,
} from "../constants.js";
import { decodeAddress } from "../tx/index.js";
import { ATM_SAPLING_PROOF, ATM_SAPLING_RESERVED, ATM_TRANSPARENT, FLOW_AUTHORIZATION, type ConfirmationPolicy } from "./types.js";

/** Dust threshold of a P2PKH/P2SH output at the default relay fee (plan S-5, X-F15). */
export const DUST_ZAT = 54n;
export const MIN_CONFIRMATIONS = -1;
export const MAX_CONFIRMATIONS = 20;

export function isYcashNetwork(network: string): network is YcashNetwork {
  return (YCASH_NETWORKS as readonly string[]).includes(network);
}

/** `getblockchaininfo.chain` of each network id (verification rule 2). */
export function chainOfNetwork(network: YcashNetwork): string {
  return network === YCASH_MAINNET ? "main" : network === YCASH_TESTNET ? "test" : "regtest";
}

/** The method a requirement names; absent means `transparent`. */
export function assetTransferMethodOf(extra: Record<string, unknown> | undefined): unknown {
  return extra?.assetTransferMethod ?? ATM_TRANSPARENT;
}

export function isShieldedMethod(extra: Record<string, unknown> | undefined): boolean {
  return assetTransferMethodOf(extra) === ATM_SAPLING_PROOF;
}

/**
 * `extra.confirmationPolicy`, a closed object `{confirmations}` with an integer in [−1, 20]. An
 * absent policy resolves to `fallback`; a malformed one to null.
 */
export function resolveConfirmationPolicy(extra: Record<string, unknown> | undefined, fallback: number): ConfirmationPolicy | null {
  const value = extra?.confirmationPolicy;
  if (value === undefined) return { confirmations: fallback };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "confirmations") return null;
  const n = (value as ConfirmationPolicy).confirmations;
  if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_CONFIRMATIONS || n > MAX_CONFIRMATIONS) return null;
  return { confirmations: n };
}

/**
 * Whether observed evidence meets the policy. Evidence is −1 for a mempool tx and the node's
 * depth (≥ 1) for a mined one, so 0 and 1 both need a block, as the spec says.
 */
export function confirmationsSatisfy(observed: number, required: number): boolean {
  return observed >= required;
}

/** ⌈maxTimeoutSeconds / 75⌉: the blocks the validity window spans. */
export function timeoutBlocks(maxTimeoutSeconds: number): number {
  return Math.ceil(maxTimeoutSeconds / BLOCK_SECONDS);
}

/** The client's expiry: tip + 3 + ⌈maxTimeoutSeconds / 75⌉ (Transaction Construction). */
export function clientExpiryHeight(tip: number, maxTimeoutSeconds: number): number {
  return tip + TX_EXPIRING_SOON_THRESHOLD + timeoutBlocks(maxTimeoutSeconds);
}

/**
 * Rule 8's window, inclusive: tip + 4 ≤ nExpiryHeight ≤ tip + 4 + ⌈maxTimeoutSeconds / 75⌉ + 1.
 * The lower bound is the node's relay floor, next block + TX_EXPIRING_SOON_THRESHOLD
 * (ycash-dd/src/main.cpp:742, ycash6 :799; plan R-2, X-F8). The "+ 1" absorbs one block found
 * between the client reading its tip and the facilitator reading its own.
 */
export function expiryWindow(tip: number, maxTimeoutSeconds: number): { min: number; max: number } {
  const min = tip + 1 + TX_EXPIRING_SOON_THRESHOLD;
  return { min, max: min + timeoutBlocks(maxTimeoutSeconds) + 1 };
}

const CANONICAL_AMOUNT = /^[1-9][0-9]*$/;

/**
 * The form checks of a `transparent` YEC requirement (Assets and Amounts, PaymentRequirements).
 * Returns a reason string, or null when the requirement is well formed.
 */
export function checkTransparentYecRequirements(req: PaymentRequirements): string | null {
  if (!isYcashNetwork(req.network)) return `unsupported network ${req.network}`;
  if (req.asset !== ASSET_YEC) return `asset must be ${ASSET_YEC}`;
  if (typeof req.amount !== "string" || !CANONICAL_AMOUNT.test(req.amount)) return "amount must be a positive canonical integer";
  if (BigInt(req.amount) < DUST_ZAT) return `amount below the dust threshold of ${DUST_ZAT} zatoshis`;
  if (!Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) return "maxTimeoutSeconds must be a positive integer";
  try {
    // The network comes from the requirements, never from the address (plan X-F1).
    if (decodeAddress(req.payTo, req.network).kind === "yed") return "a YEC payTo must be a transparent address";
  } catch (e) {
    return `invalid payTo: ${(e as Error).message}`;
  }
  return null;
}

/**
 * The form checks of a `transparent` YED requirement (Assets and Amounts): `amount` in cents in
 * [100, 10,000,000] (XFER-1: a smaller YED output burns, ycash-dd/src/yellowback/params.cpp:18-19)
 * and a Yellowback `payTo` of the requirements' network. A reason, or null.
 */
export function checkTransparentYedRequirements(req: PaymentRequirements): string | null {
  if (!isYcashNetwork(req.network)) return `unsupported network ${req.network}`;
  if (req.asset !== ASSET_YED) return `asset must be ${ASSET_YED}`;
  if (typeof req.amount !== "string" || !CANONICAL_AMOUNT.test(req.amount)) return "amount must be a positive canonical integer";
  const cents = BigInt(req.amount);
  if (cents < BigInt(YED_MIN_OUTPUT_CENTS) || cents > BigInt(YED_MAX_OUTPUT_CENTS)) {
    return `a YED amount must be ${YED_MIN_OUTPUT_CENTS}..${YED_MAX_OUTPUT_CENTS} cents ($1.00 to $100,000): a smaller output burns`;
  }
  if (!Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) return "maxTimeoutSeconds must be a positive integer";
  try {
    if (decodeAddress(req.payTo, req.network).kind !== "yed") return "a YED payTo must be a Yellowback (ye…/yt…/yr…) address";
  } catch (e) {
    return `invalid payTo: ${(e as Error).message}`;
  }
  return null;
}

/** The form checks of a `transparent` requirement of either asset. */
export function checkTransparentRequirements(req: PaymentRequirements): string | null {
  return req.asset === ASSET_YED ? checkTransparentYedRequirements(req) : checkTransparentYecRequirements(req);
}

/** Method and flow checks shared by every `transparent` party: a reason, or null. */
export function checkTransparentMethod(extra: Record<string, unknown> | undefined): { reason: "method" | "flow" | "fees"; message: string } | null {
  const method = assetTransferMethodOf(extra);
  if (method === ATM_SAPLING_RESERVED) return { reason: "method", message: "assetTransferMethod sapling is reserved, not yet specified" };
  if (method !== ATM_TRANSPARENT) return { reason: "method", message: `unknown assetTransferMethod ${String(method)}` };
  const flow = extra?.paymentFlow;
  if (flow !== undefined && flow !== FLOW_AUTHORIZATION) return { reason: "flow", message: `paymentFlow must be absent or ${FLOW_AUTHORIZATION} for transparent` };
  if (extra?.areFeesSponsored !== undefined && extra.areFeesSponsored !== false) return { reason: "fees", message: "areFeesSponsored must be false" };
  return null;
}
