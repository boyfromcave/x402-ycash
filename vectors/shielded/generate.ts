// Generates vectors/shielded/shielded.json: the `sapling-proof` request hash and memo, JCS edge cases,
// and ES256K offer-and-receipt JWS artifacts (did:jwk kid) for fixed keys and times (plan X-2, X4a;
// specs/scheme_exact_ycash.md, "sapling-proof", "Receipts").
//
//   npx tsx vectors/shielded/generate.ts
//
// Offline and deterministic: RFC 6979 signatures, low-S, so every implementation reproduces the JWS
// byte for byte (the Python SDK does, python/tests/unit/test_shielded_vectors.py).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createJws, didJwkFor, es256kSigner, jcs, memoForRecord, memoToHex, requestHash, signOffer, signReceipt, type RequestRecord } from "../../packages/ycash/src/shielded/index.js";

const receiptPriv = hexToBytes("44".repeat(32));
const signer = es256kSigner(receiptPriv);
const record: RequestRecord = {
  v: 1,
  network: "ycash:regtest",
  asset: "YEC",
  amount: "1500000",
  payTo: "yregtestsapling1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
  resource: "https://merchant.example/x402/report?q=café",
  expiresAt: 1_791_000_000,
  nonce: "ab".repeat(32),
};
const jcsCases = [
  { value: { b: 1, a: [true, false, null], "é": "x", "😀": 2, "€": 3 } },
  { value: { s: "quote\" back\\ ctl\u0001\u001f tab\t nl\n cr\r ff\f bs\b del\u007f   é 😀" } },
  { value: [0, -1, 9007199254740991, "", {}] },
].map((c) => ({ ...c, jcs: jcs(c.value) }));

const txid = "5be1".padEnd(64, "0");
const receipt = await signReceipt({ network: record.network, resourceUrl: record.resource, transaction: txid, issuedAt: 1_791_000_123 }, signer);
const offer = await signOffer(
  { resourceUrl: record.resource, scheme: "exact", network: record.network, asset: "YEC", payTo: record.payTo, amount: record.amount, validUntil: record.expiresAt },
  signer,
);
// A high-S variant of the receipt's signature: valid ECDSA, which both verifiers accept (noble with lowS: false).
const [h, p, s] = receipt.signature.split(".") as [string, string, string];
const sig = Buffer.from(s, "base64url");
const n = secp.Point.CURVE().n;
const highS = (n - BigInt("0x" + sig.subarray(32).toString("hex"))).toString(16).padStart(64, "0");
const highSJws = `${h}.${p}.${Buffer.concat([sig.subarray(0, 32), Buffer.from(highS, "hex")]).toString("base64url")}`;

const doc = {
  description:
    "sapling-proof (plan X4a): the request record's JCS and SHA-256 request hash, the memo and its z_sendmany hex; JCS edge cases (UTF-16 member order, escapes); ES256K offer-and-receipt JWS (did:jwk kid, JCS payloads, r||s low-S, RFC 6979) for a fixed key. Offline, deterministic.",
  request: { record, jcs: jcs(record), requestHash: requestHash(record), memo: memoForRecord(record), memoHex: memoToHex(memoForRecord(record)) },
  jcs: jcsCases,
  receiptKey: { priv: bytesToHex(receiptPriv), pubCompressed: bytesToHex(secp.getPublicKey(receiptPriv, true)), kid: didJwkFor(secp.getPublicKey(receiptPriv, true)) },
  receipt: { input: { network: record.network, resourceUrl: record.resource, transaction: txid, issuedAt: 1_791_000_123 }, artifact: receipt },
  offer: { artifact: offer },
  jws: { payload: { b: "β", a: 1 }, compact: await createJws({ b: "β", a: 1 }, signer) },
  highS: { compact: highSJws, valid: true },
};
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "shielded.json"), JSON.stringify(doc, null, 2) + "\n");
