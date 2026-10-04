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
import { NodeWalletIssuer, type AddressIssuer, type NodeWalletIssuerRpc } from "./issuer.js";
import { currentPrice, quoteZat, type PriceRpc, type PriceQuote } from "./price.js";
import { InMemoryIssuedAddressRegistry, recordRetainUntil, type IssuedAddressRegistry, type IssuedRequest } from "./registry.js";
import { memoForRecord, type RequestRecord } from "./request.js";

/** The merchant wallet calls the server makes. `YcashRpc` satisfies it. */
export interface ShieldedServerRpc extends PriceRpc, NodeWalletIssuerRpc {}

export interface ShieldedExactServerConfig {
  /**
   * The merchant's node: the default issuer's wallet, and the `yed_getprice` source of `priceUsd`
   * quotes. Optional with an `issuer` that needs no node (an OfflineAddressIssuer).
   */
  rpc?: ShieldedServerRpc;
  /** Where addresses come from. Default: a NodeWalletIssuer on `rpc` and `baseAddress`. */
  issuer?: AddressIssuer;
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

/**
 * The `sapling-proof` resource server: for each request it issues a fresh diversified address (from
 * its AddressIssuer), records the request in the registry the facilitator reads, and returns the
 * requirements with the memo commitment, expiry and confirmation policy.
 */
export class ShieldedExactServer {
  readonly registry: IssuedAddressRegistry;
  readonly issuer: AddressIssuer;
  private readonly config: ShieldedExactServerConfig;

  /**
   * Creates a server; with no `issuer`, addresses come from the wallet behind `rpc`.
   *
   * @param config - The issuer or wallet, registry, defaults and limits.
   * @throws {Error} When neither an issuer nor an rpc is given.
   */
  constructor(config: ShieldedExactServerConfig) {
    this.config = config;
    this.registry = config.registry ?? new InMemoryIssuedAddressRegistry();
    if (config.issuer) this.issuer = config.issuer;
    else if (config.rpc) this.issuer = new NodeWalletIssuer(config.rpc, config.baseAddress);
    else throw new Error("a sapling-proof server needs an address issuer, or the merchant wallet's rpc");
  }

  /**
   * Turns a route's `sapling-proof` template into the requirements of one request: a fresh payTo,
   * extra.memo, extra.expiresAt, paymentFlow "upfront" and the confirmation policy. The record is
   * kept in the registry before the requirements are returned, so a 402 never names an address
   * the facilitator would not recognise.
   *
   * @param requirements - The route's template: exact, YEC, `sapling-proof`, with an amount in
   *   zatoshis or `extra.priceUsd`.
   * @param resource - The resource (or its URL); the URL is part of the request hash.
   * @returns The requirements of one request.
   * @throws {Error} On a template this method cannot serve, a policy outside the operator's range,
   *   the issuance limit, or an issuer fault.
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
      const quote = await this.quote();
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

  /**
   * The request record behind an issued address (the spec lets the server expose it to the client).
   *
   * @param payTo - An issued address.
   * @returns The record while it is held.
   */
  async requestRecord(payTo: string): Promise<RequestRecord | undefined> {
    return (await this.registry.get(payTo))?.record;
  }

  /**
   * The current time, or the injected clock's.
   *
   * @returns Unix seconds.
   */
  private now(): number {
    return this.config.now ? this.config.now() : Math.floor(Date.now() / 1000);
  }

  /**
   * The YEC price for a `priceUsd` template: the node's `yed_getprice`, or the configured fallback
   * when the node has none or there is no node (an offline issuer needs none).
   *
   * @returns micro-USD per YEC and where it came from.
   */
  private quote(): Promise<PriceQuote> {
    const fallback = this.config.fallbackPriceMicroUsd;
    if (this.config.rpc) return currentPrice(this.config.rpc, fallback);
    if (fallback !== undefined) return Promise.resolve({ priceMicroUsd: fallback, source: "configured" });
    return Promise.reject(new Error("no YEC price: no merchant node and no fallback price is configured"));
  }

  /**
   * A diversified address never issued before, of the network's Sapling HRP (which also catches a
   * merchant node on another chain). Both issuers advance the diversifier index, so a repeat would
   * be an issuer fault; it is refused, not reused.
   *
   * @param network - The requirements' network.
   * @returns An address not in the registry.
   * @throws {Error} When the issuer returns another network's address, or repeats itself.
   */
  private async freshAddress(network: YcashNetwork): Promise<string> {
    const hrp = SAPLING_HRP[network] + "1";
    for (let i = 0; i < 3; i++) {
      const addr = await this.issuer.issue(network);
      if (!addr.startsWith(hrp)) throw new Error(`diversified address ${addr} is not a ${network} Sapling address`);
      if (!(await this.registry.wasIssued(addr))) return addr;
    }
    throw new Error(`the ${this.issuer.kind} issuer keeps returning addresses already issued`);
  }
}

/**
 * extra.confirmationPolicy.confirmations, when declared.
 *
 * @param extra - A requirement's extra.
 * @returns The declared confirmations, or undefined.
 */
export function confirmationsOf(extra: Record<string, unknown> | undefined): number | undefined {
  const policy = extra?.confirmationPolicy;
  if (policy && typeof policy === "object" && "confirmations" in policy) {
    const c = (policy as { confirmations: unknown }).confirmations;
    if (typeof c === "number") return c;
  }
  return undefined;
}
