// Dispatch: `run(argv, env)` is the whole CLI, so tests drive it without a process.
import type { YcashRpc } from "x402-ycash-mechanism";
import { buildClient } from "./client.js";
import { channelClose, channelOpen, channelRefund, channelStatus, pay, type Out } from "./commands.js";
import { loadCliConfig, parseCli, USAGE, UsageError } from "./config.js";

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
    const config = loadCliConfig(args, env, deps.node);
    const client = buildClient(config);
    const f = deps.fetch ?? fetch;
    if (cmd === "pay") return await pay(client, config, need(sub, "<url>"), io.out, f);
    if (cmd === "channel") {
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
  }
}
