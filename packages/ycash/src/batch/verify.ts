// The stateless verification rules shared by the server and a facilitator
// (specs/scheme_batch_settlement_ycash.md, "Verification"). State (charged total, stored voucher,
// in-flight lock) lives in the server's ledger.
import { channelFromScript, channelIdOf, yecDeposit, type Channel } from "../channel/channel.js";
import { parseChannelScript } from "../channel/script.js";
import { checkVoucherShape, verifyVoucherSignature } from "../channel/voucher.js";
import { yecVoucherOutputs, type VoucherLayout } from "../channel/outputs.js";
import { YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET, type YcashNetwork } from "../constants.js";
import { yecToZat } from "../node/amount.js";
import type { BlockchainInfo, TxOutInfo, VerifyScriptsResult } from "../node/types.js";
import { addressToScript } from "../tx/address.js";
import { equalBytes, hexToBytes } from "../tx/bytes.js";
import { feeFloor, txFee } from "../tx/fee.js";
import { hasShielded, parseTx, serializeTxHex, txid as txidOf, type Tx } from "../tx/tx.js";
import { channelScriptPubKey } from "../channel/script.js";
import { BatchError, BatchSettlementError } from "./errors.js";
import type { BatchOpenPayload, BatchTerms } from "./types.js";

/** The node calls verification needs; YcashRpc satisfies it. */
export interface ChainView {
  getBlockCount(): Promise<number>;
  getBlockchainInfo(): Promise<BlockchainInfo>;
  getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null>;
  verifyScripts(hex: string): Promise<VerifyScriptsResult>;
  sendRawTransaction(hex: string): Promise<string>;
}

const CHAIN_OF: Record<YcashNetwork, string> = { [YCASH_MAINNET]: "main", [YCASH_TESTNET]: "test", [YCASH_REGTEST]: "regtest" };

/** The node's chain matches the network, and the branch id the next block signs under. */
export async function chainContext(chain: ChainView, network: YcashNetwork): Promise<{ tip: number; branchId: number }> {
  const info = await chain.getBlockchainInfo();
  if (info.chain !== CHAIN_OF[network]) throw new BatchSettlementError(BatchError.NETWORK, `node is on ${info.chain}, not ${network}`);
  return { tip: info.blocks, branchId: parseInt(info.consensus.nextblock, 16) >>> 0 };
}

export function decodeTx(hex: string, reason: string): Tx {
  try {
    const tx = parseTx(hex);
    if (serializeTxHex(tx) !== hex) throw new Error("not canonical");
    return tx;
  } catch (e) {
    throw new BatchSettlementError(reason, (e as Error).message);
  }
}

export function zatOf(out: TxOutInfo): bigint {
  return yecToZat(out.value);
}

export interface VerifiedOpen {
  channel: Channel;
  channelId: string;
  fundingTx: Tx;
  fundingTxid: string;
  /** D, in the asset's unit */
  deposit: bigint;
  /** The funding output already exists (in the mempool or a block). */
  alreadyBroadcast: boolean;
}

/**
 * Open rules 2–6, and voucher rules 4–6 for the first voucher. Read-only: nothing is relayed.
 * Rule 1 (the envelope) is the caller's.
 */
export async function verifyOpen(
  p: BatchOpenPayload,
  terms: BatchTerms,
  chain: ChainView,
  ctx: { tip: number; branchId: number },
  layout: VoucherLayout = yecVoucherOutputs,
): Promise<VerifiedOpen> {
  // 2. the redeem script
  const rs = hexToBytes(p.redeemScript);
  const script = parseChannelScript(rs);
  if (!script) throw new BatchSettlementError(BatchError.REDEEM_SCRIPT, "not the channel script");
  if (!equalBytes(script.serverPubKey, terms.serverPubKey)) throw new BatchSettlementError(BatchError.REDEEM_SCRIPT, "S is not extra.serverPubKey");
  if (script.refundHeight < ctx.tip + terms.minLockBlocks) {
    throw new BatchSettlementError(BatchError.REDEEM_SCRIPT, `t = ${script.refundHeight} is below tip + minLockBlocks = ${ctx.tip + terms.minLockBlocks}`);
  }
  // 3. the funding transaction
  const fundingTx = decodeTx(p.fundingTx, BatchError.FUNDING);
  if (hasShielded(fundingTx) || fundingTx.valueBalance !== 0n || fundingTx.lockTime !== 0) {
    throw new BatchSettlementError(BatchError.FUNDING, "the funding tx must be transparent with nLockTime 0");
  }
  const out = fundingTx.vout[p.vout];
  if (!out || !equalBytes(out.scriptPubKey, channelScriptPubKey(rs))) {
    throw new BatchSettlementError(BatchError.FUNDING, `vout ${p.vout} does not pay the channel script`);
  }
  const fundingTxid = txidOf(fundingTx);
  const channel = channelFromScript({
    outpoint: { txid: fundingTxid, vout: p.vout },
    redeemScript: rs,
    value: out.value,
    closeFee: terms.closeFee,
    payToScript: addressToScript(terms.payTo, terms.network),
  });
  // 4. the deposit (YEC: V − closeFee)
  const deposit = yecDeposit(channel);
  if (deposit <= 0n) throw new BatchSettlementError(BatchError.FUNDING, "V does not cover the close fee");
  if (deposit > terms.maxDeposit) throw new BatchSettlementError(BatchError.DEPOSIT_TOO_LARGE, `D = ${deposit} > ${terms.maxDeposit}`);
  // 5–6. unspent inputs, fee floor, scripts — or the funding output already exists
  const existing = await chain.getTxOut(fundingTxid, p.vout, true);
  if (!existing) {
    const values: bigint[] = [];
    for (const i of fundingTx.vin) {
      const [confirmed, live] = await Promise.all([chain.getTxOut(i.prevout.txid, i.prevout.vout, false), chain.getTxOut(i.prevout.txid, i.prevout.vout, true)]);
      if (!confirmed || !live) throw new BatchSettlementError(BatchError.FUNDING, `input ${i.prevout.txid}:${i.prevout.vout} is spent or unconfirmed`);
      values.push(zatOf(confirmed));
    }
    const fee = txFee(fundingTx, values);
    if (fee < feeFloor(fundingTx)) throw new BatchSettlementError(BatchError.FUNDING, `fee ${fee} is below the floor ${feeFloor(fundingTx)}`);
    const scripts = await chain.verifyScripts(p.fundingTx);
    if (!scripts.complete || scripts.errors.length > 0) throw new BatchSettlementError(BatchError.FUNDING, "the funding scripts do not verify");
  }
  // 7. the first voucher, rules 4–6 (charged is 0)
  const cumulative = BigInt(p.voucher.cumulative);
  checkVoucher(decodeTx(p.voucher.tx, BatchError.VOUCHER_SHAPE), channel, cumulative, { charged: 0n, amount: terms.amount, deposit, branchId: ctx.branchId, layout });
  return { channel, channelId: channelIdOf(channel.outpoint), fundingTx, fundingTxid, deposit, alreadyBroadcast: existing !== null };
}

export interface VoucherBounds {
  /** the server's charged total */
  charged: bigint;
  /** the per-request ceiling */
  amount: bigint;
  /** D */
  deposit: bigint;
  branchId: number;
  layout?: VoucherLayout;
  /** accept a completed close (the server's slot filled), for a facilitator's `claim` */
  allowCompleted?: boolean;
}

/** Voucher rules 4 (shape), 5 (charged + amount ≤ cumulative ≤ D, plan X-F16) and 6 (sigC). */
export function checkVoucher(tx: Tx, channel: Channel, cumulative: bigint, b: VoucherBounds): void {
  if (cumulative > b.deposit) throw new BatchSettlementError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT, `${cumulative} > D = ${b.deposit}`);
  const shape = checkVoucherShape(tx, channel, cumulative, { ...(b.layout ? { layout: b.layout } : {}), allowCompleted: b.allowCompleted ?? false });
  if (shape) throw new BatchSettlementError(BatchError.VOUCHER_SHAPE, shape);
  if (cumulative < b.charged + b.amount) {
    throw new BatchSettlementError(BatchError.CUMULATIVE_MISMATCH, `${cumulative} < charged ${b.charged} + amount ${b.amount}`);
  }
  if (!verifyVoucherSignature(tx, channel, b.branchId)) throw new BatchSettlementError(BatchError.VOUCHER_SIGNATURE);
}

/** Rule 7: the completed voucher passes the node's script verifier (signrawtransaction hex [] []). */
export async function checkCompleted(chain: ChainView, completed: Tx): Promise<string> {
  const hex = serializeTxHex(completed);
  const r = await chain.verifyScripts(hex);
  if (!r.complete || r.errors.length > 0) throw new BatchSettlementError(BatchError.SCRIPT, r.errors[0]?.error ?? "incomplete");
  return hex;
}

