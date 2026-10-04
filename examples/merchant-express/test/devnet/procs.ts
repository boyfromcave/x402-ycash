// Real processes for the HTTP devnet suite: the facilitator service, the merchant, the agent and the
// CLI, each started from source with tsx in its own package directory (so its tsconfig `paths` read
// the workspace packages from source, as `npm start` does). Output is JSON lines on stdout.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "../../../..");
const TSX = join(REPO, "node_modules/.bin/tsx");

export const PACKAGES = {
  facilitator: join(REPO, "packages/facilitator"),
  merchant: join(REPO, "examples/merchant-express"),
  agent: join(REPO, "examples/agent-client"),
  cli: join(REPO, "packages/cli"),
} as const;

export interface Proc {
  name: string;
  child: ChildProcess;
  /** Every stdout line parsed as JSON (non-JSON lines are kept as `{ text }`). */
  lines: Record<string, unknown>[];
  stderr: string[];
  exited: Promise<number>;
  stop(): Promise<void>;
}

function start(name: string, cwd: string, args: string[], env: Record<string, string>): Proc {
  // A clean environment: the devnet suite's own X402_* variables must not leak into a service.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("X402_") && !k.startsWith("MERCHANT_") && !k.startsWith("AGENT_")));
  const child = spawn(TSX, args, { cwd, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const lines: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  let buf = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        lines.push({ text: line });
      }
    }
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
  const exited = new Promise<number>((r) => child.once("close", (code, signal) => r(code ?? (signal ? 128 : 1))));
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(t);
  };
  return { name, child, lines, stderr, exited, stop };
}

/** Starts a service and waits for the log line carrying its URL. */
export async function startService(name: "facilitator" | "merchant", env: Record<string, string>, timeoutMs = 60_000): Promise<Proc & { url: string }> {
  const p = start(name, PACKAGES[name], ["src/main.ts"], env);
  const want = name === "facilitator" ? "listening" : "merchant listening";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = p.lines.find((l) => l.msg === want && typeof l.url === "string");
    if (ready) return Object.assign(p, { url: ready.url as string });
    if (p.child.exitCode !== null) throw new Error(`${name} exited ${p.child.exitCode}: ${p.stderr.join("")}${JSON.stringify(p.lines.slice(-5))}`);
    if (Date.now() > deadline) {
      await p.stop();
      throw new Error(`${name} did not start: ${p.stderr.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Runs the agent; resolves with its exit code and output when it finishes. */
export function runAgent(env: Record<string, string>): Proc {
  return start("agent", PACKAGES.agent, ["src/main.ts"], env);
}

/** Starts `x402-ycash <args>`, for a caller that acts while it runs (mines its funding). */
export function startCli(args: string[], env: Record<string, string> = {}): Proc {
  return start("cli", PACKAGES.cli, ["src/main.ts", ...args], env);
}

/** Runs `x402-ycash <args>`; resolves with exit code and output. */
export async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; lines: Record<string, unknown>[]; stderr: string }> {
  const p = startCli(args, env);
  const code = await p.exited;
  return { code, lines: p.lines, stderr: p.stderr.join("") };
}

/**
 * One more ycashd on a running devnet, with node 1's consensus flags (stock: no -yellowback) plus
 * `extraArgs`, its own datadir and ports, connected to nodes 0 and 1. The devnet CLI cannot add or
 * restart a single node with other flags, so a suite that needs one (a payer with
 * `-walletbroadcast=0`, an offline key holder) starts it here.
 */
export class SideNode {
  readonly url: string;
  readonly user = "side";
  readonly password: string;
  private child: ChildProcess | undefined;
  private readonly args: string[];

  constructor(
    private readonly bin: string,
    private readonly datadir: string,
    devnetDir: string,
    rpcPort: number,
    p2pPort: number,
    extraArgs: string[] = [],
  ) {
    const ps = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" }).split("\n");
    const node1 = ps.find((l) => l.includes(`-datadir=${devnetDir}/node1 `) || l.endsWith(`-datadir=${devnetDir}/node1`));
    if (!node1) throw new Error("devnet node 1 is not running");
    const flags = node1.split(/\s+/).slice(1).filter((a) => a.startsWith("-") && !a.startsWith("-datadir=") && !a.startsWith("-zmq"));
    const conf = ["ycash.conf", "zcash.conf"].find((n) => existsSync(join(devnetDir, "node0", n)));
    if (!conf) throw new Error(`no node conf in ${devnetDir}/node0`);
    const p2p = (n: number) => Number(/^port=(\d+)$/m.exec(readFileSync(join(devnetDir, `node${n}`, conf), "utf8"))?.[1]);
    mkdirSync(datadir, { recursive: true });
    this.password = "side-" + Math.random().toString(36).slice(2, 12);
    writeFileSync(join(datadir, conf), `regtest=1\nrpcuser=${this.user}\nrpcpassword=${this.password}\nport=${p2pPort}\nrpcport=${rpcPort}\nlistenonion=0\n`);
    this.args = [`-datadir=${datadir}`, ...flags, `-connect=127.0.0.1:${p2p(0)}`, `-connect=127.0.0.1:${p2p(1)}`, "-listen=0", ...extraArgs];
    this.url = `http://127.0.0.1:${rpcPort}`;
  }

  /** Starts the node and waits for RPC. */
  async start(ready: () => Promise<boolean>): Promise<void> {
    this.child = spawn(this.bin, this.args, { stdio: "ignore" });
    const deadline = Date.now() + 120_000;
    while (!(await ready().catch(() => false))) {
      if (this.child.exitCode !== null) throw new Error(`side node ${this.datadir} exited ${this.child.exitCode}`);
      if (Date.now() > deadline) throw new Error(`side node ${this.datadir} did not answer RPC`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Stops it (SIGTERM; ycashd shuts down cleanly on it). */
  async stop(): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    const exited = new Promise<void>((r) => c.once("exit", () => r()));
    c.kill("SIGTERM");
    const t = setTimeout(() => c.kill("SIGKILL"), 30_000);
    await exited;
    clearTimeout(t);
    this.child = undefined;
  }
}
