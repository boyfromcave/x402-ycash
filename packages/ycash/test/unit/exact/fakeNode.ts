// An in-memory ycashd for the exact mechanism's unit tests: a UTXO set, a mempool, a tip, and a
// script verifier that checks P2PKH signatures with the SDK's own ZIP-243 code, so a corrupted
// signature fails rule 9 as it would on a node.
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { RpcError, SendRawTransactionError, type BlockchainInfo, type NodeCapabilities, type TxOutInfo, type VerifyScriptsResult, type YedValidation } from "../../../src/node/index.js";
import type { ExactFacilitatorRpc } from "../../../src/exact/index.js";
import type { ChainState, Coin, UtxoSource } from "../../../src/exact/index.js";
import {
  bytesToHex,
  encodeWif,
  hash160,
  p2pkhHash,
  p2pkhScript,
  parseScript,
  parseTx,
  pubkeyFromPriv,
  sighashV4,
  txid as txidOf,
  verifyInputSig,
  encodeAddress,
} from "../../../src/tx/index.js";

export const BRANCH_ID = 0x19bd2d2f;
export const NETWORK = "ycash:regtest" as const;

interface Utxo {
  value: bigint;
  script: Uint8Array;
  height: number;
}

export class FakeNode implements ExactFacilitatorRpc {
  chain = "regtest";
  tip = 300;
  yellowback = false;
  /** cents of YED each outpoint holds (Yellowback node only) */
  yedCents = new Map<string, number>();
  utxos = new Map<string, Utxo>();
  /** txid -> {hex, height (null = mempool)} */
  txs = new Map<string, { hex: string; height: number | null }>();
  calls: string[] = [];
  /** Makes the next sendrawtransaction throw this. */
  sendError: RpcError | undefined;

  private key(txid: string, n: number): string {
    return `${txid}:${n}`;
  }

  /** A confirmed coin paying `script`. */
  addCoin(value: bigint, script: Uint8Array, confirmations = 6): { txid: string; vout: number } {
    const txid = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    this.utxos.set(this.key(txid, 0), { value, script, height: this.tip - confirmations + 1 });
    return { txid, vout: 0 };
  }

  private spentInMempool(k: string): boolean {
    for (const t of this.txs.values()) {
      if (t.height !== null) continue;
      if (parseTx(t.hex).vin.some((i) => this.key(i.prevout.txid, i.prevout.vout) === k)) return true;
    }
    return false;
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    this.calls.push("getblockchaininfo");
    return { chain: this.chain, blocks: this.tip, headers: this.tip, bestblockhash: "", consensus: { chaintip: "19bd2d2f", nextblock: "19bd2d2f" }, upgrades: {} };
  }

  async getBlockCount(): Promise<number> {
    this.calls.push("getblockcount");
    return this.tip;
  }

  async getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null> {
    this.calls.push(`gettxout ${includeMempool}`);
    const k = this.key(txid, n);
    const u = this.utxos.get(k);
    if (u && u.height <= this.tip) {
      if (includeMempool && this.spentInMempool(k)) return null;
      return out(u, this.tip - u.height + 1);
    }
    // an output of a mempool tx
    const t = this.txs.get(txid);
    if (includeMempool && t && t.height === null) {
      const o = parseTx(t.hex).vout[n];
      if (o && !this.spentInMempool(k)) return out({ value: o.value, script: o.scriptPubKey }, 0);
    }
    return null;
  }

  async verifyScripts(hex: string): Promise<VerifyScriptsResult> {
    this.calls.push("signrawtransaction");
    const tx = parseTx(hex);
    const errors: VerifyScriptsResult["errors"] = [];
    tx.vin.forEach((input, i) => {
      const k = this.key(input.prevout.txid, input.prevout.vout);
      const u = this.utxos.get(k);
      const e = (error: string) => errors.push({ txid: input.prevout.txid, vout: input.prevout.vout, scriptSig: bytesToHex(input.scriptSig), sequence: input.sequence, error });
      if (!u) return e("Input not found or already spent");
      const chunks = parseScript(input.scriptSig);
      const sig = chunks[0]?.data;
      const pub = chunks[1]?.data;
      const pkh = p2pkhHash(u.script);
      if (!sig || !pub || !pkh || bytesToHex(hash160(pub)) !== bytesToHex(pkh)) return e("Operation not valid with the current stack size");
      const digest = sighashV4(tx, i, u.script, u.value, sig[sig.length - 1] as number, BRANCH_ID);
      if (!verifyInputSig(sig, digest, pub)) return e("Script evaluated without error but finished with a false/empty top stack element");
    });
    return { complete: errors.length === 0, errors };
  }

  async sendRawTransaction(hex: string): Promise<string> {
    this.calls.push("sendrawtransaction");
    if (this.sendError) {
      const e = this.sendError;
      this.sendError = undefined;
      throw e;
    }
    const id = txidOf(hex);
    if (this.txs.has(id)) return id;
    this.txs.set(id, { hex, height: null });
    return id;
  }

  async capabilities(): Promise<NodeCapabilities> {
    return { line: "v4", subversion: "/YcashCpp:4.5.0/", version: 4050050, yellowback: this.yellowback, chain: this.chain };
  }

  async yedValidateRawTransaction(hex: string): Promise<YedValidation> {
    this.calls.push("yed_validaterawtransaction");
    const tx = parseTx(hex);
    const yedIn = tx.vin.reduce((s, i) => s + (this.yedCents.get(this.key(i.prevout.txid, i.prevout.vout)) ?? 0), 0);
    return {
      valid: yedIn === 0, verdict: yedIn === 0 ? "OK" : "BURNED", type: yedIn === 0 ? "none" : "transfer", path: "", yedIn, yedOut: 0, burned: yedIn,
      feeZat: 0, payee: null, blockValid: true, wouldBeRejected: false, mempoolExpiryOk: true, unconfirmedInputs: [],
    };
  }

  /** Mines the mempool into a block at tip + 1. */
  mine(n = 1): void {
    for (let b = 0; b < n; b++) {
      this.tip++;
      for (const [id, t] of this.txs) {
        if (t.height !== null) continue;
        t.height = this.tip;
        const tx = parseTx(t.hex);
        for (const i of tx.vin) this.utxos.delete(this.key(i.prevout.txid, i.prevout.vout));
        tx.vout.forEach((o, n) => this.utxos.set(this.key(id, n), { value: o.value, script: o.scriptPubKey, height: this.tip }));
      }
    }
  }

  /** Puts a tx in the mempool directly (another wallet's spend). */
  acceptToMempool(hex: string): void {
    this.txs.set(txidOf(hex), { hex, height: null });
  }

  sendErrorOf(code: number, message: string): SendRawTransactionError {
    return new SendRawTransactionError(new RpcError(code, message, "sendrawtransaction"));
  }
}

function out(u: { value: bigint; script: Uint8Array }, confirmations: number): TxOutInfo {
  return {
    bestblock: "",
    confirmations,
    value: Number(u.value) / 1e8,
    scriptPubKey: { asm: "", hex: bytesToHex(u.script), type: "pubkeyhash" },
    version: 4,
    coinbase: false,
  };
}

/** A UtxoSource over the fake node: the coins of one script. */
export class FakeUtxoSource implements UtxoSource {
  constructor(private readonly node: FakeNode) {}
  async chainState(): Promise<ChainState> {
    return { chain: this.node.chain, height: this.node.tip, branchId: BRANCH_ID };
  }
  async listCoins(address: string): Promise<Coin[]> {
    void address;
    const coins: Coin[] = [];
    for (const [k, u] of this.node.utxos) {
      const [txid, vout] = k.split(":") as [string, string];
      if ((await this.node.getTxOut(txid, Number(vout), true)) === null) continue;
      coins.push({ txid, vout: Number(vout), value: u.value, scriptPubKey: u.script, confirmations: this.node.tip - u.height + 1 });
    }
    return coins;
  }
}

/** A deterministic regtest key. */
export function testKey(seed: number): { priv: Uint8Array; wif: string; script: Uint8Array; address: string } {
  const priv = new Uint8Array(32);
  priv[31] = seed;
  priv[0] = 0x11;
  const pub = pubkeyFromPriv(priv);
  return { priv, wif: encodeWif(priv, NETWORK), script: p2pkhScript(hash160(pub)), address: encodeAddress(NETWORK, "p2pkh", hash160(pub)) };
}

export function requirements(payTo: string, amount = "250000", extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: "YEC",
    amount,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "transparent", areFeesSponsored: false, confirmationPolicy: { confirmations: -1 }, ...extra },
  };
}

export function paymentPayload(req: PaymentRequirements, transaction: string): PaymentPayload {
  return { x402Version: 2, accepted: structuredClone(req), payload: { transaction } };
}
