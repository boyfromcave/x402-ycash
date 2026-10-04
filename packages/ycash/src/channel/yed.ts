// The YED channel (specs/scheme_batch_settlement_ycash.md, "YED Channels"; plan §5.8, X3): the YEC
// channel's script and spends, with a Yellowback TRANSFER on every spend, because a YED spend without
// one burns (plan Y-4; ycash-dd/src/yellowback/state.cpp:860-865, same on ycash6).
//
//   funding  a TRANSFER assigning D cents to the P2SH output, whose YEC value is
//            V = 2 × TOKEN_VALUE + closeFee (plan Y-12)
//   voucher  vout 0 payTo TOKEN_VALUE, vout 1 client TOKEN_VALUE, vout 2 the TRANSFER of the split
//   refund   the CLTV branch, a TRANSFER assigning all of D to the client's output
import { TOKEN_VALUE_ZAT } from "../constants.js";
import { equalBytes } from "../tx/bytes.js";
import { p2pkhHash } from "../tx/script.js";
import type { Tx } from "../tx/tx.js";
import { buildYedTransfer, type BuiltYedTransfer, type TokenCoin, type YecCoin } from "../yed/build.js";
import { yedChannelSplit } from "../yed/floor.js";
import type { Assignment } from "../yed/payload.js";
import { transferOpReturnScript } from "../yed/script.js";
import type { VoucherLayout } from "./outputs.js";
import { buildRefund, type BuildRefundParams } from "./refund.js";
import { channelScriptPubKey } from "./script.js";

/** The voucher's fixed vouts: the server's, the client's (always present), the TRANSFER. */
export const YED_SERVER_VOUT = 0;
export const YED_CLIENT_VOUT = 1;
export const YED_TRANSFER_VOUT = 2;

const TOKEN_VALUE = BigInt(TOKEN_VALUE_ZAT);

/** V of a YED channel: the two voucher outputs' YEC plus the close fee. */
export function yedChannelValue(closeFee: bigint): bigint {
  return 2n * TOKEN_VALUE + closeFee;
}

/**
 * The voucher's TRANSFER at `cumulative` out of D: the server's vout gets serverCents and the
 * client's clientCents, omitted when 0 (yedChannelSplit: the dollar floor, X-7). Σ = D, so nothing burns.
 */
export function yedVoucherAssignments(depositCents: bigint, cumulative: bigint): Assignment[] {
  const split = yedChannelSplit(Number(depositCents), Number(cumulative));
  const a: Assignment[] = [{ vout: YED_SERVER_VOUT, cents: split.serverCents }];
  if (split.clientCents > 0) a.push({ vout: YED_CLIENT_VOUT, cents: split.clientCents });
  return a;
}

/**
 * The YED voucher layout of a channel holding D cents. Constant shape: three outputs whatever the
 * split, so the fee is always V − 2 × TOKEN_VALUE = closeFee. Throws when V is not
 * 2 × TOKEN_VALUE + closeFee, the client script is missing, not P2PKH or payTo's, or the cumulative breaks
 * the dollar floor.
 */
export function yedVoucherLayout(depositCents: bigint): VoucherLayout {
  return ({ channel, cumulative, clientScript }) => {
    if (channel.value !== yedChannelValue(channel.closeFee)) {
      throw new RangeError(`a YED channel's value must be 2 × TOKEN_VALUE + closeFee = ${yedChannelValue(channel.closeFee)}, not ${channel.value}`);
    }
    if (!clientScript) throw new Error("a YED voucher always has a client output script");
    // A YED holder is a key hash: there is no P2SH Yellowback address (plan Y-8).
    if (!p2pkhHash(clientScript)) throw new Error("a YED voucher returns the client's YED to a P2PKH script");
    if (equalBytes(clientScript, channel.payToScript)) throw new Error("the client output must not pay payTo");
    return [
      { value: TOKEN_VALUE, scriptPubKey: channel.payToScript },
      { value: TOKEN_VALUE, scriptPubKey: clientScript },
      { value: 0n, scriptPubKey: transferOpReturnScript(yedVoucherAssignments(depositCents, cumulative)) },
    ];
  };
}

export interface BuildYedFundingParams {
  redeemScript: Uint8Array;
  depositCents: bigint;
  closeFee: bigint;
  /** Token inputs (selectTokenCoins over D); their cents beyond D return as YED change. */
  tokens: readonly TokenCoin[];
  yecCoins: readonly YecCoin[];
  yedChangeScript: Uint8Array;
  yecChangeScript: Uint8Array;
  /** 0 = never expires. */
  expiryHeight?: number;
}

/**
 * The unsigned funding TRANSFER: vout 0 the channel's P2SH output carrying V and assigned D, then
 * the YED change, the OP_RETURN and YEC change. The SDK builds it: there is no P2SH `ye…` address
 * and `yed_send` refuses one (plan Y-8).
 */
export function buildYedFundingTx(p: BuildYedFundingParams): BuiltYedTransfer {
  return buildYedTransfer({
    recipients: [{ scriptPubKey: channelScriptPubKey(p.redeemScript), cents: Number(p.depositCents), value: yedChannelValue(p.closeFee) }],
    tokens: p.tokens,
    yecCoins: p.yecCoins,
    yedChangeScript: p.yedChangeScript,
    yecChangeScript: p.yecChangeScript,
    ...(p.expiryHeight !== undefined ? { expiryHeight: p.expiryHeight } : {}),
  });
}

/** The client's refund of a YED channel: the CLTV branch with a TRANSFER assigning all of D to it. */
export function buildYedRefund(p: Omit<BuildRefundParams, "extraOutputs"> & { depositCents: bigint }): Tx {
  // buildRefund puts the extra outputs first, so the client's output is vout 1.
  const opReturn = { value: 0n, scriptPubKey: transferOpReturnScript([{ vout: 1, cents: Number(p.depositCents) }]) };
  return buildRefund({ ...p, extraOutputs: [opReturn] });
}

/** D as the funding transaction assigns it to the channel output, from its decoded TRANSFER. */
export function assignedTo(assignments: readonly Assignment[], vout: number): number | undefined {
  const hits = assignments.filter((a) => a.vout === vout);
  return hits.length === 1 ? hits[0]?.cents : undefined;
}

