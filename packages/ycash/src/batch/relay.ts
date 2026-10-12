// Broadcasting a channel transaction (rpcversion 8, the fee structure). A YED channel's funding,
// close and refund pay the Yellowback network rate (yed_getinfo.params.fees.network), which at a low
// YEC price is above the node's -maxtxfee, so the stock sendrawtransaction refuses them as absurdly
// high. Their fees are bounded before they get here (the close fee and the refund's are the channel's
// closeFee, which the server chose under the node's cap and the client capped at open; a funding's is
// checked by verifyOpen), so a YED channel transaction refused for its fee is resubmitted with
// allowhighfees, as the node's own Yellowback paths submit. A YEC channel transaction never is.
import { SendRawTransactionError } from "../node/errors.js";

/** A node view that broadcasts, optionally past -maxtxfee. */
export interface RelayChain {
  sendRawTransaction(hex: string, allowHighFees?: boolean): Promise<string>;
}

/**
 * sendrawtransaction, and for a YED channel transaction refused as absurdly high, once more with
 * allowhighfees.
 *
 * @param chain - The node.
 * @param hex - The transaction.
 * @param yed - Whether it is a YED channel's transaction (its fee bounded by the caller).
 * @returns The txid.
 * @throws The node's refusal.
 */
export async function sendChannelTransaction(chain: RelayChain, hex: string, yed: boolean): Promise<string> {
  try {
    return await chain.sendRawTransaction(hex);
  } catch (e) {
    if (yed && e instanceof SendRawTransactionError && e.kind === "absurd-fee") return chain.sendRawTransaction(hex, true);
    throw e;
  }
}
