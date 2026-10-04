// The light client as the agent's shielded wallet (src/shielded/light.ts), against a fake
// `x402-light serve`: `build` is the builder contract exactly, `status` gives the tip for
// nExpiryHeight, and the `sapling-proof` payer checks, then `send`s and presents the txid.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LightClient, LightClientError, LightClientShieldedPayer, memoToHex, SaplingExactClient } from "../../../src/shielded/index.js";
import { addressOf, buildPaymentTx, NETWORK, TEST_KEY } from "./saplingBuild.js";

const NOW = 1_800_000_000;
const TIP = 640;
const MEMO = "x402:" + "d4".repeat(32);
const payTo = addressOf(TEST_KEY);
const SENT_TXID = "ab".repeat(32);

const req = (method: "sapling" | "sapling-proof", extra: Record<string, unknown> = {}, over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  asset: "YEC",
  amount: "1500000",
  payTo: payTo.address,
  maxTimeoutSeconds: 900,
  extra: {
    assetTransferMethod: method,
    areFeesSponsored: false,
    memo: MEMO,
    expiresAt: NOW + 900,
    ...(method === "sapling-proof" ? { paymentFlow: "upfront" } : {}),
    ...extra,
  },
  ...over,
});

describe("LightClient and LightClientShieldedPayer against a fake x402-light", () => {
  let server: Server;
  let url: string;
  const calls: { method: string; params: unknown }[] = [];
  let network = "regtest";

  beforeAll(async () => {
    server = createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c: Buffer) => (body += c.toString()));
      rq.on("end", () => {
        const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
        calls.push({ method, params });
        const reply = (result: unknown) => rs.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        if (method === "status") return reply({ network, lwdHeight: TIP, height: TIP, synced: true, hasKey: true, address: "yregtestsapling1x", balance: { spendableZat: 1e8, pendingChangeZat: 0, pendingIncomingZat: 0, totalZat: 1e8 } });
        if (method === "build") {
          const b = buildPaymentTx({ notes: [{ key: TEST_KEY, index: payTo.index, value: 1_500_000n, memo: MEMO }], valueBalance: 10_000n, expiryHeight: Number(params.expiryHeight ?? TIP + 41) });
          return reply({ txHex: b.hex, txid: b.txid, feeZat: 10000, expiryHeight: params.expiryHeight, branchId: "19bd2d2f" });
        }
        if (method === "send") return reply({ txid: SENT_TXID, txHex: "00", feeZat: 10000, expiryHeight: TIP + 41 });
        rs.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    calls.length = 0;
    network = "regtest";
  });

  it("is the tip source and the builder of the sapling client: build {to, amountZat, memoHex, expiryHeight} with the spec's expiry", async () => {
    const light = new LightClient(url);
    expect(await light.getBlockCount()).toBe(TIP);
    const out = await new SaplingExactClient({ builder: light, chain: light, now: () => NOW }).createPaymentPayload(2, req("sapling"));
    expect(out.payload.transaction).toMatch(/^[0-9a-f]+$/);
    expect(calls.find((c) => c.method === "build")?.params).toEqual({ to: payTo.address, amountZat: "1500000", memoHex: memoToHex(MEMO), expiryHeight: TIP + 3 + 12 });
  });

  it("pays sapling-proof with send and presents the txid", async () => {
    const payer = new LightClientShieldedPayer({ light: new LightClient(url), now: () => NOW });
    expect(await payer.createPaymentPayload(2, req("sapling-proof"))).toEqual({ x402Version: 2, payload: { txid: SENT_TXID } });
    expect(calls.map((c) => c.method)).toEqual(["status", "send"]);
    expect(calls[1]!.params).toEqual({ to: payTo.address, amountZat: "1500000", memoHex: memoToHex(MEMO) });
  });

  it("refuses before any money moves: a wrong requirement asks nothing, a light client on another network is never asked to send", async () => {
    const payer = new LightClientShieldedPayer({ light: new LightClient(url), now: () => NOW });
    await expect(payer.createPaymentPayload(2, req("sapling"))).rejects.toThrow(/not a sapling-proof requirement/);
    await expect(payer.createPaymentPayload(2, req("sapling-proof", { paymentFlow: "authorization" }))).rejects.toThrow(/upfront/);
    await expect(payer.createPaymentPayload(2, req("sapling-proof", { expiresAt: NOW }))).rejects.toThrow(/expired/);
    await expect(payer.createPaymentPayload(2, req("sapling-proof", {}, { payTo: "sm1abc" }))).rejects.toThrow(/Sapling address/);
    expect(calls).toHaveLength(0);
    network = "testnet";
    await expect(payer.createPaymentPayload(2, req("sapling-proof"))).rejects.toThrow(/on testnet, not ycash:regtest/);
    expect(calls.map((c) => c.method)).toEqual(["status"]);
  });

  it("surfaces JSON-RPC errors with their code", async () => {
    const e = await new LightClient(url).call("nope").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LightClientError);
    expect((e as LightClientError).code).toBe(-32601);
  });
});
