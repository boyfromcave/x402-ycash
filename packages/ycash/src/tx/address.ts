// Transparent and YED addresses: base58check of version bytes ‖ 20-byte hash.
// Transparent prefixes (identical on both lines):
//   mainnet P2PKH 1C 28 "s1…", P2SH 1C 2C "s2…"/"s3…" (ycash-dd/src/chainparams.cpp:149-151, ycash6 :161-163)
//   testnet and regtest share P2PKH 1C 95 "sm…", P2SH 1C 2A "s2…" (ycash-dd :409-411,613-614; ycash6 :456-458,689-690)
// YED addresses are P2PKH only, one version per network (ycash-dd/src/yellowback/params.cpp:142,162,195,
// address.cpp:11-27; same lines on ycash6): mainnet 1F E4 "ye…", testnet 20 07 "yt…", regtest 20 02 "yr…".
import { YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET, type YcashNetwork } from "../constants.js";
import { base58CheckDecode, base58CheckEncode } from "./base58.js";
import { concatBytes } from "./bytes.js";
import { p2pkhScript, p2shScript } from "./script.js";

export type AddressKind = "p2pkh" | "p2sh" | "yed";

export interface DecodedAddress {
  network: YcashNetwork;
  kind: AddressKind;
  /** The 20-byte key hash (p2pkh, yed) or script hash (p2sh). */
  hash: Uint8Array;
}

const VERSIONS: Record<YcashNetwork, Record<AddressKind, readonly [number, number]>> = {
  [YCASH_MAINNET]: { p2pkh: [0x1c, 0x28], p2sh: [0x1c, 0x2c], yed: [0x1f, 0xe4] },
  [YCASH_TESTNET]: { p2pkh: [0x1c, 0x95], p2sh: [0x1c, 0x2a], yed: [0x20, 0x07] },
  [YCASH_REGTEST]: { p2pkh: [0x1c, 0x95], p2sh: [0x1c, 0x2a], yed: [0x20, 0x02] },
};

export function encodeAddress(network: YcashNetwork, kind: AddressKind, hash: Uint8Array): string {
  if (hash.length !== 20) throw new Error("address hash must be 20 bytes");
  const v = VERSIONS[network][kind];
  return base58CheckEncode(concatBytes(Uint8Array.from(v), hash));
}

/**
 * Decode an address. Testnet and regtest share their transparent prefixes, so a `sm…`/`s2…`
 * address decodes as "ycash:testnet" unless `network` says which is meant; with `network`, an
 * address of another network is refused.
 */
export function decodeAddress(addr: string, network?: YcashNetwork): DecodedAddress {
  const b = base58CheckDecode(addr);
  if (b.length !== 22) throw new Error("not a Ycash address (bad length)");
  const hash = b.slice(2);
  const candidates = network !== undefined ? [network] : [YCASH_MAINNET, YCASH_TESTNET, YCASH_REGTEST];
  for (const net of candidates) {
    for (const kind of ["p2pkh", "p2sh", "yed"] as const) {
      const [v0, v1] = VERSIONS[net][kind];
      if (b[0] === v0 && b[1] === v1) return { network: net, kind, hash };
    }
  }
  throw new Error(network !== undefined ? `not a ${network} address` : "not a Ycash address (unknown version)");
}

/**
 * The scriptPubKey an address pays. A YED address is a P2PKH key hash; its YEC output script is
 * the plain P2PKH script.
 */
export function addressToScript(addr: string, network?: YcashNetwork): Uint8Array {
  const d = decodeAddress(addr, network);
  return d.kind === "p2sh" ? p2shScript(d.hash) : p2pkhScript(d.hash);
}
