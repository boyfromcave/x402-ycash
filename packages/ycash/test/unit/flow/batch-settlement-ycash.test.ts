// A YEC channel session through @x402/core, in process: the client opens with its first request,
// pays a run of requests with vouchers the resource server verifies itself, and the server closes
// with one transaction paying the cumulative charge. The upstream package runs this file as its
// integration test (tools/upstream/stage.sh moves it to test/integrations/).
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentRequired, SupportedResponse } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { BatchYcashFacilitatorScheme, tx as T } from "../../../src/index.js";
import { NET, payToAddr, returnAddr, setup } from "../batch/setup.js";

describe("batch-settlement on Ycash through x402Client / x402ResourceServer / x402Facilitator", () => {
  it("opens, pays ten requests off chain, and closes with one transaction for the charged total", async () => {
    const s = await setup({ confirmations: -1 });
    const fac = new x402Facilitator().register(NET, new BatchYcashFacilitatorScheme({ rpc: s.chain }));
    const server = new x402ResourceServer({
      verify: (p, r) => fac.verify(p, r),
      settle: (p, r) => fac.settle(p, r),
      // core types the facilitator's kinds with network: string; the server wants `${string}:${string}`
      getSupported: async () => fac.getSupported() as SupportedResponse,
    }).register(NET, s.server);
    await server.initialize();
    const [req] = await server.buildPaymentRequirements({ scheme: "batch-settlement", network: NET, payTo: payToAddr, price: "0.00002", maxTimeoutSeconds: 300 });
    expect(req!.amount).toBe("2000");
    const agent = new x402Client().register(NET, s.client);
    const required: PaymentRequired = { x402Version: 2, resource: { url: "https://api.example/search" }, accepts: [req!] };

    let channelId = "";
    for (let i = 1; i <= 10; i++) {
      const payload = await agent.createPaymentPayload(required);
      expect(payload.payload).toMatchObject({ type: i === 1 ? "open" : "voucher" });
      const verified = await server.verifyPayment(payload, req!);
      expect(verified).toMatchObject({ isValid: true });
      channelId = verified.payer!;
      const settled = await server.settlePayment(payload, req!);
      expect(settled.extra).toMatchObject({ chargedAmount: "2000" });
      await agent.handlePaymentResponse({ paymentPayload: payload, requirements: req!, settleResponse: settled });
    }
    // one funding on chain so far; ten requests charged 20,000 zatoshis
    expect(s.chain.sent).toHaveLength(1);

    const closeTxid = await s.server.manager.close(channelId);
    expect(closeTxid).toHaveLength(64);
    expect(s.chain.sent).toHaveLength(2);
    const close = T.parseTx(s.chain.sent.at(-1)!);
    const paid = (addr: string) => close.vout.filter((o) => T.equalBytes(o.scriptPubKey, T.addressToScript(addr, NET))).reduce((a, o) => a + o.value, 0n);
    expect(paid(payToAddr)).toBe(20_000n);
    expect(paid(returnAddr)).toBe(100_000n - 20_000n); // the client's remainder returns to its wallet
  });
});
