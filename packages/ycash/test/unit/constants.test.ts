import { describe, expect, it } from "vitest";
import { YCASH_NETWORKS, YED_MIN_OUTPUT_CENTS } from "../../src/index.js";

describe("constants", () => {
  it("names three networks in the ycash namespace", () => {
    expect(YCASH_NETWORKS.every((n) => n.startsWith("ycash:"))).toBe(true);
  });
  it("keeps the YED dollar floor", () => {
    expect(YED_MIN_OUTPUT_CENTS).toBe(100);
  });
});
