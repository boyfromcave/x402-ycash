import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcError, SendRawTransactionError, YcashRpc, basicAuthHeader, lineOf, stripUserinfo } from "../../../src/node/index.js";
import { MockNode, fail, ok } from "./mockNode.js";

let node: MockNode;
let url: string;

beforeEach(async () => {
  node = new MockNode();
  url = await node.start();
});
afterEach(async () => {
  await node.stop();
});

describe("transport", () => {
  it("sends UTF-8 basic auth built from user/password, not the URL", () => {
    expect(basicAuthHeader("ü🦊", "p🔑")).toBe("Basic " + Buffer.from("ü🦊:p🔑", "utf8").toString("base64"));
    expect(stripUserinfo("http://a%F0%9F%A6%8A:b@127.0.0.1:1/")).toEqual({ url: "http://127.0.0.1:1/", user: "a🦊", password: "b" });
  });

  it("returns the result and sends JSON-RPC 1.0", async () => {
    node.handler = () => ok(7);
    const rpc = new YcashRpc({ url, user: "u🦊", password: "p" });
    expect(await rpc.getBlockCount()).toBe(7);
    expect(node.requests[0]).toMatchObject({ method: "getblockcount", params: [], authorization: basicAuthHeader("u🦊", "p") });
  });

  it("throws RpcError with the node's code and method, whatever the HTTP status", async () => {
    node.handler = () => fail(-32601, "Method not found", 404);
    const rpc = new YcashRpc({ url, user: "u", password: "p" });
    const e = await rpc.call("nope").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e).toMatchObject({ code: -32601, message: "Method not found", method: "nope", httpStatus: 404, transport: false });
  });

  it("reports 401 and non-JSON bodies as transport errors", async () => {
    node.expectAuth = "nobody";
    const rpc = new YcashRpc({ url, user: "u", password: "p" });
    await expect(rpc.call("x")).rejects.toMatchObject({ transport: true, httpStatus: 401 });
    node.expectAuth = undefined;
    node.handler = () => ({ status: 500, body: "<html>" });
    await expect(rpc.call("x")).rejects.toMatchObject({ transport: true, httpStatus: 500 });
  });

  it("times out", async () => {
    node.handler = () => new Promise((r) => setTimeout(() => r(ok(1)), 500));
    const rpc = new YcashRpc({ url, user: "u", password: "p", timeoutMs: 50 });
    await expect(rpc.call("slow")).rejects.toMatchObject({ transport: true, message: expect.stringContaining("timed out") });
  });

  it("reads a cookie file and re-reads it after a 401 (node restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-cookie-"));
    const cookie = join(dir, ".cookie");
    writeFileSync(cookie, "__cookie__:one");
    node.expectAuth = basicAuthHeader("__cookie__", "one");
    node.handler = () => ok("a");
    const rpc = new YcashRpc({ url, cookieFile: cookie });
    expect(await rpc.call("x")).toBe("a");
    writeFileSync(cookie, "__cookie__:two");
    node.expectAuth = basicAuthHeader("__cookie__", "two");
    expect(await rpc.call("x")).toBe("a");
  });

  it("loads a devnet.json entry, stripping the URL userinfo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-devnet-"));
    const path = join(dir, "devnet.json");
    const u = new URL(url);
    writeFileSync(path, JSON.stringify({ rpc: { "1": { url: `http://x%F0%9F%A6%8A:y@${u.host}`, port: Number(u.port), user: "x🦊", password: "ÿ🔑" } } }));
    node.handler = () => ok(1);
    const rpc = YcashRpc.fromDevnetJson(path, 1);
    expect(rpc.url).toBe(`http://${u.host}/`);
    await rpc.getBlockCount();
    expect(node.requests[0]?.authorization).toBe(basicAuthHeader("x🦊", "ÿ🔑"));
    expect(() => YcashRpc.fromDevnetJson(path, 0)).toThrow(/no rpc\.0/);
  });
});

describe("wrappers", () => {
  const rpc = () => new YcashRpc({ url, user: "u", password: "p" });

  it("verifyScripts calls signrawtransaction with empty prevtxs and keys", async () => {
    node.handler = () => ok({ hex: "00", complete: true });
    expect(await rpc().verifyScripts("00")).toEqual({ complete: true, errors: [] });
    expect(node.requests[0]).toMatchObject({ method: "signrawtransaction", params: ["00", [], []] });
  });

  it("sends amounts as exact decimal strings", async () => {
    node.handler = () => ok("hex");
    await rpc().createRawTransaction([{ txid: "aa", vout: 1 }], { tAddr: 250_000n }, 0, 300);
    expect(node.requests[0]?.params).toEqual([[{ txid: "aa", vout: 1 }], { tAddr: "0.00250000" }, 0, 300]);
    await rpc().sendToAddress("tAddr", 100_000_000n);
    expect(node.requests[1]?.params).toEqual(["tAddr", "1.00000000"]);
  });

  it("z_sendmany passes only the trailing arguments given", async () => {
    node.handler = () => ok("opid-1");
    await rpc().zSendMany("from", [{ address: "zs", amount: 1n, memo: "ab" }]);
    expect(node.requests[0]?.params).toEqual(["from", [{ address: "zs", amount: "0.00000001", memo: "ab" }]]);
    await rpc().zSendMany("from", [{ address: "zs", amount: 1n }], { privacyPolicy: "AllowRevealedSenders" });
    expect(node.requests[1]?.params).toEqual(["from", [{ address: "zs", amount: "0.00000001" }], 1, null, "AllowRevealedSenders"]);
  });

  it("waitForOperation polls until success, and surfaces a failure", async () => {
    let polls = 0;
    node.handler = (_m, params) => {
      const id = (params[0] as string[])[0];
      if (id === "bad") return ok([{ id, status: "failed", error: { code: -6, message: "Insufficient funds" } }]);
      return ok(++polls < 3 ? [] : [{ id, status: "success", result: { txid: "ff" } }]);
    };
    expect(await rpc().waitForOperation("good", 5000, 5)).toBe("ff");
    await expect(rpc().waitForOperation("bad", 5000, 5)).rejects.toMatchObject({ code: -6, message: "Insufficient funds" });
  });

  it("sendRawTransaction throws a classified error", async () => {
    node.handler = () => fail(-26, "18: txn-mempool-conflict");
    const e = await rpc().sendRawTransaction("00").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SendRawTransactionError);
    expect(e).toMatchObject({ kind: "mempool-conflict", rejectCode: 18 });
  });

  it("detects the line and the Yellowback RPCs once", async () => {
    node.handler = (m) => {
      if (m === "getnetworkinfo") return ok({ version: 4050050, subversion: "/YcashCpp:4.5.0/", protocolversion: 1, relayfee: 0 });
      if (m === "getblockchaininfo") return ok({ chain: "regtest" });
      return fail(-32601, "Method not found", 404);
    };
    const r = rpc();
    expect(await r.capabilities()).toEqual({ line: "v4", subversion: "/YcashCpp:4.5.0/", version: 4050050, yellowback: false, chain: "regtest" });
    await r.capabilities();
    expect(node.requests.filter((q) => q.method === "yed_getinfo")).toHaveLength(1);
  });

  it("treats any non-404 yed_getinfo error as Yellowback present (an unhealthy index)", async () => {
    node.handler = (m) => {
      if (m === "getnetworkinfo") return ok({ version: 6210025, subversion: "/YcashCpp:6.21.0-rc1/", protocolversion: 1, relayfee: 0 });
      if (m === "getblockchaininfo") return ok({ chain: "regtest" });
      return fail(-1, "Yellowback index unhealthy");
    };
    expect(await rpc().capabilities()).toMatchObject({ line: "v6", yellowback: true });
  });

  it("names the line from the subversion", () => {
    expect(lineOf("/YcashCpp:4.5.0/")).toBe("v4");
    expect(lineOf("/YcashCpp:6.21.0-rc1/")).toBe("v6");
    expect(lineOf("/MagicBean:5.0.0/")).toBe("unknown");
  });
});
