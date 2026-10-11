// Vouchers: client-signed transactions that spend the channel through its multisig branch
// (specs/scheme_batch_settlement_ycash.md, "`voucher`", "Spends"). The scriptSig is assembled here
// because the stock signer cannot sign a non-template script (plan R-8, src/script/sign.cpp:84-86),
// as atomic swap does (ycash-dd/src/script/atomicswap.cpp:151-185).
import { pqSign, pqVerify, type PQKeyPair } from "../pq/sign.js";
import { parsePQSpend, pqSpendItems, spendMatches, type PQSpend } from "../pq/script.js";
import { equalBytes } from "../tx/bytes.js";
import { signInput, sigHashType, verifyInputSig } from "../tx/keys.js";
import { OP, buildScript, p2shScriptSig, parseScript } from "../tx/script.js";
import { SIGHASH, sighashV4 } from "../tx/sighash.js";
import { SEQUENCE_FINAL, hasShielded, newTx, type Tx } from "../tx/tx.js";
import type { Channel, PQChannel } from "./channel.js";
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
  /** C's secp256k1 private key (P2SH channel). */
  clientPrivKey?: Uint8Array;
  /** The client's post-quantum key pair (TX_PQCHANNEL); its key hash must be the channel's. */
  clientPQKey?: PQKeyPair;
  /** The consensus branch id the voucher is signed under (`getblockchaininfo.consensus.nextblock`). */
  branchId: number;
  layout?: VoucherLayout;
}

/**
 * The client's post-quantum signature of a TX_PQCHANNEL spend, hash type ALL appended.
 *
 * @param sighash - The 32-byte sighash.
 * @param key - The client's key pair.
 * @returns The signature ‖ 0x01.
 */
export function pqSignAll(sighash: Uint8Array, key: PQKeyPair): Uint8Array {
  const sig = pqSign(key.scheme, key.secretKey, sighash);
  const out = new Uint8Array(sig.length + 1);
  out.set(sig);
  out[sig.length] = SIGHASH.ALL;
  return out;
}

/**
 * The cooperative TX_PQCHANNEL scriptSig: `<sigS | OP_0> <sig_1>…<sig_s> <s> <pk_1>…<pk_p> <p> OP_1`
 * (s + p + 4 pushes; quantum spec D-Q-19).
 *
 * @param sigS - The server's signature, or empty for a voucher's open slot.
 * @param pk - The client's public key.
 * @param sigC - The client's signature ‖ hash type.
 * @returns The scriptSig.
 */
export function pqCloseScriptSig(sigS: Uint8Array, pk: Uint8Array, sigC: Uint8Array): Uint8Array {
  return buildScript([sigS.length === 0 ? OP.OP_0 : sigS, ...pqSpendItems(pk, sigC), OP.OP_1]);
}

/**
 * The client's key pair of a TX_PQCHANNEL voucher or refund, checked against the channel.
 *
 * @param channel - The channel.
 * @param key - The key pair given.
 * @returns The key pair.
 * @throws Error when it is missing or is not the channel's client key.
 */
export function pqClientKey(channel: PQChannel, key: PQKeyPair | undefined): PQKeyPair {
  if (!key) throw new Error("a post-quantum channel needs the client's post-quantum key");
  if (!spendMatches({ scheme: key.scheme, pk: key.publicKey, sig: new Uint8Array() }, channel.client)) {
    throw new Error("the post-quantum key is not the channel's client key");
  }
  return key;
}

/**
 * A voucher: one input (the channel outpoint), the layout's outputs, nLockTime 0 and nExpiryHeight
 * 0 (it must stay valid until the server closes), signed SIGHASH_ALL by C, with the server's slot
 * empty: `OP_0 <sigC> OP_0 OP_1 <redeemScript>` (P2SH), or `OP_0 <sigC chunks> <s> <pk> <p> OP_1`
 * (TX_PQCHANNEL).
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
  const sighash = voucherSighash(tx, p.channel, p.branchId);
  if (p.channel.template === "pq") {
    const key = pqClientKey(p.channel, p.clientPQKey);
    tx.vin[0]!.scriptSig = pqCloseScriptSig(new Uint8Array(), key.publicKey, pqSignAll(sighash, key));
    return tx;
  }
  if (!p.clientPrivKey) throw new Error("a P2SH channel needs the client's private key");
  const sigC = signInput(sighash, p.clientPrivKey, SIGHASH.ALL);
  tx.vin[0]!.scriptSig = p2shScriptSig([OP.OP_0, sigC, OP.OP_0, OP.OP_1], p.channel.redeemScript);
  return tx;
}

export interface PQCloseScriptSig {
  /** Empty in a voucher (the server's slot), the server's signature in a completed close. */
  sigS: Uint8Array;
  /** The client's chunked spend. */
  spend: PQSpend;
}

/**
 * Parses the cooperative TX_PQCHANNEL scriptSig `<sigS | OP_0> <sig_1>…<sig_s> <s> <pk_1>…<pk_p> <p> OP_1`,
 * with minimal pushes and canonical chunks only; null for any other scriptSig.
 *
 * @param scriptSig - The channel input's scriptSig.
 * @returns The server's signature (empty when unfilled) and the client's spend, or null.
 */
export function parsePQCloseScriptSig(scriptSig: Uint8Array): PQCloseScriptSig | null {
  let chunks;
  try {
    chunks = parseScript(scriptSig);
  } catch {
    return null;
  }
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  if (!first?.data || !last || last.op !== OP.OP_1 || last.data !== undefined) return null;
  const spend = parsePQSpend(chunks.slice(1, -1));
  if (!spend) return null;
  const parsed = { sigS: first.data, spend };
  return equalBytes(pqCloseScriptSig(parsed.sigS, spend.pk, spend.sig), scriptSig) ? parsed : null;
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
  if (channel.template === "pq") {
    const ps = parsePQCloseScriptSig(input.scriptSig);
    if (!ps || (ps.sigS.length !== 0 && !opts.allowCompleted)) return "script_sig";
  } else {
    const ss = parseCloseScriptSig(input.scriptSig);
    if (!ss || (ss.sigS.length !== 0 && !opts.allowCompleted)) return "script_sig";
    if (!equalBytes(ss.redeemScript, channel.redeemScript)) return "redeem_script";
  }
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
 * Voucher rule 6: sigC is a valid strict-DER low-S SIGHASH_ALL signature by C (P2SH), or a valid
 * SIGHASH_ALL post-quantum signature by the key whose SHA256(scheme ‖ pk) the channel names (TX_PQCHANNEL).
 *
 * @param tx - The voucher.
 * @param channel - The channel it spends.
 * @param branchId - The consensus branch id it was signed under.
 * @returns Whether the client signature verifies.
 */
export function verifyVoucherSignature(tx: Tx, channel: Channel, branchId: number): boolean {
  if (channel.template === "pq") {
    const ps = tx.vin.length === 1 && tx.vin[0] ? parsePQCloseScriptSig(tx.vin[0].scriptSig) : null;
    if (!ps || !spendMatches(ps.spend, channel.client) || sigHashType(ps.spend.sig) !== SIGHASH.ALL) return false;
    return pqVerify(ps.spend.scheme, ps.spend.pk, ps.spend.sig.subarray(0, -1), voucherSighash(tx, channel, branchId));
  }
  const ss = tx.vin.length === 1 && tx.vin[0] ? parseCloseScriptSig(tx.vin[0].scriptSig) : null;
  if (!ss || sigHashType(ss.sigC) !== SIGHASH.ALL) return false;
  return verifyInputSig(ss.sigC, voucherSighash(tx, channel, branchId), channel.clientPubKey);
}

/**
 * Server completion: adds sigS in its slot, giving `OP_0 <sigC> <sigS> OP_1 <redeemScript>` (P2SH)
 * or `<sigS> <sigC chunks> <s> <pk> <p> OP_1` (TX_PQCHANNEL).
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
  if (channel.template === "pq") {
    const ps = tx.vin.length === 1 && tx.vin[0] ? parsePQCloseScriptSig(tx.vin[0].scriptSig) : null;
    if (!ps) throw new Error("not a voucher");
    const sigS = signInput(voucherSighash(tx, channel, branchId), serverPrivKey, SIGHASH.ALL);
    return { ...tx, vin: [{ ...tx.vin[0]!, scriptSig: pqCloseScriptSig(sigS, ps.spend.pk, ps.spend.sig) }] };
  }
  const ss = tx.vin.length === 1 && tx.vin[0] ? parseCloseScriptSig(tx.vin[0].scriptSig) : null;
  if (!ss) throw new Error("not a voucher");
  const sigS = signInput(voucherSighash(tx, channel, branchId), serverPrivKey, SIGHASH.ALL);
  const done: Tx = { ...tx, vin: [{ ...tx.vin[0]!, scriptSig: p2shScriptSig([OP.OP_0, ss.sigC, sigS, OP.OP_1], channel.redeemScript) }] };
  return done;
}
