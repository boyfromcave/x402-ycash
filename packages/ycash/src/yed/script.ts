// Finding a transaction's Yellowback payload in its output scripts: ExtractOpReturnData,
// FindOpReturn and FindPayload (ycash-dd/src/yellowback/payload.cpp:383-430, identical on ycash6).

import {
  type Assignment,
  type Payload,
  type PayloadDecodeError,
  MAX_PAYLOAD,
  MIN_PAYLOAD,
  decodePayload,
  encodeTransferPayload,
  isPayloadError,
} from "./payload.js";

export const OP_RETURN = 0x6a;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;

/**
 * The canonical (minimal) push, as CScript << vector writes it. The SDK only ever writes this form:
 * a non-minimal push of 80 bytes would make the script 84 bytes, over the 83-byte relay limit
 * (MAX_OP_RETURN_RELAY, ycash-dd/src/script/standard.h:34, ycash6 :26), although the overlay accepts it.
 *
 * @param data - The payload, 1..255 bytes.
 * @returns The push opcode followed by the data.
 * @throws RangeError when `data` is empty or longer than 255 bytes.
 */
function minimalPush(data: Uint8Array): Uint8Array {
  const n = data.length;
  if (n === 0 || n > 0xff) throw new RangeError(`payload push of ${n} bytes`); // payloads are 4..80
  const head = n < OP_PUSHDATA1 ? Uint8Array.of(n) : Uint8Array.of(OP_PUSHDATA1, n);
  const out = new Uint8Array(head.length + n);
  out.set(head, 0);
  out.set(data, head.length);
  return out;
}

/**
 * PayloadScript (payload.cpp:383-386): OP_RETURN <push>.
 *
 * @param data - The encoded payload.
 * @returns The OP_RETURN output script.
 */
export function payloadScript(data: Uint8Array): Uint8Array {
  const push = minimalPush(data);
  const out = new Uint8Array(1 + push.length);
  out[0] = OP_RETURN;
  out.set(push, 1);
  return out;
}

/**
 * The OP_RETURN output script carrying a TRANSFER payload for these assignments.
 *
 * @param assignments - The (vout, cents) pairs.
 * @returns The OP_RETURN output script.
 * @throws RangeError when the assignments are not encodable.
 */
export function transferOpReturnScript(assignments: readonly Assignment[]): Uint8Array {
  return payloadScript(encodeTransferPayload(assignments));
}

/**
 * ExtractOpReturnData (payload.cpp:388-401): the pushed bytes when `script` is exactly
 * OP_RETURN followed by one data push (direct, PUSHDATA1, 2 or 4) of 4..80 bytes that ends the
 * script.
 *
 * @param script - An output script.
 * @returns The pushed bytes, or undefined for any other shape (no push, OP_0, OP_N, two pushes, a
 * truncated push, a size outside 4..80).
 */
export function extractOpReturnData(script: Uint8Array): Uint8Array | undefined {
  if (script.length < 1 || script[0] !== OP_RETURN) return undefined;
  let pc = 1;
  const op = script[pc++];
  if (op === undefined || op > OP_PUSHDATA4) return undefined;
  let size: number;
  if (op < OP_PUSHDATA1) {
    size = op;
  } else {
    const width = op === OP_PUSHDATA1 ? 1 : op === OP_PUSHDATA2 ? 2 : 4;
    if (script.length - pc < width) return undefined;
    size = 0;
    for (let i = width - 1; i >= 0; i--) size = size * 256 + (script[pc + i] as number);
    pc += width;
  }
  if (script.length - pc < size) return undefined; // GetOp fails on a truncated push
  if (size === 0) return undefined; // OP_0 or an empty PUSHDATA pushes no data
  if (pc + size !== script.length) return undefined; // a second op follows
  if (size < MIN_PAYLOAD || size > MAX_PAYLOAD) return undefined;
  return script.slice(pc, pc + size);
}

/** An output as the codec needs it: only its script. */
export interface ScriptOutput {
  readonly scriptPubKey: Uint8Array;
}

/**
 * FindOpReturn (payload.cpp:403-414): any script starting with OP_RETURN counts, well-formed or not.
 *
 * @param outputs - The transaction's outputs.
 * @returns The indices of the OP_RETURN outputs.
 */
function opReturnIndices(outputs: readonly ScriptOutput[]): number[] {
  const found: number[] = [];
  outputs.forEach((o, i) => {
    if (o.scriptPubKey.length >= 1 && o.scriptPubKey[0] === OP_RETURN) found.push(i);
  });
  return found;
}

export interface FoundPayload {
  /** The OP_RETURN output's index. */
  readonly index: number;
  readonly payload: Payload;
}

export type FindPayloadError =
  | "multiple_op_return"
  | "op_return_shape"
  | PayloadDecodeError
  | "assignment_vout_out_of_range"
  | "assignment_vout_is_op_return";

/** The transaction has an OP_RETURN, but no Yellowback payload: the node treats it as non-Yellowback. */
export interface FindPayloadFailure {
  readonly error: FindPayloadError;
  /** The OP_RETURN's index; null when there is more than one. */
  readonly index: number | null;
}

/**
 * Narrows a non-null findPayload result to the failure case.
 *
 * @param x - A non-null findPayload result.
 * @returns True when the OP_RETURN carries no Yellowback payload.
 */
export function isFindPayloadFailure(x: FoundPayload | FindPayloadFailure): x is FindPayloadFailure {
  return "error" in x;
}

/**
 * FindPayload (payload.cpp:416-430). null when no output is an OP_RETURN; a failure (with the
 * reason) when there is one but it carries no Yellowback payload; otherwise the payload and the
 * OP_RETURN's index. Either non-success outcome means the same to the overlay: non-Yellowback for
 * outputs, so any YED the transaction spends burns (state.cpp:860-865).
 *
 * @param outputs - The transaction's outputs.
 * @returns The payload and its index, a failure with its reason, or null.
 */
export function findPayload(outputs: readonly ScriptOutput[]): FoundPayload | FindPayloadFailure | null {
  const idx = opReturnIndices(outputs);
  if (idx.length === 0) return null;
  if (idx.length > 1) return { error: "multiple_op_return", index: null };
  const index = idx[0] as number;
  const data = extractOpReturnData((outputs[index] as ScriptOutput).scriptPubKey);
  if (!data) return { error: "op_return_shape", index };
  const payload = decodePayload(data);
  if (isPayloadError(payload)) return { error: payload.error, index };
  if (payload.type === "transfer" || payload.type === "redeem") {
    for (const a of payload.assignments) {
      if (a.vout >= outputs.length) return { error: "assignment_vout_out_of_range", index };
      if (a.vout === index) return { error: "assignment_vout_is_op_return", index };
    }
  }
  return { index, payload };
}
