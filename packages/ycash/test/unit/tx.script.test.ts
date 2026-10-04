import { describe, expect, it } from "vitest";
import {
  OP, buildScript, bytesToHex, decodeScriptNum, hash160, hexToBytes, opReturnScript, p2pkhHash, p2pkhScript,
  p2pkhScriptSig, p2shHash, p2shScript, p2shScriptSig, parseScript, pushData, pushInt, scriptNum,
} from "../../src/tx/index.js";

const fill = (n: number, v = 0xab): Uint8Array => new Uint8Array(n).fill(v);

describe("pushes", () => {
  it("are minimal (SCRIPT_VERIFY_MINIMALDATA)", () => {
    expect(bytesToHex(pushData(new Uint8Array()))).toBe("00");
    expect(bytesToHex(pushData(Uint8Array.of(1)))).toBe("51");
    expect(bytesToHex(pushData(Uint8Array.of(16)))).toBe("60");
    expect(bytesToHex(pushData(Uint8Array.of(0x81)))).toBe("4f");
    expect(bytesToHex(pushData(Uint8Array.of(0)))).toBe("0100");
    expect(bytesToHex(pushData(Uint8Array.of(17)))).toBe("0111");
    expect(bytesToHex(pushData(fill(75)).slice(0, 1))).toBe("4b");
    expect(bytesToHex(pushData(fill(76)).slice(0, 2))).toBe("4c4c");
    expect(bytesToHex(pushData(fill(255)).slice(0, 2))).toBe("4cff");
    expect(bytesToHex(pushData(fill(256)).slice(0, 3))).toBe("4d0001");
    expect(bytesToHex(pushData(fill(65536)).slice(0, 5))).toBe("4e00000100");
  });

  it("push numbers as CScript << int64 does", () => {
    expect(bytesToHex(pushInt(0))).toBe("00");
    expect(bytesToHex(pushInt(-1))).toBe("4f");
    expect(bytesToHex(pushInt(1))).toBe("51");
    expect(bytesToHex(pushInt(16))).toBe("60");
    expect(bytesToHex(pushInt(17))).toBe("0111");
    expect(bytesToHex(pushInt(128))).toBe("028000");
    expect(bytesToHex(pushInt(-128))).toBe("028080");
    expect(bytesToHex(pushInt(500_000))).toBe("0320a107");
    expect(bytesToHex(pushInt(255))).toBe("02ff00");
  });

  it("round-trip CScriptNum", () => {
    for (const n of [0n, 1n, -1n, 127n, 128n, -128n, 255n, 256n, 32767n, 8388608n, 499_999_999n, -2147483647n]) {
      expect(decodeScriptNum(scriptNum(n))).toBe(n);
    }
  });
});

describe("buildScript and parseScript", () => {
  it("treats numbers as opcodes, bytes as pushes and bigints as number pushes", () => {
    const s = buildScript([OP.OP_DUP, fill(3, 1), 7n, OP.OP_0, new Uint8Array()]);
    expect(bytesToHex(s)).toBe("76" + "03010101" + "57" + "00" + "00");
    expect(parseScript(s)).toEqual([
      { op: OP.OP_DUP },
      { op: 3, data: fill(3, 1) },
      { op: 0x57 },
      { op: 0, data: new Uint8Array() },
      { op: 0, data: new Uint8Array() },
    ]);
    expect(() => buildScript([256])).toThrow(/opcode/);
  });

  it("parses PUSHDATA1/2/4 and refuses a truncated push", () => {
    const s = buildScript([fill(80), fill(300), OP.OP_CHECKSIG]);
    const chunks = parseScript(s);
    expect(chunks.map((c) => [c.op, c.data?.length])).toEqual([[OP.OP_PUSHDATA1, 80], [OP.OP_PUSHDATA2, 300], [OP.OP_CHECKSIG, undefined]]);
    expect(parseScript(pushData(fill(65536)))[0]!.data).toHaveLength(65536);
    expect(() => parseScript(Uint8Array.of(0x05, 1, 2))).toThrow(/truncated/);
  });
});

describe("templates", () => {
  const pkh = hexToBytes("751e76e8199196d454941c45d1b3a323f1433bd6");

  it("P2PKH and P2SH scriptPubKeys, and their recognisers", () => {
    expect(bytesToHex(p2pkhScript(pkh))).toBe("76a914751e76e8199196d454941c45d1b3a323f1433bd688ac");
    expect(bytesToHex(p2shScript(pkh))).toBe("a914751e76e8199196d454941c45d1b3a323f1433bd687");
    expect(p2pkhHash(p2pkhScript(pkh))).toEqual(pkh);
    expect(p2shHash(p2shScript(pkh))).toEqual(pkh);
    expect(p2pkhHash(p2shScript(pkh))).toBeNull();
    expect(p2shHash(p2pkhScript(pkh))).toBeNull();
    expect(() => p2pkhScript(fill(19))).toThrow(/20 bytes/);
  });

  it("OP_RETURN", () => {
    expect(bytesToHex(opReturnScript(Uint8Array.of(0xde, 0xad)))).toBe("6a02dead");
    expect(bytesToHex(opReturnScript(fill(80)).slice(0, 3))).toBe("6a4c50");
  });

  it("P2PKH scriptSig: <sig> <pubkey>", () => {
    const sig = fill(71, 0x30);
    const pub = fill(33, 0x02);
    expect(bytesToHex(p2pkhScriptSig(sig, pub))).toBe("47" + bytesToHex(sig) + "21" + bytesToHex(pub));
  });

  it("the channel scriptSigs of plan §5.7, with OP_0 / OP_1 as opcodes", () => {
    const C = fill(33, 0x02);
    const S = fill(33, 0x03);
    const rs = buildScript([
      OP.OP_IF, OP.OP_2, C, S, OP.OP_2, OP.OP_CHECKMULTISIG,
      OP.OP_ELSE, 1152n, OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP, C, OP.OP_CHECKSIG, OP.OP_ENDIF,
    ]);
    const sigC = fill(72, 0x30);
    const sigS = fill(71, 0x30);
    const close = p2shScriptSig([OP.OP_0, sigC, sigS, OP.OP_1], rs);
    expect(parseScript(close).map((c) => c.op)).toEqual([0x00, 72, 71, 0x51, OP.OP_PUSHDATA1]); // the redeem script is over 75 bytes
    expect(parseScript(close)[4]!.data).toEqual(rs);
    const refund = p2shScriptSig([sigC, OP.OP_0], rs);
    expect(bytesToHex(refund)).toBe("48" + bytesToHex(sigC) + "00" + "4c" + rs.length.toString(16) + bytesToHex(rs));
    expect(p2shHash(p2shScript(hash160(rs)))).toEqual(hash160(rs));
  });
});
