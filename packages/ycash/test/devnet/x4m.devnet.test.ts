// X4-M first measurements (plan §7 X4, §5.10), recorded as FINDING lines for docs/x4m-measurements.md.
// Slow (it proves a few hundred Sapling outputs), so it runs only with X402_X4M=1.
//   (a) merchant scan cost: wall time for a node to reconnect blocks full of Sapling outputs it cannot
//       decrypt, with 0, 1 and 10 Sapling keys, and with 1 key plus 50 diversified addresses of it;
//   (b) a viewing-key-only wallet: can it issue diversified addresses, and does it see mempool and
//       mined receipts at the merchant's diversified addresses?
import { performance } from "node:perf_hooks";
import { beforeAll, expect, it } from "vitest";
import { RpcError, type YcashRpc, type ZSendManyOptions } from "../../src/index.js";
import { describeDevnet, devnet, record, waitFor, type Devnet } from "./harness.js";

const run = process.env.X402_X4M === "1";
const describeX4m = run ? describeDevnet : (describeDevnet.skip as typeof describeDevnet);

/** Blocks in the shielded segment, Sapling outputs per block, repetitions per measurement. */
const N_BLOCKS = 5;
const OUTPUTS_PER_BLOCK = 50;
const REPS = 3;

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describeX4m("X4-M measurements", () => {
  let d: Devnet;
  let tOpts: ZSendManyOptions;

  beforeAll(async () => {
    d = await devnet();
    tOpts = d.line === "v6" ? { minconf: 1, privacyPolicy: "AllowFullyTransparent" } : { minconf: 1 };
  });

  it("(a) merchant scan cost: reconnecting blocks of foreign Sapling outputs, by wallet key count", async () => {
    const node = d.stock; // node 1: a wallet with no Sapling key yet
    const keysBefore = await node.call<string[]>("z_listaddresses");
    expect(keysBefore).toEqual([]);

    // The payer: one transparent source; the outputs go to the pool's own Sapling addresses.
    const payer = d.pool;
    const tFrom = await payer.getNewAddress();
    for (let i = 0; i < N_BLOCKS + 2; i++) await d.fund(tFrom, 200_000_000n);
    await d.mine(1);
    const zBase = await payer.zGetNewAddress();
    const recipients = [zBase];
    while (recipients.length < OUTPUTS_PER_BLOCK) recipients.push(await payer.zGetNewDiversifiedAddress(zBase));

    // Shielded segment: N blocks of one tx with OUTPUTS_PER_BLOCK outputs each.
    const proveMs: number[] = [];
    const shielded: string[] = [];
    for (let b = 0; b < N_BLOCKS; b++) {
      const t0 = performance.now();
      await payer.zSendManyAndWait(tFrom, recipients.map((address) => ({ address, amount: 100_000n })), { ...tOpts, timeoutMs: 600_000 });
      proveMs.push(performance.now() - t0);
      shielded.push(...(await d.mine(1)));
    }
    // Control segment: N blocks with one transparent tx each; a marker paying node 1 in the last one.
    const control: string[] = [];
    const sink = await d.wallet.getNewAddress();
    for (let b = 0; b < N_BLOCKS; b++) {
      await d.fund(sink, 1_000_000n);
      if (b === N_BLOCKS - 1) await d.fund(await node.getNewAddress(), 1_000_000n);
      control.push(...(await d.mine(1)));
    }
    const lastHash = control[control.length - 1]!;
    const markerBlock = await node.call<{ tx: string[] }>("getblock", [lastHash]);
    const marker = await findWalletTx(node, markerBlock.tx);

    /** invalidate `from` (and everything above it), then time reconsiderblock until the wallet has the marker confirmed. */
    const reconnect = async (from: string): Promise<{ rpcMs: number; walletMs: number }> => {
      await node.call("invalidateblock", [from]);
      await waitFor(async () => (await node.call<{ confirmations: number }>("gettransaction", [marker])).confirmations <= 0, { pollMs: 20, what: "the disconnect to reach the wallet" });
      const t0 = performance.now();
      await node.call("reconsiderblock", [from], { timeoutMs: 600_000 });
      const rpcMs = performance.now() - t0;
      await waitFor(async () => (await node.call<{ blockhash?: string }>("gettransaction", [marker])).blockhash === lastHash, { pollMs: 5, timeoutMs: 600_000, what: "the wallet to reconnect" });
      return { rpcMs, walletMs: performance.now() - t0 };
    };
    const measure = async (label: string) => {
      const all: { rpcMs: number; walletMs: number }[] = [];
      const ctl: { rpcMs: number; walletMs: number }[] = [];
      for (let r = 0; r < REPS; r++) {
        all.push(await reconnect(shielded[0]!));
        ctl.push(await reconnect(control[0]!));
      }
      const m = {
        label,
        saplingKeys: (await node.call<string[]>("z_listaddresses")).length,
        shieldedPlusControl: { walletMs: median(all.map((x) => x.walletMs)), rpcMs: median(all.map((x) => x.rpcMs)), samples: all.map((x) => Math.round(x.walletMs)) },
        controlOnly: { walletMs: median(ctl.map((x) => x.walletMs)), rpcMs: median(ctl.map((x) => x.rpcMs)), samples: ctl.map((x) => Math.round(x.walletMs)) },
      };
      return { ...m, shieldedOnlyWalletMs: m.shieldedPlusControl.walletMs - m.controlOnly.walletMs };
    };

    const results = [];
    results.push(await measure("no Sapling key"));
    const key1 = await node.zGetNewAddress();
    results.push(await measure("1 Sapling key"));
    for (let i = 0; i < 50; i++) await node.zGetNewDiversifiedAddress(key1);
    results.push(await measure("1 key + 50 diversified addresses"));
    for (let i = 0; i < 9; i++) await node.zGetNewAddress();
    results.push(await measure("10 Sapling keys"));

    record(d.line, "X4M-a", {
      nBlocks: N_BLOCKS,
      outputsPerBlock: OUTPUTS_PER_BLOCK,
      saplingOutputs: N_BLOCKS * OUTPUTS_PER_BLOCK,
      reps: REPS,
      proveMsPerTx: proveMs.map(Math.round),
      results: results.map((r) => ({ ...r, shieldedOnlyWalletMs: Math.round(r.shieldedOnlyWalletMs) })),
    });
    // Sanity: the node returned to the tip.
    expect(await node.call<string>("getbestblockhash")).toBe(lastHash);
  });

  it("(b) a viewing-key-only wallet: diversified addresses and receipts", async () => {
    const merchant = d.wallet;
    const watcher = d.nodes[3]!; // a wallet that will hold only the viewing key
    const base = await merchant.zGetNewAddress();
    const divBefore = await merchant.zGetNewDiversifiedAddress(base);
    const vkey = await merchant.call<string>("z_exportviewingkey", [base]);
    const importArgs = [vkey, "no"]; // same signature on both lines: rescan "no"
    const imported = await watcher.call<unknown>("z_importviewingkey", importArgs);
    const divAfter = await merchant.zGetNewDiversifiedAddress(base);

    const attempt = async <T>(f: () => Promise<T>): Promise<{ ok: T } | { error: string }> => {
      try {
        return { ok: await f() };
      } catch (e) {
        return { error: e instanceof RpcError ? `${e.code} ${e.message}` : String(e) };
      }
    };
    const issueOnWatcher = await attempt(() => watcher.zGetNewDiversifiedAddress(base));
    const validated = await watcher.call<Record<string, unknown>>("z_validateaddress", [divBefore]);

    const payer = d.pool;
    const tFrom = await payer.getNewAddress();
    await d.fund(tFrom, 100_000_000n);
    await d.fund(tFrom, 100_000_000n);
    await d.mine(1);
    const memoHex = Buffer.from("x402 viewing key probe", "utf8").toString("hex");
    const tx1 = await payer.zSendManyAndWait(tFrom, [{ address: divBefore, amount: 1_000_000n, memo: memoHex }], tOpts);
    const tx2 = await payer.zSendManyAndWait(tFrom, [{ address: divAfter, amount: 2_000_000n, memo: memoHex }], tOpts);
    await d.syncMempools();
    // The merchant (spending key) sees both in the mempool within a few seconds.
    await waitFor(async () => (await merchant.zListReceivedByAddress(divAfter, 0)).some((n) => n.txid === tx2), { what: "the merchant to see tx2" });
    const seen = async (addr: string, minconf: number) => attempt(async () => (await watcher.zListReceivedByAddress(addr, minconf)).map((n) => ({ txid: n.txid, amountZat: n.amountZat, confirmations: n.confirmations, memoOk: n.memo.startsWith(memoHex) })));
    // give the watcher the same few seconds
    await new Promise((r) => setTimeout(r, 3000));
    const mempool = { divBefore: await seen(divBefore, 0), divAfter: await seen(divAfter, 0), base: await seen(base, 0) };
    await d.mine(1);
    await new Promise((r) => setTimeout(r, 1000));
    const mined = { divBefore: await seen(divBefore, 1), divAfter: await seen(divAfter, 1), base: await seen(base, 1) };
    const watcherTx = await attempt(() => watcher.call<Record<string, unknown>>("z_viewtransaction", [tx1]));

    record(d.line, "X4M-b", { imported, issueOnWatcher, validatedOnWatcher: validated, tx1, tx2, mempool, mined, watcherViewTx1: "ok" in watcherTx ? { outputs: (watcherTx.ok as { outputs?: unknown[] }).outputs } : watcherTx });
    expect("error" in issueOnWatcher).toBe(true);
  });
});

/** The txid in `txids` that `node`'s wallet knows. */
async function findWalletTx(node: YcashRpc, txids: string[]): Promise<string> {
  for (const txid of txids) {
    try {
      await node.call("gettransaction", [txid]);
      return txid;
    } catch {
      // not a wallet tx of this node
    }
  }
  throw new Error("no wallet tx of the measured node in the marker block");
}
