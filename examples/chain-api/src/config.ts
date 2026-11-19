// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The chain-data API's configuration, from the environment, validated once at startup. The service
// holds no spending key: `payTo` is an address of a wallet the operator controls elsewhere (on the
// fast testnet, the faucet's wallet, so spent coins flow back to it; x402 demonstrations note D-4).
// The private routes (`sapling-proof`) need that wallet on the API's node: the node issues each
// request's Sapling address from a base address it holds; the API itself still holds no key.
import { shielded, tx, YCASH_MAINNET, YCASH_NETWORKS, YCASH_REGTEST, YCASH_TESTNET, YcashRpc, type YcashNetwork } from "x402-ycash-mechanism";

/** Where the API reads the chain: the host node over JSON-RPC (cookie or user + password), or a devnet node (tests). */
export type NodeSource =
  | { kind: "cookie"; url: string; cookieFile: string }
  | { kind: "password"; url: string; user: string; password: string }
  | { kind: "devnet"; path: string; node: number };

export interface RateLimits {
  /** Requests without a PAYMENT-SIGNATURE per client address per minute (each 402 costs us a challenge). */
  unpaidPerMinute: number;
  /** Requests carrying a payment per client address per minute (each costs the facilitator a verify). */
  paidPerMinute: number;
  /** `/`, `/pricing`, `/healthz` per client address per minute. */
  freePerMinute: number;
  /** Paid relay attempts (`/v1/broadcast`) per client address per minute, within the paid limit. */
  relayPerMinute: number;
}

/** Links shown in /pricing for people and agents (never fetched by the service). */
export interface Links {
  faucet?: string;
  explorer?: string;
  lightwalletd?: string;
  source?: string;
}

export interface ChainApiConfig {
  host: string;
  port: number;
  network: YcashNetwork;
  /** The testnet profile the node must report on ycash:testnet (D-6); undefined on regtest. */
  testnetProfile?: "fast";
  /** Regtest/devnet allowed (API_ALLOW_REGTEST=1): tests and local demonstrations only. */
  allowRegtest: boolean;
  node: NodeSource;
  /** Node RPC timeout per call, ms. */
  rpcTimeoutMs: number;
  facilitatorUrl: string;
  facilitatorApiKey?: string;
  /** The transparent address every payment goes to. */
  payTo: string;
  /** The price of each paid read, zatoshis (D-10: 0.0001 testnet YEC). */
  priceZat: bigint;
  /** The price of the paid relay, zatoshis. */
  priceBroadcastZat: bigint;
  /** exact payments up to this many zatoshis settle on mempool acceptance (D-10: 0.001 YEC). */
  zeroConfCapZat: bigint;
  /** Paid requests in progress at once, over all clients; more get 503 before any verify (S1). */
  maxInflight: number;
  /** How long a used payment stays refused, ms (longer than a payment transaction's validity). */
  claimTtlMs: number;
  /** The most payments remembered at once (fail closed when full). */
  maxClaims: number;
  /** How many blocks back the address history looks (bounds the node's work per paid request). */
  historyWindowBlocks: number;
  limits: RateLimits;
  /** Reverse-proxy hops in front of the API (Caddy on the host: 1). */
  trustProxy: number;
  links: Links;
  /** The private routes (`sapling-proof`); undefined = not sold. */
  shielded?: ShieldedApiConfig;
}

/**
 * The private routes' setup (`sapling-proof`, x402-ycash README "Private payments"). The node is the
 * merchant's wallet: it issues a fresh diversified address of `baseAddress` per request
 * (`z_getnewdiversifiedaddress`), and the self-hosted facilitator on the same wallet finds the note.
 */
export interface ShieldedApiConfig {
  /** The issued-address registry file, shared with the facilitator (its X402_ISSUED_REGISTRY). */
  registryPath: string;
  /** A Sapling address whose spending key the node's wallet holds (checked at startup). */
  baseAddress: string;
  /** The confirmation policy each request carries: −1 (the mempool) to 20. */
  confirmations: number;
  /** The price of each private read, zatoshis. */
  priceZat: bigint;
  /** The most issued requests held at once (each unpaid 402 issues one); then 503. */
  maxOutstanding: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const str = (env: Env, name: string): string | undefined => {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
};

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const v = str(env, name);
  if (v === undefined) return fallback;
  if (!/^\d{1,9}$/.test(v) || Number(v) < min || Number(v) > max) throw new ConfigError(`${name} must be an integer in ${min}..${max}`);
  return Number(v);
}

function zat(env: Env, name: string, fallback: string): bigint {
  const v = str(env, name) ?? fallback;
  if (!/^[1-9]\d{0,15}$/.test(v)) throw new ConfigError(`${name} must be a positive whole number of zatoshis`);
  return BigInt(v);
}

function flag(env: Env, name: string): boolean {
  const v = str(env, name);
  if (v === undefined || v === "0") return false;
  if (v === "1") return true;
  throw new ConfigError(`${name} must be 0 or 1`);
}

function httpUrl(name: string, v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`${name} must be an http(s) URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError(`${name} must be an http(s) URL`);
  if (u.username || u.password) throw new ConfigError(`${name} must not carry credentials in the URL`);
  return v;
}

function nodeOf(env: Env): NodeSource {
  const devnet = str(env, "API_DEVNET_JSON");
  if (devnet) return { kind: "devnet", path: devnet, node: int(env, "API_DEVNET_NODE", 0, 0, 64) };
  const url = str(env, "API_RPC_URL");
  if (!url) throw new ConfigError("no node: set API_RPC_URL with API_RPC_COOKIE_FILE (or API_RPC_USER and API_RPC_PASSWORD)");
  httpUrl("API_RPC_URL", url);
  const cookieFile = str(env, "API_RPC_COOKIE_FILE");
  if (cookieFile) return { kind: "cookie", url, cookieFile };
  const user = str(env, "API_RPC_USER");
  const password = str(env, "API_RPC_PASSWORD");
  if (!user || !password) throw new ConfigError("API_RPC_URL needs API_RPC_COOKIE_FILE, or API_RPC_USER and API_RPC_PASSWORD");
  return { kind: "password", url, user, password };
}

function linksOf(env: Env): Links {
  const out: Links = {};
  for (const [key, name] of [["faucet", "API_LINK_FAUCET"], ["explorer", "API_LINK_EXPLORER"], ["lightwalletd", "API_LINK_LIGHTWALLETD"], ["source", "API_LINK_SOURCE"]] as const) {
    const v = str(env, name);
    if (v === undefined) continue;
    // lightwalletd is a gRPC host:port, shown as given; the others are web pages.
    if (key === "lightwalletd") {
      if (!/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(v)) throw new ConfigError(`${name} must be host or host:port`);
      out[key] = v;
    } else out[key] = httpUrl(name, v);
  }
  return out;
}

/**
 * The private routes' setup: on when API_ISSUED_REGISTRY is set; the base address is then required.
 *
 * @param env - The environment.
 * @param network - The API's network.
 * @param priceZat - The transparent price, the default of the private one.
 * @returns The setup, or undefined when the private routes are off.
 */
function shieldedOf(env: Env, network: YcashNetwork, priceZat: bigint): ShieldedApiConfig | undefined {
  const registryPath = str(env, "API_ISSUED_REGISTRY");
  const baseAddress = str(env, "API_SAPLING_BASE_ADDRESS");
  if (!registryPath) {
    for (const name of ["API_SAPLING_BASE_ADDRESS", "API_SHIELDED_CONFIRMATIONS", "API_PRICE_SHIELDED_ZAT", "API_SHIELDED_MAX_OUTSTANDING"]) {
      if (str(env, name) !== undefined) throw new ConfigError(`${name} is for the private routes, which need API_ISSUED_REGISTRY (the facilitator's X402_ISSUED_REGISTRY)`);
    }
    return undefined;
  }
  if (!baseAddress) throw new ConfigError("the private routes (API_ISSUED_REGISTRY) need API_SAPLING_BASE_ADDRESS, a Sapling address of the node's wallet");
  const hrp = shielded.SAPLING_HRP[network] + "1";
  if (!baseAddress.startsWith(hrp) || !/^[a-z0-9]{1,200}$/.test(baseAddress)) throw new ConfigError(`API_SAPLING_BASE_ADDRESS must be a ${network} Sapling address (${hrp}…)`);
  const rawConf = str(env, "API_SHIELDED_CONFIRMATIONS");
  if (rawConf !== undefined && !/^(-1|\d{1,2})$/.test(rawConf)) throw new ConfigError("API_SHIELDED_CONFIRMATIONS must be an integer in -1..20");
  const confirmations = rawConf === undefined ? 1 : Number(rawConf);
  if (confirmations > 20) throw new ConfigError("API_SHIELDED_CONFIRMATIONS must be an integer in -1..20");
  return {
    registryPath,
    baseAddress,
    confirmations,
    priceZat: zat(env, "API_PRICE_SHIELDED_ZAT", priceZat.toString()),
    maxOutstanding: int(env, "API_SHIELDED_MAX_OUTSTANDING", 1000, 1, 1_000_000),
  };
}

/**
 * Reads and checks the configuration.
 *
 * @param env - The environment.
 * @returns The configuration.
 * @throws ConfigError on any missing or bad value; mainnet is refused (D-9: after the X6 runbook).
 */
export function loadChainApiConfig(env: Env = process.env): ChainApiConfig {
  const network = (str(env, "X402_NETWORK") ?? YCASH_TESTNET) as YcashNetwork;
  if (!YCASH_NETWORKS.includes(network)) throw new ConfigError(`X402_NETWORK must be one of ${YCASH_NETWORKS.join(", ")}`);
  if (network === YCASH_MAINNET) throw new ConfigError("ycash:mainnet is not served yet: the mainnet API follows the X6 runbook (x402 demonstrations note, D-9)");
  const allowRegtest = flag(env, "API_ALLOW_REGTEST");
  if (network === YCASH_REGTEST && !allowRegtest) throw new ConfigError("ycash:regtest needs API_ALLOW_REGTEST=1 (tests and local devnets only)");

  const payTo = str(env, "API_PAY_TO");
  if (!payTo) throw new ConfigError("API_PAY_TO (the transparent address payments go to, e.g. the faucet's) is required");
  let kind: string;
  try {
    kind = tx.decodeAddress(payTo, network).kind;
  } catch (e) {
    throw new ConfigError(`API_PAY_TO: ${(e as Error).message}`);
  }
  if (kind !== "p2pkh") throw new ConfigError("API_PAY_TO must be a transparent P2PKH address of this network");

  const port = int(env, "PORT", 4021, 0, 65535);
  const priceZat = zat(env, "API_PRICE_ZAT", "10000");
  const zeroConfCapZat = zat(env, "API_ZERO_CONF_CAP_ZAT", "100000");
  const facilitatorUrl = httpUrl("FACILITATOR_URL", str(env, "FACILITATOR_URL") ?? "http://127.0.0.1:4022");
  const apiKey = str(env, "FACILITATOR_API_KEY");
  const shieldedConfig = shieldedOf(env, network, priceZat);
  return {
    host: str(env, "HOST") ?? "127.0.0.1",
    port,
    network,
    ...(network === YCASH_TESTNET ? { testnetProfile: "fast" as const } : {}),
    allowRegtest,
    node: nodeOf(env),
    rpcTimeoutMs: int(env, "API_RPC_TIMEOUT_MS", 15_000, 1_000, 120_000),
    facilitatorUrl,
    ...(apiKey ? { facilitatorApiKey: apiKey } : {}),
    payTo,
    priceZat,
    priceBroadcastZat: zat(env, "API_PRICE_BROADCAST_ZAT", priceZat.toString()),
    zeroConfCapZat,
    historyWindowBlocks: int(env, "API_HISTORY_WINDOW_BLOCKS", 10_000, 1, 1_000_000),
    limits: {
      unpaidPerMinute: int(env, "API_UNPAID_PER_MINUTE", 30, 1, 100_000),
      paidPerMinute: int(env, "API_PAID_PER_MINUTE", 120, 1, 100_000),
      freePerMinute: int(env, "API_FREE_PER_MINUTE", 120, 1, 100_000),
      relayPerMinute: int(env, "API_RELAY_PER_MINUTE", 10, 1, 100_000),
    },
    maxInflight: int(env, "API_MAX_INFLIGHT", 16, 1, 10_000),
    claimTtlMs: int(env, "API_CLAIM_TTL_SECONDS", 7_200, 60, 604_800) * 1000,
    maxClaims: int(env, "API_MAX_CLAIMS", 100_000, 10, 10_000_000),
    trustProxy: int(env, "API_TRUST_PROXY", 0, 0, 10),
    links: linksOf(env),
    ...(shieldedConfig ? { shielded: shieldedConfig } : {}),
  };
}

/**
 * The RPC client for the configured node.
 *
 * @param c - The configuration.
 * @returns A client: read RPCs and sendrawtransaction, and with the private routes the two wallet calls
 *   that issue addresses (z_validateaddress at startup, z_getnewdiversifiedaddress per 402).
 */
export function rpcOf(c: ChainApiConfig): YcashRpc {
  const timeout = { timeoutMs: c.rpcTimeoutMs };
  switch (c.node.kind) {
    case "devnet":
      return YcashRpc.fromDevnetJson(c.node.path, c.node.node, timeout);
    case "cookie":
      return new YcashRpc({ url: c.node.url, cookieFile: c.node.cookieFile, ...timeout });
    case "password":
      return new YcashRpc({ url: c.node.url, user: c.node.user, password: c.node.password, ...timeout });
  }
}

/** What the startup line may show: no password, no API key. */
export function describeConfig(c: ChainApiConfig): Record<string, unknown> {
  return {
    network: c.network,
    testnetProfile: c.testnetProfile ?? "(none)",
    node: c.node.kind === "devnet" ? `devnet ${c.node.path}#${c.node.node}` : c.node.url,
    facilitator: c.facilitatorUrl,
    facilitatorApiKey: c.facilitatorApiKey ? "(set)" : "(none)",
    payTo: c.payTo,
    priceZat: c.priceZat.toString(),
    priceBroadcastZat: c.priceBroadcastZat.toString(),
    zeroConfCapZat: c.zeroConfCapZat.toString(),
    limits: c.limits,
    trustProxy: c.trustProxy,
    shielded: c.shielded
      ? { registry: c.shielded.registryPath, baseAddress: c.shielded.baseAddress, confirmations: c.shielded.confirmations, priceZat: c.shielded.priceZat.toString(), maxOutstanding: c.shielded.maxOutstanding }
      : "(off)",
  };
}
