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
import type { ChannelStore } from "../../store/channelStore.js";

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

export class ChannelLedger {
  constructor(
    readonly store: ChannelStore,
    private readonly inflightTtlMs = 60_000,
  ) {}

  /** Records a new channel; false if it is already known. */
  async open(terms: ChannelTerms): Promise<boolean> {
    const id = terms.channelId;
    // Auxiliary records first: a reader that finds the main record finds them too.
    await this.store.open({ channelId: `${id}#charged`, cumulative: 0n });
    await this.store.open({ channelId: `${id}#inflight`, cumulative: 0n });
    await this.store.open({ channelId: `${id}#state`, cumulative: CHANNEL_OPEN });
    return this.store.open({ channelId: id, cumulative: 0n, data: { ...terms } });
  }

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

  /** The ids of every channel still open (main records only: ids carry no `#` or `@`). */
  async openChannelIds(): Promise<string[]> {
    const open: string[] = [];
    for (const id of await this.store.list()) {
      if (id.includes("#") || id.includes("@")) continue;
      if ((await this.store.get(`${id}#state`))?.cumulative === CHANNEL_OPEN) open.push(id);
    }
    return open;
  }

  /** Takes the channel's in-flight lock; returns its token, or null when another voucher holds it. */
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

  /** Gives the lock back; a no-op when it expired and someone else took it. */
  async release(channelId: string, token: bigint): Promise<void> {
    await this.store.compareAndSetCumulative(`${channelId}#inflight`, token, 0n);
  }

  /**
   * Voucher rule 8: stores the voucher only if its cumulative is at least the stored one's
   * (the same cumulative must be the same voucher).
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

  /** Adds a charge to the charged total; returns the new total. */
  async addCharge(channelId: string, charge: bigint): Promise<bigint> {
    const key = `${channelId}#charged`;
    for (;;) {
      const r = await this.store.get(key);
      if (!r) throw new Error(`unknown channel ${channelId}`);
      if (await this.store.compareAndSetCumulative(key, r.cumulative, r.cumulative + charge)) return r.cumulative + charge;
    }
  }

  /** Moves the channel from open to closing; false if it was not open (one closer wins). */
  claimClose(channelId: string): Promise<boolean> {
    return this.store.compareAndSetCumulative(`${channelId}#state`, CHANNEL_OPEN, CHANNEL_CLOSING);
  }

  /** Records the close transaction and marks the channel closed. */
  async markClosed(channelId: string, txid: string | undefined): Promise<void> {
    if (txid) await this.store.open({ channelId: `${channelId}#close`, cumulative: 0n, data: { txid } });
    const state = await this.store.get(`${channelId}#state`);
    if (state && state.cumulative !== CHANNEL_CLOSED) await this.store.compareAndSetCumulative(`${channelId}#state`, state.cumulative, CHANNEL_CLOSED);
  }

  /** Back to open after a close that could not be broadcast (so a later trigger retries). */
  reopen(channelId: string): Promise<boolean> {
    return this.store.compareAndSetCumulative(`${channelId}#state`, CHANNEL_CLOSING, CHANNEL_OPEN);
  }
}
