// Vouchers: client-signed transactions that spend the channel through its multisig branch
// (specs/scheme_batch_settlement_ycash.md, "`voucher`", "Spends"). The scriptSig is assembled here
// because the stock signer cannot sign a non-template script (plan R-8, src/script/sign.cpp:84-86),
// as atomic swap does (ycash-dd/src/script/atomicswap.cpp:151-185).
import { equalBytes } from "../tx/bytes.js";
import { signInput, sigHashType, verifyInputSig } from "../tx/keys.js";
import { OP, p2shScriptSig, parseScript } from "../tx/script.js";
import { SIGHASH, sighashV4 } from "../tx/sighash.js";
import { SEQUENCE_FINAL, hasShielded, newTx, type Tx } from "../tx/tx.js";
import type { Channel } from "./channel.js";
import { yecVoucherOutputs, type VoucherLayout } from "./outputs.js";

/**
 * The ZIP-243 hash both voucher signatures cover: script code the redeem script, amount V.
 *
 * @param tx - The voucher or close.
 * @param channel - The channel it spends.
 * @param branchId - The consensus branch id.
 * @returns The 32-byte SIGHASH_ALL digest of input 0.
 */
export function voucherSighash(tx: Tx, channel: Channel, branchId: number): Uint8Array {
  return sighashV4(tx, 0, channel.redeemScript, channel.value, SIGHASH.ALL, branchId);
}

export interface BuildVoucherParams {
  channel: Channel;
  cumulative: bigint;
  /** The client's change script (YEC: omitted from the tx when the remainder is dust). */
  clientScript?: Uint8Array;
  clientPrivKey: Uint8Array;
  /** The consensus branch id the voucher is signed under (`getblockchaininfo.consensus.nextblock`). */
  branchId: number;
  layout?: VoucherLayout;
}

/**
 * A voucher: one input (the channel outpoint), the layout's outputs, nLockTime 0 and nExpiryHeight
 * 0 (it must stay valid until the server closes), signed SIGHASH_ALL by C, with the server's slot
 * empty: `OP_0 <sigC> OP_0 OP_1 <redeemScript>`.
 *
 * @param p - Channel, cumulative, client key and script, branch id and optional layout (default YEC).
 * @returns The client-signed voucher.
 * @throws RangeError or Error from the layout when the channel cannot carry `cumulative`.
 */
export function buildVoucher(p: BuildVoucherParams): Tx {
  const layout = p.layout ?? yecVoucherOutputs;
  const tx = newTx({
    vin: [{ prevout: p.channel.outpoint, scriptSig: new Uint8Array(), sequence: SEQUENCE_FINAL }],
    vout: layout({ channel: p.channel, cumulative: p.cumulative, ...(p.clientScript ? { clientScript: p.clientScript } : {}) }),
    lockTime: 0,
    expiryHeight: 0,
  });
  const sigC = signInput(voucherSighash(tx, p.channel, p.branchId), p.clientPrivKey, SIGHASH.ALL);
  tx.vin[0]!.scriptSig = p2shScriptSig([OP.OP_0, sigC, OP.OP_0, OP.OP_1], p.channel.redeemScript);
  return tx;
}

export interface CloseScriptSig {
  sigC: Uint8Array;
  /** Empty in a voucher (the server's slot), the server's signature in a completed close. */
  sigS: Uint8Array;
  redeemScript: Uint8Array;
}

/**
 * Parses `OP_0 <sigC> <sigS | OP_0> OP_1 <redeemScript>`, with minimal pushes only; null for any
 * other scriptSig.
 *
 * @param scriptSig - The channel input's scriptSig.
 * @returns The two signatures (sigS empty when unfilled) and redeem script, or null.
 */
export function parseCloseScriptSig(scriptSig: Uint8Array): CloseScriptSig | null {
  let chunks;
  try {
    chunks = parseScript(scriptSig);
  } catch {
    return null;
  }
  if (chunks.length !== 5) return null;
  const [dummy, c, s, branch, rs] = chunks as [typeof chunks[0], typeof chunks[0], typeof chunks[0], typeof chunks[0], typeof chunks[0]];
  if (dummy.op !== OP.OP_0 || branch.op !== OP.OP_1 || branch.data !== undefined) return null;
  if (!c.data || c.data.length === 0 || !s.data || !rs.data) return null;
  const parsed = { sigC: c.data, sigS: s.data, redeemScript: rs.data };
  const canonical = p2shScriptSig([OP.OP_0, parsed.sigC, parsed.sigS.length === 0 ? OP.OP_0 : parsed.sigS, OP.OP_1], parsed.redeemScript);
  return equalBytes(canonical, scriptSig) ? parsed : null;
}

export type VoucherShapeError = "inputs" | "script_sig" | "redeem_script" | "lock_time" | "expiry" | "shielded" | "outputs";

/**
 * Voucher rule 4: one input spending the channel outpoint with the close skeleton (server slot
 * empty unless `allowCompleted`), nLockTime 0, nExpiryHeight 0, transparent only, and exactly the
 * layout's outputs at `cumulative`. The client's script is the channel's bound return script
 * (`clientScript`, from the open's returnAddress); only a verifier that never saw the open (a
 * stateless facilitator) leaves it out, and then it is read from vout 1.
 *
 * @param tx - The voucher (or completed close, with `allowCompleted`).
 * @param channel - The channel it must spend.
 * @param cumulative - The amount it must pay the server, in the asset's unit.
 * @param opts - Optional checks.
 * @param opts.layout - The output layout; defaults to the YEC layout.
 * @param opts.allowCompleted - Accept a filled server signature slot.
 * @param opts.clientScript - The channel's bound client return script.
 * @returns The first rule broken, or null when the shape is valid.
 */
export function checkVoucherShape(
  tx: Tx,
  channel: Channel,
  cumulative: bigint,
  opts: { layout?: VoucherLayout; allowCompleted?: boolean; clientScript?: Uint8Array } = {},
): VoucherShapeError | null {
  const input = tx.vin[0];
  if (tx.vin.length !== 1 || !input) return "inputs";
  if (input.prevout.txid !== channel.outpoint.txid || input.prevout.vout !== channel.outpoint.vout) return "inputs";
  const ss = parseCloseScriptSig(input.scriptSig);
  if (!ss || (ss.sigS.length !== 0 && !opts.allowCompleted)) return "script_sig";
  if (!equalBytes(ss.redeemScript, channel.redeemScript)) return "redeem_script";
  if (tx.lockTime !== 0) return "lock_time";
  if (tx.expiryHeight !== 0) return "expiry";
  if (hasShielded(tx) || tx.valueBalance !== 0n) return "shielded";
  const clientScript = opts.clientScript ?? tx.vout[1]?.scriptPubKey;
  let expected;
  try {
    expected = (opts.layout ?? yecVoucherOutputs)({ channel, cumulative, ...(clientScript ? { clientScript } : {}) });
  } catch {
    return "outputs";
  }
  if (expected.length !== tx.vout.length) return "outputs";
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]!;
    const got = tx.vout[i]!;
    if (want.value !== got.value || !equalBytes(want.scriptPubKey, got.scriptPubKey)) return "outputs";
  }
  return null;
}

/**
 * Voucher rule 6: sigC is a valid strict-DER low-S SIGHASH_ALL signature by C.
 *
 * @param tx - The voucher.
 * @param channel - The channel it spends.
 * @param branchId - The consensus branch id it was signed under.
 * @returns Whether the client signature verifies.
 */
export function verifyVoucherSignature(tx: Tx, channel: Channel, branchId: number): boolean {
  const ss = tx.vin.length === 1 && tx.vin[0] ? parseCloseScriptSig(tx.vin[0].scriptSig) : null;
  if (!ss || sigHashType(ss.sigC) !== SIGHASH.ALL) return false;
  return verifyInputSig(ss.sigC, voucherSighash(tx, channel, branchId), channel.clientPubKey);
}

/**
 * Server completion: adds sigS in its slot, giving `OP_0 <sigC> <sigS> OP_1 <redeemScript>`.
 * The outputs cannot change: the client signed SIGHASH_ALL.
 *
 * @param tx - The client-signed voucher.
 * @param channel - The channel it spends.
 * @param serverPrivKey - S's private key.
 * @param branchId - The consensus branch id to sign under.
 * @returns The completed close, ready to broadcast; `tx` is not modified.
 * @throws Error when `tx` does not have the voucher's scriptSig.
 */
export function completeVoucher(tx: Tx, channel: Channel, serverPrivKey: Uint8Array, branchId: number): Tx {
  const ss = tx.vin.length === 1 && tx.vin[0] ? parseCloseScriptSig(tx.vin[0].scriptSig) : null;
  if (!ss) throw new Error("not a voucher");
  const sigS = signInput(voucherSighash(tx, channel, branchId), serverPrivKey, SIGHASH.ALL);
  const done: Tx = { ...tx, vin: [{ ...tx.vin[0]!, scriptSig: p2shScriptSig([OP.OP_0, ss.sigC, sigS, OP.OP_1], channel.redeemScript) }] };
  return done;
}
