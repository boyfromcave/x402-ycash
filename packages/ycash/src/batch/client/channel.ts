// The client's channel records. A record holds the channel key C, so a durable storage must be
// treated like a wallet file.
import { channelFromScript, type Channel } from "../../channel/channel.js";
import type { YcashNetwork } from "../../constants.js";
import { addressToScript } from "../../tx/address.js";
import { hexToBytes } from "../../tx/bytes.js";
import type { BatchOpenPayload } from "../types.js";

export interface ClientChannelRecord {
  channelId: string;
  /** network|payTo|serverPubKey: one live channel per offer */
  offerKey: string;
  network: YcashNetwork;
  asset: string;
  payTo: string;
  serverPubKey: string;
  redeemScript: string;
  fundingTx: string;
  vout: number;
  /** V, zatoshis */
  value: string;
  closeFee: string;
  /** D */
  deposit: string;
  refundHeight: number;
  closeMarginBlocks: number;
  /** C's private key, hex */
  clientPrivKey: string;
  /** where each voucher returns the client's remainder */
  clientScript: string;
  /** the server's charged total, as last reported */
  charged: string;
  /** the highest cumulative signed */
  signed: string;
  /** the open payload, resent until the server accepts it (funding depth) */
  open?: BatchOpenPayload;
  status: "opening" | "open" | "retired" | "closed" | "refunded";
  closeTxid?: string;
  refundTxid?: string;
}

export interface ClientChannelStorage {
  get(channelId: string): Promise<ClientChannelRecord | undefined>;
  /** The live (opening or open) channel for an offer. */
  findLive(offerKey: string): Promise<ClientChannelRecord | undefined>;
  put(record: ClientChannelRecord): Promise<void>;
  list(): Promise<ClientChannelRecord[]>;
}

export class InMemoryClientChannelStorage implements ClientChannelStorage {
  private readonly records = new Map<string, ClientChannelRecord>();
  async get(channelId: string): Promise<ClientChannelRecord | undefined> {
    const r = this.records.get(channelId);
    return r ? structuredClone(r) : undefined;
  }
  async findLive(offerKey: string): Promise<ClientChannelRecord | undefined> {
    for (const r of this.records.values()) if (r.offerKey === offerKey && (r.status === "opening" || r.status === "open")) return structuredClone(r);
    return undefined;
  }
  async put(record: ClientChannelRecord): Promise<void> {
    this.records.set(record.channelId, structuredClone(record));
  }
  async list(): Promise<ClientChannelRecord[]> {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
}

export function offerKeyOf(network: string, payTo: string, serverPubKey: string): string {
  return `${network}|${payTo}|${serverPubKey}`;
}

export function channelOfRecord(r: ClientChannelRecord): Channel {
  const [txid, vout] = r.channelId.split(":") as [string, string];
  return channelFromScript({
    outpoint: { txid, vout: Number(vout) },
    redeemScript: hexToBytes(r.redeemScript),
    value: BigInt(r.value),
    closeFee: BigInt(r.closeFee),
    payToScript: addressToScript(r.payTo, r.network),
  });
}
