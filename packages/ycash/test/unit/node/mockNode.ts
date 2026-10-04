import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  params: unknown[];
  authorization: string | undefined;
}

export type Handler = (method: string, params: unknown[]) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/** A fake ycashd: answers JSON-RPC posts from a handler and records every request. */
export class MockNode {
  readonly requests: Recorded[] = [];
  private server: Server | undefined;
  handler: Handler = () => ({ body: { result: null, error: null, id: 1 } });
  /** When set, requests whose Authorization differs get HTTP 401. */
  expectAuth: string | undefined;

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { method: string; params: unknown[] };
      this.requests.push({ method: body.method, params: body.params, authorization: req.headers.authorization });
      if (this.expectAuth !== undefined && req.headers.authorization !== this.expectAuth) {
        res.writeHead(401).end();
        return;
      }
      const out = await this.handler(body.method, body.params);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

export const ok = (result: unknown) => ({ body: { result, error: null, id: 1 } });
export const fail = (code: number, message: string, status = 500) => ({ status, body: { result: null, error: { code, message }, id: 1 } });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
