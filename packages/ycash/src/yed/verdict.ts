// Reading the overlay's own answers about a TRANSFER: `yed_decodepayload` and
// `yed_validaterawtransaction` (plan Y-9; ycash-dd/src/rpc/yellowback.cpp:1384-1488, ycash6 :1372,
// :1428, identical fields). Pure functions over the RPC results, shared by the exact facilitator
// (rules 4Y, 9Y) and the channel server and facilitator (YED channels).
import type { YedPayload, YedValidation } from "../node/types.js";
import type { Assignment } from "./payload.js";

/** The overlay's verdict strings are lowercase (ycash-dd/src/yellowback/state.cpp:23-24, same on ycash6). */
export const YED_VERDICT_OK = "ok";
export const YED_VERDICT_BURNED = "burned";

export type TransferVerdictProblem =
  /** `valid` false: the node's script verifier refused an input. */
  | "scripts"
  /** Not a TRANSFER (type `none` means no payload the overlay accepts: every YED input burns). */
  | "type"
  /** A verdict other than `ok`, `burned` included. */
  | "verdict"
  /** `burned` > 0 or yedOut ≠ yedIn. */
  | "burned"
  /** yedIn is not the expected amount (a channel's D). */
  | "yed_in"
  /** An input the overlay cannot see (it reads confirmed token records only, plan Y-7, X-F14). */
  | "unconfirmed_input";

export interface TransferVerdictExpectation {
  /** The exact yedIn required, in cents (a channel's D). */
  yedIn?: number;
  /**
   * Whether `valid` (the node's script verdict) must be true. Default true. A voucher with the
   * server's slot still empty cannot pass it by construction; its scripts are checked once completed.
   */
  scripts?: boolean;
}

/**
 * The verdict a non-burning TRANSFER must have: type `transfer`, verdict `ok`, burned 0, yedOut =
 * yedIn, no unconfirmed input, and (by default) valid scripts. Returns the first problem, or null.
 */
export function checkTransferVerdict(v: YedValidation, exp: TransferVerdictExpectation = {}): { problem: TransferVerdictProblem; message: string } | null {
  if ((exp.scripts ?? true) && !v.valid) return { problem: "scripts", message: "yed_validaterawtransaction: the scripts do not verify" };
  if (v.unconfirmedInputs.length > 0) {
    const list = v.unconfirmedInputs.map((o) => `${o.txid}:${o.vout}`).join(", ");
    return { problem: "unconfirmed_input", message: `inputs not in a block: ${list}` };
  }
  if (v.type !== "transfer") return { problem: "type", message: `overlay type ${v.type}, not transfer` };
  if (v.verdict !== YED_VERDICT_OK) return { problem: "verdict", message: `overlay verdict ${v.verdict}` };
  if (v.burned !== 0 || v.yedOut !== v.yedIn) return { problem: "burned", message: `burns ${v.burned} cents (yedIn ${v.yedIn}, yedOut ${v.yedOut})` };
  if (exp.yedIn !== undefined && v.yedIn !== exp.yedIn) return { problem: "yed_in", message: `yedIn ${v.yedIn}, expected ${exp.yedIn}` };
  return null;
}

export interface DecodedTransfer {
  opReturnIndex: number;
  assignments: Assignment[];
}

/** The TRANSFER `yed_decodepayload(hex)` found in a transaction, or null for anything else. */
export function decodedTransferOf(p: YedPayload): DecodedTransfer | null {
  if (p.valid !== true || p.type !== "transfer" || typeof p.opReturnIndex !== "number") return null;
  const raw = p.assignments;
  if (!Array.isArray(raw)) return null;
  const assignments: Assignment[] = [];
  for (const a of raw as unknown[]) {
    if (typeof a !== "object" || a === null) return null;
    const { vout, cents } = a as { vout?: unknown; cents?: unknown };
    if (typeof vout !== "number" || typeof cents !== "number") return null;
    assignments.push({ vout, cents });
  }
  return { opReturnIndex: p.opReturnIndex, assignments };
}

/** The two assignment lists name the same vouts with the same cents (order ignored). */
export function sameAssignments(a: readonly Assignment[], b: readonly Assignment[]): boolean {
  if (a.length !== b.length) return false;
  const key = (x: Assignment) => `${x.vout}:${x.cents}`;
  const want = new Set(b.map(key));
  return want.size === b.length && a.every((x) => want.has(key(x)));
}
