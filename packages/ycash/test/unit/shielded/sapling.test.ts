// The offline Sapling address derivation against FF1's Zcash test vectors and against
// vectors/shielded/divaddr.json: addresses each node line's wallet issued, and sapling-crypto 0.7's
// offline derivation of the same key (tools/x4m/rust divaddr).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bech32Decode,
  bech32Encode,
  decodeSaplingViewingKey,
  diversifier,
  ff1Aes256EncryptBits,
  findSaplingAddress,
  saplingAddressAt,
  SAPLING_EXTFVK_HRP,
} from "../../../src/shielded/index.js";

interface Derived {
  index: string;
  address: string;
}
interface Vectors {
  cases: { line: string; network: "ycash:regtest"; viewingKey: string; nodeAddresses: (Derived & { rpc: string })[]; rust: { start: string; addresses: Derived[] }[] }[];
  mainnet: { viewingKey: string; rust: { start: string; addresses: Derived[] }[] };
}
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../vectors/shielded/divaddr.json", import.meta.url)), "utf8")) as Vectors;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

describe("FF1-AES256, radix 2 (zcash-test-vectors ff1.py, as fpe 0.6 carries them)", () => {
  const key = unhex("2b7e151628aed2a6abf7158809cf4f3cef4359d8d580aa4f7f036d6f04fc6a94");
  it.each([
    ["00".repeat(11), "", "90acee3f83cde7ae5622f3"],
    ["90acee3f83cde7ae5622f3", "", "5b8bf120f39bab8527ea1b"],
    ["aa".repeat(11), "", "f082b7ee8f29c07691ce64"],
    ["aa".repeat(11), Buffer.from(Array.from({ length: 255 }, (_, i) => i)).toString("hex"), "be11b886a8059c27517bc5"],
  ])("%s, tweak of %# → %s", (pt, tweak, ct) => {
    expect(hex(ff1Aes256EncryptBits(key, unhex(tweak), unhex(pt)))).toBe(ct);
  });
  it("a zero key over 32 bits (fpe's own case)", () => {
    expect(hex(ff1Aes256EncryptBits(new Uint8Array(32), new Uint8Array(0), new Uint8Array(4)))).toBe("7bf9041b");
  });
  it("refuses a short key or fewer than 20 numerals", () => {
    expect(() => ff1Aes256EncryptBits(new Uint8Array(16), new Uint8Array(0), new Uint8Array(11))).toThrow(/32-byte/);
    expect(() => ff1Aes256EncryptBits(key, new Uint8Array(0), new Uint8Array(2))).toThrow(/20 numerals/);
  });
});

describe("bech32 without a length limit", () => {
  it("round-trips a viewing key and refuses a corrupted one", () => {
    const k = vectors.cases[0]!.viewingKey;
    const { hrp, bytes } = bech32Decode(k);
    expect(hrp).toBe("zxviewregtestsapling");
    expect(bytes.length).toBe(169);
    expect(bech32Encode(hrp, bytes)).toBe(k);
    const bad = k.slice(0, -1) + (k.endsWith("q") ? "p" : "q");
    expect(() => bech32Decode(bad)).toThrow(/checksum/);
    expect(() => bech32Decode(k.toUpperCase())).not.toThrow();
    expect(() => bech32Decode(k.slice(0, 30) + k.slice(30).toUpperCase())).toThrow(/mixed case/);
  });
});

describe.each(vectors.cases.map((c) => [c.line, c] as const))("addresses of a %s wallet's key", (_line, c) => {
  const key = decodeSaplingViewingKey(c.viewingKey, c.network);
  it("equal the node wallet's z_getnewaddress and z_getnewdiversifiedaddress at the same index", () => {
    for (const a of c.nodeAddresses) expect(saplingAddressAt(key, BigInt(a.index))).toBe(a.address);
    expect(findSaplingAddress(key, 0n).address).toBe(c.nodeAddresses[0]!.address);
  });
  it("equal sapling-crypto's find_address walk (low, 2^40, 2^63)", () => {
    for (const run of c.rust) {
      let j = BigInt(run.start);
      for (const a of run.addresses) {
        const got = findSaplingAddress(key, j);
        expect({ index: got.index.toString(), address: got.address }).toEqual(a);
        j = got.index + 1n;
      }
    }
  });
  it("skips invalid diversifiers exactly where sapling-crypto does", () => {
    const low = c.rust[0]!.addresses.map((a) => BigInt(a.index));
    const last = low[low.length - 1]!;
    for (let j = 0n; j <= last; j++) expect(saplingAddressAt(key, j) !== undefined).toBe(low.includes(j));
  });
  it("refuses the key under another network", () => {
    expect(() => decodeSaplingViewingKey(c.viewingKey, "ycash:testnet")).toThrow(/not a ycash:testnet Sapling viewing key/);
  });
});

describe("mainnet HRPs", () => {
  it("derive ys… addresses from a zxviews… key, as sapling-crypto does", () => {
    const key = decodeSaplingViewingKey(vectors.mainnet.viewingKey, "ycash:mainnet");
    let j = BigInt(vectors.mainnet.rust[0]!.start);
    for (const a of vectors.mainnet.rust[0]!.addresses) {
      const got = findSaplingAddress(key, j);
      expect(got.address).toBe(a.address);
      expect(got.address.startsWith("ys1")).toBe(true);
      j = got.index + 1n;
    }
  });
  it("names the three extended-FVK HRPs", () => {
    expect(SAPLING_EXTFVK_HRP).toEqual({ "ycash:mainnet": "zxviews", "ycash:testnet": "zxviewtestsapling", "ycash:regtest": "zxviewregtestsapling" });
  });
});

describe("decodeSaplingViewingKey", () => {
  it("refuses a wrong length and an index outside 88 bits", () => {
    expect(() => decodeSaplingViewingKey(bech32Encode("zxviewregtestsapling", new Uint8Array(168)), "ycash:regtest")).toThrow(/169 bytes/);
    const key = decodeSaplingViewingKey(vectors.cases[0]!.viewingKey, "ycash:regtest");
    expect(() => diversifier(key.dk, 1n << 88n)).toThrow(RangeError);
    expect(() => diversifier(key.dk, -1n)).toThrow(RangeError);
  });
});
