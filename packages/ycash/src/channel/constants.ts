// Channel protocol constants (specs/scheme_batch_settlement_ycash.md; plan §5.7).

/** Least t − tip a server accepts at open: about 24 h at 75 s. */
export const DEFAULT_MIN_LOCK_BLOCKS = 1152;
/** The server stops accepting vouchers and closes at t − this: about 2 h. */
export const DEFAULT_CLOSE_MARGIN_BLOCKS = 96;
/**
 * The close fee every voucher reserves, zatoshis: the fee floor of a one-input (~308 bytes, so 3
 * logical actions), two-output close (plan X-F3). SDK and server policy; neither node enforces it.
 */
export const DEFAULT_CLOSE_FEE = 1500n;
/**
 * An output below 54 zatoshis is dust and non-standard on both lines (plan X-F15): 3 × (34 + 148)
 * bytes at the 100 zat/kB minimum relay fee (ycash-dd/src/primitives/transaction.h:460-479).
 */
export const DUST_THRESHOLD = 54n;
/** nLockTime values from here on are Unix times (LOCKTIME_THRESHOLD, src/script/script.h). */
export const LOCKTIME_THRESHOLD = 500_000_000;
/** A non-final nSequence: CLTV needs one, or nLockTime is ignored (interpreter.cpp CheckLockTime). */
export const REFUND_SEQUENCE = 0xfffffffe;
