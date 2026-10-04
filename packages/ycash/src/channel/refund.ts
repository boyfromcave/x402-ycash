// The client's refund: the CLTV branch, from height t (specs/scheme_batch_settlement_ycash.md,
// "Client Refund"). CLTV needs nLockTime ≥ t as a height and a non-final nSequence
// (ycash-dd/src/script/interpreter.cpp:1307-1338; ycash6 :1416). The tx is final, and so relays,
// once nLockTime is below the next block's height (ycash-dd/src/main.cpp:722; ycash6 :779).
import { feeFloor } from "../tx/fee.js";
import { signInput } from "../tx/keys.js";
import { OP, p2shScriptSig } from "../tx/script.js";
import { SIGHASH, sighashV4 } from "../tx/sighash.js";
import { newTx, type Tx, type TxOut } from "../tx/tx.js";
import type { Channel } from "./channel.js";
import { DUST_THRESHOLD, LOCKTIME_THRESHOLD, REFUND_SEQUENCE } from "./constants.js";

export interface BuildRefundParams {
  channel: Channel;
  clientPrivKey: Uint8Array;
  /** Where the refund goes. */
  toScript: Uint8Array;
  branchId: number;
  /** ≥ t and a height; defaults to t. */
  lockTime?: number;
  /** Defaults to the fee floor. */
  fee?: bigint;
  /** Extra outputs before the client's (the YED binding adds its TRANSFER here). */
  extraOutputs?: readonly TxOut[];
}

const MAX_SIG = new Uint8Array(73);

/** `<sigC> OP_0 <redeemScript>`, nSequence 0xFFFFFFFE, nLockTime ≥ t, expiry 0. */
export function buildRefund(p: BuildRefundParams): Tx {
  const lockTime = p.lockTime ?? p.channel.refundHeight;
  if (!Number.isSafeInteger(lockTime) || lockTime < p.channel.refundHeight || lockTime >= LOCKTIME_THRESHOLD) {
    throw new Error(`refund lock time must be a height ≥ t = ${p.channel.refundHeight}: ${lockTime}`);
  }
  const extra = p.extraOutputs ?? [];
  const tx = newTx({
    vin: [{ prevout: p.channel.outpoint, scriptSig: p2shScriptSig([MAX_SIG, OP.OP_0], p.channel.redeemScript), sequence: REFUND_SEQUENCE }],
    vout: [...extra, { value: 0n, scriptPubKey: p.toScript }],
    lockTime,
    expiryHeight: 0,
  });
  const fee = p.fee ?? feeFloor(tx);
  const extraValue = extra.reduce((s, o) => s + o.value, 0n);
  const amount = p.channel.value - extraValue - fee;
  if (amount < DUST_THRESHOLD) throw new Error(`refund output ${amount} is below dust`);
  tx.vout[tx.vout.length - 1]!.value = amount;
  const sh = sighashV4(tx, 0, p.channel.redeemScript, p.channel.value, SIGHASH.ALL, p.branchId);
  tx.vin[0]!.scriptSig = p2shScriptSig([signInput(sh, p.clientPrivKey, SIGHASH.ALL), OP.OP_0], p.channel.redeemScript);
  return tx;
}
