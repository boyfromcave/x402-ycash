// The address issuers: the node-wallet issuer's calls, and the offline issuer's index file (start
// index, persistence across instances and processes, key binding).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  ASSET_TRANSFER_METHOD_SAPLING_PROOF,
  decodeSaplingViewingKey,
  findSaplingAddress,
  NodeWalletIssuer,
  OFFLINE_ISSUER_DEFAULT_START,
  OfflineAddressIssuer,
  ShieldedExactServer,
} from "../../../src/shielded/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../../../../vectors/shielded/divaddr.json", import.meta.url), "utf8")) as {
  cases: { viewingKey: string; rust: { start: string; addresses: { index: string; address: string }[] }[] }[];
};
const KEY = vectors.cases[0]!.viewingKey;
const AT_2_40 = vectors.cases[0]!.rust[1]!.addresses;
const tmp = () => join(mkdtempSync(join(tmpdir(), "x402-issuer-")), "index.json");

describe("NodeWalletIssuer", () => {
  it("makes the base address once and asks the wallet for each diversified address", async () => {
    const calls: string[] = [];
    let n = 0;
    const issuer = new NodeWalletIssuer({
      zGetNewAddress: async () => (calls.push("new"), "yregtestsapling1base"),
      zGetNewDiversifiedAddress: async (b) => (calls.push(`div ${b}`), `yregtestsapling1d${n++}`),
    });
    expect(await issuer.issue("ycash:regtest")).toBe("yregtestsapling1d0");
    expect(await issuer.issue("ycash:regtest")).toBe("yregtestsapling1d1");
    expect(calls).toEqual(["new", "div yregtestsapling1base", "div yregtestsapling1base"]);
  });
  it("refuses a base address of another network", async () => {
    const issuer = new NodeWalletIssuer({ zGetNewAddress: async () => "ys1x", zGetNewDiversifiedAddress: async () => "ys1y" }, "ys1base");
    await expect(issuer.issue("ycash:regtest")).rejects.toThrow(/not a ycash:regtest Sapling address/);
  });
});

describe("OfflineAddressIssuer", () => {
  it("starts at 2^40 by default and walks valid indices, as sapling-crypto does", async () => {
    const issuer = new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath: tmp() });
    expect(await issuer.nextIndex()).toBe(OFFLINE_ISSUER_DEFAULT_START);
    for (const a of AT_2_40) expect(await issuer.issue("ycash:regtest")).toBe(a.address);
    expect(await issuer.nextIndex()).toBe(BigInt(AT_2_40[AT_2_40.length - 1]!.index) + 1n);
  });
  it("keeps the next index across restarts", async () => {
    const indexPath = tmp();
    const first = new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath });
    const a = await first.issue("ycash:regtest");
    const second = new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath, startIndex: 1n << 50n });
    const b = await second.issue("ycash:regtest");
    expect(b).not.toBe(a);
    expect(b).toBe(AT_2_40[1]!.address); // the file wins over a changed startIndex
  });
  it("never hands out one address twice under concurrent calls on a shared file", async () => {
    const indexPath = tmp();
    const issuers = [0, 1, 2].map(() => new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath }));
    const got = await Promise.all(Array.from({ length: 12 }, (_, i) => issuers[i % 3]!.issue("ycash:regtest")));
    expect(new Set(got).size).toBe(12);
  });
  it("refuses an index file of another key", async () => {
    const indexPath = tmp();
    writeFileSync(indexPath, JSON.stringify({ v: 1, key: "0000000000000000", next: "1099511627776" }));
    const issuer = new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath });
    await expect(issuer.issue("ycash:regtest")).rejects.toThrow(/belongs to another viewing key/);
  });
  it("refuses a start index in the wallets' range, another network, and a bad key", async () => {
    expect(() => new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath: tmp(), startIndex: 5n })).toThrow(RangeError);
    expect(() => new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:mainnet", indexPath: tmp() })).toThrow(/not a ycash:mainnet/);
    const issuer = new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath: tmp() });
    await expect(issuer.issue("ycash:testnet")).rejects.toThrow(/regtest key/);
  });
  it("names the key's default address, which z_getnewaddress returned", () => {
    const issuer = new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath: tmp() });
    expect(issuer.defaultAddress()).toBe(findSaplingAddress(decodeSaplingViewingKey(KEY, "ycash:regtest"), 0n).address);
  });
});

describe("ShieldedExactServer with an offline issuer", () => {
  const template: PaymentRequirements = {
    scheme: "exact",
    network: "ycash:regtest",
    asset: "YEC",
    amount: "1500000",
    payTo: "",
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: ASSET_TRANSFER_METHOD_SAPLING_PROOF },
  };
  it("issues from the viewing key with no node at all", async () => {
    const server = new ShieldedExactServer({ issuer: new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath: tmp() }) });
    const r1 = await server.enhanceRequirements(template, "https://m.example/r");
    const r2 = await server.enhanceRequirements(template, "https://m.example/r");
    expect([r1.payTo, r2.payTo]).toEqual([AT_2_40[0]!.address, AT_2_40[1]!.address]);
    expect((await server.requestRecord(r1.payTo))?.payTo).toBe(r1.payTo);
  });
  it("quotes priceUsd from the fallback price when there is no node, and refuses without one", async () => {
    const issuer = new OfflineAddressIssuer({ viewingKey: KEY, network: "ycash:regtest", indexPath: tmp() });
    const usd: PaymentRequirements = { ...template, extra: { ...template.extra, priceUsd: "0.50" } };
    const priced = await new ShieldedExactServer({ issuer, fallbackPriceMicroUsd: 25_000_000 }).enhanceRequirements(usd, "https://m.example/r");
    expect(priced.amount).toBe("2000000");
    await expect(new ShieldedExactServer({ issuer }).enhanceRequirements(usd, "https://m.example/r")).rejects.toThrow(/no merchant node/);
  });
  it("needs an issuer or a wallet", () => {
    expect(() => new ShieldedExactServer({})).toThrow(/needs an address issuer/);
  });
});
