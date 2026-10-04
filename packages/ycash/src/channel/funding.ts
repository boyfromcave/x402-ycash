// The funding transaction: pays V to the channel's P2SH script at vout 0 and change to the client
// (specs/scheme_batch_settlement_ycash.md, "`open`"). It follows the `exact` construction rules
// (v4, transparent, SIGHASH_ALL, fee ≥ floor) except the expiry window: 0 (never) is allowed.
import { equalBytes } from "../tx/bytes.js";
import { feeFloor } from "../tx/fee.js";
import { pubkeyFromPriv, signInput } from "../tx/keys.js";
import { hash160 } from "../tx/hash.js";
import { p2pkhHash, p2pkhScriptSig } from "../tx/script.js";
import { SIGHASH, sighashV4 } from "../tx/sighash.js";
import { SEQUENCE_FINAL, newTx, type OutPoint, type Tx } from "../tx/tx.js";
import { DUST_THRESHOLD } from "./constants.js";
import { channelScriptPubKey } from "./script.js";

export interface FundingInput {
  outpoint: OutPoint;
  /** zatoshis */
  value: bigint;
  /** The coin's P2PKH scriptPubKey. */
  scriptPubKey: Uint8Array;
}

export interface BuildFundingParams {
  inputs: readonly FundingInput[];
  redeemScript: Uint8Array;
  /** V, zatoshis. */
  value: bigint;
  /** Where the change goes; change below dust is left to the fee. */
  changeScript: Uint8Array;
  /** Defaults to the fee floor. */
  fee?: bigint;
  /** 0 = never expires. */
  expiryHeight?: number;
}

/** The funding output is vout 0. */
export const FUNDING_VOUT = 0;

/** A P2PKH scriptSig at its longest: a 73-byte signature and a compressed key. */
const P2PKH_SCRIPTSIG_MAX = 1 + 73 + 1 + 33;

/**
 * Builds the unsigned funding transaction: V to the channel script at vout 0, then change unless
 * it is below dust (it then goes to the fee). The default fee is the floor of the tx sized with
 * full-length scriptSigs; inputs are returned with empty scriptSigs for {@link signFundingTx}.
 *
 * @param p - Inputs, redeem script, V, change script, optional fee and expiry height.
 * @returns The unsigned transaction.
 * @throws Error when there are no inputs or they cannot pay V plus the fee.
 */
export function buildFundingTx(p: BuildFundingParams): Tx {
  if (p.inputs.length === 0) throw new Error("funding needs at least one input");
  const total = p.inputs.reduce((s, i) => s + i.value, 0n);
  const channelOut = { value: p.value, scriptPubKey: channelScriptPubKey(p.redeemScript) };
  const tx = newTx({
    vin: p.inputs.map((i) => ({ prevout: i.outpoint, scriptSig: new Uint8Array(P2PKH_SCRIPTSIG_MAX), sequence: SEQUENCE_FINAL })),
    vout: [channelOut, { value: 0n, scriptPubKey: p.changeScript }],
    expiryHeight: p.expiryHeight ?? 0,
  });
  const fee = p.fee ?? feeFloor(tx); // sized with the change output and full-size scriptSigs
  const change = total - p.value - fee;
  if (change < 0n) throw new Error(`inputs ${total} cannot pay ${p.value} plus fee ${fee}`);
  tx.vout = change >= DUST_THRESHOLD ? [channelOut, { value: change, scriptPubKey: p.changeScript }] : [channelOut];
  for (const i of tx.vin) i.scriptSig = new Uint8Array();
  return tx;
}

/**
 * Signs every P2PKH input SIGHASH_ALL under ZIP-243; `privKeys[i]` owns `inputs[i]`.
 *
 * @param tx - The unsigned funding transaction.
 * @param inputs - The coins spent, in vin order (value and scriptPubKey feed the sighash).
 * @param privKeys - One private key per input.
 * @param branchId - The consensus branch id to sign under.
 * @returns A signed copy; `tx` is not modified.
 * @throws Error when the counts differ or an input is not a P2PKH coin of its key.
 */
export function signFundingTx(tx: Tx, inputs: readonly FundingInput[], privKeys: readonly Uint8Array[], branchId: number): Tx {
  if (inputs.length !== tx.vin.length || privKeys.length !== tx.vin.length) throw new Error("one input and key per vin");
  const signed: Tx = { ...tx, vin: tx.vin.map((i) => ({ ...i })) };
  inputs.forEach((inp, n) => {
    const priv = privKeys[n]!;
    const pub = pubkeyFromPriv(priv);
    const pkh = p2pkhHash(inp.scriptPubKey);
    if (!pkh || !equalBytes(pkh, hash160(pub))) throw new Error(`input ${n} is not a P2PKH coin of its key`);
    const sig = signInput(sighashV4(signed, n, inp.scriptPubKey, inp.value, SIGHASH.ALL, branchId), priv, SIGHASH.ALL);
    signed.vin[n]!.scriptSig = p2pkhScriptSig(sig, pub);
  });
  return signed;
}

/**
 * Finds the output of `tx` that pays the channel's P2SH script.
 *
 * @param tx - A funding transaction.
 * @param redeemScript - The channel redeem script.
 * @returns The first matching vout, or -1 when none pays it.
 */
export function findChannelVout(tx: Tx, redeemScript: Uint8Array): number {
  const spk = channelScriptPubKey(redeemScript);
  return tx.vout.findIndex((o) => equalBytes(o.scriptPubKey, spk));
}
