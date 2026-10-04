// Hand-built payments for the negative cases: any shape, any hash type, signed with the SDK.
import {
  addressToScript,
  newTx,
  p2pkhScriptSig,
  pubkeyFromPriv,
  serializeTxHex,
  sighashV4,
  signInput,
  SEQUENCE_FINAL,
  SIGHASH,
  type Tx,
  type TxOut,
} from "../../../src/tx/index.js";
import { BRANCH_ID, NETWORK, type FakeNode } from "./fakeNode.js";

export interface BuildOptions {
  coins: { txid: string; vout: number; value: bigint; script: Uint8Array }[];
  priv: Uint8Array;
  outputs: TxOut[];
  expiryHeight: number;
  lockTime?: number;
  hashType?: number;
  mutate?: (tx: Tx) => void;
}

export function buildSigned(o: BuildOptions): string {
  const tx = newTx({
    vin: o.coins.map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: new Uint8Array(), sequence: SEQUENCE_FINAL })),
    vout: o.outputs,
    lockTime: o.lockTime ?? 0,
    expiryHeight: o.expiryHeight,
  });
  o.mutate?.(tx);
  const pub = pubkeyFromPriv(o.priv);
  o.coins.forEach((c, i) => {
    const ht = o.hashType ?? SIGHASH.ALL;
    tx.vin[i]!.scriptSig = p2pkhScriptSig(signInput(sighashV4(tx, i, c.script, c.value, ht, BRANCH_ID), o.priv, ht), pub);
  });
  return serializeTxHex(tx);
}

/** A standard payment: one coin of `coinValue`, `amount` to payTo, change, `fee`. */
export function standardPayment(
  node: FakeNode,
  payer: { priv: Uint8Array; script: Uint8Array },
  payTo: string,
  opts: { amount?: bigint; fee?: bigint; coinValue?: bigint; expiry?: number; hashType?: number; extraOutputs?: TxOut[]; confirmations?: number } = {},
): { hex: string; coin: { txid: string; vout: number } } {
  const amount = opts.amount ?? 250_000n;
  const fee = opts.fee ?? 1_000n;
  const value = opts.coinValue ?? 10_000_000n;
  const coin = node.addCoin(value, payer.script, opts.confirmations ?? 6);
  const outputs: TxOut[] = [{ value: amount, scriptPubKey: addressToScript(payTo, NETWORK) }, ...(opts.extraOutputs ?? [])];
  const used = outputs.reduce((s, x) => s + x.value, 0n);
  outputs.push({ value: value - used - fee, scriptPubKey: payer.script });
  const hex = buildSigned({
    coins: [{ ...coin, value, script: payer.script }],
    priv: payer.priv,
    outputs,
    expiryHeight: opts.expiry ?? node.tip + 3 + 4,
    ...(opts.hashType !== undefined ? { hashType: opts.hashType } : {}),
  });
  return { hex, coin };
}
