// The client's return address (specs/scheme_batch_settlement_ycash.md, "`open`"): where every
// voucher returns the client's remainder. Without it the remainder would go to the channel key C,
// which lives only in the SDK's channel store and which no wallet watches.
import { ASSET_YED, type YcashNetwork } from "../constants.js";
import { addressToScript, decodeAddress, isYedKind } from "../tx/address.js";
import { equalBytes } from "../tx/bytes.js";
import { BatchError, BatchSettlementError } from "./errors.js";

/**
 * The output script of `returnAddress` for a channel of `asset` paying `payToScript`. YEC takes a
 * transparent P2PKH, P2SH or post-quantum (`sq…`) address; YED a key-hash holder, P2PKH (`s…`,
 * `yb…`) or TX_PQPKH (the 53-character `yb…`/`yt…`/`yr…`, or `sq…`), never P2SH (plan Y-8; quantum
 * spec §4). After the node's Falcon height only a scheme-2 TX_PQPKH holds YED (TOK-PQ): the node's
 * `yed_validaterawtransaction` of the first voucher refuses any other return output then. Never
 * payTo's own script: the voucher would then have two server outputs.
 *
 * @param returnAddress - The client's return address, as sent in `open`.
 * @param network - The channel's network; the address must belong to it.
 * @param asset - `YEC` or `YED`, the channel's asset.
 * @param payToScript - The server's payTo output script.
 * @returns The return output script.
 * @throws BatchSettlementError with `RETURN_ADDRESS` when the address fails any of these rules.
 */
export function returnScriptOf(returnAddress: string, network: YcashNetwork, asset: string, payToScript: Uint8Array): Uint8Array {
  let kind;
  try {
    kind = decodeAddress(returnAddress, network).kind;
  } catch (e) {
    throw new BatchSettlementError(BatchError.RETURN_ADDRESS, `${returnAddress}: ${(e as Error).message}`);
  }
  if (asset === ASSET_YED ? kind === "p2sh" : isYedKind(kind)) {
    throw new BatchSettlementError(BatchError.RETURN_ADDRESS, asset === ASSET_YED ? "a YED channel returns to a key-hash (P2PKH or post-quantum) address" : "a YEC channel returns to a transparent address, not a YED one");
  }
  const script = addressToScript(returnAddress, network);
  if (equalBytes(script, payToScript)) throw new BatchSettlementError(BatchError.RETURN_ADDRESS, "the return address is payTo's");
  return script;
}
