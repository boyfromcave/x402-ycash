// Facilitator verification rules 1–10 for `transparent` YEC (specs/scheme_exact_ycash.md,
// "Facilitator Verification Rules"), in the spec's order, read-only: nothing here broadcasts.
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { deepEqual } from "@x402/core/utils";
import { ASSET_YED, type YcashNetwork } from "../../constants.js";
import { yecToZat, type YcashRpc } from "../../node/index.js";
import type { SettlementStore } from "../../store/index.js";
import { txidKey } from "../../store/index.js";
import { addressToScript, equalBytes, feeFloor, hasShielded, hexToBytes, parseTx, txFee, txid as txidOf, type Tx } from "../../tx/index.js";
import {
  ERR_AMOUNT_MISMATCH,
  ERR_ASSET_TRANSFER_METHOD,
  ERR_DUPLICATE_SETTLEMENT,
  ERR_EXPIRY,
  ERR_FEE_TOO_HIGH,
  ERR_FEE_TOO_LOW,
  ERR_INPUT_SPENT,
  ERR_NETWORK_MISMATCH,
  ERR_PAYMENT_FLOW,
  ERR_RECIPIENT_MISMATCH,
  ERR_REQUIREMENTS_MISMATCH,
  ERR_SCRIPT,
  ERR_SIGHASH,
  ERR_TRANSACTION,
  ERR_YED_INPUT,
  ERR_YED_NODE_REQUIRED,
} from "../errors.js";
import {
  assetTransferMethodOf,
  chainOfNetwork,
  checkTransparentMethod,
  checkTransparentYecRequirements,
  expiryWindow,
  resolveConfirmationPolicy,
} from "../policy.js";
import { addressOfScript, addressOfScriptSig, checkSighashAll } from "../script.js";
import { SCHEME_EXACT, type ExactYcashTransparentPayload } from "../types.js";

/** The RPCs the facilitator reads (and, in settle, `sendrawtransaction`). Any `YcashRpc` fits. */
export type ExactFacilitatorRpc = Pick<
  YcashRpc,
  "getBlockchainInfo" | "getBlockCount" | "getTxOut" | "verifyScripts" | "sendRawTransaction" | "capabilities" | "yedValidateRawTransaction"
>;

export interface VerifyLimits {
  /** Rule 3's size limit, bytes (default 100,000: MAX_STANDARD_TX_SIZE on both lines). */
  maxTransactionBytes: number;
  /** Bounds rule 6's gettxout calls (Implementation limits). */
  maxInputs: number;
  /** Rule 7's sanity cap, zatoshis (RECOMMENDED 100,000). */
  feeCapZat: bigint;
  /** The settled confirmation range; −1 needs the operator's opt-in (Confirmation policy). */
  minConfirmations: number;
  maxConfirmations: number;
  /** Policy assumed when the requirements carry none: the server normally sets it explicitly. */
  defaultConfirmations: number;
}

export type Failure = { ok: false; reason: string; message: string; payer?: string };

/** What the pure checks (rules 1, 3, 4, 5) resolved, before any chain lookup. */
export interface ResolvedPayment {
  network: YcashNetwork;
  hex: string;
  tx: Tx;
  txid: string;
  key: string;
  /** Index of the `payTo` output (rule 4). */
  payToVout: number;
  required: number;
}

export interface VerifiedPayment extends ResolvedPayment {
  payer: string;
  feeZat: bigint;
}

const fail = (reason: string, message: string, payer?: string): Failure => ({ ok: false, reason, message, ...(payer !== undefined ? { payer } : {}) });
const HEX = /^(?:[0-9a-f]{2})+$/;

/** Rule 1, the requirement forms, and the pure part of the transaction: rules 3, 4 and 5. */
export function resolvePayment(payload: PaymentPayload, req: PaymentRequirements, limits: VerifyLimits): { ok: true; state: ResolvedPayment } | Failure {
  // Rule 1: envelope.
  if (payload.x402Version !== 2) return fail(ERR_REQUIREMENTS_MISMATCH, `x402Version ${payload.x402Version} is not 2`);
  const acc = payload.accepted;
  if (!acc || typeof acc !== "object") return fail(ERR_REQUIREMENTS_MISMATCH, "accepted is missing");
  if (req.scheme !== SCHEME_EXACT) return fail(ERR_REQUIREMENTS_MISMATCH, `scheme ${req.scheme} is not exact`);
  for (const f of ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"] as const) {
    if (acc[f] !== req[f]) return fail(ERR_REQUIREMENTS_MISMATCH, `accepted.${f} differs from the requirements`);
  }
  if (assetTransferMethodOf(acc.extra) !== assetTransferMethodOf(req.extra)) {
    return fail(ERR_REQUIREMENTS_MISMATCH, "accepted names another assetTransferMethod");
  }
  for (const [k, v] of Object.entries(req.extra ?? {})) {
    if (k !== "assetTransferMethod" && !deepEqual(acc.extra?.[k], v)) return fail(ERR_REQUIREMENTS_MISMATCH, `accepted.extra.${k} differs from the requirements`);
  }
  const method = checkTransparentMethod(req.extra);
  if (method) return fail(method.reason === "method" ? ERR_ASSET_TRANSFER_METHOD : method.reason === "flow" ? ERR_PAYMENT_FLOW : ERR_REQUIREMENTS_MISMATCH, method.message);
  if (req.asset === ASSET_YED) return fail(ERR_YED_NODE_REQUIRED, "YED exact payments are not served by this facilitator (plan X3)");
  const form = checkTransparentYecRequirements(req);
  if (form) return fail(ERR_REQUIREMENTS_MISMATCH, form);
  const network = req.network as YcashNetwork;
  const policy = resolveConfirmationPolicy(req.extra, limits.defaultConfirmations);
  if (!policy) return fail(ERR_REQUIREMENTS_MISMATCH, "confirmationPolicy must be {confirmations} with an integer in [-1, 20]");
  if (policy.confirmations < limits.minConfirmations || policy.confirmations > limits.maxConfirmations) {
    return fail(ERR_REQUIREMENTS_MISMATCH, `this facilitator settles confirmations ${limits.minConfirmations}..${limits.maxConfirmations}, not ${policy.confirmations}`);
  }

  // Rule 3: decoding.
  const hex = (payload.payload as Partial<ExactYcashTransparentPayload>).transaction;
  if (typeof hex !== "string" || !HEX.test(hex)) return fail(ERR_TRANSACTION, "payload.transaction must be lowercase hex");
  if (hex.length / 2 > limits.maxTransactionBytes) return fail(ERR_TRANSACTION, `transaction exceeds ${limits.maxTransactionBytes} bytes`);
  let tx: Tx;
  try {
    tx = parseTx(hex); // v4 Sapling group only, no trailing bytes
  } catch (e) {
    return fail(ERR_TRANSACTION, (e as Error).message);
  }
  if (hasShielded(tx) || tx.valueBalance !== 0n) return fail(ERR_TRANSACTION, "a transparent payment carries no Sapling or JoinSplit component");
  if (tx.lockTime !== 0) return fail(ERR_TRANSACTION, "nLockTime must be 0");
  if (tx.vin.length === 0 || tx.vout.length === 0) return fail(ERR_TRANSACTION, "transaction has no inputs or no outputs");
  if (tx.vin.length > limits.maxInputs) return fail(ERR_TRANSACTION, `more than ${limits.maxInputs} inputs`);

  // Rule 4: recipient and amount.
  const payToScript = addressToScript(req.payTo, network);
  const hits = tx.vout.flatMap((o, n) => (equalBytes(o.scriptPubKey, payToScript) ? [n] : []));
  if (hits.length !== 1) return fail(ERR_RECIPIENT_MISMATCH, `${hits.length} outputs pay payTo; exactly one must`);
  const payToVout = hits[0] as number;
  if (tx.vout[payToVout]?.value !== BigInt(req.amount)) return fail(ERR_AMOUNT_MISMATCH, `the payTo output is not exactly ${req.amount} zatoshis`);

  // Rule 5: signature hash types.
  for (const [i, input] of tx.vin.entries()) {
    const bad = checkSighashAll(input.scriptSig);
    if (bad) return fail(ERR_SIGHASH, `input ${i}: ${bad}`);
  }
  const id = txidOf(hexToBytes(hex));
  return { ok: true, state: { network, hex, tx, txid: id, key: txidKey(network, id), payToVout, required: policy.confirmations } };
}

/** Rule 2. */
export async function checkNetwork(rpc: ExactFacilitatorRpc, network: YcashNetwork): Promise<{ ok: true; tip: number } | Failure> {
  const info = await rpc.getBlockchainInfo();
  if (info.chain !== chainOfNetwork(network)) return fail(ERR_NETWORK_MISMATCH, `the node runs ${info.chain}, the requirements name ${network}`);
  return { ok: true, tip: info.blocks };
}

/**
 * Rules 1–10 in order. A tx this facilitator already claimed (its own broadcast) has spent its
 * inputs, so rules 6–9Y "no longer apply" (rule 6's note) and the answer is rule 10's
 * `duplicate_settlement` rather than a spent-input failure.
 */
export async function verifyTransparent(
  rpc: ExactFacilitatorRpc,
  store: SettlementStore,
  payload: PaymentPayload,
  req: PaymentRequirements,
  limits: VerifyLimits,
): Promise<{ ok: true; state: VerifiedPayment } | Failure> {
  const resolved = resolvePayment(payload, req, limits);
  if (!resolved.ok) return resolved;
  const s = resolved.state;
  const net = await checkNetwork(rpc, s.network);
  if (!net.ok) return net;

  if (await store.isClaimed(s.key)) {
    return fail(ERR_DUPLICATE_SETTLEMENT, `${s.txid} is already claimed`, addressOfScriptSig(s.tx.vin[0]?.scriptSig ?? new Uint8Array(), s.network));
  }

  // Rule 6: every input confirmed and unspent, and not spent in the mempool (plan R-6, X-F10).
  const values: bigint[] = [];
  let payer = "";
  for (const [i, input] of s.tx.vin.entries()) {
    const { txid, vout } = input.prevout;
    const confirmed = await rpc.getTxOut(txid, vout, false);
    if (!confirmed) return fail(ERR_INPUT_SPENT, `input ${i} (${txid}:${vout}) is unknown, unconfirmed or spent`);
    if (!(await rpc.getTxOut(txid, vout, true))) return fail(ERR_INPUT_SPENT, `input ${i} (${txid}:${vout}) is spent by a mempool transaction`);
    values.push(yecToZat(confirmed.value));
    if (i === 0) payer = addressOfScript(hexToBytes(confirmed.scriptPubKey.hex), s.network);
  }

  // Rule 7: fee floor (SDK and facilitator policy, X-F3) and sanity cap.
  const fee = txFee(s.tx, values);
  const floor = feeFloor(s.tx);
  if (fee < floor) return fail(ERR_FEE_TOO_LOW, `fee ${fee} is below the floor ${floor}`, payer);
  if (fee > limits.feeCapZat) return fail(ERR_FEE_TOO_HIGH, `fee ${fee} is above the cap ${limits.feeCapZat}`, payer);

  // Rule 8: expiry window, read against the tip rule 2 saw.
  const w = expiryWindow(net.tip, req.maxTimeoutSeconds);
  const e = s.tx.expiryHeight;
  if (e === 0 || e < w.min || e > w.max) return fail(ERR_EXPIRY, `nExpiryHeight ${e} is outside [${w.min}, ${w.max}]`, payer);

  // Rule 9: the node's script verifier, signing nothing (plan R-5).
  const scripts = await rpc.verifyScripts(s.hex);
  if (!scripts.complete || scripts.errors.length > 0) {
    return fail(ERR_SCRIPT, scripts.errors.map((x) => `${x.txid}:${x.vout} ${x.error}`).join("; ") || "incomplete", payer);
  }

  // Rule 9Y: on a Yellowback node, a YEC payment must not spend a YED-bearing coin (plan Y-4).
  if ((await rpc.capabilities()).yellowback) {
    const yed = await rpc.yedValidateRawTransaction(s.hex);
    if (yed.yedIn !== 0) return fail(ERR_YED_INPUT, `the transaction spends ${yed.yedIn} YED cents, which a YEC payment would burn`, payer);
  }

  // Rule 10: not claimed (re-read: the claim may have landed while the lookups ran).
  if (await store.isClaimed(s.key)) return fail(ERR_DUPLICATE_SETTLEMENT, `${s.txid} is already claimed`, payer);
  return { ok: true, state: { ...s, payer, feeZat: fee } };
}
