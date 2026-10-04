// Pruning closed channels (plan X-F51): a closed channel's ledger records are retired for the
// retention window and then pruned, so list() and resume() stay fast; an open channel never is.
import { describe, expect, it } from "vitest";
import { InMemoryChannelStore } from "../../../src/index.js";
import { reasonOf, setup } from "./setup.js";

describe("closed-channel retention", () => {
  it("prunes every record of a closed channel after the window, never an open one", async () => {
    const store = new InMemoryChannelStore();
    const s = await setup({ store, closedRetentionMs: 60_000, deposit: 10_000n });
    // channel A: open, one request, then the client's close
    const first = await s.pay();
    await reasonOf(s.server.manager.verify(first, s.req));
    s.chain.mine();
    const a = await s.server.manager.verify(first, s.req);
    await s.client.applySettleResponse(await s.server.manager.settle(a, 2000n));
    const close = await s.server.manager.verify(s.wrap((await s.client.closePayload(a.channelId)).payload), s.req);
    await s.server.manager.settle(close, 0n);
    await s.client.markClosed(a.channelId, "");
    // channel B: open and live
    const second = await s.pay();
    await reasonOf(s.server.manager.verify(second, s.req));
    s.chain.mine();
    const b = await s.server.manager.verify(second, s.req);
    await s.server.manager.settle(b, 2000n);

    const ofA = (ids: string[]) => ids.filter((id) => id.startsWith(a.channelId));
    expect(ofA(await store.list()).length).toBeGreaterThanOrEqual(5);
    expect(await store.prune(Date.now())).toBe(0); // within the window: still there for audit
    expect((await s.server.manager.ledger.get(a.channelId))?.closeTxid).toHaveLength(64);

    expect(await store.prune(Date.now() + 60_001)).toBeGreaterThanOrEqual(5);
    expect(ofA(await store.list())).toEqual([]);
    expect(await s.server.manager.ledger.get(a.channelId)).toBeUndefined();
    expect(await s.server.manager.resume()).toEqual([b.channelId]);
    expect((await s.server.manager.ledger.get(b.channelId))?.chargedCumulative).toBe(2000n);
  });
});
