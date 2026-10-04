// The `sapling-proof` resource server: per request, a fresh diversified address, the request record
// and its memo commitment (spec, "sapling-proof", Requirements; plan §5.9 X4a).
import { randomBytes } from "node:crypto";
import type { PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { ASSET_YEC, YCASH_NETWORKS, type YcashNetwork } from "../constants.js";
import {
  ASSET_TRANSFER_METHOD_SAPLING_PROOF,
  DEFAULT_SAPLING_PROOF_CONFIRMATIONS,
  MAX_CONFIRMATIONS,
  MIN_CONFIRMATIONS,
  PAYMENT_FLOW_UPFRONT,
  SAPLING_HRP,
  SCHEME_EXACT,
} from "./constants.js";
import { currentPrice, quoteZat, type PriceRpc } from "./price.js";
import { InMemoryIssuedAddressRegistry, recordRetainUntil, type IssuedAddressRegistry, type IssuedRequest } from "./registry.js";
import { memoForRecord, type RequestRecord } from "./request.js";

/** The merchant wallet calls the server makes. `YcashRpc` satisfies it. */
export interface ShieldedServerRpc extends PriceRpc {
  zGetNewAddress(): Promise<string>;
  zGetNewDiversifiedAddress(base: string): Promise<string>;
}

export interface ShieldedExactServerConfig {
  rpc: ShieldedServerRpc;
  /** Shared with the facilitator. Default: in memory (a restart forgets open requests). */
  registry?: IssuedAddressRegistry;
  /**
   * The merchant's base Sapling address, whose spending key the wallet holds (both lines refuse a
   * diversified address without it: `ycash-dd/src/wallet/rpcdump.cpp:869-870`,
   * `ycash6/src/wallet/rpcdump.cpp:1425-1427`). Default: one `z_getnewaddress sapling`, made once.
   */
  baseAddress?: string;
  /** Used when a requirement declares no confirmationPolicy (spec default 1). */
  defaultConfirmations?: number;
  /** Seconds a record is held beyond expiresAt + the policy depth (default 3600). */
  retentionGraceSeconds?: number;
  /** Refuse to issue beyond this many held records (spec, "Implementation limits"). */
  maxOutstanding?: number;
  /**
   * The confirmation range the operator settles. A policy outside it is refused before anything is
   * issued, so a refusal uses no address and does not count toward maxOutstanding.
   */
  confirmationRange?: { minimum: number; maximum: number };
  /** micro-USD per YEC when the node has no live `yed_getprice`. */
  fallbackPriceMicroUsd?: number;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

/** A requirement template may carry `extra.priceUsd` instead of an amount; the server quotes it. */
export const EXTRA_PRICE_USD = "priceUsd";

export class ShieldedExactServer {
  readonly registry: IssuedAddressRegistry;
  private readonly rpc: ShieldedServerRpc;
  private readonly config: ShieldedExactServerConfig;
  private basePromise: Promise<string> | undefined;

  constructor(config: ShieldedExactServerConfig) {
    this.config = config;
    this.rpc = config.rpc;
    this.registry = config.registry ?? new InMemoryIssuedAddressRegistry();
    if (config.baseAddress) this.basePromise = Promise.resolve(config.baseAddress);
  }

  private now(): number {
    return this.config.now ? this.config.now() : Math.floor(Date.now() / 1000);
  }

  private baseAddress(): Promise<string> {
    this.basePromise ??= this.rpc.zGetNewAddress().catch((e: unknown) => {
      this.basePromise = undefined;
      throw e;
    });
    return this.basePromise;
  }

  /**
   * Turns a route's `sapling-proof` template into the requirements of one request: a fresh payTo,
   * extra.memo, extra.expiresAt, paymentFlow "upfront" and the confirmation policy. The record is
   * kept in the registry before the requirements are returned, so a 402 never names an address
   * the facilitator would not recognise.
   */
  async enhanceRequirements(requirements: PaymentRequirements, resource: ResourceInfo | string): Promise<PaymentRequirements> {
    const resourceUrl = typeof resource === "string" ? resource : resource.url;
    if (!resourceUrl) throw new Error("sapling-proof needs the resource URL: it is part of the request hash");
    const network = requirements.network as YcashNetwork;
    if (!YCASH_NETWORKS.includes(network)) throw new Error(`not a Ycash network: ${requirements.network}`);
    if (requirements.scheme !== SCHEME_EXACT) throw new Error(`scheme ${requirements.scheme} is not exact`);
    if (requirements.asset !== ASSET_YEC) throw new Error("sapling-proof pays YEC only");
    const extra: Record<string, unknown> = { ...(requirements.extra ?? {}) };
    const method = extra.assetTransferMethod;
    if (method !== ASSET_TRANSFER_METHOD_SAPLING_PROOF) throw new Error(`assetTransferMethod ${String(method)} is not sapling-proof`);
    const timeout = requirements.maxTimeoutSeconds;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error(`maxTimeoutSeconds must be a positive integer: ${timeout}`);
    const confirmations = confirmationsOf(extra) ?? this.config.defaultConfirmations ?? DEFAULT_SAPLING_PROOF_CONFIRMATIONS;
    if (!Number.isInteger(confirmations) || confirmations < MIN_CONFIRMATIONS || confirmations > MAX_CONFIRMATIONS) {
      throw new Error(`confirmations ${confirmations} is outside [${MIN_CONFIRMATIONS}, ${MAX_CONFIRMATIONS}]`);
    }
    const range = this.config.confirmationRange;
    if (range && (confirmations < range.minimum || confirmations > range.maximum)) {
      throw new Error(`confirmations ${confirmations} is outside the operator's range [${range.minimum}, ${range.maximum}]`);
    }

    let amount = requirements.amount;
    if (typeof extra[EXTRA_PRICE_USD] === "string") {
      const usd = extra[EXTRA_PRICE_USD] as string;
      const quote = await currentPrice(this.rpc, this.config.fallbackPriceMicroUsd);
      amount = quoteZat(usd, quote.priceMicroUsd).toString();
      delete extra[EXTRA_PRICE_USD];
      extra.quote = { usd, priceMicroUsd: quote.priceMicroUsd, source: quote.source, ...(quote.height === undefined ? {} : { height: quote.height }) };
    }
    if (!/^[1-9]\d*$/.test(amount)) throw new Error(`amount must be a positive integer of zatoshis: ${amount}`);

    const now = this.now();
    const graceSeconds = this.config.retentionGraceSeconds ?? 3600;
    if (this.config.maxOutstanding !== undefined && (await this.registry.outstanding(now)) >= this.config.maxOutstanding) {
      throw new Error(`issuance limit: ${this.config.maxOutstanding} sapling-proof requests already held`);
    }

    const payTo = await this.freshAddress(network);
    const expiresAt = now + timeout;
    const record: RequestRecord = {
      v: 1,
      network,
      asset: ASSET_YEC,
      amount,
      payTo,
      resource: resourceUrl,
      expiresAt,
      nonce: randomBytes(32).toString("hex"),
    };
    const memo = memoForRecord(record);
    const issued: IssuedRequest = { record, memo, confirmations, issuedAt: now, retainUntil: recordRetainUntil(expiresAt, confirmations, graceSeconds) };
    if (!(await this.registry.issue(payTo, issued))) throw new Error(`address ${payTo} was already issued`);

    return {
      ...requirements,
      amount,
      payTo,
      extra: {
        ...extra,
        assetTransferMethod: ASSET_TRANSFER_METHOD_SAPLING_PROOF,
        paymentFlow: PAYMENT_FLOW_UPFRONT,
        areFeesSponsored: false,
        memo,
        expiresAt,
        confirmationPolicy: { confirmations },
      },
    };
  }

  /** The request record behind an issued address (the spec lets the server expose it to the client). */
  async requestRecord(payTo: string): Promise<RequestRecord | undefined> {
    return (await this.registry.get(payTo))?.record;
  }

  /**
   * A diversified address never issued before, of the network's Sapling HRP (which also catches a
   * merchant node on another chain). `z_getnewdiversifiedaddress` advances the diversifier index, so a
   * repeat would be a wallet fault; it is refused, not reused.
   */
  private async freshAddress(network: YcashNetwork): Promise<string> {
    const base = await this.baseAddress();
    const hrp = SAPLING_HRP[network] + "1";
    if (!base.startsWith(hrp)) throw new Error(`base address ${base} is not a ${network} Sapling address`);
    for (let i = 0; i < 3; i++) {
      const addr = await this.rpc.zGetNewDiversifiedAddress(base);
      if (!addr.startsWith(hrp)) throw new Error(`diversified address ${addr} is not a ${network} Sapling address`);
      if (!(await this.registry.wasIssued(addr))) return addr;
    }
    throw new Error("the wallet keeps returning addresses already issued");
  }
}

/** extra.confirmationPolicy.confirmations, when declared. */
export function confirmationsOf(extra: Record<string, unknown> | undefined): number | undefined {
  const policy = extra?.confirmationPolicy;
  if (policy && typeof policy === "object" && "confirmations" in policy) {
    const c = (policy as { confirmations: unknown }).confirmations;
    if (typeof c === "number") return c;
  }
  return undefined;
}
