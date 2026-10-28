// The client's refund: the CLTV branch, from height t (specs/scheme_batch_settlement_ycash.md,
// "Client Refund"). CLTV needs nLockTime ≥ t as a height and a non-final nSequence
// (ycash-dd/src/script/interpreter.cpp:1307-1338; ycash6 :1416). The tx is final, and so relays,
// once nLockTime is below the next block's height (ycash-dd/src/main.cpp:722; ycash6 :779).
import { pqSpendItems } from "../pq/script.js";
import { pubKeySize, sigSize } from "../pq/scheme.js";
import type { PQKeyPair } from "../pq/sign.js";
import { feeFloor } from "../tx/fee.js";
import { signInput } from "../tx/keys.js";
import { OP, buildScript, p2shScriptSig } from "../tx/script.js";
import { SIGHASH, sighashV4 } from "../tx/sighash.js";
import { newTx, type Tx, type TxOut } from "../tx/tx.js";
import type { Channel } from "./channel.js";
import { DUST_THRESHOLD, LOCKTIME_THRESHOLD, REFUND_SEQUENCE } from "./constants.js";
import { pqClientKey, pqSignAll } from "./voucher.js";

export interface BuildRefundParams {
  channel: Channel;
  /** C's secp256k1 private key (P2SH channel). */
  clientPrivKey?: Uint8Array;
  /** The client's post-quantum key pair (TX_PQCHANNEL). */
  clientPQKey?: PQKeyPair;
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

/**
 * The TX_PQCHANNEL refund scriptSig: `<sig_1>…<sig_s> <s> <pk_1>…<pk_p> <p> OP_0` (s + p + 3 pushes; D-Q-19).
 *
 * @param pk - The client's public key.
 * @param sigC - The client's signature ‖ hash type.
 * @returns The scriptSig.
 */
export function pqRefundScriptSig(pk: Uint8Array, sigC: Uint8Array): Uint8Array {
  return buildScript([...pqSpendItems(pk, sigC), OP.OP_0]);
}

/**
 * Builds and signs the client's refund through the CLTV branch: scriptSig
 * `<sigC> OP_0 <redeemScript>` (P2SH) or the chunked `<sigC…> <s> <pk…> <p> OP_0` (TX_PQCHANNEL), nSequence 0xFFFFFFFE, nLockTime ≥ t, expiry 0. The client's
 * output, last, gets V less the extra outputs and the fee.
 *
 * @param p - Channel, client key, destination script, branch id and optional lock time, fee and extra outputs.
 * @returns The signed refund transaction.
 * @throws Error when the lock time is not a height ≥ t, or the refund output would be below dust.
 */
export function buildRefund(p: BuildRefundParams): Tx {
  const lockTime = p.lockTime ?? p.channel.refundHeight;
  if (!Number.isSafeInteger(lockTime) || lockTime < p.channel.refundHeight || lockTime >= LOCKTIME_THRESHOLD) {
    throw new Error(`refund lock time must be a height ≥ t = ${p.channel.refundHeight}: ${lockTime}`);
  }
  const extra = p.extraOutputs ?? [];
  const ch = p.channel;
  const placeholder = ch.template === "pq"
    ? pqRefundScriptSig(new Uint8Array(pubKeySize(ch.client.scheme)), new Uint8Array(sigSize(ch.client.scheme) + 1))
    : p2shScriptSig([MAX_SIG, OP.OP_0], ch.redeemScript);
  const tx = newTx({
    vin: [{ prevout: p.channel.outpoint, scriptSig: placeholder, sequence: REFUND_SEQUENCE }],
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
  if (ch.template === "pq") {
    const key = pqClientKey(ch, p.clientPQKey);
    tx.vin[0]!.scriptSig = pqRefundScriptSig(key.publicKey, pqSignAll(sh, key));
    return tx;
  }
  if (!p.clientPrivKey) throw new Error("a P2SH channel needs the client's private key");
  tx.vin[0]!.scriptSig = p2shScriptSig([signInput(sh, p.clientPrivKey, SIGHASH.ALL), OP.OP_0], p.channel.redeemScript);
  return tx;
}
