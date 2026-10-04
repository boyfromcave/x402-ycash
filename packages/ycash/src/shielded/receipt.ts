// `offer-and-receipt` artifacts in JWS format (upstream specs/extensions/extension-offer-and-receipt.md
// §3.3, §4, §5), signed ES256K: ECDSA over secp256k1 with SHA-256, the JWS signature being r ‖ s
// (RFC 8812 §3.2). The payload is JCS (§10). The key id is a did:jwk, so a verifier can resolve the
// public key from the receipt alone; whether that key may sign for the merchant is a separate check
// (§4.5.1), which `verifyReceipt` makes against the trusted keys its caller passes.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as secp from "@noble/secp256k1";
import { ANONYMOUS_PAYER, OFFER_RECEIPT } from "./constants.js";
import { jcs } from "./jcs.js";

secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);

/** The upstream extension's JWS signer shape (`typescript/packages/extensions/src/offer-receipt/types.ts`). */
export interface JwsSigner {
  readonly format: "jws";
  readonly algorithm: string;
  /** a DID URL */
  readonly kid: string;
  /** Signs the JWS signing input; returns the base64url signature. */
  sign(signingInput: Uint8Array): Promise<string>;
}

export interface ReceiptPayload {
  version: 1;
  network: string;
  resourceUrl: string;
  payer: string;
  issuedAt: number;
  transaction?: string;
}

export interface OfferPayload {
  version: 1;
  resourceUrl: string;
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  validUntil?: number;
}

export interface JwsSignedArtifact {
  format: "jws";
  signature: string;
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const unb64u = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("JWS: not base64url");
  return new Uint8Array(Buffer.from(s, "base64url"));
};
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** `did:jwk:` of a secp256k1 public key (compressed or uncompressed). */
export function didJwkFor(publicKey: Uint8Array): string {
  const p = secp.Point.fromBytes(publicKey).toBytes(false);
  const jwk = { crv: "secp256k1", kty: "EC", x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) };
  return `did:jwk:${b64u(utf8(jcs(jwk)))}`;
}

/** The compressed public key a `did:jwk:` secp256k1 kid names (an optional `#0` fragment is ignored). */
export function publicKeyFromDidJwk(kid: string): Uint8Array {
  const m = /^did:jwk:([A-Za-z0-9_-]+)(#.*)?$/.exec(kid);
  if (!m) throw new Error(`not a did:jwk key id: ${kid}`);
  const jwk = JSON.parse(new TextDecoder().decode(unb64u(m[1]!))) as { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown };
  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("did:jwk is not a secp256k1 EC key");
  }
  const x = unb64u(jwk.x);
  const y = unb64u(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error("did:jwk coordinates are not 32 bytes");
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 33);
  return secp.Point.fromBytes(raw).toBytes(true); // throws if the point is not on the curve
}

/** An ES256K signer from a 32-byte secp256k1 private key; its kid defaults to the key's did:jwk. */
export function es256kSigner(privateKey: Uint8Array, kid?: string): JwsSigner {
  const publicKey = secp.getPublicKey(privateKey, true);
  return {
    format: "jws",
    algorithm: "ES256K",
    kid: kid ?? didJwkFor(publicKey),
    async sign(signingInput) {
      return b64u(secp.sign(sha256(signingInput), privateKey, { prehash: false, lowS: true }));
    },
  };
}

/** JWS Compact Serialization of a JCS payload. */
export async function createJws(payload: object, signer: JwsSigner): Promise<string> {
  const header = b64u(utf8(jcs({ alg: signer.algorithm, kid: signer.kid })));
  const body = b64u(utf8(jcs(payload)));
  return `${header}.${body}.${await signer.sign(utf8(`${header}.${body}`))}`;
}

export interface VerifyJwsOptions {
  /**
   * The keys authorised to sign for the merchant (§4.5.1), compressed or uncompressed, bytes or
   * hex. A valid signature by any other key is refused.
   */
  trustedPublicKeys: ReadonlyArray<Uint8Array | string>;
}

/** Verifies an ES256K JWS whose kid is a did:jwk; returns its header and payload. */
export function verifyJws<T>(jws: string, opts: VerifyJwsOptions): { header: { alg: string; kid: string }; payload: T } {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("JWS: not compact serialization");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(unb64u(h))) as { alg?: unknown; kid?: unknown };
  if (header.alg !== "ES256K") throw new Error(`JWS: unsupported alg ${String(header.alg)}`);
  if (typeof header.kid !== "string") throw new Error("JWS: header has no kid");
  const publicKey = publicKeyFromDidJwk(header.kid);
  const sig = unb64u(s);
  if (sig.length !== 64) throw new Error("JWS: ES256K signature is not 64 bytes");
  if (!secp.verify(sig, sha256(utf8(`${h}.${p}`)), publicKey, { prehash: false, lowS: false })) {
    throw new Error("JWS: bad signature");
  }
  const trusted = opts.trustedPublicKeys.map((k) => bytesToHex(secp.Point.fromBytes(typeof k === "string" ? hexToBytes(k) : k).toBytes(true)));
  if (!trusted.includes(bytesToHex(publicKey))) throw new Error("JWS: signing key is not authorised for this merchant");
  return { header: { alg: header.alg, kid: header.kid }, payload: JSON.parse(new TextDecoder().decode(unb64u(p))) as T };
}

/** The receipt of a settled `sapling-proof` payment (spec, "Receipts"). */
export async function signReceipt(
  input: { network: string; resourceUrl: string; transaction: string; issuedAt?: number; payer?: string },
  signer: JwsSigner,
): Promise<JwsSignedArtifact> {
  const payload: ReceiptPayload = {
    version: 1,
    network: input.network,
    resourceUrl: input.resourceUrl,
    payer: input.payer ?? ANONYMOUS_PAYER,
    issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
    transaction: input.transaction,
  };
  return { format: "jws", signature: await createJws(payload, signer) };
}

export interface VerifyReceiptOptions extends VerifyJwsOptions {
  /** Refuse a receipt older than this many seconds (§5.5 step 7); unchecked when omitted. */
  maxAgeSeconds?: number;
  /** Unix seconds; defaults to now. */
  now?: number;
}

/** Verifies a JWS receipt (§5.5): signature, signer authorisation, version, and optionally its age. */
export function verifyReceipt(receipt: JwsSignedArtifact, opts: VerifyReceiptOptions): ReceiptPayload {
  if (receipt.format !== "jws") throw new Error(`receipt format ${String(receipt.format)} is not jws`);
  const { payload } = verifyJws<ReceiptPayload>(receipt.signature, opts);
  if (payload.version !== 1) throw new Error(`receipt version ${String(payload.version)} is not 1`);
  for (const f of ["network", "resourceUrl", "payer"] as const) {
    if (typeof payload[f] !== "string") throw new Error(`receipt ${f} is missing`);
  }
  if (!Number.isSafeInteger(payload.issuedAt)) throw new Error("receipt issuedAt is missing");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (opts.maxAgeSeconds !== undefined && now - payload.issuedAt > opts.maxAgeSeconds) throw new Error("receipt is too old");
  return payload;
}

/** A signed offer for one `accepts[]` entry (§4), so a verifier can learn the amount a receipt paid. */
export async function signOffer(payload: Omit<OfferPayload, "version">, signer: JwsSigner): Promise<JwsSignedArtifact> {
  return { format: "jws", signature: await createJws({ version: 1, ...payload }, signer) };
}

/** `extensions["offer-receipt"]` of a settle response carrying `receipt`. */
export function receiptExtension(receipt: JwsSignedArtifact): Record<string, unknown> {
  return { [OFFER_RECEIPT]: { info: { receipt } } };
}
