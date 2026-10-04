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
  /** where each voucher (and the refund, by default) returns the client's remainder: the return address's script */
  clientScript: string;
  /** the open's `returnAddress` (absent in records written before it existed, whose clientScript is C's) */
  returnAddress?: string;
  /** the funding's nExpiryHeight (0 or absent: never expires) */
  fundingExpiryHeight?: number;
  /** the server's charged total, as last reported */
  charged: string;
  /** the highest cumulative signed */
  signed: string;
  /** the open payload, resent until the server accepts it (funding depth) */
  open?: BatchOpenPayload;
  /** `expired`: the funding expired unrelayed, so the channel never existed */
  status: "opening" | "open" | "retired" | "closed" | "refunded" | "expired";
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

/**
 * Process-local channel store. Records are cloned on the way in and out, so callers never share
 * mutable state with the store; channels (and their keys) are lost when the process exits.
 */
export class InMemoryClientChannelStorage implements ClientChannelStorage {
  private readonly records = new Map<string, ClientChannelRecord>();
  /**
   * Looks up a channel by id.
   *
   * @param channelId - The channel id (`txid:vout` of the funding output).
   * @returns A copy of the record, or undefined.
   */
  async get(channelId: string): Promise<ClientChannelRecord | undefined> {
    const r = this.records.get(channelId);
    return r ? structuredClone(r) : undefined;
  }
  /**
   * Finds the channel in `opening` or `open` state for an offer, so a new request reuses it.
   *
   * @param offerKey - The key from {@link offerKeyOf}.
   * @returns A copy of the live record, or undefined.
   */
  async findLive(offerKey: string): Promise<ClientChannelRecord | undefined> {
    for (const r of this.records.values()) if (r.offerKey === offerKey && (r.status === "opening" || r.status === "open")) return structuredClone(r);
    return undefined;
  }
  /**
   * Inserts or replaces a record by its channel id.
   *
   * @param record - The record to store.
   */
  async put(record: ClientChannelRecord): Promise<void> {
    this.records.set(record.channelId, structuredClone(record));
  }
  /**
   * Lists every stored channel, in any state.
   *
   * @returns Copies of all records.
   */
  async list(): Promise<ClientChannelRecord[]> {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
}

/**
 * The key under which a client keeps one live channel per offer: same network, payTo and server key.
 *
 * @param network - The CAIP-2 network.
 * @param payTo - The server's payTo address.
 * @param serverPubKey - The server key S, lowercase hex.
 * @returns The offer key.
 */
export function offerKeyOf(network: string, payTo: string, serverPubKey: string): string {
  return `${network}|${payTo}|${serverPubKey}`;
}

/**
 * Rebuilds the {@link Channel} of a stored record (outpoint from the id, script, value, close fee
 * and payTo script).
 *
 * @param r - The stored record.
 * @returns The channel.
 */
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
