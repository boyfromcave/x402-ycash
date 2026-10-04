// Signer backend (b): the keys stay in a node wallet. `listunspent` + `createrawtransaction`
// (with the expiry) + `signrawtransaction`, which both lines have (plan §5.6).
import { RPC_METHOD_NOT_FOUND, RpcError, yecToZat, type YcashRpc } from "../../node/index.js";
import { addressToScript, hexToBytes, txid, type OutPoint } from "../../tx/index.js";
import { selectCoins, type Coin } from "./coinSelection.js";
import { chainStateOf, type ChainState, type PaymentOrder, type SignedPayment, type YcashClientSigner } from "./signer.js";

export type RpcWalletSignerRpc = Pick<
  YcashRpc,
  "getBlockchainInfo" | "listUnspent" | "getTxOut" | "createRawTransaction" | "signRawTransactionWithWallet" | "capabilities" | "call"
>;

export interface RpcWalletSignerOptions {
  /** Attempts when a just-spent coin is selected (X-F13). Default 3. */
  retries?: number;
  /** Where change goes. Default: a fresh `getrawchangeaddress`. */
  changeAddress?: string;
}

/** `yed_listunspent` row (ycash-dd/src/rpc/yellowbackwallet.cpp:699). */
interface YedCoinRow {
  txid: string;
  vout: number;
}

/**
 * The wallet selects nothing itself: this signer picks the coins (skipping YED-bearing ones on a
 * Yellowback node), and `lockunspent`s them so neither the wallet nor a concurrent payment
 * spends them before the facilitator broadcasts. Right after a block or a broadcast the wallet
 * may still list a just-spent coin (X-F13); each candidate is re-checked with `gettxout(…, true)`
 * and a failed signing is retried without the offending coins.
 */
export class RpcWalletSigner implements YcashClientSigner {
  private readonly retries: number;

  constructor(
    private readonly rpc: RpcWalletSignerRpc,
    private readonly options: RpcWalletSignerOptions = {},
  ) {
    this.retries = options.retries ?? 3;
  }

  async chainState(): Promise<ChainState> {
    return chainStateOf(await this.rpc.getBlockchainInfo());
  }

  async signPayment(order: PaymentOrder): Promise<SignedPayment> {
    const payToScript = addressToScript(order.payTo, order.network);
    const change = this.options.changeAddress ?? (await this.rpc.call<string>("getrawchangeaddress"));
    const changeScript = addressToScript(change, order.network);
    const excluded = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const coins = (await this.candidates()).filter((c) => !excluded.has(key(c)));
      const sel = selectCoins(coins, order.amount, payToScript, changeScript);
      const inputs: OutPoint[] = sel.coins.map((c) => ({ txid: c.txid, vout: c.vout }));
      await this.lock(inputs);
      try {
        const outputs: Record<string, bigint> = { [order.payTo]: order.amount };
        if (sel.change > 0n) outputs[change] = sel.change;
        const unsigned = await this.rpc.createRawTransaction(inputs, outputs, 0, order.expiryHeight);
        const signed = await this.rpc.signRawTransactionWithWallet(unsigned);
        // signrawtransaction signs SIGHASH_ALL by default, the hash type the binding requires.
        if (signed.complete) return { hex: signed.hex, txid: txid(signed.hex), inputs };
        for (const e of signed.errors ?? []) excluded.add(`${e.txid}:${e.vout}`);
        lastError = new Error(`signrawtransaction incomplete: ${(signed.errors ?? []).map((e) => e.error).join("; ")}`);
      } catch (e) {
        lastError = e;
      }
      await this.unlock(inputs);
      for (const c of sel.coins) if (!(await this.rpc.getTxOut(c.txid, c.vout, true))) excluded.add(key(c));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Gives back the coins of a payment that will never be settled (the wallet unlocks on restart too). */
  async release(inputs: readonly OutPoint[]): Promise<void> {
    await this.unlock(inputs);
  }

  private async candidates(): Promise<Coin[]> {
    // listunspent omits locked coins, so a coin held by a pending payment is not offered again.
    const unspent = (await this.rpc.listUnspent(1)).filter((u) => u.spendable);
    const yed = await this.yedOutpoints();
    const coins: Coin[] = [];
    for (const u of unspent) {
      if (yed.has(`${u.txid}:${u.vout}`)) continue;
      if (!(await this.rpc.getTxOut(u.txid, u.vout, true))) continue; // X-F13
      coins.push({
        txid: u.txid,
        vout: u.vout,
        value: u.amountZat !== undefined ? BigInt(u.amountZat) : yecToZat(u.amount),
        scriptPubKey: hexToBytes(u.scriptPubKey),
        confirmations: u.confirmations,
      });
    }
    return coins;
  }

  private async yedOutpoints(): Promise<Set<string>> {
    if (!(await this.rpc.capabilities()).yellowback) return new Set();
    try {
      return new Set((await this.rpc.call<YedCoinRow[]>("yed_listunspent")).map((r) => `${r.txid}:${r.vout}`));
    } catch (e) {
      if (e instanceof RpcError && e.code === RPC_METHOD_NOT_FOUND) return new Set(); // no Yellowback wallet
      throw e;
    }
  }

  private async lock(inputs: readonly OutPoint[]): Promise<void> {
    if (inputs.length > 0) await this.rpc.call("lockunspent", [false, inputs]);
  }

  private async unlock(inputs: readonly OutPoint[]): Promise<void> {
    if (inputs.length > 0) await this.rpc.call("lockunspent", [true, inputs]).catch(() => undefined);
  }
}

const key = (c: { txid: string; vout: number }): string => `${c.txid}:${c.vout}`;
