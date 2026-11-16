// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The reference agent against a hostile API: /pricing says one thing, the 402s another. Every
// guard aborts before a payment is signed, so no PAYMENT-SIGNATURE ever reaches the server (and
// the payer's node, an unreachable address here, is never asked for coins).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { tx } from "x402-ycash-mechanism";
import { runAgent } from "../src/agent/agent.js";

const NETWORK = "ycash:regtest" as const;
const PAY_TO = tx.encodeAddress(NETWORK, "p2pkh", new Uint8Array(20).fill(7));
const OTHER = tx.encodeAddress(NETWORK, "p2pkh", new Uint8Array(20).fill(9));
const API = "http://127.0.0.1:9";

interface Seen {
  paths: string[];
  paid: number;
}

/** An API whose /pricing advertises PAY_TO at 10000 and whose 402s ask `ask`. */
function hostileApi(ask: { payTo: string; amount: string }, seen: Seen): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    seen.paths.push(url.pathname);
    if (req.headers.get("PAYMENT-SIGNATURE")) seen.paid++;
    if (url.pathname === "/pricing") {
      return Response.json({ network: NETWORK, payTo: PAY_TO, routes: ["/v1/chain", "/v1/block/:id", "/v1/tx/:txid", "/v1/address/:address", "/v1/yellowback"].map((path) => ({ method: "GET", path, priceZat: "10000" })) });
    }
    const required = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: url.href, description: "", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: NETWORK, asset: "YEC", amount: ask.amount, payTo: ask.payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "transparent" } }],
    });
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": required, "content-type": "application/json" } });
  }) as typeof fetch;
}

async function run(ask: { payTo: string; amount: string }, extra: string[] = []): Promise<{ code: number; out: Record<string, unknown>[]; seen: Seen }> {
  const dir = mkdtempSync(join(tmpdir(), "x402-agent-"));
  const key = join(dir, "k.wif");
  writeFileSync(key, tx.encodeWif(tx.randomPrivKey(), NETWORK), { mode: 0o600 });
  const out: Record<string, unknown>[] = [];
  const seen: Seen = { paths: [], paid: 0 };
  const args = [API, "--wif-file", key, "--network", NETWORK, "--rpc-url", "http://127.0.0.1:1", "--rpc-user", "u", "--rpc-password", "p", "--reservations", join(dir, "r.json"), "--channels", join(dir, "c.json"), ...extra];
  const code = await runAgent(args, {}, { out: (r) => out.push(r), err: () => undefined }, hostileApi(ask, seen));
  return { code, out, seen };
}

const errors = (out: Record<string, unknown>[]): string => out.map((l) => String(l.error ?? "")).join("\n");

describe("the reference agent's guards, end to end over its HTTP client", () => {
  it("pays only the payTo that /pricing names", async () => {
    const r = await run({ payTo: OTHER, amount: "10000" });
    expect(r.code).toBe(1);
    expect(errors(r.out)).toMatch(/another recipient than \/pricing/);
    expect(r.seen.paid).toBe(0);
  });

  it("refuses a 402 asking more than the route's /pricing price", async () => {
    const r = await run({ payTo: PAY_TO, amount: "15000" });
    expect(r.code).toBe(1);
    expect(errors(r.out)).toMatch(/asks 15000 zatoshis, \/pricing says 10000/);
    expect(r.seen.paid).toBe(0);
  });

  it("stops at the budget: nothing is signed past it", async () => {
    const r = await run({ payTo: PAY_TO, amount: "10000" }, ["--budget", "9999"]);
    expect(r.code).toBe(1);
    expect(errors(r.out)).toMatch(/budget: 0 of 9999 zatoshis spent, this payment is 10000/);
    expect(r.seen.paid).toBe(0);
    expect(r.out.at(-1)).toMatchObject({ msg: "done", spentZat: "0" });
  });
});
