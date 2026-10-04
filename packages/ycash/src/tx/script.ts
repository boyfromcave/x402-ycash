// Script building: opcodes, minimal pushes, the standard templates, and hand-assembled P2SH
// scriptSigs. The stock signer cannot sign a non-template redeem script (plan R-8,
// src/script/sign.cpp:84-86), so channel scriptSigs are assembled here, as atomic swap does
// (src/script/atomicswap.cpp:151-185). Pushes are minimal because SCRIPT_VERIFY_MINIMALDATA is a
// standard flag on both lines (ycash-dd/src/policy/policy.h:32-40, ycash6 :45-53).
import { ByteReader, ByteWriter, concatBytes } from "./bytes.js";

/** Opcodes used by the bindings (src/script/script.h). */
export const OP = {
  OP_0: 0x00,
  OP_FALSE: 0x00,
  OP_PUSHDATA1: 0x4c,
  OP_PUSHDATA2: 0x4d,
  OP_PUSHDATA4: 0x4e,
  OP_1NEGATE: 0x4f,
  OP_1: 0x51,
  OP_TRUE: 0x51,
  OP_2: 0x52,
  OP_3: 0x53,
  OP_16: 0x60,
  OP_NOP: 0x61,
  OP_IF: 0x63,
  OP_NOTIF: 0x64,
  OP_ELSE: 0x67,
  OP_ENDIF: 0x68,
  OP_VERIFY: 0x69,
  OP_RETURN: 0x6a,
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_SIZE: 0x82,
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  OP_SHA256: 0xa8,
  OP_HASH160: 0xa9,
  OP_CHECKSIG: 0xac,
  OP_CHECKSIGVERIFY: 0xad,
  OP_CHECKMULTISIG: 0xae,
  OP_CHECKMULTISIGVERIFY: 0xaf,
  OP_CHECKLOCKTIMEVERIFY: 0xb1,
} as const;

/** A script element: a number is an opcode, bytes are a data push, a bigint is a number push. */
export type ScriptItem = number | bigint | Uint8Array;

/** The minimal push of `data` (CheckMinimalPush, src/script/interpreter.cpp). */
export function pushData(data: Uint8Array): Uint8Array {
  const n = data.length;
  if (n === 0) return Uint8Array.of(OP.OP_0);
  if (n === 1) {
    const v = data[0] as number;
    if (v >= 1 && v <= 16) return Uint8Array.of(OP.OP_1 + v - 1);
    if (v === 0x81) return Uint8Array.of(OP.OP_1NEGATE);
  }
  const w = new ByteWriter();
  if (n <= 75) w.u8(n);
  else if (n <= 0xff) w.u8(OP.OP_PUSHDATA1).u8(n);
  else if (n <= 0xffff) w.u8(OP.OP_PUSHDATA2).bytes(Uint8Array.of(n & 0xff, n >> 8));
  else w.u8(OP.OP_PUSHDATA4).u32(n);
  return w.bytes(data).finish();
}

/** CScriptNum serialisation: little-endian magnitude with a sign bit. */
export function scriptNum(n: bigint | number): Uint8Array {
  let v = BigInt(n);
  if (v === 0n) return new Uint8Array();
  const neg = v < 0n;
  if (neg) v = -v;
  const out: number[] = [];
  while (v > 0n) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  const last = out[out.length - 1] as number;
  if (last & 0x80) out.push(neg ? 0x80 : 0);
  else if (neg) out[out.length - 1] = last | 0x80;
  return Uint8Array.from(out);
}

export function decodeScriptNum(b: Uint8Array): bigint {
  if (b.length === 0) return 0n;
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] as number);
  const top = b[b.length - 1] as number;
  if (top & 0x80) return -(v & ~(0x80n << BigInt(8 * (b.length - 1))));
  return v;
}

/** Push a number as CScript << int64 does: OP_0, OP_1NEGATE, OP_1..OP_16, else a CScriptNum push. */
export function pushInt(n: bigint | number): Uint8Array {
  const v = BigInt(n);
  if (v === 0n) return Uint8Array.of(OP.OP_0);
  if (v === -1n) return Uint8Array.of(OP.OP_1NEGATE);
  if (v >= 1n && v <= 16n) return Uint8Array.of(OP.OP_1 + Number(v) - 1);
  return pushData(scriptNum(v));
}

export function buildScript(items: readonly ScriptItem[]): Uint8Array {
  return concatBytes(
    ...items.map((it) => {
      if (it instanceof Uint8Array) return pushData(it);
      if (typeof it === "bigint") return pushInt(it);
      if (!Number.isInteger(it) || it < 0 || it > 0xff) throw new Error(`invalid opcode ${it}`);
      return Uint8Array.of(it);
    }),
  );
}

export interface ScriptChunk {
  op: number;
  /** Set for data pushes (including OP_0, as an empty array). */
  data?: Uint8Array;
}

/** Split a script into opcodes and pushes; throws on a truncated push. */
export function parseScript(script: Uint8Array): ScriptChunk[] {
  const r = new ByteReader(script);
  const out: ScriptChunk[] = [];
  while (r.remaining > 0) {
    const op = r.u8();
    if (op === OP.OP_0) out.push({ op, data: new Uint8Array() });
    else if (op <= 75) out.push({ op, data: r.take(op) });
    else if (op === OP.OP_PUSHDATA1) out.push({ op, data: r.take(r.u8()) });
    else if (op === OP.OP_PUSHDATA2) {
      const lenBytes = r.take(2);
      out.push({ op, data: r.take((lenBytes[0] as number) | ((lenBytes[1] as number) << 8)) });
    } else if (op === OP.OP_PUSHDATA4) out.push({ op, data: r.take(r.u32()) });
    else out.push({ op });
  }
  return out;
}

function check20(h: Uint8Array, what: string): Uint8Array {
  if (h.length !== 20) throw new Error(`${what} must be 20 bytes`);
  return h;
}

/** OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG */
export function p2pkhScript(pkh: Uint8Array): Uint8Array {
  return buildScript([OP.OP_DUP, OP.OP_HASH160, check20(pkh, "key hash"), OP.OP_EQUALVERIFY, OP.OP_CHECKSIG]);
}

/** OP_HASH160 <scriptHash> OP_EQUAL */
export function p2shScript(scriptHash: Uint8Array): Uint8Array {
  return buildScript([OP.OP_HASH160, check20(scriptHash, "script hash"), OP.OP_EQUAL]);
}

/** OP_RETURN <data>; standard up to 80 data bytes, one per tx (src/script/standard.h:34). */
export function opReturnScript(data: Uint8Array): Uint8Array {
  return buildScript([OP.OP_RETURN, data]);
}

/** The key hash of a P2PKH scriptPubKey, or null. */
export function p2pkhHash(spk: Uint8Array): Uint8Array | null {
  return spk.length === 25 && spk[0] === OP.OP_DUP && spk[1] === OP.OP_HASH160 && spk[2] === 20 &&
    spk[23] === OP.OP_EQUALVERIFY && spk[24] === OP.OP_CHECKSIG
    ? spk.slice(3, 23)
    : null;
}

/** The script hash of a P2SH scriptPubKey, or null. */
export function p2shHash(spk: Uint8Array): Uint8Array | null {
  return spk.length === 23 && spk[0] === OP.OP_HASH160 && spk[1] === 20 && spk[22] === OP.OP_EQUAL
    ? spk.slice(2, 22)
    : null;
}

/** <sig> <pubkey> */
export function p2pkhScriptSig(sig: Uint8Array, pubkey: Uint8Array): Uint8Array {
  return buildScript([sig, pubkey]);
}

/**
 * A P2SH scriptSig: the items (opcodes such as OP.OP_0 / OP.OP_1, or byte pushes) followed by a
 * push of the redeem script. The channel close is
 * `p2shScriptSig([OP.OP_0, sigC, sigS, OP.OP_1], rs)` and the refund `p2shScriptSig([sigC, OP.OP_0], rs)`.
 */
export function p2shScriptSig(items: readonly ScriptItem[], redeemScript: Uint8Array): Uint8Array {
  return buildScript([...items, redeemScript]);
}
