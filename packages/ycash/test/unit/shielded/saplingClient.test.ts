// The `sapling` client and its builder contract (src/shielded/builder.ts): the JSON-RPC and command
// builders speak `build {to, amountZat, memoHex, expiryHeight?} → {txHex, txid}`, the client checks the
// requirement before asking and the answer after, and the exact client router refuses `sapling`
// cleanly when no builder is configured.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExactYcashMethodRouter } from "../../../src/exact/index.js";
import {
  CommandSaplingBuilder,
  FakeSaplingBuilder,
  JsonRpcSaplingBuilder,
  memoToHex,
  parseBuildResult,
  SaplingExactClient,
  saplingBuilderFrom,
  type SaplingBuildRequest,
} from "../../../src/shielded/index.js";
import { addressOf, buildPaymentTx, NETWORK, TEST_KEY } from "./saplingBuild.js";

const NOW = 1_800_000_000;
const TIP = 500;
const MEMO = "x402:" + "c3".repeat(32);
const payTo = addressOf(TEST_KEY);
const req = (extra: Record<string, unknown> = {}, over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  asset: "YEC",
  amount: "1500000",
  payTo: payTo.address,
  maxTimeoutSeconds: 900,
  extra: { assetTransferMethod: "sapling", areFeesSponsored: false, memo: MEMO, expiresAt: NOW + 900, ...extra },
  ...over,
});
const built = (expiryHeight = TIP + 3 + 12) => buildPaymentTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: 1_500_000n, memo: MEMO }], valueBalance: 1000n, expiryHeight });

describe("SaplingExactClient", () => {
  const chain = { getBlockCount: async () => TIP };

  it("asks the builder for payTo, the amount, the memo hex and the spec's expiry, and returns the hex unbroadcast", async () => {
    const b = built();
    const builder = new FakeSaplingBuilder(() => ({ txHex: b.hex, txid: b.txid }));
    const client = new SaplingExactClient({ builder, chain, now: () => NOW });
    const out = await client.createPaymentPayload(2, req());
    expect(out).toEqual({ x402Version: 2, payload: { transaction: b.hex } });
    expect(builder.requests).toEqual([{ to: payTo.address, amountZat: "1500000", memoHex: memoToHex(MEMO), expiryHeight: TIP + 3 + 12 }]);
  });

  it("leaves the expiry to the builder when it has no chain view", async () => {
    const b = built(777);
    const builder = new FakeSaplingBuilder(() => ({ txHex: b.hex, txid: b.txid }));
    await new SaplingExactClient({ builder, now: () => NOW }).createPaymentPayload(2, req());
    expect(builder.requests[0]).not.toHaveProperty("expiryHeight");
  });

  it("refuses a requirement it cannot pay before asking the builder", async () => {
    const builder = new FakeSaplingBuilder(() => Promise.reject(new Error("must not be called")));
    const client = new SaplingExactClient({ builder, chain, now: () => NOW });
    await expect(client.createPaymentPayload(2, req({ assetTransferMethod: "sapling-proof" }))).rejects.toThrow(/not a sapling requirement/);
    await expect(client.createPaymentPayload(2, req({ paymentFlow: "upfront" }))).rejects.toThrow(/authorization/);
    await expect(client.createPaymentPayload(2, req({ memo: "hello" }))).rejects.toThrow(/memo/);
    await expect(client.createPaymentPayload(2, req({ expiresAt: NOW }))).rejects.toThrow(/expired/);
    await expect(client.createPaymentPayload(2, req({}, { payTo: "sm1abc" }))).rejects.toThrow(/Sapling address/);
    await expect(client.createPaymentPayload(2, req({}, { asset: "YED" }))).rejects.toThrow(/YEC/);
    expect(builder.requests).toHaveLength(0);
  });

  it("refuses an answer of the wrong shape: undecodable, a txid that is not the transaction's, the wrong expiry", async () => {
    const b = built();
    const client = (txHex: string, txid: string) => new SaplingExactClient({ builder: new FakeSaplingBuilder(() => ({ txHex, txid })), chain, now: () => NOW });
    await expect(client("00", b.txid).createPaymentPayload(2, req())).rejects.toThrow(/does not decode/);
    await expect(client(b.hex, "11".repeat(32)).createPaymentPayload(2, req())).rejects.toThrow(/not the transaction's/);
    const late = built(TIP + 40);
    await expect(client(late.hex, late.txid).createPaymentPayload(2, req())).rejects.toThrow(/nExpiryHeight/);
  });
});

describe("the builder contract", () => {
  let server: Server;
  let url: string;
  const seen: unknown[] = [];
  beforeAll(async () => {
    server = createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c: Buffer) => (body += c.toString()));
      rq.on("end", () => {
        const call = JSON.parse(body) as { id: number; method: string; params: SaplingBuildRequest };
        seen.push(call);
        rs.setHeader("content-type", "application/json");
        if (call.params.to === "fail") rs.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -1, message: "no notes" } }));
        else rs.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { txHex: "aabb", txid: "cd".repeat(32) } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("JSON-RPC: method build with the request as params; an error is reported with its message", async () => {
    const b = new JsonRpcSaplingBuilder(url);
    const r: SaplingBuildRequest = { to: "ys1x", amountZat: "5", memoHex: "00", expiryHeight: 9 };
    expect(await b.build(r)).toEqual({ txHex: "aabb", txid: "cd".repeat(32) });
    expect(seen[0]).toMatchObject({ jsonrpc: "2.0", method: "build", params: r });
    await expect(b.build({ ...r, to: "fail" })).rejects.toThrow(/build failed \(-1\): no notes/);
  });

  it("command: the request on stdin, the last stdout line is the answer; a failure carries stderr", async () => {
    const echo = new CommandSaplingBuilder(`node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("log line");console.log(JSON.stringify({txHex:r.memoHex,txid:"ef".repeat(32)}))})'`);
    expect(await echo.build({ to: "ys1x", amountZat: "1", memoHex: "abcd" })).toEqual({ txHex: "abcd", txid: "ef".repeat(32) });
    await expect(new CommandSaplingBuilder("echo nope >&2; exit 3").build({ to: "", amountZat: "1", memoHex: "" })).rejects.toThrow(/exited 3: nope/);
    await expect(new CommandSaplingBuilder("echo not-json").build({ to: "", amountZat: "1", memoHex: "" })).rejects.toThrow(/not JSON/);
  });

  it("validates the answer and picks the builder from the configuration string", () => {
    expect(() => parseBuildResult({ txHex: "AB", txid: "00".repeat(32) }, "x")).toThrow(/txHex/);
    expect(() => parseBuildResult({ txHex: "ab", txid: "00" }, "x")).toThrow(/txid/);
    expect(saplingBuilderFrom("http://127.0.0.1:9/")).toBeInstanceOf(JsonRpcSaplingBuilder);
    expect(saplingBuilderFrom("x402-light build --stdin")).toBeInstanceOf(CommandSaplingBuilder);
  });
});

describe("ExactYcashMethodRouter and sapling", () => {
  const transparent = { scheme: "exact", createPaymentPayload: async () => ({ x402Version: 2, payload: { transaction: "t" } }) };
  it("refuses sapling cleanly without a builder, and routes it to the sapling payer with one", async () => {
    await expect(new ExactYcashMethodRouter({ transparent }).createPaymentPayload(2, req())).rejects.toThrow(/no Sapling transaction builder is configured/);
    const sapling = { createPaymentPayload: async () => ({ x402Version: 2, payload: { transaction: "s" } }) };
    const router = new ExactYcashMethodRouter({ transparent, sapling });
    expect(router.methods).toEqual(["transparent", "sapling"]);
    expect((await router.createPaymentPayload(2, req())).payload).toEqual({ transaction: "s" });
  });
});
