import { describe, expect, it } from "vitest";
import { yecToZat, zatToYecString } from "../../../src/node/index.js";

describe("YEC amounts", () => {
  it("formats zatoshis as the node's 8-decimal string", () => {
    expect(zatToYecString(250000n)).toBe("0.00250000");
    expect(zatToYecString(0)).toBe("0.00000000");
    expect(zatToYecString(2_100_000_000_000_000n)).toBe("21000000.00000000");
    expect(zatToYecString(-1n)).toBe("-0.00000001");
  });
  it("parses node amounts exactly, including float noise", () => {
    expect(yecToZat(5.9375)).toBe(593_750_000n);
    expect(yecToZat(0.1 + 0.2)).toBe(30_000_000n);
    expect(yecToZat("0.00000001")).toBe(1n);
    expect(yecToZat("12")).toBe(1_200_000_000n);
    expect(yecToZat(-0.5)).toBe(-50_000_000n);
  });
  it("refuses a non-amount", () => {
    expect(() => yecToZat("1e-8")).toThrow(RangeError);
    expect(() => yecToZat("0.000000001")).toThrow(RangeError);
  });
  it("round-trips", () => {
    for (const z of [1n, 99n, 100_000_000n, 123_456_789_012n]) expect(yecToZat(zatToYecString(z))).toBe(z);
  });
});
