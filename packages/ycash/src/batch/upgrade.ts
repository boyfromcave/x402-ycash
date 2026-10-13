// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or https://www.opensource.org/licenses/mit-license.php .
//
// The next network-upgrade activation height (specs/scheme_batch_settlement_ycash.md, "Network
// upgrades"; audit 06/X-1). A voucher commits to the consensus branch id current when it was signed
// (ZIP-243), so the client's half of a voucher signed before an activation height cannot be mined
// at or after it: a server closes every channel below the next activation, treating that height
// like t for its margin (a `closeBy` bound beside the Falcon height, re-read every sweep).

/** One entry of `getblockchaininfo.upgrades` (the fields this module reads). */
export interface UpgradeInfo {
  activationheight: number;
  status: string;
}

/**
 * The least activation height among the upgrades the node lists as `pending` above the tip. An
 * entry at or below the tip is ignored (a misconfigured node listing a pending upgrade in the past
 * would otherwise close every channel at once), as is one without an integer height.
 *
 * @param upgrades - `getblockchaininfo.upgrades` (keyed by branch id), or undefined when the
 * source does not carry it (an older lightwalletd).
 * @param tip - The current tip height.
 * @returns The next activation height, or undefined when none is pending.
 */
export function nextActivationHeightOf(upgrades: Record<string, UpgradeInfo> | undefined, tip: number): number | undefined {
  let next: number | undefined;
  for (const u of Object.values(upgrades ?? {})) {
    if (u.status !== "pending" || !Number.isSafeInteger(u.activationheight) || u.activationheight <= tip) continue;
    if (next === undefined || u.activationheight < next) next = u.activationheight;
  }
  return next;
}
