// The YED dollar floor for payment channels (plan X-7). Every YED output must be at least $1.00
// (XFER-1, ycash-dd/src/yellowback/params.cpp:18, state.cpp:447-449) or the whole transfer burns, so
// a voucher can never pay the server, or return to the client, a sub-dollar amount:
//   - the cumulative is at least $1.00 from the first voucher on (it pre-pays the first dollar);
//   - the client's remainder is 0 or at least $1.00; a remainder in (0, $1.00) goes to the server.

import { YED_MAX_OUTPUT_CENTS, YED_MIN_OUTPUT_CENTS } from "../constants.js";

export interface YedChannelSplit {
  /** Assigned to the server's vout. */
  readonly serverCents: number;
  /** Assigned to the client's vout; 0 means the voucher has no client output. */
  readonly clientCents: number;
}

/**
 * Refuses a channel deposit that is not a valid single YED output (XFER-1).
 *
 * @param depositCents - The channel deposit, in cents.
 * @throws RangeError when the deposit is not an integer in [$1.00, the output maximum].
 */
function checkDeposit(depositCents: number): void {
  if (!Number.isInteger(depositCents) || depositCents < YED_MIN_OUTPUT_CENTS || depositCents > YED_MAX_OUTPUT_CENTS) {
    throw new RangeError(
      `channel deposit ${depositCents} cents is outside [${YED_MIN_OUTPUT_CENTS}, ${YED_MAX_OUTPUT_CENTS}]`,
    );
  }
}

/**
 * True when `cumulativeCents` is a voucher amount the channel can carry: an integer in
 * [$1.00, deposit]. Every such amount has a non-burning split (yedChannelSplit); a deposit outside
 * the XFER-1 range has none.
 *
 * @param depositCents - The channel deposit, in cents.
 * @param cumulativeCents - The voucher's cumulative amount, in cents.
 * @returns Whether the voucher amount is acceptable.
 */
export function isValidYedVoucherCumulative(depositCents: number, cumulativeCents: number): boolean {
  return (
    Number.isInteger(depositCents) &&
    depositCents >= YED_MIN_OUTPUT_CENTS &&
    depositCents <= YED_MAX_OUTPUT_CENTS &&
    Number.isInteger(cumulativeCents) &&
    cumulativeCents >= YED_MIN_OUTPUT_CENTS &&
    cumulativeCents <= depositCents
  );
}

/**
 * The TRANSFER assignments of a YED voucher (or close) at `cumulativeCents` out of a channel holding
 * `depositCents`. serverCents + clientCents always equals the deposit, so yedOut = yedIn and nothing
 * burns; a client remainder below $1.00 goes to the server.
 *
 * @param depositCents - The channel deposit, in cents.
 * @param cumulativeCents - The voucher's cumulative amount, in cents.
 * @returns The server and client cents.
 * @throws RangeError on a cumulative below $1.00 or above the deposit, and on a deposit outside XFER-1.
 */
export function yedChannelSplit(depositCents: number, cumulativeCents: number): YedChannelSplit {
  checkDeposit(depositCents);
  if (!Number.isInteger(cumulativeCents)) throw new RangeError(`cumulative ${cumulativeCents} is not an integer`);
  if (cumulativeCents < YED_MIN_OUTPUT_CENTS) {
    throw new RangeError(`cumulative ${cumulativeCents} cents is below the $1.00 floor`);
  }
  if (cumulativeCents > depositCents) {
    throw new RangeError(`cumulative ${cumulativeCents} cents exceeds the deposit ${depositCents}`);
  }
  const remainder = depositCents - cumulativeCents;
  if (remainder < YED_MIN_OUTPUT_CENTS) return { serverCents: depositCents, clientCents: 0 };
  return { serverCents: cumulativeCents, clientCents: remainder };
}
