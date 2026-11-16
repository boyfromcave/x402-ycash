// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The reference agent: given a key file and the API's URL, it reads /pricing, then buys a short
// tour of the chain (the summary, the tip block, a transaction of it, its own address, the
// Yellowback state), paying each 402 itself in transparent YEC, under a hard spending cap. With
// `--lwd host:port` it needs no node: coins and the tip come from a public lightwalletd server.
import { parseArgs } from "node:util";
import type { PaymentRequirements } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { buildClient, loadCliConfig, UsageError, wifAddress, type CliConfig } from "x402-ycash-cli";
import { ASSET_YEC } from "x402-ycash-mechanism";

export const AGENT_USAGE = `usage:
  x402-chain-agent <api-url> --wif-file FILE --lwd HOST:PORT [--network ycash:testnet] [--budget ZAT] [--max-payment ZAT] [--address ADDR]

  --wif-file FILE      the payer's key (x402-ycash key new FILE writes one; mode 0600 or stricter)
  --lwd HOST:PORT      a lightwalletd server for coins and the tip (no node needed); or --devnet FILE /
                       --rpc-url URL with --rpc-cookie or --rpc-user and --rpc-password for a node
  --network NET        default ycash:testnet
  --budget ZAT         the most this run pays in total, zatoshis (default 100000 = 0.001 YEC); network fees are on top
  --max-payment ZAT    the most one payment may be, zatoshis (default 20000)
  --address ADDR       the address to look up (default the key's own address)
  --reservations FILE  coins held by signed, unconfirmed payments (default ~/.x402-ycash/reservations.json)`;

const OPTIONS = {
  network: { type: "string" },
  lwd: { type: "string" },
  "wif-file": { type: "string" },
  devnet: { type: "string" },
  node: { type: "string" },
  "rpc-url": { type: "string" },
  "rpc-user": { type: "string" },
  "rpc-password": { type: "string" },
  "rpc-cookie": { type: "string" },
  reservations: { type: "string" },
  channels: { type: "string" },
  "max-payment": { type: "string" },
  budget: { type: "string" },
  address: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export interface AgentIo {
  out: (record: Record<string, unknown>) => void;
  err: (line: string) => void;
}

/** A hard cap on what one run pays: every payment is counted when signed (a signed payment can be broadcast). */
export class Budget {
  spent = 0n;
  constructor(readonly limit: bigint) {}
  /**
   * Whether a payment of `amount` still fits.
   *
   * @param amount - Zatoshis.
   * @returns True when spent + amount stays within the limit.
   */
  allows(amount: bigint): boolean {
    return this.spent + amount <= this.limit;
  }
}

function zatOpt(name: string, v: string | undefined, fallback: bigint): bigint {
  if (v === undefined) return fallback;
  if (!/^[1-9]\d{0,15}$/.test(v)) throw new UsageError(`${name} must be a positive whole number of zatoshis`);
  return BigInt(v);
}

interface Pricing {
  network: string;
  payTo: string;
  routes: { method: string; path: string; priceZat: string }[];
}

/**
 * Fetches and checks /pricing: the right network, a payTo, and prices the agent can read.
 *
 * @param base - The API's base URL.
 * @param network - The network the agent pays on.
 * @param f - fetch.
 * @returns The pricing document.
 */
async function pricingOf(base: URL, network: string, f: typeof fetch): Promise<Pricing> {
  const res = await f(new URL("/pricing", base), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${base.origin}/pricing answered ${res.status}`);
  const p = (await res.json()) as Partial<Pricing>;
  if (p.network !== network) throw new Error(`the API serves ${String(p.network)}, not ${network} (--network)`);
  if (typeof p.payTo !== "string" || !Array.isArray(p.routes)) throw new Error("/pricing has no payTo or routes");
  return p as Pricing;
}

/**
 * Runs the agent.
 *
 * @param argv - The arguments.
 * @param env - The environment (X402_* variables as the CLI reads them).
 * @param io - Output.
 * @param f - fetch (tests).
 * @returns The exit code: 0 when every request was answered, 1 on a failed request, 2 on bad usage.
 */
export async function runAgent(argv: string[], env: Record<string, string | undefined> = process.env, io: AgentIo, f: typeof fetch = fetch): Promise<number> {
  let config: CliConfig | undefined;
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const { help, budget: budgetRaw, address: addressFlag, ...values } = parsed.values;
    const [url] = parsed.positionals;
    if (help || !url) {
      io.err(AGENT_USAGE);
      return help ? 0 : 2;
    }
    let base: URL;
    try {
      base = new URL(url);
    } catch {
      throw new UsageError("<api-url> must be an http(s) URL");
    }
    if (base.protocol !== "https:" && base.protocol !== "http:") throw new UsageError("<api-url> must be an http(s) URL");
    if (!values["wif-file"] && !env.X402_WIF_FILE) throw new UsageError("--wif-file is required: the agent pays from a key file");
    config = loadCliConfig({ command: ["pay", url], help: false, values: { network: "ycash:testnet", "max-payment": "20000", ...values } as Record<string, string | undefined> }, { ...env, X402_WIF: undefined });
    const budget = new Budget(zatOpt("--budget", budgetRaw, 100_000n));
    const wif = config.wif as string;
    const own = wifAddress(wif, config.network);
    const pricing = await pricingOf(base, config.network, f);
    io.out({ msg: "pricing", api: base.origin, network: pricing.network, payTo: pricing.payTo, routes: pricing.routes.map((r) => `${r.method} ${r.path} ${r.priceZat} zat`) });

    const paying = buildClient(config);
    // Pay only the advertised recipient, in YEC, on this network, within the budget.
    paying.client.onBeforePaymentCreation(async ({ selectedRequirements: r }: { selectedRequirements: PaymentRequirements }) => {
      const amount = BigInt(r.amount);
      if (r.network !== config?.network || r.asset !== ASSET_YEC) return { abort: true, reason: `refusing ${r.asset} on ${r.network}` };
      if (r.payTo !== pricing.payTo) return { abort: true, reason: "the 402 names another recipient than /pricing" };
      if (!budget.allows(amount)) return { abort: true, reason: `budget: ${budget.spent} of ${budget.limit} zatoshis spent, this payment is ${amount}` };
      budget.spent += amount;
      return undefined;
    });
    const paid = wrapFetchWithPayment(f, paying.client);
    let failed = false;
    const get = async (path: string): Promise<Record<string, unknown> | undefined> => {
      const t0 = performance.now();
      let res: Response;
      try {
        res = await paid(new URL(path, base), { signal: AbortSignal.timeout(180_000) });
      } catch (e) {
        failed = true;
        io.out({ path, error: (e as Error).message, spentZat: budget.spent.toString() });
        return undefined;
      }
      const h = res.headers.get("PAYMENT-RESPONSE");
      const settlement = h ? decodePaymentResponseHeader(h) : undefined;
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: printed as text
      }
      if (res.status >= 400) failed = true;
      io.out({ path, status: res.status, ms: Math.round(performance.now() - t0), ...(settlement ? { paidTx: settlement.transaction } : {}), spentZat: budget.spent.toString(), body });
      return res.ok && typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
    };

    const chain = await get("/v1/chain");
    const tip = typeof chain?.blocks === "number" ? chain.blocks : undefined;
    const block = tip !== undefined ? await get(`/v1/block/${tip}`) : undefined;
    const txid = Array.isArray(block?.tx) && typeof block.tx[0] === "string" ? block.tx[0] : undefined;
    if (txid) await get(`/v1/tx/${txid}`);
    await get(`/v1/address/${encodeURIComponent(addressFlag ?? own)}`);
    await get("/v1/yellowback");
    io.out({ msg: "done", spentZat: budget.spent.toString(), budgetZat: budget.limit.toString(), payer: own });
    return failed ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`x402-chain-agent: ${e.message}\n\n${AGENT_USAGE}`);
      return 2;
    }
    io.err(`x402-chain-agent: ${(e as Error).message}`);
    return 1;
  } finally {
    config?.lwd?.close();
  }
}
