// The Sapling transaction builder the `sapling` client delegates to (spec, "sapling", Client). Neither
// node line builds a shielded transaction without broadcasting it (plan Z-1), so the signed,
// unbroadcast transaction comes from outside this package: the Rust light client's `x402-light serve`
// over JSON-RPC, or any shell command that speaks the same contract on stdin/stdout.
//
// The contract, one call:
//   build {to, amountZat, memoHex, expiryHeight?}  →  {txHex, txid}
// `to` is the Sapling payTo, `amountZat` a decimal string, `memoHex` the memo's UTF-8 bytes in hex
// (the builder pads to 512 bytes), `expiryHeight` the nExpiryHeight to use when the caller knows the
// tip (absent: the builder picks tip + 3 + ⌈maxTimeoutSeconds / 75⌉ itself). `txHex` is lowercase,
// complete and signed; the builder MUST NOT broadcast it.
import { spawn } from "node:child_process";

/** One `build` request. */
export interface SaplingBuildRequest {
  to: string;
  /** zatoshis, decimal */
  amountZat: string;
  /** the memo's UTF-8 bytes, hex, unpadded */
  memoHex: string;
  expiryHeight?: number;
}

/** What the builder returns: the signed transaction and its txid (display order). */
export interface SaplingBuildResult {
  txHex: string;
  txid: string;
}

/** A Sapling transaction builder: signs and returns, never broadcasts. */
export interface SaplingTransactionBuilder {
  /** For logs: where the transactions come from. */
  readonly description: string;
  build(request: SaplingBuildRequest): Promise<SaplingBuildResult>;
}

const HEX = /^(?:[0-9a-f]{2})+$/;
const TXID = /^[0-9a-f]{64}$/;

/**
 * Checks a builder's answer has the contract's shape.
 *
 * @param v - The decoded answer.
 * @param from - The builder, for the error.
 * @returns The result.
 * @throws Error when a field is missing or malformed.
 */
export function parseBuildResult(v: unknown, from: string): SaplingBuildResult {
  const r = v as Partial<SaplingBuildResult> | null;
  if (!r || typeof r.txHex !== "string" || !HEX.test(r.txHex)) throw new Error(`${from}: the answer has no lowercase txHex`);
  if (typeof r.txid !== "string" || !TXID.test(r.txid)) throw new Error(`${from}: the answer has no txid`);
  return { txHex: r.txHex, txid: r.txid };
}

/** `x402-light serve` (or anything speaking JSON-RPC 2.0 with method `build`). */
export class JsonRpcSaplingBuilder implements SaplingTransactionBuilder {
  readonly description: string;
  private id = 0;

  /**
   * Keeps the endpoint.
   *
   * @param url - The JSON-RPC URL, http(s).
   * @param opts - `timeoutMs` (default 120 s: proving takes seconds) and an optional fetch.
   * @param opts.timeoutMs - How long one build may take.
   * @param opts.fetch - The fetch to use (tests).
   */
  constructor(
    private readonly url: string,
    private readonly opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {
    this.description = `json-rpc ${url}`;
  }

  /**
   * Calls `build`.
   *
   * @param request - The payment to build.
   * @returns The signed transaction.
   * @throws Error on a transport failure, a JSON-RPC error or a malformed answer.
   */
  async build(request: SaplingBuildRequest): Promise<SaplingBuildResult> {
    const res = await (this.opts.fetch ?? fetch)(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: "build", params: request }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { code?: number; message?: string } } | null;
    if (!body) throw new Error(`${this.description}: HTTP ${res.status} with no JSON body`);
    if (body.error) throw new Error(`${this.description}: build failed (${body.error.code ?? "?"}): ${body.error.message ?? "no message"}`);
    return parseBuildResult(body.result, this.description);
  }
}

/** A shell command: the request as one JSON object on stdin, the result as one JSON object on stdout. */
export class CommandSaplingBuilder implements SaplingTransactionBuilder {
  readonly description: string;

  /**
   * Keeps the command.
   *
   * @param command - Run with `sh -c`.
   * @param opts - `timeoutMs` (default 120 s) and extra environment.
   * @param opts.timeoutMs - How long one build may take.
   * @param opts.env - Added to the inherited environment.
   */
  constructor(
    private readonly command: string,
    private readonly opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ) {
    this.description = `command ${command}`;
  }

  /**
   * Runs the command once.
   *
   * @param request - The payment to build.
   * @returns The signed transaction.
   * @throws Error on a non-zero exit, a timeout or a malformed answer.
   */
  build(request: SaplingBuildRequest): Promise<SaplingBuildResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", this.command], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(this.opts.env ?? {}) } });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), this.opts.timeoutMs ?? 120_000);
      child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`${this.description}: ${e.message}`));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`${this.description}: exited ${code ?? signal}: ${err.trim().slice(-500)}`));
        try {
          resolve(parseBuildResult(JSON.parse(out.trim().split("\n").pop() ?? ""), this.description));
        } catch (e) {
          reject(e instanceof SyntaxError ? new Error(`${this.description}: stdout is not JSON`) : e);
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

/** A builder for tests: answers from a function and records every request. */
export class FakeSaplingBuilder implements SaplingTransactionBuilder {
  readonly description = "fake";
  readonly requests: SaplingBuildRequest[] = [];

  /**
   * Keeps the answer function.
   *
   * @param answer - Builds the result of a request.
   */
  constructor(private readonly answer: (r: SaplingBuildRequest) => SaplingBuildResult | Promise<SaplingBuildResult>) {}

  /**
   * Records and answers.
   *
   * @param request - The payment to build.
   * @returns The answer.
   */
  async build(request: SaplingBuildRequest): Promise<SaplingBuildResult> {
    this.requests.push(request);
    return this.answer(request);
  }
}

/**
 * The builder a configuration string names: an http(s) URL is `x402-light serve`'s JSON-RPC, anything
 * else a shell command.
 *
 * @param spec - AGENT_SAPLING_BUILDER / --sapling-builder.
 * @returns The builder.
 */
export function saplingBuilderFrom(spec: string): SaplingTransactionBuilder {
  return /^https?:\/\//.test(spec) ? new JsonRpcSaplingBuilder(spec) : new CommandSaplingBuilder(spec);
}
