// What a light client reads of the chain through lightwalletd: the tip and branch id it signs at,
// whether an output is still there, and a broadcast path. It fits the batch client's ClientChain,
// so a channel's status, funding-expiry check and refund work without a node RPC.
import type { ClientChain } from "../batch/client/scheme.js";
import { zatToYecString } from "../node/amount.js";
import type { BlockchainInfo, TxOutInfo } from "../node/types.js";
import { bytesToHex, decodeAddress, encodeAddress, p2pkhHash, parseTx } from "../tx/index.js";
import type { ChainState } from "../exact/client/signer.js";
import type { LwdClient } from "./client.js";

/**
 * Recovers the transparent address an output pays, since lightwalletd's UTXO index is keyed by address.
 *
 * @param script - The output's scriptPubKey.
 * @param chain - The node's chain name (`main`, `test` or `regtest`).
 * @returns The P2PKH or P2SH address, or undefined for any other script.
 */
function addressOf(script: Uint8Array, chain: string): string | undefined {
  const network = chain === "main" ? "ycash:mainnet" : chain === "test" ? "ycash:testnet" : "ycash:regtest";
  const pkh = p2pkhHash(script);
  if (pkh) return encodeAddress(network, "p2pkh", pkh);
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return encodeAddress(network, "p2sh", script.slice(2, 22));
  return undefined;
}

/**
 * A {@link ClientChain} backed by lightwalletd's gRPC services instead of a node's JSON-RPC.
 */
export class LwdChain implements ClientChain {
  /**
   * Wraps a lightwalletd client.
   *
   * @param lwd - The connected lightwalletd client.
   */
  constructor(readonly lwd: LwdClient) {}

  /**
   * Tip and branch id from `GetLightdInfo`. lightwalletd reports the tip's branch id
   * (`consensus.chaintip`, lightwalletd-dd/common/common.go:212), not the next block's: the two
   * differ only on the block before a network upgrade activates, where a signature made now would
   * be refused. lightwalletd offers no `nextblock`, so the light path signs at the tip's branch.
   *
   * @returns The chain name, tip height and consensus branch id.
   */
  async chainState(): Promise<ChainState> {
    const info = await this.lwd.getLightdInfo();
    return { chain: info.chainName, height: Number(info.blockHeight), branchId: parseInt(info.consensusBranchId, 16) >>> 0 };
  }

  /**
   * The fields of `getblockchaininfo` the clients read (chain, blocks, consensus), from GetLightdInfo.
   *
   * @returns Chain name, tip height, and the tip's branch id as both `chaintip` and `nextblock`.
   */
  async getBlockchainInfo(): Promise<Pick<BlockchainInfo, "chain" | "blocks" | "consensus">> {
    const info = await this.lwd.getLightdInfo();
    const branch = info.consensusBranchId.toLowerCase();
    return { chain: info.chainName, blocks: Number(info.blockHeight), consensus: { chaintip: branch, nextblock: branch } };
  }

  /**
   * `gettxout` from what lightwalletd can see: the transaction (GetTransaction), then, once it is in
   * a block, whether its output is still in the address index (GetAddressUtxos). A mempool output
   * counts only with `includeMempool`. **Gap:** a confirmed output spent by a mempool transaction
   * still reads as unspent, since neither the address index nor GetMempoolTx (Sapling-only) shows
   * transparent mempool spends.
   *
   * @param txid - The transaction id, display-order hex.
   * @param n - The output index.
   * @param includeMempool - Whether an output of an unconfirmed transaction counts.
   * @returns The output in `gettxout` shape, or null when missing, spent, or not indexable.
   */
  async getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null> {
    const found = await this.lwd.getTransaction(txid);
    if (!found) return null;
    const out = parseTx(found.hex).vout[n];
    if (!out) return null;
    const info = await this.lwd.getLightdInfo();
    const tip = Number(info.blockHeight);
    const address = addressOf(out.scriptPubKey, info.chainName);
    const view = (confirmations: number): TxOutInfo => ({
      bestblock: "",
      confirmations,
      value: Number(zatToYecString(out.value)),
      scriptPubKey: { asm: "", hex: bytesToHex(out.scriptPubKey), type: address ? (decodeAddress(address).kind === "p2sh" ? "scripthash" : "pubkeyhash") : "nonstandard", ...(address ? { addresses: [address] } : {}) },
      version: 4,
      coinbase: false,
    });
    if (found.height === undefined) return includeMempool ? view(0) : null;
    if (!address) return null; // not in the address index: no way to tell spent from unspent
    const live = (await this.lwd.getAddressUtxos([address], found.height)).some((u) => u.txid === txid && u.vout === n);
    return live ? view(tip - found.height + 1) : null;
  }

  /**
   * Broadcast through lightwalletd's node; refusals are SendRawTransactionError, as over RPC.
   *
   * @param hex - The signed transaction, hex.
   * @returns The txid the node accepted.
   */
  sendRawTransaction(hex: string): Promise<string> {
    return this.lwd.sendTransaction(hex);
  }

  /**
   * `getrawtransaction txid` (hex), for a caller that inspects what it broadcast.
   *
   * @param txid - The transaction id, display-order hex.
   * @returns The raw transaction, hex.
   * @throws Error when lightwalletd's node does not know the transaction.
   */
  async getRawTransaction(txid: string): Promise<string> {
    const found = await this.lwd.getTransaction(txid);
    if (!found) throw new Error(`lightwalletd's node knows no transaction ${txid}`);
    return found.hex;
  }
}
