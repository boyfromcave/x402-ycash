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
}

export interface ChannelStore {
  get(channelId: string): Promise<ChannelRecord | undefined>;
  /** Records a new channel; false if the id is already known. */
  open(record: ChannelRecord): Promise<boolean>;
  /** Sets `cumulative` to `next` only if it is currently `expected`; false otherwise (or unknown channel). */
  compareAndSetCumulative(channelId: string, expected: bigint, next: bigint): Promise<boolean>;
  delete(channelId: string): Promise<void>;
}

function copy(r: ChannelRecord): ChannelRecord {
  return { channelId: r.channelId, cumulative: r.cumulative, ...(r.data ? { data: structuredClone(r.data) } : {}) };
}

export class InMemoryChannelStore implements ChannelStore {
  private readonly channels = new Map<string, ChannelRecord>();

  async get(channelId: string): Promise<ChannelRecord | undefined> {
    const r = this.channels.get(channelId);
    return r ? copy(r) : undefined;
  }

  async open(record: ChannelRecord): Promise<boolean> {
    if (this.channels.has(record.channelId)) return false;
    this.channels.set(record.channelId, copy(record));
    return true;
  }

  async compareAndSetCumulative(channelId: string, expected: bigint, next: bigint): Promise<boolean> {
    const r = this.channels.get(channelId);
    if (!r || r.cumulative !== expected) return false;
    r.cumulative = next;
    return true;
  }

  async delete(channelId: string): Promise<void> {
    this.channels.delete(channelId);
  }
}

interface ChannelsDoc {
  version: 1;
  /** bigints are stored as decimal strings */
  channels: Record<string, { cumulative: string; data?: Record<string, unknown> }>;
}

/** A channel store in one JSON file, safe across processes on one host (see JsonFile). */
export class FileChannelStore implements ChannelStore {
  private readonly file: JsonFile<ChannelsDoc>;

  constructor(path: string, opts?: JsonFileOptions) {
    this.file = new JsonFile<ChannelsDoc>(path, () => ({ version: 1, channels: {} }), opts);
  }

  async get(channelId: string): Promise<ChannelRecord | undefined> {
    const doc = await this.file.read();
    if (!Object.hasOwn(doc.channels, channelId)) return undefined;
    const r = doc.channels[channelId] as ChannelsDoc["channels"][string];
    return { channelId, cumulative: BigInt(r.cumulative), ...(r.data ? { data: r.data } : {}) };
  }

  open(record: ChannelRecord): Promise<boolean> {
    return this.file.update((doc) => {
      if (Object.hasOwn(doc.channels, record.channelId)) return { result: false, write: false };
      doc.channels[record.channelId] = { cumulative: record.cumulative.toString(), ...(record.data ? { data: record.data } : {}) };
      return { result: true, write: true };
    });
  }

  compareAndSetCumulative(channelId: string, expected: bigint, next: bigint): Promise<boolean> {
    return this.file.update((doc) => {
      const r = Object.hasOwn(doc.channels, channelId) ? doc.channels[channelId] : undefined;
      if (!r || BigInt(r.cumulative) !== expected) return { result: false, write: false };
      r.cumulative = next.toString();
      return { result: true, write: true };
    });
  }

  delete(channelId: string): Promise<void> {
    return this.file.update((doc) => {
      if (!Object.hasOwn(doc.channels, channelId)) return { result: undefined, write: false };
      delete doc.channels[channelId];
      return { result: undefined, write: true };
    });
  }
}
