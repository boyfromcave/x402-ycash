// Merchant configuration from the environment.
import { shielded, tx, YCASH_NETWORKS, YcashRpc, type YcashNetwork } from "x402-ycash-mechanism";

/** The YEC payment-channel route (batch-settlement): the server key S and the channel terms. */
export interface ChannelConfig {
  /** S's private key. A secret: it completes every voucher. */
  serverPrivKey: Uint8Array;
  /** The largest deposit D accepted, zatoshis. */
  maxDeposit: bigint;
  /** The server's channel store (FileChannelStore): the voucher watermark survives a restart. */
  storePath: string;
  minLockBlocks?: number;
  closeMarginBlocks?: number;
  /** The funding policy depth: −1 (mempool, a YEC opt-in) to 20; default 1. */
  confirmations: number;
  /** Close a channel after this long without a request. */
  idleMs?: number;
  /** How long an `open` request waits for the funding depth before answering funding_depth. */
  fundingWaitMs: number;
  /** The close watcher's poll interval. */
  watcherPollMs: number;
}

/** The shielded route (sapling-proof): the registry the self-hosted facilitator reads too. */
export interface ShieldedConfig {
  /** The issued-address registry file, shared with the facilitator (X402_ISSUED_REGISTRY there). */
  registryPath: string;
  /** The merchant's base Sapling address; default: the wallet makes one. */
  baseAddress?: string;
  /** The policy each issued request carries: −1 to 20; default 1. */
  confirmations: number;
}

export interface MerchantConfig {
  host: string;
  port: number;
  network: YcashNetwork;
  facilitatorUrl: string;
  facilitatorApiKey?: string;
  /** Transparent `s1…` (mainnet) or `sm…` (testnet, regtest) address receiving exact and channel payments. */
  payTo: string;
  /** Prices in zatoshis. */
  priceExactZat: string;
  priceTickerZat: string;
  priceChannelZat: string;
  priceShieldedZat: string;
  /** exact YEC payments up to this many zatoshis default to policy −1 (default: the ticker price). */
  zeroConfCapZat: bigint;
  /** The merchant's node: the channel server's chain view, and the wallet that issues shielded addresses. */
  wallet?: YcashRpc;
  channel?: ChannelConfig;
  shielded?: ShieldedConfig;
}

type Env = Record<string, string | undefined>;

function zat(env: Env, name: string, fallback: string): string {
  const v = env[name] ?? fallback;
  if (!/^[1-9]\d{0,15}$/.test(v)) throw new Error(`${name} must be a positive whole number of zatoshis`);
  return v;
}

function int(env: Env, name: string, min: number, max: number): number | undefined {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  if (!/^-?\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return Number(v);
}

function nodeOf(env: Env): YcashRpc | undefined {
  if (env.MERCHANT_DEVNET_JSON) return YcashRpc.fromDevnetJson(env.MERCHANT_DEVNET_JSON, Number(env.MERCHANT_DEVNET_NODE ?? "0"));
  if (env.MERCHANT_RPC_URL && env.MERCHANT_RPC_COOKIE_FILE) return new YcashRpc({ url: env.MERCHANT_RPC_URL, cookieFile: env.MERCHANT_RPC_COOKIE_FILE });
  if (env.MERCHANT_RPC_URL && env.MERCHANT_RPC_USER && env.MERCHANT_RPC_PASSWORD) {
    return new YcashRpc({ url: env.MERCHANT_RPC_URL, user: env.MERCHANT_RPC_USER, password: env.MERCHANT_RPC_PASSWORD });
  }
  return undefined;
}

/** secp256k1's group order: a private key is in [1, n − 1]. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function channelOf(env: Env, wallet: YcashRpc | undefined): ChannelConfig | undefined {
  const key = env.MERCHANT_CHANNEL_KEY;
  if (!key) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(key) || BigInt("0x" + key) === 0n || BigInt("0x" + key) >= SECP256K1_N) {
    throw new Error("MERCHANT_CHANNEL_KEY must be a secp256k1 private key, 64 hex characters");
  }
  if (!wallet) throw new Error("the channel route needs the merchant's node: MERCHANT_DEVNET_JSON or MERCHANT_RPC_*");
  const minLockBlocks = int(env, "MERCHANT_MIN_LOCK_BLOCKS", 2, 100_000);
  const closeMarginBlocks = int(env, "MERCHANT_CLOSE_MARGIN_BLOCKS", 1, 100_000);
  const idleMs = int(env, "MERCHANT_CHANNEL_IDLE_MS", 1, 86_400_000);
  return {
    serverPrivKey: tx.hexToBytes(key.toLowerCase()),
    maxDeposit: BigInt(zat(env, "MERCHANT_MAX_DEPOSIT_ZAT", "100000000")),
    storePath: env.MERCHANT_CHANNEL_STORE ?? "merchant-channels.json",
    confirmations: int(env, "MERCHANT_CHANNEL_CONFIRMATIONS", -1, 20) ?? 1,
    fundingWaitMs: int(env, "MERCHANT_FUNDING_WAIT_MS", 0, 600_000) ?? 60_000,
    watcherPollMs: int(env, "MERCHANT_WATCHER_POLL_MS", 100, 3_600_000) ?? 15_000,
    ...(minLockBlocks !== undefined ? { minLockBlocks } : {}),
    ...(closeMarginBlocks !== undefined ? { closeMarginBlocks } : {}),
    ...(idleMs !== undefined ? { idleMs } : {}),
  };
}

function shieldedOf(env: Env, network: YcashNetwork, wallet: YcashRpc | undefined): ShieldedConfig | undefined {
  const registryPath = env.MERCHANT_ISSUED_REGISTRY;
  if (!registryPath) return undefined;
  if (!wallet) throw new Error("the shielded route needs the merchant's wallet node: MERCHANT_DEVNET_JSON or MERCHANT_RPC_*");
  const baseAddress = env.MERCHANT_SAPLING_BASE_ADDRESS;
  const hrp = shielded.SAPLING_HRP[network] + "1";
  if (baseAddress && !baseAddress.startsWith(hrp)) throw new Error(`MERCHANT_SAPLING_BASE_ADDRESS must be a ${network} Sapling address (${hrp}…)`);
  return { registryPath, confirmations: int(env, "MERCHANT_SHIELDED_CONFIRMATIONS", -1, 20) ?? 1, ...(baseAddress ? { baseAddress } : {}) };
}

export function loadMerchantConfig(env: Env = process.env): MerchantConfig {
  const network = (env.X402_NETWORK ?? "ycash:regtest") as YcashNetwork;
  if (!YCASH_NETWORKS.includes(network)) throw new Error(`X402_NETWORK must be one of ${YCASH_NETWORKS.join(", ")}`);

  const payTo = env.MERCHANT_PAY_TO;
  if (!payTo) throw new Error("MERCHANT_PAY_TO (a transparent address) is required");
  // The network comes from config, never from the address: testnet and regtest share prefixes (X-F1).
  const decoded = tx.decodeAddress(payTo, network);
  if (decoded.kind === "yed") throw new Error("MERCHANT_PAY_TO must be a YEC address, not a YED (ye…) address");

  const wallet = nodeOf(env);
  const port = Number(env.PORT ?? "4021");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a TCP port");
  const priceTickerZat = zat(env, "PRICE_TICKER_ZAT", "10000");
  const channel = channelOf(env, wallet);
  const shieldedConfig = shieldedOf(env, network, wallet);

  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    network,
    facilitatorUrl: env.FACILITATOR_URL ?? "http://127.0.0.1:4022",
    ...(env.FACILITATOR_API_KEY ? { facilitatorApiKey: env.FACILITATOR_API_KEY } : {}),
    payTo,
    priceExactZat: zat(env, "PRICE_EXACT_ZAT", "250000"),
    priceTickerZat,
    priceChannelZat: zat(env, "PRICE_CHANNEL_ZAT", "1000"),
    priceShieldedZat: zat(env, "PRICE_SHIELDED_ZAT", "1500000"),
    zeroConfCapZat: BigInt(zat(env, "MERCHANT_ZERO_CONF_CAP_ZAT", priceTickerZat)),
    ...(wallet ? { wallet } : {}),
    ...(channel ? { channel } : {}),
    ...(shieldedConfig ? { shielded: shieldedConfig } : {}),
  };
}

/** What the startup line may show: no keys. */
export function describeConfig(c: MerchantConfig): Record<string, unknown> {
  return {
    network: c.network,
    facilitator: c.facilitatorUrl,
    payTo: c.payTo,
    node: c.wallet?.url ?? "(none)",
    channel: c.channel ? { maxDeposit: c.channel.maxDeposit.toString(), store: c.channel.storePath, confirmations: c.channel.confirmations, serverKey: "(set)" } : "(off)",
    shielded: c.shielded ? { registry: c.shielded.registryPath, confirmations: c.shielded.confirmations } : "(off)",
  };
}
