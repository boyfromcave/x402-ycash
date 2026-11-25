// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The reference agent: given a key file and the API's URL, it reads /pricing, then buys a short
// tour of the chain (the summary, the tip block, a transaction of it, its own address, the
// Yellowback state), paying each 402 itself in transparent YEC, under a hard spending cap. With
// `--lwd host:port` it needs no node: coins and the tip come from a public lightwalletd server. With
// `--sapling-builder URL` (x402-light serve, holding one Sapling key) it takes the private tour
// instead: the same reads under /v1/private, each paid in shielded YEC (`sapling-proof`).
import { parseArgs } from "node:util";
import type { PaymentRequirements } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { buildClient, loadCliConfig, UsageError, wifAddress, type CliConfig } from "x402-ycash-cli";
import { ASSET_YEC, shielded, type YcashNetwork } from "x402-ycash-mechanism";

export const AGENT_USAGE = `usage:
  x402-chain-agent <api-url> --wif-file FILE --lwd HOST:PORT [--network ycash:testnet] [--budget ZAT] [--max-payment ZAT] [--address ADDR]
  x402-chain-agent <api-url> --sapling-builder URL [--network ycash:testnet] [--budget ZAT] [--max-payment ZAT] [--address ADDR] [--wait SECONDS]

  --wif-file FILE      the payer's key (x402-ycash key new FILE writes one; mode 0600 or stricter)
  --lwd HOST:PORT      a lightwalletd server for coins and the tip (no node needed); or --devnet FILE /
                       --rpc-url URL with --rpc-cookie or --rpc-user and --rpc-password for a node
  --network NET        default ycash:testnet
  --budget ZAT         the most this run pays in total, zatoshis (default 100000 = 0.001 YEC); network fees are on top
  --max-payment ZAT    the most one payment may be, zatoshis (default 20000)
  --address ADDR       the address to look up (default the key's own address; private tour: the API's payTo)
  --reservations FILE  coins held by signed, unconfirmed payments (default ~/.x402-ycash/reservations.json)
  --sapling-builder URL  the private tour: pay the /v1/private routes in shielded YEC from the Sapling key of
                       x402-light serve at URL (scripts/light-agent.sh start prints it); no WIF, no node
  --wait SECONDS       private tour: how long to wait for a spendable note before a payment (default 300;
                       a light wallet spends confirmed notes only, so change returns one block later)`;

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
  "sapling-builder": { type: "string" },
  wait: { type: "string" },
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
  routes: { method: string; path: string; priceZat: string; payment?: string }[];
}

/** The light client's wallet, as the private tour reads it before each payment. */
interface LightWallet {
  status(): Promise<{ balance: { spendableZat: number; pendingChangeZat: number; pendingIncomingZat: number } }>;
  sync(): Promise<unknown>;
}

/**
 * Waits until the light wallet can spend `need` zatoshis: a light wallet spends confirmed notes only,
 * so after a payment its change is spendable one block later.
 *
 * @param light - The light client.
 * @param need - Zatoshis (the price plus the network fee).
 * @param waitMs - How long to wait.
 * @param sleep - Injected for tests.
 * @returns undefined when spendable, else why not.
 */
export async function waitSpendable(light: LightWallet, need: bigint, waitMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // Catch up first: the light client builds only at lightwalletd's tip, and a block may have come
    // since its last background pass.
    await light.sync().catch(() => undefined);
    const b = (await light.status()).balance;
    if (BigInt(b.spendableZat) >= need) return undefined;
    if (BigInt(b.spendableZat) + BigInt(b.pendingChangeZat) + BigInt(b.pendingIncomingZat) < need) {
      return `the Sapling key holds ${b.spendableZat} zatoshis spendable (${b.pendingChangeZat + b.pendingIncomingZat} pending), a payment needs ${need}: get more from the faucet`;
    }
    if (Date.now() >= deadline) return `no spendable note within the wait: ${b.spendableZat} zatoshis spendable, ${b.pendingChangeZat + b.pendingIncomingZat} waiting for a block`;
    await sleep(5_000);
  }
}

/** The ZIP-317 fee the light client pays for one spend and two outputs (README "Private agents"). */
const LIGHT_FEE_ZAT = 10_000n;

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
/**
 * The command that splits the agent's coins, as plain text (a hint printed in a JSON line); the
 * placeholders KEY_FILE and HOST:PORT stand for the caller's key file and lightwalletd server.
 */
function splitHint(config: CliConfig | undefined): string {
  const words = ["no confirmed coin left; wait for a block or run: x402-ycash split --count 10 --wif-file KEY_FILE"];
  if (config?.lwd) words.push("--lwd HOST:PORT");
  words.push("--network", String(config?.network));
  return words.join(" ");
}

export async function runAgent(argv: string[], env: Record<string, string | undefined> = process.env, io: AgentIo, f: typeof fetch = fetch): Promise<number> {
  let config: CliConfig | undefined;
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const { help, budget: budgetRaw, address: addressFlag, wait: waitRaw, ...values } = parsed.values;
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
    // Plain http only to this machine: elsewhere a network path could rewrite /pricing and the 402s.
    if (base.protocol === "http:" && !/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(base.hostname)) throw new UsageError("<api-url> must be https (plain http only for localhost)");
    const builder = values["sapling-builder"] ?? env.X402_SAPLING_BUILDER;
    // The private tour pays with the light client alone: no WIF, no node, no lightwalletd of its own.
    const privateTour = builder !== undefined && builder !== "";
    if (privateTour && !/^https?:\/\//.test(builder)) throw new UsageError("--sapling-builder must be the http URL of x402-light serve");
    if (privateTour && (values["wif-file"] || values.lwd || values.devnet || values["rpc-url"])) throw new UsageError("--sapling-builder takes the private tour alone: leave out --wif-file, --lwd, --devnet and --rpc-url");
    if (!privateTour && !values["wif-file"] && !env.X402_WIF_FILE) throw new UsageError("--wif-file is required: the agent pays from a key file (or --sapling-builder for the private tour)");
    if (waitRaw !== undefined && !/^\d{1,5}$/.test(waitRaw)) throw new UsageError("--wait must be a whole number of seconds");
    const waitMs = (waitRaw === undefined ? 300 : Number(waitRaw)) * 1000;
    const cliEnv = privateTour ? { ...env, X402_WIF: undefined, X402_WIF_FILE: undefined, X402_LWD_URL: undefined, X402_DEVNET_JSON: undefined, X402_RPC_URL: undefined } : { ...env, X402_WIF: undefined };
    config = loadCliConfig({ command: ["pay", url], help: false, values: { network: "ycash:testnet", "max-payment": "20000", ...values } as Record<string, string | undefined> }, cliEnv);
    const budget = new Budget(zatOpt("--budget", budgetRaw, 100_000n));
    const network = config.network as YcashNetwork;
    const own = privateTour ? undefined : wifAddress(config.wif as string, config.network);
    const pricing = await pricingOf(base, config.network, f);
    const prefix = privateTour ? "/v1/private" : "/v1";
    if (privateTour && !pricing.routes.some((r) => r.payment === "sapling-proof")) throw new Error(`${base.origin} sells no private (sapling-proof) route: see its /pricing`);
    io.out({ msg: "pricing", api: base.origin, network: pricing.network, payTo: pricing.payTo, routes: pricing.routes.map((r) => `${r.method} ${r.path} ${r.priceZat} zat`) });

    const paying = buildClient(config);
    // The price /pricing names for the route being requested: a 402 asking more is refused.
    let routePrice: bigint | undefined;
    const priceOf = (method: string, template: string): bigint | undefined => {
      const r = pricing.routes.find((x) => x.method === method && x.path === template);
      return r && /^\d{1,16}$/.test(r.priceZat) ? BigInt(r.priceZat) : undefined;
    };
    // Pay only the advertised recipient, in YEC, on this network, at most the route's advertised price, within the budget.
    paying.client.onBeforePaymentCreation(async ({ selectedRequirements: r }: { selectedRequirements: PaymentRequirements }) => {
      const amount = BigInt(r.amount);
      if (r.network !== config?.network || r.asset !== ASSET_YEC) return { abort: true, reason: `refusing ${r.asset} on ${r.network}` };
      const method = r.extra?.assetTransferMethod ?? "transparent";
      if (privateTour) {
        // A private request's payTo is fresh per request: it can only be checked for its kind and network.
        if (method !== shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF) return { abort: true, reason: `the private tour pays sapling-proof only, not ${String(method)}` };
        if (!r.payTo.startsWith(shielded.SAPLING_HRP[network] + "1")) return { abort: true, reason: "the 402 names no Sapling address of this network" };
      } else if (r.payTo !== pricing.payTo) return { abort: true, reason: "the 402 names another recipient than /pricing" };
      if (routePrice === undefined) return { abort: true, reason: "/pricing names no price for this route" };
      if (amount > routePrice) return { abort: true, reason: `the 402 asks ${amount} zatoshis, /pricing says ${routePrice}` };
      if (!budget.allows(amount)) return { abort: true, reason: `budget: ${budget.spent} of ${budget.limit} zatoshis spent, this payment is ${amount}` };
      budget.spent += amount;
      return undefined;
    });
    const paid = wrapFetchWithPayment(f, paying.client);
    let failed = false;
    let outOfCoins = false;
    const get = async (path: string, template: string): Promise<Record<string, unknown> | undefined> => {
      if (outOfCoins) return undefined;
      path = prefix + path.slice("/v1".length);
      template = prefix + template.slice("/v1".length);
      routePrice = priceOf("GET", template);
      if (privateTour && config?.light && routePrice !== undefined) {
        const why = await waitSpendable(config.light, routePrice + LIGHT_FEE_ZAT, waitMs);
        if (why !== undefined) {
          failed = true;
          outOfCoins = true;
          io.out({ path, error: "no spendable note", hint: why, spentZat: budget.spent.toString() });
          return undefined;
        }
      }
      const t0 = performance.now();
      let res: Response;
      try {
        try {
          res = await paid(new URL(path, base), { signal: AbortSignal.timeout(180_000) });
        } catch (e) {
          // A block arrived between the light client's sync and its build: it refused before building
          // anything (nothing was sent), so the payment is uncounted, and tried once more after a sync.
          if (!(privateTour && config?.light && /is not the server's tip/.test((e as Error).message))) throw e;
          if (routePrice !== undefined) budget.spent -= routePrice;
          await config.light.sync().catch(() => undefined);
          res = await paid(new URL(path, base), { signal: AbortSignal.timeout(180_000) });
        }
      } catch (e) {
        failed = true;
        const message = (e as Error).message;
        if (/insufficient funds|no confirmed coin/i.test(message)) {
          // Over lightwalletd only confirmed coins can be spent, one payment per coin until the next block.
          outOfCoins = true;
          io.out({ path, error: "no confirmed coin left", hint: splitHint(config), spentZat: budget.spent.toString() });
          return undefined;
        }
        io.out({ path, error: message, spentZat: budget.spent.toString() });
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

    const chain = await get("/v1/chain", "/v1/chain");
    const tip = typeof chain?.blocks === "number" ? chain.blocks : undefined;
    const block = tip !== undefined ? await get(`/v1/block/${tip}`, "/v1/block/:id") : undefined;
    const txid = Array.isArray(block?.tx) && typeof block.tx[0] === "string" && /^[0-9a-f]{64}$/i.test(block.tx[0]) ? block.tx[0] : undefined;
    if (txid) await get(`/v1/tx/${txid}`, "/v1/tx/:txid");
    await get(`/v1/address/${encodeURIComponent(addressFlag ?? own ?? pricing.payTo)}`, "/v1/address/:address");
    await get("/v1/yellowback", "/v1/yellowback");
    io.out({ msg: "done", spentZat: budget.spent.toString(), budgetZat: budget.limit.toString(), payer: own ?? "a Sapling key (x402-light)" });
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
