// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// The wider Falcon known-answer run. noble's Falcon (@noble/post-quantum 0.7.1) samples in IEEE-754
// double arithmetic, so byte identity with the node's PQClean `falcon-padded-512/clean` (integer-
// emulated floating point) is checked on many more keys and signatures than pq_vectors.json's three:
//
// 1. NIST round-3 `falcon512-KAT.rsp` (100 entries: keygen from the AES-256-CTR DRBG, the signed
//    message `sm`, 33..3,300-byte messages), regenerated here byte for byte and compared with the
//    published file's SHA-256 (Falcon-Round3.zip from csrc.nist.gov, `KAT/falcon512-KAT.rsp`,
//    dd75c946…b5cd). When FALCON_KAT_RSP names a copy of the file, each entry is also compared
//    field by field, so a failure names its count.
// 2. PQClean `falcon-padded-512` and `falcon-512` (master 0586a824fc0d, 2026-10-10), both of PQClean's
//    own KAT outputs, compared with the SHA-256 their META.yml records:
//    - `testvectors` (test/crypto_sign/testvectors.c over test/common/notrandombytes.c): 7 key pairs,
//      7 attached and 7 detached signatures over 0..1,024-byte messages;
//    - `nistkat` (test/crypto_sign/nistkat.c over the NIST DRBG): 1 key pair and 1 attached signature.
//
// Nothing is downloaded: every input is generated from the published deterministic RNGs, and only the
// expected digests are constants. Run with `npm run test:kat -w x402-ycash-mechanism`.
import { createCipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { falcon512, falcon512padded } from "@noble/post-quantum/falcon.js";
import { describe, expect, it } from "vitest";

type Falcon = typeof falcon512;
type Rng = (n: number) => Uint8Array;

const NIST_ROUND3_FALCON512_RSP_SHA256 = "dd75c946fdedef4ec46a2bee7e10c65c9126f1a839b9ced6921fd45f7354b5cd";
const PQCLEAN = {
  "falcon-padded-512": { nistkat: "91842d41138e7cfaf6e2e8f12a03c3b3411302255121e4d07d02f91a003c0395", testvectors: "a380380196d874a5ecd3616e17a807dd58674b7f5456e21140564d503a8610e1" },
  "falcon-512": { nistkat: "da27fe8a462de7307ddf1f9b00072a457d9c5b14e838c148fbe2662094b9a2ca", testvectors: "e6d6d5b0ee34ccdeabfc9d7e5487adafedec13b425f2fe991a1fa6efff3be68a" },
} as const;

/** NIST's AES-256-CTR DRBG (PQCgenKAT rng.c / PQClean nistkatrng.c): one Update after every call. */
class NistDrbg {
  private key = new Uint8Array(32);
  private v = new Uint8Array(16);
  constructor(entropy: Uint8Array) {
    this.update(entropy);
  }
  private block(): Uint8Array {
    for (let j = 15; j >= 0; j--) {
      if (this.v[j] === 0xff) this.v[j] = 0;
      else {
        this.v[j]!++;
        break;
      }
    }
    const c = createCipheriv("aes-256-ecb", this.key, null);
    c.setAutoPadding(false);
    return new Uint8Array(c.update(this.v));
  }
  private update(provided?: Uint8Array): void {
    const temp = new Uint8Array(48);
    for (let i = 0; i < 3; i++) temp.set(this.block(), 16 * i);
    if (provided) for (let i = 0; i < 48; i++) temp[i]! ^= provided[i]!;
    this.key = temp.slice(0, 32);
    this.v = temp.slice(32, 48);
  }
  randombytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 16) out.set(this.block().subarray(0, Math.min(16, n - i)), i);
    this.update();
    return out;
  }
}

/** PQClean's test/common/notrandombytes.c (D. J. Bernstein's surf): a predictable byte stream. */
function notRandomBytes(): Rng {
  const seed = Uint32Array.from([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4, 6, 2, 6, 4, 3, 3, 8, 3, 2, 7, 9, 5]);
  const inp = new Uint32Array(12);
  const out = new Uint32Array(8);
  let outleft = 0;
  const surf = (): void => {
    const t = new Uint32Array(12);
    for (let i = 0; i < 12; i++) t[i] = inp[i]! ^ seed[12 + i]!;
    for (let i = 0; i < 8; i++) out[i] = seed[24 + i]!;
    let x = t[11]!;
    let sum = 0;
    const rot = (v: number, b: number): number => ((v << b) | (v >>> (32 - b))) >>> 0;
    for (let loop = 0; loop < 2; loop++) {
      for (let r = 0; r < 16; r++) {
        sum = (sum + 0x9e3779b9) >>> 0;
        for (let i = 0; i < 12; i++) {
          const b = [5, 7, 9, 13][i % 4]!;
          t[i] = (t[i]! + ((((x ^ seed[i]!) >>> 0) + sum) ^ rot(x, b))) >>> 0;
          x = t[i]!;
        }
      }
      for (let i = 0; i < 8; i++) out[i] = out[i]! ^ t[i + 4]!;
    }
  };
  return (n: number) => {
    const buf = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (!outleft) {
        if (!(inp[0] = (inp[0]! + 1) >>> 0)) if (!(inp[1] = (inp[1]! + 1) >>> 0)) if (!(inp[2] = (inp[2]! + 1) >>> 0)) inp[3] = (inp[3]! + 1) >>> 0;
        surf();
        outleft = 8;
      }
      buf[k] = out[--outleft]! & 0xff;
    }
    return buf;
  };
}

const hexU = (b: Uint8Array): string => (b.length === 0 ? "00" : Buffer.from(b).toString("hex").toUpperCase());
const hexL = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const sha256 = (s: string): string => createHash("sha256").update(s, "latin1").digest("hex");

/** Falcon randomness in PQClean's order: keygen draws 48 bytes; a signature 40 (nonce) then 48 (sampler seed). */
const keygen = (f: Falcon, rng: Rng) => f.keygen(rng(48));
const signOpts = (rng: Rng) => ({ random: (n = 0) => rng(n) }) as unknown as Parameters<Falcon["sign"]>[2];

/** PQClean falcon-padded-512 crypto_sign: 0x39 ‖ nonce ‖ padded s2 ‖ m (noble's detached padded signature, then m). */
function smPadded(sk: Uint8Array, m: Uint8Array, rng: Rng): Uint8Array {
  const sig = falcon512padded.sign(m, sk, signOpts(rng));
  return Uint8Array.from([...sig, ...m]);
}
/** NIST / PQClean falcon-512 crypto_sign: len ‖ nonce ‖ m ‖ 0x29 ‖ s2 (noble's attached form). */
function smCompressed(sk: Uint8Array, m: Uint8Array, rng: Rng): Uint8Array {
  return falcon512.attached.seal(m, sk, signOpts(rng));
}

const variants = {
  "falcon-padded-512": { f: falcon512padded as unknown as Falcon, sm: smPadded },
  "falcon-512": { f: falcon512, sm: smCompressed },
} as const;

/** The NIST round-3 falcon512 KAT file, regenerated (PQCgenKAT_sign.c's two passes). */
function nistRound3Rsp(): { text: string; entries: Map<number, Record<string, string>> } {
  const outer = new NistDrbg(Uint8Array.from({ length: 48 }, (_, i) => i));
  const reqs: { seed: Uint8Array; msg: Uint8Array }[] = [];
  for (let i = 0; i < 100; i++) {
    const seed = outer.randombytes(48);
    reqs.push({ seed, msg: outer.randombytes(33 * (i + 1)) });
  }
  let text = "# Falcon-512\n\n";
  const entries = new Map<number, Record<string, string>>();
  reqs.forEach(({ seed, msg }, count) => {
    const drbg = new NistDrbg(seed);
    const rng: Rng = (n) => drbg.randombytes(n);
    const kp = keygen(falcon512, rng);
    const sm = smCompressed(kp.secretKey, msg, rng);
    const e = { seed: hexU(seed), mlen: String(msg.length), msg: hexU(msg), pk: hexU(kp.publicKey), sk: hexU(kp.secretKey), smlen: String(sm.length), sm: hexU(sm) };
    entries.set(count, e);
    text += `count = ${count}\nseed = ${e.seed}\nmlen = ${e.mlen}\nmsg = ${e.msg}\npk = ${e.pk}\nsk = ${e.sk}\nsmlen = ${e.smlen}\nsm = ${e.sm}\n\n`;
    expect(falcon512.attached.open(sm, kp.publicKey)).toEqual(msg);
  });
  return { text, entries };
}

/** PQClean test/crypto_sign/testvectors.c output for one variant. */
function pqcleanTestvectors(name: keyof typeof variants): { text: string; sigs: number } {
  const { f, sm } = variants[name];
  const rng = notRandomBytes();
  let text = "";
  let sigs = 0;
  for (let i = 0; i < 2048; i = i === 0 ? 1 : i << 2) {
    const m = rng(i);
    const kp = keygen(f, rng);
    text += `${hexL(kp.publicKey)}\n${hexL(kp.secretKey)}\n`;
    const attached = sm(kp.secretKey, m, rng);
    const detached = f.sign(m, kp.secretKey, signOpts(rng));
    text += `${hexL(attached)}\n${hexL(detached)}\n`;
    expect(f.verify(detached, m, kp.publicKey)).toBe(true);
    sigs += 2;
  }
  return { text, sigs };
}

/** PQClean test/crypto_sign/nistkat.c output (one entry) for one variant. */
function pqcleanNistkat(name: keyof typeof variants): string {
  const { f, sm } = variants[name];
  const outer = new NistDrbg(Uint8Array.from({ length: 48 }, (_, i) => i));
  const seed = outer.randombytes(48);
  const m = outer.randombytes(33);
  const drbg = new NistDrbg(seed);
  const rng: Rng = (n) => drbg.randombytes(n);
  const kp = keygen(f, rng);
  const s = sm(kp.secretKey, m, rng);
  return `count = 0\nseed = ${hexU(seed)}\nmlen = 33\nmsg = ${hexU(m)}\npk = ${hexU(kp.publicKey)}\nsk = ${hexU(kp.secretKey)}\nsmlen = ${s.length}\nsm = ${hexU(s)}\n`;
}

describe("Falcon known answers (noble 0.7.1 vs NIST round 3 and PQClean)", () => {
  it("NIST round-3 falcon512-KAT.rsp: all 100 entries", () => {
    const { text, entries } = nistRound3Rsp();
    const file = process.env.FALCON_KAT_RSP;
    if (file) {
      // The downloaded file is untrusted data: only parsed as `key = HEX` lines.
      const got = new Map<number, Record<string, string>>();
      let cur: Record<string, string> | undefined;
      for (const line of readFileSync(file, "latin1").split("\n")) {
        const m = /^(count|seed|mlen|msg|pk|sk|smlen|sm) = ([0-9A-F]*)$/.exec(line);
        if (!m) continue;
        if (m[1] === "count") got.set(Number(m[2]), (cur = {}));
        else if (cur) cur[m[1]!] = m[2]!;
      }
      let pass = 0;
      const failed: number[] = [];
      for (const [count, e] of entries) (JSON.stringify(got.get(count)) === JSON.stringify(e) ? pass++ : failed.push(count));
      console.log(`NIST round-3 falcon512 KAT: ${pass}/${entries.size} entries byte-identical (keygen pk/sk and sm)${failed.length ? `; failed counts ${failed.join(",")}` : ""}`);
      expect(failed).toEqual([]);
    }
    expect(sha256(text)).toBe(NIST_ROUND3_FALCON512_RSP_SHA256);
  }, 600_000);

  for (const name of Object.keys(variants) as (keyof typeof variants)[]) {
    it(`PQClean ${name} testvectors (7 key pairs, 14 signatures)`, () => {
      const { text, sigs } = pqcleanTestvectors(name);
      expect(sigs).toBe(14);
      expect(sha256(text)).toBe(PQCLEAN[name].testvectors);
    }, 600_000);
    it(`PQClean ${name} nistkat (1 key pair, 1 signature)`, () => {
      expect(sha256(pqcleanNistkat(name))).toBe(PQCLEAN[name].nistkat);
    }, 600_000);
  }
});
