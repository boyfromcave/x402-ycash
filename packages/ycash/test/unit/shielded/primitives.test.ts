import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RpcError, YCASH_REGTEST } from "../../../src/index.js";
import {
  FileIssuedAddressRegistry,
  InMemoryIssuedAddressRegistry,
  createJws,
  currentPrice,
  didJwkFor,
  es256kSigner,
  jcs,
  memoForRecord,
  memoToHex,
  noteMemoBytes,
  noteMemoEquals,
  publicKeyFromDidJwk,
  quoteZat,
  recordRetainUntil,
  requestHash,
  signOffer,
  signReceipt,
  usdToMicro,
  verifyJws,
  verifyReceipt,
  type IssuedAddressRegistry,
  type IssuedRequest,
  type RequestRecord,
} from "../../../src/shielded/index.js";
import * as secp from "@noble/secp256k1";

describe("JCS (RFC 8785)", () => {
  it("sorts members by UTF-16 code units (RFC 8785 §3.2.3)", () => {
    const o = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
    const keys = [...jcs(o).matchAll(/"([^"]*)":/g)].map((m) => m[1]);
    expect(keys).toEqual(["\\r", "1", "\u0080", "ö", "€", "😀", "דּ"]);
  });
  it("serialises numbers in ECMAScript form and strings with short escapes (RFC 8785 3.2.2)", () => {
    // RFC 8785 3.2.2.3 sample: the literal is meant to round to 333333333.3333333 (parsed, so no lint rule trips on it).
    expect(jcs([Number("333333333.33333329"), 1e30, 4.5, 2e-3, 0.000000000000000000000000001])).toBe("[333333333.3333333,1e+30,4.5,0.002,1e-27]");
    // U+000F stays a \u escape, U+000A takes the short form, quote and backslash are escaped, "/" is not
    const str = String.fromCharCode(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x2f);
    const want = '"' + String.fromCharCode(0x20ac) + "$" + "\\u000f" + "\\n" + "A'B" + '\\"' + "\\\\" + '/"';
    expect(jcs(str)).toBe(want);
    expect(jcs({ literals: [null, true, false] })).toBe('{"literals":[null,true,false]}');
    expect(jcs({ b: 1, a: { d: undefined, c: -0 } })).toBe('{"a":{"c":0},"b":1}');
  });
  it("refuses what JSON cannot carry", () => {
    expect(() => jcs(Number.NaN)).toThrow();
    expect(() => jcs(Infinity)).toThrow();
    expect(() => jcs(1n)).toThrow();
    expect(() => jcs("\ud800")).toThrow();
    expect(() => jcs({ f: () => 1 })).toThrow();
  });
});

const RECORD: RequestRecord = {
  v: 1,
  network: YCASH_REGTEST,
  asset: "YEC",
  amount: "1500000",
  payTo: "yregtestsapling1qqqq",
  resource: "https://api.example.com/data",
  expiresAt: 1791100800,
  nonce: "00".repeat(32),
};

describe("request hash and memo", () => {
  it("hashes the JCS record (pinned vector)", () => {
    expect(jcs(RECORD)).toBe(
      '{"amount":"1500000","asset":"YEC","expiresAt":1791100800,"network":"ycash:regtest","nonce":"' + "00".repeat(32) + '","payTo":"yregtestsapling1qqqq","resource":"https://api.example.com/data","v":1}',
    );
    const h = requestHash(RECORD);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe("14a506512c2afe6675308d683a79058170229d509632cb7d813b9d2793ce67e2"); // sha256 of the JCS text above (node:crypto)
    expect(memoForRecord(RECORD)).toBe("x402:" + h);
    expect(requestHash({ ...RECORD, nonce: "01".repeat(32) })).not.toBe(h);
  });
  it("matches a note memo with trailing zeros removed, from hex or memoStr", () => {
    const memo = memoForRecord(RECORD);
    const hex = memoToHex(memo) + "00".repeat(512 - memo.length);
    expect(noteMemoEquals({ memo: hex }, memo)).toBe(true);
    expect(noteMemoEquals({ memo: hex.toUpperCase() }, memo)).toBe(true);
    expect(noteMemoEquals({ memo: undefined as unknown as string, memoStr: memo }, memo)).toBe(true);
    expect(noteMemoEquals({ memo: memoToHex(memo + "x") }, memo)).toBe(false);
    expect(noteMemoEquals({ memo: memoToHex(memo.slice(0, -1)) }, memo)).toBe(false);
    // "no memo" is 0xF6 then zeros (ZIP 302)
    expect(noteMemoBytes({ memo: "f6" + "00".repeat(511) })).toEqual(new Uint8Array([0xf6]));
    expect(noteMemoEquals({ memo: "f6" + "00".repeat(511) }, memo)).toBe(false);
  });
});

describe("price quote", () => {
  it("parses USD exactly and rounds the quote up", () => {
    expect(usdToMicro("0.05")).toBe(50_000n);
    expect(usdToMicro("12")).toBe(12_000_000n);
    expect(() => usdToMicro("0.0000001")).toThrow();
    expect(() => usdToMicro("-1")).toThrow();
    // $0.05 at $0.30/YEC = 0.1666… YEC
    expect(quoteZat("0.05", 300_000)).toBe(16_666_667n);
    expect(quoteZat("1", 1_000_000)).toBe(100_000_000n);
    expect(() => quoteZat("0", 1)).toThrow();
    expect(() => quoteZat("1", 0)).toThrow();
  });
  it("reads yed_getprice, and falls back on a stock node or a missing price", async () => {
    const live = { yedGetPrice: async () => ({ height: 7, pFast: 310_000, pMid: 300_000, pSlow: null, pMint: null, pClaim: null, armed: false, attestStatus: "x" }) };
    expect(await currentPrice(live)).toEqual({ priceMicroUsd: 300_000, source: "yed_getprice:pMid", height: 7 });
    const fastOnly = { yedGetPrice: async () => ({ height: 7, pFast: 310_000, pMid: null, pSlow: null, pMint: null, pClaim: null, armed: false, attestStatus: "x" }) };
    expect((await currentPrice(fastOnly)).source).toBe("yed_getprice:pFast");
    const stock = { yedGetPrice: async () => Promise.reject(new RpcError(-32601, "Method not found", "yed_getprice")) };
    expect(await currentPrice(stock, 250_000)).toEqual({ priceMicroUsd: 250_000, source: "configured" });
    await expect(currentPrice(stock)).rejects.toThrow(/no YEC price/);
    const none = { yedGetPrice: async () => ({ height: 1, pFast: null, pMid: null, pSlow: null, pMint: null, pClaim: null, armed: false, attestStatus: "x" }) };
    expect((await currentPrice(none, 1)).source).toBe("configured");
    const down = { yedGetPrice: async () => Promise.reject(new RpcError(0, "refused", "yed_getprice", { transport: true })) };
    await expect(currentPrice(down, 1)).rejects.toThrow(/refused/);
  });
});

const issued = (payTo: string, retainUntil: number): IssuedRequest => ({ record: { ...RECORD, payTo }, memo: memoForRecord({ ...RECORD, payTo }), confirmations: 1, issuedAt: 0, retainUntil });

describe.each([
  ["in memory", (): IssuedAddressRegistry => new InMemoryIssuedAddressRegistry()],
  ["file", (): IssuedAddressRegistry => new FileIssuedAddressRegistry(join(mkdtempSync(join(tmpdir(), "x402-reg-")), "issued.json"))],
])("issued-address registry (%s)", (_, make) => {
  it("never issues an address twice, even after its record is pruned", async () => {
    const r = make();
    expect(await r.issue("a", issued("a", 100))).toBe(true);
    expect(await r.issue("a", issued("a", 100))).toBe(false);
    expect(await r.issue("b", issued("b", 200))).toBe(true);
    expect((await r.get("a"))?.record.payTo).toBe("a");
    expect(await r.outstanding(150)).toBe(1);
    expect(await r.prune(150)).toBe(1);
    expect(await r.get("a")).toBeUndefined();
    expect(await r.wasIssued("a")).toBe(true);
    expect(await r.issue("a", issued("a", 999))).toBe(false);
    expect((await r.get("b"))?.retainUntil).toBe(200);
  });
  it("retains a record past expiresAt by twice the policy depth plus grace", () => {
    expect(recordRetainUntil(1000, 1, 60)).toBe(1000 + 150 + 60);
    expect(recordRetainUntil(1000, -1, 0)).toBe(1150);
    expect(recordRetainUntil(1000, 6, 0)).toBe(1000 + 900);
  });
});

describe("offer-and-receipt JWS (ES256K)", () => {
  const priv = new Uint8Array(32).fill(7);
  const pub = secp.getPublicKey(priv, true);
  const signer = es256kSigner(priv);

  it("names the key with a did:jwk that resolves back to it", () => {
    expect(signer.kid).toMatch(/^did:jwk:/);
    expect(publicKeyFromDidJwk(signer.kid)).toEqual(pub);
    expect(didJwkFor(secp.getPublicKey(priv, false))).toBe(signer.kid);
    expect(() => publicKeyFromDidJwk("did:web:example.com")).toThrow();
  });
  it("signs a receipt that verifies against the trusted key only", async () => {
    const r = await signReceipt({ network: YCASH_REGTEST, resourceUrl: "https://x/y", transaction: "ab".repeat(32), issuedAt: 1000 }, signer);
    expect(r.format).toBe("jws");
    const [h] = r.signature.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "ES256K", kid: signer.kid });
    const p = verifyReceipt(r, { trustedPublicKeys: [pub], now: 1100 });
    expect(p).toEqual({ version: 1, network: YCASH_REGTEST, resourceUrl: "https://x/y", payer: "anonymous", issuedAt: 1000, transaction: "ab".repeat(32) });
    expect(verifyReceipt(r, { trustedPublicKeys: [Buffer.from(pub).toString("hex")] }).payer).toBe("anonymous");
    const other = secp.getPublicKey(new Uint8Array(32).fill(9), true);
    expect(() => verifyReceipt(r, { trustedPublicKeys: [other] })).toThrow(/not authorised/);
    expect(() => verifyReceipt(r, { trustedPublicKeys: [pub], now: 5000, maxAgeSeconds: 60 })).toThrow(/too old/);
  });
  it("refuses a tampered payload, a swapped kid, or another alg", async () => {
    const r = await signReceipt({ network: YCASH_REGTEST, resourceUrl: "https://x/y", transaction: "ab".repeat(32) }, signer);
    const [h, p, s] = r.signature.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), resourceUrl: "https://evil" })).toString("base64url");
    expect(() => verifyJws(`${h}.${forged}.${s}`, { trustedPublicKeys: [pub] })).toThrow(/bad signature/);
    const otherSigner = es256kSigner(new Uint8Array(32).fill(9));
    const h2 = Buffer.from(JSON.stringify({ alg: "ES256K", kid: otherSigner.kid })).toString("base64url");
    expect(() => verifyJws(`${h2}.${p}.${s}`, { trustedPublicKeys: [pub] })).toThrow(/bad signature/);
    const h3 = Buffer.from(JSON.stringify({ alg: "none", kid: signer.kid })).toString("base64url");
    expect(() => verifyJws(`${h3}.${p}.${s}`, { trustedPublicKeys: [pub] })).toThrow(/alg/);
    expect(() => verifyJws("a.b", { trustedPublicKeys: [pub] })).toThrow();
  });
  it("signs offers and arbitrary JCS payloads", async () => {
    const o = await signOffer({ resourceUrl: "https://x/y", scheme: "exact", network: YCASH_REGTEST, asset: "YEC", payTo: "yregtestsapling1q", amount: "5", validUntil: 9 }, signer);
    expect(verifyJws<{ version: number; amount: string }>(o.signature, { trustedPublicKeys: [pub] }).payload).toMatchObject({ version: 1, amount: "5" });
    const jws = await createJws({ b: 1, a: 2 }, signer);
    expect(Buffer.from(jws.split(".")[1]!, "base64url").toString()).toBe('{"a":2,"b":1}');
  });
});
