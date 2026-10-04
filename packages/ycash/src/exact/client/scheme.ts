// The exact client for Ycash: builds the `transparent` YEC payment (specs/scheme_exact_ycash.md,
// "Transaction Construction"), signed but never broadcast, as Cardano's client does.
import type { PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { YcashNetwork } from "../../constants.js";
import { addressToScript, equalBytes, parseTx } from "../../tx/index.js";
import { chainOfNetwork, checkTransparentMethod, checkTransparentYecRequirements, clientExpiryHeight, resolveConfirmationPolicy } from "../policy.js";
import { SCHEME_EXACT, type ExactYcashTransparentPayload } from "../types.js";
import type { YcashClientSigner } from "./signer.js";

export class ExactYcashScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME_EXACT;

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
    const form = checkTransparentYecRequirements(requirements);
    if (form) throw new Error(form);
    if (!resolveConfirmationPolicy(requirements.extra, 1)) throw new Error("invalid confirmationPolicy");
    const network = requirements.network as YcashNetwork;

    // The network comes from the requirements and is checked against the client's own node.
    const chain = await this.signer.chainState();
    if (chain.chain !== chainOfNetwork(network)) throw new Error(`the signer's node runs ${chain.chain}, the requirements name ${network}`);

    const amount = BigInt(requirements.amount);
    const expiryHeight = clientExpiryHeight(chain.height, requirements.maxTimeoutSeconds);
    const signed = await this.signer.signPayment({ network, payTo: requirements.payTo, amount, expiryHeight, tip: chain.height, branchId: chain.branchId });

    // A signer is pluggable: check its tx has the shape the facilitator will demand.
    const tx = parseTx(signed.hex);
    const payTo = addressToScript(requirements.payTo, network);
    const hits = tx.vout.filter((o) => equalBytes(o.scriptPubKey, payTo));
    if (hits.length !== 1 || hits[0]?.value !== amount) throw new Error("signer built a transaction that does not pay exactly amount to payTo");
    if (tx.lockTime !== 0 || tx.expiryHeight !== expiryHeight) throw new Error("signer built a transaction with the wrong nLockTime or nExpiryHeight");

    const payload: ExactYcashTransparentPayload = { transaction: signed.hex };
    return { x402Version, payload: { ...payload } };
  }
}
