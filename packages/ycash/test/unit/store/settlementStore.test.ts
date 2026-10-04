import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  FileSettlementStore,
  InMemorySettlementStore,
  RETAIN_FOREVER,
  SETTLEMENT_RETENTION_BLOCKS,
  YCASH_REGTEST,
  consumptionKey,
  retainUntilForExpiry,
  txidKey,
  type SettlementStore,
} from "../../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "x402-store-"));
const TXID = "AB".repeat(32);

describe("keys", () => {
  it("builds ycash:<net>:<id> keys", () => {
    expect(consumptionKey(YCASH_REGTEST, "chan1")).toBe("ycash:regtest:chan1");
    expect(txidKey(YCASH_REGTEST, TXID)).toBe(`ycash:regtest:${"ab".repeat(32)}`);
    expect(() => txidKey(YCASH_REGTEST, "xyz")).toThrow();
    expect(() => consumptionKey(YCASH_REGTEST, "a:b")).toThrow();
  });
  it("retains a tx claim until expiry + 10 blocks, and refuses expiry 0", () => {
    expect(SETTLEMENT_RETENTION_BLOCKS).toBe(10);
    expect(retainUntilForExpiry(300)).toBe(310);
    expect(() => retainUntilForExpiry(0)).toThrow();
  });
});

const stores: [string, () => SettlementStore][] = [
  ["InMemorySettlementStore", () => new InMemorySettlementStore()],
  ["FileSettlementStore", () => new FileSettlementStore(join(tmp(), "claims.json"))],
];

describe.each(stores)("%s", (_name, make) => {
  it("claims a key once", async () => {
    const s = make();
    expect(await s.claim("k", 100)).toBe(true);
    expect(await s.claim("k", 200)).toBe(false);
    expect(await s.isClaimed("k")).toBe(true);
    expect(await s.isClaimed("other")).toBe(false);
  });

  it("gives exactly one winner among concurrent claims", async () => {
    const s = make();
    const results = await Promise.all(Array.from({ length: 25 }, () => s.claim("race", 10)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("releases a claim so it can be taken again", async () => {
    const s = make();
    await s.claim("k", 10);
    await s.release("k");
    expect(await s.isClaimed("k")).toBe(false);
    expect(await s.claim("k", 10)).toBe(true);
    await s.release("never-claimed");
  });

  it("prunes only claims whose retention ended, never RETAIN_FOREVER", async () => {
    const s = make();
    await s.claim("a", 100);
    await s.claim("b", 105);
    await s.claim("forever", RETAIN_FOREVER);
    expect(await s.prune(100)).toBe(0); // retained through height 100 inclusive
    expect(await s.prune(101)).toBe(1);
    expect(await s.isClaimed("a")).toBe(false);
    expect(await s.isClaimed("b")).toBe(true);
    expect(await s.prune(1_000_000)).toBe(1);
    expect(await s.isClaimed("forever")).toBe(true);
  });

  it("refuses a non-integer retention height", async () => {
    await expect(make().claim("k", 1.5)).rejects.toThrow();
  });
});

describe("FileSettlementStore across instances and processes", () => {
  it("shares claims between instances on one file and persists RETAIN_FOREVER", async () => {
    const path = join(tmp(), "claims.json");
    const a = new FileSettlementStore(path);
    const b = new FileSettlementStore(path);
    expect(await a.claim("k", RETAIN_FOREVER)).toBe(true);
    expect(await b.claim("k", 5)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, claims: { k: null } });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("gives one winner among racing processes", async () => {
    const path = join(tmp(), "claims.json");
    const tsx = resolve(here, "../../../../../node_modules/.bin/tsx");
    const worker = join(here, "claimWorker.ts");
    const run = promisify(execFile);
    const outs = await Promise.all(Array.from({ length: 6 }, () => run(tsx, [worker, path, "shared-key", "20"])));
    const won = outs.map((o) => Number(o.stdout.trim()));
    expect(won.reduce((x, y) => x + y, 0)).toBe(1);
  }, 60_000);

  it("breaks a stale lock left by a crashed process", async () => {
    const path = join(tmp(), "claims.json");
    writeFileSync(`${path}.lock`, "999999.dead");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    const s = new FileSettlementStore(path, { staleLockMs: 1000, lockTimeoutMs: 2000 });
    expect(await s.claim("k", 1)).toBe(true);
  });

  it("times out on a live lock", async () => {
    const path = join(tmp(), "claims.json");
    writeFileSync(`${path}.lock`, "held");
    const s = new FileSettlementStore(path, { staleLockMs: 60_000, lockTimeoutMs: 100 });
    await expect(s.claim("k", 1)).rejects.toThrow(/timed out/);
  });
});
