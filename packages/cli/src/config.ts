// The CLI's configuration: flags first, then the environment, then defaults. The node is a
// yellowback-devnet devnet.json entry or an RPC URL with credentials; the payer is a WIF key or
// the node's own wallet.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { tx, YCASH_NETWORKS, YcashRpc, type YcashNetwork } from "x402-ycash-mechanism";

export interface CliConfig {
  network: YcashNetwork;
  node: YcashRpc;
  /** A WIF key pays transparent payments and channel funding; absent, the node's wallet does. */
  wif?: string;
  /** sapling-proof: the z_sendmany source (a Sapling address for tier P1). */
  shieldedFrom?: string;
  /** Channel records, with their keys: a wallet file. */
  channelStorePath: string;
  maxPaymentZat: bigint;
  /** D for a channel this CLI opens; default the scheme's (amount × 100, capped at maxDeposit). */
  depositZat?: bigint;
  /** `pay --count` */
  count: number;
  /** `channel refund --to`: where the refund goes; default the channel's client address. */
  refundTo?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `usage:
  x402-ycash pay <url> [--count N]
  x402-ycash channel open <url> [--deposit ZAT]
  x402-ycash channel status [channelId]
  x402-ycash channel close <url> [channelId]
  x402-ycash channel refund <channelId> [--to ADDRESS]

node (flag / env):   --devnet FILE / X402_DEVNET_JSON, --node N / X402_DEVNET_NODE (default 0)
                     --rpc-url / X402_RPC_URL with --rpc-user + --rpc-password (X402_RPC_USER, X402_RPC_PASSWORD)
                     or --rpc-cookie / X402_RPC_COOKIE_FILE
payer:               --wif / X402_WIF (a local key; default: the node's wallet signs)
                     --shielded-from / X402_SHIELDED_FROM (pays sapling-proof routes from this address)
other:               --network / X402_NETWORK (default ycash:regtest), --channels FILE / X402_CHANNEL_STORE
                     (default ~/.x402-ycash/channels.json), --max-payment ZAT / X402_MAX_PAYMENT_ZAT (default 1000000)`;

type Env = Record<string, string | undefined>;

const OPTIONS = {
  network: { type: "string" },
  devnet: { type: "string" },
  node: { type: "string" },
  "rpc-url": { type: "string" },
  "rpc-user": { type: "string" },
  "rpc-password": { type: "string" },
  "rpc-cookie": { type: "string" },
  wif: { type: "string" },
  "shielded-from": { type: "string" },
  channels: { type: "string" },
  "max-payment": { type: "string" },
  deposit: { type: "string" },
  count: { type: "string" },
  to: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export interface ParsedArgs {
  command: string[];
  help: boolean;
  values: Record<string, string | undefined>;
}

export function parseCli(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { help, ...values } = parsed.values;
  return { command: parsed.positionals, help: help === true, values: values as Record<string, string | undefined> };
}

function zat(name: string, v: string | undefined): bigint | undefined {
  if (v === undefined) return undefined;
  if (!/^[1-9]\d{0,15}$/.test(v)) throw new UsageError(`${name} must be a positive whole number of zatoshis`);
  return BigInt(v);
}

function nodeOf(f: Record<string, string | undefined>, env: Env): YcashRpc {
  const devnet = f.devnet ?? env.X402_DEVNET_JSON;
  if (devnet) {
    const n = f.node ?? env.X402_DEVNET_NODE ?? "0";
    if (!/^\d+$/.test(n)) throw new UsageError("--node must be a devnet node number");
    return YcashRpc.fromDevnetJson(devnet, Number(n));
  }
  const url = f["rpc-url"] ?? env.X402_RPC_URL;
  if (url) {
    const cookieFile = f["rpc-cookie"] ?? env.X402_RPC_COOKIE_FILE;
    if (cookieFile) return new YcashRpc({ url, cookieFile });
    const user = f["rpc-user"] ?? env.X402_RPC_USER;
    const password = f["rpc-password"] ?? env.X402_RPC_PASSWORD;
    if (user && password) return new YcashRpc({ url, user, password });
    throw new UsageError("--rpc-url needs --rpc-user and --rpc-password, or --rpc-cookie");
  }
  throw new UsageError("no node: pass --devnet devnet.json, or --rpc-url with credentials (or set X402_DEVNET_JSON / X402_RPC_URL)");
}

export function loadCliConfig(args: ParsedArgs, env: Env = process.env, node?: YcashRpc): CliConfig {
  const f = args.values;
  const network = (f.network ?? env.X402_NETWORK ?? "ycash:regtest") as YcashNetwork;
  if (!YCASH_NETWORKS.includes(network)) throw new UsageError(`--network must be one of ${YCASH_NETWORKS.join(", ")}`);
  const wif = f.wif ?? env.X402_WIF;
  // The WIF prefix is shared by testnet and regtest; decodeWif with the network still refuses mainnet keys elsewhere.
  if (wif) {
    try {
      tx.decodeWif(wif, network);
    } catch (e) {
      throw new UsageError(`--wif: ${(e as Error).message}`);
    }
  }
  const count = f.count ?? "1";
  if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 100_000) throw new UsageError("--count must be 1..100000");
  const refundTo = f.to;
  if (refundTo) {
    try {
      tx.decodeAddress(refundTo, network);
    } catch (e) {
      throw new UsageError(`--to: ${(e as Error).message}`);
    }
  }
  const shieldedFrom = f["shielded-from"] ?? env.X402_SHIELDED_FROM;
  const depositZat = zat("--deposit", f.deposit);
  return {
    network,
    node: node ?? nodeOf(f, env),
    channelStorePath: f.channels ?? env.X402_CHANNEL_STORE ?? join(homedir(), ".x402-ycash", "channels.json"),
    maxPaymentZat: zat("--max-payment", f["max-payment"] ?? env.X402_MAX_PAYMENT_ZAT) ?? 1_000_000n,
    count: Number(count),
    ...(wif ? { wif } : {}),
    ...(shieldedFrom ? { shieldedFrom } : {}),
    ...(depositZat !== undefined ? { depositZat } : {}),
    ...(refundTo ? { refundTo } : {}),
  };
}
