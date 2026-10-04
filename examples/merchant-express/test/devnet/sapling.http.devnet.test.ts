// The `sapling` method end to end on a live devnet of either line (plan X4b), facilitator side, on real
// node-built Sapling transactions, ahead of the Rust light client:
//
// - the merchant's key: made on node 0, its viewing key imported into node 1 (stock), which is the
//   self-hosted facilitator's node; the merchant server issues addresses offline from the viewing key;
// - the facilitator serves `sapling-proof` and `sapling` (X402_SHIELDED_METHODS) and lists both;
// - the payer: a side node run with `-walletbroadcast=0 -txexpirydelta=14`, whose z_sendmany signs and
//   commits without relaying (plan Z-1). TEST ONLY: the flag is node-wide, so it stands in for the
//   Rust client's `build` behind the builder contract (zsendmanyBuilder.ts); -txexpirydelta=14 makes
//   its nExpiryHeight tip + 1 + 14, exactly the spec's tip + 3 + ⌈900/75⌉;
// - the agent pays /shielded/private-report P0 (t→z) and P2 (z→z) through AGENT_SAPLING_BUILDER:
//   merchant → facilitator /verify → handler → /settle (broadcast) → receipt;
// - then the facilitator's HTTP surface directly: /verify read-only and repeatable, /settle broadcasts
//   once, a repeat /verify is duplicate_settlement and a repeat /settle only observes; a transaction
//   presented for another request's address is refused (rule 5).
//
//   scripts/devnet.sh up dd 341 && X402_DEVNET_JSON=…/dd-341/devnet.json \
//     npx vitest run --dir test/devnet sapling.http -w x402-ycash-example-merchant-express
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, expect, it } from "vitest";
import { shielded, tx, verifyReceipt, YcashRpc, type DecodedTransaction } from "x402-ycash-mechanism";
import { DEVNET_JSON, describeDevnet, devnet, record, waitFor, type Devnet } from "../../../../packages/ycash/test/devnet/harness.js";
import { PACKAGES, REPO, runAgent, SideNode, startService, type Proc } from "./procs.js";

const NETWORK = "ycash:regtest";
const PRICE = 1_500_000n;
const BUILDER = `${join(REPO, "node_modules/.bin/tsx")} ${join(PACKAGES.merchant, "test/devnet/zsendmanyBuilder.ts")}`;

interface PaidLine {
  i: number;
  status: number;
  settlement?: { success: boolean; transaction: string; errorReason?: string; extra?: Record<string, unknown>; extensions?: Record<string, unknown> };
  body: unknown;
}

describeDevnet("sapling end to end: node-built transactions through the facilitator's verify → resource → settle", () => {
  let d: Devnet;
  let dir: string;
  let payer: SideNode;
  let payerRpc: YcashRpc;
  let fac: Proc & { url: string };
  let shop: Proc & { url: string };
  let receiptPub: Uint8Array;
  let tFrom: string;
  let tDirect: string;
  let tProbe: string;
  let zFrom: string;
  const procs: Proc[] = [];
  const devnetJson = DEVNET_JSON as string;

  const builderEnv = (from: string): Record<string, string> => ({
    BUILDER_RPC_URL: payer.url,
    BUILDER_RPC_USER: payer.user,
    BUILDER_RPC_PASSWORD: payer.password,
    BUILDER_FROM: from,
    BUILDER_LINE: d.line,
  });

  /** A payer transaction the wallet committed but never relayed: relay it ourselves (funding only). */
  const relay = async (txid: string): Promise<void> => {
    const { hex } = await payerRpc.call<{ hex: string }>("gettransaction", [txid]);
    await payerRpc.sendRawTransaction(hex);
  };

  async function agent(from: string): Promise<PaidLine> {
    const p = runAgent({
      X402_NETWORK: NETWORK,
      RESOURCE_URL: `${shop.url}/shielded/private-report`,
      AGENT_DEVNET_JSON: devnetJson,
      AGENT_DEVNET_NODE: "1",
      AGENT_SIGNER: "node",
      AGENT_RESERVATIONS: join(dir, "agent-reservations.json"),
      AGENT_SAPLING_BUILDER: BUILDER,
      MAX_PAYMENT_ZAT: "5000000",
      ...builderEnv(from),
    });
    procs.push(p);
    const code = await p.exited;
    if (code !== 0) throw new Error(`agent exited ${code}: ${p.stderr.join("")} ${JSON.stringify(p.lines.slice(-3))}`);
    return p.lines.find((l) => typeof l.i === "number") as unknown as PaidLine;
  }

  /** A fresh 402 of the sapling route: the issued requirements, as the agent would see them. */
  async function offer(): Promise<{ req: PaymentRequirements; resource: unknown }> {
    const res = await fetch(`${shop.url}/shielded/private-report`);
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") as string);
    return { req: pr.accepts[0] as PaymentRequirements, resource: pr.resource };
  }

  const post = async (op: "verify" | "settle", req: PaymentRequirements, resource: unknown, hex: string) =>
    (await (
      await fetch(`${fac.url}/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2, resource, accepted: req, payload: { transaction: hex } }, paymentRequirements: req }),
      })
    ).json()) as Record<string, unknown>;

  beforeAll(async () => {
    d = await devnet();
    dir = mkdtempSync(join(tmpdir(), "x402-sapling-e2e-"));
    const state = JSON.parse(readFileSync(devnetJson, "utf8")) as { dir: string; bitcoind: string; rpc: Record<string, { port: number }> };
    const rpc0 = state.rpc["0"]!.port;

    // The payer: a wallet that signs and commits but never relays (test only, see the header).
    payer = new SideNode(state.bitcoind, join(state.dir, "payerP"), state.dir, rpc0 + 41, rpc0 - 5000 + 41, ["-walletbroadcast=0", "-txexpirydelta=14"]);
    payerRpc = new YcashRpc({ url: payer.url, user: payer.user, password: payer.password, timeoutMs: 120_000 });
    await payer.start(async () => (await payerRpc.getBlockCount()) >= 0);
    await waitFor(async () => (await payerRpc.getBlockCount()) >= (await d.tip()), { timeoutMs: 120_000, what: "the payer node at the tip" });

    // The merchant's key on node 0; node 1 (the facilitator's node) holds only its viewing key.
    const base = await d.wallet.zGetNewAddress();
    const viewingKey = await d.wallet.call<string>("z_exportviewingkey", [base]);
    await d.stock.call("z_importviewingkey", [viewingKey, "no"]);

    const receiptKey = tx.randomPrivKey();
    receiptPub = tx.pubkeyFromPriv(receiptKey);
    const registry = join(dir, "issued.json");
    fac = await startService("facilitator", {
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
      X402_SHIELDED_METHODS: "sapling-proof,sapling",
    });
    procs.push(fac);
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
      PRICE_PRIVATE_REPORT_ZAT: PRICE.toString(),
    });
    procs.push(shop);

    // Fund the payer: one transparent coin per use (t→z via the agent, t→z direct, the relay probe, the shielding).
    tFrom = await payerRpc.getNewAddress();
    tDirect = await payerRpc.getNewAddress();
    tProbe = await payerRpc.getNewAddress();
    const tShield = await payerRpc.getNewAddress();
    for (const a of [tFrom, tDirect, tProbe, tShield]) await d.fund(a, 100_000_000n);
    await d.mine(1);
    for (const a of [tFrom, tDirect, tProbe, tShield]) await waitFor(async () => (await payerRpc.listUnspent(1, 9_999_999, [a])).length > 0, { what: `the payer's coin at ${a}` });
    // ...and a Sapling note for P2. Its shielding transaction is relayed by hand (the wallet will not).
    zFrom = await payerRpc.zGetNewAddress();
    const shieldTxid = await payerRpc.zSendManyAndWait(tShield, [{ address: zFrom, amount: 50_000_000n }], {
      minconf: 1,
      fee: 2_000n,
      ...(d.line === "v6" ? { privacyPolicy: "AllowFullyTransparent" } : {}),
    });
    await relay(shieldTxid);
    await waitFor(async () => (await d.stock.getRawMempool()).includes(shieldTxid), { what: "the shielding transaction in node 1's mempool" });
    await d.mine(1);
    await waitFor(async () => (await payerRpc.zListReceivedByAddress(zFrom, 1)).length > 0, { what: "the payer's confirmed Sapling note" });

    // The merchant turns the sapling route on once it sees the facilitator list it.
    const supported = (await (await fetch(`${fac.url}/supported`)).json()) as { kinds: { scheme: string; extra?: { assetTransferMethods?: string[] } }[] };
    expect(supported.kinds.find((k) => k.scheme === "exact")?.extra?.assetTransferMethods).toEqual(["transparent", "sapling-proof", "sapling"]);
    await waitFor(async () => (await fetch(`${shop.url}/shielded/private-report`)).status === 402, { timeoutMs: 30_000, pollMs: 1000, what: "the merchant's sapling route" });
    record(d.line, "sapling e2e setup", { facilitator: fac.url, merchant: shop.url, payer: payer.url, tFrom, zFrom });
  });

  afterAll(async () => {
    await Promise.all(procs.map((p) => p.stop()));
    procs.forEach((p, i) => writeFileSync(join(dir, `${i}-${p.name}.log`), [...p.lines.map((l) => JSON.stringify(l)), ...p.stderr].join("\n")));
    console.log(`sapling e2e logs: ${dir}`);
    await payer?.stop();
  });

  it("the payer node does not relay: z_sendmany's transaction stays out of every mempool", async () => {
    const probe = await payerRpc.zSendManyAndWait(tProbe, [{ address: await d.stock.getNewAddress(), amount: 10_000n }], {
      minconf: 1,
      fee: 2_000n,
      ...(d.line === "v6" ? { privacyPolicy: "AllowFullyTransparent" } : {}),
    });
    await new Promise((r) => setTimeout(r, 3000));
    expect(await payerRpc.getRawMempool()).not.toContain(probe);
    expect(await d.stock.getRawMempool()).not.toContain(probe);
    record(d.line, "sapling payer -walletbroadcast=0", { probe, relayed: false });
  });

  for (const tier of ["P0", "P2"] as const) {
    it(`an agent pays ${tier} (${tier === "P0" ? "t→z" : "z→z"}) through the builder: verified before the handler, broadcast after, with a receipt`, async () => {
      const r = await agent(tier === "P0" ? tFrom : zFrom);
      expect(r).toMatchObject({ status: 200, body: { paidWith: "exact/sapling" }, settlement: { success: true, extra: { status: "mempool", receivedZat: PRICE.toString() } } });
      const txid = r.settlement!.transaction;
      const receipt = (r.settlement!.extensions as { "offer-receipt": { info: { receipt: Parameters<typeof verifyReceipt>[0] } } })["offer-receipt"].info.receipt;
      expect(verifyReceipt(receipt, { trustedPublicKeys: [receiptPub] })).toMatchObject({ network: NETWORK, payer: "anonymous", transaction: txid });
      // The facilitator broadcast it (the payer node never would): it is in node 1's mempool now.
      expect(await d.stock.getRawMempool()).toContain(txid);
      const shape = await d.stock.call<DecodedTransaction>("getrawtransaction", [txid, 1]);
      expect(shape.vin.length > 0).toBe(tier === "P0");
      expect((shape.vShieldedSpend?.length ?? 0) > 0).toBe(tier === "P2");
      record(d.line, `sapling agent ${tier}`, { txid, vin: shape.vin.length, saplingSpends: shape.vShieldedSpend?.length ?? 0, saplingOutputs: shape.vShieldedOutput?.length ?? 0, expiryHeight: shape.expiryheight });
    });
  }

  it("the facilitator over HTTP: /verify is read-only, /settle broadcasts once, repeats are duplicate or observed; another request's address is refused", async () => {
    await d.mine(1, d.stock);
    const { req, resource } = await offer();
    const builder = new shielded.CommandSaplingBuilder(BUILDER, { env: builderEnv(tDirect) });
    const built = await builder.build({ to: req.payTo, amountZat: req.amount, memoHex: shielded.memoToHex(req.extra.memo as string) });
    expect(await d.stock.getRawMempool()).not.toContain(built.txid);

    const v1 = await post("verify", req, resource, built.txHex);
    expect(v1).toMatchObject({ isValid: true, extra: { receivedZat: PRICE.toString() } });
    expect(await post("verify", req, resource, built.txHex)).toMatchObject({ isValid: true });
    expect(await d.stock.getRawMempool()).not.toContain(built.txid); // verify never broadcasts

    // The same transaction against another issued request: its output does not pay that address.
    const other = await offer();
    expect(await post("verify", other.req, other.resource, built.txHex)).toMatchObject({ isValid: false, invalidReason: "invalid_exact_ycash_sapling_output" });

    const s1 = await post("settle", req, resource, built.txHex);
    expect(s1).toMatchObject({ success: true, transaction: built.txid, extra: { status: "mempool" } });
    expect(await d.stock.getRawMempool()).toContain(built.txid);
    expect(await post("verify", req, resource, built.txHex)).toMatchObject({ isValid: false, invalidReason: "duplicate_settlement" });
    expect(await post("settle", req, resource, built.txHex)).toMatchObject({ success: true, transaction: built.txid });

    await d.mine(1, d.stock);
    const notes = await d.stock.zListReceivedByAddress(req.payTo, 1);
    expect(notes.filter((n) => n.txid === built.txid).map((n) => n.amountZat)).toEqual([Number(PRICE)]);
    record(d.line, "sapling facilitator http", { txid: built.txid, verify: v1, settle: s1 });
  });
});
