// Agent configuration from the environment: where to call, how many times, and which signer pays.
import { tx, YCASH_NETWORKS, YcashRpc, type YcashNetwork } from "x402-ycash-mechanism";

/** How the agent signs its payments (plan §5.6 "two signer backends"). */
export type AgentSigner =
  /** Keys in the agent: a WIF private key, signed with the SDK's ZIP-243 code (the local signer). */
  | { kind: "wif"; privKey: Uint8Array; address: string }
  /** The agent's own node wallet: listunspent + createrawtransaction + signrawtransaction (the RPC signer). */
  | { kind: "node"; rpc: YcashRpc };

export interface AgentConfig {
  url: string;
  requests: number;
  network: YcashNetwork;
  signer: AgentSigner;
  /** Per-payment cap in zatoshis; the client refuses a 402 asking for more. */
  maxPaymentZat: string;
}

type Env = Record<string, string | undefined>;

export function loadSigner(env: Env, network: YcashNetwork): AgentSigner {
  const kind = env.AGENT_SIGNER ?? (env.AGENT_WIF ? "wif" : "node");
  if (kind === "wif") {
    if (!env.AGENT_WIF) throw new Error("AGENT_SIGNER=wif needs AGENT_WIF");
    const { privKey, compressed } = tx.decodeWif(env.AGENT_WIF, network);
    const address = tx.encodeAddress(network, "p2pkh", tx.hash160(tx.pubkeyFromPriv(privKey, compressed)));
    return { kind: "wif", privKey, address };
  }
  if (kind === "node") {
    if (env.AGENT_DEVNET_JSON) return { kind: "node", rpc: YcashRpc.fromDevnetJson(env.AGENT_DEVNET_JSON, Number(env.AGENT_DEVNET_NODE ?? "0")) };
    if (env.AGENT_RPC_URL && env.AGENT_RPC_COOKIE_FILE) return { kind: "node", rpc: new YcashRpc({ url: env.AGENT_RPC_URL, cookieFile: env.AGENT_RPC_COOKIE_FILE }) };
    if (env.AGENT_RPC_URL && env.AGENT_RPC_USER && env.AGENT_RPC_PASSWORD) {
      return { kind: "node", rpc: new YcashRpc({ url: env.AGENT_RPC_URL, user: env.AGENT_RPC_USER, password: env.AGENT_RPC_PASSWORD }) };
    }
    throw new Error("AGENT_SIGNER=node needs AGENT_DEVNET_JSON, or AGENT_RPC_URL with AGENT_RPC_USER/AGENT_RPC_PASSWORD or AGENT_RPC_COOKIE_FILE");
  }
  throw new Error(`AGENT_SIGNER must be "wif" or "node", got ${JSON.stringify(kind)}`);
}

export function loadAgentConfig(env: Env = process.env): AgentConfig {
  const network = (env.X402_NETWORK ?? "ycash:regtest") as YcashNetwork;
  if (!YCASH_NETWORKS.includes(network)) throw new Error(`X402_NETWORK must be one of ${YCASH_NETWORKS.join(", ")}`);
  const requests = Number(env.REQUESTS ?? "1");
  if (!Number.isInteger(requests) || requests < 1 || requests > 100_000) throw new Error("REQUESTS must be 1..100000");
  const maxPaymentZat = env.MAX_PAYMENT_ZAT ?? "1000000";
  if (!/^[1-9]\d{0,15}$/.test(maxPaymentZat)) throw new Error("MAX_PAYMENT_ZAT must be a positive whole number of zatoshis");
  return {
    url: env.RESOURCE_URL ?? "http://127.0.0.1:4021/exact/quote",
    requests,
    network,
    signer: loadSigner(env, network),
    maxPaymentZat,
  };
}
