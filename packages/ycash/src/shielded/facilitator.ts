// The `sapling-proof` facilitator, self-hosted with the merchant's wallet: `settle` runs the spec's
// nine steps in order (specs/scheme_exact_ycash.md, "sapling-proof", Settlement) and answers the
// client-submitted checklist of upstream `scheme_exact.md`: the claim is the last step, so a payment
// below its policy depth, or any failure before the claim, holds nothing.
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { ASSET_YEC, YCASH_NETWORKS, type YcashNetwork } from "../constants.js";
import { yecToZat, type BlockchainInfo, type ZReceived } from "../node/index.js";
import { RETAIN_FOREVER, consumptionKey, type SettlementStore } from "../store/index.js";
import {
  ASSET_TRANSFER_METHOD_SAPLING_PROOF,
  CHAIN_OF,
  ERR,
  MEMO_REGEX,
  PAYMENT_FLOW_UPFRONT,
  SCHEME_EXACT,
  TXID_REGEX,
  type ShieldedErrorReason,
} from "./constants.js";
import { receiptExtension, signReceipt, type JwsSigner } from "./receipt.js";
import type { IssuedAddressRegistry, IssuedRequest } from "./registry.js";
import { jcs } from "./jcs.js";
import { memoForRecord, noteMemoEquals } from "./request.js";

/**
 * The consumption key is per (txid, payTo): payTo is a diversified address issued for exactly one
 * request, so one transaction paying two requests buys both, and a proof still binds to one request.
 */
export function paymentKey(network: Parameters<typeof consumptionKey>[0], txid: string, payTo: string): string {
  return consumptionKey(network, `${txid}@${payTo}`);
}

/** The merchant wallet calls the facilitator makes. `YcashRpc` satisfies it. */
export interface ShieldedFacilitatorRpc {
  zListReceivedByAddress(address: string, minconf?: number): Promise<ZReceived[]>;
  getBlockchainInfo(): Promise<BlockchainInfo>;
}

export interface ShieldedExactFacilitatorConfig {
  rpc: ShieldedFacilitatorRpc;
  /** The server's registry (the same object or the same file). */
  registry: IssuedAddressRegistry;
  /** Restart-durable consumption store; keys are kept forever (spec, "Retention bound"). */
  store: SettlementStore;
  /** The merchant's receipt key; every success carries a signed receipt (spec, "Receipts"). */
  receiptSigner: JwsSigner;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

/** What the checks established, before the claim. */
interface Checked {
  network: YcashNetwork;
  txid: string;
  issued: IssuedRequest;
  receivedZat: bigint;
  /** −1 for a mempool note, else the shallowest note's confirmations */
  observed: number;
}

type Outcome = { ok: true; value: Checked } | { ok: false; reason: ShieldedErrorReason; message: string; txid: string; observed?: number };

const fail = (reason: ShieldedErrorReason, message: string, txid = "", observed?: number): Outcome => ({ ok: false, reason, message, txid, ...(observed === undefined ? {} : { observed }) });

/** True when `observed` (−1 mempool, N ≥ 1 depth) meets `policy` (−1 mempool; 0 and 1 a block; N). */
export function meetsPolicy(observed: number, policy: number): boolean {
  if (policy < 0) return true;
  return observed >= Math.max(policy, 1);
}

export class ShieldedExactFacilitator {
  private readonly config: ShieldedExactFacilitatorConfig;
  private chainChecked: string | undefined;

  constructor(config: ShieldedExactFacilitatorConfig) {
    this.config = config;
  }

  private now(): number {
    return this.config.now ? this.config.now() : Math.floor(Date.now() / 1000);
  }

  /**
   * Read-only: every settle check but the claim. `upfront` never calls /verify (spec step list);
   * this exists for a resource server that wants to look before it settles.
   */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.check(payload, requirements);
    if (!r.ok) return { isValid: false, invalidReason: r.reason, invalidMessage: r.message };
    if (await this.config.store.isClaimed(paymentKey(r.value.network, r.value.txid, requirements.payTo))) {
      return { isValid: false, invalidReason: ERR.duplicateSettlement, invalidMessage: `${r.value.txid} was already settled` };
    }
    return { isValid: true, extra: statusExtra(r.value.observed, r.value.receivedZat) };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    const r = await this.check(payload, requirements);
    if (!r.ok) {
      const res: SettleResponse = { success: false, errorReason: r.reason, errorMessage: r.message, transaction: r.txid, network };
      if (r.reason === ERR.settlementPending) res.extra = { status: "pending", confirmations: r.observed ?? -1 };
      return res;
    }
    // Step 9: the claim, atomically, last. Of two concurrent presentations exactly one gets here.
    const key = paymentKey(r.value.network, r.value.txid, requirements.payTo);
    if (!(await this.config.store.claim(key, RETAIN_FOREVER))) {
      return { success: false, errorReason: ERR.duplicateSettlement, errorMessage: `${r.value.txid} was already settled`, transaction: r.value.txid, network };
    }
    try {
      const receipt = await signReceipt({ network, resourceUrl: r.value.issued.record.resource, transaction: r.value.txid, issuedAt: this.now() }, this.config.receiptSigner);
      return {
        success: true,
        transaction: r.value.txid,
        network,
        extra: statusExtra(r.value.observed, r.value.receivedZat),
        extensions: receiptExtension(receipt),
      };
    } catch (e) {
      // The resource has not run: an attempt that ends abnormally must not hold the claim.
      await this.config.store.release(key);
      return { success: false, errorReason: ERR.unexpected, errorMessage: `receipt signing failed: ${String(e)}`, transaction: r.value.txid, network };
    }
  }

  /** Steps 1 to 8. */
  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Outcome> {
    // 1. Envelope.
    const accepted = payload.accepted;
    if (payload.x402Version !== 2) return fail(ERR.requirementsMismatch, `x402Version ${payload.x402Version} is not 2`);
    if (!accepted) return fail(ERR.requirementsMismatch, "payload has no accepted requirements");
    for (const f of ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"] as const) {
      if (accepted[f] !== requirements[f]) return fail(ERR.requirementsMismatch, `accepted.${f} differs from the requirements`);
    }
    if (requirements.scheme !== SCHEME_EXACT) return fail(ERR.requirementsMismatch, `scheme ${requirements.scheme} is not exact`);
    const network = requirements.network as YcashNetwork;
    if (!YCASH_NETWORKS.includes(network)) return fail(ERR.requirementsMismatch, `${requirements.network} is not a Ycash network`);
    if (requirements.asset !== ASSET_YEC) return fail(ERR.requirementsMismatch, "sapling-proof pays YEC only");
    const ex = requirements.extra ?? {};
    const ax = accepted.extra ?? {};
    for (const x of [ex, ax]) {
      if (x.assetTransferMethod !== ASSET_TRANSFER_METHOD_SAPLING_PROOF) return fail(ERR.assetTransferMethod, `assetTransferMethod ${String(x.assetTransferMethod)} is not sapling-proof`);
      if (x.paymentFlow !== PAYMENT_FLOW_UPFRONT) return fail(ERR.paymentFlow, `paymentFlow ${String(x.paymentFlow)} is not upfront`);
    }
    if (typeof ex.memo !== "string" || !MEMO_REGEX.test(ex.memo)) return fail(ERR.requirementsMismatch, "extra.memo is missing or malformed");
    if (!Number.isSafeInteger(ex.expiresAt)) return fail(ERR.requirementsMismatch, "extra.expiresAt is missing");
    // Every server-declared extra field, memo and expiresAt included, has the same value in accepted.
    for (const k of Object.keys(ex)) {
      if (jcs(ex[k] ?? null) !== jcs(ax[k] ?? null)) return fail(ERR.requirementsMismatch, `accepted.extra.${k} differs from the requirements`);
    }

    // Rule 2: the merchant node is on the requirements' chain.
    if (this.chainChecked !== network) {
      const chain = (await this.config.rpc.getBlockchainInfo()).chain;
      if (chain !== CHAIN_OF[network]) return fail(ERR.networkMismatch, `the merchant node is on ${chain}, not ${network}`);
      this.chainChecked = network;
    }

    // 2. The instrument: issued here, record still held, memo and terms those of the record.
    const issued = await this.config.registry.get(requirements.payTo);
    if (!issued) return fail(ERR.unknownInstrument, `${requirements.payTo} is not an address issued for a held request`);
    const rec = issued.record;
    if (issued.memo !== ex.memo || memoForRecord(rec) !== ex.memo) return fail(ERR.unknownInstrument, "extra.memo is not the memo issued for this address");
    if (rec.network !== network || rec.amount !== requirements.amount || rec.expiresAt !== ex.expiresAt || rec.payTo !== requirements.payTo) {
      return fail(ERR.unknownInstrument, "the requirements are not the ones issued for this address");
    }

    // 3. The proof.
    const txid = payload.payload?.txid;
    if (typeof txid !== "string" || !TXID_REGEX.test(txid)) return fail(ERR.txidMalformed, "payload.txid is not 64 lowercase hex characters");

    // 4. Notes of this txid at payTo, mempool included (minconf 0).
    const notes = (await this.config.rpc.zListReceivedByAddress(requirements.payTo, 0)).filter((n) => n.txid === txid);
    if (notes.length === 0) return fail(ERR.notReceived, `the merchant wallet has no note of ${txid} at payTo (yet)`, txid);

    // 5. Memo: at least one note carries the commitment.
    if (!notes.some((n) => noteMemoEquals(n, ex.memo as string))) return fail(ERR.memoMismatch, `no note of ${txid} carries extra.memo`, txid);

    // 6. Amount: the sum covers it. Overpayment is accepted and kept (spec, "Amount acceptance").
    const receivedZat = notes.reduce((s, n) => s + (n.amountZat !== undefined ? BigInt(n.amountZat) : yecToZat(n.amount)), 0n);
    if (receivedZat < BigInt(requirements.amount)) {
      return fail(ERR.underpaid, `received ${receivedZat} zatoshis, ${requirements.amount} required; the funds stay at payTo`, txid);
    }

    // 7. Depth: every note meets the policy. Below it: pending, nothing claimed.
    const minConf = Math.min(...notes.map((n) => n.confirmations ?? 0));
    const observed = minConf <= 0 ? -1 : minConf;
    if (!meetsPolicy(observed, issued.confirmations)) {
      const need = Math.max(issued.confirmations, 1);
      return fail(ERR.settlementPending, `${txid} has ${Math.max(minConf, 0)} confirmations, the policy needs ${need}`, txid, observed);
    }

    // 8. Window: the record is still held (step 2 found it); pruning honours the retention bound.
    return { ok: true, value: { network, txid, issued, receivedZat, observed } };
  }
}

/** `extra` of a response: the strongest evidence observed (spec, "Confirmation policy"). */
function statusExtra(observed: number, receivedZat: bigint): Record<string, unknown> {
  return { status: observed < 0 ? "mempool" : "confirmed", confirmations: observed, receivedZat: receivedZat.toString() };
}
