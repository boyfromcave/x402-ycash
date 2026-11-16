// Copyright (c) 2026 The Ycash developers. MIT License.
//
// `split --count N`: one transaction from the key's confirmed coins to N equal outputs back to its
// own address. Over lightwalletd an agent spends confirmed coins only, one payment per coin until
// the next block, and a faucet pays one output per address (z_sendmany refuses duplicate
// recipients); a split after one block gives N payments in a row.
import { exact, tx, type YcashNetwork } from "x402-ycash-mechanism";

/** The most outputs one split makes (a small transaction, a bounded fee). */
export const MAX_SPLIT_OUTPUTS = 50;
/** The most coins one split spends (largest first). */
export const MAX_SPLIT_INPUTS = 50;
/** The default smallest output: one 0.0001 YEC payment plus its network fee, with room. */
export const DEFAULT_MIN_SPLIT_OUTPUT_ZAT = 20_000n;
/** Blocks the split stays valid for. */
const SPLIT_EXPIRY_DELTA = 20;

export interface SplitPlan {
  hex: string;
  txid: string;
  inputs: { txid: string; vout: number }[];
  /** Each output, zatoshis. */
  each: bigint;
  count: number;
  fee: bigint;
  expiryHeight: number;
}

/**
 * Builds and signs the split. Nothing is broadcast here.
 *
 * @param coins - The key's spendable coins (only confirmed ones are used).
 * @param opts - The key, network, count, smallest output and the chain state to sign at.
 * @param opts.wif - The key (WIF) whose coins are split.
 * @param opts.network - The network.
 * @param opts.count - How many outputs, 2..MAX_SPLIT_OUTPUTS.
 * @param opts.minOutput - The smallest output allowed, zatoshis.
 * @param opts.height - The tip, for the expiry height.
 * @param opts.branchId - The branch id of the next block, signed into every input.
 * @returns The signed transaction and its figures.
 * @throws Error on a bad count, no confirmed coin, or outputs that would be smaller than `minOutput`.
 */
export function buildSplit(
  coins: readonly exact.Coin[],
  opts: { wif: string; network: YcashNetwork; count: number; minOutput: bigint; height: number; branchId: number },
): SplitPlan {
  if (!Number.isInteger(opts.count) || opts.count < 2 || opts.count > MAX_SPLIT_OUTPUTS) throw new Error(`--count must be 2..${MAX_SPLIT_OUTPUTS}`);
  const minOutput = opts.minOutput > exact.DUST_ZAT ? opts.minOutput : exact.DUST_ZAT + 1n;
  const { privKey, compressed } = tx.decodeWif(opts.wif, opts.network);
  try {
    const pubkey = tx.pubkeyFromPriv(privKey, compressed);
    const script = tx.p2pkhScript(tx.hash160(pubkey));
    const mine = coins
      .filter((c) => c.confirmations >= 1 && tx.equalBytes(c.scriptPubKey, script))
      .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
      .slice(0, MAX_SPLIT_INPUTS);
    if (mine.length === 0) throw new Error("no confirmed coin to split: get coins (the faucet) and wait for one block");
    const total = mine.reduce((s, c) => s + c.value, 0n);
    const outputs = Array.from({ length: opts.count }, () => ({ value: 1n, scriptPubKey: script }));
    const fee = exact.draftFee(mine.length, outputs);
    if (total <= fee) throw new Error(`the confirmed coins (${total} zatoshis) do not cover the fee (${fee})`);
    const each = (total - fee) / BigInt(opts.count);
    if (each < minOutput) {
      throw new Error(`${opts.count} outputs would be ${each} zatoshis each, below the smallest allowed (${minOutput}); split into fewer (at most ${(total - fee) / minOutput})`);
    }
    const remainder = total - fee - each * BigInt(opts.count); // < count zatoshis: to the fee
    const expiryHeight = opts.height + SPLIT_EXPIRY_DELTA;
    const t = tx.newTx({
      vin: mine.map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: new Uint8Array(), sequence: tx.SEQUENCE_FINAL })),
      vout: outputs.map(() => ({ value: each, scriptPubKey: script })),
      lockTime: 0,
      expiryHeight,
    });
    mine.forEach((c, i) => {
      const digest = tx.sighashV4(t, i, c.scriptPubKey, c.value, tx.SIGHASH.ALL, opts.branchId);
      (t.vin[i] as (typeof t.vin)[number]).scriptSig = tx.p2pkhScriptSig(tx.signInput(digest, privKey, tx.SIGHASH.ALL), pubkey);
    });
    return { hex: tx.serializeTxHex(t), txid: tx.txid(t), inputs: mine.map((c) => ({ txid: c.txid, vout: c.vout })), each, count: opts.count, fee: fee + remainder, expiryHeight };
  } finally {
    privKey.fill(0);
  }
}
