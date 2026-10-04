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
  type Tx,
  type TxOut,
} from "../../tx/index.js";
import { buildYedTransfer, selectTokenCoins, type YecCoin } from "../../yed/index.js";
import { selectCoins } from "./coinSelection.js";
import type { ChainState, PaymentOrder, SignedPayment, YcashClientSigner, YedPaymentOrder } from "./signer.js";
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

  /**
   * Derives the key's public key and P2PKH script from its WIF.
   *
   * @param wif - The private key in Ycash WIF.
   * @param source - Where the key's coins (and, for YED, token outputs) are listed.
   */
  constructor(
    wif: string,
    private readonly source: UtxoSource,
  ) {
    const k = decodeWif(wif);
    this.privKey = k.privKey;
    this.pubkey = pubkeyFromPriv(k.privKey, k.compressed);
    this.script = p2pkhScript(hash160(this.pubkey));
  }

  /**
   * Encodes the key's transparent address; the WIF does not fix the network.
   *
   * @param network - The network to encode for.
   * @returns The P2PKH address.
   */
  address(network: PaymentOrder["network"]): string {
    return encodeAddress(network, "p2pkh", hash160(this.pubkey));
  }

  /**
   * Reads the tip and branch id from the UtxoSource.
   *
   * @returns The source's chain state.
   */
  chainState(): Promise<ChainState> {
    return this.source.chainState();
  }

  /**
   * Builds and signs a YEC payment, retrying up to three times when the source's durable
   * reservation reports that another process took one of the selected coins.
   *
   * @param order - The payment to build.
   * @returns The signed, unbroadcast transaction and the outpoints it spends.
   * @throws Error when funds are insufficient or the coins keep being taken.
   */
  async signPayment(order: PaymentOrder): Promise<SignedPayment> {
    for (let attempt = 1; ; attempt++) {
      const signed = await this.signOnce(order);
      // The source's durable hold: another process may have taken one of these coins meanwhile.
      if (!this.source.reserve || (await this.source.reserve(signed.inputs, { txid: signed.txid, expiryHeight: order.expiryHeight }))) return signed;
      if (attempt >= 3) throw new Error("coins kept being taken by another spend of this key; try again");
    }
  }

  /**
   * A YED payment from this key's token outputs (its `ye…` address), with YEC fee coins from its
   * transparent address; YED and YEC change return to the key. Retries like `signPayment`.
   *
   * @param order - The YED payment to build.
   * @returns The signed, unbroadcast transaction and the outpoints it spends.
   * @throws Error when the source cannot list tokens, funds are insufficient, or the coins keep
   * being taken.
   */
  async signYedPayment(order: YedPaymentOrder): Promise<SignedPayment> {
    for (let attempt = 1; ; attempt++) {
      const signed = await this.signYedOnce(order);
      if (!this.source.reserve || (await this.source.reserve(signed.inputs, { txid: signed.txid, expiryHeight: order.expiryHeight }))) return signed;
      if (attempt >= 3) throw new Error("coins kept being taken by another spend of this key; try again");
    }
  }

  /**
   * One YEC build attempt: selects confirmed coins not held by an earlier unexpired payment,
   * holds them in memory until the order's expiry, and signs.
   *
   * @param order - The payment to build.
   * @returns The signed transaction and its inputs.
   */
  private async signOnce(order: PaymentOrder): Promise<SignedPayment> {
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
    this.signAll(tx, sel.coins.map((c) => ({ value: c.value, scriptPubKey: c.scriptPubKey })), order.branchId);
    return { hex: serializeTxHex(tx), txid: txid(tx), inputs: sel.coins.map((c) => ({ txid: c.txid, vout: c.vout })) };
  }

  /**
   * One YED build attempt: selects token outputs at the key's `ye…` address and YEC fee coins,
   * holds them in memory until the order's expiry, and signs the TRANSFER.
   *
   * @param order - The YED payment to build.
   * @returns The signed transaction and its inputs.
   * @throws Error when the UtxoSource cannot list YED outputs.
   */
  private async signYedOnce(order: YedPaymentOrder): Promise<SignedPayment> {
    if (!this.source.listTokens) throw new Error("this UtxoSource cannot list YED outputs");
    for (const [k, expiry] of this.reserved) if (expiry < order.tip) this.reserved.delete(k);
    const free = (o: { txid: string; vout: number }) => !this.reserved.has(`${o.txid}:${o.vout}`);
    const yr = encodeAddress(order.network, "yed", hash160(this.pubkey));
    const tokens = (await this.source.listTokens(yr)).filter((t) => equalBytes(t.scriptPubKey, this.script) && free(t.outpoint));
    const yec: YecCoin[] = (await this.source.listCoins(this.address(order.network)))
      .filter((c) => c.confirmations >= 1 && equalBytes(c.scriptPubKey, this.script) && free(c))
      .map((c) => ({ outpoint: { txid: c.txid, vout: c.vout }, value: c.value, scriptPubKey: c.scriptPubKey }));
    const sel = selectTokenCoins(tokens, order.amountCents);
    const built = buildYedTransfer({
      recipients: [{ scriptPubKey: addressToScript(order.payTo, order.network), cents: order.amountCents }],
      tokens: sel.coins,
      yecCoins: yec,
      yedChangeScript: this.script,
      yecChangeScript: this.script,
      expiryHeight: order.expiryHeight,
    });
    const inputs = built.inputs.map((c) => c.outpoint);
    for (const o of inputs) this.reserved.set(`${o.txid}:${o.vout}`, order.expiryHeight);
    this.signAll(built.tx, built.inputs, order.branchId);
    return { hex: serializeTxHex(built.tx), txid: txid(built.tx), inputs };
  }

  /**
   * Signs every input SIGHASH_ALL with this key, in place.
   *
   * @param tx - The unsigned transaction.
   * @param coins - The spent coins; `coins[i]` is the one vin[i] spends.
   * @param branchId - The consensus branch id the ZIP-243 sighash commits to.
   */
  private signAll(tx: Tx, coins: readonly { value: bigint; scriptPubKey: Uint8Array }[], branchId: number): void {
    coins.forEach((c, i) => {
      const digest = sighashV4(tx, i, c.scriptPubKey, c.value, SIGHASH.ALL, branchId);
      (tx.vin[i] as (typeof tx.vin)[number]).scriptSig = p2pkhScriptSig(signInput(digest, this.privKey, SIGHASH.ALL), this.pubkey);
    });
  }
}
