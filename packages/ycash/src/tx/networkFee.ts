// The network fee of post-quantum and Yellowback transactions (rpcversion 8, the fee structure;
// docs/plans/yellowback-quantum-fees-spec.md §3.1 in the workspace). Policy, not consensus: the node
// publishes dollar-per-KB rates at the attested price in yed_getinfo.params.fees.network
// (ycash-dd src/policy/policy.cpp PlainPQFeeRate / YedFeeRate / YedMaxTxFee), and its wallets pay
//   fee = max(flat floor, min(rate × size / 1000, cap))
// with the plain PQ rate for a transaction that spends a post-quantum input, the Yellowback rate for a
// YED or vault transaction, and the Yellowback cap for both (owner D-Q-26). Every other transaction
// keeps the S-6 floor (fee.ts). The SDK reads the node-computed zat rates and never does price arithmetic.
import { feeFloor } from "./fee.js";
import { serializeTx, type Tx } from "./tx.js";

/** Which rate a transaction pays: S-6 only, the plain PQ rate, or the Yellowback rate. */
export type FeeKind = "plain" | "pq" | "yellowback";

/** `yed_getinfo.params.fees.network` as the SDK uses it, amounts in zatoshis. */
export interface NetworkFees {
  /** The attested price the rates were computed at (µUSD per YEC); null when none ("fallback"). */
  priceMicroUsd: number | null;
  /** "tip", or "fallback" (no price: both rates are the node's -pqfeerate). */
  priceSource: string;
  /** The plain post-quantum rate ($0.02/KB at the price), zatoshis per 1,000 bytes. */
  plainZatPerKB: bigint;
  /** The vault/Yellowback rate ($0.05/KB at the price), zatoshis per 1,000 bytes. */
  yellowbackZatPerKB: bigint;
  /** The wallet's flat floor (DEFAULT_FEE on v4.5.0). */
  flatZat: bigint;
  /** -maxtxfee: what sendrawtransaction accepts without allowhighfees. */
  maxTxFeeZat: bigint;
  /** The cap of a PQ or Yellowback transaction: min(max(-maxtxfee, $2 at the price), -yellowbackmaxtxfee). */
  yellowbackMaxTxFeeZat: bigint;
}

/** The rpcversion that introduced params.fees (the node's yed_getinfo). */
export const FEES_RPC_VERSION = 8;

const zat = (v: unknown): bigint | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined);

/**
 * The network fee rates from a `yed_getinfo` result.
 *
 * @param info - The `yed_getinfo` result.
 * @returns The rates, or undefined when the node is older than rpcversion 8 or does not report them
 * (callers then pay the S-6 floor, as before).
 */
export function networkFeesOf(info: { [field: string]: unknown }): NetworkFees | undefined {
  if (typeof info.rpcversion !== "number" || info.rpcversion < FEES_RPC_VERSION) return undefined;
  const n = ((info.params as { fees?: { network?: unknown } } | undefined)?.fees?.network ?? undefined) as
    | { priceMicroUsd?: unknown; priceSource?: unknown; plain?: { zatPerKB?: unknown }; yellowback?: { zatPerKB?: unknown; maxTxFeeZat?: unknown }; flatZat?: unknown; maxTxFeeZat?: unknown }
    | undefined;
  if (!n) return undefined;
  const plain = zat(n.plain?.zatPerKB);
  const yellowback = zat(n.yellowback?.zatPerKB);
  const flat = zat(n.flatZat);
  const max = zat(n.maxTxFeeZat);
  const cap = zat(n.yellowback?.maxTxFeeZat);
  if (plain === undefined || yellowback === undefined || flat === undefined || max === undefined || cap === undefined) return undefined;
  const price = typeof n.priceMicroUsd === "number" && n.priceMicroUsd > 0 ? n.priceMicroUsd : null;
  return {
    priceMicroUsd: price,
    priceSource: typeof n.priceSource === "string" ? n.priceSource : price === null ? "fallback" : "tip",
    plainZatPerKB: plain,
    yellowbackZatPerKB: yellowback,
    flatZat: flat,
    maxTxFeeZat: max,
    yellowbackMaxTxFeeZat: cap,
  };
}

/**
 * The node's current network fee rates (never cached: they follow the attested price).
 *
 * @param rpc - A node view that may answer `yed_getinfo`.
 * @param rpc.yedGetInfo - `yed_getinfo`, when the view has it.
 * @returns The rates, or undefined from a node without the overlay or older than rpcversion 8.
 */
export async function readNetworkFees(rpc: { yedGetInfo?(): Promise<{ [field: string]: unknown }> }): Promise<NetworkFees | undefined> {
  if (typeof rpc.yedGetInfo !== "function") return undefined;
  try {
    return networkFeesOf(await rpc.yedGetInfo());
  } catch {
    return undefined; // a node without the Yellowback overlay
  }
}

/**
 * CFeeRate::GetFee: rate × size / 1000, rounded down, and never 0 for a positive rate (src/amount.cpp).
 *
 * @param zatPerKB - The rate.
 * @param size - The transaction size in bytes.
 * @returns The size fee, zatoshis.
 */
export function sizeFee(zatPerKB: bigint, size: number): bigint {
  const fee = (zatPerKB * BigInt(size)) / 1000n;
  return fee === 0n && zatPerKB > 0n ? zatPerKB : fee;
}

/**
 * The fee the SDK pays for a draft (signatures at their largest, so the signed transaction is no
 * larger): the S-6 floor for a plain transaction or when the node gave no rates; else
 * max(S-6 floor, flatZat, min(rate × size / 1000, cap)).
 *
 * @param tx - The draft.
 * @param kind - Which rate applies.
 * @param fees - The node's rates (rpcversion 8), if known.
 * @returns The fee, zatoshis.
 */
export function networkFee(tx: Tx, kind: FeeKind, fees: NetworkFees | undefined): bigint {
  const floor = feeFloor(tx);
  if (kind === "plain" || !fees) return floor;
  const rate = kind === "pq" ? fees.plainZatPerKB : fees.yellowbackZatPerKB;
  const priced = sizeFee(rate, serializeTx(tx).length);
  const capped = priced < fees.yellowbackMaxTxFeeZat ? priced : fees.yellowbackMaxTxFeeZat;
  const flat = fees.flatZat > floor ? fees.flatZat : floor;
  return capped > flat ? capped : flat;
}

/**
 * The highest fee a facilitator accepts: its own cap for a plain transaction, at least the node's
 * PQ/Yellowback cap for the others (a correctly priced YED spend pays far more than a plain cap).
 *
 * @param kind - Which rate the transaction pays.
 * @param plainCap - The facilitator's configured cap.
 * @param fees - The node's rates, if known.
 * @returns The cap, zatoshis.
 */
export function networkFeeCap(kind: FeeKind, plainCap: bigint, fees: NetworkFees | undefined): bigint {
  if (kind === "plain" || !fees) return plainCap;
  return fees.yellowbackMaxTxFeeZat > plainCap ? fees.yellowbackMaxTxFeeZat : plainCap;
}

/**
 * Whether sendrawtransaction must be told `allowhighfees`: the fee is above -maxtxfee (the node's
 * own Yellowback paths submit with the check off and cap the fee themselves; so does the SDK, which
 * checked the fee against {@link networkFeeCap} first).
 *
 * @param fee - The transaction's fee.
 * @param kind - Which rate the transaction pays.
 * @param fees - The node's rates, if known.
 * @returns True when the fee is within the PQ/Yellowback cap and above -maxtxfee.
 */
export function needsHighFees(fee: bigint, kind: FeeKind, fees: NetworkFees | undefined): boolean {
  return kind !== "plain" && fees !== undefined && fee > fees.maxTxFeeZat && fee <= fees.yellowbackMaxTxFeeZat;
}
