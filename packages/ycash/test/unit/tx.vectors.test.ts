// Offline replay of the node-generated vectors in vectors/tx (plan X-2): every case was built by
// src/tx, accepted by sendrawtransaction and mined on the named line; uniform-hash-type P2PKH cases
// were also byte-identical to the node's own signrawtransaction.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OP, decodeWif, feeFloor, hexToBytes, bytesToHex, logicalActions, p2pkhScriptSig, p2shScriptSig, parseTx,
  pubkeyFromPriv, serializeTx, sighashV4, signInput, txFee, txid, verifyInputSig,
} from "../../src/tx/index.js";

const vectorsDir = fileURLToPath(new URL("../../../../vectors/tx/", import.meta.url));
// `any`-free loader: the JSON shapes are declared below and only read.
const load = <T>(name: string): T => JSON.parse(readFileSync(vectorsDir + name, "utf8")) as T;

interface NodeCase {
  name: string;
  line: string;
  branchId: string;
  unsignedHex: string;
  prevouts: { txid: string; vout: number; scriptPubKey: string; value: string; redeemScript?: string }[];
  inputs: { kind: "p2pkh" | "p2sh-channel-close" | "p2sh-channel-refund"; hashType: number; wifs: string[]; scriptCode: string; sighash: string }[];
  feeZat: string;
  logicalActions: number;
  signedHex: string;
  txid: string;
  nodeSignedIdentical: boolean | null;
  accepted: boolean;
  mined: boolean;
}
interface WrongBranch {
  name: string; branchId: string; prevout: { txid: string; vout: number; scriptPubKey: string; value: string };
  signedHex: string; sighash: string; verifyComplete: boolean; error: string;
}
interface NodeFile {
  line: string; subversion: string; branchId: string; cases: NodeCase[]; negatives: { name: string; signedHex: string; error: string }[];
  wrongBranch?: WrongBranch;
}

// ycash-dd-vault.json: ycash-dd upgrade/vault past the Vault upgrade (branch 6d5b7a31).
const files = ["ycash-dd.json", "ycash-dd-canopy.json", "ycash6.json", "ycash-dd-vault.json"].map((f) => load<NodeFile>(f));

describe("node vectors: both lines", () => {
  it("cover both node lines, each with 13 accepted and mined cases", () => {
    expect(files.map((f) => f.subversion)).toEqual(["/YcashCpp:4.5.0/", "/YcashCpp:4.5.0/", "/YcashCpp:6.21.0-rc1/", "/YcashCpp:4.5.0/"]);
    expect(files.map((f) => f.branchId)).toEqual(["76b809bb", "19bd2d2f", "76b809bb", "6d5b7a31"]);
    for (const f of files) {
      expect(f.cases).toHaveLength(13);
      expect(f.cases.every((c) => c.accepted && c.mined)).toBe(true);
      expect(f.cases.filter((c) => c.nodeSignedIdentical === true).length).toBe(9);
    }
  });

  for (const f of files) {
    describe(`${f.line} (${f.subversion}, branch ${f.branchId})`, () => {
      for (const c of f.cases) {
        it(c.name, () => {
          const branch = parseInt(c.branchId, 16);
          const tx = parseTx(c.unsignedHex);
          expect(bytesToHex(serializeTx(tx))).toBe(c.unsignedHex);
          c.inputs.forEach((inp, i) => {
            const p = c.prevouts[i]!;
            const scriptCode = hexToBytes(inp.scriptCode);
            expect(inp.scriptCode).toBe(p.redeemScript ?? p.scriptPubKey);
            const sh = sighashV4(tx, i, scriptCode, BigInt(p.value), inp.hashType, branch);
            expect(bytesToHex(sh)).toBe(inp.sighash);
            const keys = inp.wifs.map((w) => decodeWif(w).privKey);
            const sigs = keys.map((k) => signInput(sh, k, inp.hashType));
            sigs.forEach((s, j) => expect(verifyInputSig(s, sh, pubkeyFromPriv(keys[j]!))).toBe(true));
            const rs = p.redeemScript ? hexToBytes(p.redeemScript) : new Uint8Array();
            tx.vin[i]!.scriptSig =
              inp.kind === "p2pkh" ? p2pkhScriptSig(sigs[0]!, pubkeyFromPriv(keys[0]!))
              : inp.kind === "p2sh-channel-close" ? p2shScriptSig([OP.OP_0, sigs[0]!, sigs[1]!, OP.OP_1], rs)
              : p2shScriptSig([sigs[0]!, OP.OP_0], rs);
          });
          expect(bytesToHex(serializeTx(tx))).toBe(c.signedHex);
          expect(txid(tx)).toBe(c.txid);
          expect(txid(c.signedHex)).toBe(c.txid);
          expect(txFee(tx, c.prevouts.map((p) => BigInt(p.value))).toString()).toBe(c.feeZat);
          expect(logicalActions(tx)).toBe(c.logicalActions);
          expect(BigInt(c.feeZat)).toBe(feeFloor(tx)); // every case paid exactly the S-6 floor and relayed
        });
      }
      it("refuses the CLTV refund before t (non-final, then the CLTV check)", () => {
        expect(f.negatives.map((n) => n.error)).toEqual([
          expect.stringContaining("non-final"),
          expect.stringContaining("Locktime requirement not satisfied"),
        ]);
        for (const n of f.negatives) expect(() => parseTx(n.signedHex)).not.toThrow();
      });
    });
  }
});

describe("Vault (6d5b7a31): the node refuses a spend signed under Canopy past activation", () => {
  const vault = files[3]!;
  const w = vault.wrongBranch!;
  it("its signature is Canopy's, fails under Vault, and the node said old-consensus-branch-id", () => {
    expect(vault.branchId).toBe("6d5b7a31");
    expect(w.branchId).toBe("19bd2d2f");
    const tx = parseTx(w.signedHex);
    const [sig, pub] = [0, 1].map((k) => {
      const ss = tx.vin[0]!.scriptSig; // <sig> <pubkey>, two direct pushes
      const n = ss[0]!;
      return k === 0 ? ss.slice(1, 1 + n) : ss.slice(2 + n, 2 + n + ss[1 + n]!);
    }) as [Uint8Array, Uint8Array];
    const at = (branch: number) => sighashV4(tx, 0, hexToBytes(w.prevout.scriptPubKey), BigInt(w.prevout.value), 1, branch);
    expect(bytesToHex(at(0x19bd2d2f))).toBe(w.sighash);
    expect(verifyInputSig(sig, at(0x19bd2d2f), pub)).toBe(true);
    expect(verifyInputSig(sig, at(0x6d5b7a31), pub)).toBe(false);
    expect(w.verifyComplete).toBe(false);
    expect(w.error).toContain("old-consensus-branch-id (Expected 6d5b7a31, found 19bd2d2f)");
  });
  it("only the Vault file carries one", () => {
    expect(files.filter((f) => f.wrongBranch).map((f) => f.line)).toEqual(["ycash-dd-vault"]);
  });
});

describe("YEW tx.rs vectors (ycash-dd devnet, Canopy branch)", () => {
  interface YewFile {
    transactions: {
      unsignedHex: string; branchId: string; signedHex: string; txid: string; sighashPerInput: string[]; feeZat: number;
      prevouts: { scriptPubKeyHex: string; valueZat: number }[]; keys: { wif: string; pubkeyHex: string }[];
    }[];
  }
  const yew = load<YewFile>("yew-transparent.json");
  it("reproduces every sighash, signature and txid", () => {
    expect(yew.transactions.length).toBeGreaterThan(0);
    for (const t of yew.transactions) {
      const tx = parseTx(t.unsignedHex);
      t.prevouts.forEach((p, i) => {
        const sh = sighashV4(tx, i, hexToBytes(p.scriptPubKeyHex), BigInt(p.valueZat), 1, parseInt(t.branchId, 16));
        expect(bytesToHex(sh)).toBe(t.sighashPerInput[i]);
        const { privKey } = decodeWif(t.keys[i]!.wif);
        expect(bytesToHex(pubkeyFromPriv(privKey))).toBe(t.keys[i]!.pubkeyHex);
        tx.vin[i]!.scriptSig = p2pkhScriptSig(signInput(sh, privKey), pubkeyFromPriv(privKey));
      });
      expect(bytesToHex(serializeTx(tx))).toBe(t.signedHex);
      expect(txid(tx)).toBe(t.txid);
      expect(txFee(tx, t.prevouts.map((p) => BigInt(p.valueZat)))).toBe(BigInt(t.feeZat));
    }
  });
});

describe("ZIP-243 rows of the node's src/test/data/sighash.json (shielded components, random hash types)", () => {
  interface RowFile { cases: { line: string; row: [string, string, number, number, number, string] }[] }
  const rows = load<RowFile>("sighash-node-tests.json");
  it("matches all rows from both lines", () => {
    expect(new Set(rows.cases.map((c) => c.line))).toEqual(new Set(["ycash-dd", "ycash6"]));
    let shielded = 0;
    for (const { row } of rows.cases) {
      const [raw, script, idx, hashType, branchId, expected] = row;
      const tx = parseTx(raw);
      if (tx.shieldedSpends.length + tx.shieldedOutputs.length + tx.joinSplits.length > 0) shielded++;
      expect(bytesToHex(serializeTx(tx))).toBe(raw);
      const sh = sighashV4(tx, idx, hexToBytes(script), 0n, hashType >>> 0, branchId >>> 0);
      expect(bytesToHex(Uint8Array.from(sh).reverse())).toBe(expected);
    }
    expect(shielded).toBeGreaterThan(100);
  });
});

describe("wallet-built shielded transactions", () => {
  interface ShieldedFile {
    line: string;
    cases: {
      name: string; hex: string; txid: string; nVin: number; nVout: number; nShieldedSpend: number; nShieldedOutput: number;
      nJoinSplit: number; valueBalanceZat: string; inputValuesZat: string[]; feeZat: string | null;
      outputs: { cv: string; cmu: string; ephemeralKey: string }[];
    }[];
  }
  for (const f of ["ycash-dd-shielded.json", "ycash6-shielded.json"].map((n) => load<ShieldedFile>(n))) {
    for (const c of f.cases) {
      it(`${f.line}: ${c.name}`, () => {
        const tx = parseTx(c.hex);
        expect(bytesToHex(serializeTx(tx))).toBe(c.hex);
        expect(txid(tx)).toBe(c.txid);
        expect([tx.vin.length, tx.vout.length, tx.shieldedSpends.length, tx.shieldedOutputs.length, tx.joinSplits.length])
          .toEqual([c.nVin, c.nVout, c.nShieldedSpend, c.nShieldedOutput, c.nJoinSplit]);
        expect(tx.valueBalance.toString()).toBe(c.valueBalanceZat);
        expect(tx.bindingSig).toHaveLength(64);
        // decoderawtransaction prints cv, cmu and ephemeralKey as uint256 (reversed).
        tx.shieldedOutputs.forEach((o, i) => {
          const rev = (b: Uint8Array): string => bytesToHex(Uint8Array.from(b).reverse());
          expect(rev(o.cv)).toBe(c.outputs[i]!.cv);
          expect(rev(o.cmu)).toBe(c.outputs[i]!.cmu);
          expect(rev(o.ephemeralKey)).toBe(c.outputs[i]!.ephemeralKey);
          expect(o.encCiphertext).toHaveLength(580);
          expect(o.outCiphertext).toHaveLength(80);
        });
        const fee = txFee(tx, c.inputValuesZat.map(BigInt));
        expect(fee > 0n).toBe(true);
        if (c.feeZat !== null) expect(fee.toString()).toBe(c.feeZat);
      });
    }
  }
});
