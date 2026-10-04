// The TypeScript side of the Python interop suites (tests/devnet/test_interop.py, test_parity.py), run
// with tsx from the repo's npm workspace. Commands (JSON on stdout):
//   pay <devnet.json> <node> <wif> <requirements.json>        -> {transaction}, built by ExactYcashScheme + LocalKeySigner (YEC or YED)
//   facilitate <devnet.json> <node> <requirements.json> <hex> -> {verify, settle}, by ExactYcashFacilitatorScheme
//   shielded-pay <devnet.json> <node> <from> <requirements.json> -> {txid}, by ShieldedExactClient (z_sendmany)
//   verify-receipt <receipt.json> <pubkey hex>                -> {payload}, by verifyReceipt (or exit 1 with the error)
//   batch-client <devnet.json> <node> <deposit>               -> a JSON-lines session on stdin/stdout driving one
//       BatchYcashClientScheme (rpcWalletFunder on <node>): {"op":"pay","req":…} -> {"payload":…};
//       {"op":"apply","settle":…} -> {"ok":true}; {"op":"close","channelId":…} -> {"payload":…}; {"op":"exit"}
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { BatchYcashClientScheme, exact, rpcWalletFunder, shielded, YcashRpc } from "../../../packages/ycash/src/index.js";

const [cmd, ...args] = process.argv.slice(2);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const out = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");

if (cmd === "pay") {
  const [devnetJson, node, wif, reqPath] = args as [string, string, string, string];
  const rpc = YcashRpc.fromDevnetJson(devnetJson, Number(node));
  const signer = new exact.LocalKeySigner(wif, new exact.RpcUtxoSource(rpc));
  const r = await new exact.ExactYcashScheme(signer).createPaymentPayload(2, readJson<PaymentRequirements>(reqPath));
  out(r.payload);
} else if (cmd === "facilitate") {
  const [devnetJson, node, reqPath, hex] = args as [string, string, string, string];
  const rpc = YcashRpc.fromDevnetJson(devnetJson, Number(node));
  const req = readJson<PaymentRequirements>(reqPath);
  const payload: PaymentPayload = { x402Version: 2, accepted: structuredClone(req), payload: { transaction: hex } };
  const f = new exact.ExactYcashFacilitatorScheme(rpc, { confirmationTimeoutMs: 5_000, confirmationPollMs: 250 });
  const verify = await f.verify(payload, req);
  const settle = verify.isValid ? await f.settle(payload, req) : null;
  out({ verify, settle });
} else if (cmd === "shielded-pay") {
  const [devnetJson, node, from, reqPath] = args as [string, string, string, string];
  const rpc = YcashRpc.fromDevnetJson(devnetJson, Number(node), { timeoutMs: 120_000 });
  const { payload } = await new shielded.ShieldedExactClient({ rpc, from }).createPaymentPayload(2, readJson<PaymentRequirements>(reqPath));
  out(payload);
} else if (cmd === "verify-receipt") {
  const [receiptPath, pub] = args as [string, string];
  out({ payload: shielded.verifyReceipt(readJson<shielded.JwsSignedArtifact>(receiptPath), { trustedPublicKeys: [pub] }) });
} else if (cmd === "batch-client") {
  const [devnetJson, node, deposit] = args as [string, string, string];
  const rpc = YcashRpc.fromDevnetJson(devnetJson, Number(node), { timeoutMs: 60_000 });
  const client = new BatchYcashClientScheme({ chain: rpc, funder: rpcWalletFunder(rpc), deposit: () => BigInt(deposit), lockSlackBlocks: 3 });
  // One request at a time, in order: the client's channel state is sequential.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line) as { op: string; req?: PaymentRequirements; settle?: SettleResponse; channelId?: string };
    try {
      if (m.op === "pay") out({ payload: (await client.createPaymentPayload(2, m.req as PaymentRequirements)).payload });
      else if (m.op === "apply") out({ ok: await client.applySettleResponse(m.settle as SettleResponse).then(() => true) });
      else if (m.op === "close") out({ payload: (await client.closePayload(m.channelId as string)).payload });
      else if (m.op === "exit") break;
      else out({ error: `unknown op ${m.op}` });
    } catch (e) {
      out({ error: (e as Error).message });
    }
  }
  process.exit(0); // keep-alive sockets would hold the loop open
} else {
  throw new Error(`unknown command ${String(cmd)}`);
}
