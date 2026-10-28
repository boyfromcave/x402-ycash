// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// YED channels across the node's Falcon height (quantum spec R-A2, A-1, TOK-PQ; D-Q-19). From
// `pqFalconHeight` F the module's TOK-PQ rule lets only a scheme-2 (FN-DSA-512) TX_PQPKH, or a
// TX_PQCHANNEL with a scheme-2 client, receive YED; a transaction assigning YED to any other output is
// invalid. Before F the node's policy refuses every new scheme-2 output (A-1). So:
//
// - a channel opened at or after F (the funding's block ≥ F) is a TX_PQCHANNEL with a Falcon client,
//   and every voucher output that receives YED (payTo, the client's return) is a Falcon TX_PQPKH;
// - a channel opened before F (a P2SH channel, or a TX_PQCHANNEL with an SLH-DSA client, its outputs
//   P2PKH or SLH-DSA TX_PQPKH) must be funded *and closed* below F: its `closeBy` is min(t, F), and
//   client and server treat closeBy like t (the server closes at closeBy − closeMarginBlocks). After F
//   only its refund remains, and the refund must pay a Falcon TX_PQPKH.
//
// The owner's decision of 2026-10-10 puts F at 0 on mainnet and testnet (Falcon from the vault upgrade's
// first block), so there every YED channel is Falcon from the start and the P2SH YED channel is never
// valid; the pre-Falcon forms exist for regtest runs with `-pqfalconheight` > 0 only.
import { ASSET_YED, YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET, type YcashNetwork } from "../constants.js";
import type { YedInfo } from "../node/types.js";
import { pqpkhKeyId } from "../pq/script.js";
import { SCHEME_FN_DSA_512, SCHEME_SLH_DSA_SHA2_128S, type PQScheme } from "../pq/scheme.js";
import type { Channel } from "./channel.js";

/** `yed_getinfo.params.pq.falconHeight` when Falcon never activates (the node's NO_ACTIVATION_HEIGHT). */
export const FALCON_NEVER = -1;

/**
 * The Falcon height assumed when the node cannot be asked (no `yed_getinfo`): 0 on mainnet and testnet
 * (owner decision 2026-10-10: Falcon from day one), never on regtest (set there by `-pqfalconheight`).
 */
export const DEFAULT_FALCON_HEIGHT: Readonly<Record<YcashNetwork, number>> = { [YCASH_MAINNET]: 0, [YCASH_TESTNET]: 0, [YCASH_REGTEST]: FALCON_NEVER };

/**
 * Whether Falcon (and TOK-PQ) applies to a block: the node's IsPQFalconActive.
 *
 * @param falconHeight - F, or {@link FALCON_NEVER}.
 * @param height - The block height (for a transaction not yet mined: tip + 1).
 * @returns True when height ≥ F ≥ 0.
 */
export function isFalconActiveAt(falconHeight: number, height: number): boolean {
  return falconHeight >= 0 && height >= falconHeight;
}

/**
 * F from a `yed_getinfo` result (rpcversion 7: `params.pq.falconHeight`).
 *
 * @param info - The `yed_getinfo` result.
 * @returns F, {@link FALCON_NEVER}, or undefined when the node does not report it (before rpcversion 7).
 */
export function falconHeightOf(info: YedInfo): number | undefined {
  const pq = (info.params as { pq?: { falconHeight?: unknown } } | undefined)?.pq;
  const h = pq?.falconHeight;
  return typeof h === "number" && Number.isSafeInteger(h) && h >= FALCON_NEVER ? h : undefined;
}

/** A node view that may answer `yed_getinfo`. */
export interface FalconHeightSource {
  yedGetInfo?(): Promise<YedInfo>;
}

const cache = new WeakMap<object, number>();

/**
 * F as the node reports it (cached per node object: it is a fixed consensus parameter), else the
 * network's {@link DEFAULT_FALCON_HEIGHT}.
 *
 * @param chain - The node view.
 * @param network - The network, for the default.
 * @returns F, or {@link FALCON_NEVER}.
 */
export async function readFalconHeight(chain: FalconHeightSource, network: YcashNetwork): Promise<number> {
  const hit = cache.get(chain);
  if (hit !== undefined) return hit;
  let h: number | undefined;
  if (typeof chain.yedGetInfo === "function") {
    try {
      h = falconHeightOf(await chain.yedGetInfo());
    } catch {
      h = undefined; // a node without the Yellowback overlay: the network default
    }
  }
  if (h === undefined) return DEFAULT_FALCON_HEIGHT[network];
  cache.set(chain, h);
  return h;
}

/**
 * Whether `spk` is a Falcon (scheme-2) TX_PQPKH: the only YED holder output after F.
 *
 * @param spk - An output script.
 * @returns True for `20 <hash> 52 c2`.
 */
export function isFalconHolder(spk: Uint8Array): boolean {
  return pqpkhKeyId(spk)?.scheme === SCHEME_FN_DSA_512;
}

/**
 * Why `spk` cannot receive YED in a transaction mined under `falconActive`, or null when it can.
 * After F: only a Falcon TX_PQPKH (TOK-PQ). Before F: anything but a scheme-2 output (policy A-1).
 *
 * @param spk - The output script.
 * @param falconActive - Whether Falcon applies to the block the transaction lands in.
 * @returns The reason, or null.
 */
export function yedHolderProblem(spk: Uint8Array, falconActive: boolean): string | null {
  const id = pqpkhKeyId(spk);
  if (falconActive) return id?.scheme === SCHEME_FN_DSA_512 ? null : "after the Falcon height only a Falcon (scheme-2) post-quantum address holds YED (TOK-PQ)";
  return id?.scheme === SCHEME_FN_DSA_512 ? "a Falcon (scheme-2) address cannot receive outputs before the Falcon height (node policy)" : null;
}

/**
 * The client scheme a new YED channel opens with: Falcon once its funding lands at or after F, SLH-DSA before.
 *
 * @param falconActive - Whether Falcon applies to the next block.
 * @returns The scheme.
 */
export function yedChannelClientScheme(falconActive: boolean): PQScheme {
  return falconActive ? SCHEME_FN_DSA_512 : SCHEME_SLH_DSA_SHA2_128S;
}

/**
 * Whether a channel is of the Falcon era: a TX_PQCHANNEL with a Falcon client (its outputs were checked
 * as Falcon holders at open). Any other YED channel was opened before F.
 *
 * @param ch - The channel (template and client scheme).
 * @returns True for a scheme-2 TX_PQCHANNEL.
 */
export function isFalconChannel(ch: Pick<Channel, "template"> & { client?: { scheme: number } }): boolean {
  return ch.template === "pq" && ch.client?.scheme === SCHEME_FN_DSA_512;
}

/**
 * The height by which a channel must be closed (its last voucher mined below it): t, or for a YED
 * channel opened before F, min(t, F).
 *
 * @param asset - The channel's asset.
 * @param ch - The channel (template, client scheme, t).
 * @param falconHeight - F, or {@link FALCON_NEVER}.
 * @returns closeBy.
 */
export function channelCloseBy(asset: string, ch: Pick<Channel, "template" | "refundHeight"> & { client?: { scheme: number } }, falconHeight: number): number {
  if (asset !== ASSET_YED || falconHeight < 0 || isFalconChannel(ch)) return ch.refundHeight;
  return Math.min(ch.refundHeight, falconHeight);
}
