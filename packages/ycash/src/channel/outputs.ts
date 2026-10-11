// Voucher outputs (specs/scheme_batch_settlement_ycash.md, "Voucher outputs") and the close-fee
// floor. The layout is a function so the YED binding (plan X3) supplies its own — constant shape,
// TOKEN_VALUE outputs, a TRANSFER at vout 2, the split of yed.yedChannelSplit — and reuses the
// voucher builder, verifier, completion and close unchanged.
import { pqSpendItems } from "../pq/script.js";
import { pubKeySize, sigSize, type PQScheme } from "../pq/scheme.js";
import { equalBytes } from "../tx/bytes.js";
import { feeFloor } from "../tx/fee.js";
import { OP, buildScript } from "../tx/script.js";
import { SEQUENCE_FINAL, newTx, type TxOut } from "../tx/tx.js";
import type { Channel } from "./channel.js";
import { DUST_THRESHOLD } from "./constants.js";
import { parsePQChannelScript } from "./pqScript.js";

export interface VoucherLayoutParams {
  channel: Channel;
  /** The total the voucher pays the server, in the asset's unit. */
  cumulative: bigint;
  /** The client's change script; required whenever the layout has a client output. */
  clientScript?: Uint8Array;
}

/** The exact outputs of a voucher at `cumulative`; throws when the channel cannot carry it. */
export type VoucherLayout = (p: VoucherLayoutParams) => TxOut[];

/**
 * YEC: vout 0 pays `payTo` the cumulative, vout 1 returns V − closeFee − cumulative to the client.
 * A client remainder below dust is folded into vout 0 and vout 1 is omitted (plan X-F15).
 *
 * @param root0 - The layout parameters.
 * @param root0.channel - The channel.
 * @param root0.cumulative - The total paid to the server, zatoshis.
 * @param root0.clientScript - The client's change script; needed unless the remainder is dust.
 * @returns The voucher's outputs.
 * @throws RangeError when the cumulative is below dust or above the deposit; Error when the
 *   client script is missing or equals payTo.
 */
export const yecVoucherOutputs: VoucherLayout = ({ channel, cumulative, clientScript }) => {
  const deposit = channel.value - channel.closeFee;
  if (cumulative < DUST_THRESHOLD) throw new RangeError(`cumulative ${cumulative} is below the ${DUST_THRESHOLD}-zatoshi dust threshold`);
  if (cumulative > deposit) throw new RangeError(`cumulative ${cumulative} exceeds the deposit ${deposit}`);
  const remainder = deposit - cumulative;
  if (remainder < DUST_THRESHOLD) return [{ value: deposit, scriptPubKey: channel.payToScript }];
  if (!clientScript) throw new Error("a client output script is required");
  if (equalBytes(clientScript, channel.payToScript)) throw new Error("the client output must not pay payTo");
  return [
    { value: cumulative, scriptPubKey: channel.payToScript },
    { value: remainder, scriptPubKey: clientScript },
  ];
};

/** A DER signature at its longest (72 bytes) plus the hash type. */
const MAX_SIG = new Uint8Array(73);

/**
 * The fee floor of a close with these outputs: one channel input whose scriptSig is the full
 * `OP_0 <sigC> <sigS> OP_1 <redeemScript>` at maximum signature length, or, for a TX_PQCHANNEL,
 * `<sigS> <sigC chunks> <s> <pk chunks> <p> OP_1` (an SLH-DSA client's is ≈ 8,013 bytes, so its
 * floor is ≈ 27,000 zatoshis where the P2SH close's is 1,500).
 *
 * @param redeemScript - The channel script.
 * @param outputs - The close's outputs.
 * @returns The minimum fee, zatoshis.
 */
export function closeFeeFloor(redeemScript: Uint8Array, outputs: readonly TxOut[]): bigint {
  const pq = parsePQChannelScript(redeemScript);
  if (pq) return pqCloseFeeFloor(pq.client.scheme, outputs);
  return floorOf(buildScript([OP.OP_0, MAX_SIG, MAX_SIG, OP.OP_1, redeemScript]), outputs);
}

/**
 * The fee floor of a TX_PQCHANNEL close with these outputs and a client key of `scheme`:
 * `<sigS> <sigC chunks> <s> <pk chunks> <p> OP_1` at maximum ECDSA length.
 *
 * @param scheme - The client key's scheme.
 * @param outputs - The close's outputs.
 * @returns The minimum fee, zatoshis.
 */
export function pqCloseFeeFloor(scheme: PQScheme, outputs: readonly TxOut[]): bigint {
  return floorOf(buildScript([MAX_SIG, ...pqSpendItems(new Uint8Array(pubKeySize(scheme)), new Uint8Array(sigSize(scheme) + 1)), OP.OP_1]), outputs);
}

/**
 * The fee floor of a one-input transaction with this scriptSig and these outputs.
 *
 * @param scriptSig - The input's scriptSig.
 * @param outputs - The outputs.
 * @returns The minimum fee, zatoshis.
 */
function floorOf(scriptSig: Uint8Array, outputs: readonly TxOut[]): bigint {
  const tx = newTx({
    vin: [{ prevout: { txid: "00".repeat(32), vout: 0 }, scriptSig, sequence: SEQUENCE_FINAL }],
    vout: [...outputs],
  });
  return feeFloor(tx);
}
