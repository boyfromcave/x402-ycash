// The `sapling` facilitator (specs/scheme_exact_ycash.md, "sapling"; plan §5.9 X4b): the client hands
// over a signed Sapling v4 transaction it has not broadcast; verify trial-decrypts the payment output
// with the merchant's incoming viewing key and checks it offline, settle claims the txid, broadcasts
// and observes the note in the merchant's wallet. The facilitator holds the viewing key itself (no
// wallet RPC can decrypt an unmined transaction, plan N-2), so it is the merchant's own.
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { ASSET_YEC, YCASH_NETWORKS, type YcashNetwork } from "../constants.js";
import { checkSighashAll } from "../exact/script.js";
import { expiryWindow } from "../exact/policy.js";
import { RPC_INVALID_ADDRESS_OR_KEY, RpcError, SendRawTransactionError, yecToZat, type BlockchainInfo, type TxOutInfo, type VerifyScriptsResult, type ZReceived } from "../node/index.js";
import { retainUntilForExpiry, txidKey, type SettlementStore } from "../store/index.js";
import { feeFloor, parseTx, txFee, txid as txidOf, type Tx } from "../tx/index.js";
import { ASSET_TRANSFER_METHOD_SAPLING, CHAIN_OF, ERR, MEMO_REGEX, SCHEME_EXACT, type ShieldedErrorReason } from "./constants.js";
import { meetsPolicy } from "./facilitator.js";
import { jcs } from "./jcs.js";
import { receiptExtension, signReceipt, type JwsSigner } from "./receipt.js";
import type { IssuedAddressRegistry, IssuedRequest } from "./registry.js";
import { memoForRecord, noteMemoEquals } from "./request.js";
import { decodeSaplingViewingKey, LEAD_BYTE_ZIP212, memoBytes, trialDecryptOutput, type DecryptedNote, type SaplingIncomingKey } from "./sapling/index.js";

/** The `sapling` method's own codes (spec, "Error Codes"). */
export const ERR_SAPLING = {
  /** no output, or more than one, decrypts under the merchant's key, or it is not to payTo (rule 5) */
  output: "invalid_exact_ycash_sapling_output",
  /** the node refused the transaction at relay: proofs, signatures, a spent nullifier (settle step 3) */
  rejected: "invalid_exact_ycash_sapling_rejected",
  transaction: "invalid_exact_ycash_transaction",
  sighash: "invalid_exact_ycash_sighash",
  inputSpent: "invalid_exact_ycash_input_spent",
  feeTooLow: "invalid_exact_ycash_fee_too_low",
  feeTooHigh: "invalid_exact_ycash_fee_too_high",
  expiry: "invalid_exact_ycash_expiry",
  script: "invalid_exact_ycash_script",
} as const;
export type SaplingErrorReason = ShieldedErrorReason | (typeof ERR_SAPLING)[keyof typeof ERR_SAPLING];

/** `paymentFlow` of the method; absent means the same. */
export const PAYMENT_FLOW_AUTHORIZATION = "authorization" as const;

/** The node calls the facilitator makes. `YcashRpc` satisfies it. */
export interface SaplingFacilitatorRpc {
  getBlockchainInfo(): Promise<BlockchainInfo>;
  getBlockCount(): Promise<number>;
  getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null>;
  verifyScripts(hex: string): Promise<VerifyScriptsResult>;
  sendRawTransaction(hex: string): Promise<string>;
  /** On the node that holds the merchant's viewing key (settle step 4). */
  zListReceivedByAddress(address: string, minconf?: number): Promise<ZReceived[]>;
}

export interface SaplingVerifyLimits {
  /** Rule 3's size limit, bytes (default 100,000: MAX_STANDARD_TX_SIZE on both lines). */
  maxTransactionBytes: number;
  /** Rule 3's bound on Sapling spends plus outputs plus transparent inputs (default 50). */
  maxComponents: number;
  /** Rule 8's sanity cap, zatoshis (RECOMMENDED 100,000). */
  feeCapZat: bigint;
}

export const DEFAULT_SAPLING_LIMITS: SaplingVerifyLimits = { maxTransactionBytes: 100_000, maxComponents: 50, feeCapZat: 100_000n };

export interface SaplingExactFacilitatorConfig {
  rpc: SaplingFacilitatorRpc;
  /** The merchant's `zxview…` key (`z_exportviewingkey`), or its decoded incoming half. */
  viewingKey: string | SaplingIncomingKey;
  /** The one network served: the key's HRP must be its own. */
  network: YcashNetwork;
  /** The server's registry (the same object or the same file). */
  registry: IssuedAddressRegistry;
  /** The settlement store shared with every settle worker; keys live until expiry + 10 blocks. */
  store: SettlementStore;
  /** The merchant's receipt key; every success carries a signed receipt. */
  receiptSigner: JwsSigner;
  limits?: Partial<SaplingVerifyLimits>;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
  /** How long settle observes the note for the policy depth (default 10 s, capped by maxTimeoutSeconds). */
  observeWaitMs?: number;
  /** Poll interval of that wait (default 500 ms). */
  observePollMs?: number;
}

/** What verify established, before the claim. */
export interface SaplingVerified {
  network: YcashNetwork;
  hex: string;
  tx: Tx;
  txid: string;
  key: string;
  issued: IssuedRequest;
  note: DecryptedNote;
  feeZat: bigint;
}

type Outcome = { ok: true; value: SaplingVerified } | { ok: false; reason: SaplingErrorReason; message: string; txid: string };

const fail = (reason: SaplingErrorReason, message: string, txid = ""): Outcome => ({ ok: false, reason, message, txid });
const HEX = /^(?:[0-9a-f]{2})+$/;

/**
 * The `sapling` facilitator: offline note decryption and the node's transparent checks in verify,
 * claim-then-broadcast in settle. It is self-hosted: it holds the merchant's incoming viewing key.
 */
export class SaplingExactFacilitator {
  private readonly config: SaplingExactFacilitatorConfig;
  private readonly key: SaplingIncomingKey;
  private readonly limits: SaplingVerifyLimits;
  private chainChecked = false;

  /**
   * Decodes the viewing key for the network and keeps the configuration.
   *
   * @param config - The node, viewing key, registry, store, receipt signer and limits.
   * @throws Error when the viewing key is not a key of the network.
   */
  constructor(config: SaplingExactFacilitatorConfig) {
    this.config = config;
    this.key = typeof config.viewingKey === "string" ? decodeSaplingViewingKey(config.viewingKey, config.network) : config.viewingKey;
    if (this.key.network !== config.network) throw new Error(`the viewing key is a ${this.key.network} key, the facilitator serves ${config.network}`);
    this.limits = { ...DEFAULT_SAPLING_LIMITS, ...(config.limits ?? {}) };
  }

  /**
   * Verification rules 1 to 11, read-only (nothing broadcast). A claimed txid answers
   * `duplicate_settlement`, as the transparent method does.
   *
   * @param payload - The client's payload, carrying the transaction hex.
   * @param requirements - The issued requirements.
   * @returns `isValid` with the decrypted value, or the first failing rule's reason.
   */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const r = await this.check(payload, requirements);
      if (!r.ok) return { isValid: false, invalidReason: r.reason, invalidMessage: r.message };
      return { isValid: true, extra: { receivedZat: r.value.note.value.toString(), feeZat: r.value.feeZat.toString() } };
    } catch (e) {
      return { isValid: false, invalidReason: ERR.unexpected, invalidMessage: `node lookup failed: ${String(e)}` };
    }
  }

  /**
   * Settlement: a claimed txid is only observed (never broadcast twice); otherwise the rules are
   * re-run, the txid claimed, the transaction broadcast, and the note observed in the merchant's
   * wallet until the policy depth or the wait ends. A node rejection releases the claim and is
   * terminal; a transport failure keeps it.
   *
   * @param payload - The client's payload, carrying the transaction hex.
   * @param requirements - The issued requirements.
   * @returns Success with a receipt, `settlement_pending`, or a failure.
   */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    const failure = (reason: string, txid: string, message: string): SettleResponse => ({ success: false, errorReason: reason, errorMessage: message, transaction: txid, network });
    const pure = this.resolve(payload, requirements);
    if (!pure.ok) return failure(pure.reason, pure.txid, pure.message);
    const { tx, txid, key } = pure.value;
    try {
      if (await this.config.store.isClaimed(key)) {
        const issued = await this.config.registry.get(requirements.payTo);
        return issued ? this.observe(txid, tx, issued, requirements) : failure(ERR.unknownInstrument, txid, `${requirements.payTo} is no longer held`);
      }
      const r = await this.check(payload, requirements);
      if (!r.ok) return r.reason === ERR.duplicateSettlement ? this.observeClaimed(txid, tx, requirements) : failure(r.reason, r.txid, r.message);
      // The claim is taken before the first await on submission; losing it means another settle owns the broadcast.
      if (!(await this.config.store.claim(key, retainUntilForExpiry(tx.expiryHeight)))) return this.observe(txid, tx, r.value.issued, requirements);
      const rejected = await this.submit(r.value);
      if (rejected) {
        await this.config.store.release(key); // the node answered and did not accept it
        return failure(rejected.reason, txid, rejected.message);
      }
      return this.observe(txid, tx, r.value.issued, requirements);
    } catch (e) {
      return failure(ERR.unexpected, txid, `settle failed: ${String(e)}`);
    }
  }

  /**
   * The current time in Unix seconds, from the injected clock when there is one.
   *
   * @returns Unix seconds.
   */
  private now(): number {
    return this.config.now ? this.config.now() : Math.floor(Date.now() / 1000);
  }

  /**
   * Rules 1 and 3 and the txid: the checks that need no node, so a malformed payment is refused
   * before any RPC.
   *
   * @param payload - The client's payload.
   * @param requirements - The issued requirements.
   * @returns The parsed transaction, txid and consumption key, or the first failure.
   */
  private resolve(payload: PaymentPayload, requirements: PaymentRequirements): { ok: true; value: { tx: Tx; hex: string; txid: string; key: string; network: YcashNetwork } } | Exclude<Outcome, { ok: true }> {
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
    if (network !== this.config.network) return fail(ERR.networkMismatch, `this facilitator serves ${this.config.network}`);
    if (requirements.asset !== ASSET_YEC) return fail(ERR.requirementsMismatch, "sapling pays YEC only");
    const ex = requirements.extra ?? {};
    const ax = accepted.extra ?? {};
    for (const x of [ex, ax]) {
      if (x.assetTransferMethod !== ASSET_TRANSFER_METHOD_SAPLING) return fail(ERR.assetTransferMethod, `assetTransferMethod ${String(x.assetTransferMethod)} is not sapling`);
      if (x.paymentFlow !== undefined && x.paymentFlow !== PAYMENT_FLOW_AUTHORIZATION) return fail(ERR.paymentFlow, `paymentFlow ${String(x.paymentFlow)} is not authorization`);
      if (x.areFeesSponsored !== undefined && x.areFeesSponsored !== false) return fail(ERR.requirementsMismatch, "areFeesSponsored must be false");
    }
    if (typeof ex.memo !== "string" || !MEMO_REGEX.test(ex.memo)) return fail(ERR.requirementsMismatch, "extra.memo is missing or malformed");
    if (!Number.isSafeInteger(ex.expiresAt)) return fail(ERR.requirementsMismatch, "extra.expiresAt is missing");
    for (const k of Object.keys(ex)) {
      if (jcs(ex[k] ?? null) !== jcs(ax[k] ?? null)) return fail(ERR.requirementsMismatch, `accepted.extra.${k} differs from the requirements`);
    }

    // 3. Decoding: one v4 Sapling-group transaction with a Sapling bundle, within the limits.
    const hex = payload.payload?.transaction;
    if (typeof hex !== "string" || !HEX.test(hex)) return fail(ERR_SAPLING.transaction, "payload.transaction is not lowercase hex");
    if (hex.length / 2 > this.limits.maxTransactionBytes) return fail(ERR_SAPLING.transaction, `transaction exceeds ${this.limits.maxTransactionBytes} bytes`);
    let tx: Tx;
    try {
      tx = parseTx(hex);
    } catch (e) {
      return fail(ERR_SAPLING.transaction, `not a v4 transaction: ${(e as Error).message}`);
    }
    if (tx.shieldedOutputs.length === 0 || !tx.bindingSig) return fail(ERR_SAPLING.transaction, "no Sapling outputs");
    if (tx.joinSplits.length > 0) return fail(ERR_SAPLING.transaction, "JoinSplits are not accepted");
    if (tx.lockTime !== 0) return fail(ERR_SAPLING.transaction, `nLockTime ${tx.lockTime} is not 0`);
    if (tx.shieldedSpends.length + tx.shieldedOutputs.length + tx.vin.length > this.limits.maxComponents) {
      return fail(ERR_SAPLING.transaction, `more than ${this.limits.maxComponents} spends, outputs and inputs`);
    }
    const seen = new Set<string>();
    for (const s of tx.shieldedSpends) {
      const nf = Buffer.from(s.nullifier).toString("hex");
      if (seen.has(nf)) return fail(ERR_SAPLING.transaction, "a nullifier is repeated");
      seen.add(nf);
    }
    const txid = txidOf(tx);
    return { ok: true, value: { tx, hex, txid, key: txidKey(network, txid), network } };
  }

  /**
   * Rules 1 to 11 in order (spec, "sapling", Facilitator verification rules). Read-only.
   *
   * @param payload - The client's payload.
   * @param requirements - The issued requirements.
   * @returns The established facts, or the first failure's reason and message.
   */
  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Outcome> {
    const pure = this.resolve(payload, requirements);
    if (!pure.ok) return pure;
    const { tx, hex, txid, key, network } = pure.value;
    const ex = requirements.extra ?? {};

    // 2. Network: the node is on the requirements' chain (the viewing key's HRP was checked at construction).
    if (!this.chainChecked) {
      const chain = (await this.config.rpc.getBlockchainInfo()).chain;
      if (chain !== CHAIN_OF[network]) return fail(ERR.networkMismatch, `the facilitator node is on ${chain}, not ${network}`);
      this.chainChecked = true;
    }

    // 4. The instrument: issued here, record still held, memo and terms those of the record.
    const issued = await this.config.registry.get(requirements.payTo);
    if (!issued) return fail(ERR.unknownInstrument, `${requirements.payTo} is not an address issued for a held request`, txid);
    const rec = issued.record;
    if (issued.memo !== ex.memo || memoForRecord(rec) !== ex.memo) return fail(ERR.unknownInstrument, "extra.memo is not the memo issued for this address", txid);
    if (rec.network !== network || rec.amount !== requirements.amount || rec.expiresAt !== ex.expiresAt || rec.payTo !== requirements.payTo) {
      return fail(ERR.unknownInstrument, "the requirements are not the ones issued for this address", txid);
    }

    // 11 (early, as the transparent method does): a claimed txid is on its way; the input checks no longer describe it.
    if (await this.config.store.isClaimed(key)) return fail(ERR.duplicateSettlement, `${txid} is already claimed`, txid);

    // 5. Recipient: exactly one output decrypts under the merchant's key, to payTo, as a ZIP 212 note.
    const notes: DecryptedNote[] = [];
    for (const o of tx.shieldedOutputs) {
      const n = trialDecryptOutput(o, this.key.ivk, network);
      if (n) notes.push(n);
    }
    if (notes.length === 0) return fail(ERR_SAPLING.output, "no output decrypts under the merchant's viewing key", txid);
    if (notes.length > 1) return fail(ERR_SAPLING.output, `${notes.length} outputs decrypt under the merchant's viewing key, one is required`, txid);
    const note = notes[0] as DecryptedNote;
    if (note.address !== requirements.payTo) return fail(ERR_SAPLING.output, `the output pays ${note.address}, not payTo`, txid);
    if (note.leadByte !== LEAD_BYTE_ZIP212) return fail(ERR_SAPLING.output, "the note is not a ZIP 212 note (lead byte 0x02); the merchant wallet would not accept it", txid);

    // 6. Amount.
    if (note.value < BigInt(requirements.amount)) return fail(ERR.underpaid, `the output carries ${note.value} zatoshis, ${requirements.amount} required`, txid);

    // 7. Memo.
    if (!noteMemoEquals({ memo: Buffer.from(memoBytes(note.memo)).toString("hex") }, ex.memo as string)) return fail(ERR.memoMismatch, "the note's memo is not extra.memo", txid);

    // 9. Transparent inputs, if any: SIGHASH_ALL, confirmed, unspent, not spent in the mempool.
    const values: bigint[] = [];
    for (const [i, input] of tx.vin.entries()) {
      const problem = checkSighashAll(input.scriptSig);
      if (problem) return fail(ERR_SAPLING.sighash, `input ${i}: ${problem}`, txid);
      const { txid: prev, vout } = input.prevout;
      const confirmed = await this.config.rpc.getTxOut(prev, vout, false);
      if (!confirmed) return fail(ERR_SAPLING.inputSpent, `input ${i} (${prev}:${vout}) is unknown, unconfirmed or spent`, txid);
      if (!(await this.config.rpc.getTxOut(prev, vout, true))) return fail(ERR_SAPLING.inputSpent, `input ${i} (${prev}:${vout}) is spent by a mempool transaction`, txid);
      values.push(yecToZat(confirmed.value));
    }

    // 8. Fee: valueBalance plus transparent inputs minus outputs, within [floor, cap].
    const feeZat = txFee(tx, values);
    const floor = feeFloor(tx);
    if (feeZat < floor) return fail(ERR_SAPLING.feeTooLow, `fee ${feeZat} is below the floor ${floor}`, txid);
    if (feeZat > this.limits.feeCapZat) return fail(ERR_SAPLING.feeTooHigh, `fee ${feeZat} is above the cap ${this.limits.feeCapZat}`, txid);

    // 10. Expiry window, against the node's tip.
    const tip = await this.config.rpc.getBlockCount();
    const w = expiryWindow(tip, requirements.maxTimeoutSeconds);
    const e = tx.expiryHeight;
    if (e === 0 || e < w.min || e > w.max) return fail(ERR_SAPLING.expiry, `nExpiryHeight ${e} is outside [${w.min}, ${w.max}]`, txid);

    // 9, the node's half: the script verifier on the transparent inputs. It does not check Sapling
    // proofs or signatures (ycash-dd rawtransaction.cpp:1069-1079); relay does, at settle.
    if (tx.vin.length > 0) {
      const scripts = await this.config.rpc.verifyScripts(hex);
      if (!scripts.complete || scripts.errors.length > 0) {
        return fail(ERR_SAPLING.script, scripts.errors.map((x) => `${x.txid}:${x.vout} ${x.error}`).join("; ") || "incomplete", txid);
      }
    }

    // 11. Not claimed (re-read: the claim may have landed while the lookups ran).
    if (await this.config.store.isClaimed(key)) return fail(ERR.duplicateSettlement, `${txid} is already claimed`, txid);
    return { ok: true, value: { network, hex, tx, txid, key, issued, note, feeZat } };
  }

  /**
   * Settle step 3: `sendrawtransaction`. A rejection is terminal; -27, a mempool duplicate and a
   * transport failure mean the transaction is on its way (X-F6).
   *
   * @param v - The verified payment.
   * @returns A terminal rejection, or null to observe.
   */
  private async submit(v: SaplingVerified): Promise<{ reason: SaplingErrorReason; message: string } | null> {
    try {
      const sent = await this.config.rpc.sendRawTransaction(v.hex);
      if (sent !== v.txid) throw new Error(`node returned txid ${sent}, expected ${v.txid}`);
      return null;
    } catch (e) {
      if (!(e instanceof SendRawTransactionError)) {
        if (e instanceof RpcError && e.transport) return null; // unknown outcome: keep the claim, observe
        throw e;
      }
      if (e.kind === "already-in-chain") return null;
      // Someone else may have relayed the same payload first: the merchant wallet's note proves it.
      if ((await this.notesOf(v.txid, v.issued.record.payTo)).length > 0) return null;
      const reason =
        e.kind === "mempool-conflict" || e.kind === "missing-inputs" ? ERR_SAPLING.inputSpent : e.kind === "expiring-soon" ? ERR_SAPLING.expiry : ERR_SAPLING.rejected;
      return { reason, message: `sendrawtransaction ${e.code}: ${e.message}` };
    }
  }

  /**
   * Resumes observing a txid this facilitator already claimed (a retry after `settlement_pending`).
   *
   * @param txid - The claimed txid.
   * @param tx - The parsed transaction.
   * @param requirements - The issued requirements.
   * @returns The observation's outcome.
   */
  private async observeClaimed(txid: string, tx: Tx, requirements: PaymentRequirements): Promise<SettleResponse> {
    const issued = await this.config.registry.get(requirements.payTo);
    if (!issued) return { success: false, errorReason: ERR.unknownInstrument, errorMessage: `${requirements.payTo} is no longer held`, transaction: txid, network: requirements.network };
    return this.observe(txid, tx, issued, requirements);
  }

  /**
   * The merchant wallet's notes of `txid` at `payTo`, mempool included. A viewing-key wallet
   * refuses an address it has seen no note at with -5 (X-F78), which here means no note yet.
   *
   * @param txid - The transaction.
   * @param payTo - The issued address.
   * @returns The notes, none when the wallet has not seen the transaction.
   */
  private async notesOf(txid: string, payTo: string): Promise<ZReceived[]> {
    try {
      return (await this.config.rpc.zListReceivedByAddress(payTo, 0)).filter((n) => n.txid === txid);
    } catch (e) {
      if (e instanceof RpcError && !e.transport && e.code === RPC_INVALID_ADDRESS_OR_KEY) return [];
      return []; // a transient node error is not evidence of absence
    }
  }

  /**
   * Settle steps 4 and 5: poll the merchant wallet for the note until the policy depth or the wait
   * ends; past nExpiryHeight with no note, the transaction can never land.
   *
   * @param txid - The broadcast transaction.
   * @param tx - The parsed transaction.
   * @param issued - The request record.
   * @param requirements - The issued requirements.
   * @returns Success with a receipt, `settlement_pending`, or an expiry failure.
   */
  private async observe(txid: string, tx: Tx, issued: IssuedRequest, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    const pollMs = this.config.observePollMs ?? 500;
    const deadline = Date.now() + Math.min(this.config.observeWaitMs ?? 10_000, requirements.maxTimeoutSeconds * 1000);
    let observed: number | null = null;
    let receivedZat = 0n;
    for (;;) {
      const notes = await this.notesOf(txid, requirements.payTo);
      if (notes.length > 0) {
        const minConf = Math.min(...notes.map((n) => n.confirmations ?? 0));
        observed = minConf <= 0 ? -1 : minConf;
        receivedZat = notes.reduce((s, n) => s + (n.amountZat !== undefined ? BigInt(n.amountZat) : yecToZat(n.amount)), 0n);
        if (meetsPolicy(observed, issued.confirmations)) break;
      }
      if (Date.now() + pollMs >= deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (observed !== null && meetsPolicy(observed, issued.confirmations)) {
      try {
        const receipt = await signReceipt({ network, resourceUrl: issued.record.resource, transaction: txid, issuedAt: this.now() }, this.config.receiptSigner);
        return {
          success: true,
          transaction: txid,
          network,
          extra: { status: observed < 0 ? "mempool" : "confirmed", confirmations: observed, receivedZat: receivedZat.toString() },
          extensions: receiptExtension(receipt),
        };
      } catch (e) {
        // The transaction is on its way and the claim stands: the retry resumes here.
        return { success: false, errorReason: ERR.settlementPending, errorMessage: `receipt signing failed: ${String(e)}`, transaction: txid, network, extra: { status: "pending", confirmations: observed } };
      }
    }
    if ((observed === null || observed < 0) && (await this.config.rpc.getBlockCount()) > tx.expiryHeight) {
      return { success: false, errorReason: ERR_SAPLING.expiry, errorMessage: `the chain passed nExpiryHeight ${tx.expiryHeight} without the transaction`, transaction: txid, network };
    }
    return {
      success: false,
      errorReason: ERR.settlementPending,
      errorMessage: `awaiting ${Math.max(issued.confirmations, 1)} confirmation(s)`,
      transaction: txid,
      network,
      extra: { status: "pending", confirmations: observed ?? null },
    };
  }
}
