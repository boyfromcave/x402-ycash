// The Yellowback payload codec, version 3: "YB" || 0x03 || type || body, the data of a
// transaction's only OP_RETURN output. Translation source: ycash-dd/src/yellowback/payload.{h,cpp}
// (identical on ycash6). The node's decoder is the parse the overlay applies, so this file keeps its
// structure: a bounds-checked little-endian reader, one body per type, never a throw on decode.
//
// A decoded payload is for building and checking a client's transaction only. The verdict on a
// transaction (OK, BURNED, ...) comes from the node (`yed_validaterawtransaction`), never from here.

/** PAYLOAD_MAGIC_0, PAYLOAD_MAGIC_1 (ycash-dd/src/yellowback/params.h:44-45): "YB". */
export const PAYLOAD_MAGIC = Uint8Array.of(0x59, 0x42);
/** PAYLOAD_VERSION (params.h:46). Versions 1, 2 and later than 3 are non-Yellowback (V23). */
export const PAYLOAD_VERSION = 0x03;
/** MIN_PAYLOAD (params.h:51): the four-byte header alone. */
export const MIN_PAYLOAD = 4;
/** MAX_PAYLOAD (params.h:50): the OP_RETURN data cap. */
export const MAX_PAYLOAD = 80;
/** MAX_ASSIGNMENTS (payload.h:82-83): TRANSFER, 5 + 5 * count <= 80. */
export const MAX_ASSIGNMENTS = 15;
/** MAX_REDEEM_ASSIGNMENTS (payload.h:84-85): REDEEM, 11 + 5 * count <= 80. */
export const MAX_REDEEM_ASSIGNMENTS = 13;
/** FEE_VOUT_NONE (params.h:87): "no such fee output" in MINT and REDEEM. */
export const FEE_VOUT_NONE = 0xff;

/** PayloadType (payload.h:61-69). 0x04, 0x09-0xFF are reserved: non-Yellowback. */
export const PayloadType = {
  MINT: 0x01,
  TRANSFER: 0x02,
  REDEEM: 0x03,
  ATTESTOR_REGISTER: 0x05,
  CLAIM_NOTICE: 0x06,
  EQUIVOCATION: 0x07,
  ATTESTOR_REVIVE: 0x08,
} as const;
export type PayloadTypeByte = (typeof PayloadType)[keyof typeof PayloadType];

/** PayloadTypeName (payload.cpp:432-444): the strings the node's RPCs print. */
export type PayloadTypeName =
  | "mint"
  | "transfer"
  | "redeem"
  | "register"
  | "notice"
  | "equivocation"
  | "revive";

const TYPE_NAMES: ReadonlyMap<number, PayloadTypeName> = new Map([
  [PayloadType.MINT, "mint"],
  [PayloadType.TRANSFER, "transfer"],
  [PayloadType.REDEEM, "redeem"],
  [PayloadType.ATTESTOR_REGISTER, "register"],
  [PayloadType.CLAIM_NOTICE, "notice"],
  [PayloadType.EQUIVOCATION, "equivocation"],
  [PayloadType.ATTESTOR_REVIVE, "revive"],
]);

/** The node's name for a type byte, or undefined for a reserved one. */
export function payloadTypeName(typeByte: number): PayloadTypeName | undefined {
  return TYPE_NAMES.get(typeByte);
}

/** One (vout, cents) assignment of a TRANSFER or REDEEM body. */
export interface Assignment {
  readonly vout: number;
  readonly cents: number;
}

export interface TransferPayload {
  readonly type: "transfer";
  readonly assignments: readonly Assignment[];
}
export interface RedeemPayload {
  readonly type: "redeem";
  readonly refHeight: number;
  readonly feeVout: number;
  readonly attestFeeVout: number;
  readonly assignments: readonly Assignment[];
}
export interface MintPayload {
  readonly type: "mint";
  readonly termClass: number;
  readonly cents: number;
  readonly lockHeight: number;
  readonly refHeight: number;
  /** Any 33 bytes; the overlay's MINT-3 judges whether they are a key. */
  readonly ownerKey: Uint8Array;
  readonly feeVout: number;
  readonly attestFeeVout: number;
}
export interface RegisterPayload {
  readonly type: "register";
  readonly attestorKey: Uint8Array;
  readonly bondKey: Uint8Array;
  readonly bondLocktime: number;
  readonly flags: number;
}
export interface NoticePayload {
  readonly type: "notice";
  /** Display order (RPC) hex; the payload carries the 32 internal bytes, reversed here. */
  readonly vaultTxid: string;
  readonly vaultVout: number;
  readonly refHeight: number;
}
export interface EquivocationPayload {
  readonly type: "equivocation";
}
export interface RevivePayload {
  readonly type: "revive";
  readonly seq: number;
  readonly priceMicroUsd: number;
  readonly citedHeight: number;
  readonly sig: Uint8Array;
}
export type Payload =
  | TransferPayload
  | RedeemPayload
  | MintPayload
  | RegisterPayload
  | NoticePayload
  | EquivocationPayload
  | RevivePayload;

/** Why a byte string is not a Yellowback payload. Every case is "non-Yellowback" to the node. */
export type PayloadDecodeError =
  | "payload_too_short"
  | "payload_too_long"
  | "payload_bad_magic"
  | "payload_unsupported_version"
  | "payload_reserved_type"
  | "payload_bad_length"
  | "payload_too_many_assignments"
  | "payload_zero_cents"
  | "payload_duplicate_vout";

export interface PayloadError {
  readonly error: PayloadDecodeError;
}

export function isPayloadError(x: Payload | PayloadError): x is PayloadError {
  return "error" in x;
}

const KEY_SIZE = 33;
const MINT_BODY_SIZE = 1 + 4 + 4 + 4 + KEY_SIZE + 1 + 1; // 48 (payload.cpp:17)
const REDEEM_HEAD_SIZE = 4 + 1 + 1 + 1; // payload.cpp:18
const REGISTER_BODY_SIZE = KEY_SIZE + KEY_SIZE + 4 + 1; // 71
const NOTICE_BODY_SIZE = 32 + 1 + 4; // 37
const REVIVE_BODY_SIZE = 2 + 4 + 4 + 64; // 74
const U32_MAX = 0xffff_ffff;

/** Bounds-checked little-endian reader. Callers check sizes first, so a short read is a bug guard. */
class Reader {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}
  u8(): number {
    const v = this.data[this.pos];
    if (v === undefined) throw new RangeError("short read");
    this.pos += 1;
    return v;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    // >>> 0 keeps the top byte unsigned.
    return (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.data.length) throw new RangeError("short read");
    const out = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  atEnd(): boolean {
    return this.pos === this.data.length;
  }
}

/** ValidAssignments (payload.cpp:90-99): no zero cents, no duplicate vout, in that order. */
function assignmentsError(assignments: readonly Assignment[]): PayloadDecodeError | undefined {
  const seen = new Set<number>();
  for (const a of assignments) {
    if (a.cents === 0) return "payload_zero_cents";
    if (seen.has(a.vout)) return "payload_duplicate_vout";
    seen.add(a.vout);
  }
  return undefined;
}

function readAssignments(r: Reader, count: number): Assignment[] {
  const out: Assignment[] = [];
  for (let i = 0; i < count; i++) out.push({ vout: r.u8(), cents: r.u32() });
  return out;
}

function toHexReversed(b: Uint8Array): string {
  let s = "";
  for (let i = b.length - 1; i >= 0; i--) s += (b[i] as number).toString(16).padStart(2, "0");
  return s;
}

/** DecodeBodyV3 (payload.cpp:239-301). `size` is the whole payload's length. */
function decodeBody(r: Reader, type: number, size: number): Payload | PayloadError {
  const bad = (error: PayloadDecodeError): PayloadError => ({ error });
  switch (type) {
    case PayloadType.MINT:
      if (size !== 4 + MINT_BODY_SIZE) return bad("payload_bad_length");
      return {
        type: "mint",
        termClass: r.u8(),
        cents: r.u32(),
        lockHeight: r.u32(),
        refHeight: r.u32(),
        ownerKey: r.bytes(KEY_SIZE),
        feeVout: r.u8(),
        attestFeeVout: r.u8(),
      };
    case PayloadType.TRANSFER: {
      if (size < 5) return bad("payload_bad_length");
      const count = r.u8();
      if (count > MAX_ASSIGNMENTS) return bad("payload_too_many_assignments");
      if (size !== 5 + 5 * count) return bad("payload_bad_length");
      const assignments = readAssignments(r, count);
      const e = assignmentsError(assignments);
      return e ? bad(e) : { type: "transfer", assignments };
    }
    case PayloadType.REDEEM: {
      if (size < 4 + REDEEM_HEAD_SIZE) return bad("payload_bad_length");
      const refHeight = r.u32();
      const feeVout = r.u8();
      const attestFeeVout = r.u8();
      const count = r.u8();
      if (count > MAX_REDEEM_ASSIGNMENTS) return bad("payload_too_many_assignments");
      if (size !== 4 + REDEEM_HEAD_SIZE + 5 * count) return bad("payload_bad_length");
      const assignments = readAssignments(r, count);
      const e = assignmentsError(assignments);
      return e ? bad(e) : { type: "redeem", refHeight, feeVout, attestFeeVout, assignments };
    }
    case PayloadType.ATTESTOR_REGISTER:
      if (size !== 4 + REGISTER_BODY_SIZE) return bad("payload_bad_length");
      return {
        type: "register",
        attestorKey: r.bytes(KEY_SIZE),
        bondKey: r.bytes(KEY_SIZE),
        bondLocktime: r.u32(),
        flags: r.u8(),
      };
    case PayloadType.CLAIM_NOTICE:
      if (size !== 4 + NOTICE_BODY_SIZE) return bad("payload_bad_length");
      return { type: "notice", vaultTxid: toHexReversed(r.bytes(32)), vaultVout: r.u8(), refHeight: r.u32() };
    case PayloadType.EQUIVOCATION:
      if (size !== 4) return bad("payload_bad_length");
      return { type: "equivocation" };
    case PayloadType.ATTESTOR_REVIVE:
      if (size !== 4 + REVIVE_BODY_SIZE) return bad("payload_bad_length");
      return { type: "revive", seq: r.u16(), priceMicroUsd: r.u32(), citedHeight: r.u32(), sig: r.bytes(64) };
    default:
      return bad("payload_reserved_type"); // forward-compatibility rule: non-Yellowback
  }
}

/**
 * DecodePayload (payload.cpp:365-381): the payload, or the reason the bytes are non-Yellowback.
 * Checks that need the transaction (the vout exists and is not the OP_RETURN) are in findPayload.
 */
export function decodePayload(data: Uint8Array): Payload | PayloadError {
  if (data.length < MIN_PAYLOAD) return { error: "payload_too_short" };
  if (data.length > MAX_PAYLOAD) return { error: "payload_too_long" };
  if (data[0] !== PAYLOAD_MAGIC[0] || data[1] !== PAYLOAD_MAGIC[1]) return { error: "payload_bad_magic" };
  const r = new Reader(data);
  r.u8();
  r.u8();
  const version = r.u8();
  const type = r.u8();
  if (version !== PAYLOAD_VERSION) return { error: "payload_unsupported_version" };
  const p = decodeBody(r, type, data.length);
  if (isPayloadError(p)) return p;
  if (!r.atEnd()) return { error: "payload_bad_length" }; // unreachable after the size checks; kept as the node keeps it
  return p;
}

function checkAssignmentShape(a: Assignment, i: number): void {
  if (!Number.isInteger(a.vout) || a.vout < 0 || a.vout > 0xff) {
    throw new RangeError(`assignment ${i}: vout ${a.vout} is not a u8`);
  }
  if (!Number.isInteger(a.cents) || a.cents < 0 || a.cents > U32_MAX) {
    throw new RangeError(`assignment ${i}: cents ${a.cents} is not a u32`);
  }
}

/**
 * EncodePayload for a TRANSFER (payload.cpp:324-327); mirrors `encode_transfer_v3`
 * (ycash-dd/qa/rpc-tests/test_framework/yellowback_attest.py:360). Throws where the node's encoder
 * returns an empty vector: more than 15 assignments, a zero cents or a duplicate vout. The overlay's
 * range rule (XFER-1, $1.00 to $100,000) is not a codec rule: see validateTransferAssignments.
 */
export function encodeTransferPayload(assignments: readonly Assignment[]): Uint8Array {
  if (assignments.length > MAX_ASSIGNMENTS) {
    throw new RangeError(`a TRANSFER holds at most ${MAX_ASSIGNMENTS} assignments, got ${assignments.length}`);
  }
  assignments.forEach(checkAssignmentShape);
  const e = assignmentsError(assignments);
  if (e) throw new RangeError(`TRANSFER not encodable: ${e}`);
  const out = new Uint8Array(5 + 5 * assignments.length);
  out.set(PAYLOAD_MAGIC, 0);
  out[2] = PAYLOAD_VERSION;
  out[3] = PayloadType.TRANSFER;
  out[4] = assignments.length;
  assignments.forEach((a, i) => {
    const o = 5 + 5 * i;
    out[o] = a.vout;
    new DataView(out.buffer).setUint32(o + 1, a.cents, true);
  });
  return out;
}
