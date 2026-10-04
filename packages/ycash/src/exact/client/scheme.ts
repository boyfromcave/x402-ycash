// The exact client for Ycash: builds the `transparent` YEC payment (specs/scheme_exact_ycash.md,
// "Transaction Construction"), signed but never broadcast, as Cardano's client does.
import type { DefaultAsset, PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { ASSET_YEC, ASSET_YED, type YcashNetwork } from "../../constants.js";
import { addressToScript, equalBytes, parseTx, type Tx } from "../../tx/index.js";
import { findPayload, isFindPayloadFailure, validateTransferAssignments } from "../../yed/index.js";
import { chainOfNetwork, isYcashNetwork, checkTransparentMethod, checkTransparentRequirements, clientExpiryHeight, DUST_ZAT, resolveConfirmationPolicy } from "../policy.js";
import { SCHEME_EXACT, type ExactYcashTransparentPayload } from "../types.js";
import type { SignedPayment, YcashClientSigner } from "./signer.js";

/**
 * YED is a dollar (cents, 2 decimals), so core's USD spend cap applies to it as to any default
 * asset. YEC is not USD-pegged: reporting it here would make the "$1" cap mean 1 YEC, so YEC
 * needs an `allowedAssets` entry with an atomic cap (see `yecSpendControl`).
 */
export function findYcashDefaultAsset(asset: string, network: string): DefaultAsset | undefined {
  return asset === ASSET_YED && isYcashNetwork(network) ? { asset: ASSET_YED, decimals: 2, symbol: ASSET_YED } : undefined;
}

/** The `spendControls.allowedAssets` entry an agent sets to pay YEC, capped at `maxZat` per payment. */
export function yecSpendControl(network: YcashNetwork, maxZat: bigint): { network: YcashNetwork; asset: string; maxAmountPerPayment: string } {
  return { network, asset: ASSET_YEC, maxAmountPerPayment: maxZat.toString() };
}

export class ExactYcashScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME_EXACT;
  readonly findDefaultAsset = findYcashDefaultAsset;

  constructor(private readonly signer: YcashClientSigner) {}

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    void context;
    // Refuse a 402 the facilitator would reject, before touching the wallet.
    const method = checkTransparentMethod(requirements.extra);
    if (method) throw new Error(method.message);
    const form = checkTransparentRequirements(requirements);
    if (form) throw new Error(form);
    if (!resolveConfirmationPolicy(requirements.extra, 1)) throw new Error("invalid confirmationPolicy");
    const network = requirements.network as YcashNetwork;
    const yed = requirements.asset === ASSET_YED;
    if (yed && !this.signer.signYedPayment) throw new Error("this signer cannot pay YED");

    // The network comes from the requirements and is checked against the client's own node.
    const chain = await this.signer.chainState();
    if (chain.chain !== chainOfNetwork(network)) throw new Error(`the signer's node runs ${chain.chain}, the requirements name ${network}`);

    const expiryHeight = clientExpiryHeight(chain.height, requirements.maxTimeoutSeconds);
    const base = { network, payTo: requirements.payTo, expiryHeight, tip: chain.height, branchId: chain.branchId };
    let signed: SignedPayment;
    if (yed) signed = await this.signer.signYedPayment!({ ...base, amountCents: Number(requirements.amount) }); // checked above
    else signed = await this.signer.signPayment({ ...base, amount: BigInt(requirements.amount) });

    // A signer is pluggable: check its tx has the shape the facilitator will demand.
    const tx = parseTx(signed.hex);
    const payTo = addressToScript(requirements.payTo, network);
    const hits = tx.vout.flatMap((o, n) => (equalBytes(o.scriptPubKey, payTo) ? [n] : []));
    if (hits.length !== 1) throw new Error("signer built a transaction that does not pay payTo exactly once");
    const payToVout = hits[0] as number;
    if (yed) {
      const problem = yedShapeProblem(tx, payToVout, Number(requirements.amount));
      if (problem) throw new Error(`signer built a YED transaction that ${problem}`);
    } else if (tx.vout[payToVout]?.value !== BigInt(requirements.amount)) {
      throw new Error("signer built a transaction that does not pay exactly amount to payTo");
    }
    if (tx.lockTime !== 0 || tx.expiryHeight !== expiryHeight) throw new Error("signer built a transaction with the wrong nLockTime or nExpiryHeight");

    const payload: ExactYcashTransparentPayload = { transaction: signed.hex };
    return { x402Version, payload: { ...payload } };
  }
}

/**
 * Rule 4Y as the client can check it without a node: one TRANSFER, exactly one assignment to the
 * payTo vout of `amountCents`, every assignment encodable and in range, the payTo output above dust.
 */
function yedShapeProblem(tx: Tx, payToVout: number, amountCents: number): string | null {
  if ((tx.vout[payToVout]?.value ?? 0n) < DUST_ZAT) return "puts dust on the payTo output";
  const found = findPayload(tx.vout);
  if (!found || isFindPayloadFailure(found) || found.payload.type !== "transfer") return "carries no TRANSFER payload";
  const { assignments } = found.payload;
  const check = validateTransferAssignments(assignments, tx.vout.length, found.index);
  if (!check.valid) return `has an invalid assignment (${check.error})`;
  const toPayTo = assignments.filter((a) => a.vout === payToVout);
  if (toPayTo.length !== 1 || toPayTo[0]?.cents !== amountCents) return "does not assign exactly amount to payTo";
  return null;
}
