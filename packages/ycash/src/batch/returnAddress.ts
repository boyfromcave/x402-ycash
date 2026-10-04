// The client's return address (specs/scheme_batch_settlement_ycash.md, "`open`"): where every
// voucher returns the client's remainder. Without it the remainder would go to the channel key C,
// which lives only in the SDK's channel store and which no wallet watches.
import { ASSET_YED, type YcashNetwork } from "../constants.js";
import { addressToScript, decodeAddress } from "../tx/address.js";
import { equalBytes } from "../tx/bytes.js";
import { BatchError, BatchSettlementError } from "./errors.js";

/**
 * The output script of `returnAddress` for a channel of `asset` paying `payToScript`. YEC takes a
 * transparent P2PKH or P2SH address; YED a P2PKH one (`s…` or `ye…`), since a YED holder is a key
 * hash (plan Y-8; ycash-dd/src/yellowback/address.cpp:11-27). Never payTo's own script: the
 * voucher would then have two server outputs.
 */
export function returnScriptOf(returnAddress: string, network: YcashNetwork, asset: string, payToScript: Uint8Array): Uint8Array {
  let kind;
  try {
    kind = decodeAddress(returnAddress, network).kind;
  } catch (e) {
    throw new BatchSettlementError(BatchError.RETURN_ADDRESS, `${returnAddress}: ${(e as Error).message}`);
  }
  if (asset === ASSET_YED ? kind === "p2sh" : kind === "yed") {
    throw new BatchSettlementError(BatchError.RETURN_ADDRESS, asset === ASSET_YED ? "a YED channel returns to a P2PKH address" : "a YEC channel returns to a transparent address, not a YED one");
  }
  const script = addressToScript(returnAddress, network);
  if (equalBytes(script, payToScript)) throw new BatchSettlementError(BatchError.RETURN_ADDRESS, "the return address is payTo's");
  return script;
}
