// Strict DER for ECDSA signatures. @noble/secp256k1 3.x speaks only compact (r ‖ s), so the
// encoding is done here: encodeDer emits the minimal form, and decodeDer accepts exactly what
// IsValidSignatureEncoding accepts (src/script/interpreter.cpp, BIP66), without the hash-type byte.

function derInt(x: Uint8Array): Uint8Array {
  let i = 0;
  while (i < x.length - 1 && x[i] === 0) i++;
  const v = x.slice(i);
  return (v[0] as number) & 0x80 ? Uint8Array.from([0, ...v]) : v;
}

/** Compact 64-byte r ‖ s → DER. */
export function encodeDer(compact: Uint8Array): Uint8Array {
  if (compact.length !== 64) throw new Error("compact signature must be 64 bytes");
  const r = derInt(compact.slice(0, 32));
  const s = derInt(compact.slice(32));
  return Uint8Array.from([0x30, 4 + r.length + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}

/** DER → compact 64-byte r ‖ s; throws on anything BIP66 would reject. */
export function decodeDer(der: Uint8Array): Uint8Array {
  const at = (i: number): number => {
    const v = der[i];
    if (v === undefined) throw new Error("truncated DER signature");
    return v;
  };
  if (der.length < 8 || der.length > 72) throw new Error("bad DER length");
  if (at(0) !== 0x30 || at(1) !== der.length - 2) throw new Error("bad DER sequence");
  const lenR = at(3);
  if (at(2) !== 0x02 || lenR === 0 || 5 + lenR >= der.length) throw new Error("bad DER r");
  const lenS = at(5 + lenR);
  if (at(4 + lenR) !== 0x02 || lenS === 0 || lenR + lenS + 6 !== der.length) throw new Error("bad DER s");
  const out = new Uint8Array(64);
  for (const [off, len, dst] of [[4, lenR, 0], [6 + lenR, lenS, 32]] as const) {
    if (at(off) & 0x80) throw new Error("negative DER integer");
    if (len > 1 && at(off) === 0 && !(at(off + 1) & 0x80)) throw new Error("non-minimal DER integer");
    const v = der.slice(off, off + len);
    const trimmed = v.length === 33 && v[0] === 0 ? v.slice(1) : v;
    if (trimmed.length > 32) throw new Error("DER integer too long");
    out.set(trimmed, dst + 32 - trimmed.length);
  }
  return out;
}
