// Service configuration: an optional JSON file (X402_FACILITATOR_CONFIG), overridden key by key by
// environment variables, validated once at startup. A bad value stops the service before it binds.
import { readFileSync } from "node:fs";
import { z } from "@x402/core/schemas";
import { YCASH_NETWORKS, type YcashNetwork } from "x402-ycash-mechanism";
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

export interface FacilitatorConfig {
  host: string;
  port: number;
  network: YcashNetwork;
  rpc: RpcSource;
  settlementStorePath: string;
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
    bodyLimit: strEnv(env, "X402_BODY_LIMIT") ?? file.bodyLimit ?? DEFAULTS.bodyLimit,
    logLevel: strEnv(env, "X402_LOG_LEVEL") ?? file.logLevel ?? DEFAULTS.logLevel,
    shutdownTimeoutMs: intEnv(env, "X402_SHUTDOWN_TIMEOUT_MS") ?? file.shutdownTimeoutMs ?? DEFAULTS.shutdownTimeoutMs,
    nodeWaitMs: intEnv(env, "X402_NODE_WAIT_MS") ?? file.nodeWaitMs ?? DEFAULTS.nodeWaitMs,
    apiKey: strEnv(env, "X402_API_KEY") ?? file.apiKey,
  };
  // Re-validate the merged values with the file schema so env and file obey one set of rules.
  const checked = fileSchema.safeParse(Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)));
  if (!checked.success) throw new ConfigError(issues(checked.error));

  return {
    ...merged,
    logLevel: merged.logLevel as LogLevel,
    network: network as YcashNetwork,
    rpc,
    confirmations: conf.data,
  };
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
  const { apiKey, ...rest } = c;
  return { ...rest, rpc, apiKey: apiKey ? "(set)" : "(unset)" };
}
