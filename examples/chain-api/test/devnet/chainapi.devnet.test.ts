// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The chain-data API end to end on a live devnet of either line: the facilitator and the API run
// as processes on node 0 (-insightexplorer -txindex), payments go to a node-1 wallet address (the
// faucet's role), and the reference agent pays from a key file made by `x402-ycash key new`.
//
//   scripts/devnet.sh up 6 191 && X402_DEVNET_JSON=…/6-191/devnet.json npm run test:devnet -w x402-ycash-chain-api
// With X402_LWD_URL (a lightwalletd serving node 0: `yellowback-devnet lightwalletd start --port P`),
// the agent also runs with --lwd and no node at all, as on the fast testnet.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { buildClient, loadCliConfig, parseCli } from "x402-ycash-cli";
import { tx } from "x402-ycash-mechanism";
import { DEVNET_JSON, describeDevnet, devnet, record, waitFor, type Devnet } from "../../../../packages/ycash/test/devnet/harness.js";

const NETWORK = "ycash:regtest";
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const TSX = join(REPO, "node_modules/.bin/tsx");
const PRICE = 10_000n;

interface Proc {
  child: ChildProcess;
  lines: Record<string, unknown>[];
  stderr: string[];
  exited: Promise<number>;
  stop(): Promise<void>;
}

function start(cwd: string, args: string[], env: Record<string, string>): Proc {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("X402_") && !k.startsWith("API_")));
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
  child.stderr?.setEncoding("utf8").on("data", (c: string) => stderr.push(c));
  const exited = new Promise<number>((r) => child.once("close", (code, signal) => r(code ?? (signal ? 128 : 1))));
  return {
    child,
    lines,
    stderr,
    exited,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(t);
    },
  };
}

async function service(cwd: string, env: Record<string, string>, want: string): Promise<Proc & { url: string }> {
  const p = start(cwd, ["src/main.ts"], env);
  const deadline = Date.now() + 90_000;
  for (;;) {
    const ready = p.lines.find((l) => l.msg === want && typeof l.url === "string");
    if (ready) return Object.assign(p, { url: ready.url as string });
    if (p.child.exitCode !== null) throw new Error(`${cwd} exited ${p.child.exitCode}: ${p.stderr.join("")}${JSON.stringify(p.lines.slice(-3))}`);
    if (Date.now() > deadline) {
      await p.stop();
      throw new Error(`${cwd} did not start: ${p.stderr.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describeDevnet("chain-data API: an agent pays, the API answers from the node", () => {
  let d: Devnet;
  let dir: string;
  let payTo: string;
  let keyFile: string;
  let agentAddress: string;
  let fac: Proc & { url: string };
  let api: Proc & { url: string };
  const procs: Proc[] = [];
  const devnetJson = DEVNET_JSON as string;

  const received = async (minconf: number): Promise<bigint> => BigInt(Math.round((await d.stock.call<number>("getreceivedbyaddress", [payTo, minconf])) * 1e8));
  /** The faucet's wallet sees the payments: zcashd notifies its wallet of mempool transactions asynchronously. */
  const receivedReaches = async (want: bigint): Promise<bigint> => {
    await d.syncMempools();
    let got = 0n;
    await waitFor(async () => (got = await received(0)) >= want, { timeoutMs: 30_000, what: "the payTo wallet to see the payments" }).catch(() => undefined);
    return got;
  };

  beforeAll(async () => {
    d = await devnet();
    dir = mkdtempSync(join(tmpdir(), "x402-chainapi-"));
    payTo = await d.stock.getNewAddress(); // the faucet's wallet in production
    fac = await service(join(REPO, "packages/facilitator"), {
      X402_NETWORK: NETWORK,
      X402_DEVNET_JSON: devnetJson,
      X402_DEVNET_NODE: "0",
      X402_PORT: "0",
      X402_SETTLEMENT_STORE: join(dir, "settlements.json"),
      X402_CHANNEL_STORE: join(dir, "fac-channels.json"),
      X402_CONFIRMATIONS_MIN: "-1",
    }, "listening");
    procs.push(fac);
    api = await service(join(REPO, "examples/chain-api"), {
      X402_NETWORK: NETWORK,
      API_ALLOW_REGTEST: "1",
      API_DEVNET_JSON: devnetJson,
      API_DEVNET_NODE: "0",
      API_PAY_TO: payTo,
      FACILITATOR_URL: fac.url,
      PORT: "0",
      API_UNPAID_PER_MINUTE: "30",
    }, "chain api listening");
    procs.push(api);

    // The agent's key, from the CLI's `key new`; funded with several coins (each payment spends one).
    const k = start(join(REPO, "packages/cli"), ["src/main.ts", "key", "new", join(dir, "agent.wif"), "--network", NETWORK], {});
    expect(await k.exited).toBe(0);
    keyFile = join(dir, "agent.wif");
    agentAddress = String(k.lines[0]?.address);
    expect(JSON.stringify(k.lines)).not.toContain(readFileSync(keyFile, "utf8").trim());
    await d.wallet.call("importaddress", [agentAddress, "", false]);
    for (let i = 0; i < 14; i++) await d.fund(agentAddress, 1_000_000n);
    await d.mine(1);
    record(d.line, "chain-api stack", { facilitator: fac.url, api: api.url, payTo, agent: agentAddress });
  });

  afterAll(async () => {
    await Promise.all(procs.map((p) => p.stop()));
  });

  it("the reference agent reads /pricing, pays each route from its key file, and every answer comes from the node", async () => {
    const before = await received(0);
    const a = start(join(REPO, "examples/chain-api"), ["src/agent/main.ts", api.url, "--wif-file", keyFile, "--devnet", devnetJson, "--node", "0", "--network", NETWORK, "--budget", "50000", "--reservations", join(dir, "res.json"), "--channels", join(dir, "ch.json")], {});
    procs.push(a);
    const code = await a.exited;
    const answers = a.lines.filter((l) => typeof l.path === "string");
    expect(code, a.stderr.join("") + JSON.stringify(a.lines)).toBe(0);
    expect(answers.map((l) => l.path)).toEqual(["/v1/chain", expect.stringMatching(/^\/v1\/block\/\d+$/), expect.stringMatching(/^\/v1\/tx\/[0-9a-f]{64}$/), `/v1/address/${agentAddress}`, "/v1/yellowback"]);
    expect(answers.every((l) => l.status === 200 && typeof l.paidTx === "string")).toBe(true);
    const tip = await d.tip();
    const [chain, block, t, addr, yb] = answers.map((l) => l.body as Record<string, unknown>);
    expect(chain).toMatchObject({ chain: "regtest" });
    expect(Number(chain!.blocks)).toBeGreaterThanOrEqual(tip - 1);
    expect(block).toMatchObject({ valuePools: expect.any(Array) });
    expect(t).toMatchObject({ coinbase: true, feeZat: null });
    expect(addr).toMatchObject({ address: agentAddress });
    expect(Number(addr!.utxoCount)).toBeGreaterThan(0);
    expect(typeof yb!.active).toBe("boolean");
    expect(a.lines.at(-1)).toMatchObject({ msg: "done", spentZat: String(5n * PRICE) });
    // Paid at the mempool (policy −1): the faucet's address got 5 × the price before any block.
    expect((await receivedReaches(before + 5n * PRICE)) - before).toBe(5n * PRICE);
    record(d.line, "chain-api agent", { paid: answers.map((l) => l.paidTx), ms: answers.map((l) => l.ms) });
  });

  (process.env.X402_LWD_URL ? it : it.skip)("the agent pays with only a key file and lightwalletd (--lwd, no node)", async () => {
    const k = start(join(REPO, "packages/cli"), ["src/main.ts", "key", "new", join(dir, "lwd.wif"), "--network", NETWORK], {});
    expect(await k.exited).toBe(0);
    const address = String(k.lines[0]?.address);
    // lightwalletd lists confirmed coins only: one per payment until the next block.
    for (let i = 0; i < 6; i++) await d.fund(address, 1_000_000n);
    await d.mine(1);
    const before = await received(0);
    const a = start(join(REPO, "examples/chain-api"), ["src/agent/main.ts", api.url, "--wif-file", join(dir, "lwd.wif"), "--lwd", process.env.X402_LWD_URL as string, "--network", NETWORK, "--budget", "50000", "--reservations", join(dir, "lwd-res.json"), "--channels", join(dir, "lwd-ch.json")], {});
    procs.push(a);
    const code = await a.exited;
    expect(code, a.stderr.join("") + JSON.stringify(a.lines)).toBe(0);
    const answers = a.lines.filter((l) => typeof l.path === "string");
    expect(answers).toHaveLength(5);
    expect(answers.every((l) => l.status === 200 && typeof l.paidTx === "string")).toBe(true);
    expect((await receivedReaches(before + 5n * PRICE)) - before).toBe(5n * PRICE);
    record(d.line, "chain-api agent over lightwalletd", { paid: answers.map((l) => l.paidTx), ms: answers.map((l) => l.ms) });
  });

  it("out of confirmed coins the agent says so; split, one block, and it pays in a row", async () => {
    const lwd = process.env.X402_LWD_URL;
    const chainArgs = lwd ? ["--lwd", lwd] : ["--devnet", devnetJson, "--node", "0"];
    const key = join(dir, "split.wif");
    const k = start(join(REPO, "packages/cli"), ["src/main.ts", "key", "new", key, "--network", NETWORK], {});
    expect(await k.exited).toBe(0);
    const address = String(k.lines[0]?.address);
    if (!lwd) await d.wallet.call("importaddress", [address, "", false]);
    await d.fund(address, 1_000_000n); // the faucet: one output per address
    await d.mine(1);
    const common = ["--wif-file", key, ...chainArgs, "--network", NETWORK, "--reservations", join(dir, "split-res.json"), "--channels", join(dir, "split-ch.json")];
    const agent = async (): Promise<Proc> => {
      const a = start(join(REPO, "examples/chain-api"), ["src/agent/main.ts", api.url, ...common, "--budget", "50000"], {});
      procs.push(a);
      await a.exited;
      return a;
    };
    const first = await agent();
    const firstAnswers = first.lines.filter((l) => typeof l.path === "string");
    expect(firstAnswers[0]).toMatchObject({ status: 200 });
    expect(firstAnswers[1]).toMatchObject({ error: "no confirmed coin left", hint: expect.stringMatching(/wait for a block or run: x402-ycash split/) });
    expect(firstAnswers).toHaveLength(2); // the agent stops at the hint
    await d.mine(1); // the change confirms
    const sp = start(join(REPO, "packages/cli"), ["src/main.ts", "split", "--count", "6", ...common], {});
    expect(await sp.exited, sp.stderr.join("")).toBe(0);
    const split = sp.lines[0] as { txid: string; outputs: number; eachZat: string };
    expect(split).toMatchObject({ msg: "split", outputs: 6 });
    expect(BigInt(split.eachZat)).toBeGreaterThanOrEqual(20_000n);
    await d.mine(1);
    const second = await agent();
    const answers = second.lines.filter((l) => typeof l.path === "string");
    expect(answers, JSON.stringify(second.lines)).toHaveLength(5);
    expect(answers.every((l) => l.status === 200)).toBe(true);
    record(d.line, "chain-api split", { split: split.txid, each: split.eachZat, over: lwd ? "lightwalletd" : "node" });
  });

  it("a paid transaction lookup reports the fee from the node's spent index", async () => {
    const txid = await d.fund(agentAddress, 1_000_000n); // a wallet spend: inputs and fee known
    const c = buildClient(loadCliConfig(parseCli(["pay", "x", "--wif-file", keyFile, "--devnet", devnetJson, "--node", "0", "--network", NETWORK, "--reservations", join(dir, "res.json"), "--channels", join(dir, "ch.json")]), {}));
    c.client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: "YEC", maxAmountPerPayment: "20000" }] });
    const http = new x402HTTPClient(c.client);
    const res0 = await fetch(`${api.url}/v1/tx/${txid}`);
    expect(res0.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res0.headers.get("PAYMENT-REQUIRED") as string);
    const payload = await c.client.createPaymentPayload(pr);
    const header = http.encodePaymentSignatureHeader(payload);
    const res = await fetch(`${api.url}/v1/tx/${txid}`, { headers: header });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const entry = await d.wallet.call<{ fee?: number }>("gettransaction", [txid]);
    expect(body).toMatchObject({ txid, inMempool: true, confirmations: 0 });
    expect(body.feeZat).toBe(Math.round(Math.abs(entry.fee ?? 0) * 1e8));

    // The same payment again: refused (one payment buys one request) with 409, and nothing is read.
    const again = await fetch(`${api.url}/v1/tx/${txid}`, { headers: header });
    expect(again.status).toBe(409);
  });

  it("refuses an underpayment and a payment for another network", async () => {
    const c = buildClient(loadCliConfig(parseCli(["pay", "x", "--wif-file", keyFile, "--devnet", devnetJson, "--node", "0", "--network", NETWORK, "--reservations", join(dir, "res.json"), "--channels", join(dir, "ch.json")]), {}));
    c.client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: "YEC", maxAmountPerPayment: "20000" }] });
    const res0 = await fetch(`${api.url}/v1/chain`);
    const pr = decodePaymentRequiredHeader(res0.headers.get("PAYMENT-REQUIRED") as string);
    const req = pr.accepts[0]!;
    // A real transaction paying one zatoshi less, presented as the full price.
    const low = await c.client.createPaymentPayload({ ...pr, accepts: [{ ...req, amount: (PRICE - 1n).toString() }] });
    await d.syncMempools();
    const before = await received(0);
    const under = await fetch(`${api.url}/v1/chain`, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({ ...low, accepted: req }) } });
    expect(under.status).toBe(402);
    // A valid payment presented for another network.
    const ok = await c.client.createPaymentPayload(pr);
    const wrong = await fetch(`${api.url}/v1/chain`, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({ ...ok, accepted: { ...req, network: "ycash:testnet" } }) } });
    expect(wrong.status).toBe(402);
    await d.syncMempools();
    expect(await received(0)).toBe(before); // neither was relayed
  });

  /**
   * Exactly one response carries a settlement, and that transaction pays payTo the price once; the
   * faucet's wallet got at least that (other tests' payments may still be reaching its wallet).
   */
  async function paidOnce(responses: Response[], before: bigint): Promise<void> {
    const settled = responses
      .map((r) => r.headers.get("PAYMENT-RESPONSE"))
      .filter((h): h is string => h !== null)
      .map((h) => JSON.parse(Buffer.from(h, "base64").toString("utf8")) as { success: boolean; transaction: string; errorReason?: string })
      .filter((p) => p.success);
    expect(settled).toHaveLength(1); // a refused second settle may say so in its header, never success
    const { transaction } = settled[0] as { transaction: string };
    const t = tx.parseTx(await d.wallet.call<string>("getrawtransaction", [transaction]));
    const toPayTo = t.vout.filter((o) => tx.equalBytes(o.scriptPubKey, tx.addressToScript(payTo, NETWORK)));
    expect(toPayTo.map((o) => o.value)).toEqual([PRICE]);
    expect((await receivedReaches(before + PRICE)) - before).toBeGreaterThanOrEqual(PRICE);
  }

  /** A payment signed by the agent's key for the route's 402, as a PAYMENT-SIGNATURE header. */
  async function signedPayment(path: string): Promise<Record<string, string>> {
    const c = buildClient(loadCliConfig(parseCli(["pay", "x", "--wif-file", keyFile, "--devnet", devnetJson, "--node", "0", "--network", NETWORK, "--reservations", join(dir, "res.json"), "--channels", join(dir, "ch.json")]), {}));
    c.client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: "YEC", maxAmountPerPayment: "20000" }] });
    const res0 = await fetch(`${api.url}${path}`);
    expect(res0.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res0.headers.get("PAYMENT-REQUIRED") as string);
    return new x402HTTPClient(c.client).encodePaymentSignatureHeader(await c.client.createPaymentPayload(pr));
  }

  it("one payment on many concurrent requests over mixed routes: exactly one answer, one settlement", async () => {
    await d.syncMempools();
    const before = await received(0);
    const header = await signedPayment("/v1/chain");
    const tip = await d.tip();
    const paths = ["/v1/chain", `/v1/block/${tip}`, "/v1/yellowback", `/v1/address/${agentAddress}`];
    const requests = Array.from({ length: 12 }, (_, i) =>
      i === 11
        ? fetch(`${api.url}/v1/broadcast`, { method: "POST", headers: { ...header, "content-type": "application/json" }, body: JSON.stringify({ hex: "00" }) })
        : fetch(`${api.url}${paths[i % paths.length]}`, { headers: header }),
    );
    const responses = await Promise.all(requests);
    const codes = responses.map((r) => r.status);
    expect(codes.filter((c) => c === 200), JSON.stringify(codes)).toHaveLength(1);
    expect(codes.filter((c) => c !== 200).every((c) => c === 409), JSON.stringify(codes)).toBe(true);
    await paidOnce(responses, before);
    // Later, the same payment is still refused.
    expect((await fetch(`${api.url}/v1/chain`, { headers: header })).status).toBe(409);
    record(d.line, "chain-api parallel replay", { codes });
  });

  it("one payment sent to two API processes at once (one facilitator): exactly one answer", async () => {
    const second = await service(join(REPO, "examples/chain-api"), {
      X402_NETWORK: NETWORK,
      API_ALLOW_REGTEST: "1",
      API_DEVNET_JSON: devnetJson,
      API_DEVNET_NODE: "0",
      API_PAY_TO: payTo,
      FACILITATOR_URL: fac.url,
      PORT: "0",
    }, "chain api listening");
    procs.push(second);
    await d.syncMempools();
    const before = await received(0);
    const header = await signedPayment("/v1/chain");
    const responses = await Promise.all([api.url, second.url, api.url, second.url].map((u) => fetch(`${u}/v1/chain`, { headers: header })));
    const codes = responses.map((r) => r.status);
    expect(codes.filter((c) => c === 200), JSON.stringify(codes)).toHaveLength(1);
    expect(codes.every((c) => c === 200 || c === 402 || c === 409), JSON.stringify(codes)).toBe(true);
    await paidOnce(responses, before);
    record(d.line, "chain-api two processes", { codes });
    await second.stop();
  });

  it("refuses to start on the wrong network: ycash:testnet against a regtest node", async () => {
    const p = start(join(REPO, "examples/chain-api"), ["src/main.ts"], { X402_NETWORK: "ycash:testnet", API_DEVNET_JSON: devnetJson, API_DEVNET_NODE: "0", API_PAY_TO: tx.encodeAddress("ycash:testnet", "p2pkh", tx.hash160(tx.pubkeyFromPriv(tx.randomPrivKey()))), PORT: "0" });
    procs.push(p);
    expect(await p.exited).toBe(2);
    expect(JSON.stringify(p.lines)).toMatch(/chain \\"test\\"/);
  });

  it("rate-limits unpaid requests per client address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await fetch(`${api.url}/v1/yellowback`)).status);
    expect(codes).toContain(429);
    expect(codes.filter((c) => c !== 402 && c !== 429)).toEqual([]);
  });
});
