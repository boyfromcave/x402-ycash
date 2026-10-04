// The overlay's transfer rules as a builder and a verifier must apply them before a TRANSFER is
// signed or accepted. A transaction that breaks any of them burns YED, and burns are final.

import { YED_MAX_OUTPUT_CENTS, YED_MIN_OUTPUT_CENTS } from "../constants.js";
import { type Assignment, MAX_ASSIGNMENTS } from "./payload.js";

export type TransferAssignmentError =
  /**
   * No assignment: every YED input would burn (state.cpp:473, 879-883). This also covers XFER-3
   * (state.cpp:452): with at least one assignment of >= $1.00, XFER-2 fails first on yedIn <= 0.
   */
  | "no_assignments"
  /** More than MAX_ASSIGNMENTS (payload.h:82-83): not encodable. */
  | "too_many_assignments"
  /** vout is not an integer in 0..255 (the payload's vout is a u8). */
  | "vout_not_u8"
  /** The vout does not exist in the transaction (FindPayload, payload.cpp:426). */
  | "vout_out_of_range"
  /** The vout is the OP_RETURN itself (FindPayload, payload.cpp:427). */
  | "vout_is_op_return"
  /** Two assignments name one vout (ValidAssignments, payload.cpp:96). */
  | "duplicate_vout"
  /** XFER-1: cents outside [100, 10,000,000] (params.cpp:18-19, state.cpp:447-449). Everything burns. */
  | "cents_out_of_range"
  /** XFER-2: assigned more than yedIn (state.cpp:451). Everything burns. */
  | "over_assigned"
  /** Assigned less than yedIn: the difference burns (verdict BURNED, state.cpp:473); `strict` pools skip it. */
  | "under_assigned";

export type TransferValidation =
  | { readonly valid: true; readonly totalCents: number }
  | { readonly valid: false; readonly error: TransferAssignmentError; readonly assignment?: number };

export interface TransferValidationOptions {
  /** Sum of the token records the transaction spends. When given, XFER-2 and no-burn are checked. */
  readonly yedInCents?: number;
}

/**
 * Checks a TRANSFER's assignments against the transaction it will sit in: `outputCount` outputs, the
 * payload's OP_RETURN at `opReturnIndex`. Valid means the overlay registers every assigned cent
 * (verdict OK) and, with `yedInCents`, that nothing burns.
 *
 * @param assignments - The payload's assignments.
 * @param outputCount - The number of outputs in the transaction.
 * @param opReturnIndex - The vout of the payload's OP_RETURN.
 * @param options - The spent token total, to check over- and under-assignment.
 * @returns Valid with the assigned total, or the first rule broken and the offending assignment index.
 */
export function validateTransferAssignments(
  assignments: readonly Assignment[],
  outputCount: number,
  opReturnIndex: number,
  options: TransferValidationOptions = {},
): TransferValidation {
  const fail = (error: TransferAssignmentError, assignment?: number): TransferValidation =>
    assignment === undefined ? { valid: false, error } : { valid: false, error, assignment };
  if (assignments.length === 0) return fail("no_assignments");
  if (assignments.length > MAX_ASSIGNMENTS) return fail("too_many_assignments");
  const seen = new Set<number>();
  let total = 0;
  for (let i = 0; i < assignments.length; i++) {
    const a = assignments[i] as Assignment;
    if (!Number.isInteger(a.vout) || a.vout < 0 || a.vout > 0xff) return fail("vout_not_u8", i);
    if (a.vout >= outputCount) return fail("vout_out_of_range", i);
    if (a.vout === opReturnIndex) return fail("vout_is_op_return", i);
    if (seen.has(a.vout)) return fail("duplicate_vout", i);
    seen.add(a.vout);
    if (!Number.isInteger(a.cents) || a.cents < YED_MIN_OUTPUT_CENTS || a.cents > YED_MAX_OUTPUT_CENTS) {
      return fail("cents_out_of_range", i);
    }
    total += a.cents;
  }
  const yedIn = options.yedInCents;
  if (yedIn !== undefined) {
    if (total > yedIn) return fail("over_assigned");
    if (total < yedIn) return fail("under_assigned");
  }
  return { valid: true, totalCents: total };
}
