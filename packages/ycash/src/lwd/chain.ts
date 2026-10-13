// What a light client reads of the chain through lightwalletd: the tip and branch id it signs at,
// whether an output is still there, and a broadcast path. It fits the batch client's ClientChain,
// so a channel's status, funding-expiry check and refund work without a node RPC.
import type { ClientChain } from "../batch/client/scheme.js";
import { zatToYecString } from "../node/amount.js";
import { falconHeightOf } from "../channel/falcon.js";
import type { BlockchainInfo, TxOutInfo, YedInfo } from "../node/types.js";
import { pqpkhKeyId } from "../pq/script.js";
import { bytesToHex, decodeAddress, encodeAddress, encodePQAddress, networkFeesOf, p2pkhHash, parseTx } from "../tx/index.js";
import type { ChainState } from "../exact/client/signer.js";
import { LwdError, type LwdClient } from "./client.js";
import type { YedUpgradeMsg, YellowbackInfoMsg, YellowbackNetworkRateMsg } from "./types.js";

/** The node's GetTxnOutputType names of the kinds addressOf returns. */
const TYPE_OF: Record<string, string> = { p2pkh: "pubkeyhash", p2sh: "scripthash", pq: "pqpubkeyhash" };

/**
 * Recovers the transparent address an output pays, since lightwalletd's UTXO index is keyed by address.
 *
 * @param script - The output's scriptPubKey.
 * @param chain - The node's chain name (`main`, `test` or `regtest`).
 * @returns The P2PKH, P2SH or post-quantum (`sq…`) address, or undefined for any other script.
 */
function addressOf(script: Uint8Array, chain: string): string | undefined {
  const network = chain === "main" ? "ycash:mainnet" : chain === "test" ? "ycash:testnet" : "ycash:regtest";
  const pkh = p2pkhHash(script);
  if (pkh) return encodeAddress(network, "p2pkh", pkh);
  const pq = pqpkhKeyId(script);
  if (pq) return encodePQAddress(network, "pq", pq);
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return encodeAddress(network, "p2sh", script.slice(2, 22));
  return undefined;
}

/**
 * GetYellowbackInfo's answer in `yed_getinfo`'s JSON shape, for the fields the SDK reads: `rpcversion`,
 * `params.pq` (rpcversion 7) and `params.fees.network` (rpcversion 8). The server's messages carry the
 * node's JSON names (lightwalletd-dd walletrpc/yellowback.proto), so only the 64-bit integers, decoded
 * as decimal strings, become numbers again; a message the server left out stays out.
 *
 * @param m - The decoded GetYellowbackInfo reply.
 * @returns The `yed_getinfo` subset that networkFeesOf and falconHeightOf read.
 */
function yedInfoOf(m: YellowbackInfoMsg): YedInfo {
  const rate = (r: YellowbackNetworkRateMsg | null) => (r ? { zatPerKB: Number(r.zatPerKB), maxTxFeeZat: Number(r.maxTxFeeZat) } : undefined);
  const pq = m.params?.pq;
  const n = m.params?.fees?.network;
  return {
    rpcversion: Number(m.rpcversion),
    params: {
      ...(pq ? { pq: { schemes: pq.schemes.map(Number), falconActive: pq.falconActive, falconHeight: Number(pq.falconHeight), feeRateZatPerKB: Number(pq.feeRateZatPerKB) } } : {}),
      ...(n
        ? {
            fees: {
              network: {
                priceMicroUsd: Number(n.priceMicroUsd),
                priceSource: n.priceSource,
                plain: rate(n.plain),
                yellowback: rate(n.yellowback),
                flatZat: Number(n.flatZat),
                maxTxFeeZat: Number(n.maxTxFeeZat),
              },
            },
          }
        : {}),
    },
  };
}

/**
 * GetChainInfo's upgrade list in `getblockchaininfo.upgrades` shape (keyed by lowercase branch id).
 *
 * @param list - `YedChainInfo.upgrades`.
 * @returns The map, or undefined when the server sent none (an older lightwalletd).
 */
function upgradesOf(list: YedUpgradeMsg[] | undefined): BlockchainInfo["upgrades"] | undefined {
  if (!list || list.length === 0) return undefined;
  const out: BlockchainInfo["upgrades"] = {};
  for (const u of list) out[u.branchId.toLowerCase()] = { name: u.name, activationheight: Number(u.activationHeight), status: u.status };
  return out;
}

/** The tip and both consensus branch ids, lowercase hex; and the node's upgrade list when GetChainInfo carries it. */
interface Branches {
  chain: string;
  height: number;
  chaintip: string;
  nextblock: string;
  upgrades?: BlockchainInfo["upgrades"];
}

/**
 * A {@link ClientChain} backed by lightwalletd's gRPC services instead of a node's JSON-RPC.
 */
export class LwdChain implements ClientChain {
  /** The last GetChainInfo answer: the next block's branch id is a function of the tip height. */
  private nextByHeight: Branches | undefined;
  /** The server answered GetChainInfo UNIMPLEMENTED (no YellowbackStreamer, or older than 0b3448e). */
  private noChainInfo = false;
  /** The last GetYellowbackInfo answer, by the tip height it was asked at (the fee rates follow the tip's price). */
  private infoByHeight: { height: number; info: YedInfo } | undefined;
  /** The server answered GetYellowbackInfo UNIMPLEMENTED (started without --yellowback). */
  private noYellowbackInfo = false;

  /**
   * Wraps a lightwalletd client.
   *
   * @param lwd - The connected lightwalletd client.
   */
  constructor(readonly lwd: LwdClient) {}

  /**
   * Tip and the branch id to sign under: the next block's (see {@link branches}); and, as the RPC
   * path's chainStateWithFalcon reads them from `yed_getinfo`, the Falcon height and the network fee
   * rates (`params.fees.network`, rpcversion 8) from GetYellowbackInfo, so a YED payment through
   * lightwalletd pays the Yellowback rate by size, not the S-6 floor.
   *
   * @returns The chain name, tip height and consensus branch id, plus `falconHeight` and `networkFees`
   * when the server reports them.
   */
  async chainState(): Promise<ChainState> {
    const b = await this.branches();
    const st: ChainState = { chain: b.chain, height: b.height, branchId: parseInt(b.nextblock, 16) >>> 0 };
    let info: YedInfo;
    try {
      info = await this.yedInfoAt(b.height);
    } catch {
      return st; // no YellowbackStreamer (or a refused call): the S-6 floor and the network's Falcon default, as before
    }
    const falconHeight = falconHeightOf(info);
    const networkFees = networkFeesOf(info);
    return { ...st, ...(falconHeight !== undefined ? { falconHeight } : {}), ...(networkFees ? { networkFees } : {}) };
  }

  /**
   * `yed_getinfo` through `YellowbackStreamer.GetYellowbackInfo`, as the RPC path reads it
   * (readNetworkFees, readFalconHeight): `rpcversion`, `params.pq` and `params.fees.network` only.
   * GetYellowbackInfo is rate-limited with the rest of YellowbackStreamer, so it is asked once per
   * tip height (GetLightdInfo, not limited, gives the height); the rates change with the price, which
   * changes only with a block.
   *
   * @returns The `yed_getinfo` subset.
   * @throws LwdError from the server; `unimplemented` (remembered) without YellowbackStreamer.
   */
  async yedGetInfo(): Promise<YedInfo> {
    return this.yedInfoAt(Number((await this.lwd.getLightdInfo()).blockHeight));
  }

  /**
   * The fields of `getblockchaininfo` the clients read (chain, blocks, consensus, and `upgrades` when
   * the server's GetChainInfo carries them: the batch client bounds a channel by the next activation
   * height, audit 06/X-1).
   *
   * @returns Chain name, tip height, and the chaintip and next-block branch ids (both the tip's on a
   * server without GetChainInfo), with `upgrades` keyed by branch id when known.
   */
  async getBlockchainInfo(): Promise<Pick<BlockchainInfo, "chain" | "blocks" | "consensus"> & Partial<Pick<BlockchainInfo, "upgrades">>> {
    const b = await this.branches();
    return { chain: b.chain, blocks: b.height, consensus: { chaintip: b.chaintip, nextblock: b.nextblock }, ...(b.upgrades ? { upgrades: b.upgrades } : {}) };
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
      scriptPubKey: { asm: "", hex: bytesToHex(out.scriptPubKey), type: address ? (TYPE_OF[decodeAddress(address).kind] ?? "nonstandard") : "nonstandard", ...(address ? { addresses: [address] } : {}) },
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

  /**
   * Tip, chaintip branch id and the next block's branch id. `YellowbackStreamer.GetChainInfo`
   * (lightwalletd-dd 0b3448e+) carries the node's `consensus.nextblock`, which a signature for the
   * next block must commit to (ZIP-243): it differs from the tip's on the block before a network
   * upgrade activates (Vault, `6d5b7a31`, among them). GetChainInfo is rate-limited with the rest of
   * YellowbackStreamer (lightwalletd-dd frontend/yellowback_ratelimit.go) and the next block's branch
   * depends on the height alone, so it is asked once per tip height: GetLightdInfo (not limited)
   * gives the height each time. A server without it answers UNIMPLEMENTED, once; then
   * `GetLightdInfo`'s `consensusBranchId` is the tip's (`consensus.chaintip`,
   * lightwalletd-dd/common/common.go:212), and a payment signed on that one block is refused.
   *
   * @returns Chain name, tip height, and both branch ids as lowercase hex.
   */
  private async branches(): Promise<Branches> {
    const info = await this.lwd.getLightdInfo();
    const height = Number(info.blockHeight);
    const branch = info.consensusBranchId.toLowerCase();
    if (this.nextByHeight?.height === height) return this.nextByHeight;
    if (!this.noChainInfo) {
      try {
        const c = await this.lwd.getChainInfo();
        const upgrades = upgradesOf(c.upgrades);
        const b: Branches = {
          chain: c.chainName, height: Number(c.blockHeight), chaintip: c.consensusBranchId.toLowerCase(), nextblock: c.nextBlockBranchId.toLowerCase(),
          ...(upgrades ? { upgrades } : {}),
        };
        this.nextByHeight = b;
        return b;
      } catch (e) {
        if (!(e instanceof LwdError && e.unimplemented)) throw e;
        this.noChainInfo = true;
      }
    }
    return { chain: info.chainName, height, chaintip: branch, nextblock: branch };
  }

  /**
   * GetYellowbackInfo at `height`, cached until the tip moves.
   *
   * @param height - The tip height the caller just read.
   * @returns The `yed_getinfo` subset.
   */
  private async yedInfoAt(height: number): Promise<YedInfo> {
    if (this.infoByHeight?.height === height) return this.infoByHeight.info;
    if (this.noYellowbackInfo) throw new Error("lightwalletd serves no YellowbackStreamer.GetYellowbackInfo");
    try {
      const info = yedInfoOf(await this.lwd.getYellowbackInfo());
      this.infoByHeight = { height, info };
      return info;
    } catch (e) {
      if (e instanceof LwdError && e.unimplemented) this.noYellowbackInfo = true;
      throw e;
    }
  }
}
