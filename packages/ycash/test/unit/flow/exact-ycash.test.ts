// The whole `exact` flow through @x402/core: x402Client → x402ResourceServer → x402Facilitator,
// in process, against the in-memory node. The upstream package runs this file as its integration
// test (tools/upstream/stage.sh moves it to test/integrations/).
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { beforeEach, describe, expect, it } from "vitest";
import { exact } from "../../../src/index.js";
import { parseTx, txid } from "../../../src/tx/index.js";
import { FakeNode, FakeUtxoSource, NETWORK, testKey } from "../exact/fakeNode.js";

const payer = testKey(1);
const merchant = testKey(2);
const resource = { url: "https://api.example/ticker", description: "a paid route", mimeType: "application/json" };

/** The facilitator in process, behind the client interface the resource server talks to. */
function localFacilitator(facilitator: x402Facilitator): FacilitatorClient {
  return {
    verify: (p: PaymentPayload, r: PaymentRequirements) => facilitator.verify(p, r),
    settle: (p: PaymentPayload, r: PaymentRequirements) => facilitator.settle(p, r),
    // core types the facilitator's kinds with network: string; the server wants `${string}:${string}`
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
}

let node: FakeNode;
let server: x402ResourceServer;

beforeEach(async () => {
  node = new FakeNode();
  const facilitator = new x402Facilitator().register(NETWORK, new exact.ExactYcashFacilitatorScheme(node, { confirmationTimeoutMs: 60, confirmationPollMs: 10 }));
  // a 0.0025 YEC route; up to 0.01 YEC settles at the mempool (policy −1)
  server = new x402ResourceServer(localFacilitator(facilitator)).register(NETWORK, new exact.ExactYcashServerScheme({ zeroConfCapZat: 1_000_000n }));
  await server.initialize();
});

async function requirementsFor(amount: string): Promise<PaymentRequirements[]> {
  return server.buildPaymentRequirements({ scheme: "exact", network: NETWORK, payTo: merchant.address, price: { amount, asset: "YEC" }, maxTimeoutSeconds: 300 });
}

describe("exact on Ycash through x402Client / x402ResourceServer / x402Facilitator", () => {
  it("verifies and settles a YEC payment end to end, at the mempool", async () => {
    node.addCoin(10_000_000n, payer.script);
    const accepts = await requirementsFor("250000");
    expect(accepts[0]!.extra).toMatchObject({ assetTransferMethod: "transparent", areFeesSponsored: false, confirmationPolicy: { confirmations: -1 } });
    const client = x402Client.fromConfig({
      schemes: [{ network: NETWORK, client: new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node))) }],
      spendControls: { allowedAssets: [exact.yecSpendControl(NETWORK, 1_000_000n)] },
    });

    const payload = await client.createPaymentPayload(await server.createPaymentRequiredResponse(accepts, resource));
    const hex = (payload.payload as { transaction: string }).transaction;
    expect(parseTx(hex).vout[0]!.value).toBe(250_000n);

    const accepted = server.findMatchingRequirements(accepts, payload)!;
    expect(await server.verifyPayment(payload, accepted)).toEqual({ isValid: true, payer: payer.address });
    expect(node.calls).not.toContain("sendrawtransaction");

    const settled = await server.settlePayment(payload, accepted);
    expect(settled).toMatchObject({ success: true, transaction: txid(hex), network: NETWORK, payer: payer.address, extra: { status: "mempool", confirmations: -1 } });
  });

  it("broadcasts a payment once: a second verify is a duplicate, a second settle only observes", async () => {
    node.addCoin(10_000_000n, payer.script);
    const accepts = await requirementsFor("250000");
    const client = x402Client.fromConfig({
      schemes: [{ network: NETWORK, client: new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node))) }],
      spendControls: { allowedAssets: [exact.yecSpendControl(NETWORK, 1_000_000n)] },
    });
    const payload = await client.createPaymentPayload(await server.createPaymentRequiredResponse(accepts, resource));
    const accepted = server.findMatchingRequirements(accepts, payload)!;
    expect((await server.settlePayment(payload, accepted)).success).toBe(true);
    expect(await server.verifyPayment(payload, accepted)).toMatchObject({ isValid: false, invalidReason: "duplicate_settlement" });
    expect((await server.settlePayment(payload, accepted)).success).toBe(true);
    expect(node.calls.filter((c) => c === "sendrawtransaction")).toHaveLength(1);
  });

  it("refuses YEC under default spend controls: YEC is not USD-pegged", async () => {
    node.addCoin(10_000_000n, payer.script);
    const accepts = await requirementsFor("250000");
    const guarded = x402Client.fromConfig({ schemes: [{ network: NETWORK, client: new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node))) }] });
    await expect(guarded.createPaymentPayload(await server.createPaymentRequiredResponse(accepts, resource))).rejects.toThrow();
  });

  it("refuses a payment the client's spend control caps", async () => {
    node.addCoin(10_000_000n, payer.script);
    const accepts = await requirementsFor("2000000");
    const client = x402Client.fromConfig({
      schemes: [{ network: NETWORK, client: new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node))) }],
      spendControls: { allowedAssets: [exact.yecSpendControl(NETWORK, 1_000_000n)] },
    });
    await expect(client.createPaymentPayload(await server.createPaymentRequiredResponse(accepts, resource))).rejects.toThrow();
  });
});
