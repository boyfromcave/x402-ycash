// Transparent and YED addresses: base58check of version bytes ‖ payload.
// Transparent prefixes (identical on both lines):
//   mainnet P2PKH 1C 28 "s1…", P2SH 1C 2C "s2…"/"s3…" (ycash-dd/src/chainparams.cpp:149-151, ycash6 :161-163)
//   testnet and regtest share P2PKH 1C 95 "sm…", P2SH 1C 2A "s2…" (ycash-dd :409-411,613-614; ycash6 :456-458,689-690)
// YED P2PKH addresses (ycash-dd/src/yellowback/params.cpp, address.cpp): a 20-byte key hash under
//   mainnet 1F DD "yb…" (D-Q-21; was 1F E4 "ye…" before the quantum line), testnet 20 07 "yt…", regtest 20 02
//   "yr…"; 35 characters.
// Post-quantum addresses (decision D-9, quantum spec §4.1, rpcversion 9): base58check(version(3) ‖ keyHash(32)),
//   53 characters, one 3-byte version per network, form and scheme, so the prefix names the scheme
//   (f FN-DSA-512 = scheme 2, s SLH-DSA-SHA2-128s = scheme 1); the node's key_io PlainPQAddressVersions and
//   Yellowback pqAddressVersions (ycash-dd / ycash6 up/b2-pq-prefix):
//   yedpq (a TX_PQPKH YED holder or vault owner): mainnet 56 AE DE "ybf…" / 56 B0 44 "ybs…", testnet
//     57 21 C9 "ytf…" / 57 23 30 "yts…", regtest 57 14 44 "yrf…" / 57 15 AA "yrs…".
//   pq (plain YEC, the same TX_PQPKH script, D-Q-20): mainnet 4D DD 04 "sqf…" / 4D DE 6A "sqs…", testnet
//     4F 65 19 "tqf…" / 4F 66 7F "tqs…", regtest 4C 54 EF "rqf…" / 4C 56 55 "rqs…".
//   The pre-D-9 form (2-byte version ‖ scheme ‖ keyHash, 56 AB / 4D D9 …) is neither produced nor accepted.
import { YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET, type YcashNetwork } from "../constants.js";
import { isKnownScheme, type PQKeyId, type PQScheme } from "../pq/scheme.js";
import { pqpkhScript } from "../pq/script.js";
import { base58CheckDecode, base58CheckEncode } from "./base58.js";
import { concatBytes } from "./bytes.js";
import { p2pkhScript, p2shScript } from "./script.js";

/**
 * `p2pkh`/`p2sh`: transparent YEC. `yed`: a YED holder key hash (P2PKH). `yedpq`: a YED post-quantum
 * key (TX_PQPKH holder, or a vault owner). `pq`: a plain-YEC post-quantum key (TX_PQPKH).
 */
export type AddressKind = "p2pkh" | "p2sh" | "yed" | "yedpq" | "pq";

const KINDS: readonly AddressKind[] = ["p2pkh", "p2sh", "yed", "yedpq", "pq"];

export interface DecodedAddress {
  network: YcashNetwork;
  kind: AddressKind;
  /** The 20-byte key hash (p2pkh, yed) or script hash (p2sh), or the 32-byte key hash (yedpq, pq). */
  hash: Uint8Array;
  /** The post-quantum scheme (yedpq, pq only). */
  scheme?: PQScheme;
}

/** The two-byte versions of the 20-byte (transparent and YED P2PKH) forms. */
const VERSIONS: Record<YcashNetwork, Record<"p2pkh" | "p2sh" | "yed", readonly [number, number]>> = {
  [YCASH_MAINNET]: { p2pkh: [0x1c, 0x28], p2sh: [0x1c, 0x2c], yed: [0x1f, 0xdd] },
  [YCASH_TESTNET]: { p2pkh: [0x1c, 0x95], p2sh: [0x1c, 0x2a], yed: [0x20, 0x07] },
  [YCASH_REGTEST]: { p2pkh: [0x1c, 0x95], p2sh: [0x1c, 0x2a], yed: [0x20, 0x02] },
};

/** The post-quantum versions (D-9): one table, read by both {@link encodeAddress} and {@link decodeAddress}. */
export const PQ_VERSIONS: readonly { network: YcashNetwork; kind: "yedpq" | "pq"; scheme: PQScheme; version: readonly [number, number, number] }[] = [
  { network: YCASH_MAINNET, kind: "pq", scheme: 2, version: [0x4d, 0xdd, 0x04] }, // sqf…
  { network: YCASH_MAINNET, kind: "pq", scheme: 1, version: [0x4d, 0xde, 0x6a] }, // sqs…
  { network: YCASH_TESTNET, kind: "pq", scheme: 2, version: [0x4f, 0x65, 0x19] }, // tqf…
  { network: YCASH_TESTNET, kind: "pq", scheme: 1, version: [0x4f, 0x66, 0x7f] }, // tqs…
  { network: YCASH_REGTEST, kind: "pq", scheme: 2, version: [0x4c, 0x54, 0xef] }, // rqf…
  { network: YCASH_REGTEST, kind: "pq", scheme: 1, version: [0x4c, 0x56, 0x55] }, // rqs…
  { network: YCASH_MAINNET, kind: "yedpq", scheme: 2, version: [0x56, 0xae, 0xde] }, // ybf…
  { network: YCASH_MAINNET, kind: "yedpq", scheme: 1, version: [0x56, 0xb0, 0x44] }, // ybs…
  { network: YCASH_TESTNET, kind: "yedpq", scheme: 2, version: [0x57, 0x21, 0xc9] }, // ytf…
  { network: YCASH_TESTNET, kind: "yedpq", scheme: 1, version: [0x57, 0x23, 0x30] }, // yts…
  { network: YCASH_REGTEST, kind: "yedpq", scheme: 2, version: [0x57, 0x14, 0x44] }, // yrf…
  { network: YCASH_REGTEST, kind: "yedpq", scheme: 1, version: [0x57, 0x15, 0xaa] }, // yrs…
];

/**
 * The 3-byte version of a post-quantum address.
 *
 * @param network - The network.
 * @param kind - `yedpq` or `pq`.
 * @param scheme - The post-quantum scheme.
 * @returns The version.
 * @throws Error for a scheme outside the registry.
 */
export function pqVersion(network: YcashNetwork, kind: "yedpq" | "pq", scheme: number): readonly [number, number, number] {
  const row = PQ_VERSIONS.find((r) => r.network === network && r.kind === kind && r.scheme === scheme);
  if (!row) throw new Error(`unknown post-quantum scheme ${scheme}`);
  return row.version;
}

/**
 * Whether the kind is a post-quantum form (a 33-byte scheme ‖ key-hash payload).
 *
 * @param kind - An address kind.
 * @returns True for `yedpq` and `pq`.
 */
export function isPQKind(kind: AddressKind): kind is "yedpq" | "pq" {
  return kind === "yedpq" || kind === "pq";
}

/**
 * Whether the kind holds YED (a Yellowback address, either form).
 *
 * @param kind - An address kind.
 * @returns True for `yed` and `yedpq`.
 */
export function isYedKind(kind: AddressKind): kind is "yed" | "yedpq" {
  return kind === "yed" || kind === "yedpq";
}

/**
 * Base58check-encodes a payload under the version bytes of the given network and kind: a 20-byte
 * hash for p2pkh/p2sh/yed; for yedpq/pq the 33 bytes scheme ‖ key hash, encoded as the scheme's
 * 3-byte version ‖ key hash (D-9).
 *
 * @param network - The Ycash network whose prefixes to use.
 * @param kind - The address kind.
 * @param payload - The 20-byte hash, or the 33-byte scheme ‖ key hash.
 * @returns The encoded address.
 * @throws Error when the payload has the wrong length for the kind, or names an unknown scheme.
 */
export function encodeAddress(network: YcashNetwork, kind: AddressKind, payload: Uint8Array): string {
  if (isPQKind(kind)) {
    if (payload.length !== 33) throw new Error("a post-quantum address payload is scheme ‖ 32-byte key hash");
    if (!isKnownScheme(payload[0] as number)) throw new Error(`unknown post-quantum scheme ${payload[0]}`);
    return base58CheckEncode(concatBytes(Uint8Array.from(pqVersion(network, kind, payload[0] as number)), payload.slice(1)));
  }
  if (payload.length !== 20) throw new Error("address hash must be 20 bytes");
  return base58CheckEncode(concatBytes(Uint8Array.from(VERSIONS[network][kind]), payload));
}

/**
 * Encodes a post-quantum key as a YED (`yedpq`) or plain-YEC (`pq`) address.
 *
 * @param network - The network.
 * @param kind - `yedpq` or `pq`.
 * @param id - The key id.
 * @returns The 53-character address.
 */
export function encodePQAddress(network: YcashNetwork, kind: "yedpq" | "pq", id: PQKeyId): string {
  return encodeAddress(network, kind, concatBytes(Uint8Array.of(id.scheme), id.hash));
}

/**
 * Decode an address. Testnet and regtest share their transparent prefixes, so a `sm…`/`s2…`
 * address decodes as "ycash:testnet" unless `network` says which is meant; with `network`, an
 * address of another network is refused. A post-quantum address is 35 bytes under one of
 * {@link PQ_VERSIONS} (its version names network, form and scheme); the pre-D-9 form is refused.
 *
 * @param addr - The base58check address.
 * @param network - The network the address must belong to; omitted, any Ycash network is tried.
 * @returns The network, kind, hash and (post-quantum) scheme.
 * @throws Error on a bad checksum, a wrong length, or an unknown or mismatched version.
 */
export function decodeAddress(addr: string, network?: YcashNetwork): DecodedAddress {
  const b = base58CheckDecode(addr);
  if (b.length !== 22 && b.length !== 35) throw new Error("not a Ycash address (bad length)");
  if (b.length === 35) {
    const row = PQ_VERSIONS.find((r) => r.version[0] === b[0] && r.version[1] === b[1] && r.version[2] === b[2]);
    if (!row) throw new Error("not a Ycash address (unknown post-quantum version)");
    if (network !== undefined && row.network !== network) throw new Error(`not a ${network} address`);
    return { network: row.network, kind: row.kind, hash: b.slice(3), scheme: row.scheme };
  }
  const candidates = network !== undefined ? [network] : [YCASH_MAINNET, YCASH_TESTNET, YCASH_REGTEST];
  for (const net of candidates) {
    for (const kind of KINDS) {
      if (isPQKind(kind)) continue;
      const [v0, v1] = VERSIONS[net][kind];
      if (b[0] !== v0 || b[1] !== v1) continue;
      return { network: net, kind, hash: b.slice(2) };
    }
  }
  throw new Error(network !== undefined ? `not a ${network} address` : "not a Ycash address (unknown version)");
}

/**
 * The scriptPubKey an address pays. A `yed` address is a P2PKH key hash, a `yedpq` or `pq` address
 * a TX_PQPKH (`20 <hash> 51|52 c2`).
 *
 * @param addr - The base58check address.
 * @param network - The network the address must belong to, if known.
 * @returns The P2PKH, P2SH or TX_PQPKH output script.
 */
export function addressToScript(addr: string, network?: YcashNetwork): Uint8Array {
  const d = decodeAddress(addr, network);
  if (d.scheme !== undefined) return pqpkhScript({ scheme: d.scheme, hash: d.hash });
  return d.kind === "p2sh" ? p2shScript(d.hash) : p2pkhScript(d.hash);
}
