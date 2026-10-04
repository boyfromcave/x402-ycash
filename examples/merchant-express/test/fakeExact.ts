// A fake `exact` scheme on all three sides (client, server, facilitator), tests only. It stands in
// for the Ycash exact mechanism so the full HTTP chain runs: agent → merchant → facilitator.
import type {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentPayloadResult,
  PaymentRequirements,
  Price,
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SchemeNetworkServer,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
} from "@x402/core/types";

export const FAKE_TX = "0400008085202f89deadbeef";
export const FAKE_TXID = "cd".repeat(32);

export class FakeExactServer implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "transparent";
  readonly paymentFlows = { transparent: { supported: ["authorization"], default: "authorization" } } as const;

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) return { amount: price.amount, asset: price.asset, extra: price.extra ?? {} };
    throw new Error("the fake takes AssetAmount prices only");
  }

  async enhancePaymentRequirements(req: PaymentRequirements, _kind: SupportedKind, _ext: string[]): Promise<PaymentRequirements> {
    return { ...req, extra: { ...req.extra, areFeesSponsored: false } };
  }
}

export class FakeExactClient implements SchemeNetworkClient {
  readonly scheme = "exact";
  readonly paid: PaymentRequirements[] = [];
  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    this.paid.push(req);
    return { x402Version, payload: { transaction: FAKE_TX } };
  }
}

export class FakeExactFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "ycash:*";
  readonly calls: string[] = [];
  getExtra(_network: Network): Record<string, unknown> {
    return { assets: ["YEC"], assetTransferMethods: ["transparent"], areFeesSponsored: false };
  }
  getSigners(_network: string): string[] {
    return [];
  }
  async verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    this.calls.push("verify");
    if (p.payload.transaction !== FAKE_TX) return { isValid: false, invalidReason: "invalid_payload" };
    if (p.accepted.amount !== req.amount || p.accepted.payTo !== req.payTo) return { isValid: false, invalidReason: "invalid_exact_ycash_amount" };
    return { isValid: true, payer: "smAgent" };
  }
  async settle(_p: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    this.calls.push("settle");
    return { success: true, transaction: FAKE_TXID, network: req.network, payer: "smAgent", amount: req.amount };
  }
}
