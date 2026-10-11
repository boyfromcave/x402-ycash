// Transparent and YED addresses: base58check of version bytes ‖ payload.
// Transparent prefixes (identical on both lines):
//   mainnet P2PKH 1C 28 "s1…", P2SH 1C 2C "s2…"/"s3…" (ycash-dd/src/chainparams.cpp:149-151, ycash6 :161-163)
//   testnet and regtest share P2PKH 1C 95 "sm…", P2SH 1C 2A "s2…" (ycash-dd :409-411,613-614; ycash6 :456-458,689-690)
// YED addresses, one version per network and form (ycash-dd/src/yellowback/params.cpp, address.cpp):
//   20-byte key hash (a P2PKH holder): mainnet 1F DD "yb…" (D-Q-21; was 1F E4 "ye…" before the
//   quantum line), testnet 20 07 "yt…", regtest 20 02 "yr…"; 35 characters.
//   33-byte scheme ‖ key hash (a TX_PQPKH holder or vault owner; quantum spec §4, F-4): mainnet 56 AB
//   "yb…" (D-Q-21), testnet 57 1E "yt…", regtest 57 10 "yr…"; 53 characters.
// Plain-YEC post-quantum addresses (D-Q-20; the same TX_PQPKH script, decoded chain-wide by key_io):
//   mainnet 4D D9 "sq…", testnet 4F 61 "tq…", regtest 4C 51 "rq…"; 53 characters.
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

const VERSIONS: Record<YcashNetwork, Record<AddressKind, readonly [number, number]>> = {
  [YCASH_MAINNET]: { p2pkh: [0x1c, 0x28], p2sh: [0x1c, 0x2c], yed: [0x1f, 0xdd], yedpq: [0x56, 0xab], pq: [0x4d, 0xd9] },
  [YCASH_TESTNET]: { p2pkh: [0x1c, 0x95], p2sh: [0x1c, 0x2a], yed: [0x20, 0x07], yedpq: [0x57, 0x1e], pq: [0x4f, 0x61] },
  [YCASH_REGTEST]: { p2pkh: [0x1c, 0x95], p2sh: [0x1c, 0x2a], yed: [0x20, 0x02], yedpq: [0x57, 0x10], pq: [0x4c, 0x51] },
};

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
 * hash for p2pkh/p2sh/yed, the 33 bytes scheme ‖ key hash for yedpq/pq.
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
  } else if (payload.length !== 20) throw new Error("address hash must be 20 bytes");
  const v = VERSIONS[network][kind];
  return base58CheckEncode(concatBytes(Uint8Array.from(v), payload));
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
 * address of another network is refused. A post-quantum address must name scheme 1 or 2.
 *
 * @param addr - The base58check address.
 * @param network - The network the address must belong to; omitted, any Ycash network is tried.
 * @returns The network, kind, hash and (post-quantum) scheme.
 * @throws Error on a bad checksum, a wrong length, an unknown scheme, or an unknown or mismatched version.
 */
export function decodeAddress(addr: string, network?: YcashNetwork): DecodedAddress {
  const b = base58CheckDecode(addr);
  if (b.length !== 22 && b.length !== 35) throw new Error("not a Ycash address (bad length)");
  const pq = b.length === 35;
  const candidates = network !== undefined ? [network] : [YCASH_MAINNET, YCASH_TESTNET, YCASH_REGTEST];
  for (const net of candidates) {
    for (const kind of KINDS) {
      if (isPQKind(kind) !== pq) continue;
      const [v0, v1] = VERSIONS[net][kind];
      if (b[0] !== v0 || b[1] !== v1) continue;
      if (!pq) return { network: net, kind, hash: b.slice(2) };
      const scheme = b[2] as number;
      if (!isKnownScheme(scheme)) throw new Error(`not a Ycash address (unknown post-quantum scheme ${scheme})`);
      return { network: net, kind, hash: b.slice(3), scheme };
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
