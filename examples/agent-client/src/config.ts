// Agent configuration from the environment: where to call, how many times, which node it reads,
// and which wallet pays each method.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LightClient, LwdClient, tx, YCASH_NETWORKS, YcashRpc, type YcashNetwork } from "x402-ycash-mechanism";

/** How the agent signs transparent payments and channel funding (plan §5.6 "two signer backends"). */
export type AgentSigner =
  /** Keys in the agent: a WIF private key, signed with the SDK's ZIP-243 code (the local signer). */
  | { kind: "wif"; wif: string; privKey: Uint8Array; address: string }
  /** The agent's own node wallet: listunspent + createrawtransaction + signrawtransaction (the RPC signer). */
  | { kind: "node" }
  /**
   * No transparent payer: a private agent that pays shielded methods only, from the light client
   * (AGENT_SAPLING_BUILDER = `x402-light serve`). No node, no WIF; transparent and channel routes are refused.
   */
  | { kind: "none" };

export interface AgentConfig {
  url: string;
  requests: number;
  network: YcashNetwork;
  /**
   * The agent's node. The node signer's wallet; for a WIF signer without `lwd`, where its coins are
   * listed (the address is imported watch-only); and for sapling-proof, the Sapling wallet that pays.
   */
  node?: YcashRpc;
  /**
   * AGENT_LWD_URL: a lightwalletd server in place of the node for a WIF signer: coins, YED outputs,
   * tip and branch id, and the refund's broadcast (plan X5). Transparent YEC and YED only.
   */
  lwd?: LwdClient;
  signer: AgentSigner;
  /** Per-payment cap in zatoshis; the client refuses a 402 asking for more. */
  maxPaymentZat: string;
  /** sapling-proof: the source address z_sendmany pays from (a Sapling address for tier P1). */
  shieldedFrom?: string;
  /**
   * sapling: AGENT_SAPLING_BUILDER, the Sapling transaction builder (an http(s) URL of
   * `x402-light serve`, or a shell command; contract in x402-ycash-mechanism shielded/builder.ts).
   * Absent, the agent refuses sapling routes.
   */
  saplingBuilder?: string;
  /**
   * The light client, when AGENT_SAPLING_BUILDER is an http(s) URL (`x402-light serve`): it builds
   * `sapling` payments, gives their nExpiryHeight's tip when there is no node, and pays
   * `sapling-proof` (send) unless AGENT_SHIELDED_FROM names a node wallet source.
   */
  light?: LightClient;
  /** batch-settlement: where channel records (with their keys) are kept; default in memory. */
  channelStorePath?: string;
  /** batch-settlement: the deposit D of a new channel, zatoshis; default amount × 100, capped at maxDeposit. */
  channelDepositZat?: bigint;
  /** batch-settlement: the most this agent locks in one channel, zatoshis; default 1 YEC, whatever the server allows. */
  channelMaxDepositZat?: bigint;
  /**
   * YED's per-payment cap in cents (spend controls; default 100 = $1.00, core's USD default, X-F43).
   * It caps a YED `exact` price and a YED channel's per-request ceiling.
   */
  maxPaymentYedCents?: string;
  /** YED channels: D of a new channel, cents; default amount × 100, capped as below. */
  yedChannelDepositCents?: bigint;
  /** YED channels: the most this agent locks in one channel, cents (the client's maxDeposit for YED; default $50). */
  yedChannelMaxDepositCents?: bigint;
  /**
   * batch-settlement: the largest server-chosen closeFee this agent opens with, zatoshis, for both
   * assets (default 5,000; plan X-F50). The fee is locked in V and paid to miners at close.
   */
  channelMaxCloseFeeZat?: bigint;
  /**
   * Coins held by this payer's signed, unconfirmed spends (a file shared by every agent process
   * of the same payer, so the next run never reselects a coin the last one spent). Default: a
   * file in the OS temp directory named after the payer (loadAgentConfig); absent, in memory.
   */
  reservationsPath?: string;
}

type Env = Record<string, string | undefined>;

export function loadNode(env: Env, prefix = "AGENT"): YcashRpc | undefined {
  const v = (k: string): string | undefined => env[`${prefix}_${k}`];
  if (v("DEVNET_JSON")) return YcashRpc.fromDevnetJson(v("DEVNET_JSON") as string, Number(v("DEVNET_NODE") ?? "0"));
  const url = v("RPC_URL");
  if (url && v("RPC_COOKIE_FILE")) return new YcashRpc({ url, cookieFile: v("RPC_COOKIE_FILE") as string });
  if (url && v("RPC_USER") && v("RPC_PASSWORD")) return new YcashRpc({ url, user: v("RPC_USER") as string, password: v("RPC_PASSWORD") as string });
  return undefined;
}

export function loadSigner(env: Env, network: YcashNetwork, fallback: "node" | "none" = "node"): AgentSigner {
  const kind = env.AGENT_SIGNER ?? (env.AGENT_WIF ? "wif" : fallback);
  if (kind === "wif") {
    if (!env.AGENT_WIF) throw new Error("AGENT_SIGNER=wif needs AGENT_WIF");
    const { privKey, compressed } = tx.decodeWif(env.AGENT_WIF, network);
    const address = tx.encodeAddress(network, "p2pkh", tx.hash160(tx.pubkeyFromPriv(privKey, compressed)));
    return { kind: "wif", wif: env.AGENT_WIF, privKey, address };
  }
  if (kind === "node") return { kind: "node" };
  if (kind === "none") return { kind: "none" };
  throw new Error(`AGENT_SIGNER must be "wif", "node" or "none", got ${JSON.stringify(kind)}`);
}

/** A YED channel amount in cents: at least $1.00 (a YED channel holds at least the pre-paid dollar, X-7). */
function cents(env: Env, name: string): bigint | undefined {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  if (!/^[1-9]\d{0,7}$/.test(v) || BigInt(v) < 100n || BigInt(v) > 10_000_000n) throw new Error(`${name} must be a whole number of cents in 100..10000000`);
  return BigInt(v);
}

export function loadAgentConfig(env: Env = process.env): AgentConfig {
  const network = (env.X402_NETWORK ?? "ycash:regtest") as YcashNetwork;
  if (!YCASH_NETWORKS.includes(network)) throw new Error(`X402_NETWORK must be one of ${YCASH_NETWORKS.join(", ")}`);
  const requests = Number(env.REQUESTS ?? "1");
  if (!Number.isInteger(requests) || requests < 1 || requests > 100_000) throw new Error("REQUESTS must be 1..100000");
  const maxPaymentZat = env.MAX_PAYMENT_ZAT ?? "1000000";
  if (!/^[1-9]\d{0,15}$/.test(maxPaymentZat)) throw new Error("MAX_PAYMENT_ZAT must be a positive whole number of zatoshis");
  const node = loadNode(env);
  const lwd = env.AGENT_LWD_URL ? new LwdClient(env.AGENT_LWD_URL) : undefined;
  const light = env.AGENT_SAPLING_BUILDER && /^https?:\/\//.test(env.AGENT_SAPLING_BUILDER) ? new LightClient(env.AGENT_SAPLING_BUILDER) : undefined;
  // With only the light client configured, the agent is private: shielded methods, no transparent payer.
  const signer = loadSigner(env, network, !node && !lwd && light ? "none" : "node");
  if (lwd && signer.kind !== "wif") throw new Error("AGENT_LWD_URL needs AGENT_WIF: lightwalletd holds no wallet, so a local key pays");
  if (signer.kind === "none" && !light) throw new Error("AGENT_SIGNER=none pays shielded methods only: set AGENT_SAPLING_BUILDER to x402-light serve's URL");
  if (signer.kind === "node" && !node) throw new Error("the agent needs its node: AGENT_DEVNET_JSON, or AGENT_RPC_URL with AGENT_RPC_USER/AGENT_RPC_PASSWORD or AGENT_RPC_COOKIE_FILE, or AGENT_LWD_URL with AGENT_WIF, or AGENT_SAPLING_BUILDER=http://… (x402-light) alone");
  if (signer.kind === "wif" && !node && !lwd) throw new Error("the agent needs its node: AGENT_DEVNET_JSON, or AGENT_RPC_URL with credentials, or AGENT_LWD_URL with AGENT_WIF");
  if (env.AGENT_SHIELDED_FROM && !node) throw new Error("AGENT_SHIELDED_FROM needs a node wallet (AGENT_DEVNET_JSON or AGENT_RPC_URL): lightwalletd cannot pay sapling-proof");
  const deposit = env.AGENT_CHANNEL_DEPOSIT_ZAT;
  if (deposit !== undefined && !/^[1-9]\d{0,15}$/.test(deposit)) throw new Error("AGENT_CHANNEL_DEPOSIT_ZAT must be a positive whole number of zatoshis");
  const maxDeposit = env.AGENT_CHANNEL_MAX_DEPOSIT_ZAT;
  if (maxDeposit !== undefined && !/^[1-9]\d{0,15}$/.test(maxDeposit)) throw new Error("AGENT_CHANNEL_MAX_DEPOSIT_ZAT must be a positive whole number of zatoshis");
  const maxPaymentYedCents = env.MAX_PAYMENT_YED_CENTS ?? "100";
  if (!/^[1-9]\d{0,9}$/.test(maxPaymentYedCents)) throw new Error("MAX_PAYMENT_YED_CENTS must be a positive whole number of cents");
  const maxCloseFee = env.AGENT_CHANNEL_MAX_CLOSE_FEE_ZAT;
  if (maxCloseFee !== undefined && !/^[1-9]\d{0,15}$/.test(maxCloseFee)) throw new Error("AGENT_CHANNEL_MAX_CLOSE_FEE_ZAT must be a positive whole number of zatoshis");
  const yedDeposit = cents(env, "AGENT_YED_CHANNEL_DEPOSIT_CENTS");
  const yedMaxDeposit = cents(env, "AGENT_YED_CHANNEL_MAX_DEPOSIT_CENTS");
  const payerId =
    signer.kind === "wif" ? signer.address : `${signer.kind === "none" ? "light" : "node"}-${createHash("sha256").update(signer.kind === "none" ? (light as LightClient).url : (node as YcashRpc).url).digest("hex").slice(0, 16)}`;
  return {
    url: env.RESOURCE_URL ?? "http://127.0.0.1:4021/exact/quote",
    requests,
    network,
    ...(node ? { node } : {}),
    ...(lwd ? { lwd } : {}),
    signer,
    maxPaymentZat,
    ...(env.AGENT_SHIELDED_FROM ? { shieldedFrom: env.AGENT_SHIELDED_FROM } : {}),
    ...(env.AGENT_SAPLING_BUILDER ? { saplingBuilder: env.AGENT_SAPLING_BUILDER } : {}),
    ...(light ? { light } : {}),
    ...(env.AGENT_CHANNEL_STORE ? { channelStorePath: env.AGENT_CHANNEL_STORE } : {}),
    ...(deposit ? { channelDepositZat: BigInt(deposit) } : {}),
    ...(maxDeposit ? { channelMaxDepositZat: BigInt(maxDeposit) } : {}),
    ...(maxCloseFee ? { channelMaxCloseFeeZat: BigInt(maxCloseFee) } : {}),
    maxPaymentYedCents,
    ...(yedDeposit !== undefined ? { yedChannelDepositCents: yedDeposit } : {}),
    ...(yedMaxDeposit !== undefined ? { yedChannelMaxDepositCents: yedMaxDeposit } : {}),
    reservationsPath: env.AGENT_RESERVATIONS ?? join(tmpdir(), `x402-ycash-reservations-${payerId}.json`),
  };
}
