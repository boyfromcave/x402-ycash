// A merchant restart: the watcher's tracked set is in memory, so a restarted server re-tracks every
// open channel from its ChannelStore and still closes them on idle or margin.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tx as T, BatchYcashServerScheme, FileChannelStore } from "../../../src/index.js";
import { reasonOf, serverPriv, setup } from "./setup.js";

async function openedOnFile() {
  const path = join(mkdtempSync(join(tmpdir(), "x402-restart-")), "channels.json");
  const s = await setup({ store: new FileChannelStore(path) });
  const payload = await s.pay();
  await reasonOf(s.server.manager.verify(payload, s.req)); // funding_depth
  s.chain.mine();
  const v = await s.server.manager.verify(payload, s.req);
  await s.client.applySettleResponse(await s.server.manager.settle(v, 2000n));
  return { ...s, path, channelId: v.channelId };
}

/** The same key and store file in a fresh process. */
function restarted(s: Awaited<ReturnType<typeof openedOnFile>>, idleMs: number) {
  const closes: { reason: string; txid: string | undefined }[] = [];
  const server = new BatchYcashServerScheme({
    chain: s.chain, serverPrivKey: serverPriv, maxDeposit: 1_000_000n, minLockBlocks: 100, closeMarginBlocks: 10, idleMs,
    store: new FileChannelStore(s.path), onClose: (e) => closes.push(e),
  });
  return { server, closes };
}

describe("restart", () => {
  it("resume() re-tracks open channels only", async () => {
    const s = await openedOnFile();
    await openedOnFile(); // another server's file: not this one's channel
    const r = restarted(s, 600_000);
    expect(r.server.manager.tracked()).toEqual([]);
    expect(await r.server.manager.resume()).toEqual([s.channelId]);
    expect(r.server.manager.tracked()).toEqual([s.channelId]);
    await r.server.manager.close(s.channelId);
    expect(await restarted(s, 600_000).server.manager.resume()).toEqual([]);
  });

  it("the restarted server's watcher closes an idle channel at its first tick, before the margin", async () => {
    const s = await openedOnFile();
    const r = restarted(s, 0);
    const w = r.server.manager.watcher({ warn: () => undefined });
    expect(await w.check()).toEqual([]); // not at the margin…
    expect(r.closes.map((c) => c.reason)).toEqual(["idle"]); // …but idle since the restart
    expect(r.closes[0]!.txid).toBe(T.txid(T.parseTx(s.chain.sent.at(-1)!)));
  });

  it("the restarted server's watcher closes at the margin", async () => {
    const s = await openedOnFile();
    const r = restarted(s, 600_000);
    const w = r.server.manager.watcher({ warn: () => undefined });
    await w.check();
    expect(r.closes).toEqual([]);
    s.chain.tip = 1090;
    expect((await w.check()).map((c) => c.channelId)).toEqual([s.channelId]);
    expect(r.closes.map((c) => c.reason)).toEqual(["margin"]);
  });
});
