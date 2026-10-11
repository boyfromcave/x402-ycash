// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// Byte identity with the node's post-quantum library: vectors/pq/pq_vectors.json is ycash-dd's
// src/test/data/pq_vectors.json (upgrade/quantum-vaults @ aa0fd3812), recomputed by its
// src/test/pq_crypto_tests.cpp from the vendored FIPS 205 SLH-DSA and PQClean falcon-padded-512.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as pq from "../../src/pq/index.js";
import { buildScript, bytesToHex, hexToBytes, parseScript } from "../../src/tx/index.js";

interface Key { scheme: number; name: string; seed: string; pk: string; keyhash: string; msg: string; entropy: string; sig: string }
interface Spend { scheme: number; key: number; scriptPubKey: string; hashtype: number; sigChunks: number; pkChunks: number; scriptSigSize: number; scriptSig: string }
const file = fileURLToPath(new URL("../../../../vectors/pq/pq_vectors.json", import.meta.url));
const v = JSON.parse(readFileSync(file, "utf8")) as { format: string; keys: Key[]; spends: Spend[] };

describe("post-quantum vectors (ycash-dd pq_vectors.json)", () => {
  it("is the ycash-pq-vectors-1 format with SLH-DSA and Falcon keys", () => {
    expect(v.format).toBe("ycash-pq-vectors-1");
    expect(v.keys.filter((k) => k.scheme === 1).length).toBeGreaterThanOrEqual(2);
    expect(v.keys.filter((k) => k.scheme === 2).length).toBeGreaterThanOrEqual(2);
  });

  for (const [i, k] of v.keys.entries()) {
    it(`key ${i} (${k.name}): keygen from the seed, key hash, and the signature byte for byte`, () => {
      const scheme = k.scheme as pq.PQScheme;
      const kp = pq.pqKeygen(scheme, hexToBytes(k.seed));
      expect(bytesToHex(kp.publicKey)).toBe(k.pk);
      expect(bytesToHex(pq.keyHash(scheme, kp.publicKey))).toBe(k.keyhash);
      const sig = pq.pqSign(scheme, kp.secretKey, hexToBytes(k.msg), k.entropy ? hexToBytes(k.entropy) : undefined);
      expect(bytesToHex(sig)).toBe(k.sig);
      expect(pq.pqVerify(scheme, hexToBytes(k.pk), hexToBytes(k.sig), hexToBytes(k.msg))).toBe(true);
      const bad = hexToBytes(k.sig);
      bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
      expect(pq.pqVerify(scheme, hexToBytes(k.pk), bad, hexToBytes(k.msg))).toBe(false);
      expect(pq.pqVerify(scheme, hexToBytes(k.pk), hexToBytes(k.sig), new Uint8Array(32))).toBe(false);
      expect(pq.pqVerify(3, hexToBytes(k.pk), hexToBytes(k.sig), hexToBytes(k.msg))).toBe(false);
    });
  }

  for (const s of v.spends) {
    it(`spend scheme ${s.scheme}: TX_PQPKH and the chunked scriptSig (${s.sigChunks} + ${s.pkChunks} chunks, ${s.scriptSigSize} bytes)`, () => {
      const k = v.keys[s.key]!;
      const scheme = s.scheme as pq.PQScheme;
      const spk = pq.pqpkhScript({ scheme, hash: hexToBytes(k.keyhash) });
      expect(bytesToHex(spk)).toBe(s.scriptPubKey);
      expect(pq.pqpkhKeyId(spk)).toEqual({ scheme, hash: hexToBytes(k.keyhash) });
      const sig = Uint8Array.from([...hexToBytes(k.sig), s.hashtype]);
      const ss = buildScript(pq.pqSpendItems(hexToBytes(k.pk), sig));
      expect(bytesToHex(ss)).toBe(s.scriptSig);
      expect(ss.length).toBe(s.scriptSigSize);
      expect(pq.pqSpendSize(scheme)).toBe(s.scriptSigSize);
      const parsed = pq.parsePQSpend(parseScript(ss));
      expect(parsed && bytesToHex(parsed.pk)).toBe(k.pk);
      expect(parsed && bytesToHex(parsed.sig)).toBe(bytesToHex(sig));
      expect(pq.spendMatches(parsed!, { scheme, hash: hexToBytes(k.keyhash) })).toBe(true);
      expect(pq.spendMatches(parsed!, { scheme, hash: new Uint8Array(32) })).toBe(false);
    });
  }

  it("refuses a non-canonical chunking, a wrong count and a mixed-scheme spend", () => {
    const k = v.keys.find((x) => x.scheme === 1)!;
    const sig = Uint8Array.from([...hexToBytes(k.sig), 1]);
    const good = parseScript(buildScript(pq.pqSpendItems(hexToBytes(k.pk), sig)));
    expect(pq.parsePQSpend(good)).not.toBeNull();
    // a 519-byte first chunk
    const shifted = parseScript(buildScript([sig.slice(0, 519), ...pq.chunk(sig.slice(519)), 16n, hexToBytes(k.pk), 1n]));
    expect(pq.parsePQSpend(shifted)).toBeNull();
    // s claims 15
    expect(pq.parsePQSpend(parseScript(buildScript([...pq.chunk(sig).slice(1), 15n, hexToBytes(k.pk), 1n])))).toBeNull();
    // a Falcon-sized key with an SLH signature
    expect(pq.parsePQSpend(parseScript(buildScript([...pq.chunk(sig), 16n, ...pq.chunk(new Uint8Array(897)), 2n])))).toBeNull();
    // extra trailing push
    expect(pq.parsePQSpend([...good, { op: 0x51 }])).toBeNull();
  });

  it("sizes: SLH-DSA 32/7856 (s = 16, p = 1), Falcon 897/666 (s = 2, p = 2)", () => {
    expect([pq.pubKeySize(1), pq.sigSize(1), pq.pubKeySize(2), pq.sigSize(2), pq.pubKeySize(3)]).toEqual([32, 7856, 897, 666, 0]);
    expect(pq.chunk(new Uint8Array(7857)).map((c) => c.length)).toEqual([...Array(15).fill(520), 57]);
    expect(pq.chunk(new Uint8Array(667)).map((c) => c.length)).toEqual([520, 147]);
    expect(pq.chunk(new Uint8Array(897)).map((c) => c.length)).toEqual([520, 377]);
  });
});
