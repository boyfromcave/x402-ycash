// Where a local-key client finds its coins and its tip. The RPC source reads a node the agent
// trusts; a light-client source (lightwalletd GetAddressUtxos + GetAddressTokens) fits the same
// interface.
import { RPC_METHOD_NOT_FOUND, RpcError, yecToZat, type YcashRpc } from "../../node/index.js";
import { hexToBytes } from "../../tx/index.js";
import type { Coin } from "./coinSelection.js";
import { chainStateOf, type ChainState } from "./signer.js";

export interface UtxoSource {
  chainState(): Promise<ChainState>;
  /** Spendable coins paying `address`: confirmed, unspent also in the mempool, and holding no YED. */
  listCoins(address: string): Promise<Coin[]>;
}

export type UtxoSourceRpc = Pick<YcashRpc, "getBlockchainInfo" | "listUnspent" | "getTxOut" | "capabilities" | "call">;

export interface RpcUtxoSourceOptions {
  /**
   * Import each address watch-only on first use (`importaddress addr "" rescan`), so a node
   * that does not hold the key lists its coins. "rescan" also finds coins received before the
   * import. Default: no import (the address is already in the node's wallet).
   */
  importAddress?: boolean | "rescan";
}

/** One token record of `yed_listtokens` (plan Y-9; ycash-dd/src/rpc/yellowback.cpp:1185). */
interface TokenRow {
  txid: string;
  vout: number;
}

/**
 * Coins from `listunspent [address]`, each re-checked with `gettxout(…, true)` so a coin spent in
 * the mempool (the wallet race of X-F13) is never chosen. On a Yellowback node, `yed_listtokens`
 * names the YED-bearing outputs, which a YEC payment must not spend (rule 9Y); a stock node
 * cannot see token records, so there the caller must keep YED elsewhere.
 */
export class RpcUtxoSource implements UtxoSource {
  private readonly imported = new Set<string>();

  constructor(
    private readonly rpc: UtxoSourceRpc,
    private readonly options: RpcUtxoSourceOptions = {},
  ) {}

  async chainState(): Promise<ChainState> {
    return chainStateOf(await this.rpc.getBlockchainInfo());
  }

  async listCoins(address: string): Promise<Coin[]> {
    await this.ensureImported(address);
    const unspent = await this.rpc.listUnspent(1, 9_999_999, [address]);
    const tokens = await this.yedOutpoints(address);
    const coins: Coin[] = [];
    for (const u of unspent) {
      if (tokens.has(`${u.txid}:${u.vout}`)) continue;
      if (!(await this.rpc.getTxOut(u.txid, u.vout, true))) continue;
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

  private async ensureImported(address: string): Promise<void> {
    const mode = this.options.importAddress;
    if (!mode || this.imported.has(address)) return;
    await this.rpc.call("importaddress", [address, "", mode === "rescan"]);
    this.imported.add(address);
  }

  private async yedOutpoints(address: string): Promise<Set<string>> {
    if (!(await this.rpc.capabilities()).yellowback) return new Set();
    try {
      const rows = await this.rpc.call<TokenRow[]>("yed_listtokens", [[address]]);
      return new Set(rows.map((r) => `${r.txid}:${r.vout}`));
    } catch (e) {
      if (e instanceof RpcError && e.code === RPC_METHOD_NOT_FOUND) return new Set();
      throw e;
    }
  }
}
