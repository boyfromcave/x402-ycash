// Channel records in one JSON file, so a channel outlives the process that opened it: the CLI's
// `channel status|close|refund` find what an agent opened. A record holds the channel key C, so the
// file is a wallet file (mode 0600 is the operator's job, as for any key file).
import { JsonFile, type JsonFileOptions } from "../../store/jsonFile.js";
import type { ClientChannelRecord, ClientChannelStorage } from "./channel.js";

interface ClientChannelsDoc {
  version: 1;
  channels: Record<string, ClientChannelRecord>;
}

export class FileClientChannelStorage implements ClientChannelStorage {
  private readonly file: JsonFile<ClientChannelsDoc>;

  constructor(path: string, opts?: JsonFileOptions) {
    this.file = new JsonFile<ClientChannelsDoc>(path, () => ({ version: 1, channels: {} }), opts);
  }

  async get(channelId: string): Promise<ClientChannelRecord | undefined> {
    const doc = await this.file.read();
    return Object.hasOwn(doc.channels, channelId) ? doc.channels[channelId] : undefined;
  }

  async findLive(offerKey: string): Promise<ClientChannelRecord | undefined> {
    const doc = await this.file.read();
    return Object.values(doc.channels).find((r) => r.offerKey === offerKey && (r.status === "opening" || r.status === "open"));
  }

  put(record: ClientChannelRecord): Promise<void> {
    return this.file.update((doc) => {
      doc.channels[record.channelId] = structuredClone(record);
      return { result: undefined, write: true };
    });
  }

  async list(): Promise<ClientChannelRecord[]> {
    return Object.values((await this.file.read()).channels);
  }
}
