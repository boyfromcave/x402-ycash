// Live checks of the plan's node assumptions (plan §3 R-2, R-3, R-5, R-6, Z-3; §5.5 replacement).
// Each test records the exact RPC outputs as `FINDING <line> <item>: <json>` lines.
import { beforeAll, expect, it } from "vitest";
import { RpcError, SendRawTransactionError, type ZReceived } from "../../src/node/index.js";
import { describeDevnet, devnet, record, waitFor, type Devnet } from "./harness.js";

const FEE = 10_000n;

function errorOf(e: unknown): Record<string, unknown> {
  if (e instanceof SendRawTransactionError) return { code: e.code, message: e.message, kind: e.kind, rejectCode: e.rejectCode };
  if (e instanceof RpcError) return { code: e.code, message: e.message };
  throw e;
}

describeDevnet("plan assumptions on a live devnet", () => {
  let d: Devnet;
  beforeAll(async () => {
    d = await devnet();
  });

  /** A signed 1-in-1-out spend of `u` from node 0's wallet to `to`. */
  async function spend(u: { txid: string; vout: number; zat: bigint }, to: string, fee = FEE, expiry?: number): Promise<string> {
    const raw = await d.wallet.createRawTransaction([{ txid: u.txid, vout: u.vout }], { [to]: u.zat - fee }, 0, expiry);
    const signed = await d.wallet.signRawTransactionWithWallet(raw);
    expect(signed.complete).toBe(true);
    return signed.hex;
  }

  it("R-5: signrawtransaction hex [] [] verifies scripts without keys, on the stock node too", async () => {
    const mine = await d.utxo(d.wallet, 40_000_000n);
    const theirs = await d.utxo(d.pool, 40_000_000n);
    const to = await d.stock.getNewAddress();
    const inputs = [mine, theirs].map((u) => ({ txid: u.txid, vout: u.vout }));
    const unsigned = await d.wallet.createRawTransaction(inputs, { [to]: 79_980_000n });

    const results: Record<string, unknown> = {};
    for (const [name, node] of [["wallet", d.wallet], ["stock", d.stock]] as const) {
      const r = await node.verifyScripts(unsigned);
      results[`unsigned@${name}`] = r;
      expect(r.complete).toBe(false);
      expect(r.errors).toHaveLength(2);
    }
    // node 0 signs its own input only: partially signed.
    const partial = await d.wallet.signRawTransactionWithWallet(unsigned);
    results["walletSign(partial)"] = { complete: partial.complete, errors: partial.errors };
    expect(partial.complete).toBe(false);
    const partialCheck = await d.stock.verifyScripts(partial.hex);
    results["partial@stock"] = partialCheck;
    expect(partialCheck.complete).toBe(false);
    expect(partialCheck.errors.map((e) => e.vout)).toEqual([theirs.vout]);
    expect(partialCheck.errors[0]?.txid).toBe(theirs.txid);
    // the pool signs the rest: complete, and verifiable anywhere.
    const full = await d.pool.signRawTransactionWithWallet(partial.hex);
    expect(full.complete).toBe(true);
    for (const [name, node] of [["wallet", d.wallet], ["stock", d.stock], ["pool", d.pool]] as const) {
      const r = await node.verifyScripts(full.hex);
      results[`full@${name}`] = r;
      expect(r).toEqual({ complete: true, errors: [] });
    }
    // A corrupted signature (one byte inside input 0's DER signature) is caught without keys.
    const sig = (await d.wallet.decodeRawTransaction(full.hex)).vin[0]?.scriptSig?.hex as string;
    const bad = sig.slice(0, 20) + (sig[20] === "0" ? "1" : "0") + sig.slice(21);
    const corrupt = full.hex.replace(sig, bad);
    const corruptCheck = await d.stock.verifyScripts(corrupt);
    results["corruptSig@stock"] = corruptCheck;
    expect(corruptCheck.complete).toBe(false);
    expect(corruptCheck.errors.map((e) => e.vout)).toEqual([mine.vout]);
    // verifyScripts does not change the transaction.
    expect((await d.stock.call<{ hex: string }>("signrawtransaction", [full.hex, [], []])).hex).toBe(full.hex);
    record(d.line, "R-5", results);
    await d.stock.sendRawTransaction(full.hex);
    await d.mine(1);
  });

  it("R-6: gettxout hides a mempool-spent output with includemempool=true and reports confirmations", async () => {
    const u = await d.utxo(d.wallet, 30_000_000n);
    const before = { mempoolTrue: await d.wallet.getTxOut(u.txid, u.vout, true), mempoolFalse: await d.wallet.getTxOut(u.txid, u.vout, false) };
    const to = await d.stock.getNewAddress();
    const txid = await d.wallet.sendRawTransaction(await spend(u, to));
    await d.syncMempools();
    const after: Record<string, unknown> = {};
    for (const [name, node] of [["wallet", d.wallet], ["stock", d.stock]] as const) {
      after[`spent.true@${name}`] = await node.getTxOut(u.txid, u.vout, true);
      after[`spent.false@${name}`] = await node.getTxOut(u.txid, u.vout, false);
      after[`new.true@${name}`] = await node.getTxOut(txid, 0, true);
      after[`new.false@${name}`] = await node.getTxOut(txid, 0, false);
      expect(after[`spent.true@${name}`]).toBeNull();
      expect((after[`spent.false@${name}`] as { confirmations: number }).confirmations).toBe(1);
      expect((after[`new.true@${name}`] as { confirmations: number }).confirmations).toBe(0);
      expect(after[`new.false@${name}`]).toBeNull();
    }
    await d.mine(2);
    const mined = { spentFalse: await d.stock.getTxOut(u.txid, u.vout, false), newTrue: await d.stock.getTxOut(txid, 0, true), newFalse: await d.stock.getTxOut(txid, 0, false) };
    expect(mined.spentFalse).toBeNull();
    expect(mined.newTrue?.confirmations).toBe(2);
    expect(mined.newFalse?.confirmations).toBe(2);
    record(d.line, "R-6", { before, after, mined });
  });

  it("R-3: a resubmission from the mempool returns the txid; after mining -27; once spent, not -27", async () => {
    const u = await d.utxo(d.wallet, 30_000_000n);
    const to = await d.wallet.getNewAddress();
    const hex = await spend(u, to);
    const first = await d.wallet.sendRawTransaction(hex);
    const second = await d.wallet.sendRawTransaction(hex);
    await d.syncMempools();
    const onStock = await d.stock.sendRawTransaction(hex);
    expect(second).toBe(first);
    expect(onStock).toBe(first);
    await d.mine(1);
    const mined = await d.wallet.sendRawTransaction(hex).catch(errorOf);
    expect(mined).toMatchObject({ code: -27, kind: "already-in-chain" });
    // Spend its only output, mine, and resubmit again: the coins are gone, so the node no longer knows it.
    const hex2 = await spend({ txid: first, vout: 0, zat: u.zat - FEE }, await d.wallet.getNewAddress());
    await d.wallet.sendRawTransaction(hex2);
    await d.mine(1);
    const spentResubmit = await d.wallet.sendRawTransaction(hex).catch(errorOf);
    record(d.line, "R-3", { first, second, onStock, afterMining: mined, afterOutputsSpent: spentResubmit });
    expect(spentResubmit).not.toMatchObject({ code: -27 });
  });

  it("§5.5: a double spend of a mempool tx's input is refused on both seats (no replace-by-fee)", async () => {
    const u = await d.utxo(d.wallet, 30_000_000n);
    const t1 = await d.wallet.sendRawTransaction(await spend(u, await d.stock.getNewAddress()));
    await d.syncMempools();
    // Same input, ten times the fee, a different payee.
    const t2hex = await spend(u, await d.pool.getNewAddress(), FEE * 10n);
    const atWallet = await d.wallet.sendRawTransaction(t2hex).catch(errorOf);
    const atStock = await d.stock.sendRawTransaction(t2hex).catch(errorOf);
    const verify = await d.stock.verifyScripts(t2hex);
    const mempools = { wallet: await d.wallet.getRawMempool(), stock: await d.stock.getRawMempool() };
    record(d.line, "replacement", { atWallet, atStock, t2ScriptsValid: verify.complete, t1InMempools: [mempools.wallet.includes(t1), mempools.stock.includes(t1)] });
    expect(atWallet).toMatchObject({ kind: "mempool-conflict" });
    expect(atStock).toMatchObject({ kind: "mempool-conflict" });
    expect(mempools.wallet).toContain(t1);
    expect(mempools.stock).toContain(t1);
    await d.mine(1);
    const afterMined = await d.wallet.sendRawTransaction(t2hex).catch(errorOf);
    // Script verification after the input is spent in the chain: the input is reported, not the script.
    const verifyAfterMined = await d.stock.verifyScripts(t2hex);
    record(d.line, "replacement-after-mining", { resend: afterMined, verifyScripts: verifyAfterMined });
    expect(afterMined).toMatchObject({ kind: "missing-inputs" });
    expect(verifyAfterMined.complete).toBe(false);
  });

  it("R-2: createrawtransaction refuses expiry below next+3; an expired tx is dropped and cannot be mined", async () => {
    const u = await d.utxo(d.wallet, 30_000_000n);
    const tip = await d.tip();
    const to = await d.wallet.getNewAddress();
    const outputs = { [to]: u.zat - FEE };
    const inputs = [{ txid: u.txid, vout: u.vout }];
    const tooSoon = await d.wallet.createRawTransaction(inputs, outputs, 0, tip + 3).catch(errorOf);
    expect(tooSoon).toMatchObject({ code: -8 });
    const zero = await d.wallet.createRawTransaction(inputs, outputs, 0, 0);
    expect((await d.wallet.decodeRawTransaction(zero)).expiryheight).toBe(0);
    const minimum = tip + 4; // next + TX_EXPIRING_SOON_THRESHOLD
    const hex = (await d.wallet.signRawTransactionWithWallet(await d.wallet.createRawTransaction(inputs, outputs, 0, minimum))).hex;
    const txid = (await d.wallet.decodeRawTransaction(hex)).txid;

    // Isolate node 4 (an idle pool), give it the tx, and let the rest of the network mine past its expiry.
    const lonely = d.nodes[4]!;
    const peers = (await lonely.call<{ addr: string; inbound: boolean }[]>("getpeerinfo")).filter((p) => !p.inbound).map((p) => p.addr);
    await lonely.call("setban", ["127.0.0.1", "add", 3600]);
    await waitFor(async () => (await lonely.call<unknown[]>("getpeerinfo")).length === 0, { what: "node 4 to drop its peers" });
    try {
      expect(await lonely.sendRawTransaction(hex)).toBe(txid);
      expect(await lonely.getRawMempool()).toContain(txid);
      const others = d.nodes.filter((n) => n !== lonely);
      // A tx is valid through height nExpiryHeight; the block after it expires it (IsExpiredTx).
      await d.pool.generate(minimum - tip + 1);
      await waitFor(async () => (await Promise.all(others.map((n) => n.getBlockCount()))).every((h) => h === minimum + 1), { what: "the others to pass the expiry height" });
    } finally {
      await lonely.call("setban", ["127.0.0.1", "remove"]);
      await lonely.call("clearbanned");
      for (const addr of peers) await lonely.call("addnode", [addr, "onetry"]);
    }
    await d.syncBlocks();
    const stillThere = (await lonely.getRawMempool()).includes(txid);
    const resend = await d.wallet.sendRawTransaction(hex).catch(errorOf);
    const lonelyResend = await lonely.sendRawTransaction(hex).catch(errorOf);
    const block = await lonely.generate(1);
    const minedTxs = (await lonely.call<{ tx: string[] }>("getblock", [block[0]])).tx;
    await d.syncBlocks();
    record(d.line, "R-2", { tip, tooSoon, minimumAccepted: minimum, droppedFromIsolatedMempool: !stillThere, resend, lonelyResend, includedInNextBlock: minedTxs.includes(txid) });
    expect(stillThere).toBe(false);
    expect(resend).toMatchObject({ kind: "expiring-soon" });
    expect(minedTxs).not.toContain(txid);
  });

  it("item 6: the branch id getblockchaininfo reports for the next block", async () => {
    const info = await d.wallet.getBlockchainInfo();
    const stock = await d.stock.getBlockchainInfo();
    record(d.line, "branch-id", { consensus: info.consensus, stockConsensus: stock.consensus, upgrades: Object.fromEntries(Object.entries(info.upgrades).map(([id, u]) => [id, `${u.name}@${u.activationheight}:${u.status}`])) });
    expect(stock.consensus).toEqual(info.consensus);
    expect(info.consensus.nextblock).toBe("19bd2d2f"); // Canopy, on both lines' devnets
  });

  it("Z-3: z_getnewdiversifiedaddress, and z_listreceivedbyaddress … 0 on an unconfirmed incoming payment with memo", async () => {
    const base = await d.wallet.zGetNewAddress();
    const div = [await d.wallet.zGetNewDiversifiedAddress(base), await d.wallet.zGetNewDiversifiedAddress(base)];
    expect(new Set([base, ...div]).size).toBe(3);
    const validated = await d.wallet.call<{ isvalid: boolean; ismine?: boolean; diversifier?: string }>("z_validateaddress", [div[0]]);

    const from = await d.pool.getNewAddress();
    await d.fund(from, 30_000_000n);
    await d.mine(1);
    const memo = Buffer.from("x402 request 42", "utf8").toString("hex");
    const opts = d.line === "v6" ? { minconf: 1, privacyPolicy: "AllowFullyTransparent" } : { minconf: 1 };
    const sentAt = Date.now();
    const txid = await d.pool.zSendManyAndWait(from, [{ address: div[0]!, amount: 10_000_000n, memo }], opts);
    await d.syncMempools();
    const immediately = await d.wallet.zListReceivedByAddress(div[0]!, 0);
    let unconfirmed: ZReceived | undefined;
    try {
      unconfirmed = await waitFor(async () => (await d.wallet.zListReceivedByAddress(div[0]!, 0)).find((r) => r.txid === txid), { timeoutMs: 30_000, what: "the unconfirmed note" });
    } catch {
      unconfirmed = undefined;
    }
    const seenAfterMs = unconfirmed ? Date.now() - sentAt : null;
    const minconf1Before = await d.wallet.zListReceivedByAddress(div[0]!, 1);
    await d.mine(1);
    const confirmed = (await d.wallet.zListReceivedByAddress(div[0]!, 1)).find((r) => r.txid === txid);
    const viaBase = (await d.wallet.zListReceivedByAddress(base, 0)).find((r) => r.txid === txid);
    record(d.line, "Z-3", { base, diversified: div, validated, txid, immediately, unconfirmed: unconfirmed ?? null, seenAfterMs, minconf1Before, confirmed, viaBase: viaBase ?? null });
    expect(confirmed?.memo.startsWith(memo)).toBe(true);
    expect(confirmed?.amountZat ?? confirmed?.amount).toBeTruthy();
  });
});
