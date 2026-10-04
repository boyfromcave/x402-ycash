// The shielded routes' per-request instrument over HTTP. A `sapling-proof` or `sapling` requirement's
// payTo is a fresh diversified address, and its memo commits to the resource URL. Core treats payTo as
// immutable once the requirements are built (an enrich hook may only add `extra` fields), so the
// address is issued where core resolves payTo, the route's dynamic `payTo(context)`, which sees the
// request URL; the server scheme then fills `extra` from the issued record. On the paid retry the
// address the payload accepted is reused, so the rebuilt requirements match it exactly.
import type { FacilitatorClient, HTTPRequestContext } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { type exact, shielded, type YcashNetwork } from "x402-ycash-mechanism";

export type ShieldedMethod = typeof shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF | typeof shielded.ASSET_TRANSFER_METHOD_SAPLING;

export interface ShieldedRouteTemplate {
  network: YcashNetwork;
  /** default sapling-proof */
  method?: ShieldedMethod;
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
        // The record does not name the method, so one issuance serves both (spec, "sapling", Requirements).
        extra: { assetTransferMethod: shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF, confirmationPolicy: { confirmations: this.template.confirmations } },
      },
      url,
    );
    return issued.payTo;
  };

  /**
   * The requirement of an issued address: its memo, expiry and policy, from the registry. The method
   * is the requirement's own: `sapling-proof` (upfront) or `sapling` (authorization, no paymentFlow).
   */
  async enhanceRequirements(requirements: PaymentRequirements): Promise<PaymentRequirements> {
    const held = await this.server.registry.get(requirements.payTo);
    if (!held) throw new Error(`${requirements.payTo} was not issued by this server`);
    if (held.record.amount !== requirements.amount) throw new Error("the route's price differs from the issued request's amount");
    const method = requirements.extra?.assetTransferMethod ?? shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF;
    if (method !== shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF && method !== shielded.ASSET_TRANSFER_METHOD_SAPLING) throw new Error(`${String(method)} is not a shielded method`);
    const { paymentFlow: _flow, ...rest } = requirements.extra ?? {};
    return {
      ...requirements,
      extra: {
        ...rest,
        assetTransferMethod: method,
        ...(method === shielded.ASSET_TRANSFER_METHOD_SAPLING_PROOF ? { paymentFlow: shielded.PAYMENT_FLOW_UPFRONT } : {}),
        areFeesSponsored: false,
        memo: held.memo,
        expiresAt: held.record.expiresAt,
        confirmationPolicy: { confirmations: held.confirmations },
      },
    };
  }

  settle(): never {
    throw new Error("the merchant's server does not settle shielded payments; its facilitator does");
  }
}

/**
 * The exact server scheme's one shielded hook for the routes this merchant sells: the flows of the
 * methods it issues for (`sapling-proof` upfront, `sapling` authorization) and the method-aware
 * requirement builder, which reads only the shared registry.
 *
 * @param issuer - Any of the routes' issuers (they share the server and registry).
 * @param methods - The methods the merchant sells.
 * @returns The hook.
 */
export function shieldedHook(issuer: ShieldedRouteIssuer, methods: readonly ShieldedMethod[]): exact.ShieldedExactHandler {
  return {
    flows: Object.fromEntries(methods.map((m) => [m, m === shielded.ASSET_TRANSFER_METHOD_SAPLING ? "authorization" : "upfront"] as const)),
    enhanceRequirements: (r) => issuer.enhanceRequirements(r),
    settle: () => issuer.settle(),
  };
}

/** True when the facilitator's `exact` kind on `network` lists `method` among its transfer methods. */
export async function facilitatorListsMethod(facilitator: FacilitatorClient, network: YcashNetwork, method: string): Promise<boolean> {
  const supported = await facilitator.getSupported();
  return supported.kinds.some((k) => {
    const methods = k.extra?.assetTransferMethods;
    return k.scheme === "exact" && k.network === network && Array.isArray(methods) && methods.includes(method);
  });
}

/**
 * Whether the facilitator lists a method, as last probed: re-probed every `intervalMs` and on demand
 * (at most every `minGapMs`), so a facilitator that starts, or opts in, after the merchant turns the
 * route on without a restart (as the YED gate does, yed.ts).
 */
export class MethodGate {
  private current: boolean;
  private inflight: Promise<boolean> | undefined;
  private last = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    initial: boolean,
    private readonly probe: () => Promise<boolean>,
    private readonly opts: { intervalMs?: number; minGapMs?: number; log?: (msg: string, fields?: Record<string, unknown>) => void; what?: string } = {},
  ) {
    this.current = initial;
  }

  get listed(): boolean {
    return this.current;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(true), this.opts.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Probes again (one at a time; on demand at most every minGapMs unless forced). A failed probe means "not listed". */
  async refresh(force = false): Promise<boolean> {
    if (this.inflight) return this.inflight;
    if (!force && Date.now() - this.last < (this.opts.minGapMs ?? 5_000)) return this.current;
    this.last = Date.now();
    this.inflight = this.probe()
      .catch((e: unknown) => {
        this.opts.log?.(`${this.opts.what ?? "method"} probe failed`, { error: String(e) });
        return false;
      })
      .then((v) => {
        if (v !== this.current) this.opts.log?.(`${this.opts.what ?? "method"} route ${v ? "on" : "off"}`, { listed: v });
        this.current = v;
        return v;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
