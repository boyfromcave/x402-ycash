// Copyright (c) 2026 The Ycash developers. MIT License.
//
// One payment buys one request. The facilitator claims a payment only when it settles, and its
// verify only reads that claim, so N concurrent requests carrying the same payment all verify
// before any of them settles. Two defences:
//   1. PaymentClaims, in this process, BEFORE verify: the first request with a payment claims it;
//      any other request with it, while the first is in flight or after it answered, gets 409.
//      The claim is released only when the payment never reached the handler (the facilitator
//      refused it, or could not be reached); once the handler ran, whatever it answered, the
//      payment stays used for the TTL (a failed answer is not settled, so not charged, but the
//      payment cannot buy unlimited retries of node work).
//   2. singleUseFacilitator, across processes: a settle that did not claim the payment (the
//      facilitator's `extra.resumed`) is turned into a failure, so the middleware withholds the
//      answer it buffered.
import { createHash } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";

type State = "inflight" | "used";

export type ClaimResult = "claimed" | "inflight" | "used" | "full";

export class PaymentClaims {
  private readonly entries = new Map<string, { state: State; until: number }>();

  /**
   * @param ttlMs - How long a used payment stays refused (longer than a payment transaction's validity).
   * @param maxEntries - The most payments remembered; when full (after dropping expired ones) new payments are refused (fail closed).
   * @param now - The clock (tests).
   */
  constructor(
    readonly ttlMs: number,
    readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * The claim key of a PAYMENT-SIGNATURE: the SHA-256 of its payload's transaction (hex lower-cased,
   * so a case variant of the same transaction is the same payment), else of the whole payload.
   *
   * @param header - The header value.
   * @returns The key, or undefined when the header does not decode (the middleware answers 402).
   */
  static keyOf(header: string): string | undefined {
    let payload: { payload?: unknown };
    try {
      payload = decodePaymentSignatureHeader(header) as { payload?: unknown };
    } catch {
      return undefined;
    }
    const inner = payload.payload as { transaction?: unknown } | undefined;
    const material = typeof inner?.transaction === "string" ? `tx:${inner.transaction.toLowerCase()}` : `payload:${JSON.stringify(inner ?? null)}`;
    return createHash("sha256").update(material).digest("hex");
  }

  /**
   * Claims a payment for one request.
   *
   * @param key - The payment's key.
   * @returns "claimed", or why not: in flight elsewhere, already used, or the set is full.
   */
  claim(key: string): ClaimResult {
    const t = this.now();
    const e = this.entries.get(key);
    if (e && e.until > t) return e.state;
    if (!e && this.entries.size >= this.maxEntries) {
      for (const [k, v] of this.entries) if (v.until <= t) this.entries.delete(k);
      if (this.entries.size >= this.maxEntries) return "full";
    }
    this.entries.set(key, { state: "inflight", until: t + this.ttlMs });
    return "claimed";
  }

  /** The payment never reached the handler: it may be presented again. */
  release(key: string): void {
    if (this.entries.get(key)?.state === "inflight") this.entries.delete(key);
  }

  /** The handler ran: the payment is used for the TTL, whatever the answer was. */
  burn(key: string): void {
    this.entries.set(key, { state: "used", until: this.now() + this.ttlMs });
  }
}

/**
 * Wraps a facilitator client so that a settle which did not claim the payment (`extra.resumed`,
 * the facilitator's answer to a second settle of a claimed transaction) counts as a failure.
 *
 * @param inner - The facilitator client.
 * @returns The same client with a strict settle.
 */
export function singleUseFacilitator(inner: FacilitatorClient): FacilitatorClient {
  return {
    verify: (p, r) => inner.verify(p, r),
    getSupported: () => inner.getSupported(),
    settle: async (p, r) => {
      const s = await inner.settle(p, r);
      if (s.success && (s.extra as { resumed?: unknown } | undefined)?.resumed === true) {
        return { success: false, errorReason: "duplicate_settlement", errorMessage: "this payment already bought a request", transaction: s.transaction, network: s.network, ...(s.payer ? { payer: s.payer } : {}) };
      }
      return s;
    },
  };
}
