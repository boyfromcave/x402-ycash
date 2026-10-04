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
import { ATM_SAPLING, ATM_SAPLING_PROOF, ATM_TRANSPARENT, FLOW_AUTHORIZATION, type ConfirmationPolicy } from "./types.js";

/** Dust threshold of a P2PKH/P2SH output at the default relay fee (plan S-5, X-F15). */
export const DUST_ZAT = 54n;
export const MIN_CONFIRMATIONS = -1;
export const MAX_CONFIRMATIONS = 20;

/**
 * Narrows a CAIP-2 string to one of the Ycash network ids this binding serves.
 *
 * @param network - The network id from a requirement or payload.
 * @returns True when it is a known Ycash network.
 */
export function isYcashNetwork(network: string): network is YcashNetwork {
  return (YCASH_NETWORKS as readonly string[]).includes(network);
}

/**
 * Maps a network id to the `getblockchaininfo.chain` value its node reports (verification rule 2).
 *
 * @param network - The Ycash network id.
 * @returns "main", "test" or "regtest".
 */
export function chainOfNetwork(network: YcashNetwork): string {
  return network === YCASH_MAINNET ? "main" : network === YCASH_TESTNET ? "test" : "regtest";
}

/**
 * Reads `extra.assetTransferMethod`, defaulting an absent one to `transparent`.
 *
 * @param extra - The requirement's `extra`.
 * @returns The named method, unvalidated.
 */
export function assetTransferMethodOf(extra: Record<string, unknown> | undefined): unknown {
  return extra?.assetTransferMethod ?? ATM_TRANSPARENT;
}

/**
 * Whether a requirement selects a shielded transfer method (`sapling-proof` or `sapling`), which the
 * exact scheme routes to its shielded handler.
 *
 * @param extra - The requirement's `extra`.
 * @returns True for a shielded method.
 */
export function isShieldedMethod(extra: Record<string, unknown> | undefined): boolean {
  const m = assetTransferMethodOf(extra);
  return m === ATM_SAPLING_PROOF || m === ATM_SAPLING;
}

/**
 * `extra.confirmationPolicy`, a closed object `{confirmations}` with an integer in [−1, 20]. An
 * absent policy resolves to `fallback`; a malformed one to null.
 *
 * @param extra - The requirement's `extra`.
 * @param fallback - Confirmations to use when no policy is given.
 * @returns The resolved policy, or null when malformed.
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
 *
 * @param observed - Confirmations seen: −1 in mempool, else the block depth.
 * @param required - The policy's `confirmations`.
 * @returns True when the evidence is sufficient.
 */
export function confirmationsSatisfy(observed: number, required: number): boolean {
  return observed >= required;
}

/**
 * Converts a timeout to blocks at the 75-second target spacing, rounding up.
 *
 * @param maxTimeoutSeconds - The requirement's timeout.
 * @returns ⌈maxTimeoutSeconds / 75⌉.
 */
export function timeoutBlocks(maxTimeoutSeconds: number): number {
  return Math.ceil(maxTimeoutSeconds / BLOCK_SECONDS);
}

/**
 * The `nExpiryHeight` a client sets: tip + 3 + ⌈maxTimeoutSeconds / 75⌉ (Transaction Construction).
 *
 * @param tip - The client's current chain height.
 * @param maxTimeoutSeconds - The requirement's timeout.
 * @returns The expiry height.
 */
export function clientExpiryHeight(tip: number, maxTimeoutSeconds: number): number {
  return tip + TX_EXPIRING_SOON_THRESHOLD + timeoutBlocks(maxTimeoutSeconds);
}

/**
 * Rule 8's window, inclusive: tip + 4 ≤ nExpiryHeight ≤ tip + 4 + ⌈maxTimeoutSeconds / 75⌉ + 1.
 * The lower bound is the node's relay floor, next block + TX_EXPIRING_SOON_THRESHOLD
 * (ycash-dd/src/main.cpp:742, ycash6 :799; plan R-2, X-F8). The "+ 1" absorbs one block found
 * between the client reading its tip and the facilitator reading its own.
 *
 * @param tip - The facilitator's current chain height.
 * @param maxTimeoutSeconds - The requirement's timeout.
 * @returns The inclusive bounds on `nExpiryHeight`.
 */
export function expiryWindow(tip: number, maxTimeoutSeconds: number): { min: number; max: number } {
  const min = tip + 1 + TX_EXPIRING_SOON_THRESHOLD;
  return { min, max: min + timeoutBlocks(maxTimeoutSeconds) + 1 };
}

const CANONICAL_AMOUNT = /^[1-9][0-9]*$/;

/**
 * The form checks of a `transparent` YEC requirement (Assets and Amounts, PaymentRequirements).
 *
 * @param req - The requirement to check.
 * @returns A reason string, or null when the requirement is well formed.
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
 * and a Yellowback `payTo` of the requirements' network.
 *
 * @param req - The requirement to check.
 * @returns A reason string, or null when the requirement is well formed.
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

/**
 * Dispatches the form checks of a `transparent` requirement by asset (YED, else YEC).
 *
 * @param req - The requirement to check.
 * @returns A reason string, or null when the requirement is well formed.
 */
export function checkTransparentRequirements(req: PaymentRequirements): string | null {
  return req.asset === ASSET_YED ? checkTransparentYedRequirements(req) : checkTransparentYecRequirements(req);
}

/**
 * Method, flow and fee-sponsorship checks shared by every `transparent` party: the method must be
 * `transparent`, the flow absent or authorization, and fees not sponsored.
 *
 * @param extra - The requirement's `extra`.
 * @returns The failing check and a message, or null when all pass.
 */
export function checkTransparentMethod(extra: Record<string, unknown> | undefined): { reason: "method" | "flow" | "fees"; message: string } | null {
  const method = assetTransferMethodOf(extra);
  if (method === ATM_SAPLING) return { reason: "method", message: "assetTransferMethod sapling is a shielded method (src/shielded), not transparent" };
  if (method !== ATM_TRANSPARENT) return { reason: "method", message: `unknown assetTransferMethod ${String(method)}` };
  const flow = extra?.paymentFlow;
  if (flow !== undefined && flow !== FLOW_AUTHORIZATION) return { reason: "flow", message: `paymentFlow must be absent or ${FLOW_AUTHORIZATION} for transparent` };
  if (extra?.areFeesSponsored !== undefined && extra.areFeesSponsored !== false) return { reason: "fees", message: "areFeesSponsored must be false" };
  return null;
}
