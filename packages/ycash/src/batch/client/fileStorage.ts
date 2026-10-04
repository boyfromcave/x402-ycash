// Channel records in one JSON file, so a channel outlives the process that opened it: the CLI's
// `channel status|close|refund` find what an agent opened. A record holds the channel key C, so the
// file is a wallet file (mode 0600 is the operator's job, as for any key file).
import { JsonFile, type JsonFileOptions } from "../../store/jsonFile.js";
import type { ClientChannelRecord, ClientChannelStorage } from "./channel.js";

interface ClientChannelsDoc {
  version: 1;
  channels: Record<string, ClientChannelRecord>;
}

/**
 * {@link ClientChannelStorage} backed by one JSON file, for channels that must survive a restart.
 */
export class FileClientChannelStorage implements ClientChannelStorage {
  private readonly file: JsonFile<ClientChannelsDoc>;

  /**
   * Opens (or lazily creates) the store at `path`.
   *
   * @param path - The JSON file.
   * @param opts - File options passed to {@link JsonFile}.
   */
  constructor(path: string, opts?: JsonFileOptions) {
    this.file = new JsonFile<ClientChannelsDoc>(path, () => ({ version: 1, channels: {} }), opts);
  }

  /**
   * Looks up a channel by id.
   *
   * @param channelId - The channel id (`txid:vout` of the funding output).
   * @returns The record, or undefined.
   */
  async get(channelId: string): Promise<ClientChannelRecord | undefined> {
    const doc = await this.file.read();
    return Object.hasOwn(doc.channels, channelId) ? doc.channels[channelId] : undefined;
  }

  /**
   * Finds the channel in `opening` or `open` state for an offer.
   *
   * @param offerKey - The offer key.
   * @returns The live record, or undefined.
   */
  async findLive(offerKey: string): Promise<ClientChannelRecord | undefined> {
    const doc = await this.file.read();
    return Object.values(doc.channels).find((r) => r.offerKey === offerKey && (r.status === "opening" || r.status === "open"));
  }

  /**
   * Inserts or replaces a record by its channel id, rewriting the file.
   *
   * @param record - The record to store.
   * @returns A promise that settles once the file is written.
   */
  put(record: ClientChannelRecord): Promise<void> {
    return this.file.update((doc) => {
      doc.channels[record.channelId] = structuredClone(record);
      return { result: undefined, write: true };
    });
  }

  /**
   * Lists every stored channel, in any state.
   *
   * @returns All records.
   */
  async list(): Promise<ClientChannelRecord[]> {
    return Object.values((await this.file.read()).channels);
  }
}
