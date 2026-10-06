// Generates vectors/tx/<line>.json against a running regtest node (plan X-2).
//
//   npx tsx vectors/tx/generate.ts <line> <rpcUrl> <user> <password>
//
// The node needs a funded wallet (mine 101+ blocks) and Overwinter + Sapling active. Every case is
// built and signed by src/tx, then (a) for single-hash-type P2PKH cases compared byte for byte with
// the node's own `signrawtransaction` using the same WIF keys (both sign RFC 6979), (b) checked with
// `signrawtransaction hex [] []` as a script verifier (plan R-5), and (c) relayed with
// `sendrawtransaction` and mined. Only cases that pass all three are written.
//
// The other files in this directory:
// - ycash-dd.json / ycash6.json: this script on a bare regtest node of each line, Overwinter and
//   Sapling at height 1 (branch 76b809bb); ycash-dd-canopy.json: ycash-dd with the Ycash, Blossom,
//   Heartwood and Canopy upgrades also at 1 (branch 19bd2d2f, mainnet's). ycash6 cannot run the Ycash
//   upgrade on regtest at usable speed (Equihash 192,7 applies there). ycash-dd-vault.json: ycash-dd
//   upgrade/vault on its devnet past Vault's activation (branch 6d5b7a31, -nuparams=6d5b7a31:103),
//   plus `wrongBranch`, the same kind of spend signed under Canopy and refused there.
// - <line>-shielded.json: wallet-built shielded txs (z_shieldcoinbase, then z_sendmany to a
//   transparent address) read back with gettransaction / decoderawtransaction, for the parser.
// - sighash-node-tests.json: the v4 rows of each line's src/test/data/sighash.json.
// - yew-transparent.json: yew/core/tests/vectors/transparent.json (ycash-dd devnet, YEW's tx.rs).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import * as T from "../../packages/ycash/src/tx/index.js";

const [line, url, user, password] = process.argv.slice(2);
if (!line || !url || !user || !password) throw new Error("usage: generate.ts <line> <rpcUrl> <user> <password>");
const NET = "ycash:regtest" as const;

let rpcId = 0;
// `any`: results are untyped JSON from the node; each call site reads only what it needs.
async function rpc(method: string, ...params: unknown[]): Promise<any> {
  const res = await fetch(url!, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${user}:${password}`, "utf8").toString("base64") },
    body: JSON.stringify({ jsonrpc: "1.0", id: ++rpcId, method, params }),
  });
  const j = (await res.json()) as { result: unknown; error: { message: string; code: number } | null };
  if (j.error) throw new Error(`${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
}

const coins = (zat: bigint): number => Number(zat) / 1e8;
const CANOPY = 0x19bd2d2f;
const VAULT = 0x6d5b7a31; // the Ycash Vault network upgrade, after Canopy

interface Key { priv: Uint8Array; pub: Uint8Array; pkh: Uint8Array; wif: string; address: string }
let keyCounter = 0;
function nextKey(): Key {
  const priv = sha256(new TextEncoder().encode(`x402-ycash/tx-vectors/${line}/${keyCounter++}`));
  const pub = T.pubkeyFromPriv(priv);
  const pkh = T.hash160(pub);
  return { priv, pub, pkh, wif: T.encodeWif(priv, NET), address: T.encodeAddress(NET, "p2pkh", pkh) };
}

interface Coin { txid: string; vout: number; value: bigint; scriptPubKey: Uint8Array }

/** Fund each script with one sendmany, mine it, and return the coins. */
async function fund(targets: { address: string; value: bigint }[]): Promise<Coin[]> {
  const amounts: Record<string, number> = {};
  for (const t of targets) amounts[t.address] = coins(t.value);
  const fundTxid: string = await rpc("sendmany", "", amounts);
  await rpc("generate", 1);
  const tx = T.parseTx((await rpc("gettransaction", fundTxid)).hex as string);
  return targets.map((t) => {
    const spk = T.addressToScript(t.address, NET);
    const vout = tx.vout.findIndex((o) => T.equalBytes(o.scriptPubKey, spk) && o.value === t.value);
    if (vout < 0) throw new Error(`funding output for ${t.address} not found`);
    return { txid: fundTxid, vout, value: t.value, scriptPubKey: spk };
  });
}

type InputKind = "p2pkh" | "p2sh-channel-close" | "p2sh-channel-refund";
interface CaseInput { coin: Coin; kind: InputKind; hashType: number; keys: Key[]; redeemScript?: Uint8Array }

interface Vector {
  name: string;
  line: string;
  branchId: string;
  unsignedHex: string;
  prevouts: { txid: string; vout: number; scriptPubKey: string; value: string; redeemScript?: string }[];
  inputs: { kind: InputKind; hashType: number; wifs: string[]; scriptCode: string; sighash: string }[];
  feeZat: string;
  logicalActions: number;
  signedHex: string;
  txid: string;
  nodeSignedIdentical: boolean | null;
  nodeScriptVerify: boolean;
  accepted: boolean;
  mined: boolean;
}

const HT_NAME: Record<number, string> = {
  0x01: "ALL", 0x02: "NONE", 0x03: "SINGLE", 0x81: "ALL|ANYONECANPAY", 0x82: "NONE|ANYONECANPAY", 0x83: "SINGLE|ANYONECANPAY",
};

async function main(): Promise<void> {
  const info = await rpc("getblockchaininfo");
  const branchHex: string = info.consensus.nextblock;
  const branchId = parseInt(branchHex, 16);
  const network: { subversion: string } = await rpc("getnetworkinfo");
  console.log(`${line}: ${network.subversion}, branch ${branchHex}, height ${info.blocks}`);

  const vectors: Vector[] = [];

  async function runCase(
    name: string,
    inputs: CaseInput[],
    outputs: T.TxOut[],
    opts: { lockTime?: number; expiryHeight?: number; sequence?: number } = {},
  ): Promise<void> {
    const tx = T.newTx({
      vin: inputs.map((i) => ({ prevout: { txid: i.coin.txid, vout: i.coin.vout }, scriptSig: new Uint8Array(), sequence: opts.sequence ?? T.SEQUENCE_FINAL })),
      vout: outputs,
      lockTime: opts.lockTime ?? 0,
      expiryHeight: opts.expiryHeight ?? 0,
    });
    const unsignedHex = T.serializeTxHex(tx);
    const vin: Vector["inputs"] = [];
    inputs.forEach((inp, idx) => {
      const scriptCode = inp.redeemScript ?? inp.coin.scriptPubKey;
      const sh = T.sighashV4(tx, idx, scriptCode, inp.coin.value, inp.hashType, branchId);
      const sigs = inp.keys.map((k) => T.signInput(sh, k.priv, inp.hashType));
      let scriptSig: Uint8Array;
      if (inp.kind === "p2pkh") scriptSig = T.p2pkhScriptSig(sigs[0]!, inp.keys[0]!.pub);
      else if (inp.kind === "p2sh-channel-close") scriptSig = T.p2shScriptSig([T.OP.OP_0, sigs[0]!, sigs[1]!, T.OP.OP_1], inp.redeemScript!);
      else scriptSig = T.p2shScriptSig([sigs[0]!, T.OP.OP_0], inp.redeemScript!);
      tx.vin[idx]!.scriptSig = scriptSig;
      vin.push({ kind: inp.kind, hashType: inp.hashType, wifs: inp.keys.map((k) => k.wif), scriptCode: T.bytesToHex(scriptCode), sighash: T.bytesToHex(sh) });
    });
    const signedHex = T.serializeTxHex(tx);
    const id = T.txid(tx);
    const fee = T.txFee(tx, inputs.map((i) => i.coin.value));
    if (fee < T.feeFloor(tx)) throw new Error(`${name}: fee ${fee} below the floor ${T.feeFloor(tx)}`);

    // (a) the node's signer, for uniform-hash-type P2PKH cases.
    let nodeSignedIdentical: boolean | null = null;
    const types = new Set(inputs.map((i) => i.hashType));
    // The node's signer skips a SINGLE input with no matching output (rawtransaction.cpp, "Only
    // sign SIGHASH_SINGLE if there's a corresponding output"); such inputs are checked by (b) and (c).
    const singleWithoutOutput = inputs.some((i, idx) => (i.hashType & 0x1f) === 0x03 && idx >= outputs.length);
    if (inputs.every((i) => i.kind === "p2pkh") && types.size === 1 && !singleWithoutOutput) {
      const prevtxs = inputs.map((i) => ({ txid: i.coin.txid, vout: i.coin.vout, scriptPubKey: T.bytesToHex(i.coin.scriptPubKey), amount: coins(i.coin.value) }));
      const r = await rpc("signrawtransaction", unsignedHex, prevtxs, inputs.map((i) => i.keys[0]!.wif), HT_NAME[inputs[0]!.hashType]);
      nodeSignedIdentical = r.complete === true && r.hex === signedHex;
      if (!nodeSignedIdentical) throw new Error(`${name}: node signature differs\n ours ${signedHex}\n node ${r.hex}`);
    }
    // (b) the stock script verifier.
    const verify = await rpc("signrawtransaction", signedHex, [], []);
    if (verify.complete !== true) throw new Error(`${name}: script verify failed: ${JSON.stringify(verify.errors)}`);
    // (c) relay.
    const sent: string = await rpc("sendrawtransaction", signedHex);
    if (sent !== id) throw new Error(`${name}: txid mismatch ${sent} vs ${id}`);
    console.log(`  ${name}: accepted ${id} fee ${fee} floor ${T.feeFloor(tx)}`);
    vectors.push({
      name, line: line!, branchId: branchHex, unsignedHex,
      prevouts: inputs.map((i) => ({
        txid: i.coin.txid, vout: i.coin.vout, scriptPubKey: T.bytesToHex(i.coin.scriptPubKey), value: i.coin.value.toString(),
        ...(i.redeemScript ? { redeemScript: T.bytesToHex(i.redeemScript) } : {}),
      })),
      inputs: vin, feeZat: fee.toString(), logicalActions: T.logicalActions(tx), signedHex, txid: id,
      nodeSignedIdentical, nodeScriptVerify: true, accepted: true, mined: false,
    });
  }

  /** Outputs paying `total − feeFloor` split over n P2PKH outputs (plus extra scripts). */
  function outputsFor(total: bigint, n: number, inputs: CaseInput[], extra: Uint8Array[] = []): T.TxOut[] {
    const outs: T.TxOut[] = [];
    for (let i = 0; i < n; i++) outs.push({ value: 0n, scriptPubKey: T.p2pkhScript(nextKey().pkh) });
    for (const s of extra) outs.push({ value: 0n, scriptPubKey: s });
    // Size the fee on a skeleton with dummy scriptSigs of the final size class.
    const skel = T.newTx({ vin: inputs.map((i) => ({ prevout: { txid: i.coin.txid, vout: i.coin.vout }, scriptSig: new Uint8Array(107), sequence: 0 })), vout: outs });
    const fee = T.feeFloor(skel);
    const each = (total - fee) / BigInt(n);
    outs.forEach((o, i) => { if (i < n) o.value = i === n - 1 ? total - fee - each * BigInt(n - 1) : each; });
    return outs;
  }

  // ---- fund everything in one transaction
  const typeCases: [string, number, number, number][] = [
    // name, hashType, inputs, outputs
    ["p2pkh-all-1in-1out", 0x01, 1, 1],
    ["p2pkh-all-2in-2out", 0x01, 2, 2],
    ["p2pkh-all-3in-3out", 0x01, 3, 3],
    ["p2pkh-none-2in-2out", 0x02, 2, 2],
    ["p2pkh-single-2in-2out", 0x03, 2, 2],
    ["p2pkh-single-3in-2out", 0x03, 3, 2], // SINGLE with no matching output: hashOutputs is zero
    ["p2pkh-all-acp-2in-1out", 0x81, 2, 1],
    ["p2pkh-none-acp-1in-2out", 0x82, 1, 2],
    ["p2pkh-single-acp-2in-3out", 0x83, 2, 3],
  ];
  const caseKeys = typeCases.map(([, , nin]) => Array.from({ length: nin }, nextKey));
  const mixedKeys = [nextKey(), nextKey(), nextKey()];
  const opretKey = nextKey();
  const C = nextKey(); // channel client
  const S = nextKey(); // channel server
  const tip: number = await rpc("getblockcount");
  const refundHeight = tip + 8; // t, a block height (< 500,000,000)
  const channel = T.buildScript([
    T.OP.OP_IF, T.OP.OP_2, C.pub, S.pub, T.OP.OP_2, T.OP.OP_CHECKMULTISIG,
    T.OP.OP_ELSE, BigInt(refundHeight), T.OP.OP_CHECKLOCKTIMEVERIFY, T.OP.OP_DROP, C.pub, T.OP.OP_CHECKSIG,
    T.OP.OP_ENDIF,
  ]);
  const channelAddr = T.encodeAddress(NET, "p2sh", T.hash160(channel));
  // A second channel output: sendmany refuses a repeated address, so use another t.
  const channel2 = T.buildScript([
    T.OP.OP_IF, T.OP.OP_2, C.pub, S.pub, T.OP.OP_2, T.OP.OP_CHECKMULTISIG,
    T.OP.OP_ELSE, BigInt(refundHeight + 1), T.OP.OP_CHECKLOCKTIMEVERIFY, T.OP.OP_DROP, C.pub, T.OP.OP_CHECKSIG,
    T.OP.OP_ENDIF,
  ]);
  const channel2Addr = T.encodeAddress(NET, "p2sh", T.hash160(channel2));

  let v = 100_000_000n;
  const nextValue = (): bigint => (v += 1_234_567n);
  const targets: { address: string; value: bigint }[] = [];
  for (const ks of caseKeys) for (const k of ks) targets.push({ address: k.address, value: nextValue() });
  for (const k of mixedKeys) targets.push({ address: k.address, value: nextValue() });
  targets.push({ address: opretKey.address, value: nextValue() });
  targets.push({ address: channelAddr, value: 50_000_000n });
  targets.push({ address: channel2Addr, value: 25_000_000n });
  const coinsAll = await fund(targets);
  let ci = 0;

  for (const [ti, [name, ht, , nout]] of typeCases.entries()) {
    const inputs: CaseInput[] = caseKeys[ti]!.map((k) => ({ coin: coinsAll[ci++]!, kind: "p2pkh" as const, hashType: ht, keys: [k] }));
    const total = inputs.reduce((a, i) => a + i.coin.value, 0n);
    await runCase(name, inputs, outputsFor(total, nout, inputs));
  }
  {
    const types = [0x01, 0x02, 0x83];
    const inputs: CaseInput[] = mixedKeys.map((k, i) => ({ coin: coinsAll[ci++]!, kind: "p2pkh" as const, hashType: types[i]!, keys: [k] }));
    const total = inputs.reduce((a, i) => a + i.coin.value, 0n);
    await runCase("p2pkh-mixed-all-none-singleacp-3in-3out", inputs, outputsFor(total, 3, inputs));
  }
  {
    const inputs: CaseInput[] = [{ coin: coinsAll[ci++]!, kind: "p2pkh", hashType: 0x01, keys: [opretKey] }];
    const total = inputs[0]!.coin.value;
    const memo = T.opReturnScript(new TextEncoder().encode("x402-ycash vector: OP_RETURN and expiry"));
    const height: number = await rpc("getblockcount");
    await runCase("p2pkh-opreturn-expiry", inputs, outputsFor(total, 2, inputs, [memo]), { expiryHeight: height + 20 });
  }
  const chanCoin = coinsAll[ci++]!;
  const chan2Coin = coinsAll[ci++]!;
  {
    // Channel close: the multisig branch, a voucher paying the server and the client's change.
    const inputs: CaseInput[] = [{ coin: chanCoin, kind: "p2sh-channel-close", hashType: 0x01, keys: [C, S], redeemScript: channel }];
    const skel = T.newTx({ vin: [{ prevout: chanCoin, scriptSig: new Uint8Array(300), sequence: 0 }], vout: [
      { value: 0n, scriptPubKey: T.p2pkhScript(S.pkh) }, { value: 0n, scriptPubKey: T.p2pkhScript(C.pkh) }] });
    const fee = T.feeFloor(skel);
    await runCase("p2sh-channel-close", inputs, [
      { value: 12_345_678n, scriptPubKey: T.p2pkhScript(S.pkh) },
      { value: chanCoin.value - 12_345_678n - fee, scriptPubKey: T.p2pkhScript(C.pkh) },
    ]);
  }
  // Channel refund: the CLTV branch, after t. The tx is final once nLockTime < next block height.
  const t2 = refundHeight + 1;
  // Negative cases first: a refund before t must be refused, both while non-final (nLockTime = t)
  // and when final but with nLockTime < t (the CLTV check itself fails).
  const negatives: { name: string; signedHex: string; error: string }[] = [];
  const tipNow: number = await rpc("getblockcount");
  for (const [nname, lockTime] of [["refund-before-t-nonfinal", t2], ["refund-locktime-below-t", tipNow]] as const) {
    const tx = T.newTx({ vin: [{ prevout: chan2Coin, scriptSig: new Uint8Array(), sequence: 0xfffffffe }],
      vout: [{ value: chan2Coin.value - 2000n, scriptPubKey: T.p2pkhScript(C.pkh) }], lockTime });
    const sh = T.sighashV4(tx, 0, channel2, chan2Coin.value, T.SIGHASH.ALL, branchId);
    tx.vin[0]!.scriptSig = T.p2shScriptSig([T.signInput(sh, C.priv), T.OP.OP_0], channel2);
    const hex = T.serializeTxHex(tx);
    try {
      await rpc("sendrawtransaction", hex);
      throw new Error(`${nname}: accepted, expected a refusal`);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("expected a refusal")) throw e;
      console.log(`  ${nname}: refused (${msg})`);
      negatives.push({ name: nname, signedHex: hex, error: msg });
    }
  }
  for (;;) {
    const h: number = await rpc("getblockcount");
    if (h >= t2) break;
    await rpc("generate", 1);
  }
  {
    const inputs: CaseInput[] = [{ coin: chan2Coin, kind: "p2sh-channel-refund", hashType: 0x01, keys: [C], redeemScript: channel2 }];
    const skel = T.newTx({ vin: [{ prevout: chan2Coin, scriptSig: new Uint8Array(200), sequence: 0 }], vout: [{ value: 0n, scriptPubKey: T.p2pkhScript(C.pkh) }] });
    await runCase("p2sh-channel-refund-cltv", inputs, [{ value: chan2Coin.value - T.feeFloor(skel), scriptPubKey: T.p2pkhScript(C.pkh) }], {
      lockTime: t2, sequence: 0xfffffffe,
    });
  }

  // Past the Vault upgrade (branch 6d5b7a31, after Canopy), also show the node refusing the same
  // spend signed under the previous branch: the stock verifier fails it and relay refuses it.
  let wrongBranch: {
    name: string; branchId: string; prevout: { txid: string; vout: number; scriptPubKey: string; value: string };
    signedHex: string; sighash: string; verifyComplete: boolean; error: string;
  } | undefined;
  if (branchId === VAULT) {
    const K = nextKey();
    const [coin] = await fund([{ address: K.address, value: 1_000_000n }]);
    const tx = T.newTx({ vin: [{ prevout: { txid: coin!.txid, vout: coin!.vout }, scriptSig: new Uint8Array(), sequence: T.SEQUENCE_FINAL }],
      vout: [{ value: coin!.value - 1000n, scriptPubKey: T.p2pkhScript(K.pkh) }] });
    const sh = T.sighashV4(tx, 0, coin!.scriptPubKey, coin!.value, T.SIGHASH.ALL, CANOPY);
    tx.vin[0]!.scriptSig = T.p2pkhScriptSig(T.signInput(sh, K.priv), K.pub);
    const hex = T.serializeTxHex(tx);
    const verify = await rpc("signrawtransaction", hex, [], []);
    let error = "";
    try {
      await rpc("sendrawtransaction", hex);
    } catch (e) {
      error = (e as Error).message;
    }
    if (verify.complete === true || !error) throw new Error(`a Canopy-signed spend past Vault was not refused (${JSON.stringify(verify)}, ${error})`);
    console.log(`  p2pkh-signed-canopy-after-vault: refused (${error})`);
    wrongBranch = {
      name: "p2pkh-signed-canopy-after-vault", branchId: CANOPY.toString(16),
      prevout: { txid: coin!.txid, vout: coin!.vout, scriptPubKey: T.bytesToHex(coin!.scriptPubKey), value: coin!.value.toString() },
      signedHex: hex, sighash: T.bytesToHex(sh), verifyComplete: verify.complete === true, error,
    };
  }

  // Mine and confirm every case made it into a block (its output 0 is unspent and confirmed).
  await rpc("generate", 1);
  for (const vec of vectors) {
    const out = await rpc("gettxout", vec.txid, 0, false);
    vec.mined = out !== null && out.confirmations >= 1;
  }
  if (vectors.some((x) => !x.mined)) throw new Error("not every case was mined");

  const out = join(dirname(fileURLToPath(import.meta.url)), `${line}.json`);
  writeFileSync(out, JSON.stringify({
    description: "src/tx vectors generated against a regtest node; see vectors/tx/generate.ts",
    line, subversion: network.subversion, network: NET, branchId: branchHex, cases: vectors, negatives,
    ...(wrongBranch ? { wrongBranch } : {}),
  }, null, 1) + "\n");
  console.log(`wrote ${vectors.length} cases to ${out}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
