// The fee rule (plan S-6, §5.4): fee = max(1000, 500 × max(2, logical actions)). It meets v4.5.0's
// DEFAULT_FEE of 1000 zat (ycash-dd/src/policy/fees.h:15) and 6.21.0's ZIP-317 conventional fee, below
// which ZIP-401 adds an eviction penalty (ycash6/src/zip317.h:16-19, src/mempool_limit.h:24-25).
import { ByteWriter } from "./bytes.js";
import { writeTxIn, writeTxOut, type Tx } from "./tx.js";

export const MARGINAL_FEE = 500n;
export const GRACE_ACTIONS = 2;
/** DEFAULT_FEE on v4.5.0. */
export const MIN_FEE = 1000n;
const P2PKH_STANDARD_INPUT_SIZE = 150;
const P2PKH_STANDARD_OUTPUT_SIZE = 34;

const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

/**
 * ZIP-317 logical actions, as ycash6/src/zip317.cpp:24-38 computes them: the larger of the
 * transparent input and output sizes in standard-P2PKH units (vector bytes without the count),
 * plus 2 per JoinSplit, plus max(Sapling spends, outputs).
 *
 * @param tx - The transaction to measure.
 * @returns The number of logical actions.
 */
export function logicalActions(tx: Tx): number {
  const win = new ByteWriter();
  for (const i of tx.vin) writeTxIn(win, i);
  const wout = new ByteWriter();
  for (const o of tx.vout) writeTxOut(wout, o);
  return (
    Math.max(ceilDiv(win.finish().length, P2PKH_STANDARD_INPUT_SIZE), ceilDiv(wout.finish().length, P2PKH_STANDARD_OUTPUT_SIZE)) +
    2 * tx.joinSplits.length +
    Math.max(tx.shieldedSpends.length, tx.shieldedOutputs.length)
  );
}

/**
 * The minimum fee, in zatoshi, the SDK pays and a facilitator requires:
 * max(1000, 500 × max(2, logical actions)).
 *
 * @param tx - The transaction to price.
 * @returns The fee floor in zatoshi.
 */
export function feeFloor(tx: Tx): bigint {
  const conventional = MARGINAL_FEE * BigInt(Math.max(GRACE_ACTIONS, logicalActions(tx)));
  return conventional > MIN_FEE ? conventional : MIN_FEE;
}

/**
 * The fee a tx pays: transparent inputs − outputs, plus the Sapling value balance and the
 * JoinSplits' net vpub_new − vpub_old.
 *
 * @param tx - The transaction.
 * @param inputValues - The value in zatoshi of the coin each `vin[i]` spends, in input order.
 * @returns The fee in zatoshi; negative if outputs exceed inputs.
 * @throws Error when there is not exactly one input value per input.
 */
export function txFee(tx: Tx, inputValues: readonly bigint[]): bigint {
  if (inputValues.length !== tx.vin.length) throw new Error("one input value per vin is required");
  let fee = tx.valueBalance;
  for (const v of inputValues) fee += v;
  for (const o of tx.vout) fee -= o.value;
  for (const js of tx.joinSplits) {
    const dv = new DataView(js.buffer, js.byteOffset, 16);
    fee += dv.getBigInt64(8, true) - dv.getBigInt64(0, true); // vpub_new − vpub_old
  }
  return fee;
}
