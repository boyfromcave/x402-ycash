// Copyright (c) 2026 The Ycash developers. MIT License.
//
// Configuration, the startup network check, the reader's degradations and the agent's guards.
import { describe, expect, it } from "vitest";
import { RpcError, tx } from "x402-ycash-mechanism";
import { Budget, runAgent } from "../src/agent/agent.js";
import { broadcastHexOf, invalidParams, yecOf } from "../src/catalog.js";
import { ConfigError, describeConfig, loadChainApiConfig } from "../src/config.js";
import { ChainReader, feePicture } from "../src/reader.js";
import { checkNode, WrongNetworkError } from "../src/startup.js";
import { FakeNode, TXID } from "./fakes.js";

const TESTNET_PAY_TO = tx.encodeAddress("ycash:testnet", "p2pkh", new Uint8Array(20).fill(3));
const env = { X402_NETWORK: "ycash:testnet", API_PAY_TO: TESTNET_PAY_TO, API_RPC_URL: "http://127.0.0.1:18232", API_RPC_COOKIE_FILE: "/run/ycash/.cookie" };

describe("configuration", () => {
  it("defaults to the fast testnet at D-10's prices, and needs the fast profile there", () => {
    const c = loadChainApiConfig(env);
    expect(c).toMatchObject({ network: "ycash:testnet", testnetProfile: "fast", priceZat: 10_000n, priceBroadcastZat: 10_000n, zeroConfCapZat: 100_000n, port: 4021, host: "127.0.0.1" });
    expect(c.node).toEqual({ kind: "cookie", url: "http://127.0.0.1:18232", cookieFile: "/run/ycash/.cookie" });
  });
  it("refuses mainnet, regtest without API_ALLOW_REGTEST=1, and a payTo that is not P2PKH of the network", () => {
    expect(() => loadChainApiConfig({ ...env, X402_NETWORK: "ycash:mainnet" })).toThrow(/X6 runbook/);
    const regtestTo = tx.encodeAddress("ycash:regtest", "p2pkh", new Uint8Array(20));
    expect(() => loadChainApiConfig({ ...env, X402_NETWORK: "ycash:regtest", API_PAY_TO: regtestTo })).toThrow(/API_ALLOW_REGTEST/);
    expect(loadChainApiConfig({ ...env, X402_NETWORK: "ycash:regtest", API_PAY_TO: regtestTo, API_ALLOW_REGTEST: "1" }).testnetProfile).toBeUndefined();
    expect(() => loadChainApiConfig({ ...env, API_PAY_TO: tx.encodeAddress("ycash:mainnet", "p2pkh", new Uint8Array(20)) })).toThrow(ConfigError);
    expect(() => loadChainApiConfig({ ...env, API_PAY_TO: tx.encodeAddress("ycash:testnet", "p2sh", new Uint8Array(20)) })).toThrow(/P2PKH/);
    expect(() => loadChainApiConfig({ ...env, API_PAY_TO: undefined })).toThrow(/API_PAY_TO/);
  });
  it("validates numbers, URLs and links, and never shows the RPC password", () => {
    expect(() => loadChainApiConfig({ ...env, API_PRICE_ZAT: "0" })).toThrow(/API_PRICE_ZAT/);
    expect(() => loadChainApiConfig({ ...env, API_UNPAID_PER_MINUTE: "-1" })).toThrow(/API_UNPAID_PER_MINUTE/);
    expect(() => loadChainApiConfig({ ...env, FACILITATOR_URL: "file:///etc/passwd" })).toThrow(/FACILITATOR_URL/);
    expect(() => loadChainApiConfig({ ...env, API_LINK_FAUCET: "javascript:alert(1)" })).toThrow(/API_LINK_FAUCET/);
    expect(() => loadChainApiConfig({ ...env, API_RPC_URL: "http://u:p@node:1" })).toThrow(/credentials/);
    expect(() => loadChainApiConfig({ ...env, API_RPC_COOKIE_FILE: undefined })).toThrow(/API_RPC_USER/);
    const c = loadChainApiConfig({ ...env, API_RPC_COOKIE_FILE: undefined, API_RPC_USER: "u", API_RPC_PASSWORD: "s3cret", FACILITATOR_API_KEY: "k".repeat(20), API_LINK_LIGHTWALLETD: "fastnet-lightwallet.ycash.team:443" });
    expect(c.links.lightwalletd).toBe("fastnet-lightwallet.ycash.team:443");
    expect(JSON.stringify(describeConfig(c))).not.toMatch(/s3cret|kkkkkkkk/);
  });
});

describe("parameters", () => {
  it("checks ids, heights, addresses and the relay body", () => {
    expect(invalidParams("tx", { txid: TXID }, "ycash:testnet")).toBeUndefined();
    expect(invalidParams("block", { id: "0" }, "ycash:testnet")).toBeUndefined();
    expect(invalidParams("block", { id: "-1" }, "ycash:testnet")).toBeDefined();
    expect(invalidParams("address", { address: TESTNET_PAY_TO }, "ycash:testnet")).toBeUndefined();
    expect(broadcastHexOf({ hex: "0A0b" })).toEqual({ hex: "0a0b" });
    expect(broadcastHexOf({ hex: "0a0b", more: 1 })).toHaveProperty("error");
    expect(yecOf(10_000n)).toBe("0.0001");
    expect(yecOf(150_000_000n)).toBe("1.5");
  });
});

describe("startup check (D-6)", () => {
  const node = (info: Record<string, unknown>, index: "on" | "off" = "on"): FakeNode => {
    const n = new FakeNode();
    n.answers.getblockchaininfo = { blocks: 5, ...info };
    if (index === "off") n.answers.getaddressbalance = new RpcError(-1, "Error: getaddressbalance is disabled.", "getaddressbalance");
    return n;
  };
  const noSleep = async (): Promise<void> => undefined;
  it("passes the fast testnet and reports the address index", async () => {
    await expect(checkNode(node({ chain: "test", testnetprofile: "fast" }), "ycash:testnet", "fast", TESTNET_PAY_TO, 0, noSleep)).resolves.toMatchObject({ testnetProfile: "fast", addressIndex: true, tip: 5 });
    await expect(checkNode(node({ chain: "test", testnetprofile: "fast" }, "off"), "ycash:testnet", "fast", TESTNET_PAY_TO, 0, noSleep)).resolves.toMatchObject({ addressIndex: false });
  });
  it("refuses another testnet profile, a node without one, and another chain", async () => {
    await expect(checkNode(node({ chain: "test", testnetprofile: "slow" }), "ycash:testnet", "fast", TESTNET_PAY_TO, 0, noSleep)).rejects.toBeInstanceOf(WrongNetworkError);
    await expect(checkNode(node({ chain: "test" }), "ycash:testnet", "fast", TESTNET_PAY_TO, 0, noSleep)).rejects.toThrow(/profile none/);
    await expect(checkNode(node({ chain: "main" }), "ycash:testnet", "fast", TESTNET_PAY_TO, 0, noSleep)).rejects.toThrow(/chain "test"/);
  });
  it("retries a node that does not answer yet, then gives up with its error", async () => {
    const n = node({ chain: "test", testnetprofile: "fast" });
    let fails = 2;
    const real = n.call.bind(n);
    n.call = async <T>(m: string, p?: readonly unknown[]): Promise<T> => {
      if (m === "getblockchaininfo" && fails-- > 0) throw new RpcError(0, "ECONNREFUSED", m, { transport: true });
      return real<T>(m, p);
    };
    await expect(checkNode(n, "ycash:testnet", "fast", TESTNET_PAY_TO, 60_000, noSleep)).resolves.toMatchObject({ chain: "test" });
    const dead = new FakeNode();
    dead.answers.getblockchaininfo = new RpcError(0, "ECONNREFUSED", "getblockchaininfo", { transport: true });
    await expect(checkNode(dead, "ycash:testnet", "fast", TESTNET_PAY_TO, 0, noSleep)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("reader degradations", () => {
  it("an off address index is a 503 with the reason; an inactive Vault upgrade is 'not active'", async () => {
    const n = new FakeNode();
    n.answers.getaddressbalance = new RpcError(-1, "Error: getaddressbalance is disabled. Run './ycash-cli help getaddressbalance'", "getaddressbalance");
    await expect(new ChainReader(n).address(TESTNET_PAY_TO)).rejects.toMatchObject({ status: 503, code: "index_off" });
    n.answers.getblockchaininfo = { upgrades: {} };
    await expect(new ChainReader(n).yellowback()).resolves.toMatchObject({ active: false, reason: expect.stringMatching(/not scheduled/) });
  });
  it("an active Vault upgrade reads the vault primitive and says which YED reads the node lacks", async () => {
    const n = new FakeNode();
    n.answers.getblockchaininfo = { upgrades: { "6d5b7a31": { name: "Vault", activationheight: 10, status: "active" } } };
    n.answers.vault_getinfo = { vaults: 0 };
    n.answers.yed_getprice = new RpcError(-1, "no attested price", "yed_getprice");
    const y = await new ChainReader(n).yellowback();
    expect(y).toMatchObject({ active: true, vault: { available: true, result: { vaults: 0 } }, yed: { info: { available: false, reason: expect.stringMatching(/-yellowback/) }, price: { available: false, reason: "no attested price" } } });
  });
  it("a transaction's fee is unknown, not wrong, when a previous transaction cannot be read", async () => {
    const n = new FakeNode();
    const real = n.answers.getrawtransaction as (p: readonly unknown[]) => unknown;
    n.answers.getrawtransaction = (p: readonly unknown[]) => (p[0] === TXID ? real(p) : (() => { throw new RpcError(-5, "No information", "getrawtransaction"); })());
    await expect(new ChainReader(n).transaction(TXID)).resolves.toMatchObject({ feeZat: null, feeNote: expect.stringMatching(/-txindex/) });
  });
  it("the fee picture: rates per 1000 bytes, bounded", () => {
    expect(feePicture({ a: { fee: 0.0001, size: 1000 }, b: { fee: 0.00001, size: 500 } })).toMatchObject({ read: 2, totalFeesZat: 11_000, rateZatPerKb: { min: 2000, max: 10_000 } });
    expect(feePicture({})).toMatchObject({ read: 0, rateZatPerKb: { min: null, median: null } });
  });
});

describe("the reference agent's guards", () => {
  it("a budget is a hard cap on the total", () => {
    const b = new Budget(25_000n);
    expect(b.allows(10_000n)).toBe(true);
    b.spent = 20_000n;
    expect(b.allows(10_000n)).toBe(false);
  });
  it("needs a key file and an http(s) URL; refuses an inline key", async () => {
    const errs: string[] = [];
    const io = { out: () => undefined, err: (l: string) => errs.push(l) };
    expect(await runAgent(["https://x.example"], {}, io)).toBe(2);
    expect(errs.join("")).toMatch(/--wif-file is required/);
    expect(await runAgent(["ftp://x.example", "--wif-file", "/nonexistent"], {}, io)).toBe(2);
    expect(await runAgent(["https://x.example", "--wif", "k"], {}, io)).toBe(2); // no such option
    expect(await runAgent(["https://x.example", "--wif-file", "/nonexistent", "--lwd", "127.0.0.1:1"], {}, io)).toBe(2);
    expect(errs.join("")).toMatch(/ENOENT/);
  });
});
