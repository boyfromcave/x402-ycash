// Service configuration: an optional JSON file (X402_FACILITATOR_CONFIG), overridden key by key by
// environment variables, validated once at startup. A bad value stops the service before it binds.
import { readFileSync } from "node:fs";
import { z } from "@x402/core/schemas";
import { shielded, YCASH_NETWORKS, type YcashNetwork } from "x402-ycash-mechanism";
import { LOG_LEVELS, type LogLevel } from "./logger.js";

/** The confirmation range this facilitator settles (plan §5.5; scheme_exact_ycash.md "Confirmation policy"). */
export interface ConfirmationLimits {
  minimum: number;
  maximum: number;
}

export type RpcSource =
  | { kind: "password"; url: string; user: string; password: string; timeoutMs?: number }
  | { kind: "cookie"; url: string; cookieFile: string; timeoutMs?: number }
  | { kind: "devnet"; path: string; node: number; timeoutMs?: number };

/**
 * The self-hosted `sapling-proof` method (scheme_exact_ycash.md "Viewing-key custody"): the node is
 * the merchant's wallet, and the registry file is the one the merchant's server issues into.
 */
export interface SaplingProofConfig {
  /** The merchant's base Sapling address; default: the wallet makes one (`z_getnewaddress sapling`). */
  baseAddress?: string;
  /** The receipt key: 32-byte secp256k1 private key, 64 hex characters. A secret. */
  receiptKey: string;
  /** The issued-address registry file shared with the merchant's server. */
  registryPath: string;
  /** How long settle waits for a just-sent note to reach the wallet (default 10 s). */
  noteWaitMs?: number;
  /**
   * Set for the viewing-key setup: the merchant's server issues addresses offline from this key,
   * and the node holds only the key (`z_importviewingkey`), which startup checks.
   */
  offlineIssuer?: OfflineIssuerConfig;
}

/** The offline issuer (OfflineAddressIssuer): the viewing key, its first index and its index file. */
export interface OfflineIssuerConfig {
  /** The merchant's `zxview…` key, of the configured network. */
  viewingKey: string;
  /** The first diversifier index when the index file is new (default 2^40). */
  startIndex: bigint;
  /** Where the next index is kept. */
  indexPath: string;
}

export interface FacilitatorConfig {
  host: string;
  port: number;
  network: YcashNetwork;
  rpc: RpcSource;
  settlementStorePath: string;
  /** The batch-settlement facilitator's channel audit file (FileChannelStore). */
  channelStorePath: string;
  /** Set when sapling-proof is configured (receipt key and registry path both given). */
  saplingProof?: SaplingProofConfig;
  confirmations: ConfirmationLimits;
  /** express.json body limit, e.g. "512kb": a transparent tx of a few hundred inputs fits. */
  bodyLimit: string;
  logLevel: LogLevel;
  /** How long in-flight requests (a settle mid-broadcast) may run after SIGTERM. */
  shutdownTimeoutMs: number;
  /** How long to wait for the node at startup before giving up. */
  nodeWaitMs: number;
  /** When set, /verify and /settle require `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
}

// Spec range for `confirmationPolicy.confirmations`: −1 (mempool) to 20.
const CONF_MIN = -1;
const CONF_MAX = 20;

const confirmationsSchema = z
  .object({
    minimum: z.number().int().min(CONF_MIN).max(CONF_MAX),
    maximum: z.number().int().min(CONF_MIN).max(CONF_MAX),
  })
  .strict()
  .refine(c => c.minimum <= c.maximum, { message: "confirmations.minimum must not exceed maximum" });

const timeoutMs = z.number().int().positive().optional();

const rpcSchema = z.union([
  z.object({ url: z.string().url(), user: z.string().min(1), password: z.string().min(1), timeoutMs }).strict(),
  z.object({ url: z.string().url(), cookieFile: z.string().min(1), timeoutMs }).strict(),
]);

const devnetSchema = z.object({ path: z.string().min(1), node: z.number().int().min(0).default(0), timeoutMs }).strict();

/** The JSON file's shape; every key optional so env can supply it. */
const fileSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(0).max(65535),
    network: z.string(),
    rpc: rpcSchema,
    devnet: devnetSchema,
    settlementStorePath: z.string().min(1),
    channelStorePath: z.string().min(1),
    saplingBaseAddress: z.string().min(1),
    receiptKey: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters"),
    issuedAddressRegistryPath: z.string().min(1),
    saplingNoteWaitMs: z.number().int().min(0).max(60_000),
    saplingIssuer: z.enum(["node-wallet", "offline"]),
    saplingViewingKey: z.string().min(1),
    saplingStartIndex: z.string().regex(/^\d{1,27}$/, "must be a decimal diversifier index"),
    saplingIndexPath: z.string().min(1),
    confirmations: confirmationsSchema,
    bodyLimit: z.string().regex(/^\d+(b|kb|mb)$/),
    logLevel: z.enum(LOG_LEVELS as [LogLevel, ...LogLevel[]]),
    shutdownTimeoutMs: z.number().int().min(0),
    nodeWaitMs: z.number().int().min(0),
    apiKey: z.string().min(16),
  })
  .partial()
  .strict();

export type FacilitatorConfigFile = z.input<typeof fileSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 4022,
  settlementStorePath: "x402-ycash-settlements.json",
  channelStorePath: "x402-ycash-channels.json",
  // −1 is opt-in for the operator (the spec's "MAY refuse −1 unless its operator opted in").
  confirmations: { minimum: 0, maximum: CONF_MAX },
  bodyLimit: "512kb",
  logLevel: "info" as LogLevel,
  shutdownTimeoutMs: 30_000,
  nodeWaitMs: 60_000,
} as const;

type Env = Record<string, string | undefined>;

function intEnv(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function strEnv(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

function issues(e: z.ZodError): string {
  return e.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Reads the environment (and the JSON file it names); throws ConfigError with every problem found. */
export function loadConfig(env: Env = process.env): FacilitatorConfig {
  let file: z.output<typeof fileSchema> = {};
  const path = strEnv(env, "X402_FACILITATOR_CONFIG");
  if (path) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new ConfigError(`cannot read ${path}: ${(e as Error).message}`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw new ConfigError(`${path}: ${issues(parsed.error)}`);
    file = parsed.data;
  }
  return resolveConfig(file, env);
}

/** Merges a parsed file with env overrides and applies defaults; exported for tests. */
export function resolveConfig(file: z.output<typeof fileSchema>, env: Env): FacilitatorConfig {
  const network = strEnv(env, "X402_NETWORK") ?? file.network;
  if (!network) throw new ConfigError("X402_NETWORK (or `network`) is required: one of " + YCASH_NETWORKS.join(", "));
  if (!(YCASH_NETWORKS as readonly string[]).includes(network)) {
    throw new ConfigError(`unknown network ${JSON.stringify(network)}: one of ${YCASH_NETWORKS.join(", ")}`);
  }

  const rpc = resolveRpc(file, env);

  const confirmations = {
    minimum: intEnv(env, "X402_CONFIRMATIONS_MIN") ?? file.confirmations?.minimum ?? DEFAULTS.confirmations.minimum,
    maximum: intEnv(env, "X402_CONFIRMATIONS_MAX") ?? file.confirmations?.maximum ?? DEFAULTS.confirmations.maximum,
  };
  const conf = confirmationsSchema.safeParse(confirmations);
  if (!conf.success) throw new ConfigError(`confirmations: ${issues(conf.error)}`);

  const merged = {
    host: strEnv(env, "X402_HOST") ?? file.host ?? DEFAULTS.host,
    port: intEnv(env, "X402_PORT") ?? intEnv(env, "PORT") ?? file.port ?? DEFAULTS.port,
    settlementStorePath: strEnv(env, "X402_SETTLEMENT_STORE") ?? file.settlementStorePath ?? DEFAULTS.settlementStorePath,
    channelStorePath: strEnv(env, "X402_CHANNEL_STORE") ?? file.channelStorePath ?? DEFAULTS.channelStorePath,
    bodyLimit: strEnv(env, "X402_BODY_LIMIT") ?? file.bodyLimit ?? DEFAULTS.bodyLimit,
    logLevel: strEnv(env, "X402_LOG_LEVEL") ?? file.logLevel ?? DEFAULTS.logLevel,
    shutdownTimeoutMs: intEnv(env, "X402_SHUTDOWN_TIMEOUT_MS") ?? file.shutdownTimeoutMs ?? DEFAULTS.shutdownTimeoutMs,
    nodeWaitMs: intEnv(env, "X402_NODE_WAIT_MS") ?? file.nodeWaitMs ?? DEFAULTS.nodeWaitMs,
    apiKey: strEnv(env, "X402_API_KEY") ?? file.apiKey,
  };
  // Re-validate the merged values with the file schema so env and file obey one set of rules.
  const checked = fileSchema.safeParse(Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)));
  if (!checked.success) throw new ConfigError(issues(checked.error));

  const saplingProof = resolveSaplingProof(file, env, network as YcashNetwork);
  return {
    ...merged,
    logLevel: merged.logLevel as LogLevel,
    network: network as YcashNetwork,
    rpc,
    confirmations: conf.data,
    ...(saplingProof ? { saplingProof } : {}),
  };
}

/** secp256k1's group order: a receipt key must be in [1, n − 1]. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** sapling-proof is on when a receipt key and a registry path are both given; one alone is an error. */
function resolveSaplingProof(file: z.output<typeof fileSchema>, env: Env, network: YcashNetwork): SaplingProofConfig | undefined {
  const receiptKey = strEnv(env, "X402_RECEIPT_KEY") ?? file.receiptKey;
  const registryPath = strEnv(env, "X402_ISSUED_REGISTRY") ?? file.issuedAddressRegistryPath;
  const baseAddress = strEnv(env, "X402_SAPLING_BASE_ADDRESS") ?? file.saplingBaseAddress;
  if (!receiptKey && !registryPath && !baseAddress && !strEnv(env, "X402_SAPLING_VIEWING_KEY") && !file.saplingViewingKey) return undefined;
  if (!receiptKey || !registryPath) {
    throw new ConfigError("sapling-proof needs both X402_RECEIPT_KEY (receiptKey) and X402_ISSUED_REGISTRY (issuedAddressRegistryPath)");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(receiptKey)) throw new ConfigError("X402_RECEIPT_KEY must be 64 hex characters (a secp256k1 private key)");
  const k = BigInt("0x" + receiptKey);
  if (k === 0n || k >= SECP256K1_N) throw new ConfigError("X402_RECEIPT_KEY is not a valid secp256k1 private key");
  // The network comes from config; a base address of another network's HRP is a wrong wallet (X-F1).
  const hrp = shielded.SAPLING_HRP[network] + "1";
  if (baseAddress && !baseAddress.startsWith(hrp)) throw new ConfigError(`X402_SAPLING_BASE_ADDRESS must be a ${network} Sapling address (${hrp}…)`);
  const noteWaitMs = intEnv(env, "X402_SAPLING_NOTE_WAIT_MS") ?? file.saplingNoteWaitMs;
  if (noteWaitMs !== undefined && (noteWaitMs < 0 || noteWaitMs > 60_000)) throw new ConfigError("X402_SAPLING_NOTE_WAIT_MS must be 0..60000");
  const offlineIssuer = resolveOfflineIssuer(file, env, network);
  if (offlineIssuer && baseAddress) throw new ConfigError("X402_SAPLING_BASE_ADDRESS is for the node-wallet issuer; the offline issuer derives from X402_SAPLING_VIEWING_KEY");
  return {
    receiptKey: receiptKey.toLowerCase(),
    registryPath,
    ...(baseAddress ? { baseAddress } : {}),
    ...(noteWaitMs !== undefined ? { noteWaitMs } : {}),
    ...(offlineIssuer ? { offlineIssuer } : {}),
  };
}

/** Default index file of the offline issuer. */
export const DEFAULT_SAPLING_INDEX_PATH = "x402-ycash-sapling-index.json";

/**
 * The offline issuer's settings, when X402_SAPLING_ISSUER (saplingIssuer) is "offline".
 *
 * @param file - The parsed config file.
 * @param env - The environment, which overrides the file key by key.
 * @param network - The configured network; the viewing key must be of it.
 * @returns The offline issuer's config, or undefined for the node-wallet issuer.
 * @throws {ConfigError} On a missing or invalid viewing key or start index.
 */
function resolveOfflineIssuer(file: z.output<typeof fileSchema>, env: Env, network: YcashNetwork): OfflineIssuerConfig | undefined {
  const kind = strEnv(env, "X402_SAPLING_ISSUER") ?? file.saplingIssuer ?? "node-wallet";
  if (kind !== "node-wallet" && kind !== "offline") throw new ConfigError(`X402_SAPLING_ISSUER must be "node-wallet" or "offline", got ${JSON.stringify(kind)}`);
  const viewingKey = strEnv(env, "X402_SAPLING_VIEWING_KEY") ?? file.saplingViewingKey;
  if (kind === "node-wallet") {
    if (viewingKey) throw new ConfigError('X402_SAPLING_VIEWING_KEY needs X402_SAPLING_ISSUER="offline"');
    return undefined;
  }
  if (!viewingKey) throw new ConfigError("the offline issuer needs X402_SAPLING_VIEWING_KEY (saplingViewingKey), the merchant's zxview… key");
  const rawStart = strEnv(env, "X402_SAPLING_START_INDEX") ?? file.saplingStartIndex;
  if (rawStart !== undefined && !/^\d{1,27}$/.test(rawStart)) throw new ConfigError("X402_SAPLING_START_INDEX must be a decimal diversifier index");
  const startIndex = rawStart === undefined ? shielded.OFFLINE_ISSUER_DEFAULT_START : BigInt(rawStart);
  if (startIndex < shielded.OFFLINE_ISSUER_MIN_START || startIndex > shielded.MAX_DIVERSIFIER_INDEX) {
    throw new ConfigError("X402_SAPLING_START_INDEX must be in [2^32, 2^88): the node wallets walk the low indices");
  }
  try {
    shielded.decodeSaplingViewingKey(viewingKey, network);
  } catch (e) {
    throw new ConfigError(`X402_SAPLING_VIEWING_KEY: ${(e as Error).message}`);
  }
  return { viewingKey, startIndex, indexPath: strEnv(env, "X402_SAPLING_INDEX_FILE") ?? file.saplingIndexPath ?? DEFAULT_SAPLING_INDEX_PATH };
}

function resolveRpc(file: z.output<typeof fileSchema>, env: Env): RpcSource {
  const t = intEnv(env, "X402_RPC_TIMEOUT_MS");
  const withTimeout = <T extends object>(o: T, fallback?: number): T & { timeoutMs?: number } => {
    const ms = t ?? fallback;
    return ms === undefined ? o : { ...o, timeoutMs: ms };
  };

  const devnetPath = strEnv(env, "X402_DEVNET_JSON");
  if (devnetPath) return withTimeout({ kind: "devnet", path: devnetPath, node: intEnv(env, "X402_DEVNET_NODE") ?? 0 });

  const url = strEnv(env, "X402_RPC_URL");
  if (url) {
    const cookieFile = strEnv(env, "X402_RPC_COOKIE_FILE");
    if (cookieFile) return withTimeout({ kind: "cookie", url, cookieFile });
    const user = strEnv(env, "X402_RPC_USER");
    const password = strEnv(env, "X402_RPC_PASSWORD");
    if (!user || !password) throw new ConfigError("X402_RPC_URL needs X402_RPC_USER and X402_RPC_PASSWORD, or X402_RPC_COOKIE_FILE");
    return withTimeout({ kind: "password", url, user, password });
  }

  if (file.devnet) return withTimeout({ kind: "devnet", path: file.devnet.path, node: file.devnet.node }, file.devnet.timeoutMs);
  if (file.rpc) {
    if ("cookieFile" in file.rpc) return withTimeout({ kind: "cookie", url: file.rpc.url, cookieFile: file.rpc.cookieFile }, file.rpc.timeoutMs);
    return withTimeout({ kind: "password", url: file.rpc.url, user: file.rpc.user, password: file.rpc.password }, file.rpc.timeoutMs);
  }
  throw new ConfigError("no node RPC configured: set X402_RPC_URL (+ user/password or cookie file) or X402_DEVNET_JSON");
}

/** The config with secrets removed, for the startup log line. */
export function redactConfig(c: FacilitatorConfig): Record<string, unknown> {
  const rpc =
    c.rpc.kind === "password"
      ? { kind: c.rpc.kind, url: c.rpc.url, user: c.rpc.user }
      : c.rpc.kind === "cookie"
        ? { kind: c.rpc.kind, url: c.rpc.url, cookieFile: c.rpc.cookieFile }
        : { kind: c.rpc.kind, path: c.rpc.path, node: c.rpc.node };
  const { apiKey, saplingProof, ...rest } = c;
  return {
    ...rest,
    rpc,
    apiKey: apiKey ? "(set)" : "(unset)",
    saplingProof: saplingProof
      ? {
          issuer: saplingProof.offlineIssuer ? { kind: "offline", startIndex: saplingProof.offlineIssuer.startIndex.toString(), indexPath: saplingProof.offlineIssuer.indexPath, viewingKey: "(set)" } : { kind: "node-wallet", baseAddress: saplingProof.baseAddress ?? "(wallet)" },
          registryPath: saplingProof.registryPath,
          noteWaitMs: saplingProof.noteWaitMs,
          receiptKey: "(set)",
        }
      : "(off)",
  };
}
