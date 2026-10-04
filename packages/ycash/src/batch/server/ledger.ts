// The server's channel ledger, kept in the shared ChannelStore with nothing but its atomic
// operations (open = create-if-absent, compareAndSetCumulative), so a FileChannelStore or a database
// store works across processes. One channel is several records:
//
//   <id>            cumulative = the stored (highest) voucher's cumulative; data = the channel terms
//   <id>@<cum>      the stored voucher's hex (data.tx); the previous one is deleted on each advance
//   <id>#charged    cumulative = the charged total
//   <id>#inflight   cumulative = 0 when free, else the lock's expiry (ms): one voucher in flight
//   <id>#state      cumulative = 0 open, 1 closing, 2 closed
//   <id>#close      data.txid = the close transaction
//
// A closed channel's records are retired for `closedRetentionMs` and then pruned by the store
// (plan X-F51), so list() and resume() stay as fast as the open channels; an open or closing
// channel is never retired.
import { DEFAULT_CLOSED_RETENTION_MS, type ChannelStore } from "../../store/channelStore.js";

export const CHANNEL_OPEN = 0n;
export const CHANNEL_CLOSING = 1n;
export const CHANNEL_CLOSED = 2n;

/** The channel's fixed terms, JSON-serialisable (bigints as decimal strings). */
export interface ChannelTerms {
  channelId: string;
  network: string;
  asset: string;
  fundingTxid: string;
  vout: number;
  fundingTx: string;
  redeemScript: string;
  /** V, zatoshis */
  value: string;
  closeFee: string;
  /** D, in the asset's unit */
  deposit: string;
  payTo: string;
  refundHeight: number;
  closeMarginBlocks: number;
  /** the funding policy depth, as `confirmationPolicy.confirmations` */
  confirmations: number;
  /** the per-request ceiling at open, for the exhaustion trigger */
  amount: string;
  /** the client's output script in every voucher (hex), from the open's `returnAddress` */
  returnScript?: string;
}

export interface LedgerChannel {
  terms: ChannelTerms;
  /** the stored voucher's cumulative (0 before the first) */
  signedCumulative: bigint;
  chargedCumulative: bigint;
  state: bigint;
  /** the stored voucher, hex */
  voucherTx: string | undefined;
  closeTxid: string | undefined;
}

export type StoreVoucherResult = "stored" | "stale";

/**
 * The server's per-channel records (terms, stored voucher, charged total, in-flight lock, state),
 * built only on the ChannelStore's atomic create-if-absent and compare-and-set so several server
 * processes can share one store.
 */
export class ChannelLedger {
  /**
   * Wraps a store.
   *
   * @param store - The shared channel store.
   * @param inflightTtlMs - How long an in-flight lock lasts before another voucher may take it over.
   * @param closedRetentionMs - How long a closed channel's records are kept before pruning.
   */
  constructor(
    readonly store: ChannelStore,
    private readonly inflightTtlMs = 60_000,
    private readonly closedRetentionMs = DEFAULT_CLOSED_RETENTION_MS,
  ) {}

  /**
   * Records a new channel, writing the auxiliary records before the main one so a reader that finds
   * the main record finds them too.
   *
   * @param terms - The channel's fixed terms.
   * @returns False if the channel is already known.
   */
  async open(terms: ChannelTerms): Promise<boolean> {
    const id = terms.channelId;
    // Auxiliary records first: a reader that finds the main record finds them too.
    await this.store.open({ channelId: `${id}#charged`, cumulative: 0n });
    await this.store.open({ channelId: `${id}#inflight`, cumulative: 0n });
    await this.store.open({ channelId: `${id}#state`, cumulative: CHANNEL_OPEN });
    return this.store.open({ channelId: id, cumulative: 0n, data: { ...terms } });
  }

  /**
   * Reads a channel's records into one view.
   *
   * @param channelId - The channel id.
   * @returns The channel, or undefined when it is unknown (or pruned).
   */
  async get(channelId: string): Promise<LedgerChannel | undefined> {
    const main = await this.store.get(channelId);
    if (!main?.data) return undefined;
    const [charged, state, voucher, close] = await Promise.all([
      this.store.get(`${channelId}#charged`),
      this.store.get(`${channelId}#state`),
      main.cumulative > 0n ? this.store.get(`${channelId}@${main.cumulative}`) : undefined,
      this.store.get(`${channelId}#close`),
    ]);
    return {
      terms: main.data as unknown as ChannelTerms, // written by open() above
      signedCumulative: main.cumulative,
      chargedCumulative: charged?.cumulative ?? 0n,
      state: state?.cumulative ?? CHANNEL_OPEN,
      voucherTx: typeof voucher?.data?.tx === "string" ? voucher.data.tx : undefined,
      closeTxid: typeof close?.data?.txid === "string" ? close.data.txid : undefined,
    };
  }

  /**
   * The ids of every channel still open (main records only: ids carry no `#` or `@`).
   *
   * @returns The open channel ids.
   */
  async openChannelIds(): Promise<string[]> {
    const open: string[] = [];
    for (const id of await this.store.list()) {
      if (id.includes("#") || id.includes("@")) continue;
      if ((await this.store.get(`${id}#state`))?.cumulative === CHANNEL_OPEN) open.push(id);
    }
    return open;
  }

  /**
   * Takes the channel's in-flight lock, or takes over one whose holder let it expire. The token is
   * the lock's expiry in ms, bumped by one if it would equal the stale value.
   *
   * @param channelId - The channel id.
   * @param now - The current time, ms.
   * @returns The lock token, or null when another voucher holds it or the channel is unknown.
   */
  async acquire(channelId: string, now = Date.now()): Promise<bigint | null> {
    const key = `${channelId}#inflight`;
    const r = await this.store.get(key);
    if (!r) return null;
    if (r.cumulative !== 0n && r.cumulative > BigInt(now)) return null;
    // A stale lock (its holder crashed) is taken over by the same compare-and-set.
    let token = BigInt(now + this.inflightTtlMs);
    if (token === r.cumulative) token += 1n;
    return (await this.store.compareAndSetCumulative(key, r.cumulative, token)) ? token : null;
  }

  /**
   * Gives the lock back; a no-op when it expired and someone else took it.
   *
   * @param channelId - The channel id.
   * @param token - The token `acquire` returned.
   */
  async release(channelId: string, token: bigint): Promise<void> {
    await this.store.compareAndSetCumulative(`${channelId}#inflight`, token, 0n);
  }

  /**
   * Voucher rule 8: stores the voucher only if its cumulative is at least the stored one's
   * (the same cumulative must be the same voucher). An advance deletes the previous voucher record.
   *
   * @param channelId - The channel id.
   * @param cumulative - The voucher's cumulative, in the asset's base units.
   * @param txHex - The voucher transaction.
   * @returns `stored`, or `stale` when it is below the stored cumulative or differs at the same one.
   * @throws Error when the channel is unknown.
   */
  async storeVoucher(channelId: string, cumulative: bigint, txHex: string): Promise<StoreVoucherResult> {
    for (;;) {
      const main = await this.store.get(channelId);
      if (!main) throw new Error(`unknown channel ${channelId}`);
      const stored = main.cumulative;
      if (cumulative < stored) return "stale";
      const key = `${channelId}@${cumulative}`;
      if (!(await this.store.open({ channelId: key, cumulative, data: { tx: txHex } }))) {
        if ((await this.store.get(key))?.data?.tx !== txHex) return "stale";
      }
      if (cumulative === stored) return "stored";
      if (await this.store.compareAndSetCumulative(channelId, stored, cumulative)) {
        if (stored > 0n) await this.store.delete(`${channelId}@${stored}`);
        return "stored";
      }
    }
  }

  /**
   * Adds a charge to the charged total, retrying the compare-and-set until it lands.
   *
   * @param channelId - The channel id.
   * @param charge - The amount charged, in the asset's base units.
   * @returns The new charged total.
   * @throws Error when the channel is unknown.
   */
  async addCharge(channelId: string, charge: bigint): Promise<bigint> {
    const key = `${channelId}#charged`;
    for (;;) {
      const r = await this.store.get(key);
      if (!r) throw new Error(`unknown channel ${channelId}`);
      if (await this.store.compareAndSetCumulative(key, r.cumulative, r.cumulative + charge)) return r.cumulative + charge;
    }
  }

  /**
   * Moves the channel from open to closing, so exactly one closer wins.
   *
   * @param channelId - The channel id.
   * @returns False if it was not open.
   */
  claimClose(channelId: string): Promise<boolean> {
    return this.store.compareAndSetCumulative(`${channelId}#state`, CHANNEL_OPEN, CHANNEL_CLOSING);
  }

  /**
   * Records the close transaction, marks the channel closed and retires its records for
   * `closedRetentionMs`.
   *
   * @param channelId - The channel id.
   * @param txid - The close txid, if one was broadcast.
   * @param now - The current time, ms.
   */
  async markClosed(channelId: string, txid: string | undefined, now = Date.now()): Promise<void> {
    if (txid) await this.store.open({ channelId: `${channelId}#close`, cumulative: 0n, data: { txid } });
    const state = await this.store.get(`${channelId}#state`);
    if (state && state.cumulative !== CHANNEL_CLOSED) await this.store.compareAndSetCumulative(`${channelId}#state`, state.cumulative, CHANNEL_CLOSED);
    const main = await this.store.get(channelId);
    const ids = [channelId, `${channelId}#charged`, `${channelId}#inflight`, `${channelId}#state`, `${channelId}#close`];
    if (main && main.cumulative > 0n) ids.push(`${channelId}@${main.cumulative}`);
    await this.store.retire(ids, now + this.closedRetentionMs);
  }

  /**
   * Back to open after a close that could not be broadcast (so a later trigger retries).
   *
   * @param channelId - The channel id.
   * @returns False if it was not closing.
   */
  reopen(channelId: string): Promise<boolean> {
    return this.store.compareAndSetCumulative(`${channelId}#state`, CHANNEL_CLOSING, CHANNEL_OPEN);
  }
}
