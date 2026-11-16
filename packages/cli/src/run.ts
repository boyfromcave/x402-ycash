// Dispatch: `run(argv, env)` is the whole CLI, so tests drive it without a process.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pq, tx, YCASH_NETWORKS, type YcashNetwork, type YcashRpc } from "x402-ycash-mechanism";
import { buildClient } from "./client.js";
import { channelClose, channelOpen, channelRefund, channelStatus, pay, type Out } from "./commands.js";
import { loadCliConfig, parseCli, readWifFile, USAGE, UsageError, type CliConfig, type ParsedArgs } from "./config.js";

export interface RunIo {
  out: Out;
  err: (line: string) => void;
}

export interface RunDeps {
  /** Replaces the node built from flags (tests). */
  node?: YcashRpc;
  fetch?: typeof fetch;
}

const stdio: RunIo = {
  out: (r) => process.stdout.write(JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
};

export async function run(argv: string[], env: Record<string, string | undefined> = process.env, io: RunIo = stdio, deps: RunDeps = {}): Promise<number> {
  let config: CliConfig | undefined;
  try {
    const args = parseCli(argv);
    const [cmd, sub, a1, a2] = args.command;
    if (args.help || !cmd) {
      io.err(USAGE);
      return args.help ? 0 : 2;
    }
    const need = (v: string | undefined, what: string): string => {
      if (!v) throw new UsageError(`missing ${what}`);
      return v;
    };
    if (cmd === "yed-key") return yedKeyCommand(args, env, sub, a1, io);
    if (cmd === "key") return keyCommand(args, env, sub, a1, io);
    config = loadCliConfig(args, env, deps.node);
    const client = buildClient(config);
    const f = deps.fetch ?? fetch;
    if (cmd === "pay") return await pay(client, config, need(sub, "<url>"), io.out, f);
    if (cmd === "channel") {
      if (!client.batch) throw new UsageError("channels need a transparent payer (--wif or a node wallet): with only --sapling-builder the CLI pays shielded methods");
      switch (sub) {
        case "open":
          return await channelOpen(client, config, need(a1, "<url>"), io.out, f);
        case "status":
          return await channelStatus(client, a1, io.out);
        case "close":
          return await channelClose(client, need(a1, "<url>"), a2, io.out, f, config.asset);
        case "refund":
          return await channelRefund(client, config, need(a1, "<channelId>"), io.out);
      }
    }
    throw new UsageError(`unknown command: ${args.command.join(" ")}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`x402-ycash: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`x402-ycash: ${(e as Error).message}`);
    return 1;
  } finally {
    config?.lwd?.close(); // an open gRPC channel would keep the process alive
  }
}

function networkOf(args: ParsedArgs, env: Record<string, string | undefined>): YcashNetwork {
  const network = (args.values.network ?? env.X402_NETWORK ?? "ycash:regtest") as YcashNetwork;
  if (!YCASH_NETWORKS.includes(network)) throw new UsageError(`--network must be one of ${YCASH_NETWORKS.join(", ")}`);
  return network;
}

/** The transparent (P2PKH) address of a private key, compressed public key. */
export function wifAddress(wif: string, network: YcashNetwork): string {
  const { privKey, compressed } = tx.decodeWif(wif, network);
  const address = tx.encodeAddress(network, "p2pkh", tx.hash160(tx.pubkeyFromPriv(privKey, compressed)));
  privKey.fill(0);
  return address;
}

/**
 * `key new FILE`: writes a new transparent key as WIF (mode 0600, never over an existing file) and
 * prints its address; `key address`: the address of --wif-file. The key itself is never printed.
 * Testnet and regtest share the WIF prefix; mainnet keys have their own.
 *
 * @param args - The parsed arguments.
 * @param env - The environment.
 * @param sub - `new` or `address`.
 * @param file - `new`'s file.
 * @param io - Output.
 * @returns The exit code.
 */
function keyCommand(args: ParsedArgs, env: Record<string, string | undefined>, sub: string | undefined, file: string | undefined, io: RunIo): number {
  const network = networkOf(args, env);
  let wif: string;
  if (sub === "new") {
    if (!file) throw new UsageError("missing <FILE>");
    const priv = tx.randomPrivKey();
    wif = tx.encodeWif(priv, network);
    priv.fill(0);
    try {
      writeFileSync(file, wif + "\n", { mode: 0o600, flag: "wx" });
    } catch (e) {
      throw new UsageError(`key new: cannot create ${file}: ${(e as NodeJS.ErrnoException).code === "EEXIST" ? "it exists (a key is never overwritten)" : ((e as NodeJS.ErrnoException).code ?? "error")}`);
    }
  } else if (sub === "address") {
    const path = args.values["wif-file"] ?? env.X402_WIF_FILE;
    if (!path) throw new UsageError("key address needs --wif-file");
    wif = readWifFile(path, network);
  } else throw new UsageError(`unknown command: key ${sub ?? ""}`);
  io.out({ msg: "key", network, address: wifAddress(wif, network), ...(sub === "new" ? { file } : {}) });
  return 0;
}

/**
 * `yed-key new FILE`: writes a new Falcon YED key seed (`fn-dsa-512:<96 hex>`, mode 0600, never over an
 * existing file); `yed-key address`: the address of --yed-key-file. Both print the key's YED address and
 * its plain-YEC post-quantum address for --network; neither needs a node.
 *
 * @param args - The parsed arguments.
 * @param env - The environment.
 * @param sub - `new` or `address`.
 * @param file - `new`'s file.
 * @param io - Output.
 * @returns The exit code.
 */
function yedKeyCommand(args: ParsedArgs, env: Record<string, string | undefined>, sub: string | undefined, file: string | undefined, io: RunIo): number {
  const network = (args.values.network ?? env.X402_NETWORK ?? "ycash:regtest") as YcashNetwork;
  if (!YCASH_NETWORKS.includes(network)) throw new UsageError(`--network must be one of ${YCASH_NETWORKS.join(", ")}`);
  let seed: Uint8Array;
  if (sub === "new") {
    if (!file) throw new UsageError("missing <FILE>");
    seed = randomBytes(48);
    writeFileSync(file, pq.formatYedKeySeed(seed), { mode: 0o600, flag: "wx" });
  } else if (sub === "address") {
    const path = args.values["yed-key-file"] ?? env.X402_YED_KEY_FILE;
    if (!path) throw new UsageError("yed-key address needs --yed-key-file");
    seed = pq.parseYedKeySeed(readFileSync(path, "utf8"));
  } else throw new UsageError(`unknown command: yed-key ${sub ?? ""}`);
  const key = pq.yedFalconKeyFromSeed(seed);
  seed.fill(0);
  io.out({ msg: "yed-key", network, yedAddress: pq.yedFalconAddress(network, key), pqAddress: pq.yedFalconPlainAddress(network, key), ...(sub === "new" ? { file } : {}) });
  return 0;
}
