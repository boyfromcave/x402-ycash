import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  SIGHASH, bytesToHex, decodeWif, encodeWif, hash160, hexToBytes, pubkeyFromPriv, randomPrivKey, sigHashType,
  signInput, verifyInputSig,
} from "../../src/tx/index.js";
import { decodeDer, encodeDer } from "../../src/tx/der.js";

const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const priv1 = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");

describe("keys", () => {
  it("derives compressed and uncompressed public keys", () => {
    expect(bytesToHex(pubkeyFromPriv(priv1))).toBe("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    expect(pubkeyFromPriv(priv1, false)).toHaveLength(65);
    expect(bytesToHex(hash160(pubkeyFromPriv(priv1)))).toBe("751e76e8199196d454941c45d1b3a323f1433bd6");
  });

  it("signs with RFC 6979 (the deterministic nonce the node uses)", () => {
    // The classic RFC 6979 secp256k1 vector: key 1, message "Satoshi Nakamoto".
    const digest = sha256(new TextEncoder().encode("Satoshi Nakamoto"));
    const sig = signInput(digest, priv1, SIGHASH.ALL);
    expect(bytesToHex(sig)).toBe(
      "3045022100934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8" +
        "02202442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5" + "01",
    );
    expect(signInput(digest, priv1, SIGHASH.ALL)).toEqual(sig);
  });

  it("emits low-S strict DER with the hash-type byte appended, and verifies it", () => {
    for (let i = 0; i < 20; i++) {
      const k = randomPrivKey();
      const digest = sha256(Uint8Array.of(i));
      const ht = [SIGHASH.ALL, SIGHASH.NONE, SIGHASH.SINGLE | SIGHASH.ANYONECANPAY][i % 3]!;
      const sig = signInput(digest, k, ht);
      expect(sigHashType(sig)).toBe(ht);
      const compact = decodeDer(sig.slice(0, -1));
      const s = BigInt("0x" + bytesToHex(compact.slice(32)));
      expect(s <= N / 2n).toBe(true);
      expect(encodeDer(compact)).toEqual(sig.slice(0, -1));
      expect(verifyInputSig(sig, digest, pubkeyFromPriv(k))).toBe(true);
      expect(verifyInputSig(sig, sha256(digest), pubkeyFromPriv(k))).toBe(false);
    }
  });

  it("refuses a high-S signature and malformed DER", () => {
    const digest = sha256(Uint8Array.of(1));
    const sig = signInput(digest, priv1);
    const compact = decodeDer(sig.slice(0, -1));
    const s = BigInt("0x" + bytesToHex(compact.slice(32)));
    const highS = hexToBytes((N - s).toString(16).padStart(64, "0"));
    const malleated = Uint8Array.from([...encodeDer(Uint8Array.from([...compact.slice(0, 32), ...highS])), 1]);
    expect(verifyInputSig(malleated, digest, pubkeyFromPriv(priv1))).toBe(false);
    expect(verifyInputSig(Uint8Array.of(0x30, 1), digest, pubkeyFromPriv(priv1))).toBe(false);
    expect(() => signInput(new Uint8Array(31), priv1)).toThrow(/32 bytes/);
  });

  it("DER: minimal integers, sign padding, and BIP66 rejections", () => {
    const c = new Uint8Array(64);
    c[31] = 1;
    c[32] = 0x80;
    expect(bytesToHex(encodeDer(c))).toBe("3026020101022100" + "80" + "00".repeat(31));
    expect(decodeDer(encodeDer(c))).toEqual(c);
    expect(() => decodeDer(hexToBytes("3007020200010201010000"))).toThrow(); // trailing / bad length
    expect(() => decodeDer(hexToBytes("300702020001020101"))).toThrow(/non-minimal/);
    expect(() => decodeDer(hexToBytes("3006020180020101"))).toThrow(/negative/);
    expect(() => decodeDer(hexToBytes("3106020101020101"))).toThrow(/sequence/);
  });
});

describe("WIF", () => {
  it("decodes the node's regtest WIF (YEW vector) and re-encodes it", () => {
    const wif = "cUV3ATWopGBqmCM7j7oaRKWcu88wnHV9kyxDTrjAcVFZQ9h85Cvx";
    const d = decodeWif(wif, "ycash:regtest");
    expect(d.compressed).toBe(true);
    expect(d.network).toBe("ycash:regtest");
    expect(bytesToHex(pubkeyFromPriv(d.privKey))).toBe("02941608993bd01d43fbc065504a61924f68e21c3ad605489f13147fda411b38a4");
    expect(encodeWif(d.privKey, "ycash:regtest")).toBe(wif);
  });

  it("uses 0x80 on mainnet and 0xEF on testnet and regtest, compressed or not", () => {
    expect(encodeWif(priv1, "ycash:mainnet")).toBe("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");
    expect(encodeWif(priv1, "ycash:mainnet", false)).toBe("5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf");
    expect(encodeWif(priv1, "ycash:testnet")).toBe(encodeWif(priv1, "ycash:regtest"));
    expect(decodeWif(encodeWif(priv1, "ycash:mainnet", false))).toEqual({ privKey: priv1, compressed: false, network: "ycash:mainnet" });
    expect(decodeWif(encodeWif(priv1, "ycash:testnet")).network).toBe("ycash:testnet");
  });

  it("refuses the wrong network, a bad checksum and a bad length", () => {
    const main = encodeWif(priv1, "ycash:mainnet");
    expect(() => decodeWif(main, "ycash:regtest")).toThrow(/not for/);
    expect(() => decodeWif(encodeWif(priv1, "ycash:regtest"), "ycash:mainnet")).toThrow(/not for/);
    expect(() => decodeWif(main.slice(0, -1) + (main.endsWith("n") ? "m" : "n"))).toThrow(/checksum/);
    expect(() => encodeWif(new Uint8Array(31), "ycash:mainnet")).toThrow(/32 bytes/);
  });
});
