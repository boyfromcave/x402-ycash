import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addressToScript, base58CheckDecode, base58CheckEncode, bytesToHex, decodeAddress, decodeWif, encodeAddress, encodePQAddress, hash160,
  hexToBytes, isPQKind, isYedKind, p2pkhScript, p2shScript, pubkeyFromPriv,
} from "../../src/tx/index.js";
import { pqpkhScript } from "../../src/pq/index.js";
import { YCASH_NETWORKS } from "../../src/constants.js";

const h = new Uint8Array(20).fill(0x11);

describe("addresses", () => {
  it("encode with each network's version bytes (s1/s2-s3 mainnet; sm/s2 testnet and regtest; yb/yt/yr)", () => {
    const prefixes = YCASH_NETWORKS.map((n) => (["p2pkh", "p2sh", "yed"] as const).map((k) => encodeAddress(n, k, h).slice(0, 2)));
    expect(prefixes).toEqual([["s1", "s2", "yb"], ["sm", "s2", "yt"], ["sm", "s2", "yr"]]);
    const versions = YCASH_NETWORKS.map((n) => (["p2pkh", "p2sh", "yed"] as const).map((k) => bytesToHex(base58CheckDecode(encodeAddress(n, k, h)).slice(0, 2))));
    // D-Q-21: mainnet YED is 0x1FDD "yb…" on the quantum line (0x1FE4 "ye…" before it)
    expect(versions).toEqual([["1c28", "1c2c", "1fdd"], ["1c95", "1c2a", "2007"], ["1c95", "1c2a", "2002"]]);
  });

  it("post-quantum forms: 53 characters, yb/yt/yr for YED (quantum spec §4, D-Q-21) and sq/tq/rq for plain YEC (D-Q-20)", () => {
    const pqh = new Uint8Array(32).fill(0x22);
    for (const scheme of [1, 2] as const) {
      const prefixes = YCASH_NETWORKS.map((n) => (["yedpq", "pq"] as const).map((k) => encodePQAddress(n, k, { scheme, hash: pqh })));
      expect(prefixes.map((r) => r.map((a) => a.slice(0, 2)))).toEqual([["yb", "sq"], ["yt", "tq"], ["yr", "rq"]]);
      expect(prefixes.flat().every((a) => a.length === 53)).toBe(true);
      const versions = YCASH_NETWORKS.map((n) => (["yedpq", "pq"] as const).map((k) => bytesToHex(base58CheckDecode(encodePQAddress(n, k, { scheme, hash: pqh })).slice(0, 3))));
      expect(versions).toEqual([[`56ab0${scheme}`, `4dd90${scheme}`], [`571e0${scheme}`, `4f610${scheme}`], [`57100${scheme}`, `4c510${scheme}`]]);
      for (const n of YCASH_NETWORKS) {
        for (const k of ["yedpq", "pq"] as const) {
          const a = encodePQAddress(n, k, { scheme, hash: pqh });
          // PQ prefixes are distinct per network, so the network is always recovered
          expect(decodeAddress(a)).toEqual({ network: n, kind: k, hash: pqh, scheme });
          expect(addressToScript(a, n)).toEqual(pqpkhScript({ scheme, hash: pqh }));
        }
      }
    }
    expect(isYedKind("yedpq") && isYedKind("yed") && !isYedKind("pq") && isPQKind("pq") && !isPQKind("yed")).toBe(true);
  });

  it("refuses a post-quantum address with an unknown scheme, and a 20-byte YED payload of 33 bytes", () => {
    const bad = base58CheckEncode(Uint8Array.from([0x57, 0x10, 0x03, ...new Uint8Array(32)]));
    expect(() => decodeAddress(bad)).toThrow(/scheme 3/);
    expect(() => encodeAddress("ycash:regtest", "yedpq", Uint8Array.from([3, ...new Uint8Array(32)]))).toThrow(/scheme 3/);
    expect(() => encodeAddress("ycash:regtest", "yed", new Uint8Array(33))).toThrow(/20 bytes/);
    expect(() => encodeAddress("ycash:regtest", "pq", new Uint8Array(20))).toThrow(/scheme/);
    // a 35-byte payload under a 20-byte version is not an address
    expect(() => decodeAddress(base58CheckEncode(Uint8Array.from([0x20, 0x02, 0x01, ...new Uint8Array(32)])))).toThrow(/unknown version/);
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
