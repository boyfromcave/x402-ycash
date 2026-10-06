// An in-process lightwalletd: a real gRPC server on 127.0.0.1 serving the vendored protos, with
// canned answers, so the client is tested over the wire (encoding, byte order, status codes).
import { fileURLToPath } from "node:url";
import { Server, ServerCredentials, status, type sendUnaryData, type ServerUnaryCall, type ServerWritableStream, type UntypedServiceImplementation } from "@grpc/grpc-js";
import { loadSync, type ServiceDefinition } from "@grpc/proto-loader";
import { hexToBytes } from "../../../src/tx/index.js";

const def = loadSync(["service.proto", "yellowback.proto"], {
  includeDirs: [fileURLToPath(new URL("../../../proto", import.meta.url))],
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
});

export interface FakeUtxo {
  address: string;
  txid: string; // display order
  vout: number;
  script: string; // hex
  valueZat: number;
  height: number;
}

export interface FakeToken {
  txid: string;
  vout: number;
  cents: number;
  valueZat: number;
  height: number;
  address: string;
  transparentAddress: string;
}

export interface FakeLwdState {
  chainName: string;
  height: number;
  branchId: string;
  utxos: FakeUtxo[];
  tokens: FakeToken[];
  /** txid (display) → raw hex and height (0 = mempool; -1 sent as uint64 by some nodes) */
  txs: Map<string, { hex: string; height: number }>;
  mempool: string[];
  sent: string[];
  /** The next SendTransaction answer; default success with the JSON-quoted txid. */
  sendReply?: { errorCode: number; errorMessage: string };
  /** Serve YellowbackStreamer (a server started with --yellowback). */
  yellowback: boolean;
  /** The next block's branch id GetChainInfo serves (default: `branchId`, no upgrade pending). */
  nextBranchId?: string;
  /** Leave GetChainInfo out of YellowbackStreamer, as lightwalletd-dd before 0b3448e (UNIMPLEMENTED). */
  noChainInfo?: boolean;
  /** GetLightdInfo never answers (deadline tests). */
  hang?: boolean;
  calls: string[];
}

const le = (display: string): Buffer => Buffer.from(hexToBytes(display).reverse());
const display = (internal: Buffer): string => Buffer.from(internal).reverse().toString("hex");

export async function startFakeLwd(init: Partial<FakeLwdState> = {}): Promise<{ url: string; state: FakeLwdState; stop: () => Promise<void> }> {
  const state: FakeLwdState = { chainName: "regtest", height: 200, branchId: "19bd2d2f", utxos: [], tokens: [], txs: new Map(), mempool: [], sent: [], yellowback: true, calls: [], ...init };
  const unary = <Req, Res>(name: string, f: (req: Req) => Res | { error: { code: number; details: string } }) =>
    (call: ServerUnaryCall<Req, Res>, cb: sendUnaryData<Res>): void => {
      state.calls.push(name);
      if (name === "GetLightdInfo" && state.hang) return;
      const r = f(call.request);
      if (r && typeof r === "object" && "error" in r) cb({ code: r.error.code, details: r.error.details });
      else cb(null, r as Res);
    };
  const compact: UntypedServiceImplementation = {
    GetLightdInfo: unary("GetLightdInfo", () => ({ version: "v0.4.6", vendor: "fake", taddrSupport: true, chainName: state.chainName, consensusBranchId: state.branchId, blockHeight: String(state.height) })),
    GetLatestBlock: unary("GetLatestBlock", () => ({ height: String(state.height) })),
    GetAddressUtxos: unary("GetAddressUtxos", (req: { addresses: string[]; startHeight: string }) => ({
      addressUtxos: state.utxos
        .filter((u) => req.addresses.includes(u.address) && u.height >= Number(req.startHeight))
        .map((u) => ({ address: u.address, txid: le(u.txid), index: u.vout, script: Buffer.from(u.script, "hex"), valueZat: String(u.valueZat), height: String(u.height) })),
    })),
    GetTaddressBalance: unary("GetTaddressBalance", (req: { addresses: string[] }) => ({ valueZat: String(state.utxos.filter((u) => req.addresses.includes(u.address)).reduce((s, u) => s + u.valueZat, 0)) })),
    GetTransaction: unary("GetTransaction", (req: { hash: Buffer }) => {
      const t = state.txs.get(display(req.hash));
      if (!t) return { error: { code: status.UNKNOWN, details: "-5: No information available about transaction" } };
      return { data: Buffer.from(t.hex, "hex"), height: t.height < 0 ? "18446744073709551615" : String(t.height) };
    }),
    SendTransaction: unary("SendTransaction", (req: { data: Buffer }) => {
      state.sent.push(req.data.toString("hex"));
      return state.sendReply ?? { errorCode: 0, errorMessage: JSON.stringify("ab".repeat(32)) };
    }),
    GetMempoolTx: (call: ServerWritableStream<{ txid: Buffer[] }, unknown>) => {
      state.calls.push("GetMempoolTx");
      const skip = new Set(call.request.txid.map(display));
      for (const t of state.mempool) if (!skip.has(t)) call.write({ hash: le(t), index: "0" });
      call.end();
    },
  };
  const yed: UntypedServiceImplementation = {
    GetAddressTokens: (call: ServerWritableStream<{ addresses: string[] }, unknown>) => {
      state.calls.push("GetAddressTokens");
      for (const t of state.tokens) {
        if (call.request.addresses.includes(t.address) || call.request.addresses.includes(t.transparentAddress)) {
          call.write({ ...t, cents: String(t.cents), valueZat: String(t.valueZat), height: String(t.height) });
        }
      }
      call.end();
    },
    ...(state.noChainInfo ? {} : {
      GetChainInfo: unary("GetChainInfo", () => ({ chainName: state.chainName, blockHeight: String(state.height), consensusBranchId: state.branchId, nextBlockBranchId: state.nextBranchId ?? state.branchId })),
    }),
    ValidateRawTransaction: unary("ValidateRawTransaction", () => ({ valid: true, verdict: "ok", type: "transfer", yedIn: "500", yedOut: "500" })),
  };
  const server = new Server();
  server.addService(def["cash.z.wallet.sdk.rpc.CompactTxStreamer"] as ServiceDefinition, compact);
  if (state.yellowback) server.addService(def["cash.z.wallet.sdk.rpc.YellowbackStreamer"] as ServiceDefinition, yed);
  const port = await new Promise<number>((resolve, reject) => server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  return {
    url: `127.0.0.1:${port}`,
    state,
    stop: () => new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}
