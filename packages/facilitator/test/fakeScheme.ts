// A fake facilitator mechanism, tests only: it proves the HTTP contract without any chain. The
// payload's `mode` picks the outcome, so one registered scheme exercises every response path.
import type { Network, PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse, VerifyResponse } from "@x402/core/types";

export const FAKE_SCHEME = "fake";
export const FAKE_PAYER = "smFakePayer";
export const FAKE_TXID = "ab".repeat(32);
export const SECRET = "rpc password hunter2 at 10.0.0.7";

export type FakeMode = "ok" | "invalid" | "throw" | "pending" | "fail" | "slow";

export class FakeFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = FAKE_SCHEME;
  readonly caipFamily = "ycash:*";
  readonly settled: string[] = [];
  /** Resolves a `slow` settle; tests hold it to observe shutdown with a request in flight. */
  release: () => void = () => {};
  private slowGate: Promise<void> = Promise.resolve();

  constructor(private readonly extra?: Record<string, unknown>) {}

  holdSlowSettles(): void {
    this.slowGate = new Promise(r => {
      this.release = r;
    });
  }

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return this.extra;
  }

  getSigners(_network: string): string[] {
    return [];
  }

  private mode(p: PaymentPayload): FakeMode {
    return (p.payload.mode as FakeMode | undefined) ?? "ok";
  }

  async verify(payload: PaymentPayload, _req: PaymentRequirements): Promise<VerifyResponse> {
    switch (this.mode(payload)) {
      case "throw":
        throw new Error(`node exploded: ${SECRET}`);
      case "invalid":
        return { isValid: false, invalidReason: "invalid_exact_ycash_amount", payer: FAKE_PAYER };
      default:
        return { isValid: true, payer: FAKE_PAYER, extensionResponses: { fakeext: { status: "seen" } } };
    }
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const network = req.network;
    switch (this.mode(payload)) {
      case "throw":
        throw new Error(`broadcast exploded: ${SECRET}`);
      case "fail":
        return { success: false, errorReason: "duplicate_settlement", transaction: "", network };
      case "pending":
        return { success: false, errorReason: "settlement_pending", transaction: FAKE_TXID, network, payer: FAKE_PAYER };
      case "slow":
        await this.slowGate;
        break;
      default:
        break;
    }
    this.settled.push(FAKE_TXID);
    return { success: true, transaction: FAKE_TXID, network, payer: FAKE_PAYER, extensionResponses: { fakeext: { status: "settled" } } };
  }
}

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: FAKE_SCHEME,
    network: "ycash:regtest",
    asset: "YEC",
    amount: "250000",
    payTo: "smMerchant",
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

export function paymentPayload(mode: FakeMode = "ok", req: PaymentRequirements = requirements()): PaymentPayload {
  return { x402Version: 2, accepted: req, payload: { mode } };
}

export function body(mode: FakeMode = "ok", req: PaymentRequirements = requirements()): Record<string, unknown> {
  return { x402Version: 2, paymentPayload: paymentPayload(mode, req), paymentRequirements: req };
}
