// The client-side glue the facilitator service, the examples and the CLI share: the exact method
// router, the file-backed channel storage, and the UtxoSource funder.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { channel, exact, FileClientChannelStorage, tx as T, utxoSourceFunder } from "../../../src/index.js";
import type { ClientChannelRecord } from "../../../src/batch/client/index.js";

const NET = "ycash:regtest" as const;
const req = (extra: Record<string, unknown>): PaymentRequirements => ({ scheme: "exact", network: NET, asset: "YEC", amount: "1000", payTo: "sm", maxTimeoutSeconds: 60, extra });

describe("ExactYcashMethodRouter", () => {
  const transparent = { scheme: "exact", createPaymentPayload: async (v: number) => ({ x402Version: v, payload: { transaction: "aa" } }) };
  const shielded = { createPaymentPayload: async (v: number) => ({ x402Version: v, payload: { txid: "bb" } }) };

  it("routes by assetTransferMethod: absent or transparent to the transparent client, sapling-proof to the payer", async () => {
    const r = new exact.ExactYcashMethodRouter({ transparent, shielded });
    expect(r.methods).toEqual(["transparent", "sapling-proof"]);
    expect((await r.createPaymentPayload(2, req({}))).payload).toEqual({ transaction: "aa" });
    expect((await r.createPaymentPayload(2, req({ assetTransferMethod: "transparent" }))).payload).toEqual({ transaction: "aa" });
    expect((await r.createPaymentPayload(2, req({ assetTransferMethod: "sapling-proof" }))).payload).toEqual({ txid: "bb" });
  });

  it("refuses a method it has no wallet for, and an empty configuration", async () => {
    await expect(new exact.ExactYcashMethodRouter({ transparent }).createPaymentPayload(2, req({ assetTransferMethod: "sapling-proof" }))).rejects.toThrow(/Sapling wallet/);
    await expect(new exact.ExactYcashMethodRouter({ shielded }).createPaymentPayload(2, req({}))).rejects.toThrow(/shielded methods only/);
    expect(() => new exact.ExactYcashMethodRouter({})).toThrow();
  });

  it("knows YED as a default asset and not YEC (YEC needs an allowedAssets entry)", () => {
    const r = new exact.ExactYcashMethodRouter({ transparent });
    expect(r.findDefaultAsset("YED", NET)).toMatchObject({ decimals: 2 });
    expect(r.findDefaultAsset("YEC", NET)).toBeUndefined();
  });
});

describe("FileClientChannelStorage", () => {
  const rec = (id: string, status: ClientChannelRecord["status"], offerKey = "k"): ClientChannelRecord => ({
    channelId: id, offerKey, network: NET, asset: "YEC", payTo: "sm", serverPubKey: "02", redeemScript: "", fundingTx: "", vout: 0,
    value: "10", closeFee: "1", deposit: "9", refundHeight: 100, closeMarginBlocks: 5, clientPrivKey: "11", clientScript: "", charged: "0", signed: "54", status,
  });

  it("persists records across instances and finds the live one per offer", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "x402-cs-")), "channels.json");
    const a = new FileClientChannelStorage(path);
    await a.put(rec("t1:0", "closed"));
    await a.put(rec("t2:0", "open"));
    await a.put(rec("t3:0", "opening", "other"));
    const b = new FileClientChannelStorage(path);
    expect((await b.get("t2:0"))?.status).toBe("open");
    expect((await b.findLive("k"))?.channelId).toBe("t2:0");
    expect((await b.findLive("other"))?.channelId).toBe("t3:0");
    expect(await b.get("nope")).toBeUndefined();
    expect((await b.list()).map((r) => r.channelId).sort()).toEqual(["t1:0", "t2:0", "t3:0"]);
    await b.put({ ...rec("t2:0", "closed"), closeTxid: "cc" });
    expect(await a.findLive("k")).toBeUndefined();
  });
});

describe("utxoSourceFunder", () => {
  const priv = T.hexToBytes("33".repeat(32));
  const script = T.p2pkhScript(T.hash160(T.pubkeyFromPriv(priv)));
  const coin = (n: number, value: bigint) => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value, scriptPubKey: script });
  const redeemScript = channel.buildChannelScript({ clientPubKey: T.pubkeyFromPriv(T.hexToBytes("44".repeat(32))), serverPubKey: T.pubkeyFromPriv(T.hexToBytes("55".repeat(32))), refundHeight: 500 });

  it("funds V from the key's largest coins, signs every input, and never reuses a coin it signed", async () => {
    const listed: string[] = [];
    const source = { listCoins: async (a: string) => (listed.push(a), [coin(1, 30_000n), coin(2, 80_000n), coin(3, 50_000n), { ...coin(4, 900_000n), scriptPubKey: T.p2pkhScript(new Uint8Array(20)) }]) };
    const f = utxoSourceFunder(priv, source);
    const first = T.parseTx(await f.fund({ network: NET, redeemScript, value: 100_000n, branchId: 0x19bd2d2f }));
    expect(listed[0]).toBe(T.encodeAddress(NET, "p2pkh", T.hash160(T.pubkeyFromPriv(priv))));
    expect(first.vin.map((i) => i.prevout.txid.slice(-1))).toEqual(["2", "3"]); // 80k + 50k, not the foreign 900k
    expect(first.vout[0]).toMatchObject({ value: 100_000n });
    expect(T.equalBytes(first.vout[0]!.scriptPubKey, channel.channelScriptPubKey(redeemScript))).toBe(true);
    expect(first.vin.every((i) => i.scriptSig.length > 100)).toBe(true);
    await expect(f.fund({ network: NET, redeemScript, value: 100_000n, branchId: 0x19bd2d2f })).rejects.toThrow(/cannot fund/); // only 30k left
  });
});
