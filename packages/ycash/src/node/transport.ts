import { readFile } from "node:fs/promises";
import { RpcError } from "./errors.js";

export interface PasswordAuth {
  url: string;
  user: string;
  password: string;
}

export interface CookieAuth {
  url: string;
  /** The node's `.cookie` file (`__cookie__:<secret>`), re-read when the node restarts. */
  cookieFile: string;
}

export type RpcConfig = (PasswordAuth | CookieAuth) & {
  /** Per-call timeout, milliseconds (default 30 s). */
  timeoutMs?: number;
};

export interface CallOptions {
  timeoutMs?: number;
}

/**
 * Basic auth over UTF-8. The devnet's credentials contain emoji (chain-viz finding C-F1), and a
 * URL's userinfo is percent-encoded and dropped by fetch, so the header is built by hand.
 */
export function basicAuthHeader(user: string, password: string): string {
  return "Basic " + Buffer.from(`${user}:${password}`, "utf8").toString("base64");
}

/** Removes `user:pass@` from a URL; returns it with any userinfo it held, decoded. */
export function stripUserinfo(raw: string): { url: string; user?: string; password?: string } {
  const u = new URL(raw);
  const user = u.username ? decodeURIComponent(u.username) : undefined;
  const password = u.password ? decodeURIComponent(u.password) : undefined;
  u.username = "";
  u.password = "";
  return { url: u.toString(), ...(user !== undefined ? { user } : {}), ...(password !== undefined ? { password } : {}) };
}

/**
 * One JSON-RPC 1.0 endpoint. Node's global fetch (undici) keeps connections alive per origin, so
 * repeated calls reuse the socket. ycashd answers errors with HTTP 500 (404 for an unknown method)
 * and a JSON body, so the body is read whatever the status.
 */
export class RpcTransport {
  readonly url: string;
  private readonly timeoutMs: number;
  private auth: string | undefined;
  private readonly cookieFile: string | undefined;
  private nextId = 1;

  constructor(config: RpcConfig) {
    this.url = stripUserinfo(config.url).url;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    if ("cookieFile" in config) {
      this.cookieFile = config.cookieFile;
    } else {
      this.auth = basicAuthHeader(config.user, config.password);
    }
  }

  async call<T>(method: string, params: readonly unknown[] = [], opts: CallOptions = {}): Promise<T> {
    let res = await this.post(method, params, opts);
    if (res.status === 401 && this.cookieFile) {
      this.auth = undefined; // the node restarted and wrote a new cookie
      res = await this.post(method, params, opts);
    }
    if (res.status === 401 || res.status === 403) {
      throw new RpcError(0, `HTTP ${res.status}: unauthorised`, method, { httpStatus: res.status, transport: true });
    }
    const text = await res.text();
    let body: { result?: unknown; error?: { code: number; message: string } | null };
    try {
      body = JSON.parse(text) as typeof body;
    } catch (cause) {
      throw new RpcError(0, `HTTP ${res.status}: not JSON: ${text.slice(0, 200)}`, method, { httpStatus: res.status, transport: true, cause });
    }
    if (body.error) throw new RpcError(body.error.code, body.error.message, method, { httpStatus: res.status });
    return body.result as T;
  }

  private async post(method: string, params: readonly unknown[], opts: CallOptions): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    try {
      return await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: await this.authorization() },
        body: JSON.stringify({ jsonrpc: "1.0", id: this.nextId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
        keepalive: true,
      });
    } catch (cause) {
      const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
      const message = timedOut ? `timed out after ${timeoutMs} ms` : `request failed: ${(cause as Error).message}`;
      throw new RpcError(0, message, method, { transport: true, cause });
    }
  }

  private async authorization(): Promise<string> {
    if (this.auth) return this.auth;
    const cookie = (await readFile(this.cookieFile as string, "utf8")).trim();
    const colon = cookie.indexOf(":");
    if (colon < 0) throw new RpcError(0, `malformed cookie file ${this.cookieFile}`, "auth", { transport: true });
    this.auth = basicAuthHeader(cookie.slice(0, colon), cookie.slice(colon + 1));
    return this.auth;
  }
}
