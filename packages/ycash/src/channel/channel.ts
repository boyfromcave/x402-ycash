// A channel's fixed parameters, and its identifiers (specs/scheme_batch_settlement_ycash.md,
// "Channel id", "Settlement").
import type { OutPoint } from "../tx/tx.js";
import { parseChannelScript, type ChannelScript } from "./script.js";

/** Everything a voucher, close or refund of one channel needs, fixed at open. */
export interface Channel extends ChannelScript {
  /** The funding outpoint (txid in display order). */
  outpoint: OutPoint;
  /** The redeem script. */
  redeemScript: Uint8Array;
  /** V, the channel output's value, zatoshis. */
  value: bigint;
  /** The fee every voucher reserves inside V, zatoshis (`extra.closeFee`). */
  closeFee: bigint;
  /** The server's output script (`payTo`). */
  payToScript: Uint8Array;
}

/**
 * Builds a Channel, taking C, S and t from the redeem script so they cannot disagree with it.
 *
 * @param fields - The channel's fields other than the ones parsed from the script.
 * @returns The complete channel.
 * @throws Error when `redeemScript` is not exactly the channel script.
 */
export function channelFromScript(fields: Omit<Channel, keyof ChannelScript>): Channel {
  const parsed = parseChannelScript(fields.redeemScript);
  if (!parsed) throw new Error("not the channel redeem script");
  return { ...parsed, ...fields };
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
