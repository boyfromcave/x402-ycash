// Signer backend (b): the keys stay in a node wallet. `listunspent` + `createrawtransaction`
// (with the expiry) + `signrawtransaction`, which both lines have (plan §5.6).
import { RPC_METHOD_NOT_FOUND, RpcError, yecToZat, type YcashRpc } from "../../node/index.js";
import { addressToScript, hexToBytes, serializeTxHex, txid, type OutPoint } from "../../tx/index.js";
import { buildYedTransfer, selectTokenCoins, type TokenCoin } from "../../yed/index.js";
import { selectCoins, type Coin } from "./coinSelection.js";
import { chainStateOf, type ChainState, type PaymentOrder, type SignedPayment, type YcashClientSigner, type YedPaymentOrder } from "./signer.js";

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

/** `yed_listunspent` row (ycash-dd/src/rpc/yellowbackwallet.cpp:699-718). */
interface YedCoinRow {
  txid: string;
  vout: number;
  cents: number;
  valueZat: number;
  address: string;
  confirmations: number;
  spentUnconfirmed: boolean;
  locked: boolean;
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
  /**
   * YED outputs in signed, not yet settled payments, until their expiry. The Yellowback wallet keeps
   * every YED output `lockunspent`-locked against plain YEC spends (ycash-dd/src/yellowback/wallet.cpp:404-410,
   * 450-465), so a lock cannot mark one as taken: the signer tracks its own.
   */
  private readonly reservedTokens = new Map<string, number>();

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

  /**
   * A YED payment from the wallet's confirmed YED outputs (`yed_listunspent`), YEC fee coins from
   * its plain transparent coins. The SDK serialises the TRANSFER (createrawtransaction cannot write
   * an OP_RETURN, plan R-7) and the wallet signs it (`signrawtransaction hex`).
   */
  async signYedPayment(order: YedPaymentOrder): Promise<SignedPayment> {
    if (!(await this.rpc.capabilities()).yellowback) throw new Error("paying YED needs a Yellowback node wallet (-experimentalfeatures -yellowback)");
    const payToScript = addressToScript(order.payTo, order.network);
    const yecChange = addressToScript(this.options.changeAddress ?? (await this.rpc.call<string>("getrawchangeaddress")), order.network);
    const yedChange = addressToScript(await this.rpc.call<string>("yed_getnewaddress"), order.network);
    const excluded = new Set<string>();
    for (const [k, expiry] of this.reservedTokens) if (expiry < order.tip) this.reservedTokens.delete(k);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const tokens = (await this.tokenCandidates()).filter((t) => !excluded.has(key(t.outpoint)) && !this.reservedTokens.has(key(t.outpoint)));
      const yec = (await this.candidates()).filter((c) => c.confirmations >= 1 && !excluded.has(key(c)));
      const sel = selectTokenCoins(tokens, order.amountCents);
      const built = buildYedTransfer({
        recipients: [{ scriptPubKey: payToScript, cents: order.amountCents }],
        tokens: sel.coins,
        yecCoins: yec.map((c) => ({ outpoint: { txid: c.txid, vout: c.vout }, value: c.value, scriptPubKey: c.scriptPubKey })),
        yedChangeScript: yedChange,
        yecChangeScript: yecChange,
        expiryHeight: order.expiryHeight,
      });
      const inputs: OutPoint[] = built.inputs.map((c) => c.outpoint);
      await this.lock(inputs);
      try {
        const signed = await this.rpc.signRawTransactionWithWallet(serializeTxHex(built.tx));
        if (signed.complete) {
          for (const t of sel.coins) this.reservedTokens.set(key(t.outpoint), order.expiryHeight);
          return { hex: signed.hex, txid: txid(signed.hex), inputs };
        }
        for (const e of signed.errors ?? []) excluded.add(`${e.txid}:${e.vout}`);
        lastError = new Error(`signrawtransaction incomplete: ${(signed.errors ?? []).map((e) => e.error).join("; ")}`);
      } catch (e) {
        lastError = e;
      }
      await this.unlock(inputs);
      for (const o of inputs) if (!(await this.rpc.getTxOut(o.txid, o.vout, true))) excluded.add(key(o));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Gives back the coins of a payment that will never be settled (the wallet unlocks on restart too). */
  async release(inputs: readonly OutPoint[]): Promise<void> {
    await this.unlock(inputs);
  }

  private async candidates(): Promise<Coin[]> {
    // listunspent omits locked coins, so a coin held by a pending payment is not offered again.
    // Coinbase outputs are left out: outside regtest, consensus makes them go to the shielded pool first.
    const unspent = (await this.rpc.listUnspent(1)).filter((u) => u.spendable && !u.generated);
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

  /**
   * The wallet's spendable YED outputs: confirmed and not spent in the mempool. `locked` is not a
   * filter: the Yellowback wallet locks every YED output it holds.
   */
  private async tokenCandidates(): Promise<TokenCoin[]> {
    const rows = await this.rpc.call<YedCoinRow[]>("yed_listunspent");
    const tokens: TokenCoin[] = [];
    for (const r of rows) {
      if (r.spentUnconfirmed || r.confirmations < 1) continue;
      if (!(await this.rpc.getTxOut(r.txid, r.vout, true))) continue; // X-F13
      tokens.push({ outpoint: { txid: r.txid, vout: r.vout }, cents: r.cents, value: BigInt(r.valueZat), scriptPubKey: addressToScript(r.address) });
    }
    return tokens;
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
