// An in-process chain for the batch-settlement unit tests: a UTXO set with a mempool, gettxout's
// two views, sendrawtransaction with first-seen conflicts, and a script verifier that really checks
// channel spends (both multisig signatures, or the refund's CLTV signature) and accepts P2PKH spends.
import { channel, tx as T, RpcError, SendRawTransactionError, zatToYecString } from "../../../src/index.js";
import type { BlockchainInfo, TxOutInfo, VerifyScriptsResult } from "../../../src/node/types.js";

export const CANOPY = 0x19bd2d2f;

interface Coin {
  value: bigint;
  spk: Uint8Array;
  /** height of its block, or null in the mempool */
  height: number | null;
  spentInMempool: boolean;
}

export class FakeChain {
  tip = 1000;
  chain = "regtest";
  branchId = CANOPY;
  readonly coins = new Map<string, Coin>();
  readonly sent: string[] = [];
  /** Make verifyScripts fail every input (a node refusing the scripts). */
  failScripts = false;

  addCoin(txid: string, vout: number, value: bigint, spk: Uint8Array, mempool = false): void {
    this.coins.set(`${txid}:${vout}`, { value, spk, height: mempool ? null : this.tip, spentInMempool: false });
  }

  mine(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.tip++;
      for (const [k, c] of this.coins) {
        if (c.height === null) c.height = this.tip;
        if (c.spentInMempool) this.coins.delete(k);
      }
    }
  }

  async getBlockCount(): Promise<number> {
    return this.tip;
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    const b = this.branchId.toString(16).padStart(8, "0");
    return { chain: this.chain, blocks: this.tip, headers: this.tip, bestblockhash: "00".repeat(32), consensus: { chaintip: b, nextblock: b }, upgrades: {} };
  }

  async getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null> {
    const c = this.coins.get(`${txid}:${n}`);
    if (!c) return null;
    if (includeMempool && c.spentInMempool) return null;
    if (!includeMempool && c.height === null) return null;
    return {
      bestblock: "00".repeat(32),
      confirmations: c.height === null ? 0 : this.tip - c.height + 1,
      value: Number(zatToYecString(c.value)),
      scriptPubKey: { asm: "", hex: T.bytesToHex(c.spk), type: "" },
      version: 4,
      coinbase: false,
    };
  }

  async verifyScripts(hex: string): Promise<VerifyScriptsResult> {
    const tx = T.parseTx(hex);
    const errors = tx.vin.flatMap((i, n) => (this.failScripts || !this.inputOk(tx, n) ? [{ txid: i.prevout.txid, vout: i.prevout.vout, scriptSig: "", sequence: i.sequence, error: "Script evaluated without error but finished with a false/empty top stack element" }] : []));
    return { complete: errors.length === 0, errors };
  }

  private inputOk(tx: T.Tx, n: number): boolean {
    const i = tx.vin[n]!;
    const c = this.coins.get(`${i.prevout.txid}:${i.prevout.vout}`);
    if (!c) return false;
    if (T.p2pkhHash(c.spk)) return true;
    const close = channel.parseCloseScriptSig(i.scriptSig);
    const chunks = T.parseScript(i.scriptSig);
    const rs = close?.redeemScript ?? chunks[chunks.length - 1]?.data;
    if (!rs || T.bytesToHex(T.p2shScript(T.hash160(rs))) !== T.bytesToHex(c.spk)) return false;
    const script = channel.parseChannelScript(rs);
    if (!script) return false;
    const sh = T.sighashV4(tx, n, rs, c.value, T.SIGHASH.ALL, this.branchId);
    if (close) {
      return T.verifyInputSig(close.sigC, sh, script.clientPubKey) && close.sigS.length > 0 && T.verifyInputSig(close.sigS, sh, script.serverPubKey);
    }
    // refund: <sigC> OP_0 <rs>, CLTV
    if (chunks.length !== 3 || chunks[1]?.op !== T.OP.OP_0) return false;
    if (tx.lockTime < script.refundHeight || i.sequence === T.SEQUENCE_FINAL) return false;
    return T.verifyInputSig(chunks[0]!.data!, sh, script.clientPubKey);
  }

  async sendRawTransaction(hex: string): Promise<string> {
    const tx = T.parseTx(hex);
    const id = T.txid(tx);
    if (tx.lockTime >= this.tip + 1 && tx.vin.some((i) => i.sequence !== T.SEQUENCE_FINAL)) throw new SendRawTransactionError(new RpcError(-26, "64: non-final", "sendrawtransaction"));
    if (this.coins.has(`${id}:0`)) throw new SendRawTransactionError(new RpcError(-27, "transaction already in block chain", "sendrawtransaction"));
    for (const i of tx.vin) {
      const c = this.coins.get(`${i.prevout.txid}:${i.prevout.vout}`);
      if (!c) throw new SendRawTransactionError(new RpcError(-25, "Missing inputs", "sendrawtransaction"));
      if (c.spentInMempool) throw new SendRawTransactionError(new RpcError(-26, "18: txn-mempool-conflict", "sendrawtransaction"));
    }
    const v = await this.verifyScripts(hex);
    if (!v.complete) throw new SendRawTransactionError(new RpcError(-26, "16: mandatory-script-verify-flag-failed", "sendrawtransaction"));
    for (const i of tx.vin) this.coins.get(`${i.prevout.txid}:${i.prevout.vout}`)!.spentInMempool = true;
    tx.vout.forEach((o, n) => this.addCoin(id, n, o.value, o.scriptPubKey, true));
    this.sent.push(hex);
    return id;
  }
}
