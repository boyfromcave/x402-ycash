import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULTS, loadConfig, redactConfig } from "../src/config.js";

const base = { X402_NETWORK: "ycash:regtest", X402_RPC_URL: "http://127.0.0.1:18232", X402_RPC_USER: "u", X402_RPC_PASSWORD: "p" };

function file(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-fac-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("loadConfig", () => {
  it("applies the defaults (127.0.0.1:4022, confirmations 0..20: −1 is opt-in)", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      host: DEFAULTS.host,
      port: 4022,
      network: "ycash:regtest",
      rpc: { kind: "password", url: "http://127.0.0.1:18232", user: "u", password: "p" },
      confirmations: { minimum: 0, maximum: 20 },
      settlementStorePath: DEFAULTS.settlementStorePath,
      bodyLimit: "512kb",
      logLevel: "info",
    });
    expect(c.apiKey).toBeUndefined();
  });

  it("requires a known network", () => {
    expect(() => loadConfig({ ...base, X402_NETWORK: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, X402_NETWORK: "zcash:mainnet" })).toThrow(/unknown network/);
  });

  it("requires a node RPC, and user + password with a URL", () => {
    expect(() => loadConfig({ X402_NETWORK: "ycash:regtest" })).toThrow(/no node RPC/);
    expect(() => loadConfig({ ...base, X402_RPC_PASSWORD: undefined })).toThrow(/X402_RPC_USER/);
  });

  it("takes a cookie file or a devnet.json instead of a password", () => {
    expect(loadConfig({ ...base, X402_RPC_COOKIE_FILE: "/data/.cookie" }).rpc).toEqual({ kind: "cookie", url: base.X402_RPC_URL, cookieFile: "/data/.cookie" });
    expect(loadConfig({ X402_NETWORK: "ycash:regtest", X402_DEVNET_JSON: "/d/devnet.json", X402_DEVNET_NODE: "1", X402_RPC_TIMEOUT_MS: "5000" }).rpc).toEqual({
      kind: "devnet",
      path: "/d/devnet.json",
      node: 1,
      timeoutMs: 5000,
    });
  });

  it("validates the confirmation range against the spec's −1..20", () => {
    expect(loadConfig({ ...base, X402_CONFIRMATIONS_MIN: "-1", X402_CONFIRMATIONS_MAX: "6" }).confirmations).toEqual({ minimum: -1, maximum: 6 });
    expect(() => loadConfig({ ...base, X402_CONFIRMATIONS_MIN: "-2" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, X402_CONFIRMATIONS_MAX: "21" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, X402_CONFIRMATIONS_MIN: "5", X402_CONFIRMATIONS_MAX: "2" })).toThrow(/minimum must not exceed/);
    expect(() => loadConfig({ ...base, X402_CONFIRMATIONS_MIN: "one" })).toThrow(/integer/);
  });

  it("rejects bad scalar values", () => {
    expect(() => loadConfig({ ...base, X402_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, X402_LOG_LEVEL: "loud" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, X402_BODY_LIMIT: "lots" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, X402_API_KEY: "short" })).toThrow(ConfigError);
  });

  it("reads a JSON file, with env overriding it key by key", () => {
    const path = file({
      network: "ycash:mainnet",
      port: 5000,
      rpc: { url: "http://node:8232", cookieFile: "/c" },
      confirmations: { minimum: 1, maximum: 10 },
      settlementStorePath: "/data/s.json",
    });
    const c = loadConfig({ X402_FACILITATOR_CONFIG: path, X402_PORT: "6000" });
    expect(c).toMatchObject({ network: "ycash:mainnet", port: 6000, rpc: { kind: "cookie", url: "http://node:8232", cookieFile: "/c" }, confirmations: { minimum: 1, maximum: 10 }, settlementStorePath: "/data/s.json" });
  });

  it("rejects an unknown key or unreadable JSON in the file", () => {
    expect(() => loadConfig({ X402_FACILITATOR_CONFIG: file({ network: "ycash:regtest", prot: 1 }) })).toThrow(/Unrecognized key/);
    expect(() => loadConfig({ X402_FACILITATOR_CONFIG: file("{") })).toThrow(/cannot read/);
  });

  it("redacts the password and the API key", () => {
    const shown = JSON.stringify(redactConfig(loadConfig({ ...base, X402_RPC_PASSWORD: "s3cret-pw", X402_API_KEY: "a".repeat(20) })));
    expect(shown).not.toContain("s3cret-pw");
    expect(shown).not.toContain("a".repeat(20));
    expect(shown).toContain('"apiKey":"(set)"');
  });
});
