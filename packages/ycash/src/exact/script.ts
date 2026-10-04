// scriptSig inspection for verification rule 5 and the response's `payer`.
import type { YcashNetwork } from "../constants.js";
import { encodeAddress, hash160, p2pkhHash, p2shHash, parseScript, SIGHASH, type ScriptChunk } from "../tx/index.js";

/**
 * Whether a push is a DER signature followed by a hash-type byte, by its shape alone: 0x30, a
 * length byte covering the rest but the hash type, then two INTEGERs (BIP66). Strictness is the
 * node's job (rule 9); this only finds which pushes are signatures.
 */
export function looksLikeSignature(b: Uint8Array): boolean {
  if (b.length < 9 || b.length > 73) return false;
  if (b[0] !== 0x30 || b[1] !== b.length - 3) return false;
  const rLen = b[3] as number;
  return b[2] === 0x02 && 5 + rLen < b.length - 1 && b[4 + rLen] === 0x02;
}

/**
 * Rule 5: every signature in the scriptSig carries SIGHASH_ALL, and there is at least one (an
 * unsigned input would let anyone rewrite the outputs). Returns a reason, or null.
 */
export function checkSighashAll(scriptSig: Uint8Array): string | null {
  let chunks: ScriptChunk[];
  try {
    chunks = parseScript(scriptSig);
  } catch {
    return "scriptSig does not parse";
  }
  const sigs = chunks.filter((c) => c.data !== undefined && looksLikeSignature(c.data)).map((c) => c.data as Uint8Array);
  if (sigs.length === 0) return "scriptSig carries no signature";
  const bad = sigs.find((s) => s[s.length - 1] !== SIGHASH.ALL);
  return bad ? `signature hash type 0x${(bad[bad.length - 1] as number).toString(16)} is not SIGHASH_ALL` : null;
}

/** The address of a P2PKH or P2SH scriptPubKey, or "" for any other script. */
export function addressOfScript(spk: Uint8Array, network: YcashNetwork): string {
  const pkh = p2pkhHash(spk);
  if (pkh) return encodeAddress(network, "p2pkh", pkh);
  const sh = p2shHash(spk);
  return sh ? encodeAddress(network, "p2sh", sh) : "";
}

/**
 * The address a verified scriptSig spends from, for a settle that resumes after the inputs are
 * spent (gettxout no longer shows them): `<sig> <pubkey>` is P2PKH, otherwise the last push is
 * a P2SH redeem script. "" when neither shape fits.
 */
export function addressOfScriptSig(scriptSig: Uint8Array, network: YcashNetwork): string {
  let chunks: ScriptChunk[];
  try {
    chunks = parseScript(scriptSig);
  } catch {
    return "";
  }
  const last = chunks[chunks.length - 1]?.data;
  if (!last || last.length === 0) return "";
  const isPubkey = (last.length === 33 && (last[0] === 2 || last[0] === 3)) || (last.length === 65 && last[0] === 4);
  if (chunks.length === 2 && isPubkey && chunks[0]?.data && looksLikeSignature(chunks[0].data)) {
    return encodeAddress(network, "p2pkh", hash160(last));
  }
  return encodeAddress(network, "p2sh", hash160(last));
}
