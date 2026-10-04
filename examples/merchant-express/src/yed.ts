// Whether the merchant may sell its YED routes. A facilitator lists YED in /supported only when its
// node runs the Yellowback overlay (spec "/supported"); the channel route also needs the merchant's
// own node to run it, since the server checks each voucher with yed_validaterawtransaction.
import type { FacilitatorClient } from "@x402/core/server";
import { ASSET_YED, type YcashNetwork } from "x402-ycash-mechanism";
import type { YedConfig } from "./config.js";
import type { YedModes } from "./schemes.js";

/** The parts of the merchant's node the probe reads. */
export interface YedNode {
  capabilities(): Promise<{ yellowback: boolean }>;
}

export type Log = (msg: string, fields?: Record<string, unknown>) => void;

/** True when the facilitator's `exact` kind on `network` lists YED among its assets. */
export async function facilitatorListsYed(facilitator: FacilitatorClient, network: YcashNetwork): Promise<boolean> {
  const supported = await facilitator.getSupported();
  return supported.kinds.some((k) => {
    const assets = k.extra?.assets;
    return k.scheme === "exact" && k.network === network && Array.isArray(assets) && assets.includes(ASSET_YED);
  });
}

/**
 * The YED modes to serve. Each failure turns YED off with a log line rather than stopping the
 * merchant: its YEC routes do not depend on the overlay.
 */
export async function probeYed(yed: YedConfig, facilitator: FacilitatorClient, network: YcashNetwork, node: YedNode | undefined, log: Log): Promise<YedModes> {
  const off: YedModes = { exact: false, channel: false, maxDepositCents: yed.maxDepositCents };
  let listed: boolean;
  try {
    listed = await facilitatorListsYed(facilitator, network);
  } catch (e) {
    log("YED routes off", { reason: `the facilitator's /supported failed: ${(e as Error).message}` });
    return off;
  }
  if (!listed) {
    log("YED routes off", { reason: "the facilitator does not list YED (its node does not run -yellowback)" });
    return off;
  }
  let channel = false;
  try {
    channel = node !== undefined && (await node.capabilities()).yellowback;
  } catch (e) {
    log("YED channel route off", { reason: `the merchant's node: ${(e as Error).message}` });
  }
  if (!channel && node !== undefined) log("YED channel route off", { reason: "the merchant's node does not run -yellowback" });
  return { exact: true, channel, maxDepositCents: yed.maxDepositCents };
}
