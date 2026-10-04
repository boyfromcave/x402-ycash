// The CLI's configuration: flags first, then the environment, then defaults. The chain is read from
// a node (a yellowback-devnet devnet.json entry or an RPC URL with credentials) or from a
// lightwalletd server (--lwd); the payer is a WIF key or the node's own wallet.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ASSET_YEC, ASSET_YED, LwdClient, tx, YCASH_NETWORKS, YcashRpc, type YcashAsset, type YcashNetwork } from "x402-ycash-mechanism";

export interface CliConfig {
  network: YcashNetwork;
  /** The node: the payer's wallet when there is no WIF key, and the chain unless `lwd` is set. */
  node?: YcashRpc;
  /**
   * `--lwd`: read coins, YED outputs and the tip through lightwalletd and broadcast refunds through
   * it, with no node RPC. Needs a WIF key; sapling-proof still needs a node wallet.
   */
  lwd?: LwdClient;
  /** A WIF key pays transparent payments and channel funding; absent, the node's wallet does. */
  wif?: string;
  /** sapling-proof: the z_sendmany source (a Sapling address for tier P1). */
  shieldedFrom?: string;
  /** sapling: the Sapling transaction builder, an http(s) JSON-RPC URL or a shell command (shielded/builder.ts). */
  saplingBuilder?: string;
  /** Channel records, with their keys: a wallet file. */
  channelStorePath: string;
  maxPaymentZat: bigint;
  /** YED's per-payment cap, cents (spend controls; default 100 = $1.00, core's USD default, X-F43). */
  maxPaymentYedCents: bigint;
  /** `--asset`: pay and open only requirements in this asset; default whichever the route offers first. */
  asset?: YcashAsset;
  /** D for a YEC channel this CLI opens; default the scheme's (amount × 100, capped at maxDeposit). */
  depositZat?: bigint;
  /** D for a YED channel this CLI opens (`--asset YED --deposit CENTS`), cents. */
  depositCents?: bigint;
  /** The most a YED channel this CLI opens may lock, cents (the client's maxDeposit for YED; default $50). */
  maxDepositCents?: bigint;
  /** The most a channel this CLI opens may lock, zatoshis; default 1 YEC, whatever the server allows. */
  maxDepositZat?: bigint;
  /** The largest server closeFee a channel this CLI opens may lock, zatoshis, both assets (default the mechanism's 5,000; plan X-F50). */
  maxCloseFeeZat?: bigint;
  /** Coins held by signed, unconfirmed spends, shared by every run (default next to the channel store). */
  reservationsPath: string;
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
  x402-ycash pay <url> [--count N] [--asset YEC|YED]
  x402-ycash channel open <url> [--asset YEC|YED] [--deposit ZAT|CENTS] [--max-deposit ZAT] [--max-deposit-yed CENTS]
  x402-ycash channel status [channelId]
  x402-ycash channel close <url> [channelId] [--asset YEC|YED]
  x402-ycash channel refund <channelId> [--to ADDRESS]

node (flag / env):   --devnet FILE / X402_DEVNET_JSON, --node N / X402_DEVNET_NODE (default 0)
                     --rpc-url / X402_RPC_URL with --rpc-user + --rpc-password (X402_RPC_USER, X402_RPC_PASSWORD)
                     or --rpc-cookie / X402_RPC_COOKIE_FILE
                     or --lwd HOST:PORT / X402_LWD_URL: a lightwalletd server instead of a node (needs --wif;
                     grpc://… plaintext, grpcs://… TLS, a bare host:port is TLS unless loopback)
payer:               --wif / X402_WIF (a local key; default: the node's wallet signs)
                     --shielded-from / X402_SHIELDED_FROM (pays sapling-proof routes from this address)
                     --sapling-builder / X402_SAPLING_BUILDER (pays sapling routes with transactions from this
                     builder: an http(s) URL of x402-light serve, or a shell command; build {to, amountZat,
                     memoHex, expiryHeight?} -> {txHex, txid}; without it sapling routes are refused)
other:               --network / X402_NETWORK (default ycash:regtest), --channels FILE / X402_CHANNEL_STORE
                     (default ~/.x402-ycash/channels.json), --max-payment ZAT / X402_MAX_PAYMENT_ZAT (default 1000000),
                     --max-deposit ZAT / X402_MAX_DEPOSIT_ZAT (default 100000000, 1 YEC), --reservations FILE /
                     X402_RESERVATIONS (default reservations.json next to the channel store),
                     --max-close-fee ZAT / X402_MAX_CLOSE_FEE_ZAT (the largest server closeFee a channel may lock;
                     default 5000)
channels:            the remainder of every close and refund returns to the payer: the WIF key's address, or a new
                     address of the node's wallet (a Yellowback address for YED)
YED:                 --asset YED picks a route's YED requirements; --deposit is then in cents (at least 100).
                     --max-payment-yed CENTS / X402_MAX_PAYMENT_YED_CENTS (default 100, $1.00),
                     --max-deposit-yed CENTS / X402_MAX_DEPOSIT_YED_CENTS (default 5000, $50).
                     A YED refund carries a TRANSFER of all of D; without --to it goes to the WIF key's
                     address or a new yed_getnewaddress of the node's wallet.`;

type Env = Record<string, string | undefined>;

const OPTIONS = {
  network: { type: "string" },
  devnet: { type: "string" },
  node: { type: "string" },
  "rpc-url": { type: "string" },
  "rpc-user": { type: "string" },
  "rpc-password": { type: "string" },
  "rpc-cookie": { type: "string" },
  lwd: { type: "string" },
  wif: { type: "string" },
  "shielded-from": { type: "string" },
  "sapling-builder": { type: "string" },
  channels: { type: "string" },
  "max-payment": { type: "string" },
  deposit: { type: "string" },
  "max-deposit": { type: "string" },
  "max-payment-yed": { type: "string" },
  "max-deposit-yed": { type: "string" },
  "max-close-fee": { type: "string" },
  asset: { type: "string" },
  reservations: { type: "string" },
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

/** A YED amount in cents: at least $1.00 (a YED output below it burns; a YED channel holds at least $1.00). */
function cents(name: string, v: string | undefined, min: bigint): bigint | undefined {
  if (v === undefined) return undefined;
  if (!/^[1-9]\d{0,7}$/.test(v) || BigInt(v) < min || BigInt(v) > 10_000_000n) throw new UsageError(`${name} must be a whole number of cents in ${min}..10000000`);
  return BigInt(v);
}

function assetOf(v: string | undefined): YcashAsset | undefined {
  if (v === undefined) return undefined;
  const a = v.toUpperCase();
  if (a !== ASSET_YEC && a !== ASSET_YED) throw new UsageError("--asset must be YEC or YED");
  return a;
}

function nodeOf(f: Record<string, string | undefined>, env: Env): YcashRpc | undefined {
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
  return undefined;
}

function lwdOf(f: Record<string, string | undefined>, env: Env): LwdClient | undefined {
  const url = f.lwd ?? env.X402_LWD_URL;
  if (!url) return undefined;
  try {
    return new LwdClient(url);
  } catch (e) {
    throw new UsageError(`--lwd: ${(e as Error).message}`);
  }
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
  const saplingBuilder = f["sapling-builder"] ?? env.X402_SAPLING_BUILDER;
  const asset = assetOf(f.asset);
  // --deposit is in the asset's unit: zatoshis for YEC, cents for YED.
  const depositZat = asset === ASSET_YED ? undefined : zat("--deposit", f.deposit);
  const depositCents = asset === ASSET_YED ? cents("--deposit", f.deposit, 100n) : undefined;
  const maxDepositCents = cents("--max-deposit-yed", f["max-deposit-yed"] ?? env.X402_MAX_DEPOSIT_YED_CENTS, 100n);
  const maxDepositZat = zat("--max-deposit", f["max-deposit"] ?? env.X402_MAX_DEPOSIT_ZAT);
  const maxCloseFeeZat = zat("--max-close-fee", f["max-close-fee"] ?? env.X402_MAX_CLOSE_FEE_ZAT);
  const channelStorePath = f.channels ?? env.X402_CHANNEL_STORE ?? join(homedir(), ".x402-ycash", "channels.json");
  const rpc = node ?? nodeOf(f, env);
  const lwd = lwdOf(f, env);
  if (!rpc && !lwd) throw new UsageError("no node: pass --devnet devnet.json, --rpc-url with credentials, or --lwd host:port (or set X402_DEVNET_JSON / X402_RPC_URL / X402_LWD_URL)");
  if (lwd && !wif) throw new UsageError("--lwd needs --wif: lightwalletd holds no wallet, so a local key pays");
  if (shieldedFrom && !rpc) throw new UsageError("--shielded-from needs a node wallet (--devnet or --rpc-url): lightwalletd cannot pay sapling-proof");
  return {
    network,
    ...(rpc ? { node: rpc } : {}),
    ...(lwd ? { lwd } : {}),
    channelStorePath,
    reservationsPath: f.reservations ?? env.X402_RESERVATIONS ?? join(dirname(channelStorePath), "reservations.json"),
    maxPaymentZat: zat("--max-payment", f["max-payment"] ?? env.X402_MAX_PAYMENT_ZAT) ?? 1_000_000n,
    maxPaymentYedCents: cents("--max-payment-yed", f["max-payment-yed"] ?? env.X402_MAX_PAYMENT_YED_CENTS, 1n) ?? 100n,
    count: Number(count),
    ...(asset ? { asset } : {}),
    ...(depositCents !== undefined ? { depositCents } : {}),
    ...(maxDepositCents !== undefined ? { maxDepositCents } : {}),
    ...(wif ? { wif } : {}),
    ...(shieldedFrom ? { shieldedFrom } : {}),
    ...(saplingBuilder ? { saplingBuilder } : {}),
    ...(depositZat !== undefined ? { depositZat } : {}),
    ...(maxDepositZat !== undefined ? { maxDepositZat } : {}),
    ...(maxCloseFeeZat !== undefined ? { maxCloseFeeZat } : {}),
    ...(refundTo ? { refundTo } : {}),
  };
}
