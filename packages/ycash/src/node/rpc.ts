import { readFileSync } from "node:fs";
import { zatToYecString } from "./amount.js";
import { RPC_METHOD_NOT_FOUND, RpcError, SendRawTransactionError } from "./errors.js";
import { RpcTransport, stripUserinfo, type CallOptions, type RpcConfig } from "./transport.js";
import type {
  BlockchainInfo,
  DecodedTransaction,
  NetworkInfo,
  NodeCapabilities,
  NodeLine,
  OperationResult,
  RawTxInput,
  SignResult,
  TxOutInfo,
  UnspentOutput,
  VerifyScriptsResult,
  YedInfo,
  YedPayload,
  YedPrice,
  YedValidation,
  ZReceived,
  ZRecipient,
} from "./types.js";

/** One node's entry in the devnet's `devnet.json` (`rpc.<n>`). */
interface DevnetRpcEntry {
  url: string;
  port: number;
  user: string;
  password: string;
}

export interface ZSendManyOptions {
  minconf?: number;
  /** zatoshis; omitted lets the node pick its default (6.21.0: the ZIP-317 conventional fee). */
  fee?: bigint;
  /** 6.21.0 only (`z_sendmany`'s 5th argument), e.g. "AllowRevealedSenders". */
  privacyPolicy?: string;
  /** How long to poll `z_getoperationresult`, milliseconds (default 120 s). */
  timeoutMs?: number;
}

/**
 * A typed ycashd JSON-RPC client for both node lines (v4.5.0 `ycash-dd`, 6.21.0 `ycash6`). It wraps
 * exactly the RPCs the x402 facilitator, server and client use; anything else goes through `call`.
 */
export class YcashRpc {
  private readonly transport: RpcTransport;
  private capabilitiesPromise: Promise<NodeCapabilities> | undefined;

  /**
   * Creates a client over one JSON-RPC endpoint; nothing is sent until the first call.
   *
   * @param config - URL, credentials (password or cookie file) and default timeout.
   */
  constructor(config: RpcConfig) {
    this.transport = new RpcTransport(config);
  }

  /**
   * The endpoint this client calls.
   *
   * @returns The endpoint URL, without credentials.
   */
  get url(): string {
    return this.transport.url;
  }

  /**
   * A node of a Yellowback devnet. The URL in `devnet.json` carries the credentials as userinfo; they
   * are stripped and sent from the `user`/`password` fields as UTF-8 basic auth.
   *
   * @param path - Path to the devnet's `devnet.json`.
   * @param nodeIndex - The node's index under `rpc`.
   * @param opts - Client options.
   * @param opts.timeoutMs - Per-call timeout, milliseconds.
   * @returns A client for that node.
   * @throws Error when the file has no entry for `nodeIndex`.
   */
  static fromDevnetJson(path: string, nodeIndex: number, opts: { timeoutMs?: number } = {}): YcashRpc {
    const state = JSON.parse(readFileSync(path, "utf8")) as { rpc?: Record<string, DevnetRpcEntry> };
    const entry = state.rpc?.[String(nodeIndex)];
    if (!entry) throw new Error(`${path} has no rpc.${nodeIndex}`);
    return new YcashRpc({ url: stripUserinfo(entry.url).url, user: entry.user, password: entry.password, ...opts });
  }

  /**
   * Calls any RPC the typed wrappers do not cover.
   *
   * @param method - The RPC method name.
   * @param params - Positional parameters.
   * @param opts - Per-call timeout override.
   * @returns The call's `result`.
   */
  call<T>(method: string, params: readonly unknown[] = [], opts?: CallOptions): Promise<T> {
    return this.transport.call<T>(method, params, opts);
  }

  // ------------------------------------------------------------------ capabilities

  /**
   * Detected once per client: which line, and whether the Yellowback RPCs exist. A failed probe is
   * not cached, so the next call retries.
   *
   * @returns The node's line, version, chain and Yellowback support.
   */
  capabilities(): Promise<NodeCapabilities> {
    this.capabilitiesPromise ??= this.detect().catch((e: unknown) => {
      this.capabilitiesPromise = undefined; // a transient failure must not stick
      throw e;
    });
    return this.capabilitiesPromise;
  }

  // ------------------------------------------------------------------ chain

  /**
   * `getnetworkinfo`.
   *
   * @returns The node's version and subversion, among other fields.
   */
  getNetworkInfo(): Promise<NetworkInfo> {
    return this.call("getnetworkinfo");
  }

  /**
   * `getblockchaininfo`.
   *
   * @returns Chain name, height and consensus branch ids, among other fields.
   */
  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.call("getblockchaininfo");
  }

  /**
   * `getblockcount`.
   *
   * @returns The height of the node's active tip.
   */
  getBlockCount(): Promise<number> {
    return this.call("getblockcount");
  }

  /**
   * `getrawmempool`.
   *
   * @returns The txids in the node's mempool, display-order hex.
   */
  getRawMempool(): Promise<string[]> {
    return this.call("getrawmempool");
  }

  /**
   * `gettxout`: whether an output is unspent.
   *
   * @param txid - The transaction id, display-order hex.
   * @param n - The output index.
   * @param includeMempool - Also see mempool outputs, and treat outputs spent by a mempool tx as spent.
   * @returns The output, or null when it is spent, unknown, or (with includeMempool) spent by a mempool tx.
   */
  getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null> {
    return this.call("gettxout", [txid, n, includeMempool]);
  }

  /**
   * `decoderawtransaction`.
   *
   * @param hex - The serialized transaction.
   * @returns The node's decoding of it.
   */
  decodeRawTransaction(hex: string): Promise<DecodedTransaction> {
    return this.call("decoderawtransaction", [hex]);
  }

  /**
   * Script verification on any node, wallet or not: `signrawtransaction hex [] []` signs nothing
   * (empty prevtxs, empty keys) and runs VerifyScript on every input
   * (`ycash-dd/src/rpc/rawtransaction.cpp:1069-1079`, `ycash6` `:1226-1231`).
   *
   * @param hex - The signed transaction.
   * @returns Whether every input's script verifies, and the per-input errors.
   */
  async verifyScripts(hex: string): Promise<VerifyScriptsResult> {
    const r = await this.call<SignResult>("signrawtransaction", [hex, [], []]);
    return { complete: r.complete, errors: r.errors ?? [] };
  }

  /**
   * Relay a signed tx. A resubmission of a tx already in the mempool returns its txid with no
   * error, so callers deduplicate by txid themselves.
   *
   * @param hex - The signed transaction.
   * @returns The txid, display-order hex.
   * @throws SendRawTransactionError (with a `kind`) when the node refuses it; RpcError on a transport failure.
   */
  async sendRawTransaction(hex: string): Promise<string> {
    try {
      return await this.call<string>("sendrawtransaction", [hex]);
    } catch (e) {
      if (e instanceof RpcError && !e.transport) throw new SendRawTransactionError(e);
      throw e;
    }
  }

  // ------------------------------------------------------------------ Yellowback (YED)

  /**
   * `yed_validaterawtransaction`: the Yellowback overlay's verdict on a transaction at the tip.
   *
   * @param hex - The serialized transaction.
   * @returns The overlay's validation result.
   */
  yedValidateRawTransaction(hex: string): Promise<YedValidation> {
    return this.call("yed_validaterawtransaction", [hex]);
  }

  /**
   * `yed_decodepayload`: decodes the transaction's Yellowback OP_RETURN payload.
   *
   * @param hex - The serialized transaction.
   * @returns The decoded payload, with `valid` false when there is none or it is malformed.
   */
  yedDecodePayload(hex: string): Promise<YedPayload> {
    return this.call("yed_decodepayload", [hex]);
  }

  /**
   * `yed_getprice`: the attested price state.
   *
   * @param height - The block height to read at; the tip when omitted.
   * @returns The price tiers and attestation status at that height.
   */
  yedGetPrice(height?: number): Promise<YedPrice> {
    return this.call("yed_getprice", height === undefined ? [] : [height]);
  }

  /**
   * `yed_getinfo`; also the probe for whether the node runs Yellowback.
   *
   * @returns The overlay's state, kept opaque.
   */
  yedGetInfo(): Promise<YedInfo> {
    return this.call("yed_getinfo");
  }

  // ------------------------------------------------------------------ shielded

  /**
   * A new wallet Sapling address (`yregtestsapling1…` on regtest); both lines take the "sapling" type.
   *
   * @returns The new address.
   */
  zGetNewAddress(): Promise<string> {
    return this.call("z_getnewaddress", ["sapling"]);
  }

  /**
   * A new diversified address of an existing wallet Sapling address: same viewing key, unlinkable
   * address, one per request. Both lines require the base address
   * (`ycash-dd/src/wallet/rpcdump.cpp:835-860`, `ycash6/src/wallet/rpcdump.cpp:1391-1421`).
   *
   * @param base - A Sapling address the wallet holds the key for.
   * @returns The new diversified address.
   */
  zGetNewDiversifiedAddress(base: string): Promise<string> {
    return this.call("z_getnewdiversifiedaddress", [base]);
  }

  /**
   * `z_listreceivedbyaddress`: the notes a wallet Sapling address received.
   *
   * @param address - The wallet's Sapling address.
   * @param minconf - Minimum confirmations; 0 includes the mempool.
   * @returns The received notes, with memos as hex.
   */
  zListReceivedByAddress(address: string, minconf = 1): Promise<ZReceived[]> {
    return this.call("z_listreceivedbyaddress", [address, minconf]);
  }

  // ------------------------------------------------------------------ wallet signer

  /**
   * `listunspent` over the node wallet's transparent coins.
   *
   * @param minconf - Minimum confirmations.
   * @param maxconf - Maximum confirmations.
   * @param addresses - Restrict to these addresses.
   * @returns The wallet's unspent outputs.
   */
  listUnspent(minconf = 1, maxconf = 9_999_999, addresses?: string[]): Promise<UnspentOutput[]> {
    return this.call("listunspent", addresses ? [minconf, maxconf, addresses] : [minconf, maxconf]);
  }

  /**
   * `createrawtransaction`, with amounts sent as exact decimal strings.
   *
   * @param inputs - The outpoints to spend.
   * @param outputs - Address to amount in zatoshis.
   * @param locktime - nLockTime.
   * @param expiryHeight - nExpiryHeight; the node refuses one below next block + 3.
   * @returns The unsigned transaction, hex.
   */
  createRawTransaction(inputs: RawTxInput[], outputs: Record<string, bigint>, locktime = 0, expiryHeight?: number): Promise<string> {
    const out = Object.fromEntries(Object.entries(outputs).map(([addr, zat]) => [addr, zatToYecString(zat)]));
    const params: unknown[] = [inputs, out, locktime];
    if (expiryHeight !== undefined) params.push(expiryHeight);
    return this.call("createrawtransaction", params);
  }

  /**
   * `signrawtransaction hex` with the node wallet's keys (Ycash has no signrawtransactionwithwallet).
   *
   * @param hex - The unsigned transaction.
   * @returns The (possibly partially) signed transaction and whether it is complete.
   */
  signRawTransactionWithWallet(hex: string): Promise<SignResult> {
    return this.call("signrawtransaction", [hex]);
  }

  /**
   * `getnewaddress`.
   *
   * @returns A new transparent wallet address.
   */
  getNewAddress(): Promise<string> {
    return this.call("getnewaddress");
  }

  /**
   * `sendtoaddress` from the node wallet's transparent coins.
   *
   * @param address - The recipient.
   * @param zat - The amount in zatoshis.
   * @returns The txid.
   */
  sendToAddress(address: string, zat: bigint): Promise<string> {
    return this.call("sendtoaddress", [address, zatToYecString(zat)]);
  }

  /**
   * Starts `z_sendmany`. Optional positional arguments are sent only up to the last one set, so
   * v4.5.0 never receives the 6.21.0-only privacy policy unless the caller asks.
   *
   * @param from - The sending address (transparent or Sapling).
   * @param recipients - Recipients with amounts in zatoshis and optional hex memos.
   * @param opts - minconf, fee in zatoshis and privacy policy.
   * @returns The async operation id.
   */
  zSendMany(from: string, recipients: ZRecipient[], opts: ZSendManyOptions = {}): Promise<string> {
    const amounts = recipients.map((r) => ({ address: r.address, amount: zatToYecString(r.amount), ...(r.memo ? { memo: r.memo } : {}) }));
    const params: unknown[] = [from, amounts];
    if (opts.minconf !== undefined || opts.fee !== undefined || opts.privacyPolicy !== undefined) params.push(opts.minconf ?? 1);
    if (opts.fee !== undefined || opts.privacyPolicy !== undefined) params.push(opts.fee === undefined ? null : zatToYecString(opts.fee));
    if (opts.privacyPolicy !== undefined) params.push(opts.privacyPolicy);
    return this.call("z_sendmany", params);
  }

  /**
   * Polls `z_getoperationresult` until the operation ends.
   *
   * @param opid - The operation id.
   * @param timeoutMs - How long to poll, milliseconds.
   * @param pollMs - The polling interval, milliseconds.
   * @returns The operation's txid.
   * @throws RpcError with the operation's error when it fails, or a transport RpcError on timeout.
   */
  async waitForOperation(opid: string, timeoutMs = 120_000, pollMs = 250): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [op] = await this.call<OperationResult[]>("z_getoperationresult", [[opid]]);
      if (op) {
        if (op.status === "success" && op.result) return op.result.txid;
        throw new RpcError(op.error?.code ?? 0, op.error?.message ?? `operation ${op.status}`, "z_sendmany");
      }
      if (Date.now() > deadline) throw new RpcError(0, `operation ${opid} still running after ${timeoutMs} ms`, "z_getoperationresult", { transport: true });
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * `z_sendmany` then wait for its txid.
   *
   * @param from - The sending address.
   * @param recipients - Recipients with amounts in zatoshis.
   * @param opts - z_sendmany options; `timeoutMs` bounds the wait.
   * @returns The txid.
   */
  async zSendManyAndWait(from: string, recipients: ZRecipient[], opts: ZSendManyOptions = {}): Promise<string> {
    return this.waitForOperation(await this.zSendMany(from, recipients, opts), opts.timeoutMs);
  }

  // ------------------------------------------------------------------ regtest

  /**
   * `generate` (regtest): mines blocks, with the timeout scaled to the count.
   *
   * @param n - How many blocks to mine.
   * @returns The new block hashes.
   */
  generate(n: number): Promise<string[]> {
    return this.call("generate", [n], { timeoutMs: 120_000 + 10_000 * n });
  }

  // ------------------------------------------------------------------ internals

  /**
   * Probes the node once: line and version from `getnetworkinfo`, chain from `getblockchaininfo`,
   * and Yellowback support from whether `yed_getinfo` exists.
   *
   * @returns The node's capabilities.
   * @throws The underlying error for a transport failure or any error other than "method not found".
   */
  private async detect(): Promise<NodeCapabilities> {
    const [net, chain] = await Promise.all([this.getNetworkInfo(), this.getBlockchainInfo()]);
    let yellowback = true;
    try {
      await this.yedGetInfo();
    } catch (e) {
      // Only "no such method" means a stock node; an unhealthy index still has the RPCs.
      if (e instanceof RpcError && e.code === RPC_METHOD_NOT_FOUND) yellowback = false;
      else if (!(e instanceof RpcError) || e.transport) throw e;
    }
    return { line: lineOf(net.subversion), subversion: net.subversion, version: net.version, yellowback, chain: chain.chain };
  }
}

/**
 * Reads the node line from its subversion: `/YcashCpp:4.5.0/` -> v4; `/YcashCpp:6.21.0/` -> v6.
 *
 * @param subversion - `getnetworkinfo`'s subversion.
 * @returns The node line, or "unknown" for any other major version.
 */
export function lineOf(subversion: string): NodeLine {
  const m = /:(\d+)\.\d+/.exec(subversion);
  if (!m) return "unknown";
  if (m[1] === "4") return "v4";
  if (m[1] === "6") return "v6";
  return "unknown";
}
