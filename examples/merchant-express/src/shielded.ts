// The shielded route's per-request instrument over HTTP. A `sapling-proof` requirement's payTo is a
// fresh diversified address, and its memo commits to the resource URL. Core treats payTo as
// immutable once the requirements are built (an enrich hook may only add `extra` fields), so the
// address is issued where core resolves payTo, the route's dynamic `payTo(context)`, which sees the
// request URL; the server scheme then fills `extra` from the issued record. On the paid retry the
// address the payload accepted is reused, so the rebuilt requirements match it exactly.
import type { HTTPRequestContext } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { type exact, shielded, type YcashNetwork } from "x402-ycash-mechanism";

export interface ShieldedRouteTemplate {
  network: YcashNetwork;
  /** zatoshis */
  amount: string;
  maxTimeoutSeconds: number;
  confirmations: number;
}

/** The `accepted.payTo` of a PAYMENT-SIGNATURE header, if it decodes as a v2 payload. */
function acceptedPayTo(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepted?: { payTo?: unknown } };
    return typeof p.accepted?.payTo === "string" ? p.accepted.payTo : undefined;
  } catch {
    return undefined; // a malformed header fails matching downstream
  }
}

/**
 * Issues the route's addresses (`payTo`) and serves as the exact server scheme's `shielded`
 * handler (`enhanceRequirements` reads the issued record). It never settles: the self-hosted
 * facilitator does, from the same registry file.
 */
export class ShieldedRouteIssuer implements exact.ShieldedExactHandler {
  constructor(
    private readonly server: shielded.ShieldedExactServer,
    private readonly template: ShieldedRouteTemplate,
  ) {}

  /** The route's dynamic payTo. */
  readonly payTo = async (context: HTTPRequestContext): Promise<string> => {
    const url = context.adapter.getUrl();
    const retry = acceptedPayTo(context.paymentHeader);
    if (retry) {
      const held = await this.server.registry.get(retry);
      // Only an address issued for this very resource and still unexpired is reused.
      if (held && held.record.resource === url && held.record.expiresAt > Math.floor(Date.now() / 1000)) return retry;
    }
    const issued = await this.server.enhanceRequirements(
      {
        scheme: "exact",
        network: this.template.network,
        asset: "YEC",
        amount: this.template.amount,
        payTo: "",
        maxTimeoutSeconds: this.template.maxTimeoutSeconds,
        extra: { assetTransferMethod: shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF, confirmationPolicy: { confirmations: this.template.confirmations } },
      },
      url,
    );
    return issued.payTo;
  };

  /** The requirement of an issued address: its memo, expiry and policy, from the registry. */
  async enhanceRequirements(requirements: PaymentRequirements): Promise<PaymentRequirements> {
    const held = await this.server.registry.get(requirements.payTo);
    if (!held) throw new Error(`${requirements.payTo} was not issued by this server`);
    if (held.record.amount !== requirements.amount) throw new Error("the route's price differs from the issued request's amount");
    return {
      ...requirements,
      extra: {
        ...requirements.extra,
        assetTransferMethod: shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF,
        paymentFlow: shielded.PAYMENT_FLOW_UPFRONT,
        areFeesSponsored: false,
        memo: held.memo,
        expiresAt: held.record.expiresAt,
        confirmationPolicy: { confirmations: held.confirmations },
      },
    };
  }

  settle(): never {
    throw new Error("the merchant's server does not settle sapling-proof; its facilitator does");
  }
}
