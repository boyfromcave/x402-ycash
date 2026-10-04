// `--lwd`: the CLI with a WIF key and a lightwalletd server, no node RPC (plan X5). The server is
// the in-process fake from the mechanism's unit tests, over a real gRPC wire.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { batch as B, channel, FileClientChannelStorage, tx as T } from "x402-ycash-mechanism";
import { startFakeLwd } from "../../ycash/test/unit/lwd/fakeLwd.js";
import { loadCliConfig, parseCli, run } from "../src/index.js";

const NET = "ycash:regtest" as const;
const wif = T.encodeWif(T.hexToBytes("07".repeat(32)), NET);

function capture() {
  const lines: Record<string, unknown>[] = [];
  const errs: string[] = [];
  return { lines, errs, io: { out: (r: Record<string, unknown>) => lines.push(r), err: (l: string) => errs.push(l) } };
}

describe("x402-ycash --lwd", () => {
  let fake: Awaited<ReturnType<typeof startFakeLwd>>;
  beforeAll(async () => {
    fake = await startFakeLwd({ height: 120 });
  });
  afterAll(async () => {
    await fake.stop();
  });

  it("configuration: --lwd or X402_LWD_URL instead of a node; needs a WIF key; sapling-proof needs a node", () => {
    const c = loadCliConfig(parseCli(["pay", "x", "--lwd", fake.url, "--wif", wif]), {});
    expect(c.lwd?.url).toBe(fake.url);
    expect(c.node).toBeUndefined();
    c.lwd?.close();
    const e = loadCliConfig(parseCli(["pay", "x"]), { X402_LWD_URL: "grpcs://lite.ycash.xyz", X402_WIF: wif });
    expect(e.lwd?.tls).toBe(true);
    e.lwd?.close();
    expect(() => loadCliConfig(parseCli(["pay", "x", "--lwd", fake.url]), {})).toThrow(/--lwd needs --wif/);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--lwd", fake.url, "--wif", wif, "--shielded-from", "zregtestsapling1x"]), {})).toThrow(/node wallet/);
    expect(() => loadCliConfig(parseCli(["pay", "x", "--lwd", "not a url", "--wif", wif]), {})).toThrow(/--lwd/);
    expect(() => loadCliConfig(parseCli(["pay", "x"]), {})).toThrow(/--lwd host:port/);
  });

  it("channel status and refund read the tip from lightwalletd and broadcast the refund through SendTransaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-cli-lwd-"));
    const store = join(dir, "channels.json");
    const cPriv = T.hexToBytes("11".repeat(32));
    const sPub = T.pubkeyFromPriv(T.hexToBytes("22".repeat(32)));
    const payTo = T.encodeAddress(NET, "p2pkh", new Uint8Array(20).fill(9));
    const redeemScript = channel.buildChannelScript({ clientPubKey: T.pubkeyFromPriv(cPriv), serverPubKey: sPub, refundHeight: 130 });
    const returnAddress = T.encodeAddress(NET, "p2pkh", new Uint8Array(20).fill(4));
    const rec: B.client.ClientChannelRecord = {
      channelId: "ab".repeat(32) + ":0", offerKey: B.client.offerKeyOf(NET, payTo, T.bytesToHex(sPub)), network: NET, asset: "YEC", payTo, serverPubKey: T.bytesToHex(sPub),
      redeemScript: T.bytesToHex(redeemScript), fundingTx: "00", vout: 0, value: "101500", closeFee: "1500", deposit: "100000", refundHeight: 130,
      closeMarginBlocks: 5, clientPrivKey: T.bytesToHex(cPriv), clientScript: T.bytesToHex(T.addressToScript(returnAddress, NET)), returnAddress, charged: "5000", signed: "6000", status: "open",
    };
    await new FileClientChannelStorage(store).put(rec);
    const args = ["--lwd", fake.url, "--wif", wif, "--channels", store];
    const c = capture();
    expect(await run(["channel", "status", ...args], {}, c.io)).toBe(0);
    // The funding is unknown to the fake's node: the output reads as gone.
    expect(c.lines[0]).toMatchObject({ channelId: rec.channelId, tip: 120, blocksToRefund: 10, unspent: false });
    expect(await run(["channel", "refund", rec.channelId, ...args], {}, c.io)).toBe(1);
    expect(c.errs.join()).toMatch(/valid from height 130/);
    fake.state.height = 130;
    expect(await run(["channel", "refund", rec.channelId, ...args], {}, c.io)).toBe(0);
    expect(fake.state.sent).toHaveLength(1);
    const refund = T.parseTx(fake.state.sent[0]!);
    expect(refund.lockTime).toBe(130);
    expect(refund.vout[0]!.scriptPubKey).toEqual(T.addressToScript(returnAddress, NET));
    expect(c.lines.at(-1)).toMatchObject({ msg: "refunded", transaction: "ab".repeat(32) });
    expect((await new FileClientChannelStorage(store).get(rec.channelId))?.status).toBe("refunded");
  });
});
