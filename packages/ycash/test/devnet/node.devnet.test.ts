// Every YcashRpc wrapper against a live devnet (either line).
import { beforeAll, expect, it } from "vitest";
import { RpcError, SendRawTransactionError, yecToZat, type ZRecipient } from "../../src/node/index.js";
import { describeDevnet, devnet, record, waitFor, type Devnet } from "./harness.js";

describeDevnet("YcashRpc on a live devnet", () => {
  let d: Devnet;
  beforeAll(async () => {
    d = await devnet();
  });

  it("detects the line and the Yellowback RPCs per node", async () => {
    const wallet = await d.wallet.capabilities();
    const stock = await d.stock.capabilities();
    record(d.line, "capabilities", { wallet, stock });
    expect(wallet.line).toMatch(/^v[46]$/);
    expect(stock.line).toBe(wallet.line);
    expect(wallet.yellowback).toBe(true);
    expect(stock.yellowback).toBe(false);
    expect(wallet.chain).toBe("regtest");
  });

  it("reads the chain", async () => {
    const info = await d.wallet.getBlockchainInfo();
    expect(info.chain).toBe("regtest");
    expect(info.consensus.nextblock).toMatch(/^[0-9a-f]{8}$/);
    expect(await d.wallet.getBlockCount()).toBe(info.blocks);
    expect(Array.isArray(await d.wallet.getRawMempool())).toBe(true);
  });

  it("builds, signs, verifies, decodes and relays a raw transaction; gettxout follows it", async () => {
    const u = await d.utxo(d.wallet, 100_000_000n);
    const tip = await d.tip();
    const to = await d.stock.getNewAddress();
    const unsigned = await d.wallet.createRawTransaction([{ txid: u.txid, vout: u.vout }], { [to]: 99_990_000n }, 0, tip + 20);
    const decoded = await d.wallet.decodeRawTransaction(unsigned);
    expect(decoded).toMatchObject({ overwintered: true, version: 4, versiongroupid: "892f2085", locktime: 0, expiryheight: tip + 20 });
    expect(decoded.vout[0]?.valueZat).toBe(99_990_000);

    const signed = await d.wallet.signRawTransactionWithWallet(unsigned);
    expect(signed.complete).toBe(true);
    expect(await d.stock.verifyScripts(signed.hex)).toEqual({ complete: true, errors: [] });

    const out = await d.wallet.getTxOut(u.txid, u.vout, false);
    expect(out?.confirmations).toBe(1);
    expect(yecToZat(out!.value)).toBe(u.zat);

    const txid = await d.wallet.sendRawTransaction(signed.hex);
    expect(txid).toBe((await d.wallet.decodeRawTransaction(signed.hex)).txid);
    expect(await d.wallet.getTxOut(u.txid, u.vout, true)).toBeNull();
    await d.mine(1);
    expect((await d.stock.getTxOut(txid, 0, false))?.confirmations).toBe(1);
  });

  it("lists unspent outputs and sends to an address", async () => {
    const unspent = await d.wallet.listUnspent(1);
    expect(unspent.length).toBeGreaterThan(0);
    expect(unspent[0]).toHaveProperty("amountZat");
    const addr = await d.pool.getNewAddress();
    const txid = await d.wallet.sendToAddress(addr, 12_345_678n);
    expect((await d.findVout(txid, addr)).zat).toBe(12_345_678n);
    await d.mine(1);
  });

  it("raises SendRawTransactionError for a garbage transaction", async () => {
    const e = await d.wallet.sendRawTransaction("00").catch((x: unknown) => x);
    record(d.line, "sendrawtransaction-garbage", { code: (e as RpcError).code, message: (e as RpcError).message });
    expect(e).toBeInstanceOf(SendRawTransactionError);
  });

  it("answers the Yellowback RPCs on node 0, and -32601 on the stock node", async () => {
    const info = await d.wallet.yedGetInfo();
    expect(info).toHaveProperty("enabled");
    const price = await d.wallet.yedGetPrice();
    expect(price.height).toBe(await d.tip());
    record(d.line, "yed_getprice", { pMint: price.pMint, armed: price.armed, attestStatus: price.attestStatus });

    const u = await d.utxo(d.wallet, 50_000_000n);
    const to = await d.wallet.getNewAddress();
    const hex = (await d.wallet.signRawTransactionWithWallet(await d.wallet.createRawTransaction([{ txid: u.txid, vout: u.vout }], { [to]: 49_990_000n }))).hex;
    const v = await d.wallet.yedValidateRawTransaction(hex);
    record(d.line, "yed_validaterawtransaction(plain YEC tx)", v);
    expect(Object.keys(v).sort()).toEqual(
      ["valid", "verdict", "type", "path", "yedIn", "yedOut", "burned", "feeZat", "payee", "blockValid", "wouldBeRejected", "mempoolExpiryOk", "unconfirmedInputs"].sort(),
    );
    expect(v).toMatchObject({ valid: true, yedIn: 0, burned: 0, type: "none", unconfirmedInputs: [] });
    const p = await d.wallet.yedDecodePayload(hex);
    expect(p).toMatchObject({ valid: false, type: "none" });

    await expect(d.stock.yedGetInfo()).rejects.toMatchObject({ code: -32601 });
  });

  it("makes a diversified address and sees a payment to it with its memo", async () => {
    const base = await d.wallet.zGetNewAddress();
    const zaddr = await d.wallet.zGetNewDiversifiedAddress(base);
    expect(zaddr).toMatch(/^yregtestsapling1/);
    expect(zaddr).not.toBe(base);
    // The pool's wallet pays from a transparent coin of its own (not locked: z_sendmany honours locks).
    const u = { address: await d.pool.getNewAddress() };
    await d.fund(u.address, 30_000_000n);
    await d.mine(1);
    const memo = Buffer.from("x402 node suite", "utf8").toString("hex");
    const recipients: ZRecipient[] = [{ address: zaddr, amount: 10_000_000n, memo }];
    const opts = d.line === "v6" ? { minconf: 1, privacyPolicy: "AllowFullyTransparent" } : { minconf: 1 };
    const txid = await d.pool.zSendManyAndWait(u.address, recipients, opts);
    await d.syncMempools();
    // The wallet learns of a mempool tx asynchronously on both lines: poll.
    const note = await waitFor(async () => (await d.wallet.zListReceivedByAddress(zaddr, 0)).find((r) => r.txid === txid), { what: "the incoming note" });
    expect(note.memo.startsWith(memo)).toBe(true);
    expect(note.amountZat).toBe(10_000_000);
    await d.mine(1);
  });

  it("generates blocks", async () => {
    const before = await d.tip();
    const hashes = await d.mine(2);
    expect(hashes).toHaveLength(2);
    expect(await d.tip()).toBe(before + 2);
  });
});
