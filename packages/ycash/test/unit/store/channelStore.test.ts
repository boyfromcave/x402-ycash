import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileChannelStore, InMemoryChannelStore, type ChannelStore } from "../../../src/index.js";

const stores: [string, () => ChannelStore][] = [
  ["InMemoryChannelStore", () => new InMemoryChannelStore()],
  ["FileChannelStore", () => new FileChannelStore(join(mkdtempSync(join(tmpdir(), "x402-chan-")), "channels.json"))],
];

describe.each(stores)("%s", (_name, make) => {
  it("opens a channel once and reads it back", async () => {
    const s = make();
    expect(await s.open({ channelId: "c", cumulative: 0n, data: { funding: "tx:0" } })).toBe(true);
    expect(await s.open({ channelId: "c", cumulative: 5n })).toBe(false);
    expect(await s.get("c")).toEqual({ channelId: "c", cumulative: 0n, data: { funding: "tx:0" } });
    expect(await s.get("unknown")).toBeUndefined();
  });

  it("advances cumulative only from the expected value", async () => {
    const s = make();
    await s.open({ channelId: "c", cumulative: 0n });
    expect(await s.compareAndSetCumulative("c", 0n, 100n)).toBe(true);
    expect(await s.compareAndSetCumulative("c", 0n, 200n)).toBe(false);
    expect((await s.get("c"))?.cumulative).toBe(100n);
    expect(await s.compareAndSetCumulative("nope", 0n, 1n)).toBe(false);
  });

  it("lets one of many concurrent compare-and-sets from one value win", async () => {
    const s = make();
    await s.open({ channelId: "c", cumulative: 10n });
    const r = await Promise.all([11n, 12n, 13n, 14n, 15n].map((n) => s.compareAndSetCumulative("c", 10n, n)));
    expect(r.filter(Boolean)).toHaveLength(1);
  });

  it("keeps amounts above 2^53 exact, and deletes", async () => {
    const s = make();
    const big = 2n ** 60n + 1n;
    await s.open({ channelId: "c", cumulative: big });
    expect((await s.get("c"))?.cumulative).toBe(big);
    await s.delete("c");
    expect(await s.get("c")).toBeUndefined();
  });

  it("does not let a caller mutate stored data through a returned record", async () => {
    const s = make();
    await s.open({ channelId: "c", cumulative: 0n, data: { k: 1 } });
    const r = await s.get("c");
    (r!.data as { k: number }).k = 2;
    expect((await s.get("c"))?.data).toEqual({ k: 1 });
  });

  it("lists every record id, and forgets a deleted one", async () => {
    const s = make();
    expect(await s.list()).toEqual([]);
    for (const id of ["a", "a#state", "b"]) await s.open({ channelId: id, cumulative: 0n });
    await s.delete("b");
    expect((await s.list()).sort()).toEqual(["a", "a#state"]);
  });

  it("retires records: kept until their retention, then gone from get, list and prune (plan X-F51)", async () => {
    const s = make();
    for (const id of ["a", "a#state", "b"]) await s.open({ channelId: id, cumulative: 0n });
    const now = Date.now();
    await s.retire(["a", "a#state", "unknown"], now + 60_000);
    expect(await s.get("a")).toMatchObject({ channelId: "a", retainUntilMs: now + 60_000 });
    expect(await s.prune(now)).toBe(0);
    expect((await s.list()).sort()).toEqual(["a", "a#state", "b"]);
    expect(await s.prune(now + 60_000)).toBe(2);
    expect(await s.list()).toEqual(["b"]);
    expect(await s.get("b")).toEqual({ channelId: "b", cumulative: 0n });
  });

  it("treats a record past its retention as pruned before prune runs: list drops it, and its id can open again", async () => {
    const s = make();
    await s.open({ channelId: "a", cumulative: 7n });
    await s.retire(["a"], Date.now() - 1);
    expect(await s.get("a")).toBeUndefined();
    expect(await s.compareAndSetCumulative("a", 7n, 8n)).toBe(false);
    expect(await s.list()).toEqual([]);
    expect(await s.open({ channelId: "a", cumulative: 0n })).toBe(true);
  });
});
