// The kogany leg (workspace kogany plan W9-c, report-only): the `exact` facilitator (the verifier)
// reading a regtest kogany node (koganyd --features ycash, the third node line), and the RPC
// wallet signer against kogany and its ycash6 test rig. Run by scripts/kogany-leg.sh, which starts
// the rig (scripts/kogany-rig.py: kogany, and a ycash6 sidecar `connect=` kogany that holds the
// wallet and mines) and sets X402_KOGANY_JSON to the rig's devnet.json: rpc.0 the sidecar, rpc.1
// kogany. Without it the suite is skipped.
//
// kogany is wallet-less (kogany plan K-3) and serves no `signrawtransaction`, the facilitator's
// script verifier (rule 9): every stack here takes that one call from the sidecar. Two stacks:
//   kogany       everything else from kogany, rule 9Y's yed_validaterawtransaction included;
//   kogany+rig   the Yellowback verdict from the sidecar too (kogany's chain reads, mempool and
//                confirmations), so a kogany gap in rule 9Y does not hide the rest.
// The RPC wallet signer takes its wallet calls from the sidecar and its chain reads from kogany.
import { readFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";
import { exact } from "../../src/index.js";
import { RpcError, YcashRpc } from "../../src/node/index.js";
import { InMemorySettlementStore } from "../../src/store/index.js";
import { encodeAddress, encodeWif, hash160, pubkeyFromPriv, randomPrivKey, txid as txidOf } from "../../src/tx/index.js";
import { record, waitFor } from "./harness.js";

const RIG = process.env.X402_KOGANY_JSON;
const describeKogany: typeof describe = (RIG ? describe : describe.skip) as typeof describe;
const NETWORK = "ycash:regtest" as const;
const AMOUNT = 250_000n; // 0.0025 YEC
const LINE = "kogany";

let sidecar: YcashRpc;
let kogany: YcashRpc;
let merchant: string;

/**
 * Mines n blocks on the sidecar once its mempool holds `txids`, then waits for kogany at the same tip
 * and for the sidecar's wallet to see every `txids` confirmed (it hears of a block asynchronously).
 */
async function mine(n: number, txids: string[] = []): Promise<void> {
  const since = Date.now();
  let handed = false;
  await waitFor(async () => {
    const pool = await sidecar.getRawMempool();
    const missing = txids.filter((t) => !pool.includes(t));
    if (missing.length > 0 && !handed && Date.now() - since > 30_000) {
      // kogany did not relay within 30 s: hand them over, and say so (a relay miss is a finding)
      handed = true;
      for (const t of missing) {
        record(LINE, "kogany -> sidecar relay miss after 30 s, handed over", t);
        const hex = await kogany.call<string>("getrawtransaction", [t]).catch(() => undefined);
        if (hex) await sidecar.sendRawTransaction(hex).catch(() => undefined);
      }
    }
    return missing.length === 0;
  }, { timeoutMs: 120_000, what: `${txids.join(",")} in the sidecar's mempool` });
  const hashes = await sidecar.generate(n);
  const tip = hashes[hashes.length - 1];
  await waitFor(async () => (await kogany.call<string>("getbestblockhash")) === tip, { timeoutMs: 120_000, what: `kogany at ${tip}` });
  for (const t of txids) {
    await waitFor(async () => {
      try {
        return (await sidecar.call<{ confirmations: number }>("gettransaction", [t, true])).confirmations > 0;
      } catch {
        return false;
      }
    }, { what: `the sidecar's wallet to see ${t} confirmed` });
  }
}

type Rpc = exact.ExactFacilitatorRpc & { yedGetInfo: YcashRpc["yedGetInfo"] };

/** The facilitator's RPC: kogany, but for the calls `verdicts` names, taken from the sidecar. */
function facilitatorRpc(verdicts: "kogany" | "rig"): Rpc {
  const yed = verdicts === "kogany" ? kogany : sidecar;
  return {
    getBlockchainInfo: () => kogany.getBlockchainInfo(),
    getBlockCount: () => kogany.getBlockCount(),
    getTxOut: (txid, n, mempool) => kogany.getTxOut(txid, n, mempool),
    sendRawTransaction: (hex, high) => kogany.sendRawTransaction(hex, high),
    capabilities: () => kogany.capabilities(),
    yedDecodePayload: (hex) => kogany.yedDecodePayload(hex),
    yedGetInfo: () => kogany.yedGetInfo(),
    verifyScripts: (hex) => sidecar.verifyScripts(hex),
    yedValidateRawTransaction: (hex) => yed.yedValidateRawTransaction(hex),
  };
}

interface Stack {
  server: x402ResourceServer;
}

async function makeStack(rpc: Rpc): Promise<Stack> {
  const scheme = new exact.ExactYcashFacilitatorScheme(rpc, { settlementStore: new InMemorySettlementStore(), confirmationTimeoutMs: 120_000, confirmationPollMs: 250 });
  const facilitator = new x402Facilitator().register(NETWORK, scheme);
  const client = {
    verify: (p: PaymentPayload, r: PaymentRequirements) => facilitator.verify(p, r),
    settle: (p: PaymentPayload, r: PaymentRequirements) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
  const server = new x402ResourceServer(client).register(NETWORK, new exact.ExactYcashServerScheme({}));
  await server.initialize();
  return { server };
}

async function requirementsFor(s: Stack, confirmations: number): Promise<PaymentRequirements> {
  const [req] = await s.server.buildPaymentRequirements({
    scheme: "exact", network: NETWORK, payTo: merchant, price: { amount: AMOUNT.toString(), asset: "YEC" }, maxTimeoutSeconds: 300,
    extra: { confirmationPolicy: { confirmations } },
  });
  return req as PaymentRequirements;
}

/** A local-key payer whose coins the sidecar's wallet watches (RpcUtxoSource lists them there). */
async function localPayer(): Promise<x402Client> {
  const priv = randomPrivKey();
  const address = encodeAddress(NETWORK, "p2pkh", hash160(pubkeyFromPriv(priv)));
  const signer = new exact.LocalKeySigner(encodeWif(priv, NETWORK), new exact.RpcUtxoSource(sidecar, { importAddress: true }));
  await sidecar.call("importaddress", [address, "", false]);
  const funding = [];
  for (let i = 0; i < 4; i++) funding.push(await sidecar.sendToAddress(address, 10_000_000n));
  await mine(1, funding);
  const client = new x402Client().register(NETWORK, new exact.ExactYcashScheme(signer));
  client.setSpendControls({ allowedAssets: [exact.yecSpendControl(NETWORK, 10_000_000n)] });
  return client;
}

/** The RPC wallet signer: wallet calls on the sidecar, chain reads (gettxout, getblockchaininfo) on kogany. */
function rigWalletSigner(): exact.RpcWalletSigner {
  const rpc: exact.RpcWalletSignerRpc = {
    getBlockchainInfo: () => kogany.getBlockchainInfo(),
    getTxOut: (txid, n, mempool) => kogany.getTxOut(txid, n, mempool),
    listUnspent: (...a) => sidecar.listUnspent(...a),
    createRawTransaction: (...a) => sidecar.createRawTransaction(...a),
    signRawTransactionWithWallet: (...a) => sidecar.signRawTransactionWithWallet(...a),
    capabilities: () => kogany.capabilities(),
    call: <T>(method: string, params?: readonly unknown[]) => sidecar.call<T>(method, params),
  };
  return new exact.RpcWalletSigner(rpc);
}

/** 402 -> payload -> verify -> settle, mining once the payment reached the sidecar when it must confirm. */
async function pay(s: Stack, client: x402Client, confirmations: number) {
  const req = await requirementsFor(s, confirmations);
  const pl = await client.createPaymentPayload(await s.server.createPaymentRequiredResponse([req], { url: "https://merchant.test/resource" }));
  const id = txidOf((pl.payload as { transaction: string }).transaction);
  const v = await s.server.verifyPayment(pl, req);
  if (!v.isValid) return { id, v };
  const settling = s.server.settlePayment(pl, req);
  if (confirmations >= 0) {
    // a settlement that fails (the node refused the transaction) ends the wait for the mempool
    const failed = settling.then((r) => (r.success ? new Promise<never>(() => undefined) : r), (e: unknown) => e);
    const early = await Promise.race([mine(1, [id]).then(() => undefined), failed]);
    if (early !== undefined) return { id, v, settled: (await settling.catch((e: unknown) => ({ success: false, errorReason: String(e) }))) as SettleResponse };
  }
  const settled = await settling;
  if (confirmations < 0) await mine(1, [id]);
  return { id, v, settled };
}

describeKogany("x402 exact against kogany and its ycash6 test rig", () => {
  beforeAll(async () => {
    sidecar = YcashRpc.fromDevnetJson(RIG as string, 0, { timeoutMs: 120_000 });
    kogany = YcashRpc.fromDevnetJson(RIG as string, 1, { timeoutMs: 120_000 });
    const rig = JSON.parse(readFileSync(RIG as string, "utf8")) as { rpc: Record<string, { role: string }> };
    expect([rig.rpc["0"]?.role, rig.rpc["1"]?.role]).toEqual(["sidecar", "kogany"]);
    merchant = await sidecar.getNewAddress();
  });

  it("kogany: a Yellowback node on regtest, with no script verifier of its own", async () => {
    const caps = await kogany.capabilities();
    expect(caps).toMatchObject({ yellowback: true, chain: "regtest" });
    expect(caps.subversion).toMatch(/^\/koganyd:/);
    record(LINE, "kogany capabilities", caps);
    const raw = await sidecar.call<string>("createrawtransaction", [[], {}]);
    const err = await kogany.verifyScripts(raw).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    record(LINE, "signrawtransaction (rule 9's verifier) on kogany", (err as RpcError).message);
  });

  for (const verdicts of ["rig", "kogany"] as const) {
    const name = verdicts === "rig" ? "kogany+rig" : "kogany";
    it(`[${name}] exact YEC from a local key, settled at 1 and at -1 through kogany`, async () => {
      const s = await makeStack(facilitatorRpc(verdicts));
      const payer = await localPayer();
      for (const c of [1, -1]) {
        const r = await pay(s, payer, c);
        expect(r.v.isValid, `verify at ${c}: ${JSON.stringify(r.v)}`).toBe(true);
        expect(r.settled, JSON.stringify(r.settled)).toMatchObject({ success: true, transaction: r.id, network: NETWORK });
        expect(r.settled?.extra).toEqual(c < 0 ? { status: "mempool", confirmations: -1 } : { status: "confirmed", confirmations: 1 });
        const out = await kogany.getTxOut(r.id, 0, false);
        expect(out?.confirmations, "kogany sees the payment confirmed").toBeGreaterThanOrEqual(1);
      }
      record(LINE, `exact YEC, facilitator ${name}`, "settled at 1 and -1");
    });

    it(`[${name}] the RPC wallet signer (sidecar wallet, kogany reads) pays`, async () => {
      const s = await makeStack(facilitatorRpc(verdicts));
      // the signer spends no coinbase: give the wallet two plain coins
      const funding = [];
      for (let i = 0; i < 2; i++) funding.push(await sidecar.sendToAddress(await sidecar.getNewAddress(), 50_000_000n));
      await mine(1, funding);
      const client = new x402Client().register(NETWORK, new exact.ExactYcashScheme(rigWalletSigner()));
      client.setSpendControls({ allowedAssets: [exact.yecSpendControl(NETWORK, 10_000_000n)] });
      const r = await pay(s, client, 1);
      expect(r.v.isValid, JSON.stringify(r.v)).toBe(true);
      expect(r.settled, JSON.stringify(r.settled)).toMatchObject({ success: true, transaction: r.id });
      record(LINE, `RpcWalletSigner, facilitator ${name}`, r.settled?.extra);
    });
  }
});
