// Tests for x402.yaml (semgrep --test contrib/semgrep/rules). Not compiled, not shipped.
import express from "express";
import { paymentMiddleware } from "@x402/express";

export function bad(paid: object, server: object) {
  const app = express();
  // ruleid: x402.payments.route-before-paywall
  app.get("/report", (_req, res) => {
    res.json({ report: "served unpaid" });
  });
  // ok: x402.payments.route-before-paywall
  app.get("/gated", (_req, res, next) => {
    next();
  });
  app.use(paymentMiddleware(paid, server));
  // ok: x402.payments.route-before-paywall
  app.get("/after", (_req, res) => {
    res.json({ report: "paid" });
  });
}

export function nonce(): string {
  // ruleid: x402.crypto.non-crypto-rng
  const weak = Math.random().toString(36);
  // ok: x402.crypto.non-crypto-rng
  const strong = crypto.getRandomValues(new Uint8Array(16));
  return weak + strong.toString();
}

export async function rpcs(rpc: { call(m: string): Promise<string> }) {
  // ruleid: x402.node.yed-write-rpc
  await rpc.call("yed_send");
  // ruleid: x402.node.yed-write-rpc
  await rpc.call("yed_mint");
  // ok: x402.node.yed-write-rpc
  await rpc.call("yed_getnewaddress");
  // ok: x402.node.yed-write-rpc
  await rpc.call("yed_validaterawtransaction");
  // ok: x402.node.yed-write-rpc
  // a comment that names `yed_send` is not a call
  await rpc.call("getinfo");
}
