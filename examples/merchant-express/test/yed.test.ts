// The YED routes (plan X3): configured by MERCHANT_YED_PAY_TO, served only when the facilitator lists
// YED, priced "$x" in cents, the exact route never below $1.00.
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { tx } from "x402-ycash-mechanism";
import { createMerchant, PAID_ROUTES } from "../src/app.js";
import { describeConfig, loadMerchantConfig } from "../src/config.js";
import { facilitatorListsYed, probeYed, YedGate } from "../src/yed.js";

const NETWORK = "ycash:regtest" as const;
const PAY_TO = tx.encodeAddress(NETWORK, "p2pkh", new Uint8Array(20).fill(7));
const YED_PAY_TO = tx.encodeAddress(NETWORK, "yed", new Uint8Array(20).fill(8));
const NODE = { MERCHANT_RPC_URL: "http://127.0.0.1:1", MERCHANT_RPC_USER: "u", MERCHANT_RPC_PASSWORD: "p" };
const BASE = { X402_NETWORK: NETWORK, MERCHANT_PAY_TO: PAY_TO, FACILITATOR_URL: "http://127.0.0.1:9" };

function facilitator(assets: string[], fail = false): FacilitatorClient {
  const supported: SupportedResponse = {
    kinds: [
      { x402Version: 2, scheme: "exact", network: NETWORK, extra: { assets, assetTransferMethods: ["transparent"] } },
      { x402Version: 2, scheme: "batch-settlement", network: NETWORK },
    ],
    extensions: [],
    signers: {},
  };
  return {
    getSupported: async () => {
      if (fail) throw new Error("connection refused");
      return supported;
    },
    verify: async () => ({ isValid: false, invalidReason: "unused" }),
    settle: async () => ({ success: false, transaction: "", network: NETWORK, errorReason: "unused" }),
  };
}

const quiet = (): void => undefined;

async function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("YED config", () => {
  it("is off without MERCHANT_YED_PAY_TO, and takes prices in dollars", () => {
    expect(loadMerchantConfig(BASE).yed).toBeUndefined();
    const c = loadMerchantConfig({ ...BASE, MERCHANT_YED_PAY_TO: YED_PAY_TO });
    expect(c.yed).toEqual({ payTo: YED_PAY_TO, priceReport: "$2.00", priceStream: "$0.01", maxDepositCents: 10_000n });
    expect(loadMerchantConfig({ ...BASE, MERCHANT_YED_PAY_TO: YED_PAY_TO, PRICE_YED_REPORT: "25", PRICE_YED_STREAM: "$0.5", MERCHANT_MAX_DEPOSIT_CENTS: "500" }).yed)
      .toMatchObject({ priceReport: "$25.00", priceStream: "$0.50", maxDepositCents: 500n });
    expect(describeConfig(c).yed).toMatchObject({ payTo: YED_PAY_TO, report: "$2.00", maxDepositCents: "10000" });
  });

  it("refuses a YEC payTo, an exact price below $1.00 (it would burn), fractions of a cent and a bad deposit cap", () => {
    expect(() => loadMerchantConfig({ ...BASE, MERCHANT_YED_PAY_TO: PAY_TO })).toThrow(/Yellowback/);
    expect(() => loadMerchantConfig({ ...BASE, MERCHANT_YED_PAY_TO: YED_PAY_TO, PRICE_YED_REPORT: "$0.99" })).toThrow(/at least \$1\.00/);
    expect(() => loadMerchantConfig({ ...BASE, MERCHANT_YED_PAY_TO: YED_PAY_TO, PRICE_YED_STREAM: "$0.001" })).toThrow(/whole cents/);
    expect(() => loadMerchantConfig({ ...BASE, MERCHANT_YED_PAY_TO: YED_PAY_TO, MERCHANT_MAX_DEPOSIT_CENTS: "99" })).toThrow(/100\.\.10000000/);
  });
});

describe("probeYed", () => {
  const yed = loadMerchantConfig({ ...BASE, MERCHANT_YED_PAY_TO: YED_PAY_TO }).yed!;
  const node = (yellowback: boolean) => ({ capabilities: async () => ({ yellowback }) });

  it("turns YED on only when the facilitator lists it; the channel also needs a Yellowback node", async () => {
    expect(await facilitatorListsYed(facilitator(["YEC", "YED"]), NETWORK)).toBe(true);
    expect(await facilitatorListsYed(facilitator(["YEC", "YED"]), "ycash:testnet")).toBe(false);
    expect(await probeYed(yed, facilitator(["YEC", "YED"]), NETWORK, node(true), quiet)).toEqual({ exact: true, channel: true, maxDepositCents: 10_000n });
    expect(await probeYed(yed, facilitator(["YEC", "YED"]), NETWORK, node(false), quiet)).toMatchObject({ exact: true, channel: false });
    expect(await probeYed(yed, facilitator(["YEC", "YED"]), NETWORK, undefined, quiet)).toMatchObject({ exact: true, channel: false });
  });

  it("stays off, with a reason, when the facilitator does not list YED or cannot be reached", async () => {
    const logs: unknown[] = [];
    expect(await probeYed(yed, facilitator(["YEC"]), NETWORK, node(true), (m, f) => logs.push({ m, ...f }))).toMatchObject({ exact: false, channel: false });
    expect(await probeYed(yed, facilitator(["YEC"], true), NETWORK, node(true), (m, f) => logs.push({ m, ...f }))).toMatchObject({ exact: false, channel: false });
    expect(JSON.stringify(logs)).toMatch(/does not list YED.*connection refused/);
  });
});

describe("the YED routes with the production schemes", () => {
  it("sells /yed/report (exact, $2 = 200 cents) and /yed/stream (a YED channel, 1 cent, maxDeposit from config)", async () => {
    const config = loadMerchantConfig({ ...BASE, ...NODE, MERCHANT_YED_PAY_TO: YED_PAY_TO, MERCHANT_CHANNEL_KEY: "5a".repeat(32), MERCHANT_MAX_DEPOSIT_CENTS: "500", MERCHANT_CHANNEL_STORE: join(mkdtempSync(join(tmpdir(), "yed-")), "c.json") });
    const fac = facilitator(["YEC", "YED"]);
    const merchant = createMerchant(config, { facilitator: fac, yed: { exact: true, channel: true, maxDepositCents: 500n } });
    expect(merchant.modes).toMatchObject({ yedExact: true, yedChannel: true });
    const shop = await listen(merchant.app);
    try {
      const report = await fetch(`${shop.url}/yed/report`);
      expect(report.status).toBe(402);
      expect(decodePaymentRequiredHeader(report.headers.get("PAYMENT-REQUIRED") as string).accepts).toEqual([
        expect.objectContaining({ scheme: "exact", asset: "YED", amount: "200", payTo: YED_PAY_TO, extra: expect.objectContaining({ assetTransferMethod: "transparent" }) }),
      ]);
      const stream = await fetch(`${shop.url}/yed/stream`);
      expect(stream.status).toBe(402);
      expect(decodePaymentRequiredHeader(stream.headers.get("PAYMENT-REQUIRED") as string).accepts).toEqual([
        expect.objectContaining({ scheme: "batch-settlement", asset: "YED", amount: "1", payTo: YED_PAY_TO, extra: expect.objectContaining({ maxDeposit: "500", confirmationPolicy: { confirmations: 1 } }) }),
      ]);
      // the YEC channel route keeps its zatoshi terms
      const yec = decodePaymentRequiredHeader((await fetch(`${shop.url}/channel/search`)).headers.get("PAYMENT-REQUIRED") as string).accepts[0];
      expect(yec).toMatchObject({ asset: "YEC", amount: "1000", extra: { maxDeposit: "100000000" } });
      expect(await (await fetch(shop.url)).json()).toMatchObject({ routes: { [PAID_ROUTES.yedReport]: "paid", [PAID_ROUTES.yedStream]: "paid" } });
    } finally {
      await merchant.close();
      await new Promise<void>((r) => shop.server.close(() => r()));
    }
  });

  it("answers 501 on both YED routes when the probe found no YED, and keeps the YED channel off at confirmations −1", async () => {
    const config = loadMerchantConfig({ ...BASE, ...NODE, MERCHANT_YED_PAY_TO: YED_PAY_TO, MERCHANT_CHANNEL_KEY: "5a".repeat(32), MERCHANT_CHANNEL_CONFIRMATIONS: "-1", MERCHANT_CHANNEL_STORE: join(mkdtempSync(join(tmpdir(), "yed-")), "c.json") });
    const off = createMerchant(config, { facilitator: facilitator(["YEC"]) });
    expect(off.modes).toMatchObject({ yedExact: false, yedChannel: false });
    const mempool = createMerchant(config, { facilitator: facilitator(["YEC", "YED"]), yed: { exact: true, channel: true, maxDepositCents: 500n } });
    expect(mempool.modes).toMatchObject({ yedExact: true, yedChannel: false, channel: true });
    const shop = await listen(off.app);
    try {
      for (const path of ["/yed/report", "/yed/stream"]) expect((await fetch(`${shop.url}${path}`)).status, path).toBe(501);
    } finally {
      await Promise.all([off.close(), mempool.close()]);
      await new Promise<void>((r) => shop.server.close(() => r()));
    }
  });
});

describe("re-probing the facilitator's /supported", () => {
  /** A facilitator that starts without YED and lists it once `on` is set. */
  const switching = () => {
    const state = { on: false, calls: 0 };
    const fac: FacilitatorClient = {
      getSupported: async () => (state.calls++, (await facilitator(state.on ? ["YEC", "YED"] : ["YEC"]).getSupported())),
      verify: async () => ({ isValid: false, invalidReason: "unused" }),
      settle: async () => ({ success: false, transaction: "", network: NETWORK, errorReason: "unused" }),
    };
    return { state, fac };
  };
  const config = () => loadMerchantConfig({ ...BASE, ...NODE, MERCHANT_YED_PAY_TO: YED_PAY_TO, MERCHANT_CHANNEL_KEY: "5a".repeat(32), MERCHANT_CHANNEL_STORE: join(mkdtempSync(join(tmpdir(), "yed-")), "c.json") });
  const node = { capabilities: async () => ({ yellowback: true }) };

  it("YedGate probes on demand at most every minGapMs, one probe at a time, and on its interval", async () => {
    let n = 0;
    const gate = new YedGate({ exact: false, channel: false, maxDepositCents: 1n }, async () => ({ exact: ++n > 1, channel: false, maxDepositCents: 1n }), { minGapMs: 60_000, intervalMs: 10 });
    await Promise.all([gate.refresh(), gate.refresh()]);
    expect(n).toBe(1);
    await gate.refresh(); // within minGapMs: the last view
    expect(n).toBe(1);
    gate.start();
    await new Promise((r) => setTimeout(r, 50));
    gate.stop();
    expect(n).toBeGreaterThan(1);
    expect(gate.modes.exact).toBe(true);
  });

  it("a YED route of a merchant started before the facilitator re-probes and comes on; while off it answers 501", async () => {
    const c = config();
    const { state, fac } = switching();
    const yedProbe = (f: FacilitatorClient) => probeYed(c.yed!, f, NETWORK, node, quiet);
    const merchant = createMerchant(c, { facilitator: fac, yed: await yedProbe(fac), yedProbe });
    expect(merchant.modes).toMatchObject({ yedExact: false, yedChannel: false, exact: true });
    const shop = await listen(merchant.app);
    try {
      expect((await fetch(`${shop.url}/yed/report`)).status).toBe(501); // the start-up view is under 5 s old
      state.on = true;
      await new Promise((r) => setTimeout(r, 5_100));
      expect((await fetch(`${shop.url}/yed/report`)).status).toBe(402); // a request to an off route re-probes
      expect(merchant.modes).toMatchObject({ yedExact: true, yedChannel: true });
      expect((await fetch(`${shop.url}/yed/stream`)).status).toBe(402);
      expect(await (await fetch(shop.url)).json()).toMatchObject({ routes: { [PAID_ROUTES.yedReport]: "paid" } });
    } finally {
      await merchant.close();
      await new Promise<void>((r) => shop.server.close(() => r()));
    }
  }, 15_000);

  it("the periodic re-probe turns YED on without a request, and off again when the facilitator drops it", async () => {
    const c = config();
    const { state, fac } = switching();
    const merchant = createMerchant(c, { facilitator: fac, yedProbe: (f) => probeYed(c.yed!, f, NETWORK, node, quiet), yedReprobeMs: 20 });
    try {
      expect(merchant.modes.yedExact).toBe(false);
      state.on = true;
      await new Promise((r) => setTimeout(r, 100));
      expect(merchant.modes).toMatchObject({ yedExact: true, yedChannel: true });
      state.on = false;
      await new Promise((r) => setTimeout(r, 100));
      expect(merchant.modes.yedExact).toBe(false);
    } finally {
      await merchant.close();
    }
  });
});
