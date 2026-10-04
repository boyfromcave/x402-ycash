import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { YED_MAX_OUTPUT_CENTS, YED_MIN_OUTPUT_CENTS } from "../../src/constants.js";
import {
  isValidYedVoucherCumulative,
  validateTransferAssignments,
  yedChannelSplit,
} from "../../src/yed/index.js";

describe("validateTransferAssignments", () => {
  // outputs: 0 server, 1 client, 2 OP_RETURN
  const ok = [
    { vout: 0, cents: 150 },
    { vout: 1, cents: 1850 },
  ];
  it("accepts a well-formed transfer and reports its total", () => {
    expect(validateTransferAssignments(ok, 3, 2)).toEqual({ valid: true, totalCents: 2000 });
    expect(validateTransferAssignments(ok, 3, 2, { yedInCents: 2000 })).toEqual({ valid: true, totalCents: 2000 });
  });
  it("enforces XFER-1 at both ends of [$1.00, $100,000]", () => {
    expect(validateTransferAssignments([{ vout: 0, cents: YED_MIN_OUTPUT_CENTS }], 2, 1).valid).toBe(true);
    expect(validateTransferAssignments([{ vout: 0, cents: YED_MAX_OUTPUT_CENTS }], 2, 1).valid).toBe(true);
    expect(validateTransferAssignments([{ vout: 0, cents: 99 }], 2, 1)).toEqual({
      valid: false,
      error: "cents_out_of_range",
      assignment: 0,
    });
    expect(validateTransferAssignments([{ vout: 0, cents: YED_MAX_OUTPUT_CENTS + 1 }], 2, 1)).toMatchObject({
      error: "cents_out_of_range",
    });
    expect(validateTransferAssignments([{ vout: 0, cents: 100.5 }], 2, 1)).toMatchObject({ error: "cents_out_of_range" });
  });
  it("enforces the transaction-shape rules of FindPayload", () => {
    expect(validateTransferAssignments([], 3, 2)).toEqual({ valid: false, error: "no_assignments" });
    expect(validateTransferAssignments([{ vout: 3, cents: 100 }], 3, 2)).toMatchObject({ error: "vout_out_of_range" });
    expect(validateTransferAssignments([{ vout: 2, cents: 100 }], 3, 2)).toMatchObject({ error: "vout_is_op_return" });
    expect(validateTransferAssignments([{ vout: -1, cents: 100 }], 3, 2)).toMatchObject({ error: "vout_not_u8" });
    expect(
      validateTransferAssignments(
        [
          { vout: 0, cents: 100 },
          { vout: 0, cents: 100 },
        ],
        3,
        2,
      ),
    ).toEqual({ valid: false, error: "duplicate_vout", assignment: 1 });
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ vout: i, cents: 100 }));
    expect(validateTransferAssignments(sixteen, 20, 19)).toMatchObject({ error: "too_many_assignments" });
  });
  it("with yedIn, refuses XFER-2 and any partial burn", () => {
    expect(validateTransferAssignments(ok, 3, 2, { yedInCents: 1999 })).toMatchObject({ error: "over_assigned" });
    expect(validateTransferAssignments(ok, 3, 2, { yedInCents: 2001 })).toMatchObject({ error: "under_assigned" });
    expect(validateTransferAssignments([{ vout: 0, cents: 100 }], 2, 1, { yedInCents: 0 })).toMatchObject({
      error: "over_assigned",
    });
  });
});

describe("yedChannelSplit (the dollar floor, X-7)", () => {
  it("pays the cumulative to the server and the rest to the client", () => {
    expect(yedChannelSplit(2000, 100)).toEqual({ serverCents: 100, clientCents: 1900 });
    expect(yedChannelSplit(2000, 1900)).toEqual({ serverCents: 1900, clientCents: 100 });
  });
  it("assigns all of the deposit to the server at cumulative = deposit", () => {
    expect(yedChannelSplit(2000, 2000)).toEqual({ serverCents: 2000, clientCents: 0 });
  });
  it("gives a client remainder in (0, $1.00) to the server, never to a burn", () => {
    expect(yedChannelSplit(2000, 1901)).toEqual({ serverCents: 2000, clientCents: 0 });
    expect(yedChannelSplit(2000, 1999)).toEqual({ serverCents: 2000, clientCents: 0 });
  });
  it("keeps yedOut = yedIn for every cumulative", () => {
    for (let c = 100; c <= 1000; c++) {
      const s = yedChannelSplit(1000, c);
      expect(s.serverCents + s.clientCents).toBe(1000);
      expect(s.serverCents).toBeGreaterThanOrEqual(YED_MIN_OUTPUT_CENTS);
      expect(s.clientCents === 0 || s.clientCents >= YED_MIN_OUTPUT_CENTS).toBe(true);
    }
  });
  it("throws below the floor, above the deposit, and on a deposit outside XFER-1", () => {
    expect(() => yedChannelSplit(2000, 99)).toThrow(/floor/);
    expect(() => yedChannelSplit(2000, 2001)).toThrow(/exceeds/);
    expect(() => yedChannelSplit(99, 99)).toThrow(/deposit/);
    expect(() => yedChannelSplit(YED_MAX_OUTPUT_CENTS + 1, 100)).toThrow(/deposit/);
    expect(() => yedChannelSplit(2000, 150.5)).toThrow(/integer/);
  });
});

describe("isValidYedVoucherCumulative", () => {
  it("accepts [$1.00, deposit] and nothing else", () => {
    expect(isValidYedVoucherCumulative(2000, 100)).toBe(true);
    expect(isValidYedVoucherCumulative(2000, 1950)).toBe(true);
    expect(isValidYedVoucherCumulative(2000, 2000)).toBe(true);
    expect(isValidYedVoucherCumulative(2000, 99)).toBe(false);
    expect(isValidYedVoucherCumulative(2000, 2001)).toBe(false);
    expect(isValidYedVoucherCumulative(2000, 100.5)).toBe(false);
    expect(isValidYedVoucherCumulative(50, 50)).toBe(false);
  });
});

describe("vectors: dollar floor", () => {
  const v = JSON.parse(
    readFileSync(new URL("../../../../vectors/yed/dollar_floor.json", import.meta.url), "utf8"),
  ) as {
    split: { depositCents: number; cumulativeCents: number; serverCents?: number; clientCents?: number; throws?: boolean }[];
  };
  it.each(v.split)("D=$depositCents c=$cumulativeCents", (c) => {
    if (c.throws) {
      expect(() => yedChannelSplit(c.depositCents, c.cumulativeCents)).toThrow(RangeError);
      expect(isValidYedVoucherCumulative(c.depositCents, c.cumulativeCents)).toBe(false);
    } else {
      expect(yedChannelSplit(c.depositCents, c.cumulativeCents)).toEqual({
        serverCents: c.serverCents,
        clientCents: c.clientCents,
      });
      expect(isValidYedVoucherCumulative(c.depositCents, c.cumulativeCents)).toBe(true);
    }
  });
});
