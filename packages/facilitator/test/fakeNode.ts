// A fake ycashd JSON-RPC endpoint, tests only: enough of getnetworkinfo / getblockchaininfo /
// yed_getinfo / getblockcount for the service's startup and /healthz.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeNodeOptions {
  chain?: string;
  subversion?: string;
  yellowback?: boolean;
  /** Answer -28 (warming up) to this many requests first. */
  warmupCalls?: number;
  /** Hold the merchant's viewing key: answer z_listreceivedbyaddress and z_validateaddress (offline-issuer startup). */
  viewingKey?: boolean;
}

export interface FakeNode {
  url: string;
  user: string;
  password: string;
  calls: string[];
  close(): Promise<void>;
}

export async function startFakeNode(opts: FakeNodeOptions = {}): Promise<FakeNode> {
  const calls: string[] = [];
  let warmup = opts.warmupCalls ?? 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(raw) as { id: number; method: string };
      calls.push(method);
      const reply = (status: number, result: unknown, error: { code: number; message: string } | null = null): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ result, error, id }));
      };
      if (warmup > 0) {
        warmup--;
        return reply(500, null, { code: -28, message: "Loading block index..." });
      }
      switch (method) {
        case "getnetworkinfo":
          return reply(200, { version: 4050050, subversion: opts.subversion ?? "/YcashCpp:4.5.0/", protocolversion: 170013, relayfee: 0.000001 });
        case "getblockchaininfo":
          return reply(200, { chain: opts.chain ?? "regtest", blocks: 232 });
        case "getblockcount":
          return reply(200, 232);
        case "z_listreceivedbyaddress":
          return opts.viewingKey ? reply(200, []) : reply(500, null, { code: -5, message: "viewing key not found" });
        case "z_validateaddress":
          return reply(200, { isvalid: true, ismine: false });
        case "yed_getinfo":
          return opts.yellowback === false ? reply(404, null, { code: -32601, message: "Method not found" }) : reply(200, {});
        default:
          return reply(404, null, { code: -32601, message: "Method not found" });
      }
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    user: "x402",
    password: "pässwörd🔑",
    calls,
    close: () => new Promise(r => server.close(() => r())),
  };
}
