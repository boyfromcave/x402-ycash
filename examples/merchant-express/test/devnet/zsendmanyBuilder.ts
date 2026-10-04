// TEST ONLY: a Sapling builder that speaks the builder contract (x402-ycash-mechanism shielded/builder.ts,
// `build {to, amountZat, memoHex, expiryHeight?} → {txHex, txid}` on stdin/stdout) by asking a node
// wallet's z_sendmany. z_sendmany always commits, and broadcasts unless the node runs with
// `-walletbroadcast=0` (plan Z-1), which is node-wide: so this is only for a dedicated payer node in the
// devnet suite, standing in for the Rust light client until it exists. It is never a production path.
//
// Environment: BUILDER_RPC_URL, BUILDER_RPC_USER, BUILDER_RPC_PASSWORD (the payer node, run with
// -walletbroadcast=0 -txexpirydelta=N), BUILDER_FROM (a transparent or Sapling source), BUILDER_LINE
// (v4 | v6), BUILDER_FEE_ZAT (default 2000: at or above the SDK floor of a 3-action t→z, 1500, and at most 4× 6.21.0's conventional fee, 4000, which its z_sendmany refuses to exceed).
import { YcashRpc, type ZSendManyOptions } from "x402-ycash-mechanism";

interface Request {
  to: string;
  amountZat: string;
  memoHex: string;
  expiryHeight?: number;
}

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

let raw = "";
for await (const chunk of process.stdin) raw += String(chunk);
const req = JSON.parse(raw) as Request;
const rpc = new YcashRpc({ url: env("BUILDER_RPC_URL"), user: env("BUILDER_RPC_USER"), password: env("BUILDER_RPC_PASSWORD") });
const from = env("BUILDER_FROM");
const opts: ZSendManyOptions = { minconf: 1, fee: BigInt(process.env.BUILDER_FEE_ZAT ?? "2000") };
// 6.21.0 needs a policy for a transparent source with transparent change (X-F12); a Sapling source needs none.
if (process.env.BUILDER_LINE === "v6" && !from.startsWith("yregtestsapling1")) opts.privacyPolicy = "AllowFullyTransparent";
const txid = await rpc.zSendManyAndWait(from, [{ address: req.to, amount: BigInt(req.amountZat), memo: req.memoHex }], opts);
// The wallet committed it without relaying: its hex is in the wallet (gettransaction), not in any mempool.
const { hex } = await rpc.call<{ hex: string }>("gettransaction", [txid]);
if (req.expiryHeight !== undefined) {
  const decoded = await rpc.call<{ expiryheight: number }>("decoderawtransaction", [hex]);
  if (decoded.expiryheight !== req.expiryHeight) {
    process.stderr.write(`z_sendmany set nExpiryHeight ${decoded.expiryheight}, the client asked ${req.expiryHeight} (run the payer node with -txexpirydelta to match)\n`);
    process.exit(2);
  }
}
process.stdout.write(JSON.stringify({ txHex: hex, txid }) + "\n");
