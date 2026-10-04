import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addressToScript, base58CheckDecode, base58CheckEncode, bytesToHex, decodeAddress, decodeWif, encodeAddress, hash160,
  hexToBytes, p2pkhScript, p2shScript, pubkeyFromPriv,
} from "../../src/tx/index.js";
import { YCASH_NETWORKS } from "../../src/constants.js";

const h = new Uint8Array(20).fill(0x11);

describe("addresses", () => {
  it("encode with each network's version bytes (s1/s2-s3 mainnet; sm/s2 testnet and regtest; ye/yt/yr)", () => {
    const prefixes = YCASH_NETWORKS.map((n) => (["p2pkh", "p2sh", "yed"] as const).map((k) => encodeAddress(n, k, h).slice(0, 2)));
    expect(prefixes).toEqual([["s1", "s2", "ye"], ["sm", "s2", "yt"], ["sm", "s2", "yr"]]);
    const versions = YCASH_NETWORKS.map((n) => (["p2pkh", "p2sh", "yed"] as const).map((k) => bytesToHex(base58CheckDecode(encodeAddress(n, k, h)).slice(0, 2))));
    expect(versions).toEqual([["1c28", "1c2c", "1fe4"], ["1c95", "1c2a", "2007"], ["1c95", "1c2a", "2002"]]);
  });

  it("decode a mainnet Ycash founders' address (ycash-dd/src/chainparams.cpp:316)", () => {
    const d = decodeAddress("s1hfWJ4ej1H3s8XCUb7YnrU68K64AsGVUHE");
    expect(d.network).toBe("ycash:mainnet");
    expect(d.kind).toBe("p2pkh");
    expect(encodeAddress("ycash:mainnet", "p2pkh", d.hash)).toBe("s1hfWJ4ej1H3s8XCUb7YnrU68K64AsGVUHE");
  });

  it("round-trip every network and kind; testnet and regtest share transparent prefixes", () => {
    for (const n of YCASH_NETWORKS) {
      for (const k of ["p2pkh", "p2sh", "yed"] as const) {
        const a = encodeAddress(n, k, h);
        expect(decodeAddress(a, n)).toEqual({ network: n, kind: k, hash: h });
        const guessed = decodeAddress(a);
        expect(guessed.kind).toBe(k);
        expect(guessed.network).toBe(n === "ycash:regtest" && k !== "yed" ? "ycash:testnet" : n);
      }
    }
  });

  it("refuses another network's address when one is named", () => {
    expect(() => decodeAddress(encodeAddress("ycash:mainnet", "p2pkh", h), "ycash:regtest")).toThrow(/not a ycash:regtest/);
    expect(() => decodeAddress(encodeAddress("ycash:testnet", "yed", h), "ycash:regtest")).toThrow(/not a ycash:regtest/);
  });

  it("refuses Zcash addresses, bad checksums and bad lengths", () => {
    expect(() => decodeAddress("t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd")).toThrow(/unknown version/); // Zcash founders (1C BD)
    const a = encodeAddress("ycash:mainnet", "yed", h);
    expect(() => decodeAddress(a.slice(0, -1) + (a.endsWith("1") ? "2" : "1"))).toThrow(/checksum/);
    expect(() => decodeAddress(base58CheckEncode(Uint8Array.from([0x1c, 0x28, ...new Uint8Array(19)])))).toThrow(/length/);
    expect(() => decodeAddress("s1-not-base58")).toThrow(/base58/);
    expect(() => encodeAddress("ycash:mainnet", "p2pkh", new Uint8Array(21))).toThrow(/20 bytes/);
  });

  it("map to scriptPubKeys (a YED address pays a plain P2PKH script)", () => {
    expect(addressToScript(encodeAddress("ycash:regtest", "p2pkh", h))).toEqual(p2pkhScript(h));
    expect(addressToScript(encodeAddress("ycash:regtest", "p2sh", h))).toEqual(p2shScript(h));
    expect(addressToScript(encodeAddress("ycash:regtest", "yed", h))).toEqual(p2pkhScript(h));
  });

  it("match the node's regtest addresses for the same keys (YEW vectors from ycash-dd)", () => {
    const file = fileURLToPath(new URL("../../../../vectors/tx/yew-transparent.json", import.meta.url));
    const yew = JSON.parse(readFileSync(file, "utf8")) as { transactions: { keys: { wif: string; address: string; address_ye: string; hash160Hex: string }[] }[] };
    for (const k of yew.transactions.flatMap((t) => t.keys)) {
      const pkh = hash160(pubkeyFromPriv(decodeWif(k.wif).privKey));
      expect(bytesToHex(pkh)).toBe(k.hash160Hex);
      expect(encodeAddress("ycash:regtest", "p2pkh", pkh)).toBe(k.address);
      expect(encodeAddress("ycash:regtest", "yed", pkh)).toBe(k.address_ye);
      expect(decodeAddress(k.address_ye).network).toBe("ycash:regtest");
    }
  });

  it("base58 keeps leading zero bytes", () => {
    const b = hexToBytes("0000ff");
    expect(base58CheckDecode(base58CheckEncode(b))).toEqual(b);
    expect(base58CheckEncode(b).startsWith("11")).toBe(true);
  });
});
