// Cross-check against vectors/yed/transfer_v3.json, generated from the node's qa framework
// (encode_transfer_v3, decode_payload, tx_payload). The node, its Python twin and this codec must agree.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Assignment,
  type Payload,
  decodePayload,
  encodeTransferPayload,
  findPayload,
  isFindPayloadFailure,
  isPayloadError,
  transferOpReturnScript,
} from "../../src/yed/index.js";

interface Vectors {
  encode: { name: string; assignments: Assignment[]; data: string; script: string }[];
  decode: { name: string; data: string; payload: Record<string, unknown> | null }[];
  find: { name: string; outputs: string[]; opReturnIndex: number | null; payload: Record<string, unknown> | null }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("../../../../vectors/yed/transfer_v3.json", import.meta.url), "utf8"),
) as Vectors;

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));

/** The payload as the vector file writes it: byte fields as hex. */
function asJson(p: Payload): Record<string, unknown> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v instanceof Uint8Array ? hex(v) : v]));
}

describe("vectors: encode_transfer_v3", () => {
  it.each(vectors.encode)("$name", (v) => {
    expect(hex(encodeTransferPayload(v.assignments))).toBe(v.data);
    expect(hex(transferOpReturnScript(v.assignments))).toBe(v.script);
  });
});

describe("vectors: decode_payload", () => {
  it.each(vectors.decode)("$name", (v) => {
    const p = decodePayload(unhex(v.data));
    if (v.payload === null) {
      expect(isPayloadError(p)).toBe(true);
    } else {
      expect(isPayloadError(p)).toBe(false);
      expect(asJson(p as Payload)).toEqual(v.payload);
    }
  });
});

describe("vectors: tx_payload (FindPayload)", () => {
  it.each(vectors.find)("$name", (v) => {
    const r = findPayload(v.outputs.map((s) => ({ scriptPubKey: unhex(s) })));
    if (v.payload === null) {
      if (v.opReturnIndex === null) {
        // no OP_RETURN (null) or more than one (a failure with no index)
        expect(r === null || (isFindPayloadFailure(r) && r.index === null)).toBe(true);
      } else {
        expect(r !== null && isFindPayloadFailure(r) && r.index === v.opReturnIndex).toBe(true);
      }
    } else {
      expect(r !== null && !isFindPayloadFailure(r)).toBe(true);
      if (r === null || isFindPayloadFailure(r)) return;
      expect(r.index).toBe(v.opReturnIndex);
      expect(asJson(r.payload)).toEqual(v.payload);
    }
  });
});
