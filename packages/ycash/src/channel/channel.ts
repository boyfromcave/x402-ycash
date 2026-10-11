// A channel's fixed parameters, and its identifiers (specs/scheme_batch_settlement_ycash.md,
// "Channel id", "Settlement").
import type { PQKeyId } from "../pq/scheme.js";
import type { OutPoint } from "../tx/tx.js";
import { parsePQChannelScript } from "./pqScript.js";
import { parseChannelScript, type ChannelScript } from "./script.js";

/** The fields every channel has, whatever its script template. */
export interface ChannelFields {
  /** The funding outpoint (txid in display order). */
  outpoint: OutPoint;
  /**
   * The channel script: the P2SH redeem script, or the bare TX_PQCHANNEL script (also the funding
   * output's scriptPubKey). The wire's `redeemScript` field carries it for both.
   */
  redeemScript: Uint8Array;
  /** V, the channel output's value, zatoshis. */
  value: bigint;
  /** The fee every voucher reserves inside V, zatoshis (`extra.closeFee`). */
  closeFee: bigint;
  /** The server's output script (`payTo`). */
  payToScript: Uint8Array;
}

/**
 * The P2SH 2-of-2 secp256k1 channel. For YED it is deprecated on the quantum line: it stays valid
 * only before the node's Falcon height, after which TOK-PQ refuses a P2SH YED holder (D-Q-19).
 */
export interface P2shChannel extends ChannelFields, ChannelScript {
  template: "p2sh";
}

/** The hybrid TX_PQCHANNEL: client post-quantum key + server secp256k1 key, CLTV refund to the client's PQ key (D-Q-19). */
export interface PQChannel extends ChannelFields {
  template: "pq";
  client: PQKeyId;
  serverPubKey: Uint8Array;
  refundHeight: number;
}

/** Everything a voucher, close or refund of one channel needs, fixed at open. */
export type Channel = P2shChannel | PQChannel;

/**
 * Builds a Channel, taking the keys and t from the channel script so they cannot disagree with it:
 * a TX_PQCHANNEL gives a {@link PQChannel}, the P2SH redeem script a {@link P2shChannel}.
 *
 * @param fields - The channel's fields other than the ones parsed from the script.
 * @returns The complete channel.
 * @throws Error when `redeemScript` is neither channel script.
 */
export function channelFromScript(fields: ChannelFields): Channel {
  const pq = parsePQChannelScript(fields.redeemScript);
  if (pq) return { ...fields, template: "pq", client: pq.client, serverPubKey: pq.serverPubKey, refundHeight: pq.refundHeight };
  const parsed = parseChannelScript(fields.redeemScript);
  if (!parsed) throw new Error("not the channel redeem script");
  return { ...parsed, ...fields, template: "p2sh" };
}

/**
 * The server key and refund height of either channel script.
 *
 * @param rs - The channel script.
 * @returns S and t, or null when `rs` is neither channel script.
 */
export function channelTermsOf(rs: Uint8Array): { serverPubKey: Uint8Array; refundHeight: number; template: Channel["template"] } | null {
  const pq = parsePQChannelScript(rs);
  if (pq) return { serverPubKey: pq.serverPubKey, refundHeight: pq.refundHeight, template: "pq" };
  const p = parseChannelScript(rs);
  return p ? { serverPubKey: p.serverPubKey, refundHeight: p.refundHeight, template: "p2sh" } : null;
}

/**
 * D for a YEC channel: V − closeFee, the most a voucher can pay the server.
 *
 * @param ch - The channel's value and close fee, zatoshis.
 * @returns The deposit, zatoshis.
 */
export function yecDeposit(ch: Pick<Channel, "value" | "closeFee">): bigint {
  return ch.value - ch.closeFee;
}

/**
 * The channel id, `"<funding txid>:<vout>"` with the txid in display order.
 *
 * @param p - The funding outpoint.
 * @returns The channel id.
 */
export function channelIdOf(p: OutPoint): string {
  return `${p.txid}:${p.vout}`;
}

/**
 * Parses a channel id strictly: lowercase 64-hex txid, decimal vout within uint32.
 *
 * @param id - A channel id as produced by {@link channelIdOf}.
 * @returns The funding outpoint, or null when `id` is malformed.
 */
export function parseChannelId(id: string): OutPoint | null {
  const m = /^([0-9a-f]{64}):(\d{1,10})$/.exec(id);
  if (!m) return null;
  const vout = Number(m[2]);
  return vout <= 0xffffffff ? { txid: m[1] as string, vout } : null;
}

/**
 * The commitment id of a stored voucher: `"<channelId>@<cumulative>"`.
 *
 * @param channelId - The channel id.
 * @param cumulative - The voucher's cumulative, in the asset's unit.
 * @returns The commitment id.
 */
export function commitmentIdOf(channelId: string, cumulative: bigint): string {
  return `${channelId}@${cumulative}`;
}
