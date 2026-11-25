// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The private routes' per-request address (`sapling-proof`, x402-ycash specs/scheme_exact_ycash.md).
// Each 402 carries a fresh diversified Sapling address of the wallet's base address and a memo that
// commits to the request; the issued record goes into the registry file the facilitator reads. Core
// takes payTo from the route's dynamic `payTo(context)` (it sees the request URL) and lets the scheme
// fill `extra` from the issued record. On the paid retry the address the payload accepted is reused,
// so the rebuilt requirements match it exactly. (The merchant example does the same:
// examples/merchant-express/src/shielded.ts.)
import type { HTTPRequestContext } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { type exact, FileIssuedAddressRegistry, shielded, type YcashNetwork } from "x402-ycash-mechanism";
import type { ShieldedApiConfig } from "./config.js";

/** Seconds a client has to pay a private request (the issued record's expiresAt). */
export const SHIELDED_TIMEOUT_SECONDS = 600;

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
 * Issues the private routes' addresses and serves as the exact server scheme's `shielded` hook. It
 * never settles: the facilitator does, on the same wallet, from the same registry file.
 */
export class PrivateRouteIssuer {
  readonly server: shielded.ShieldedExactServer;

  /**
   * @param network - The API's network.
   * @param config - The private routes' setup.
   * @param wallet - The node's wallet (z_getnewdiversifiedaddress).
   */
  constructor(
    private readonly network: YcashNetwork,
    private readonly config: ShieldedApiConfig,
    wallet: shielded.ShieldedServerRpc,
  ) {
    this.server = new shielded.ShieldedExactServer({
      rpc: wallet,
      registry: new FileIssuedAddressRegistry(config.registryPath),
      baseAddress: config.baseAddress,
      defaultConfirmations: config.confirmations,
      maxOutstanding: config.maxOutstanding,
    });
  }

  /**
   * A route's dynamic payTo: the address a retry accepted, while it is held for this very resource
   * and unexpired; otherwise a fresh one, issued for this request.
   *
   * @param amount - The route's price, zatoshis.
   * @returns The payTo function core calls.
   */
  payToFor(amount: bigint): (context: HTTPRequestContext) => Promise<string> {
    return async (context) => {
      const url = context.adapter.getUrl();
      const retry = acceptedPayTo(context.paymentHeader);
      if (retry) {
        const held = await this.server.registry.get(retry);
        if (held && held.record.resource === url && held.record.expiresAt > Math.floor(Date.now() / 1000)) return retry;
      }
      const issued = await this.server.enhanceRequirements(
        {
          scheme: "exact",
          network: this.network,
          asset: "YEC",
          amount: amount.toString(),
          payTo: "",
          maxTimeoutSeconds: SHIELDED_TIMEOUT_SECONDS,
          extra: { assetTransferMethod: shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF, confirmationPolicy: { confirmations: this.config.confirmations } },
        },
        url,
      );
      return issued.payTo;
    };
  }

  /** The exact server scheme's hook: `sapling-proof`, upfront, requirements from the registry. */
  hook(): exact.ShieldedExactHandler {
    return {
      flows: { [shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF]: "upfront" },
      enhanceRequirements: (r) => this.enhanceRequirements(r),
      settle: () => {
        throw new Error("the API does not settle shielded payments; its facilitator does");
      },
    };
  }

  /**
   * The requirement of an issued address: its memo, expiry and policy, from the registry.
   *
   * @param requirements - The route's requirement with the issued payTo.
   * @returns It, with `extra` filled.
   */
  async enhanceRequirements(requirements: PaymentRequirements): Promise<PaymentRequirements> {
    const held = await this.server.registry.get(requirements.payTo);
    if (!held) throw new Error(`${requirements.payTo} was not issued by this server`);
    if (held.record.amount !== requirements.amount) throw new Error("the route's price differs from the issued request's amount");
    return {
      ...requirements,
      extra: {
        ...(requirements.extra ?? {}),
        assetTransferMethod: shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF,
        paymentFlow: shielded.PAYMENT_FLOW_UPFRONT,
        areFeesSponsored: false,
        memo: held.memo,
        expiresAt: held.record.expiresAt,
        confirmationPolicy: { confirmations: held.confirmations },
      },
    };
  }
}
