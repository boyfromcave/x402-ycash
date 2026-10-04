// The resource server's side of a channel (specs/scheme_batch_settlement_ycash.md, "Verification",
// "Close triggers", "Settlement"). The server holds S, verifies every voucher before the handler,
// charges the actual price after it, and closes by completing its highest voucher. Framework-free:
// the x402 scheme (scheme.ts) and the watcher drive it.
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { channelFromScript, channelIdOf, commitmentIdOf, parseChannelId, type Channel } from "../../channel/channel.js";
import type { VoucherLayout } from "../../channel/outputs.js";
import { completeVoucher } from "../../channel/voucher.js";
import { ASSET_YED } from "../../constants.js";
import { SendRawTransactionError } from "../../node/errors.js";
import { InMemoryChannelStore, type ChannelStore } from "../../store/channelStore.js";
import { addressToScript } from "../../tx/address.js";
import { bytesToHex, hexToBytes } from "../../tx/bytes.js";
import { pubkeyFromPriv } from "../../tx/keys.js";
import { parseTx, txid as txidOf } from "../../tx/tx.js";
import { BatchError, BatchSettlementError } from "../errors.js";
import { isBatchPayload, parseTerms, requiredDepth, sameOffer, type BatchChannelState, type BatchClientPayload, type BatchTerms } from "../types.js";
import {
  chainContext,
  checkCompleted,
  checkVoucher,
  checkYedVoucher,
  closeCumulative,
  cumulativeFloor,
  decodeTx,
  isExhausted,
  layoutFor,
  verifyOpen,
  yedChain,
  type ChainView,
} from "../verify.js";
import { ChannelWatcher, type WatchedChannel } from "../watcher.js";
import { CHANNEL_OPEN, ChannelLedger, type ChannelTerms, type LedgerChannel } from "./ledger.js";

export type CloseReason = "idle" | "margin" | "exhausted" | "client" | "demand";

export interface ChannelManagerConfig {
  /** the server's node (any line, stock is enough for YEC) */
  chain: ChainView;
  /** S's private key */
  serverPrivKey: Uint8Array;
  store?: ChannelStore;
  /** Close a channel after this long without a request (default 10 minutes). */
  idleMs?: number;
  /** How long an `open` waits for the funding depth before answering funding_depth (default 0). */
  fundingWaitMs?: number;
  /** Poll interval while waiting for the funding depth (default 500 ms). */
  fundingPollMs?: number;
  /** A held in-flight lock expires after this long (default 60 s), for a crashed handler. */
  inflightTtlMs?: number;
  /** Notified after each broadcast close. */
  onClose?: (event: { channelId: string; reason: CloseReason; txid: string | undefined; cumulative: bigint }) => void;
  log?: (msg: string) => void;
}

/** A voucher that passed verification and holds its channel's in-flight lock until settle or release. */
export interface VerifiedVoucher {
  kind: BatchClientPayload["type"];
  channelId: string;
  cumulative: bigint;
  /** the per-request ceiling (`amount`) */
  ceiling: bigint;
  token: bigint;
  network: PaymentRequirements["network"];
  fundingTxid: string;
  /** the completed close (kind "close") */
  completedHex?: string;
}

export class ChannelManager {
  readonly ledger: ChannelLedger;
  readonly serverPubKey: Uint8Array;
  private readonly chain: ChainView;
  private readonly serverPrivKey: Uint8Array;
  private readonly idleMs: number;
  private readonly fundingWaitMs: number;
  private readonly fundingPollMs: number;
  private readonly lastActivity = new Map<string, number>();
  private readonly cfg: ChannelManagerConfig;

  constructor(cfg: ChannelManagerConfig) {
    this.cfg = cfg;
    this.chain = cfg.chain;
    this.serverPrivKey = cfg.serverPrivKey;
    this.serverPubKey = pubkeyFromPriv(cfg.serverPrivKey);
    this.ledger = new ChannelLedger(cfg.store ?? new InMemoryChannelStore(), cfg.inflightTtlMs);
    this.idleMs = cfg.idleMs ?? 600_000;
    this.fundingWaitMs = cfg.fundingWaitMs ?? 0;
    this.fundingPollMs = cfg.fundingPollMs ?? 500;
  }

  /** The voucher outputs of a channel of `asset` holding D (YEC, or YED with the dollar floor). */
  protected layoutFor(asset: string, deposit: bigint): VoucherLayout {
    return layoutFor(asset, deposit);
  }

  /** Channels this process opened or was told to watch. */
  tracked(): string[] {
    return [...this.lastActivity.keys()];
  }

  /** Watch a channel recorded by another process (after a restart). */
  track(channelId: string, now = Date.now()): void {
    if (!this.lastActivity.has(channelId)) this.lastActivity.set(channelId, now);
  }

  // ------------------------------------------------------------------ verify

  /** Every rule before the handler. On success the channel's in-flight lock is held. */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifiedVoucher> {
    if (payload.x402Version !== 2 || !sameOffer(payload.accepted, requirements)) {
      throw new BatchSettlementError(BatchError.REQUIREMENTS, "accepted does not match the requirements");
    }
    const p = payload.payload;
    if (!isBatchPayload(p) || p.type === "claim") throw new BatchSettlementError(BatchError.PAYLOAD_TYPE, String((p as { type?: unknown }).type));
    const terms = parseTerms(requirements);
    if (terms.asset === ASSET_YED) yedChain(this.chain); // vouchers are checked by the overlay
    const ctx = await chainContext(this.chain, terms.network);
    switch (p.type) {
      case "open": {
        const known = await this.ledger.get(channelIdOf({ txid: txidOf(decodeTx(p.fundingTx, BatchError.FUNDING)), vout: p.vout }));
        let channelId: string;
        if (known) {
          channelId = known.terms.channelId; // a retried open: its voucher is checked as a voucher
        } else {
          const v = await verifyOpen(p, terms, this.chain, ctx);
          channelId = v.channelId;
          if (!v.alreadyBroadcast) await this.relayFunding(p.fundingTx, v.fundingTxid, p.vout);
          await this.ledger.open(this.termsOf(v.channel, channelId, p.fundingTx, terms, v.deposit));
          this.log(`open ${channelId} V=${v.channel.value} D=${v.deposit} t=${v.channel.refundHeight}`);
        }
        this.track(channelId);
        await this.waitForDepth(channelId);
        return this.verifyVoucher("open", channelId, p.voucher.tx, BigInt(p.voucher.cumulative), terms, ctx);
      }
      case "voucher":
        return this.verifyVoucher("voucher", p.channelId, p.tx, BigInt(p.cumulative), terms, ctx);
      case "close":
        return this.verifyVoucher("close", p.channelId, p.tx, BigInt(p.cumulative), terms, ctx);
    }
  }

  private async verifyVoucher(
    kind: VerifiedVoucher["kind"],
    channelId: string,
    txHex: string,
    cumulative: bigint,
    terms: BatchTerms,
    ctx: { tip: number; branchId: number },
  ): Promise<VerifiedVoucher> {
    // 1. known and open
    if (!parseChannelId(channelId)) throw new BatchSettlementError(BatchError.UNKNOWN_CHANNEL, channelId);
    const before = await this.ledger.get(channelId);
    if (!before) throw new BatchSettlementError(BatchError.UNKNOWN_CHANNEL, channelId);
    if (before.state !== CHANNEL_OPEN) throw new BatchSettlementError(BatchError.CHANNEL_CLOSING, "the channel is closing or closed");
    this.checkSameTerms(before, terms);
    const channel = this.channelOf(before.terms);
    // 2. margin: refuse and close (a client close is still welcome until t)
    const marginHeight = before.terms.refundHeight - before.terms.closeMarginBlocks;
    if (kind !== "close" && ctx.tip >= marginHeight) {
      await this.close(channelId, "margin").catch((e: unknown) => this.log(`margin close of ${channelId} failed: ${String(e)}`));
      throw new BatchSettlementError(BatchError.CHANNEL_CLOSING, `tip ${ctx.tip} ≥ t − margin = ${marginHeight}`);
    }
    const token = await this.ledger.acquire(channelId);
    if (token === null) throw new BatchSettlementError(BatchError.CHANNEL_BUSY, "another voucher of this channel is in flight");
    try {
      // Read the state again under the lock: a settle may have landed since.
      const ch = (await this.ledger.get(channelId)) as LedgerChannel;
      if (ch.state !== CHANNEL_OPEN) throw new BatchSettlementError(BatchError.CHANNEL_CLOSING, "the channel is closing or closed");
      // 3. unspent, and at the funding policy depth
      const out = await this.chain.getTxOut(channel.outpoint.txid, channel.outpoint.vout, true);
      if (!out) throw new BatchSettlementError(BatchError.CHANNEL_CLOSING, "the channel output is spent");
      if (out.confirmations < requiredDepth(ch.terms.confirmations)) {
        throw new BatchSettlementError(BatchError.FUNDING_DEPTH, `funding ${channel.outpoint.txid} has ${out.confirmations} confirmations`);
      }
      const tx = decodeTx(txHex, BatchError.VOUCHER_SHAPE);
      const deposit = BigInt(ch.terms.deposit);
      const asset = ch.terms.asset;
      const bounds = { deposit, branchId: ctx.branchId, layout: this.layoutFor(asset, deposit), floor: cumulativeFloor(asset) };
      if (kind === "close") {
        // At the charged total, or the pre-paid $1.00 for YED (the dollar floor).
        const want = closeCumulative(asset, ch.chargedCumulative);
        if (cumulative !== want) throw new BatchSettlementError(BatchError.CUMULATIVE_MISMATCH, `a close must be at ${want}`);
        checkVoucher(tx, channel, cumulative, { ...bounds, charged: ch.chargedCumulative, amount: 0n });
      } else {
        // 8 (early): a voucher below the stored one is stale whatever else it is
        if (cumulative < ch.signedCumulative) throw new BatchSettlementError(BatchError.STALE_VOUCHER, `${cumulative} < stored ${ch.signedCumulative}`);
        // 4–6
        checkVoucher(tx, channel, cumulative, { ...bounds, charged: ch.chargedCumulative, amount: terms.amount });
      }
      // 7. completed with sigS, the node's script verifier accepts it
      const completedHex = await checkCompleted(this.chain, completeVoucher(tx, channel, this.serverPrivKey, ctx.branchId));
      // YED: the overlay registers the completed voucher's split and burns nothing (yedIn = D)
      if (asset === ASSET_YED) await checkYedVoucher(this.chain, completedHex, deposit, cumulative);
      // 8. compare-and-set store (a close is broadcast at settle, never stored)
      if (kind !== "close" && (await this.ledger.storeVoucher(channelId, cumulative, txHex)) === "stale") {
        throw new BatchSettlementError(BatchError.STALE_VOUCHER, "a higher voucher was stored concurrently");
      }
      this.lastActivity.set(channelId, Date.now());
      return {
        kind, channelId, cumulative, ceiling: terms.amount, token, network: terms.network, fundingTxid: channel.outpoint.txid,
        ...(kind === "close" ? { completedHex } : {}),
      };
    } catch (e) {
      await this.ledger.release(channelId, token);
      throw e;
    }
  }

  // ------------------------------------------------------------------ settle

  /**
   * After the handler: charges the actual price (≤ the ceiling) and releases the lock; a client
   * `close` is broadcast instead. Closes the channel when the next request would not fit.
   */
  async settle(v: VerifiedVoucher, actualCharge: bigint): Promise<SettleResponse> {
    if (v.kind === "close") return this.settleClientClose(v);
    let charged: bigint;
    try {
      if (actualCharge < 0n || actualCharge > v.ceiling) {
        throw new BatchSettlementError(BatchError.CUMULATIVE_MISMATCH, `charge ${actualCharge} is above the ceiling ${v.ceiling}`);
      }
      charged = await this.ledger.addCharge(v.channelId, actualCharge);
    } finally {
      await this.ledger.release(v.channelId, v.token);
    }
    this.lastActivity.set(v.channelId, Date.now());
    const state = await this.channelState(v.channelId);
    const response: SettleResponse = {
      success: true,
      transaction: v.kind === "open" ? v.fundingTxid : "",
      network: v.network,
      payer: v.channelId,
      amount: "",
      extra: { commitmentId: commitmentIdOf(v.channelId, v.cumulative), chargedAmount: actualCharge.toString(), channelState: state },
    };
    // exhausted: the deposit is fully signed, or the next voucher at the ceiling would exceed it
    // (YED: or leave the client less than $1.00)
    const asset = (await this.ledger.get(v.channelId))?.terms.asset ?? "";
    if (isExhausted(asset, BigInt(state.deposit), charged, v.ceiling, v.cumulative)) {
      await this.close(v.channelId, "exhausted").catch((e: unknown) => this.log(`exhausted close of ${v.channelId} failed: ${String(e)}`));
    }
    return response;
  }

  /** A verified request that will not be settled (the handler failed): charged is unchanged. */
  async release(v: VerifiedVoucher): Promise<void> {
    await this.ledger.release(v.channelId, v.token);
  }

  private async settleClientClose(v: VerifiedVoucher): Promise<SettleResponse> {
    try {
      if (!(await this.ledger.claimClose(v.channelId))) throw new BatchSettlementError(BatchError.CHANNEL_CLOSING, "already closing");
      const txid = await this.broadcastClose(v.channelId, v.completedHex as string);
      this.cfg.onClose?.({ channelId: v.channelId, reason: "client", txid, cumulative: v.cumulative });
      return {
        success: true, transaction: txid ?? "", network: v.network, payer: v.channelId, amount: "",
        extra: { commitmentId: commitmentIdOf(v.channelId, v.cumulative), chargedAmount: "0", channelState: await this.channelState(v.channelId) },
      };
    } finally {
      await this.ledger.release(v.channelId, v.token);
    }
  }

  // ------------------------------------------------------------------ close

  /**
   * Completes the highest stored voucher with sigS and broadcasts it. Idempotent: a channel
   * already closing or closed returns its close txid (undefined while another close is running,
   * or when the channel was spent by something else, such as the client's refund).
   */
  async close(channelId: string, reason: CloseReason = "demand"): Promise<string | undefined> {
    if (!(await this.ledger.claimClose(channelId))) return (await this.ledger.get(channelId))?.closeTxid;
    const ch = await this.ledger.get(channelId);
    if (!ch) throw new BatchSettlementError(BatchError.UNKNOWN_CHANNEL, channelId);
    if (!ch.voucherTx) {
      await this.ledger.markClosed(channelId, undefined);
      return undefined;
    }
    const channel = this.channelOf(ch.terms);
    let hex: string;
    try {
      const { branchId } = await chainContext(this.chain, ch.terms.network as BatchTerms["network"]);
      hex = await checkCompleted(this.chain, completeVoucher(parseTx(ch.voucherTx), channel, this.serverPrivKey, branchId));
    } catch (e) {
      if (!(await this.chain.getTxOut(channel.outpoint.txid, channel.outpoint.vout, true))) {
        await this.ledger.markClosed(channelId, undefined); // spent by a refund or an earlier close
        return undefined;
      }
      await this.ledger.reopen(channelId);
      throw e;
    }
    const txid = await this.broadcastClose(channelId, hex);
    this.log(`close ${channelId} (${reason}) at ${ch.signedCumulative}: ${txid ?? "channel already spent"}`);
    this.cfg.onClose?.({ channelId, reason, txid, cumulative: ch.signedCumulative });
    return txid;
  }

  private async broadcastClose(channelId: string, hex: string): Promise<string | undefined> {
    const txid = txidOf(hexToBytes(hex));
    try {
      await this.chain.sendRawTransaction(hex);
    } catch (e) {
      if (!(e instanceof SendRawTransactionError) || e.kind !== "already-in-chain") {
        const ch = (await this.ledger.get(channelId)) as LedgerChannel;
        if (!(await this.chain.getTxOut(ch.terms.fundingTxid, ch.terms.vout, true))) {
          // Spent already: by this very close (resubmission) or by the client's refund.
          const ours = await this.chain.getTxOut(txid, 0, true);
          await this.ledger.markClosed(channelId, ours ? txid : undefined);
          return ours ? txid : undefined;
        }
        await this.ledger.reopen(channelId);
        throw e;
      }
    }
    await this.ledger.markClosed(channelId, txid);
    return txid;
  }

  /**
   * Runs the close triggers for every tracked open channel: margin (tip ≥ t − margin) and idle.
   * Returns the channels it closed.
   */
  async sweep(tip?: number, now = Date.now()): Promise<{ channelId: string; reason: CloseReason; txid: string | undefined }[]> {
    const height = tip ?? (await this.chain.getBlockCount());
    const closed: { channelId: string; reason: CloseReason; txid: string | undefined }[] = [];
    for (const id of this.tracked()) {
      const ch = await this.ledger.get(id);
      if (!ch || ch.state !== CHANNEL_OPEN) {
        this.lastActivity.delete(id);
        continue;
      }
      let reason: CloseReason | null = null;
      if (height >= ch.terms.refundHeight - ch.terms.closeMarginBlocks) reason = "margin";
      else if (now - (this.lastActivity.get(id) ?? now) >= this.idleMs) reason = "idle";
      if (reason) closed.push({ channelId: id, reason, txid: await this.close(id, reason) });
    }
    return closed;
  }

  /** The server's watcher: closes at t − margin, and sweeps idle channels each tick. */
  watcher(opts: { pollMs?: number; warn?: (msg: string) => void } = {}): ChannelWatcher {
    return new ChannelWatcher({
      ...opts,
      tip: () => this.chain.getBlockCount(),
      channels: async () => {
        const open: WatchedChannel[] = [];
        for (const id of this.tracked()) {
          const ch = await this.ledger.get(id);
          if (ch?.state === CHANNEL_OPEN) open.push({ channelId: id, refundHeight: ch.terms.refundHeight, closeMarginBlocks: ch.terms.closeMarginBlocks });
        }
        return open;
      },
      onMargin: async (ch) => {
        await this.close(ch.channelId, "margin");
      },
      onTick: async (tip) => {
        await this.sweep(tip);
      },
    });
  }

  async channelState(channelId: string): Promise<BatchChannelState> {
    const ch = await this.ledger.get(channelId);
    if (!ch) throw new BatchSettlementError(BatchError.UNKNOWN_CHANNEL, channelId);
    return {
      channelId,
      deposit: ch.terms.deposit,
      chargedCumulative: ch.chargedCumulative.toString(),
      signedCumulative: ch.signedCumulative.toString(),
      refundHeight: ch.terms.refundHeight,
      closeMarginBlocks: ch.terms.closeMarginBlocks,
    };
  }

  // ------------------------------------------------------------------ helpers

  private async relayFunding(hex: string, txid: string, vout: number): Promise<void> {
    try {
      await this.chain.sendRawTransaction(hex);
    } catch (e) {
      if (e instanceof SendRawTransactionError && e.kind === "already-in-chain") return;
      if (await this.chain.getTxOut(txid, vout, true)) return;
      throw new BatchSettlementError(BatchError.FUNDING, `relay failed: ${(e as Error).message}`);
    }
  }

  private async waitForDepth(channelId: string): Promise<void> {
    const ch = (await this.ledger.get(channelId)) as LedgerChannel;
    const want = requiredDepth(ch.terms.confirmations);
    const deadline = Date.now() + this.fundingWaitMs;
    for (;;) {
      const out = await this.chain.getTxOut(ch.terms.fundingTxid, ch.terms.vout, true);
      if (out && out.confirmations >= want) return;
      if (Date.now() >= deadline) {
        throw new BatchSettlementError(BatchError.FUNDING_DEPTH, `funding ${ch.terms.fundingTxid} has ${out?.confirmations ?? "no"} confirmations, ${want} required`);
      }
      await new Promise((r) => setTimeout(r, this.fundingPollMs));
    }
  }

  private termsOf(ch: Channel, channelId: string, fundingTx: string, t: BatchTerms, deposit: bigint): ChannelTerms {
    return {
      channelId,
      network: t.network,
      asset: t.asset,
      fundingTxid: ch.outpoint.txid,
      vout: ch.outpoint.vout,
      fundingTx,
      redeemScript: bytesToHex(ch.redeemScript),
      value: ch.value.toString(),
      closeFee: ch.closeFee.toString(),
      deposit: deposit.toString(),
      payTo: t.payTo,
      refundHeight: ch.refundHeight,
      closeMarginBlocks: t.closeMarginBlocks,
      confirmations: t.confirmations,
      amount: t.amount.toString(),
    };
  }

  private channelOf(t: ChannelTerms): Channel {
    return channelFromScript({
      outpoint: { txid: t.fundingTxid, vout: t.vout },
      redeemScript: hexToBytes(t.redeemScript),
      value: BigInt(t.value),
      closeFee: BigInt(t.closeFee),
      payToScript: addressToScript(t.payTo, t.network as BatchTerms["network"]),
    });
  }

  /** A voucher is checked under the terms the channel was opened with. */
  private checkSameTerms(ch: LedgerChannel, t: BatchTerms): void {
    if (ch.terms.network !== t.network || ch.terms.asset !== t.asset || ch.terms.payTo !== t.payTo || BigInt(ch.terms.closeFee) !== t.closeFee) {
      throw new BatchSettlementError(BatchError.REQUIREMENTS, "the requirements differ from the channel's terms");
    }
  }

  private log(msg: string): void {
    this.cfg.log?.(`[batch-settlement] ${msg}`);
  }
}
