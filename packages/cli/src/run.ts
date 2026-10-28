// Dispatch: `run(argv, env)` is the whole CLI, so tests drive it without a process.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pq, YCASH_NETWORKS, type YcashNetwork, type YcashRpc } from "x402-ycash-mechanism";
import { buildClient } from "./client.js";
import { channelClose, channelOpen, channelRefund, channelStatus, pay, type Out } from "./commands.js";
import { loadCliConfig, parseCli, USAGE, UsageError, type CliConfig, type ParsedArgs } from "./config.js";

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
