// The TypeScript side of the Python interop suite (tests/devnet/test_interop.py), run with tsx from
// the repo's npm workspace. Commands (JSON on stdout):
//   pay <devnet.json> <node> <wif> <requirements.json>        -> {transaction}, built by ExactYcashScheme + LocalKeySigner
//   facilitate <devnet.json> <node> <requirements.json> <hex> -> {verify, settle}, by ExactYcashFacilitatorScheme
import { readFileSync } from "node:fs";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { exact, YcashRpc } from "../../../packages/ycash/src/index.js";

const [cmd, devnetJson, node, ...rest] = process.argv.slice(2);
if (!cmd || !devnetJson || node === undefined) throw new Error("usage: ts_bridge.ts {pay|facilitate} <devnet.json> <node> …");
const rpc = YcashRpc.fromDevnetJson(devnetJson, Number(node));
const readReq = (path: string): PaymentRequirements => JSON.parse(readFileSync(path, "utf8")) as PaymentRequirements;

if (cmd === "pay") {
  const [wif, reqPath] = rest as [string, string];
  const signer = new exact.LocalKeySigner(wif, new exact.RpcUtxoSource(rpc));
  const r = await new exact.ExactYcashScheme(signer).createPaymentPayload(2, readReq(reqPath));
  process.stdout.write(JSON.stringify(r.payload));
} else if (cmd === "facilitate") {
  const [reqPath, hex] = rest as [string, string];
  const req = readReq(reqPath);
  const payload: PaymentPayload = { x402Version: 2, accepted: structuredClone(req), payload: { transaction: hex } };
  const f = new exact.ExactYcashFacilitatorScheme(rpc, { confirmationTimeoutMs: 5_000, confirmationPollMs: 250 });
  const verify = await f.verify(payload, req);
  const settle = verify.isValid ? await f.settle(payload, req) : null;
  process.stdout.write(JSON.stringify({ verify, settle }));
} else {
  throw new Error(`unknown command ${cmd}`);
}
