// The client's `batch-settlement` scheme on Ycash, on @x402/core's SchemeNetworkClient. It opens a
// channel on first use (a fresh key C, t = tip + minLockBlocks + slack, a funding transaction from
// its funder), signs one voucher per request at the server's charged total plus `amount`, and can
// close cooperatively or refund alone from t (specs/scheme_batch_settlement_ycash.md).
import type { FindDefaultAsset, PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements, SchemeClientHooks, SchemeNetworkClient, SettleResponse } from "@x402/core/types";
import { channelIdOf } from "../../channel/channel.js";
import { DUST_THRESHOLD } from "../../channel/constants.js";
import { findChannelVout } from "../../channel/funding.js";
import type { VoucherLayout } from "../../channel/outputs.js";
import { buildRefund } from "../../channel/refund.js";
import { buildChannelScript, channelAddress } from "../../channel/script.js";
import { buildVoucher } from "../../channel/voucher.js";
import { buildYedRefund, yedChannelValue } from "../../channel/yed.js";
import { ASSET_YEC, ASSET_YED, YED_MAX_OUTPUT_CENTS } from "../../constants.js";
import type { BlockchainInfo, TxOutInfo } from "../../node/types.js";
import { bytesToHex, hexToBytes } from "../../tx/bytes.js";
import { hash160 } from "../../tx/hash.js";
import { pubkeyFromPriv, randomPrivKey } from "../../tx/keys.js";
import { p2pkhScript } from "../../tx/script.js";
import { parseTx, serializeTxHex, txid as txidOf } from "../../tx/tx.js";
import { BatchError } from "../errors.js";
import { parseTerms, type BatchChannelState, type BatchClientPayload, type BatchTerms } from "../types.js";
import { closeCumulative, cumulativeFloor, layoutFor } from "../verify.js";
import { channelOfRecord, InMemoryClientChannelStorage, offerKeyOf, type ClientChannelRecord, type ClientChannelStorage } from "./channel.js";
import type { ChannelFunder } from "./funder.js";

/** The node calls the client needs: tip and branch id, and broadcasting its refund. */
export interface ClientChain {
  getBlockchainInfo(): Promise<BlockchainInfo>;
  getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null>;
  sendRawTransaction(hex: string): Promise<string>;
}

/**
 * The client's own deposit caps, in each asset's unit: 1 YEC and $50 (5,000 YED cents). Spend
 * controls cap only the per-request `amount`; D is locked until t, and the server alone chooses
 * its `maxDeposit`, so the client caps it too.
 */
export const DEFAULT_CLIENT_MAX_DEPOSIT: Readonly<Record<string, bigint>> = { [ASSET_YEC]: 100_000_000n, [ASSET_YED]: 5_000n };

export interface BatchYcashClientConfig {
  chain: ClientChain;
  funder: ChannelFunder;
  storage?: ClientChannelStorage;
  /** D for a new channel; default amount × depositMultiplier, capped at both maxDeposits. */
  deposit?: (terms: BatchTerms) => bigint;
  /**
   * The largest D this client opens with, per asset (merged over DEFAULT_CLIENT_MAX_DEPOSIT),
   * whatever the server's maxDeposit allows. An open above it is refused.
   */
  maxDeposit?: Partial<Record<string, bigint>>;
  /** default 100 */
  depositMultiplier?: number;
  /** Blocks added to tip + minLockBlocks, so the open survives a few blocks of delay (default 10). */
  lockSlackBlocks?: number;
  log?: (msg: string) => void;
}

export interface ClientChannelStatus {
  channelId: string;
  status: ClientChannelRecord["status"];
  tip: number;
  refundHeight: number;
  /** blocks until the refund is valid (0 when it already is) */
  blocksToRefund: number;
  /** the channel output is unspent (neither closed nor refunded) */
  unspent: boolean;
  charged: string;
  signed: string;
  deposit: string;
}

export class BatchYcashScheme implements SchemeNetworkClient {
  readonly scheme = "batch-settlement";
  readonly storage: ClientChannelStorage;
  readonly schemeHooks: SchemeClientHooks;
  /** Makes YEC (8 decimals) and YED (cents) known to x402Client's spend controls, which refuse unknown assets. */
  readonly findDefaultAsset: FindDefaultAsset = (asset) =>
    asset === ASSET_YEC ? { asset: ASSET_YEC, decimals: 8, symbol: ASSET_YEC } : asset === ASSET_YED ? { asset: ASSET_YED, decimals: 2, symbol: ASSET_YED } : undefined;

  constructor(private readonly cfg: BatchYcashClientConfig) {
    this.storage = cfg.storage ?? new InMemoryClientChannelStorage();
    this.schemeHooks = {
      onPaymentResponse: async (ctx) => {
        if (ctx.settleResponse) await this.applySettleResponse(ctx.settleResponse);
        const state = ctx.paymentRequired?.accepts.find((r) => r.scheme === this.scheme)?.extra?.channelState as BatchChannelState | undefined;
        if (state && (await this.resync(state))) return { recovered: true };
        return undefined;
      },
    };
  }

  /** The voucher outputs of a channel of `asset` holding D (YEC, or YED with the dollar floor). */
  protected layoutFor(asset: string, deposit: bigint): VoucherLayout {
    return layoutFor(asset, deposit);
  }

  /** The least a voucher may carry: the dust threshold for YEC, $1.00 for YED (X-7). */
  private floorOf(asset: string): bigint {
    return asset === ASSET_YED ? cumulativeFloor(asset) : DUST_THRESHOLD;
  }

  async createPaymentPayload(x402Version: number, req: PaymentRequirements, _ctx?: PaymentPayloadContext): Promise<PaymentPayloadResult> {
    const terms = parseTerms(req);
    const key = offerKeyOf(terms.network, terms.payTo, bytesToHex(terms.serverPubKey));
    let rec = await this.storage.findLive(key);
    // An open not yet accepted (funding depth) is resent unchanged.
    if (rec?.status === "opening" && rec.open) return { x402Version, payload: { ...rec.open } };
    const info = await this.cfg.chain.getBlockchainInfo();
    const branchId = parseInt(info.consensus.nextblock, 16) >>> 0;
    if (rec) {
      const next = BigInt(rec.charged) + terms.amount;
      if (next > BigInt(rec.deposit) || info.blocks >= rec.refundHeight - rec.closeMarginBlocks) {
        rec.status = "retired"; // the server closes it (exhausted or margin); continue on a new channel
        await this.storage.put(rec);
        rec = undefined;
      } else {
        const floor = this.floorOf(rec.asset);
        const cumulative = next > floor ? next : floor;
        const tx = this.sign(rec, cumulative, branchId);
        rec.signed = cumulative.toString();
        await this.storage.put(rec);
        const payload: BatchClientPayload = { type: "voucher", channelId: rec.channelId, tx, cumulative: cumulative.toString() };
        return { x402Version, payload: { ...payload } };
      }
    }
    return { x402Version, payload: { ...(await this.open(terms, key, info.blocks, branchId)) } };
  }

  private async open(terms: BatchTerms, offerKey: string, tip: number, branchId: number) {
    const yed = terms.asset === ASSET_YED;
    const priv = randomPrivKey();
    const clientPubKey = pubkeyFromPriv(priv);
    const refundHeight = tip + terms.minLockBlocks + (this.cfg.lockSlackBlocks ?? 10);
    const redeemScript = buildChannelScript({ clientPubKey, serverPubKey: terms.serverPubKey, refundHeight });
    const cap = this.maxDepositFor(terms.asset);
    let deposit = this.cfg.deposit?.(terms) ?? terms.amount * BigInt(this.cfg.depositMultiplier ?? 100);
    const serverCap = yed && terms.maxDeposit > BigInt(YED_MAX_OUTPUT_CENTS) ? BigInt(YED_MAX_OUTPUT_CENTS) : terms.maxDeposit;
    if (deposit > serverCap) deposit = serverCap;
    if (!this.cfg.deposit && deposit > cap) deposit = cap;
    const floor = this.floorOf(terms.asset);
    const first = terms.amount > floor ? terms.amount : floor;
    if (yed && deposit < first) deposit = first; // a YED channel holds at least the pre-paid $1.00
    if (deposit > cap) throw new Error(`deposit ${deposit} is above this client's maxDeposit ${cap} for ${terms.asset}`);
    if (deposit < first || deposit > serverCap) throw new Error(`maxDeposit ${terms.maxDeposit} cannot carry one request of ${first}`);
    this.layoutFor(terms.asset, deposit); // refuse an asset without a layout before funding anything
    // YED: V carries the two voucher outputs' TOKEN_VALUE and the close fee; D is assigned in cents.
    const value = yed ? yedChannelValue(terms.closeFee) : deposit + terms.closeFee;
    const fundingTx = await this.cfg.funder.fund({ network: terms.network, redeemScript, value, branchId, asset: terms.asset, deposit });
    const vout = findChannelVout(parseTx(fundingTx), redeemScript);
    if (vout < 0) throw new Error("the funder's transaction does not pay the channel");
    const channelId = channelIdOf({ txid: txidOf(hexToBytes(fundingTx)), vout });
    const rec: ClientChannelRecord = {
      channelId, offerKey, network: terms.network, asset: terms.asset, payTo: terms.payTo, serverPubKey: bytesToHex(terms.serverPubKey),
      redeemScript: bytesToHex(redeemScript), fundingTx, vout, value: value.toString(), closeFee: terms.closeFee.toString(),
      deposit: deposit.toString(), refundHeight, closeMarginBlocks: terms.closeMarginBlocks, clientPrivKey: bytesToHex(priv),
      clientScript: bytesToHex(p2pkhScript(hash160(clientPubKey))), charged: "0", signed: first.toString(), status: "opening",
    };
    const open = { type: "open" as const, fundingTx, vout, redeemScript: rec.redeemScript, voucher: { tx: this.sign(rec, first, branchId), cumulative: first.toString() } };
    rec.open = open;
    await this.storage.put(rec);
    this.cfg.log?.(`opened ${channelId} at ${channelAddress(terms.network, redeemScript)}: V=${value} D=${deposit} t=${refundHeight}`);
    return open;
  }

  /** The client's cap on D for `asset` (refuses an asset with none). */
  private maxDepositFor(asset: string): bigint {
    const cap = this.cfg.maxDeposit?.[asset] ?? DEFAULT_CLIENT_MAX_DEPOSIT[asset];
    if (cap === undefined) throw new Error(`no client maxDeposit for ${asset}`);
    return cap;
  }

  private sign(rec: ClientChannelRecord, cumulative: bigint, branchId: number): string {
    return serializeTxHex(buildVoucher({
      channel: channelOfRecord(rec),
      cumulative,
      clientScript: hexToBytes(rec.clientScript),
      clientPrivKey: hexToBytes(rec.clientPrivKey),
      branchId,
      layout: this.layoutFor(rec.asset, BigInt(rec.deposit)),
    }));
  }

  /** Applies a PAYMENT-RESPONSE: the server's charged total, and the open accepted. */
  async applySettleResponse(resp: SettleResponse): Promise<void> {
    const state = resp.extra?.channelState as BatchChannelState | undefined;
    if (!resp.success || !state) return;
    const rec = await this.storage.get(state.channelId);
    if (!rec) return;
    if (rec.status === "opening") {
      rec.status = "open";
      delete rec.open;
    }
    rec.charged = state.chargedCumulative;
    if (BigInt(state.signedCumulative) > BigInt(rec.signed)) rec.signed = state.signedCumulative;
    await this.storage.put(rec);
  }

  /**
   * Resynchronises from a corrective 402's channelState. A charged total above what this client
   * ever signed is refused: an honest server cannot have charged it. Returns true when it changed.
   */
  async resync(state: BatchChannelState): Promise<boolean> {
    const rec = await this.storage.get(state.channelId);
    if (!rec) return false;
    const charged = BigInt(state.chargedCumulative);
    if (charged > BigInt(rec.signed) || charged === BigInt(rec.charged)) return false;
    rec.charged = charged.toString();
    if (rec.status === "opening") {
      rec.status = "open";
      delete rec.open;
    }
    await this.storage.put(rec);
    return true;
  }

  /** A cooperative close at the charged total (the `close` payload): the server broadcasts it. */
  async closePayload(channelId: string): Promise<PaymentPayloadResult> {
    const rec = await this.mustGet(channelId);
    const info = await this.cfg.chain.getBlockchainInfo();
    const cumulative = closeCumulative(rec.asset, BigInt(rec.charged));
    const tx = this.sign(rec, cumulative, parseInt(info.consensus.nextblock, 16) >>> 0);
    const payload: BatchClientPayload = { type: "close", channelId, tx, cumulative: cumulative.toString() };
    return { x402Version: 2, payload: { ...payload } };
  }

  /** Marks a channel closed after the server's close response. */
  async markClosed(channelId: string, closeTxid: string): Promise<void> {
    const rec = await this.mustGet(channelId);
    rec.status = "closed";
    rec.closeTxid = closeTxid;
    await this.storage.put(rec);
  }

  /** The refund, from height t: builds, broadcasts and records it; returns its txid. */
  async refund(channelId: string, opts: { toScript?: Uint8Array; fee?: bigint } = {}): Promise<string> {
    const rec = await this.mustGet(channelId);
    const info = await this.cfg.chain.getBlockchainInfo();
    if (info.blocks < rec.refundHeight) throw new Error(`the refund is valid from height ${rec.refundHeight}; tip is ${info.blocks}`);
    const params = {
      channel: channelOfRecord(rec),
      clientPrivKey: hexToBytes(rec.clientPrivKey),
      toScript: opts.toScript ?? hexToBytes(rec.clientScript),
      branchId: parseInt(info.consensus.nextblock, 16) >>> 0,
      ...(opts.fee !== undefined ? { fee: opts.fee } : {}),
    };
    // A YED refund carries a TRANSFER of all of D to the client: a bare spend would burn it (Y-4).
    const tx = rec.asset === ASSET_YED ? buildYedRefund({ ...params, depositCents: BigInt(rec.deposit) }) : buildRefund(params);
    const txid = await this.cfg.chain.sendRawTransaction(serializeTxHex(tx));
    rec.status = "refunded";
    rec.refundTxid = txid;
    await this.storage.put(rec);
    return txid;
  }

  async status(channelId: string): Promise<ClientChannelStatus> {
    const rec = await this.mustGet(channelId);
    const [info, out] = await Promise.all([this.cfg.chain.getBlockchainInfo(), this.cfg.chain.getTxOut(rec.channelId.split(":")[0] as string, rec.vout, true)]);
    return {
      channelId, status: rec.status, tip: info.blocks, refundHeight: rec.refundHeight,
      blocksToRefund: Math.max(0, rec.refundHeight - info.blocks), unspent: out !== null,
      charged: rec.charged, signed: rec.signed, deposit: rec.deposit,
    };
  }

  private async mustGet(channelId: string): Promise<ClientChannelRecord> {
    const rec = await this.storage.get(channelId);
    if (!rec) throw new Error(`${BatchError.UNKNOWN_CHANNEL}: ${channelId}`);
    return rec;
  }
}

