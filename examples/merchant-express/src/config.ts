// Merchant configuration from the environment.
import { tx, YCASH_NETWORKS, YcashRpc, type YcashNetwork } from "x402-ycash-mechanism";

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
  priceChannelZat: string;
  priceShieldedZat: string;
  /** The merchant's node wallet for shielded payments (optional). */
  wallet?: YcashRpc;
}

type Env = Record<string, string | undefined>;

function zat(env: Env, name: string, fallback: string): string {
  const v = env[name] ?? fallback;
  if (!/^[1-9]\d{0,15}$/.test(v)) throw new Error(`${name} must be a positive whole number of zatoshis`);
  return v;
}

export function loadMerchantConfig(env: Env = process.env): MerchantConfig {
  const network = (env.X402_NETWORK ?? "ycash:regtest") as YcashNetwork;
  if (!YCASH_NETWORKS.includes(network)) throw new Error(`X402_NETWORK must be one of ${YCASH_NETWORKS.join(", ")}`);

  const payTo = env.MERCHANT_PAY_TO;
  if (!payTo) throw new Error("MERCHANT_PAY_TO (a transparent address) is required");
  // The network comes from config, never from the address: testnet and regtest share prefixes (X-F1).
  const decoded = tx.decodeAddress(payTo, network);
  if (decoded.kind === "yed") throw new Error("MERCHANT_PAY_TO must be a YEC address, not a YED (ye…) address");

  let wallet: YcashRpc | undefined;
  if (env.MERCHANT_DEVNET_JSON) wallet = YcashRpc.fromDevnetJson(env.MERCHANT_DEVNET_JSON, Number(env.MERCHANT_DEVNET_NODE ?? "0"));
  else if (env.MERCHANT_RPC_URL && env.MERCHANT_RPC_USER && env.MERCHANT_RPC_PASSWORD) {
    wallet = new YcashRpc({ url: env.MERCHANT_RPC_URL, user: env.MERCHANT_RPC_USER, password: env.MERCHANT_RPC_PASSWORD });
  }

  const port = Number(env.PORT ?? "4021");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a TCP port");

  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    network,
    facilitatorUrl: env.FACILITATOR_URL ?? "http://127.0.0.1:4022",
    ...(env.FACILITATOR_API_KEY ? { facilitatorApiKey: env.FACILITATOR_API_KEY } : {}),
    payTo,
    priceExactZat: zat(env, "PRICE_EXACT_ZAT", "250000"),
    priceChannelZat: zat(env, "PRICE_CHANNEL_ZAT", "1000"),
    priceShieldedZat: zat(env, "PRICE_SHIELDED_ZAT", "1500000"),
    ...(wallet ? { wallet } : {}),
  };
}
