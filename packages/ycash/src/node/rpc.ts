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

  constructor(config: RpcConfig) {
    this.transport = new RpcTransport(config);
  }

  get url(): string {
    return this.transport.url;
  }

  /**
   * A node of a Yellowback devnet. The URL in `devnet.json` carries the credentials as userinfo; they
   * are stripped and sent from the `user`/`password` fields as UTF-8 basic auth (chain-viz C-F1).
   */
  static fromDevnetJson(path: string, nodeIndex: number, opts: { timeoutMs?: number } = {}): YcashRpc {
    const state = JSON.parse(readFileSync(path, "utf8")) as { rpc?: Record<string, DevnetRpcEntry> };
    const entry = state.rpc?.[String(nodeIndex)];
    if (!entry) throw new Error(`${path} has no rpc.${nodeIndex}`);
    return new YcashRpc({ url: stripUserinfo(entry.url).url, user: entry.user, password: entry.password, ...opts });
  }

  call<T>(method: string, params: readonly unknown[] = [], opts?: CallOptions): Promise<T> {
    return this.transport.call<T>(method, params, opts);
  }

  // ------------------------------------------------------------------ capabilities

  /** Detected once per client: which line, and whether the Yellowback RPCs exist. */
  capabilities(): Promise<NodeCapabilities> {
    this.capabilitiesPromise ??= this.detect().catch((e: unknown) => {
      this.capabilitiesPromise = undefined; // a transient failure must not stick
      throw e;
    });
    return this.capabilitiesPromise;
  }

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

  // ------------------------------------------------------------------ chain

  getNetworkInfo(): Promise<NetworkInfo> {
    return this.call("getnetworkinfo");
  }

  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.call("getblockchaininfo");
  }

  getBlockCount(): Promise<number> {
    return this.call("getblockcount");
  }

  getRawMempool(): Promise<string[]> {
    return this.call("getrawmempool");
  }

  /** null when the output is spent, unknown, or (includeMempool) spent by a mempool tx (plan R-6). */
  getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null> {
    return this.call("gettxout", [txid, n, includeMempool]);
  }

  decodeRawTransaction(hex: string): Promise<DecodedTransaction> {
    return this.call("decoderawtransaction", [hex]);
  }

  /**
   * Script verification on any node, wallet or not: `signrawtransaction hex [] []` signs nothing
   * (empty prevtxs, empty keys) and runs VerifyScript on every input (plan R-5;
   * `ycash-dd/src/rpc/rawtransaction.cpp:1069-1079`, `ycash6` `:1226-1231`).
   */
  async verifyScripts(hex: string): Promise<VerifyScriptsResult> {
    const r = await this.call<SignResult>("signrawtransaction", [hex, [], []]);
    return { complete: r.complete, errors: r.errors ?? [] };
  }

  /**
   * Relay a signed tx. A resubmission of a tx already in the mempool returns its txid with no
   * error (plan R-3), so callers deduplicate by txid themselves. Failures are thrown as
   * SendRawTransactionError with a `kind`.
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

  yedValidateRawTransaction(hex: string): Promise<YedValidation> {
    return this.call("yed_validaterawtransaction", [hex]);
  }

  yedDecodePayload(hex: string): Promise<YedPayload> {
    return this.call("yed_decodepayload", [hex]);
  }

  yedGetPrice(height?: number): Promise<YedPrice> {
    return this.call("yed_getprice", height === undefined ? [] : [height]);
  }

  yedGetInfo(): Promise<YedInfo> {
    return this.call("yed_getinfo");
  }

  // ------------------------------------------------------------------ shielded

  zGetNewDiversifiedAddress(): Promise<string> {
    return this.call("z_getnewdiversifiedaddress");
  }

  /** minconf 0 includes the mempool (plan Z-3). */
  zListReceivedByAddress(address: string, minconf = 1): Promise<ZReceived[]> {
    return this.call("z_listreceivedbyaddress", [address, minconf]);
  }

  // ------------------------------------------------------------------ wallet signer

  listUnspent(minconf = 1, maxconf = 9_999_999, addresses?: string[]): Promise<UnspentOutput[]> {
    return this.call("listunspent", addresses ? [minconf, maxconf, addresses] : [minconf, maxconf]);
  }

  /** outputs: address -> zatoshis. expiryHeight must be ≥ next + 3 (plan R-2). */
  createRawTransaction(inputs: RawTxInput[], outputs: Record<string, bigint>, locktime = 0, expiryHeight?: number): Promise<string> {
    const out = Object.fromEntries(Object.entries(outputs).map(([addr, zat]) => [addr, zatToYecString(zat)]));
    const params: unknown[] = [inputs, out, locktime];
    if (expiryHeight !== undefined) params.push(expiryHeight);
    return this.call("createrawtransaction", params);
  }

  /** `signrawtransaction hex` with the node wallet's keys (Ycash has no signrawtransactionwithwallet). */
  signRawTransactionWithWallet(hex: string): Promise<SignResult> {
    return this.call("signrawtransaction", [hex]);
  }

  getNewAddress(): Promise<string> {
    return this.call("getnewaddress");
  }

  sendToAddress(address: string, zat: bigint): Promise<string> {
    return this.call("sendtoaddress", [address, zatToYecString(zat)]);
  }

  /** Starts `z_sendmany`; returns the async operation id. */
  zSendMany(from: string, recipients: ZRecipient[], opts: ZSendManyOptions = {}): Promise<string> {
    const amounts = recipients.map((r) => ({ address: r.address, amount: zatToYecString(r.amount), ...(r.memo ? { memo: r.memo } : {}) }));
    const params: unknown[] = [from, amounts];
    if (opts.minconf !== undefined || opts.fee !== undefined || opts.privacyPolicy !== undefined) params.push(opts.minconf ?? 1);
    if (opts.fee !== undefined || opts.privacyPolicy !== undefined) params.push(opts.fee === undefined ? null : zatToYecString(opts.fee));
    if (opts.privacyPolicy !== undefined) params.push(opts.privacyPolicy);
    return this.call("z_sendmany", params);
  }

  /** Polls `z_getoperationresult` until the operation ends; returns its txid or throws its error. */
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

  /** `z_sendmany` then wait for its txid. */
  async zSendManyAndWait(from: string, recipients: ZRecipient[], opts: ZSendManyOptions = {}): Promise<string> {
    return this.waitForOperation(await this.zSendMany(from, recipients, opts), opts.timeoutMs);
  }

  // ------------------------------------------------------------------ regtest

  generate(n: number): Promise<string[]> {
    return this.call("generate", [n], { timeoutMs: 120_000 + 10_000 * n });
  }
}

/** `/YcashCpp:4.5.0/` -> v4; `/YcashCpp:6.21.0/` -> v6. */
export function lineOf(subversion: string): NodeLine {
  const m = /:(\d+)\.\d+/.exec(subversion);
  if (!m) return "unknown";
  if (m[1] === "4") return "v4";
  if (m[1] === "6") return "v6";
  return "unknown";
}
