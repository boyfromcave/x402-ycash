// Signer backend (a): keys held by the agent, signed with the SDK's ZIP-243 code (src/tx).
import {
  addressToScript,
  decodeWif,
  encodeAddress,
  hash160,
  newTx,
  p2pkhScript,
  p2pkhScriptSig,
  pubkeyFromPriv,
  equalBytes,
  serializeTxHex,
  sighashV4,
  signInput,
  SEQUENCE_FINAL,
  SIGHASH,
  txid,
  type TxOut,
} from "../../tx/index.js";
import { selectCoins } from "./coinSelection.js";
import type { ChainState, PaymentOrder, SignedPayment, YcashClientSigner } from "./signer.js";
import type { UtxoSource } from "./utxoSource.js";

/**
 * One P2PKH key: coins from the UtxoSource at the key's `s…`/`sm…` address, change back to it.
 * The WIF prefix is shared by testnet and regtest (plan X-F1), so the address is encoded per
 * order, from the requirements' network.
 */
export class LocalKeySigner implements YcashClientSigner {
  private readonly privKey: Uint8Array;
  private readonly pubkey: Uint8Array;
  private readonly script: Uint8Array;
  /** Coins in signed, not yet broadcast payments, kept out of selection until their expiry passes. */
  private readonly reserved = new Map<string, number>();

  constructor(
    wif: string,
    private readonly source: UtxoSource,
  ) {
    const k = decodeWif(wif);
    this.privKey = k.privKey;
    this.pubkey = pubkeyFromPriv(k.privKey, k.compressed);
    this.script = p2pkhScript(hash160(this.pubkey));
  }

  /** The key's transparent address on `network`. */
  address(network: PaymentOrder["network"]): string {
    return encodeAddress(network, "p2pkh", hash160(this.pubkey));
  }

  chainState(): Promise<ChainState> {
    return this.source.chainState();
  }

  async signPayment(order: PaymentOrder): Promise<SignedPayment> {
    const payToScript = addressToScript(order.payTo, order.network);
    for (const [k, expiry] of this.reserved) if (expiry < order.tip) this.reserved.delete(k);
    const coins = (await this.source.listCoins(this.address(order.network))).filter(
      (c) => equalBytes(c.scriptPubKey, this.script) && !this.reserved.has(`${c.txid}:${c.vout}`),
    );
    const sel = selectCoins(coins, order.amount, payToScript, this.script);
    for (const c of sel.coins) this.reserved.set(`${c.txid}:${c.vout}`, order.expiryHeight);
    const vout: TxOut[] = [{ value: order.amount, scriptPubKey: payToScript }];
    if (sel.change > 0n) vout.push({ value: sel.change, scriptPubKey: this.script });
    const tx = newTx({
      vin: sel.coins.map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: new Uint8Array(), sequence: SEQUENCE_FINAL })),
      vout,
      lockTime: 0,
      expiryHeight: order.expiryHeight,
    });
    sel.coins.forEach((c, i) => {
      const digest = sighashV4(tx, i, c.scriptPubKey, c.value, SIGHASH.ALL, order.branchId);
      (tx.vin[i] as (typeof tx.vin)[number]).scriptSig = p2pkhScriptSig(signInput(digest, this.privKey, SIGHASH.ALL), this.pubkey);
    });
    return { hex: serializeTxHex(tx), txid: txid(tx), inputs: sel.coins.map((c) => ({ txid: c.txid, vout: c.vout })) };
  }
}
