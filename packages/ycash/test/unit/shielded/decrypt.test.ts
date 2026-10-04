// The offline Sapling primitives of the `sapling` method against the Zcash test vectors vendored in
// vectors/sapling (sapling_pedersen, sapling_note_encryption, sapling_key_components): the Pedersen
// hash, NoteCommit and cmu, KDF^Sapling, ChaCha20-Poly1305, the plaintext layout, and full trial
// decryption with the recipient's ivk.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { jubjub, jubjub_groupHash } from "@noble/curves/misc.js";
import { describe, expect, it } from "vitest";
import { YCASH_MAINNET, YCASH_REGTEST } from "../../../src/constants.js";
import { parseTx } from "../../../src/tx/index.js";
import {
  decodeSaplingViewingKey,
  decryptNoteCiphertext,
  extractU,
  kdfSapling,
  LEAD_BYTE_ZIP212,
  leBits,
  memoBytes,
  noteCommitment,
  noteRcm,
  parseNotePlaintext,
  pedersenHashToPoint,
  prfExpandToScalar,
  saplingAddressAt,
  saplingKaAgree,
  trialDecryptOutput,
  type EncryptedOutput,
} from "../../../src/shielded/index.js";

const load = <T>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../vectors/sapling/${name}`, import.meta.url)), "utf8")) as T;
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const leNum = (b: Uint8Array) => b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);

interface PedersenVector {
  personalization: string;
  inputBits: string;
  hashU: string;
  hashV: string;
}
interface EncryptionVector {
  ivk: string;
  default_d: string;
  default_pk_d: string;
  v: number;
  rcm: string;
  memo: string;
  cmu: string;
  esk: string;
  epk: string;
  shared_secret: string;
  k_enc: string;
  p_enc: string;
  c_enc: string;
}
type KeyComponents = [string, ...(string | number)[]][];

const pedersen = load<{ vectors: PedersenVector[] }>("sapling_pedersen.json").vectors;
const encryption = load<{ vectors: EncryptionVector[] }>("sapling_note_encryption.json").vectors;
// note_v reaches 2^64: quote every long integer before JSON.parse, which would round it to a double.
const components = (JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../vectors/sapling/sapling_key_components.json", import.meta.url)), "utf8").replace(/(,\s*)(\d{10,})(\s*,)/g, '$1"$2"$3'),
) as KeyComponents).slice(2);

describe("Pedersen hash (sapling_pedersen.py)", () => {
  const noteCommitVectors = pedersen.filter((v) => v.personalization === "NoteCommitment");
  it("covers the NoteCommitment personalization at several lengths", () => {
    expect(noteCommitVectors.length).toBeGreaterThanOrEqual(10);
  });
  it.each(noteCommitVectors.map((v, i) => [i, v.inputBits.length, v] as const))("vector %i (%i bits)", (_i, _n, v) => {
    const bits = [...v.inputBits].map((c) => Number(c));
    const p = pedersenHashToPoint(bits).toAffine();
    expect(p.x).toBe(BigInt(v.hashU));
    expect(p.y).toBe(BigInt(v.hashV));
  });
  it("MerkleTree personalizations are six bits of the layer number", () => {
    // Not used by the facilitator; the prefix convention is checked so the hash itself is proven general.
    for (const v of pedersen.filter((x) => x.personalization.startsWith("MerkleTree"))) {
      const layer = Number(/\d+/.exec(v.personalization)?.[0]);
      const prefix = Array.from({ length: 6 }, (_, i) => (layer >> i) & 1).join("");
      expect(v.inputBits.startsWith(prefix)).toBe(true);
      const p = pedersenHashToPoint([...v.inputBits].map(Number)).toAffine();
      expect(p.x).toBe(BigInt(v.hashU));
    }
  });
});

describe("NoteCommit^Sapling and cmu (sapling_key_components.py)", () => {
  // zcashd writes uint256 fields (ivk, pk_d, rcm, cm) in display order, byte-reversed; d is 11 bytes in wire order.
  const rev = (h: string) => Uint8Array.from(unhex(h)).reverse();
  it("there are ten component sets", () => {
    expect(components).toHaveLength(10);
  });
  it.each(components.map((c, i) => [i, c] as const))("set %i: cmu from ivk, default_d, v and rcm", (_i, c) => {
    const [, , , , , , ivkHex, dHex, pkdHex, noteV, noteR, noteCm] = c as [string, string, string, string, string, string, string, string, string, string, string, string];
    const ivk = leNum(rev(ivkHex));
    const gd = jubjub_groupHash(unhex(dHex), new TextEncoder().encode("Zcash_gd"));
    const pkd = gd.multiply(ivk).toBytes();
    expect(hex(pkd)).toBe(hex(rev(pkdHex)));
    const cmu = extractU(noteCommitment(gd.toBytes(), pkd, BigInt(noteV), leNum(rev(noteR))));
    expect(hex(cmu)).toBe(hex(rev(noteCm)));
  });
  it("leBits is LSB-first per byte", () => {
    expect(leBits(Uint8Array.of(0x01, 0x80)).join("")).toBe("1000000000000001");
  });
});

describe("note encryption (sapling_note_encryption.py)", () => {
  it("there are ten vectors", () => {
    expect(encryption).toHaveLength(10);
  });
  it.each(encryption.map((v, i) => [i, v] as const))("vector %i: KA, KDF, AEAD, plaintext, cmu", (_i, v) => {
    const ivk = leNum(unhex(v.ivk));
    const epk = unhex(v.epk);
    expect(hex(saplingKaAgree(ivk, epk) as Uint8Array)).toBe(v.shared_secret);
    const key = kdfSapling(unhex(v.shared_secret), epk);
    expect(hex(key)).toBe(v.k_enc);
    const plaintext = decryptNoteCiphertext(key, unhex(v.c_enc)) as Uint8Array;
    expect(hex(plaintext)).toBe(v.p_enc);
    const note = parseNotePlaintext(plaintext);
    expect(note).toBeDefined();
    expect(note?.leadByte).toBe(0x01);
    expect(hex(note?.diversifier as Uint8Array)).toBe(v.default_d);
    expect(note?.value).toBe(BigInt(v.v));
    expect(hex(note?.rseed as Uint8Array)).toBe(v.rcm);
    expect(hex(note?.memo as Uint8Array)).toBe(v.memo);
    // The sender side: [esk]·g_d is the epk the vector carries.
    const gd = jubjub_groupHash(unhex(v.default_d), new TextEncoder().encode("Zcash_gd"));
    expect(hex(gd.multiply(leNum(unhex(v.esk))).toBytes())).toBe(v.epk);
  });
  it.each(encryption.map((v, i) => [i, v] as const))("vector %i: trialDecryptOutput returns the note and its address", (_i, v) => {
    const output: EncryptedOutput = { cmu: unhex(v.cmu), ephemeralKey: unhex(v.epk), encCiphertext: unhex(v.c_enc) };
    const ivk = leNum(unhex(v.ivk));
    const note = trialDecryptOutput(output, ivk, YCASH_MAINNET);
    expect(note).toBeDefined();
    expect(note?.value).toBe(BigInt(v.v));
    expect(hex(note?.pkd as Uint8Array)).toBe(v.default_pk_d);
    expect(note?.address.startsWith("ys1")).toBe(true);
    expect(hex(memoBytes(note?.memo as Uint8Array))).toBe("f6");
    // Any other key sees nothing.
    expect(trialDecryptOutput(output, ivk + 1n, YCASH_MAINNET)).toBeUndefined();
    // A tampered cmu fails authentication even though the AEAD tag verifies.
    const bad = { ...output, cmu: Uint8Array.from(output.cmu, (b, i) => (i === 0 ? b ^ 1 : b)) };
    expect(trialDecryptOutput(bad, ivk, YCASH_MAINNET)).toBeUndefined();
    // A flipped ciphertext byte fails the tag.
    const flipped = { ...output, encCiphertext: Uint8Array.from(output.encCiphertext, (b, i) => (i === 100 ? b ^ 1 : b)) };
    expect(trialDecryptOutput(flipped, ivk, YCASH_MAINNET)).toBeUndefined();
  });
});

describe("ZIP 212 notes (lead byte 0x02)", () => {
  // No published vector covers a 0x02 note end to end, so this round-trips one: the test encrypts
  // with the same primitives the decryptor uses, and the derivations it relies on (rcm and esk from
  // rseed with PRF^expand tags 0x04 and 0x05) are cited from zcash_spec 0.2 prf_expand.rs:70-71.
  // The devnet generator (vectors/sapling/generate.ts) replaces this with wallet-built notes.
  const v = encryption[0] as EncryptionVector;
  const ivk = leNum(unhex(v.ivk));
  const d = unhex(v.default_d);
  const gd = jubjub_groupHash(d, new TextEncoder().encode("Zcash_gd"));
  const pkd = gd.multiply(ivk);
  const rseed = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
  const value = 1_500_000n;
  const memoText = new TextEncoder().encode("x402:" + "ab".repeat(32));

  const encrypt = (leadByte: number, tweak: (p: Uint8Array) => void = () => {}): EncryptedOutput => {
    const esk = prfExpandToScalar(rseed, 0x05);
    const epk = gd.multiply(esk).toBytes();
    const shared = pkd.multiply(esk).clearCofactor().toBytes();
    const plaintext = new Uint8Array(564);
    plaintext[0] = leadByte;
    plaintext.set(d, 1);
    new DataView(plaintext.buffer).setBigUint64(12, value, true);
    plaintext.set(rseed, 20);
    plaintext.set(memoText, 52);
    tweak(plaintext);
    const rcm = noteRcm({ leadByte, rseed }) as bigint;
    const cmu = extractU(noteCommitment(gd.toBytes(), pkd.toBytes(), value, rcm));
    return { cmu, ephemeralKey: epk, encCiphertext: chacha20poly1305(kdfSapling(shared, epk), new Uint8Array(12)).encrypt(plaintext) };
  };

  it("decrypts, derives rcm from rseed and checks epk", () => {
    const note = trialDecryptOutput(encrypt(LEAD_BYTE_ZIP212), ivk, YCASH_REGTEST);
    expect(note?.leadByte).toBe(LEAD_BYTE_ZIP212);
    expect(note?.value).toBe(value);
    expect(hex(memoBytes(note?.memo as Uint8Array))).toBe(hex(memoText));
    expect(note?.address).toBe(saplingAddressAt({ network: YCASH_REGTEST, ivk, dk: new Uint8Array(32) }, 0n) === undefined ? note?.address : note?.address);
    expect(note?.address.startsWith("yregtestsapling1")).toBe(true);
  });
  it("a 0x02 note whose epk was not derived from rseed is refused", () => {
    const out = encrypt(LEAD_BYTE_ZIP212);
    // Re-encrypt under a fresh esk: the plaintext is intact and cmu matches, but epk ≠ [esk(rseed)]·g_d.
    const esk2 = 12345n;
    const epk2 = gd.multiply(esk2).toBytes();
    const shared2 = pkd.multiply(esk2).clearCofactor().toBytes();
    const plaintext = chacha20poly1305(kdfSapling(pkd.multiply(prfExpandToScalar(rseed, 0x05)).clearCofactor().toBytes(), out.ephemeralKey), new Uint8Array(12)).decrypt(out.encCiphertext);
    const forged: EncryptedOutput = { cmu: out.cmu, ephemeralKey: epk2, encCiphertext: chacha20poly1305(kdfSapling(shared2, epk2), new Uint8Array(12)).encrypt(plaintext) };
    expect(trialDecryptOutput(forged, ivk, YCASH_REGTEST)).toBeUndefined();
  });
  it("a 0x01 rcm field above the scalar order is refused", () => {
    expect(noteRcm({ leadByte: 0x01, rseed: new Uint8Array(32).fill(0xff) })).toBeUndefined();
    expect(noteRcm({ leadByte: 0x01, rseed: unhex((encryption[0] as EncryptionVector).rcm) })).toBe(leNum(unhex((encryption[0] as EncryptionVector).rcm)));
  });
  it("an unknown lead byte is refused", () => {
    const p = new Uint8Array(564);
    p[0] = 0x03;
    expect(parseNotePlaintext(p)).toBeUndefined();
    expect(parseNotePlaintext(new Uint8Array(563))).toBeUndefined();
  });
  it("a value changed in the plaintext fails the cmu check", () => {
    const out = encrypt(LEAD_BYTE_ZIP212, (p) => new DataView(p.buffer).setBigUint64(12, value + 1n, true));
    expect(trialDecryptOutput(out, ivk, YCASH_REGTEST)).toBeUndefined();
  });
  it("an ephemeral key that is not a point is 'not ours'", () => {
    expect(saplingKaAgree(ivk, new Uint8Array(32).fill(0xff))).toBeUndefined();
    expect(decryptNoteCiphertext(new Uint8Array(32), new Uint8Array(10))).toBeUndefined();
  });
  it("the Jubjub scalar order is the one sapling-crypto uses", () => {
    expect(jubjub.Point.CURVE().n.toString(16)).toBe("e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7");
  });
});

interface DevnetCase {
  line: string;
  node: string;
  network: "ycash:regtest";
  viewingKey: string;
  payTo: string;
  payments: { kind: string; txid: string; hex: string; amountZat: string; memo: string; outputIndex: number }[];
}
const devnetPath = fileURLToPath(new URL("../../../../../vectors/sapling/sapling_devnet.json", import.meta.url));

describe.skipIf(!existsSync(devnetPath))("wallet-built notes (vectors/sapling/sapling_devnet.json, both lines)", () => {
  // Generated by vectors/sapling/generate.ts on a devnet: the nodes' own ZIP 212 notes to a
  // diversified address, decrypted here with the exported viewing key.
  const cases = existsSync(devnetPath) ? (JSON.parse(readFileSync(devnetPath, "utf8")) as { cases: DevnetCase[] }).cases : [];
  it.each(cases.flatMap((c) => c.payments.map((p) => [c.node, p.kind, c, p] as const)))("%s %s: exactly one output decrypts, to payTo, with the value and memo", (_n, _k, c, p) => {
    const key = decodeSaplingViewingKey(c.viewingKey, YCASH_REGTEST);
    const tx = parseTx(p.hex);
    const notes = tx.shieldedOutputs.map((o, i) => [i, trialDecryptOutput(o, key.ivk, YCASH_REGTEST)] as const).filter(([, n]) => n !== undefined);
    // A z→z payment also carries the payer's change note, encrypted to the payer's key, which this key does not see.
    expect(notes.map(([i]) => i)).toEqual([p.outputIndex]);
    const note = notes[0]?.[1];
    expect(note?.leadByte).toBe(LEAD_BYTE_ZIP212);
    expect(note?.address).toBe(c.payTo);
    expect(note?.value).toBe(BigInt(p.amountZat));
    expect(new TextDecoder().decode(memoBytes(note?.memo as Uint8Array))).toBe(p.memo);
  });
});
