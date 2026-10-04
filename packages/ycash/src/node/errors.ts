// JSON-RPC error codes ycashd returns (src/rpc/protocol.h on both lines).
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_WALLET_ERROR = -4;
export const RPC_INVALID_ADDRESS_OR_KEY = -5;
export const RPC_VERIFY_ERROR = -25;
export const RPC_VERIFY_REJECTED = -26;
export const RPC_VERIFY_ALREADY_IN_CHAIN = -27;
export const RPC_IN_WARMUP = -28;

/** An error the node returned, or a transport failure (code 0 with `transport` set). */
export class RpcError extends Error {
  readonly code: number;
  readonly method: string;
  /** HTTP status, or undefined for a network or timeout failure. */
  readonly httpStatus: number | undefined;
  /** Set when the call never got a JSON-RPC answer (refused, timed out, unauthorised, not JSON). */
  readonly transport: boolean;

  /**
   * Builds an error from a JSON-RPC error object or a transport failure.
   *
   * @param code - The node's JSON-RPC error code, or 0 for a transport failure.
   * @param message - The node's error message.
   * @param method - The RPC method that failed.
   * @param opts - HTTP status, transport flag and underlying cause.
   * @param opts.httpStatus - The HTTP status, when a response arrived.
   * @param opts.transport - True when no JSON-RPC answer was received.
   * @param opts.cause - The underlying error.
   */
  constructor(code: number, message: string, method: string, opts: { httpStatus?: number; transport?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "RpcError";
    this.code = code;
    this.method = method;
    this.httpStatus = opts.httpStatus;
    this.transport = opts.transport ?? false;
  }
}

/** How a `sendrawtransaction` failure should be read by a facilitator. */
export type SendRawTransactionErrorKind =
  /** -27: every output of the tx is still unspent in the chain (`rawtransaction.cpp:1173-1178`). */
  | "already-in-chain"
  /** An input is already spent by another mempool transaction: no replace-by-fee on either line. */
  | "mempool-conflict"
  /** -25 "Missing inputs" or -26 "bad-txns-inputs-spent": an input is unknown or already spent in the chain. */
  | "missing-inputs"
  /** -26 "tx-expiring-soon" or an expired tx: nExpiryHeight is below next + 3. */
  | "expiring-soon"
  /** -26 any other consensus or policy rejection ("<code>: <reason>"). */
  | "rejected"
  /** Anything else (-25 with another reason, wallet guard, decode failure). */
  | "failed";

/** A `sendrawtransaction` refusal, with the reject code and reason parsed and classified into a {@link SendRawTransactionErrorKind}. */
export class SendRawTransactionError extends RpcError {
  readonly kind: SendRawTransactionErrorKind;
  /** The node's reject code (REJECT_*), when the message carries one ("18: txn-mempool-conflict"). */
  readonly rejectCode: number | undefined;
  readonly rejectReason: string;

  /**
   * Parses `"<code>: <reason>"` out of the node's message and classifies the failure.
   *
   * @param cause - The node's error from `sendrawtransaction`.
   */
  constructor(cause: RpcError) {
    super(cause.code, cause.message, cause.method, { httpStatus: cause.httpStatus, cause });
    this.name = "SendRawTransactionError";
    const parsed = /^(\d+): (.*)$/s.exec(cause.message);
    this.rejectCode = parsed ? Number(parsed[1]) : undefined;
    this.rejectReason = parsed ? (parsed[2] ?? "") : cause.message;
    this.kind = classifySendError(cause.code, this.rejectReason);
  }
}

/**
 * The two lines refuse a mempool double spend differently: 6.21.0 rejects it as
 * `-26 "18: txn-mempool-conflict"` (`ycash6/src/main.cpp:1839-1842`), while v4.5.0's
 * AcceptToMemoryPool returns false without setting a reason (`ycash-dd/src/main.cpp:1579-1583`),
 * which sendrawtransaction reports as `-25` with an empty message (`rawtransaction.cpp:1161-1166`).
 * This maps both forms (and the other refusals) to one kind.
 *
 * @param code - The node's JSON-RPC error code.
 * @param reason - The reject reason, without its `"<code>: "` prefix.
 * @returns How a facilitator should read the failure.
 */
export function classifySendError(code: number, reason: string): SendRawTransactionErrorKind {
  if (code === RPC_VERIFY_ALREADY_IN_CHAIN) return "already-in-chain";
  if (/txn-mempool-conflict/.test(reason)) return "mempool-conflict";
  if (code === RPC_VERIFY_ERROR && reason === "") return "mempool-conflict";
  if (code === RPC_VERIFY_ERROR && /^Missing inputs$/i.test(reason)) return "missing-inputs";
  if (/bad-txns-inputs-spent/.test(reason)) return "missing-inputs";
  if (/tx-expiring-soon|tx-overwinter-expired|expired/i.test(reason)) return "expiring-soon";
  if (code === RPC_VERIFY_REJECTED) return "rejected";
  return "failed";
}
