// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or https://www.opensource.org/licenses/mit-license.php .
//
// The server closes every channel before the next network-upgrade activation height (spec "Network
// upgrades"; audit 06/X-1): a voucher commits to the branch id current when it was signed (ZIP-243),
// so the client's half cannot be mined from the activation height on. The bound is a closeBy beside
// the Falcon height, set at open, re-read every sweep (a height a later release sets, plan P8),
// recorded so a restart keeps it, and applied to voucher acceptance. Setup: tip 1000, minLockBlocks
// 100, closeMarginBlocks 10, client slack 0 (t = 1100) unless stated.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batch, BatchYcashServerScheme, FileChannelStore } from "../../../src/index.js";
import { reasonOf, serverPriv, setup, type SetupOptions } from "./setup.js";

const NEXT = "0badc0de";
const pending = (h: number) => ({ [NEXT]: { name: "Next", activationheight: h, status: "pending" } });

/** Opens a channel (funding depth 1: one block mined) and settles its first request. */
async function opened(o: SetupOptions = {}) {
  const s = await setup(o);
  const payload = await s.pay();
  await reasonOf(s.server.manager.verify(payload, s.req)); // funding_depth
  s.chain.mine();
  const v = await s.server.manager.verify(payload, s.req);
  await s.client.applySettleResponse(await s.server.manager.settle(v, 2000n));
  return { ...s, channelId: v.channelId };
}

describe("close before the next network upgrade (06/X-1)", () => {
  it("(a) nextActivationHeightOf: the least pending height above the tip; marginHeightOf takes it as closeBy", () => {
    expect(batch.nextActivationHeightOf(undefined, 100)).toBeUndefined();
    expect(batch.nextActivationHeightOf({}, 100)).toBeUndefined();
    expect(batch.nextActivationHeightOf({
      a: { activationheight: 1, status: "active" },
      b: { activationheight: 400, status: "pending" },
      c: { activationheight: 300, status: "pending" },
      d: { activationheight: 90, status: "pending" }, // at or below the tip: a misconfigured node, ignored
      e: { activationheight: 200, status: "disabled" },
    }, 100)).toBe(300);
    expect(batch.nextActivationHeightOf({ b: { activationheight: 101, status: "pending" } }, 100)).toBe(101);
    expect(batch.nextActivationHeightOf({ b: { activationheight: 100, status: "pending" } }, 100)).toBeUndefined();
    expect(batch.nextActivationHeightOf({ b: { activationheight: 1.5, status: "pending" } }, 0)).toBeUndefined();
    expect(batch.marginHeightOf({ refundHeight: 500, closeMarginBlocks: 10, closeBy: 300 })).toBe(290);
  });

  it("(b) opened with an activation pending below t: closeBy is the activation; the sweep closes at activation − margin with reason upgrade", async () => {
    const s = await setup();
    s.chain.upgrades = pending(1050);
    const payload = await s.pay();
    await reasonOf(s.server.manager.verify(payload, s.req));
    s.chain.mine();
    const v = await s.server.manager.verify(payload, s.req);
    await s.server.manager.settle(v, 2000n);
    const ch = await s.server.manager.ledger.get(v.channelId);
    expect(ch?.terms.refundHeight).toBe(1100);
    expect(ch?.terms.closeBy).toBe(1050);
    expect(ch?.upgradeCloseBy).toBe(1050);
    expect(await s.server.manager.sweep(1039)).toEqual([]);
    const closed = await s.server.manager.sweep(1040);
    expect(closed.map((c) => c.reason)).toEqual(["upgrade"]);
    expect(s.closes.map((c) => c.reason)).toEqual(["upgrade"]);
  });

  it("(c) an activation scheduled after the open (the P8 case): the next sweep lowers the recorded bound, a later one closes", async () => {
    const s = await opened();
    expect((await s.server.manager.ledger.get(s.channelId))?.terms.closeBy).toBeUndefined();
    s.chain.upgrades = pending(1050);
    expect(await s.server.manager.sweep(1020)).toEqual([]);
    const ch = await s.server.manager.ledger.get(s.channelId);
    expect(ch?.terms.closeBy).toBe(1050);
    expect(ch?.upgradeCloseBy).toBe(1050);
    // a later, higher activation never raises it
    s.chain.upgrades = pending(1080);
    await s.server.manager.sweep(1021);
    expect((await s.server.manager.ledger.get(s.channelId))?.terms.closeBy).toBe(1050);
    expect((await s.server.manager.sweep(1040)).map((c) => c.reason)).toEqual(["upgrade"]);
  });

  it("(d) a voucher inside the activation margin is refused CHANNEL_CLOSING naming the upgrade, and the channel closes", async () => {
    const s = await opened();
    s.chain.tip = 1041;
    const payload = await s.pay(); // the client has not seen the upgrade: a voucher on the open channel
    expect(payload.payload.type).toBe("voucher");
    s.chain.upgrades = pending(1050);
    const err = await s.server.manager.verify(payload, s.req).catch((e: unknown) => e as batch.BatchSettlementError);
    expect((err as batch.BatchSettlementError).reason).toBe(batch.BatchError.CHANNEL_CLOSING);
    expect((err as Error).message).toContain("next network upgrade");
    expect(s.closes.map((c) => c.reason)).toEqual(["upgrade"]);
  });

  it("(d') the open itself is refused when the channel would already be inside the activation margin", async () => {
    const s = await setup();
    const payload = await s.pay(); // signed before the client saw the upgrade
    s.chain.upgrades = pending(1010);
    expect(await reasonOf(s.server.manager.verify(payload, s.req))).toBe(batch.BatchError.REDEEM_SCRIPT);
  });

  it("(e) the lowered bound survives a restart: the restarted watcher closes at activation − margin although the node no longer lists it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "x402-upgrade-")), "channels.json");
    const s = await opened({ store: new FileChannelStore(path) });
    s.chain.upgrades = pending(1050);
    await s.server.manager.sweep(1020);
    s.chain.upgrades = {}; // e.g. the restarted server's node predates the release that set the height
    const closes: { reason: string }[] = [];
    const server = new BatchYcashServerScheme({
      chain: s.chain, serverPrivKey: serverPriv, maxDeposit: 1_000_000n, minLockBlocks: 100, closeMarginBlocks: 10, idleMs: 600_000,
      store: new FileChannelStore(path), onClose: (e) => closes.push(e),
    });
    const w = server.manager.watcher({ warn: () => undefined });
    s.chain.tip = 1039;
    expect(await w.check()).toEqual([]);
    s.chain.tip = 1040;
    expect((await w.check()).map((c) => c.channelId)).toEqual([s.channelId]);
    expect(closes.map((c) => c.reason)).toEqual(["upgrade"]);
  });

  it("(f) the client chooses t below the activation when minLockBlocks leaves room, and refuses inside the margin", async () => {
    // slack 10: t would be 1110; the activation at 1105 bounds it to 1104 (≥ tip + minLockBlocks + 1)
    const s = await setup({ slack: 10 });
    s.chain.upgrades = pending(1105);
    const payload = await s.pay();
    await reasonOf(s.server.manager.verify(payload, s.req));
    s.chain.mine();
    const v = await s.server.manager.verify(payload, s.req);
    expect((await s.server.manager.ledger.get(v.channelId))?.terms.refundHeight).toBe(1104);
    expect((await s.server.manager.ledger.get(v.channelId))?.upgradeCloseBy).toBeUndefined(); // t is below it: no extra bound
    // an activation inside the margin: the client refuses to open
    const r = await setup();
    r.chain.upgrades = pending(1005);
    await expect(r.pay()).rejects.toThrow(/next network upgrade activates at 1005/);
    // an open channel is retired by the client once inside the activation margin (a new one is opened only past it)
    const o = await opened();
    o.chain.upgrades = pending(1060);
    o.chain.tip = 1050;
    await expect(o.pay()).rejects.toThrow(/next network upgrade/);
  });
});
