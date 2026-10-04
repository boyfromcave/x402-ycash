import { JsonFile, type JsonFileOptions } from "./jsonFile.js";

/**
 * A payment channel's facilitator-side state for X2/X3 (plan §5.7): the highest cumulative amount
 * the payee holds a signature for. `cumulative` only moves through compare-and-set, so two workers
 * redeeming vouchers on one channel cannot both advance it from the same value.
 */
export interface ChannelRecord {
  channelId: string;
  /** zatoshis (YEC) or cents (YED), cumulative over the channel's life */
  cumulative: bigint;
  /** opaque binding-specific fields (funding outpoint, keys, refund height, …), JSON-serialisable */
  data?: Record<string, unknown>;
  /**
   * Set by `retire` once the channel is closed: from this time (ms since the epoch) the record is
   * gone (plan X-F51). Absent: kept forever. A binding retires only closed channels.
   */
  retainUntilMs?: number;
}

/** How long a closed channel's records are kept by default: 30 days, for audit and late queries. */
export const DEFAULT_CLOSED_RETENTION_MS = 30 * 24 * 3600 * 1000;

export interface ChannelStore {
  get(channelId: string): Promise<ChannelRecord | undefined>;
  /** Records a new channel; false if the id is already known. */
  open(record: ChannelRecord): Promise<boolean>;
  /** Sets `cumulative` to `next` only if it is currently `expected`; false otherwise (or unknown channel). */
  compareAndSetCumulative(channelId: string, expected: bigint, next: bigint): Promise<boolean>;
  delete(channelId: string): Promise<void>;
  /**
   * Every live record id, in no particular order (a restarted server re-tracks its channels from
   * it). Records past their retention are pruned first, so the list stays as short as the open
   * channels plus the retention window.
   */
  list(): Promise<string[]>;
  /** Marks records for pruning from `untilMs` on (a closed channel's). Unknown ids are ignored. */
  retire(channelIds: readonly string[], untilMs: number): Promise<void>;
  /** Deletes every record past its retention; returns how many. */
  prune(now?: number): Promise<number>;
}

/**
 * Deep-copies a record so callers of the in-memory store never share its mutable state.
 *
 * @param r - The record.
 * @returns An independent copy.
 */
function copy(r: ChannelRecord): ChannelRecord {
  return {
    channelId: r.channelId,
    cumulative: r.cumulative,
    ...(r.data ? { data: structuredClone(r.data) } : {}),
    ...(r.retainUntilMs !== undefined ? { retainUntilMs: r.retainUntilMs } : {}),
  };
}

/**
 * A record is gone once its retention is over: reads treat it as pruned even before prune runs.
 *
 * @param r - The record, or its stored form.
 * @param r.retainUntilMs - When its retention ends, ms since the epoch; absent means never.
 * @param now - The current time, ms since the epoch.
 * @returns Whether the record is past its retention.
 */
const expired = (r: { retainUntilMs?: number }, now: number): boolean => r.retainUntilMs !== undefined && now >= r.retainUntilMs;

/** Process-local channel store: a single server process, or tests. Records are copied in and out. */
export class InMemoryChannelStore implements ChannelStore {
  private readonly channels = new Map<string, ChannelRecord>();

  /**
   * Reads a live record.
   *
   * @param channelId - The channel id.
   * @returns A copy of the record, or undefined when unknown or past its retention.
   */
  async get(channelId: string): Promise<ChannelRecord | undefined> {
    const r = this.live(channelId);
    return r ? copy(r) : undefined;
  }

  /**
   * Records a new channel unless a live record has its id.
   *
   * @param record - The channel's initial record.
   * @returns False when the id is already live.
   */
  async open(record: ChannelRecord): Promise<boolean> {
    if (this.live(record.channelId)) return false;
    this.channels.set(record.channelId, copy(record));
    return true;
  }

  /**
   * Advances `cumulative` from `expected` to `next` atomically.
   *
   * @param channelId - The channel id.
   * @param expected - The value the caller read.
   * @param next - The new value.
   * @returns False when the channel is unknown or `cumulative` is no longer `expected`.
   */
  async compareAndSetCumulative(channelId: string, expected: bigint, next: bigint): Promise<boolean> {
    const r = this.live(channelId);
    if (!r || r.cumulative !== expected) return false;
    r.cumulative = next;
    return true;
  }

  /**
   * Removes a record at once, whatever its retention.
   *
   * @param channelId - The channel id.
   */
  async delete(channelId: string): Promise<void> {
    this.channels.delete(channelId);
  }

  /**
   * Prunes expired records, then lists the rest.
   *
   * @returns The live channel ids.
   */
  async list(): Promise<string[]> {
    await this.prune();
    return [...this.channels.keys()];
  }

  /**
   * Sets the retention end of each known record.
   *
   * @param channelIds - The closed channels' ids; unknown ones are ignored.
   * @param untilMs - When the records go, ms since the epoch.
   */
  async retire(channelIds: readonly string[], untilMs: number): Promise<void> {
    for (const id of channelIds) {
      const r = this.channels.get(id);
      if (r) r.retainUntilMs = untilMs;
    }
  }

  /**
   * Deletes every record past its retention.
   *
   * @param now - The current time, ms since the epoch.
   * @returns How many records were deleted.
   */
  async prune(now = Date.now()): Promise<number> {
    let n = 0;
    for (const [id, r] of this.channels) {
      if (expired(r, now)) {
        this.channels.delete(id);
        n++;
      }
    }
    return n;
  }

  /**
   * Looks up a record without copying it.
   *
   * @param channelId - The channel id.
   * @returns The stored record, or undefined when unknown or past its retention.
   */
  private live(channelId: string): ChannelRecord | undefined {
    const r = this.channels.get(channelId);
    return r && !expired(r, Date.now()) ? r : undefined;
  }
}

interface ChannelsDoc {
  version: 1;
  /** bigints are stored as decimal strings */
  channels: Record<string, { cumulative: string; data?: Record<string, unknown>; retainUntilMs?: number }>;
}

type FileRecord = ChannelsDoc["channels"][string];

/**
 * The live record of `channelId` in `doc`, or undefined (absent or past its retention).
 *
 * @param doc - The channels document.
 * @param channelId - The channel id.
 * @param now - The current time, ms since the epoch.
 * @returns The stored record, or undefined.
 */
function liveIn(doc: ChannelsDoc, channelId: string, now = Date.now()): FileRecord | undefined {
  const r = Object.hasOwn(doc.channels, channelId) ? doc.channels[channelId] : undefined;
  return r && !expired(r, now) ? r : undefined;
}

/** A channel store in one JSON file, safe across processes on one host (see JsonFile). */
export class FileChannelStore implements ChannelStore {
  private readonly file: JsonFile<ChannelsDoc>;

  /**
   * Opens (lazily) the store at `path`; the file is created on the first write.
   *
   * @param path - The JSON document's path.
   * @param opts - Lock timing.
   */
  constructor(path: string, opts?: JsonFileOptions) {
    this.file = new JsonFile<ChannelsDoc>(path, () => ({ version: 1, channels: {} }), opts);
  }

  /**
   * Reads a live record, without taking the lock.
   *
   * @param channelId - The channel id.
   * @returns The record, or undefined when unknown or past its retention.
   */
  async get(channelId: string): Promise<ChannelRecord | undefined> {
    const r = liveIn(await this.file.read(), channelId);
    if (!r) return undefined;
    return { channelId, cumulative: BigInt(r.cumulative), ...(r.data ? { data: r.data } : {}), ...(r.retainUntilMs !== undefined ? { retainUntilMs: r.retainUntilMs } : {}) };
  }

  /**
   * Records a new channel under the lock unless a live record has its id.
   *
   * @param record - The channel's initial record (its `retainUntilMs` is not stored).
   * @returns False when the id is already live.
   */
  open(record: ChannelRecord): Promise<boolean> {
    return this.file.update((doc) => {
      if (liveIn(doc, record.channelId)) return { result: false, write: false };
      doc.channels[record.channelId] = { cumulative: record.cumulative.toString(), ...(record.data ? { data: record.data } : {}) };
      return { result: true, write: true };
    });
  }

  /**
   * Advances `cumulative` from `expected` to `next` under the lock, so concurrent processes serialize.
   *
   * @param channelId - The channel id.
   * @param expected - The value the caller read.
   * @param next - The new value.
   * @returns False when the channel is unknown or `cumulative` is no longer `expected`.
   */
  compareAndSetCumulative(channelId: string, expected: bigint, next: bigint): Promise<boolean> {
    return this.file.update((doc) => {
      const r = liveIn(doc, channelId);
      if (!r || BigInt(r.cumulative) !== expected) return { result: false, write: false };
      r.cumulative = next.toString();
      return { result: true, write: true };
    });
  }

  /**
   * Removes a record at once, whatever its retention.
   *
   * @param channelId - The channel id.
   * @returns Resolves once the document is written.
   */
  delete(channelId: string): Promise<void> {
    return this.file.update((doc) => {
      if (!Object.hasOwn(doc.channels, channelId)) return { result: undefined, write: false };
      delete doc.channels[channelId];
      return { result: undefined, write: true };
    });
  }

  /**
   * Lists the live ids, pruning first only when a record is due.
   *
   * @returns The live channel ids.
   */
  async list(): Promise<string[]> {
    const now = Date.now();
    const doc = await this.file.read();
    // Prune under the lock only when something is due, so a plain list stays a lock-free read.
    if (Object.values(doc.channels).some((r) => expired(r, now))) await this.prune(now);
    return Object.keys(doc.channels).filter((id) => !expired(doc.channels[id] as FileRecord, now));
  }

  /**
   * Sets the retention end of each known record under the lock.
   *
   * @param channelIds - The closed channels' ids; unknown ones are ignored.
   * @param untilMs - When the records go, ms since the epoch.
   * @returns Resolves once the document is written.
   */
  retire(channelIds: readonly string[], untilMs: number): Promise<void> {
    return this.file.update((doc) => {
      const present = channelIds.filter((id) => Object.hasOwn(doc.channels, id));
      for (const id of present) (doc.channels[id] as FileRecord).retainUntilMs = untilMs;
      return { result: undefined, write: present.length > 0 };
    });
  }

  /**
   * Deletes every record past its retention, under the lock.
   *
   * @param now - The current time, ms since the epoch.
   * @returns How many records were deleted.
   */
  prune(now = Date.now()): Promise<number> {
    return this.file.update((doc) => {
      const due = Object.keys(doc.channels).filter((id) => expired(doc.channels[id] as FileRecord, now));
      for (const id of due) delete doc.channels[id];
      return { result: due.length, write: due.length > 0 };
    });
  }
}
