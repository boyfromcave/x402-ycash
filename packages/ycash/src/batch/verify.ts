// The stateless verification rules shared by the server and a facilitator
// (specs/scheme_batch_settlement_ycash.md, "Verification"). State (charged total, stored voucher,
// in-flight lock) lives in the server's ledger.
import { channelFromScript, channelIdOf, yecDeposit, type Channel } from "../channel/channel.js";
import { channelScriptPubKey, parseChannelScript } from "../channel/script.js";
import { checkVoucherShape, verifyVoucherSignature } from "../channel/voucher.js";
import { yecVoucherOutputs, type VoucherLayout } from "../channel/outputs.js";
import { assignedTo, YED_TRANSFER_VOUT, yedChannelValue, yedVoucherAssignments, yedVoucherLayout } from "../channel/yed.js";
import {
  ASSET_YEC,
  ASSET_YED,
  TX_EXPIRING_SOON_THRESHOLD,
  YCASH_MAINNET,
  YCASH_REGTEST,
  YCASH_TESTNET,
  YED_MAX_OUTPUT_CENTS,
  YED_MIN_OUTPUT_CENTS,
  type YcashNetwork,
} from "../constants.js";
import { yecToZat } from "../node/amount.js";
import { RPC_METHOD_NOT_FOUND, RpcError } from "../node/errors.js";
import type { BlockchainInfo, TxOutInfo, VerifyScriptsResult, YedPayload, YedValidation } from "../node/types.js";
import { checkTransferVerdict, decodedTransferOf, sameAssignments } from "../yed/verdict.js";
import { findPayload, isFindPayloadFailure } from "../yed/script.js";
import { validateTransferAssignments } from "../yed/transfer.js";
import { addressToScript } from "../tx/address.js";
import { equalBytes, hexToBytes } from "../tx/bytes.js";
import { feeFloor, txFee } from "../tx/fee.js";
import { hasShielded, parseTx, serializeTxHex, txid as txidOf, type Tx } from "../tx/tx.js";
import { BatchError, BatchSettlementError } from "./errors.js";
import { returnScriptOf } from "./returnAddress.js";
import { requiredDepth, type BatchOpenPayload, type BatchTerms } from "./types.js";

/** The node calls verification needs; YcashRpc satisfies it. */
export interface ChainView {
  getBlockCount(): Promise<number>;
  getBlockchainInfo(): Promise<BlockchainInfo>;
  getTxOut(txid: string, n: number, includeMempool: boolean): Promise<TxOutInfo | null>;
  verifyScripts(hex: string): Promise<VerifyScriptsResult>;
  sendRawTransaction(hex: string): Promise<string>;
}

/** A Yellowback node's view (`-experimentalfeatures -yellowback`): what YED channels need (plan Y-9). */
export interface YedChainView extends ChainView {
  yedValidateRawTransaction(hex: string): Promise<YedValidation>;
  yedDecodePayload(hex: string): Promise<YedPayload>;
}

/**
 * Duck-typed check for the two overlay RPCs a YED channel needs.
 *
 * @param chain - The node view.
 * @returns Whether `chain` is a {@link YedChainView}.
 */
export function isYedChain(chain: ChainView): chain is YedChainView {
  const c = chain as Partial<YedChainView>;
  return typeof c.yedValidateRawTransaction === "function" && typeof c.yedDecodePayload === "function";
}

/**
 * The chain as a Yellowback node.
 *
 * @param chain - The node view.
 * @returns The same view, narrowed.
 * @throws BatchSettlementError with `YED_NODE_REQUIRED` when the view lacks the overlay RPCs.
 */
export function yedChain(chain: ChainView): YedChainView {
  if (!isYedChain(chain)) throw new BatchSettlementError(BatchError.YED_NODE_REQUIRED, "YED channels need a Yellowback node");
  return chain;
}

/**
 * Runs an overlay RPC. A stock node answers the overlay's RPCs with −32601: that is
 * `YED_NODE_REQUIRED`, not a verdict; any other error is rethrown unchanged.
 *
 * @param call - The overlay call.
 * @returns The call's result.
 */
async function overlay<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof RpcError && e.code === RPC_METHOD_NOT_FOUND) {
      throw new BatchSettlementError(BatchError.YED_NODE_REQUIRED, "the node does not run -experimentalfeatures -yellowback");
    }
    throw e;
  }
}

/**
 * The voucher output layout of a channel of `asset` holding D.
 *
 * @param asset - `YEC` or `YED`.
 * @param deposit - D, in zatoshis (YEC) or cents (YED).
 * @returns The layout.
 * @throws BatchSettlementError with `REQUIREMENTS` for any other asset.
 */
export function layoutFor(asset: string, deposit: bigint): VoucherLayout {
  if (asset === ASSET_YEC) return yecVoucherOutputs;
  if (asset === ASSET_YED) return yedVoucherLayout(deposit);
  throw new BatchSettlementError(BatchError.REQUIREMENTS, `no channel layout for ${asset}`);
}

/**
 * The least cumulative a voucher may carry: $1.00 for YED (the dollar floor), none for YEC (the
 * layout enforces dust).
 *
 * @param asset - The channel's asset.
 * @returns The floor, in the asset's unit.
 */
export function cumulativeFloor(asset: string): bigint {
  return asset === ASSET_YED ? BigInt(YED_MIN_OUTPUT_CENTS) : 0n;
}

/**
 * The cumulative of a client `close` at the charged total: never below the floor (the pre-paid
 * dollar is the server's).
 *
 * @param asset - The channel's asset.
 * @param charged - The server's charged total.
 * @returns The cumulative to sign.
 */
export function closeCumulative(asset: string, charged: bigint): bigint {
  const floor = cumulativeFloor(asset);
  return charged > floor ? charged : floor;
}

/**
 * Whether the server should close after a charge: the next voucher at the ceiling would exceed D,
 * or, for YED, would leave the client a remainder in (0, $1.00), or the latest voucher already
 * assigns all of D to the server (scheme "Close triggers").
 *
 * @param asset - The channel's asset.
 * @param deposit - D.
 * @param charged - The charged total after this charge.
 * @param ceiling - The per-request ceiling (`amount`).
 * @param latestCumulative - The cumulative of the latest stored voucher.
 * @returns Whether the channel is exhausted.
 */
export function isExhausted(asset: string, deposit: bigint, charged: bigint, ceiling: bigint, latestCumulative: bigint): boolean {
  if (asset !== ASSET_YED) return latestCumulative >= deposit || charged + ceiling > deposit;
  const min = BigInt(YED_MIN_OUTPUT_CENTS);
  const next = charged + ceiling > min ? charged + ceiling : min;
  const left = deposit - next;
  return next > deposit || (left > 0n && left < min) || deposit - latestCumulative < min;
}

/**
 * The overlay's checks of a YED voucher (scheme "Verification adds"): `yed_decodepayload` finds
 * exactly the split at vout 2, and `yed_validaterawtransaction` reports a transfer, verdict ok,
 * burned 0, yedIn = yedOut = D, no unconfirmed input. `scripts` is false for a voucher whose
 * server slot is still empty (a facilitator's `voucher`): its scripts cannot verify yet.
 *
 * @param chain - The node view; must be a Yellowback node.
 * @param hex - The voucher transaction.
 * @param deposit - D, in cents.
 * @param cumulative - The voucher's cumulative, in cents.
 * @param opts - Verification options.
 * @param opts.scripts - Whether the verdict must include passing scripts (default true).
 * @throws BatchSettlementError with `YED_VERDICT` or `SCRIPT` when the overlay disagrees.
 */
export async function checkYedVoucher(chain: ChainView, hex: string, deposit: bigint, cumulative: bigint, opts: { scripts?: boolean } = {}): Promise<void> {
  const node = yedChain(chain);
  const decoded = decodedTransferOf(await overlay(() => node.yedDecodePayload(hex)));
  if (!decoded || decoded.opReturnIndex !== YED_TRANSFER_VOUT || !sameAssignments(decoded.assignments, yedVoucherAssignments(deposit, cumulative))) {
    throw new BatchSettlementError(BatchError.YED_VERDICT, "yed_decodepayload does not find the voucher's split at vout 2");
  }
  const problem = checkTransferVerdict(await overlay(() => node.yedValidateRawTransaction(hex)), { yedIn: Number(deposit), scripts: opts.scripts ?? true });
  if (problem) throw new BatchSettlementError(problem.problem === "scripts" ? BatchError.SCRIPT : BatchError.YED_VERDICT, problem.message);
}

/**
 * The channel's D as the overlay records it: the yedIn of a voucher spending it (the channel's
 * token record).
 *
 * @param chain - The node view; must be a Yellowback node.
 * @param voucherHex - Any voucher spending the channel output.
 * @returns D, in cents.
 * @throws BatchSettlementError with `FUNDING_DEPTH` while the funding is unconfirmed, or
 * `YED_VERDICT` when the output holds less than $1.00.
 */
export async function overlayDeposit(chain: ChainView, voucherHex: string): Promise<bigint> {
  const node = yedChain(chain);
  const v = await overlay(() => node.yedValidateRawTransaction(voucherHex));
  if (v.unconfirmedInputs.length > 0) throw new BatchSettlementError(BatchError.FUNDING_DEPTH, "the channel's funding is not in a block");
  if (v.yedIn < YED_MIN_OUTPUT_CENTS) throw new BatchSettlementError(BatchError.YED_VERDICT, `the channel output holds ${v.yedIn} cents of YED`);
  return BigInt(v.yedIn);
}

const CHAIN_OF: Record<YcashNetwork, string> = { [YCASH_MAINNET]: "main", [YCASH_TESTNET]: "test", [YCASH_REGTEST]: "regtest" };

/**
 * Checks that the node's chain matches the network and reads the branch id the next block signs
 * under, which every voucher signature commits to.
 *
 * @param chain - The node view.
 * @param network - The network of the requirements.
 * @returns The tip height and the next block's consensus branch id.
 * @throws BatchSettlementError with `NETWORK` when the node is on another chain.
 */
export async function chainContext(chain: ChainView, network: YcashNetwork): Promise<{ tip: number; branchId: number }> {
  const info = await chain.getBlockchainInfo();
  if (info.chain !== CHAIN_OF[network]) throw new BatchSettlementError(BatchError.NETWORK, `node is on ${info.chain}, not ${network}`);
  return { tip: info.blocks, branchId: parseInt(info.consensus.nextblock, 16) >>> 0 };
}

/**
 * Parses a transaction and requires the canonical encoding (re-serialization must give the same
 * hex), so the txid the client signed is the txid that is relayed.
 *
 * @param hex - The transaction, lowercase hex.
 * @param reason - The error code to refuse with.
 * @returns The parsed transaction.
 * @throws BatchSettlementError with `reason` when it does not parse or is not canonical.
 */
export function decodeTx(hex: string, reason: string): Tx {
  try {
    const tx = parseTx(hex);
    if (serializeTxHex(tx) !== hex) throw new Error("not canonical");
    return tx;
  } catch (e) {
    throw new BatchSettlementError(reason, (e as Error).message);
  }
}

/**
 * The value of a `gettxout` result, converted from YEC to zatoshis.
 *
 * @param out - The `gettxout` result.
 * @returns The value in zatoshis.
 */
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
  /** The client's output script in every voucher, from `returnAddress`. */
  returnScript: Uint8Array;
  /** The funding output already exists (in the mempool or a block). */
  alreadyBroadcast: boolean;
}

/**
 * The least funding `nExpiryHeight` a server accepts at `tip` (0, never, is also accepted): the
 * funding must still relay at the next block, which refuses an expiry below next + 3
 * (TX_EXPIRING_SOON_THRESHOLD; ycash-dd/src/main.cpp:742, ycash6 :799), and leave one block per
 * confirmation of the policy depth.
 *
 * @param tip - The current tip height.
 * @param confirmations - The policy's `confirmations` value.
 * @returns The least acceptable non-zero expiry height.
 */
export function minFundingExpiry(tip: number, confirmations: number): number {
  return tip + TX_EXPIRING_SOON_THRESHOLD + requiredDepth(confirmations);
}

/**
 * Open rules 2–8, and voucher rules 4–6 for the first voucher (rule 9). Read-only: nothing is relayed.
 * Rule 1 (the envelope) is the caller's.
 *
 * @param p - The `open` payload.
 * @param terms - The parsed requirements.
 * @param chain - The node view.
 * @param ctx - The node context from {@link chainContext}.
 * @param ctx.tip - The current tip height.
 * @param ctx.branchId - The branch id the first voucher must be signed under.
 * @returns The verified channel, its deposit and return script.
 * @throws BatchSettlementError naming the first rule that fails.
 */
export async function verifyOpen(
  p: BatchOpenPayload,
  terms: BatchTerms,
  chain: ChainView,
  ctx: { tip: number; branchId: number },
): Promise<VerifiedOpen> {
  const yed = terms.asset === ASSET_YED;
  if (yed) yedChain(chain);
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
  const payToScript = addressToScript(terms.payTo, terms.network);
  const returnScript = returnScriptOf(p.returnAddress, terms.network, terms.asset, payToScript);
  const channel = channelFromScript({
    outpoint: { txid: fundingTxid, vout: p.vout },
    redeemScript: rs,
    value: out.value,
    closeFee: terms.closeFee,
    payToScript,
  });
  // 4. the deposit: V − closeFee for YEC; for YED the cents the funding TRANSFER assigns the channel
  const deposit = yed ? yedFundingDeposit(fundingTx, p.vout, channel.value, terms.closeFee) : yecDeposit(channel);
  if (deposit <= 0n) throw new BatchSettlementError(BatchError.FUNDING, "V does not cover the close fee");
  if (deposit > terms.maxDeposit) throw new BatchSettlementError(BatchError.DEPOSIT_TOO_LARGE, `D = ${deposit} > ${terms.maxDeposit}`);
  // 5–6. unspent inputs, fee floor, scripts — or the funding output already exists
  const existing = await chain.getTxOut(fundingTxid, p.vout, true);
  // The funding expiry: until the funding is in a block, it must be able to land and reach the
  // policy depth before it expires (an unrelayed funding then frees the client's coins by height).
  if ((!existing || existing.confirmations === 0) && fundingTx.expiryHeight !== 0 && fundingTx.expiryHeight < minFundingExpiry(ctx.tip, terms.confirmations)) {
    throw new BatchSettlementError(BatchError.FUNDING, `the funding expires at ${fundingTx.expiryHeight}, before ${minFundingExpiry(ctx.tip, terms.confirmations)}`);
  }
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
  // The overlay's view of the funding TRANSFER while its inputs are still in the UTXO set (not
  // broadcast, or in the mempool). Once mined, the first voucher's yedIn = D is the check.
  if (yed && (!existing || existing.confirmations === 0)) await checkYedFunding(chain, p.fundingTx, p.vout, deposit);
  // 7. the first voucher, rules 4–6 (charged is 0)
  const cumulative = BigInt(p.voucher.cumulative);
  checkVoucher(decodeTx(p.voucher.tx, BatchError.VOUCHER_SHAPE), channel, cumulative, {
    charged: 0n, amount: terms.amount, deposit, branchId: ctx.branchId, layout: layoutFor(terms.asset, deposit), floor: cumulativeFloor(terms.asset), returnScript,
  });
  return { channel, channelId: channelIdOf(channel.outpoint), fundingTx, fundingTxid, deposit, returnScript, alreadyBroadcast: existing !== null };
}

/**
 * D of a YED channel from its funding transaction (scheme "YED Channels", Funding): V is exactly
 * 2 × TOKEN_VALUE + closeFee, and the one TRANSFER assigns the channel output D cents in
 * [$1.00, $100,000], with assignments the overlay registers.
 *
 * @param fundingTx - The funding transaction.
 * @param vout - The channel output index.
 * @param value - The channel output value, in zatoshis.
 * @param closeFee - The close fee, in zatoshis.
 * @returns D, in cents.
 * @throws BatchSettlementError with `FUNDING` when any of these fails.
 */
function yedFundingDeposit(fundingTx: Tx, vout: number, value: bigint, closeFee: bigint): bigint {
  if (value !== yedChannelValue(closeFee)) {
    throw new BatchSettlementError(BatchError.FUNDING, `a YED channel output carries 2 × TOKEN_VALUE + closeFee = ${yedChannelValue(closeFee)} zatoshis, not ${value}`);
  }
  const found = findPayload(fundingTx.vout);
  if (!found || isFindPayloadFailure(found) || found.payload.type !== "transfer") {
    throw new BatchSettlementError(BatchError.FUNDING, "the funding transaction carries no TRANSFER");
  }
  const check = validateTransferAssignments(found.payload.assignments, fundingTx.vout.length, found.index);
  if (!check.valid) throw new BatchSettlementError(BatchError.FUNDING, `the funding TRANSFER would burn (${check.error})`);
  const d = assignedTo(found.payload.assignments, vout);
  if (d === undefined || d < YED_MIN_OUTPUT_CENTS || d > YED_MAX_OUTPUT_CENTS) {
    throw new BatchSettlementError(BatchError.FUNDING, `the funding TRANSFER does not assign the channel output (vout ${vout})`);
  }
  return BigInt(d);
}

/**
 * Checks that the overlay agrees: the funding TRANSFER decodes the same and burns nothing
 * (verdict ok).
 *
 * @param chain - The node view; must be a Yellowback node.
 * @param hex - The funding transaction.
 * @param vout - The channel output index.
 * @param deposit - D, in cents.
 * @throws BatchSettlementError with `FUNDING` or `YED_VERDICT` when it does not.
 */
async function checkYedFunding(chain: ChainView, hex: string, vout: number, deposit: bigint): Promise<void> {
  const node = yedChain(chain);
  const decoded = decodedTransferOf(await overlay(() => node.yedDecodePayload(hex)));
  if (!decoded || assignedTo(decoded.assignments, vout) !== Number(deposit)) {
    throw new BatchSettlementError(BatchError.FUNDING, "yed_decodepayload does not assign D to the channel output");
  }
  const problem = checkTransferVerdict(await overlay(() => node.yedValidateRawTransaction(hex)));
  if (problem) throw new BatchSettlementError(problem.problem === "unconfirmed_input" ? BatchError.FUNDING : BatchError.YED_VERDICT, `funding: ${problem.message}`);
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
  /** the least cumulative (YED: $1.00, the dollar floor) */
  floor?: bigint;
  /** the channel's bound client script (from `returnAddress`); absent only for a verifier that never saw the open */
  returnScript?: Uint8Array;
}

/**
 * Voucher rules 4 (shape), 5 (charged + amount ≤ cumulative ≤ D) and 6 (the client's signature).
 *
 * @param tx - The voucher transaction.
 * @param channel - The channel it spends.
 * @param cumulative - The cumulative the payload claims.
 * @param b - The bounds the voucher must meet.
 * @throws BatchSettlementError naming the first rule that fails.
 */
export function checkVoucher(tx: Tx, channel: Channel, cumulative: bigint, b: VoucherBounds): void {
  if (cumulative > b.deposit) throw new BatchSettlementError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT, `${cumulative} > D = ${b.deposit}`);
  if (b.floor !== undefined && cumulative < b.floor) throw new BatchSettlementError(BatchError.YED_FLOOR, `cumulative ${cumulative} is below the $1.00 floor`);
  const shape = checkVoucherShape(tx, channel, cumulative, {
    ...(b.layout ? { layout: b.layout } : {}),
    ...(b.returnScript ? { clientScript: b.returnScript } : {}),
    allowCompleted: b.allowCompleted ?? false,
  });
  if (shape) throw new BatchSettlementError(BatchError.VOUCHER_SHAPE, shape);
  if (cumulative < b.charged + b.amount) {
    throw new BatchSettlementError(BatchError.CUMULATIVE_MISMATCH, `${cumulative} < charged ${b.charged} + amount ${b.amount}`);
  }
  if (!verifyVoucherSignature(tx, channel, b.branchId)) throw new BatchSettlementError(BatchError.VOUCHER_SIGNATURE);
}

/**
 * Rule 7: the completed voucher passes the node's script verifier (signrawtransaction hex [] []).
 *
 * @param chain - The node view.
 * @param completed - The voucher with the server's signature added.
 * @returns The completed transaction's hex.
 * @throws BatchSettlementError with `SCRIPT` when the scripts do not verify.
 */
export async function checkCompleted(chain: ChainView, completed: Tx): Promise<string> {
  const hex = serializeTxHex(completed);
  const r = await chain.verifyScripts(hex);
  if (!r.complete || r.errors.length > 0) throw new BatchSettlementError(BatchError.SCRIPT, r.errors[0]?.error ?? "incomplete");
  return hex;
}

