import type { YcashNetwork } from "../constants.js";

/**
 * Blocks a claim outlives the transaction's `nExpiryHeight`. After expiry the node refuses the tx
 * (`tx-overwinter-expired`), so a retained key only has to cover reorgs near the tip (plan §5.6,
 * "Duplicate submission"; the XRPL and Cardano rule).
 */
export const SETTLEMENT_RETENTION_BLOCKS = 10;

/** Retain forever: the Lightning rule for a consumption key that must never be reused. */
export const RETAIN_FOREVER = Number.POSITIVE_INFINITY;

/**
 * The durable consumption key `ycash:<net>:<id>` (the Lightning rule). The network id already
 * carries the namespace (`ycash:regtest`), so the key is the network id plus the id.
 */
export function consumptionKey(network: YcashNetwork, id: string): string {
  if (id === "" || id.includes(":")) throw new Error(`consumption id must be non-empty and colon-free: ${id}`);
  return `${network}:${id}`;
}

/** The key for a transparent payment: its txid, lowercase, under the network. */
export function txidKey(network: YcashNetwork, txid: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`not a txid: ${txid}`);
  return consumptionKey(network, txid.toLowerCase());
}

/** retainUntilHeight for a tx: its expiry plus the retention margin. An expiry of 0 is refused (§5.6). */
export function retainUntilForExpiry(expiryHeight: number): number {
  if (!Number.isSafeInteger(expiryHeight) || expiryHeight <= 0) throw new Error(`expiry height must be positive: ${expiryHeight}`);
  return expiryHeight + SETTLEMENT_RETENTION_BLOCKS;
}

/**
 * Duplicate-settlement and consumption guard shared by every facilitator worker, modelled on the
 * Cardano mechanism's settlement store. `claim` is atomic: of any number of concurrent claims of
 * one key, across processes for a shared implementation, exactly one returns true.
 */
export interface SettlementStore {
  /** Atomically takes `key`; false if it is already held. Kept until `prune` passes retainUntilHeight. */
  claim(key: string, retainUntilHeight: number): Promise<boolean>;
  /** Gives a claim back before anything was broadcast (verification failed after the claim). */
  release(key: string): Promise<void>;
  isClaimed(key: string): Promise<boolean>;
  /** Drops every claim whose retainUntilHeight is below currentHeight; returns how many. */
  prune(currentHeight: number): Promise<number>;
}

export function checkRetainUntil(retainUntilHeight: number): void {
  if (retainUntilHeight !== RETAIN_FOREVER && !Number.isSafeInteger(retainUntilHeight)) {
    throw new Error(`retainUntilHeight must be an integer height or RETAIN_FOREVER: ${retainUntilHeight}`);
  }
}

/** Process-local store: a single facilitator process, or tests. */
export class InMemorySettlementStore implements SettlementStore {
  private readonly claims = new Map<string, number>();

  async claim(key: string, retainUntilHeight: number): Promise<boolean> {
    checkRetainUntil(retainUntilHeight);
    if (this.claims.has(key)) return false;
    this.claims.set(key, retainUntilHeight);
    return true;
  }

  async release(key: string): Promise<void> {
    this.claims.delete(key);
  }

  async isClaimed(key: string): Promise<boolean> {
    return this.claims.has(key);
  }

  async prune(currentHeight: number): Promise<number> {
    let n = 0;
    for (const [key, until] of this.claims) {
      if (until < currentHeight) {
        this.claims.delete(key);
        n++;
      }
    }
    return n;
  }
}
