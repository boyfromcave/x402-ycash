// A facilitator for `batch-settlement` on Ycash, on @x402/core's SchemeNetworkFacilitator. It holds
// no channel state and no server key: it verifies what is checkable from the chain (the open rules,
// a voucher's shape and client signature against the live channel output), relays the funding
// transaction, and broadcasts closes the server completed (`claim`). The charged total, the stored
// voucher and the in-flight lock stay with the server (specs/scheme_batch_settlement_ycash.md,
// "Settlement"). A YED channel needs a Yellowback node: D is the channel's token record as the
// overlay reports it, and every voucher must burn nothing.
import type { Network, PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse, VerifyResponse } from "@x402/core/types";
import { channelFromScript, channelIdOf, commitmentIdOf, type Channel } from "../../channel/channel.js";
import { channelScriptPubKey, parseChannelScript } from "../../channel/script.js";
import { parseCloseScriptSig } from "../../channel/voucher.js";
import { ASSET_YED } from "../../constants.js";
import { SendRawTransactionError } from "../../node/errors.js";
import { InMemoryChannelStore, type ChannelStore } from "../../store/channelStore.js";
import { RETAIN_FOREVER, txidKey, type SettlementStore } from "../../store/settlementStore.js";
import { addressToScript } from "../../tx/address.js";
import { bytesToHex, equalBytes, hexToBytes } from "../../tx/bytes.js";
import { txid as txidOf, type Tx } from "../../tx/tx.js";
import { BatchError, BatchSettlementError, reasonOf } from "../errors.js";
import { BATCH_SETTLEMENT_SCHEME, isBatchPayload, parseTerms, requiredDepth, sameOffer, type BatchPayload, type BatchTerms } from "../types.js";
import {
  chainContext,
  checkCompleted,
  checkVoucher,
  checkYedVoucher,
  cumulativeFloor,
  decodeTx,
  layoutFor,
  overlayDeposit,
  verifyOpen,
  yedChain,
  zatOf,
  type ChainView,
} from "../verify.js";

export interface BatchYcashFacilitatorConfig {
  /** the facilitator's node (YcashRpc) */
  rpc: ChainView;
  /** Deduplicates relays of a close by its txid (plan X-F6); optional for a single process. */
  settlementStore?: SettlementStore;
  /**
   * Records the channels this facilitator relayed (open) and the cumulative of the close it
   * relayed (claim), for audit across processes. The facilitator decides nothing from it: the
   * charged total and the voucher watermark are the server's. Default: in memory.
   */
  channelStore?: ChannelStore;
  /** The funding depths this facilitator settles (`/supported`); default −1..20. */
  confirmations?: { minimum: number; maximum: number };
  /** How long settle waits for the funding depth before answering settlement_pending (default 0). */
  fundingWaitMs?: number;
  fundingPollMs?: number;
}

export class BatchYcashScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "ycash:*";

  private readonly chain: ChainView;
  private readonly channels: ChannelStore;
  private readonly limits: { minimum: number; maximum: number };

  constructor(private readonly cfg: BatchYcashFacilitatorConfig) {
    this.chain = cfg.rpc;
    this.channels = cfg.channelStore ?? new InMemoryChannelStore();
    this.limits = cfg.confirmations ?? { minimum: -1, maximum: 20 };
  }

  /** The funding depths it settles, as the `exact` facilitator advertises its range. */
  getExtra(_network: Network): Record<string, unknown> | undefined {
    return { confirmations: { ...this.limits } };
  }

  /** No sponsorship: the facilitator signs nothing. */
  getSigners(_network: string): string[] {
    return [];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const { p, terms } = this.envelope(payload, requirements);
      const ctx = await chainContext(this.chain, terms.network);
      if (p.type === "open") {
        const v = await verifyOpen(p, terms, this.chain, ctx);
        return { isValid: true, payer: v.channelId, extra: { channelId: v.channelId } };
      }
      const { channel, tx } = await this.liveChannel(p.tx, p.channelId, terms);
      const yed = terms.asset === ASSET_YED;
      // YED: D is the channel output's token record, read through the voucher's yedIn.
      const deposit = yed ? await overlayDeposit(this.chain, p.tx) : channel.value - channel.closeFee;
      const cumulative = BigInt(p.cumulative);
      checkVoucher(tx, channel, cumulative, {
        charged: 0n, // the server's charged total is not known here; it applies rule 5 in full
        amount: p.type === "voucher" ? terms.amount : 0n,
        deposit,
        branchId: ctx.branchId,
        allowCompleted: p.type === "claim",
        layout: layoutFor(terms.asset, deposit),
        floor: cumulativeFloor(terms.asset),
      });
      if (p.type === "claim") await checkCompleted(this.chain, tx);
      // A voucher's server slot is empty, so only a claim's scripts can verify.
      if (yed) await checkYedVoucher(this.chain, p.tx, deposit, cumulative, { scripts: p.type === "claim" });
      return { isValid: true, payer: p.channelId, extra: { channelId: p.channelId } };
    } catch (e) {
      return { isValid: false, invalidReason: reasonOf(e), invalidMessage: (e as Error).message };
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    const fail = (e: unknown, transaction = ""): SettleResponse => ({ success: false, errorReason: reasonOf(e), errorMessage: (e as Error).message, transaction, network });
    const check = await this.verify(payload, requirements);
    if (!check.isValid) return { success: false, errorReason: check.invalidReason ?? BatchError.PAYLOAD, errorMessage: check.invalidMessage ?? "", transaction: "", network };
    const p = payload.payload as unknown as BatchPayload; // validated by verify
    const commitmentId = (channelId: string) => commitmentIdOf(channelId, BigInt(p.type === "open" ? p.voucher.cumulative : p.cumulative));
    try {
      switch (p.type) {
        case "open": {
          const tx = decodeTx(p.fundingTx, BatchError.FUNDING);
          const fundingTxid = txidOf(tx);
          const channelId = channelIdOf({ txid: fundingTxid, vout: p.vout });
          await this.relay(p.fundingTx);
          const terms = parseTerms(requirements);
          if (!(await this.waitForDepth(fundingTxid, p.vout, requiredDepth(terms.confirmations)))) {
            return { ...fail(new BatchSettlementError(BatchError.SETTLEMENT_PENDING, "funding below the policy depth"), fundingTxid), payer: channelId };
          }
          await this.channels.open({ channelId, cumulative: 0n, data: { fundingTxid, vout: p.vout } });
          return { success: true, transaction: fundingTxid, network, payer: channelId, amount: "", extra: { commitmentId: commitmentId(channelId) } };
        }
        case "voucher":
          return { success: true, transaction: "", network, payer: p.channelId, amount: "", extra: { commitmentId: commitmentId(p.channelId) } };
        case "claim": {
          const closeTxid = txidOf(hexToBytes(p.tx));
          const store = this.cfg.settlementStore;
          if (store && !(await store.claim(txidKey(requirements.network as BatchTerms["network"], closeTxid), RETAIN_FOREVER))) {
            throw new BatchSettlementError("duplicate_settlement", closeTxid);
          }
          await this.relay(p.tx);
          await this.recordClaim(p.channelId, BigInt(p.cumulative));
          return { success: true, transaction: closeTxid, network, payer: p.channelId, amount: "", extra: { commitmentId: commitmentId(p.channelId) } };
        }
        case "close":
          // Completing a client close needs S, which only the server holds.
          throw new BatchSettlementError(BatchError.PAYLOAD_TYPE, "the server completes a client close and sends it as a claim");
      }
    } catch (e) {
      return fail(e);
    }
  }

  private envelope(payload: PaymentPayload, requirements: PaymentRequirements): { p: BatchPayload; terms: BatchTerms } {
    if (payload.x402Version !== 2 || !sameOffer(payload.accepted, requirements)) {
      throw new BatchSettlementError(BatchError.REQUIREMENTS, "accepted does not match the requirements");
    }
    if (!isBatchPayload(payload.payload)) throw new BatchSettlementError(BatchError.PAYLOAD, "not a batch-settlement payload");
    const terms = parseTerms(requirements);
    if (terms.confirmations < this.limits.minimum || terms.confirmations > this.limits.maximum) {
      throw new BatchSettlementError(BatchError.REQUIREMENTS, `confirmations ${terms.confirmations} outside [${this.limits.minimum}, ${this.limits.maximum}]`);
    }
    if (terms.asset === ASSET_YED) yedChain(this.chain);
    return { p: payload.payload, terms };
  }

  /** The channel a voucher spends, rebuilt from its scriptSig's redeem script and the live output. */
  private async liveChannel(txHex: string, channelId: string, terms: BatchTerms): Promise<{ channel: Channel; tx: Tx }> {
    const tx = decodeTx(txHex, BatchError.VOUCHER_SHAPE);
    const input = tx.vin[0];
    const ss = input ? parseCloseScriptSig(input.scriptSig) : null;
    if (tx.vin.length !== 1 || !input || !ss) throw new BatchSettlementError(BatchError.VOUCHER_SHAPE, "inputs");
    if (channelIdOf(input.prevout) !== channelId) throw new BatchSettlementError(BatchError.VOUCHER_SHAPE, "the voucher does not spend channelId");
    const script = parseChannelScript(ss.redeemScript);
    if (!script || !equalBytes(script.serverPubKey, terms.serverPubKey)) throw new BatchSettlementError(BatchError.REDEEM_SCRIPT, bytesToHex(ss.redeemScript));
    const out = await this.chain.getTxOut(input.prevout.txid, input.prevout.vout, true);
    if (!out) throw new BatchSettlementError(BatchError.CHANNEL_CLOSING, "the channel output is spent or unknown");
    if (out.scriptPubKey.hex !== bytesToHex(channelScriptPubKey(ss.redeemScript))) throw new BatchSettlementError(BatchError.REDEEM_SCRIPT, "not the channel output's script");
    const channel = channelFromScript({
      outpoint: input.prevout,
      redeemScript: ss.redeemScript,
      value: zatOf(out),
      closeFee: terms.closeFee,
      payToScript: addressToScript(terms.payTo, terms.network),
    });
    return { channel, tx };
  }

  private async recordClaim(channelId: string, cumulative: bigint): Promise<void> {
    if (await this.channels.open({ channelId, cumulative })) return;
    const r = await this.channels.get(channelId);
    if (r && r.cumulative < cumulative) await this.channels.compareAndSetCumulative(channelId, r.cumulative, cumulative);
  }

  private async relay(hex: string): Promise<void> {
    try {
      await this.chain.sendRawTransaction(hex);
    } catch (e) {
      if (e instanceof SendRawTransactionError && e.kind === "already-in-chain") return;
      throw e;
    }
  }

  private async waitForDepth(txid: string, vout: number, want: number): Promise<boolean> {
    const deadline = Date.now() + (this.cfg.fundingWaitMs ?? 0);
    for (;;) {
      const out = await this.chain.getTxOut(txid, vout, true);
      if (out && out.confirmations >= want) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, this.cfg.fundingPollMs ?? 500));
    }
  }
}

