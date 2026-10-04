#!/usr/bin/env node
// Read-only helpers for smoke.sh: they query the payer's node, the merchant's unpaid 402 and the
// facilitator's /supported, and never sign or send anything. Secrets come from the environment
// (X402_RPC_PASSWORD, X402_RPC_COOKIE_FILE), never from argv, so they stay out of `ps`.
//
//   node smoke-lib.mjs chain                     → {"chain":"main","blocks":…,"branchId":"…"}
//   node smoke-lib.mjs offer <url> <scheme>      → the route's YEC requirement for X402_NETWORK
//   node smoke-lib.mjs supported <facilitator>   → the kinds it lists for X402_NETWORK
//   node smoke-lib.mjs field <json> <path>       → one field of a JSON document (dot path)
import { readFileSync } from "node:fs";

const [cmd, ...args] = process.argv.slice(2);
const network = process.env.X402_NETWORK ?? "";

function fail(msg) {
  process.stderr.write(`smoke: ${msg}\n`);
  process.exit(1);
}

/** The payer's node, from the same variables the x402-ycash CLI reads. */
function nodeAuth() {
  if (process.env.X402_DEVNET_JSON) {
    const d = JSON.parse(readFileSync(process.env.X402_DEVNET_JSON, "utf8"));
    const e = d.rpc[String(process.env.X402_DEVNET_NODE ?? "0")];
    const u = new URL(e.url);
    u.username = "";
    u.password = "";
    return { url: u.toString(), user: e.user, password: e.password };
  }
  const url = process.env.X402_RPC_URL;
  if (!url) fail("no node: set X402_RPC_URL (with X402_RPC_USER + X402_RPC_PASSWORD, or X402_RPC_COOKIE_FILE)");
  if (process.env.X402_RPC_COOKIE_FILE) {
    const [user, password] = readFileSync(process.env.X402_RPC_COOKIE_FILE, "utf8").trim().split(":");
    return { url, user, password };
  }
  return { url, user: process.env.X402_RPC_USER ?? "", password: process.env.X402_RPC_PASSWORD ?? "" };
}

async function rpc(method, params = []) {
  const { url, user, password } = nodeAuth();
  // UTF-8 basic auth by hand: the credentials may hold non-ASCII characters.
  const auth = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: "1.0", id: "smoke", method, params }),
  });
  const body = await res.json().catch(() => fail(`node answered HTTP ${res.status}`));
  if (body.error) fail(`node ${method}: ${body.error.message}`);
  return body.result;
}

/** The decoded PAYMENT-REQUIRED of an unpaid GET. */
async function paymentRequired(url) {
  const res = await fetch(url);
  if (res.status !== 402) fail(`${url} answered ${res.status}, not 402`);
  const header = res.headers.get("payment-required");
  if (header) return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  return res.json();
}

const out = (v) => process.stdout.write(JSON.stringify(v) + "\n");

switch (cmd) {
  case "chain": {
    const info = await rpc("getblockchaininfo");
    out({ chain: info.chain, blocks: info.blocks, branchId: info.consensus?.nextblock ?? null });
    break;
  }
  case "offer": {
    const [url, scheme] = args;
    const pr = await paymentRequired(url);
    const offers = (pr.accepts ?? []).filter((a) => a.scheme === scheme && a.network === network && a.asset === "YEC");
    if (offers.length === 0) {
      const seen = (pr.accepts ?? []).map((a) => `${a.scheme} ${a.network} ${a.asset}`).join(", ") || "nothing";
      fail(`${url} offers no ${scheme} YEC on ${network} (it offers ${seen})`);
    }
    out(offers[0]);
    break;
  }
  case "supported": {
    const [url] = args;
    const res = await fetch(new URL("supported", url.endsWith("/") ? url : `${url}/`));
    if (!res.ok) fail(`facilitator /supported answered ${res.status}`);
    const body = await res.json();
    out((body.kinds ?? []).filter((k) => k.network === network));
    break;
  }
  case "field": {
    const [json, path] = args;
    let v = JSON.parse(json);
    for (const k of path.split(".")) v = v?.[k];
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    break;
  }
  default:
    fail("usage: smoke-lib.mjs chain | offer <url> <scheme> | supported <facilitator> | field <json> <path>");
}
