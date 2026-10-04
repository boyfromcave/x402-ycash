import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD,
  PayloadType,
  decodePayload,
  encodeTransferPayload,
  extractOpReturnData,
  findPayload,
  isFindPayloadFailure,
  isPayloadError,
  payloadScript,
  payloadTypeName,
  transferOpReturnScript,
} from "../../src/yed/index.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const P2PKH = unhex("76a914" + "11".repeat(20) + "88ac");

describe("encodeTransferPayload", () => {
  it("writes magic, version 3, type 0x02, count, then (vout u8, cents u32 LE)", () => {
    expect(hex(encodeTransferPayload([{ vout: 1, cents: 0x01020304 }]))).toBe("59420302" + "01" + "01" + "04030201");
  });
  it("is 5 + 5n bytes and fits the 80-byte cap at n = 15", () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => ({ vout: i, cents: 100 }));
    expect(encodeTransferPayload(fifteen).length).toBe(MAX_PAYLOAD);
  });
  it("refuses 16 assignments, zero cents, a duplicate vout, a non-u8 vout and a non-u32 cents", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ vout: i, cents: 100 }));
    expect(() => encodeTransferPayload(sixteen)).toThrow(RangeError);
    expect(() => encodeTransferPayload([{ vout: 0, cents: 0 }])).toThrow(/zero_cents/);
    expect(() => encodeTransferPayload([{ vout: 0, cents: 100 }, { vout: 0, cents: 200 }])).toThrow(/duplicate/);
    expect(() => encodeTransferPayload([{ vout: 256, cents: 100 }])).toThrow(/u8/);
    expect(() => encodeTransferPayload([{ vout: 0, cents: 2 ** 32 }])).toThrow(/u32/);
    expect(() => encodeTransferPayload([{ vout: 0, cents: 1.5 }])).toThrow(/u32/);
  });
  it("round-trips through decodePayload", () => {
    const assignments = [{ vout: 3, cents: 4_000_000_000 }, { vout: 0, cents: 100 }];
    expect(decodePayload(encodeTransferPayload(assignments))).toEqual({ type: "transfer", assignments });
  });
});

describe("decodePayload", () => {
  const good = encodeTransferPayload([{ vout: 0, cents: 100 }]);
  it("names each failure", () => {
    expect(decodePayload(good.slice(0, 3))).toEqual({ error: "payload_too_short" });
    expect(decodePayload(new Uint8Array(81))).toEqual({ error: "payload_too_long" });
    expect(decodePayload(unhex("5943" + hex(good).slice(4)))).toEqual({ error: "payload_bad_magic" });
    expect(decodePayload(unhex("594202" + hex(good).slice(6)))).toEqual({ error: "payload_unsupported_version" });
    expect(decodePayload(unhex("59420304" + hex(good).slice(8)))).toEqual({ error: "payload_reserved_type" });
    expect(decodePayload(unhex(hex(good) + "00"))).toEqual({ error: "payload_bad_length" });
    expect(decodePayload(unhex("5942030201" + "00" + "00000000"))).toEqual({ error: "payload_zero_cents" });
    expect(decodePayload(unhex("5942030202" + "0164000000" + "01c8000000"))).toEqual({
      error: "payload_duplicate_vout",
    });
  });
  it("reports a count over 15 before the length (both are non-Yellowback)", () => {
    expect(decodePayload(unhex("5942030210" + "00".repeat(20)))).toEqual({ error: "payload_too_many_assignments" });
  });
  it("names every assigned type as the node's PayloadTypeName does", () => {
    expect(Object.values(PayloadType).map(payloadTypeName)).toEqual([
      "mint",
      "transfer",
      "redeem",
      "register",
      "notice",
      "equivocation",
      "revive",
    ]);
    expect(payloadTypeName(0x04)).toBeUndefined();
    expect(decodePayload(unhex("59420307"))).toEqual({ type: "equivocation" });
  });
});

describe("OP_RETURN scripts", () => {
  it("uses a direct push up to 75 bytes and OP_PUSHDATA1 above", () => {
    const fourteen = Array.from({ length: 14 }, (_, i) => ({ vout: i, cents: 100 }));
    const fifteen = Array.from({ length: 15 }, (_, i) => ({ vout: i, cents: 100 }));
    expect(hex(transferOpReturnScript(fourteen).slice(0, 2))).toBe("6a4b");
    expect(hex(transferOpReturnScript(fifteen).slice(0, 3))).toBe("6a4c50");
    // 83 bytes: exactly MAX_OP_RETURN_RELAY, so the largest TRANSFER still relays
    expect(transferOpReturnScript(fifteen).length).toBe(83);
  });
  it("extracts what payloadScript wrote", () => {
    const data = encodeTransferPayload([{ vout: 1, cents: 250 }]);
    expect(extractOpReturnData(payloadScript(data))).toEqual(data);
  });
  it("rejects a PUSHDATA1 of zero bytes and a PUSHDATA2 with a short length field", () => {
    expect(extractOpReturnData(unhex("6a4c00"))).toBeUndefined();
    expect(extractOpReturnData(unhex("6a4d05"))).toBeUndefined();
  });
});

describe("findPayload", () => {
  const opret = transferOpReturnScript([{ vout: 0, cents: 100 }]);
  it("returns null for a transaction with no OP_RETURN", () => {
    expect(findPayload([{ scriptPubKey: P2PKH }])).toBeNull();
  });
  it("finds the payload at any vout", () => {
    expect(findPayload([{ scriptPubKey: P2PKH }, { scriptPubKey: opret }])).toEqual({
      index: 1,
      payload: { type: "transfer", assignments: [{ vout: 0, cents: 100 }] },
    });
  });
  it("names why a transaction with an OP_RETURN has no payload", () => {
    const r = (outputs: Uint8Array[]) => findPayload(outputs.map((scriptPubKey) => ({ scriptPubKey })));
    expect(r([P2PKH, opret, opret])).toEqual({ error: "multiple_op_return", index: null });
    expect(r([P2PKH, unhex("6a")])).toEqual({ error: "op_return_shape", index: 1 });
    expect(r([opret])).toEqual({ error: "assignment_vout_is_op_return", index: 0 });
    expect(r([transferOpReturnScript([{ vout: 2, cents: 100 }]), P2PKH])).toEqual({
      error: "assignment_vout_out_of_range",
      index: 0,
    });
    const v4 = unhex("6a05" + "5942" + "04" + "02" + "00"); // a version-4 header: non-Yellowback
    const out = r([P2PKH, v4]);
    expect(out !== null && isFindPayloadFailure(out) && out.error).toBe("payload_unsupported_version");
  });
  it("leaves unassigned outputs alone and treats a non-transfer payload as found", () => {
    const equivocation = payloadScript(unhex("59420307"));
    const found = findPayload([{ scriptPubKey: equivocation }]);
    expect(found !== null && !isFindPayloadFailure(found) && found.payload.type).toBe("equivocation");
    expect(isPayloadError({ type: "equivocation" })).toBe(false);
  });
});
