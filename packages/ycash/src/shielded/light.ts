// The Rust light client (`x402-light serve`, light/schema.json) as the agent's whole shielded wallet:
// the `sapling` builder (build: signed, unbroadcast), the tip for nExpiryHeight (status), and the
// `sapling-proof` payer (send: build + broadcast through lightwalletd, then the txid). An agent with
// a Sapling spending key and a lightwalletd URL needs no ycashd wallet at all (plan X4b).
import type { PaymentRequirements } from "@x402/core/types";
import { type YcashNetwork } from "../constants.js";
import type { ShieldedExactPayer } from "../exact/client/methods.js";
import { parseBuildResult, type SaplingBuildRequest, type SaplingBuildResult, type SaplingTransactionBuilder } from "./builder.js";
import { checkSaplingProofRequirement } from "./client.js";
import { memoToHex } from "./request.js";

/** A JSON-RPC error from `x402-light` (codes in light/schema.json `errors`). */
export class LightClientError extends Error {
  /**
   * Keeps the code.
   *
   * @param code - The JSON-RPC error code.
   * @param message - The message, prefixed with the client.
   */
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "LightClientError";
  }
}

/** The parts of `status` this package reads (light/schema.json `status.result`). */
export interface LightStatus {
  network: "mainnet" | "testnet" | "regtest";
  /** The node's height per lightwalletd. */
  lwdHeight: number;
  /** The wallet's view of the tip, null before the first sync. */
  height: number | null;
  synced: boolean;
  hasKey: boolean;
  address: string | null;
  balance: { spendableZat: number; pendingChangeZat: number; pendingIncomingZat: number; totalZat: number };
}

/** `send`'s answer: the broadcast transaction. */
export interface LightSent {
  txid: string;
  txHex: string;
  feeZat: number | null;
  expiryHeight: number;
}

const TXID = /^[0-9a-f]{64}$/;

/** A client of `x402-light serve`'s loopback JSON-RPC. */
export class LightClient implements SaplingTransactionBuilder {
  readonly description: string;
  private id = 0;

  /**
   * Keeps the endpoint.
   *
   * @param url - `http://127.0.0.1:PORT` as `x402-light serve` prints it.
   * @param opts - `timeoutMs` (default 120 s: proving takes seconds) and an optional fetch.
   * @param opts.timeoutMs - How long one call may take.
   * @param opts.fetch - The fetch to use (tests).
   */
  constructor(
    readonly url: string,
    private readonly opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {
    this.description = `x402-light ${url}`;
  }

  /**
   * One JSON-RPC call.
   *
   * @param method - A method of light/schema.json.
   * @param params - Its params object.
   * @returns The result.
   * @throws LightClientError on a JSON-RPC error; Error on a transport failure.
   */
  async call<T>(method: string, params: unknown = null): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: T; error?: { code?: number; message?: string } } | null;
    if (!body) throw new Error(`${this.description}: HTTP ${res.status} with no JSON body`);
    if (body.error) throw new LightClientError(body.error.code ?? 0, `${this.description}: ${method} failed (${body.error.code ?? "?"}): ${body.error.message ?? "no message"}`);
    return body.result as T;
  }

  /**
   * The wallet's status.
   *
   * @returns network, heights, balance.
   */
  status(): Promise<LightStatus> {
    return this.call<LightStatus>("status");
  }

  /**
   * The chain tip, for nExpiryHeight (SaplingExactClient's `chain`): the node's height per lightwalletd.
   *
   * @returns The height.
   */
  async getBlockCount(): Promise<number> {
    return (await this.status()).lwdHeight;
  }

  /**
   * The builder contract: a signed, unbroadcast transaction (SaplingTransactionBuilder).
   *
   * @param request - The payment.
   * @returns `{txHex, txid}`.
   */
  async build(request: SaplingBuildRequest): Promise<SaplingBuildResult> {
    return parseBuildResult(await this.call("build", request), this.description);
  }

  /**
   * Build and broadcast through lightwalletd.
   *
   * @param request - The payment (same shape as `build`).
   * @returns The broadcast transaction's txid, hex, fee and expiry.
   * @throws Error when the answer carries no txid.
   */
  async send(request: SaplingBuildRequest): Promise<LightSent> {
    const r = await this.call<LightSent>("send", request);
    if (!r || typeof r.txid !== "string" || !TXID.test(r.txid)) throw new Error(`${this.description}: send answered no txid`);
    return r;
  }

  /**
   * One sync pass (the server also syncs in the background).
   *
   * @returns The sync report.
   */
  sync(): Promise<{ tipHeight: number; blocksScanned: number; receivedNotes: number; spentNotes: number; millis: number }> {
    return this.call("sync", {});
  }
}

export interface LightClientShieldedPayerConfig {
  light: LightClient;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

/**
 * The `sapling-proof` payer over the light client: the same checks as ShieldedExactClient, then
 * `send` to the per-request address with the request's memo, and the txid as the payload. Tier P1
 * (a Sapling source); nothing on chain names the payer.
 */
export class LightClientShieldedPayer implements ShieldedExactPayer {
  /**
   * Keeps the light client.
   *
   * @param config - The light client and an optional clock.
   */
  constructor(private readonly config: LightClientShieldedPayerConfig) {}

  /**
   * Pays and returns the payload. Every check runs before any money moves.
   *
   * @param x402Version - The protocol version, echoed into the payload.
   * @param requirements - The `sapling-proof` requirement.
   * @returns `{txid}`.
   * @throws Error when the requirement is not payable here or the light client is on another network.
   */
  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<{ x402Version: number; payload: { txid: string } }> {
    const network = checkSaplingProofRequirement(requirements, this.config.now);
    const status = await this.config.light.status();
    if (`ycash:${status.network}` !== (network satisfies YcashNetwork)) throw new Error(`the light client is on ${status.network}, not ${network}`);
    const sent = await this.config.light.send({ to: requirements.payTo, amountZat: requirements.amount, memoHex: memoToHex(requirements.extra.memo as string) });
    return { x402Version, payload: { txid: sent.txid } };
  }
}
