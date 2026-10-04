// Agent configuration from the environment: where to call, how many times, which node it reads,
// and which wallet pays each method.
import { tx, YCASH_NETWORKS, YcashRpc, type YcashNetwork } from "x402-ycash-mechanism";

/** How the agent signs transparent payments and channel funding (plan §5.6 "two signer backends"). */
export type AgentSigner =
  /** Keys in the agent: a WIF private key, signed with the SDK's ZIP-243 code (the local signer). */
  | { kind: "wif"; wif: string; privKey: Uint8Array; address: string }
  /** The agent's own node wallet: listunspent + createrawtransaction + signrawtransaction (the RPC signer). */
  | { kind: "node" };

export interface AgentConfig {
  url: string;
  requests: number;
  network: YcashNetwork;
  /**
   * The agent's node. The node signer's wallet; for a WIF signer, where its coins are listed (the
   * address is imported watch-only); and for sapling-proof, the Sapling wallet that pays.
   */
  node: YcashRpc;
  signer: AgentSigner;
  /** Per-payment cap in zatoshis; the client refuses a 402 asking for more. */
  maxPaymentZat: string;
  /** sapling-proof: the source address z_sendmany pays from (a Sapling address for tier P1). */
  shieldedFrom?: string;
  /** batch-settlement: where channel records (with their keys) are kept; default in memory. */
  channelStorePath?: string;
  /** batch-settlement: the deposit D of a new channel, zatoshis; default amount × 100, capped at maxDeposit. */
  channelDepositZat?: bigint;
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

export function loadSigner(env: Env, network: YcashNetwork): AgentSigner {
  const kind = env.AGENT_SIGNER ?? (env.AGENT_WIF ? "wif" : "node");
  if (kind === "wif") {
    if (!env.AGENT_WIF) throw new Error("AGENT_SIGNER=wif needs AGENT_WIF");
    const { privKey, compressed } = tx.decodeWif(env.AGENT_WIF, network);
    const address = tx.encodeAddress(network, "p2pkh", tx.hash160(tx.pubkeyFromPriv(privKey, compressed)));
    return { kind: "wif", wif: env.AGENT_WIF, privKey, address };
  }
  if (kind === "node") return { kind: "node" };
  throw new Error(`AGENT_SIGNER must be "wif" or "node", got ${JSON.stringify(kind)}`);
}

export function loadAgentConfig(env: Env = process.env): AgentConfig {
  const network = (env.X402_NETWORK ?? "ycash:regtest") as YcashNetwork;
  if (!YCASH_NETWORKS.includes(network)) throw new Error(`X402_NETWORK must be one of ${YCASH_NETWORKS.join(", ")}`);
  const requests = Number(env.REQUESTS ?? "1");
  if (!Number.isInteger(requests) || requests < 1 || requests > 100_000) throw new Error("REQUESTS must be 1..100000");
  const maxPaymentZat = env.MAX_PAYMENT_ZAT ?? "1000000";
  if (!/^[1-9]\d{0,15}$/.test(maxPaymentZat)) throw new Error("MAX_PAYMENT_ZAT must be a positive whole number of zatoshis");
  const signer = loadSigner(env, network);
  const node = loadNode(env);
  if (!node) throw new Error("the agent needs its node: AGENT_DEVNET_JSON, or AGENT_RPC_URL with AGENT_RPC_USER/AGENT_RPC_PASSWORD or AGENT_RPC_COOKIE_FILE");
  const deposit = env.AGENT_CHANNEL_DEPOSIT_ZAT;
  if (deposit !== undefined && !/^[1-9]\d{0,15}$/.test(deposit)) throw new Error("AGENT_CHANNEL_DEPOSIT_ZAT must be a positive whole number of zatoshis");
  return {
    url: env.RESOURCE_URL ?? "http://127.0.0.1:4021/exact/quote",
    requests,
    network,
    node,
    signer,
    maxPaymentZat,
    ...(env.AGENT_SHIELDED_FROM ? { shieldedFrom: env.AGENT_SHIELDED_FROM } : {}),
    ...(env.AGENT_CHANNEL_STORE ? { channelStorePath: env.AGENT_CHANNEL_STORE } : {}),
    ...(deposit ? { channelDepositZat: BigInt(deposit) } : {}),
  };
}
