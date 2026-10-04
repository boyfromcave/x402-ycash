// The recommended private-payment merchant setup, rehearsed end to end on a live devnet of either line
// (docs/x4m-measurements.md, verdict (ii); docs/mainnet-runbook.md, "Private payments"):
//
// - node A holds the merchant's one dedicated Sapling key and is kept offline: started once to make
//   the key and export its viewing key, then stopped;
// - node B, the settlement node (devnet node 1, stock), holds only that viewing key (z_importviewingkey);
// - the merchant server issues every address offline from the viewing key (no node, no spending key),
//   from index 2^40;
// - the self-hosted facilitator settles on node B and signs JWS receipts;
// - an agent pays P1 (z→z) and P0 (t→z); the receipts verify;
// - node A comes back, catches up, and spends the notes at the offline addresses: the funds are real.
//
//   scripts/devnet.sh up dd 291 && X402_DEVNET_JSON=…/dd-291/devnet.json \
//     npx vitest run --dir test/devnet viewkey -w x402-ycash-example-merchant-express
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { shielded, tx, verifyReceipt, YcashRpc, type DecodedTransaction, type ZSendManyOptions } from "x402-ycash-mechanism";
import { DEVNET_JSON, describeDevnet, devnet, record, waitFor, type Devnet } from "../../../../packages/ycash/test/devnet/harness.js";
import { runAgent, startService, type Proc } from "./procs.js";

const NETWORK = "ycash:regtest";
const PRICE = 1_500_000n;

interface PaidLine {
  i: number;
  status: number;
  ms: number;
  settlement?: { success: boolean; transaction: string; extra?: Record<string, unknown>; extensions?: Record<string, unknown> };
  body: unknown;
}

/**
 * Node A: a ycashd of the devnet's own binary, with node 1's consensus flags, its own datadir and
 * ports, connected to node 0 only. The devnet CLI cannot stop and start one node, so it runs here.
 */
class OfflineNode {
  readonly rpc: YcashRpc;
  private child: ChildProcess | undefined;
  private readonly args: string[];

  constructor(
    private readonly bin: string,
    private readonly datadir: string,
    devnetDir: string,
    rpcPort: number,
    p2pPort: number,
  ) {
    // Node 1's command line (stock: no -yellowback), with this node's datadir and no zmq.
    const ps = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" }).split("\n");
    const node1 = ps.find((l) => l.includes(`-datadir=${devnetDir}/node1 `) || l.endsWith(`-datadir=${devnetDir}/node1`));
    if (!node1) throw new Error("devnet node 1 is not running");
    const flags = node1.split(/\s+/).slice(1).filter((a) => a.startsWith("-") && !a.startsWith("-datadir=") && !a.startsWith("-zmq"));
    const conf = readFileSync(join(devnetDir, "node0", confName(devnetDir)), "utf8");
    const node0Port = Number(/^port=(\d+)$/m.exec(conf)?.[1]);
    mkdirSync(datadir, { recursive: true });
    const user = "nodeA";
    const password = "rehearse-" + tx.bytesToHex(tx.randomPrivKey()).slice(0, 16);
    writeFileSync(join(datadir, confName(devnetDir)), `regtest=1\nrpcuser=${user}\nrpcpassword=${password}\nport=${p2pPort}\nrpcport=${rpcPort}\nlistenonion=0\n`);
    this.args = [`-datadir=${datadir}`, ...flags, `-connect=127.0.0.1:${node0Port}`, "-listen=0"];
    this.rpc = new YcashRpc({ url: `http://127.0.0.1:${rpcPort}`, user, password });
  }

  async start(): Promise<void> {
    this.child = spawn(this.bin, this.args, { stdio: "ignore" });
    await waitFor(async () => (await this.rpc.getBlockCount().catch(() => -1)) >= 0, { timeoutMs: 120_000, what: `node A (${this.datadir}) to answer RPC` });
  }

  async stop(): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    const exited = new Promise<void>((r) => c.once("exit", () => r()));
    await this.rpc.call("stop").catch(() => c.kill("SIGTERM"));
    await exited;
    this.child = undefined;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }
}

/** v4.5.0's devnet writes ycash.conf; 6.21.0's may write zcash.conf. */
function confName(devnetDir: string): string {
  for (const n of ["ycash.conf", "zcash.conf"]) {
    try {
      readFileSync(join(devnetDir, "node0", n));
      return n;
    } catch {
      /* next */
    }
  }
  throw new Error(`no node conf in ${devnetDir}/node0`);
}

describeDevnet("the viewing-key merchant: offline issuer, viewing-key settlement node, offline spending key", () => {
  let d: Devnet;
  let dir: string;
  let nodeA: OfflineNode;
  let viewingKey: string;
  let baseAddress: string;
  let receiptPub: Uint8Array;
  let shop: Proc & { url: string };
  let zFrom: string;
  let tFrom: string;
  const procs: Proc[] = [];
  const paid: { tier: string; txid: string; payTo: string }[] = [];
  const devnetJson = DEVNET_JSON as string;

  async function agent(url: string, extra: Record<string, string>): Promise<PaidLine[]> {
    const p = runAgent({ X402_NETWORK: NETWORK, RESOURCE_URL: url, AGENT_DEVNET_JSON: devnetJson, AGENT_RESERVATIONS: join(dir, "agent-reservations.json"), MAX_PAYMENT_ZAT: "5000000", ...extra });
    procs.push(p);
    const code = await p.exited;
    if (code !== 0) throw new Error(`agent exited ${code}: ${p.stderr.join("")} ${JSON.stringify(p.lines.slice(-3))}`);
    return p.lines.filter((l) => typeof l.i === "number") as unknown as PaidLine[];
  }

  beforeAll(async () => {
    d = await devnet();
    dir = mkdtempSync(join(tmpdir(), "x402-viewkey-"));
    const state = JSON.parse(readFileSync(devnetJson, "utf8")) as { dir: string; bitcoind: string; rpc: Record<string, { port: number }> };
    const rpc0 = state.rpc["0"]!.port;
    nodeA = new OfflineNode(state.bitcoind, join(state.dir, "nodeA"), state.dir, rpc0 + 40, rpc0 - 5000 + 40);

    // 1. Node A: the merchant's one dedicated Sapling key; its viewing key leaves, then A goes offline.
    await nodeA.start();
    baseAddress = await nodeA.rpc.zGetNewAddress();
    viewingKey = await nodeA.rpc.call<string>("z_exportviewingkey", [baseAddress]);
    await nodeA.stop();

    // 2. Node B (node 1, stock) imports only the viewing key. The key is new: no rescan.
    const imported = await d.stock.call<{ type: string; address: string }>("z_importviewingkey", [viewingKey, "no"]);
    expect(imported).toMatchObject({ type: "sapling", address: baseAddress });

    // 3. The facilitator on node B, offline-issuer config (startup checks node B holds the key).
    const receiptKey = tx.randomPrivKey();
    receiptPub = tx.pubkeyFromPriv(receiptKey);
    const registry = join(dir, "issued.json");
    const fac = await startService("facilitator", {
      X402_NETWORK: NETWORK,
      X402_DEVNET_JSON: devnetJson,
      X402_DEVNET_NODE: "1",
      X402_PORT: "0",
      X402_SETTLEMENT_STORE: join(dir, "settlements.json"),
      X402_CHANNEL_STORE: join(dir, "fac-channels.json"),
      X402_CONFIRMATIONS_MIN: "-1",
      X402_RECEIPT_KEY: tx.bytesToHex(receiptKey),
      X402_ISSUED_REGISTRY: registry,
      X402_SAPLING_ISSUER: "offline",
      X402_SAPLING_VIEWING_KEY: viewingKey,
    });
    procs.push(fac);
    // 4. The merchant: no node at all; shielded addresses come from the viewing key.
    shop = await startService("merchant", {
      X402_NETWORK: NETWORK,
      PORT: "0",
      FACILITATOR_URL: fac.url,
      MERCHANT_PAY_TO: await d.stock.getNewAddress(),
      MERCHANT_ISSUED_REGISTRY: registry,
      MERCHANT_SHIELDED_CONFIRMATIONS: "-1",
      MERCHANT_SAPLING_ISSUER: "offline",
      MERCHANT_SAPLING_VIEWING_KEY: viewingKey,
      MERCHANT_SAPLING_INDEX_FILE: join(dir, "sapling-index.json"),
    });
    procs.push(shop);

    // 5. The payer (node 2's wallet): transparent coins (P0) and a Sapling note (P1).
    tFrom = await d.pool.getNewAddress();
    for (let i = 0; i < 3; i++) await d.fund(tFrom, 100_000_000n);
    await d.mine(1);
    zFrom = await d.pool.zGetNewAddress();
    const tOpts: ZSendManyOptions = d.line === "v6" ? { minconf: 1, privacyPolicy: "AllowFullyTransparent" } : { minconf: 1 };
    await d.pool.zSendManyAndWait(tFrom, [{ address: zFrom, amount: 50_000_000n }], tOpts);
    await d.mine(1);
    await waitFor(async () => (await d.pool.zListReceivedByAddress(zFrom, 1)).length > 0, { what: "the payer's Sapling note" });
    record(d.line, "viewkey setup", { baseAddress, facilitator: fac.url, merchant: shop.url });
  });

  afterAll(async () => {
    await Promise.all(procs.map((p) => p.stop()));
    // The services' JSON logs, for a failed run.
    procs.forEach((p, i) => writeFileSync(join(dir, `${i}-${p.name}.log`), [...p.lines.map((l) => JSON.stringify(l)), ...p.stderr].join("\n")));
    console.log(`viewkey logs: ${dir}`);
    await nodeA?.stop();
  });

  it("node B holds the viewing key only: it cannot issue an address, and the base address is not its own", async () => {
    await expect(d.stock.zGetNewDiversifiedAddress(baseAddress)).rejects.toThrow(/spending key|private zkey/);
    const v = await d.stock.call<{ isvalid: boolean; ismine: boolean }>("z_validateaddress", [baseAddress]);
    record(d.line, "viewkey node B z_validateaddress(base)", v);
    expect(v.ismine).toBe(false);
  });

  for (const tier of ["P1", "P0"] as const) {
    it(`an agent pays ${tier} to an offline-issued address; node B settles it with a verifiable receipt`, async () => {
      const [r] = await agent(`${shop.url}/shielded/report`, { AGENT_DEVNET_NODE: "2", AGENT_SIGNER: "node", AGENT_SHIELDED_FROM: tier === "P1" ? zFrom : tFrom });
      expect(r).toMatchObject({ status: 200, body: { paidWith: "exact/sapling-proof" }, settlement: { success: true, extra: { status: "mempool", receivedZat: PRICE.toString() } } });
      const txid = r!.settlement!.transaction;
      const receipt = (r!.settlement!.extensions as { "offer-receipt": { info: { receipt: Parameters<typeof verifyReceipt>[0] } } })["offer-receipt"].info.receipt;
      expect(verifyReceipt(receipt, { trustedPublicKeys: [receiptPub] })).toMatchObject({ network: NETWORK, resourceUrl: `${shop.url}/shielded/report`, payer: "anonymous", transaction: txid });

      // The address was derived offline, at the next valid index from 2^40: re-derive it independently.
      const view = await d.stock.call<{ outputs: { address?: string }[] }>("z_viewtransaction", [txid]);
      const payTo = view.outputs.map((o) => o.address).find((a) => a !== undefined && a !== zFrom) as string;
      const key = shielded.decodeSaplingViewingKey(viewingKey, NETWORK);
      let j = shielded.OFFLINE_ISSUER_DEFAULT_START;
      let want = shielded.findSaplingAddress(key, j);
      for (let k = 0; k < paid.length; k++) want = shielded.findSaplingAddress(key, (j = want.index + 1n));
      expect(payTo).toBe(want.address);
      const shape = await d.stock.call<DecodedTransaction>("getrawtransaction", [txid, 1]);
      expect(shape.vin.length > 0).toBe(tier === "P0"); // P0 reveals the payer's coins; P1 nothing transparent
      paid.push({ tier, txid, payTo });
      record(d.line, `viewkey ${tier}`, { ms: r!.ms, txid, payTo, receiptVerified: true, transparentInputs: shape.vin.length });
    });
  }

  it("node A comes back, catches up, and spends the notes at the offline addresses", async () => {
    expect(paid.map((p) => p.tier)).toEqual(["P1", "P0"]);
    await d.mine(1, d.stock);
    await nodeA.start();
    const tip = await d.tip();
    await waitFor(async () => (await nodeA.rpc.getBlockCount()) >= tip, { timeoutMs: 120_000, what: "node A at the tip" });
    for (const p of paid) {
      // Node A never issued the address either: it is refused (-5) until the wallet decrypts a note to it.
      const seen = async () => (await nodeA.rpc.zListReceivedByAddress(p.payTo, 1).catch(() => [])).some((n) => n.txid === p.txid);
      await waitFor(seen, { timeoutMs: 60_000, what: `node A to see ${p.txid} at ${p.payTo}` });
    }
    const sweepTo = await d.wallet.getNewAddress();
    const opts: ZSendManyOptions = d.line === "v6" ? { minconf: 1, privacyPolicy: "AllowRevealedRecipients" } : { minconf: 1 };
    const sweeps: string[] = [];
    for (const p of paid) sweeps.push(await nodeA.rpc.zSendManyAndWait(p.payTo, [{ address: sweepTo, amount: PRICE - 20_000n }], { ...opts, fee: 10_000n }));
    await waitFor(async () => (await d.wallet.getRawMempool()).length >= sweeps.length, { timeoutMs: 60_000, what: "node A's sweeps in node 0's mempool" }).catch(() => undefined);
    await d.mine(1, d.stock);
    const got = BigInt(Math.round((await d.wallet.call<number>("getreceivedbyaddress", [sweepTo, 1])) * 1e8));
    expect(got).toBe(2n * (PRICE - 20_000n));
    // Node B, holding only the viewing key, cannot spend them.
    const refused = await d.stock.zSendMany(paid[0]!.payTo, [{ address: sweepTo, amount: 1000n }], opts).then(
      async (opid) => d.stock.waitForOperation(opid).then(() => "spent!", (e: Error) => e.message),
      (e: Error) => e.message,
    );
    expect(refused).not.toBe("spent!");
    await nodeA.stop();
    record(d.line, "viewkey node A spend", { sweeps, sweptZat: got.toString(), nodeBRefusal: refused });
  });
});
