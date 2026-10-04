// A gRPC client for the lightwalletd methods a light agent needs: CompactTxStreamer
// (proto/service.proto:142-181) and the YED lookups of YellowbackStreamer (proto/yellowback.proto:175-195).
// @grpc/grpc-js is the reference gRPC implementation for Node (pure JS, TLS, deadlines, HTTP/2);
// @grpc/proto-loader reads the vendored protos at run time, so there is no generated code to keep
// in step with lightwalletd-dd. One grpc.Client carries both services over one channel.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, credentials, Metadata, status, type ServiceError } from "@grpc/grpc-js";
import { loadSync, type MethodDefinition, type PackageDefinition, type ServiceDefinition } from "@grpc/proto-loader";
import { RpcError, SendRawTransactionError } from "../node/errors.js";
import { bytesToHex, hexToBytes } from "../tx/index.js";
import type { AddressUtxoMsg, CompactTxMsg, LightdInfo, RawTransactionMsg, SendResponseMsg, YedTokenMsg, YedValidationMsg } from "./types.js";
import { parseLwdUrl } from "./url.js";

const PACKAGE = "cash.z.wallet.sdk.rpc";
type Service = "CompactTxStreamer" | "YellowbackStreamer";

let definition: PackageDefinition | undefined;

/**
 * The vendored protos, loaded once (packages/ycash/proto, beside src/ and dist/).
 *
 * @returns The parsed package definition of both services.
 */
function protos(): PackageDefinition {
  definition ??= loadSync(["service.proto", "yellowback.proto"], {
    includeDirs: [fileURLToPath(new URL("../../proto", import.meta.url))],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
  });
  return definition;
}

/**
 * Looks up one RPC of the vendored protos.
 *
 * @param service - The gRPC service.
 * @param name - The method name, as in the proto.
 * @returns The method's path and (de)serializers.
 * @throws Error when the protos define no such method.
 */
function method(service: Service, name: string): MethodDefinition<object, object> {
  const s = protos()[`${PACKAGE}.${service}`] as ServiceDefinition | undefined;
  const m = s?.[name];
  if (!m) throw new Error(`lightwalletd proto has no ${service}.${name}`);
  return m;
}

/** A failed lightwalletd call: the gRPC status, and the node's JSON-RPC code when the server relayed one. */
export class LwdError extends Error {
  /** gRPC status code (`@grpc/grpc-js` `status`). */
  readonly grpcCode: number;
  /** The node's JSON-RPC error code when lightwalletd passed `"<code>: <message>"` through (common.RawRequest). */
  readonly rpcCode: number | undefined;
  readonly method: string;

  /**
   * Wraps a gRPC failure, extracting the node's JSON-RPC code from `"<code>: <message>"` details.
   *
   * @param methodName - The lightwalletd method that failed.
   * @param e - The gRPC error.
   */
  constructor(methodName: string, e: ServiceError) {
    super(`lightwalletd ${methodName}: ${e.details || e.message}`, { cause: e });
    this.name = "LwdError";
    this.grpcCode = e.code;
    this.method = methodName;
    const m = /^(-?\d+): /.exec(e.details ?? "");
    this.rpcCode = m ? Number(m[1]) : undefined;
  }

  /**
   * Whether the service is not registered (a server started without `--yellowback`, or an older build).
   *
   * @returns True for gRPC UNIMPLEMENTED.
   */
  get unimplemented(): boolean {
    return this.grpcCode === status.UNIMPLEMENTED;
  }
}

export interface LwdClientConfig {
  /** `host:port`, `grpc://host:port` (plaintext) or `grpcs://host:port` (TLS); see parseLwdUrl. */
  url: string;
  /** Overrides the scheme's choice of TLS. */
  tls?: boolean;
  /** PEM root certificates for a server with a private CA (default: the system roots). */
  caFile?: string;
  /** Per-call deadline (default 15 s). */
  deadlineMs?: number;
}

/** One address's transparent coin, as lightwalletd reads it from the node's address index. */
export interface AddressUtxo {
  address: string;
  /** display-order hex */
  txid: string;
  vout: number;
  scriptPubKey: Uint8Array;
  value: bigint;
  height: number;
}

/** A transaction as `GetTransaction` returns it; `height` undefined while it is in the mempool. */
export interface LwdRawTransaction {
  hex: string;
  height: number | undefined;
}

/**
 * Internal (little-endian) txid bytes to display-order hex.
 *
 * @param internal - The txid as the protos carry it.
 * @returns The txid, display-order hex.
 */
const displayHex = (internal: Uint8Array): string => bytesToHex(Uint8Array.from(internal).reverse());
/**
 * Display-order hex to internal (little-endian) txid bytes.
 *
 * @param display - The txid, display-order hex.
 * @returns The txid as the protos carry it.
 */
const internalBytes = (display: string): Buffer => Buffer.from(hexToBytes(display).reverse());

/**
 * Reads a uint64 height: 0, or -1 sent as uint64, mean "not in a block" (the node omits or negates it for a mempool tx).
 *
 * @param h - The height as a decimal string.
 * @returns The block height, or undefined for a mempool transaction.
 */
function blockHeight(h: string): number | undefined {
  const n = BigInt(h);
  return n === 0n || n >= 1n << 63n ? undefined : Number(n);
}

/** A lightwalletd gRPC client over one channel, with a per-call deadline; txids are display-order hex at its API. */
export class LwdClient {
  readonly url: string;
  readonly tls: boolean;
  private readonly client: Client;
  private readonly deadlineMs: number;

  /**
   * Opens a channel (connected lazily by grpc-js) to the server.
   *
   * @param config - The server URL, or the full configuration.
   */
  constructor(config: LwdClientConfig | string) {
    const c = typeof config === "string" ? { url: config } : config;
    const endpoint = parseLwdUrl(c.url);
    this.url = c.url;
    this.tls = c.tls ?? endpoint.tls;
    this.deadlineMs = c.deadlineMs ?? 15_000;
    const creds = this.tls ? credentials.createSsl(c.caFile ? readFileSync(c.caFile) : null) : credentials.createInsecure();
    this.client = new Client(endpoint.target, creds);
  }

  /** Closes the channel; later calls fail. */
  close(): void {
    this.client.close();
  }

  /**
   * `GetLightdInfo`: server and chain state.
   *
   * @returns Tip height, chain name and the tip's consensus branch id, among other fields.
   */
  getLightdInfo(): Promise<LightdInfo> {
    return this.unary("CompactTxStreamer", "GetLightdInfo", {});
  }

  /**
   * `GetLatestBlock`.
   *
   * @returns The height of lightwalletd's block cache tip (it follows the node every few seconds).
   */
  async getLatestBlock(): Promise<number> {
    return Number((await this.unary<{ height: string }>("CompactTxStreamer", "GetLatestBlock", {})).height);
  }

  /**
   * The unspent outputs paying `addresses` (`s…`, or `ye…` forms the server maps), from the node's
   * address index (`getaddressutxos`): confirmed outputs only, and a mempool spend does not remove one.
   *
   * @param addresses - The transparent addresses.
   * @param startHeight - Only outputs at or above this height.
   * @returns The outputs, txids display-order hex and values in zatoshis.
   */
  async getAddressUtxos(addresses: readonly string[], startHeight = 0): Promise<AddressUtxo[]> {
    const r = await this.unary<{ addressUtxos: AddressUtxoMsg[] }>("CompactTxStreamer", "GetAddressUtxos", { addresses: [...addresses], startHeight, maxEntries: 0 });
    return r.addressUtxos.map((u) => ({
      address: u.address,
      txid: displayHex(u.txid),
      vout: u.index,
      scriptPubKey: Uint8Array.from(u.script),
      value: BigInt(u.valueZat),
      height: Number(u.height),
    }));
  }

  /**
   * `GetTaddressBalance`: `getaddressbalance` over the same index.
   *
   * @param addresses - The transparent addresses.
   * @returns Their confirmed balance, zatoshis.
   */
  async getTaddressBalance(addresses: readonly string[]): Promise<bigint> {
    return BigInt((await this.unary<{ valueZat: string }>("CompactTxStreamer", "GetTaddressBalance", { addresses: [...addresses] })).valueZat);
  }

  /**
   * `GetTransaction`: a transaction in a block or the mempool (`getrawtransaction txid 1`).
   *
   * @param txid - The transaction id, display-order hex.
   * @returns Its hex and height, or undefined if the node knows none.
   */
  async getTransaction(txid: string): Promise<LwdRawTransaction | undefined> {
    try {
      const r = await this.unary<RawTransactionMsg>("CompactTxStreamer", "GetTransaction", { hash: internalBytes(txid) });
      return { hex: bytesToHex(r.data), height: blockHeight(r.height) };
    } catch (e) {
      if (e instanceof LwdError && e.rpcCode === -5) return undefined; // RPC_INVALID_ADDRESS_OR_KEY: no such tx
      throw e;
    }
  }

  /**
   * Broadcasts through the server's node (`sendrawtransaction`). The node's refusal is thrown as the
   * same SendRawTransactionError a node RPC throws, so callers classify it the same way.
   *
   * @param hex - The signed transaction.
   * @returns The txid, display-order hex.
   * @throws SendRawTransactionError when the node refuses it.
   */
  async sendTransaction(hex: string): Promise<string> {
    const r = await this.unary<SendResponseMsg>("CompactTxStreamer", "SendTransaction", { data: Buffer.from(hexToBytes(hex)), height: 0 });
    if (r.errorCode !== 0) throw new SendRawTransactionError(new RpcError(r.errorCode, r.errorMessage, "sendrawtransaction"));
    // Success carries the RPC result verbatim: the txid as a JSON string (frontend/service.go:331-341).
    const msg = r.errorMessage.trim();
    const txid = msg.startsWith('"') ? (JSON.parse(msg) as string) : msg;
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`lightwalletd SendTransaction: unexpected result ${JSON.stringify(r.errorMessage)}`);
    return txid;
  }

  /**
   * The txids lightwalletd lists from the mempool. Only transactions with Sapling elements are
   * sent (frontend/service.go:470-473, 484-489): a transparent-only transaction never appears.
   *
   * @param exclude - Txids (display-order hex) the server may leave out.
   * @returns The listed txids, display-order hex.
   */
  async getMempoolTxids(exclude: readonly string[] = []): Promise<string[]> {
    const txs = await this.serverStream<CompactTxMsg>("CompactTxStreamer", "GetMempoolTx", { txid: exclude.map(internalBytes) });
    return txs.map((t) => displayHex(t.hash));
  }

  /**
   * YED outputs paying `addresses` (`yed_listtokens`): the token index, confirmed outputs only.
   *
   * @param addresses - The addresses.
   * @param minHeight - Only outputs at or above this height.
   * @returns The token outputs.
   */
  getAddressTokens(addresses: readonly string[], minHeight = 0): Promise<YedTokenMsg[]> {
    return this.serverStream("YellowbackStreamer", "GetAddressTokens", { addresses: [...addresses], minHeight });
  }

  /**
   * `yed_validaterawtransaction`: the overlay's verdict at the tip, and the script check.
   *
   * @param hex - The serialized transaction.
   * @returns The validation result.
   */
  validateRawTransaction(hex: string): Promise<YedValidationMsg> {
    return this.unary("YellowbackStreamer", "ValidateRawTransaction", { data: Buffer.from(hexToBytes(hex)), height: 0 });
  }

  /**
   * Makes one unary call with the client's deadline.
   *
   * @param service - The gRPC service.
   * @param name - The method name.
   * @param req - The request message.
   * @returns The response message.
   * @throws LwdError when the call fails.
   */
  private unary<Res>(service: Service, name: string, req: object): Promise<Res> {
    const m = method(service, name);
    return new Promise((resolve, reject) => {
      this.client.makeUnaryRequest(m.path, m.requestSerialize, m.responseDeserialize, req, new Metadata(), { deadline: Date.now() + this.deadlineMs }, (err, value) => {
        if (err) reject(new LwdError(name, err));
        else resolve(value as Res);
      });
    });
  }

  /**
   * Makes one server-streaming call and collects every message until the stream ends.
   *
   * @param service - The gRPC service.
   * @param name - The method name.
   * @param req - The request message.
   * @returns All streamed messages, in order.
   * @throws LwdError when the call fails.
   */
  private serverStream<Res>(service: Service, name: string, req: object): Promise<Res[]> {
    const m = method(service, name);
    return new Promise((resolve, reject) => {
      const out: Res[] = [];
      const call = this.client.makeServerStreamRequest(m.path, m.requestSerialize, m.responseDeserialize, req, new Metadata(), { deadline: Date.now() + this.deadlineMs });
      call.on("data", (v: Res) => out.push(v));
      call.on("error", (err: ServiceError) => reject(new LwdError(name, err)));
      call.on("end", () => resolve(out));
    });
  }
}
