// Generates vectors/sapling/sapling_devnet.json: wallet-built shielded payments (t→z and z→z, both
// node lines) to a diversified address of a key whose `zxview…` viewing key is recorded, so the
// `sapling` method's offline trial decryption (packages/ycash/src/shielded/sapling/decrypt.ts) is
// checked against notes a real node encrypted (ZIP 212 lead byte 0x02, PRF^expand rcm and esk).
//
//   X402_SCRATCH=… scripts/devnet.sh up dd <seed>
//   X402_DEVNET_JSON=$X402_SCRATCH/dd-<seed>/devnet.json npx tsx vectors/sapling/generate.ts
//   (then the same with `6` for the 6.21.0 line; the script appends a case per line)
//
// It needs node 0's funded wallet. The raw transaction is read while the payment is in the mempool
// (`getrawtransaction` needs no -txindex there), then mined so the wallet reports the note.
// test/unit/shielded/decrypt.test.ts runs the devnet section when this file exists.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { YcashRpc } from "../../packages/ycash/src/node/index.js";
import { memoToHex } from "../../packages/ycash/src/shielded/index.js";

interface Case {
  line: string;
  node: string;
  network: "ycash:regtest";
  viewingKey: string;
  baseAddress: string;
  payTo: string;
  payments: { kind: "t→z" | "z→z"; txid: string; hex: string; amountZat: string; memo: string; outputIndex: number }[];
}

const path = process.env.X402_DEVNET_JSON;
if (!path) throw new Error("X402_DEVNET_JSON is not set");
const wallet = YcashRpc.fromDevnetJson(path, 0, { timeoutMs: 120_000 });
const pool = YcashRpc.fromDevnetJson(path, 2, { timeoutMs: 120_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mines on the pool node, once it holds the wallet's mempool, and waits for the wallet node to see the tip.
 *
 * @param n - Blocks to mine.
 */
async function mine(n: number): Promise<void> {
  // The pool mines only what reached its mempool: wait for every wallet transaction to relay first.
  const want = await wallet.getRawMempool();
  for (let i = 0; i < 300; i++) {
    const have = new Set(await pool.getRawMempool());
    if (want.every((t) => have.has(t))) break;
    await sleep(200);
  }
  await pool.call("generate", [n]);
  const tip = await pool.getBlockCount();
  while ((await wallet.getBlockCount()) < tip) await sleep(200);
}

/**
 * Polls until a condition holds (60 s).
 *
 * @param cond - The condition.
 * @param what - For the timeout error.
 */
async function until(cond: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The output index of the note at payTo, from the wallet.
 *
 * @param payTo - The diversified address.
 * @param txid - The payment.
 * @returns outindex.
 */
async function outputIndexOf(payTo: string, txid: string): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const notes = await wallet.zListReceivedByAddress(payTo, 0);
    const n = notes.find((x) => x.txid === txid);
    if (n && n.outindex !== undefined) return n.outindex;
    await sleep(200);
  }
  throw new Error(`the wallet never reported ${txid} at ${payTo}`);
}

const info = await wallet.call<{ subversion: string }>("getnetworkinfo");
const base = await wallet.zGetNewAddress();
const viewingKey = await wallet.call<string>("z_exportviewingkey", [base]);
const payTo = await wallet.zGetNewDiversifiedAddress(base);
const memo = "x402:" + "5e".repeat(32);
const amountZat = 1_500_000n;

// A funded transparent address of the wallet for the t→z payment and for shielding.
const taddr = await wallet.call<string>("getnewaddress");
// A second funded address shields the z→z payer's note: reusing taddr right after the t→z races the
// wallet's view of the coin that payment spent (4.5.0: "inputs already spent" at commit).
const taddr2 = await wallet.call<string>("getnewaddress");
await wallet.call("sendtoaddress", [taddr, 1.0]);
await wallet.call("sendtoaddress", [taddr2, 1.0]);
await mine(1);
// getblockcount advances before the wallet has processed the block: wait for the coins themselves.
for (const a of [taddr, taddr2]) await until(async () => (await wallet.listUnspent(1, 9_999_999, [a])).length > 0, `a confirmed coin at ${a}`);

const payments: Case["payments"] = [];
// 6.21.0: a transparent source has transparent change, which needs AllowFullyTransparent (X-F12).
const privacy = info.subversion.includes("6.") ? { privacyPolicy: "AllowFullyTransparent" } : {};
// t→z
const tz = await wallet.zSendManyAndWait(taddr, [{ address: payTo, amount: amountZat, memo: memoToHex(memo) }], { fee: 1000n, ...privacy });
payments.push({ kind: "t→z", txid: tz, hex: await wallet.call<string>("getrawtransaction", [tz]), amountZat: amountZat.toString(), memo, outputIndex: await outputIndexOf(payTo, tz) });
await mine(1);
// z→z: shield to a second key of the wallet first, then pay payTo from it.
const payer = await wallet.zGetNewAddress();
await wallet.zSendManyAndWait(taddr2, [{ address: payer, amount: 50_000_000n }], { fee: 1000n, ...privacy });
await mine(1);
await until(async () => (await wallet.zListReceivedByAddress(payer, 1)).length > 0, `a confirmed note at ${payer}`);
const zz = await wallet.zSendManyAndWait(payer, [{ address: payTo, amount: amountZat, memo: memoToHex(memo) }], { fee: 1000n });
payments.push({ kind: "z→z", txid: zz, hex: await wallet.call<string>("getrawtransaction", [zz]), amountZat: amountZat.toString(), memo, outputIndex: await outputIndexOf(payTo, zz) });
await mine(1);

const out = join(dirname(fileURLToPath(import.meta.url)), "sapling_devnet.json");
const doc: { description: string; cases: Case[] } = existsSync(out)
  ? (JSON.parse(readFileSync(out, "utf8")) as { description: string; cases: Case[] })
  : {
      description:
        "Wallet-built shielded payments to a diversified address of a recorded viewing key, per node line, for the sapling method's offline trial decryption (generated by vectors/sapling/generate.ts). outputIndex is the wallet's outindex of the note at payTo.",
      cases: [],
    };
doc.cases = doc.cases.filter((c) => c.node !== info.subversion);
doc.cases.push({ line: info.subversion.includes("4.5") ? "dd" : "6", node: info.subversion, network: "ycash:regtest", viewingKey, baseAddress: base, payTo, payments });
writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
console.log(`wrote ${out}: ${doc.cases.map((c) => `${c.node} (${c.payments.length} payments)`).join(", ")}`);
