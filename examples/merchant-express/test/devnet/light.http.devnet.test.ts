// The private agent end to end on a live devnet of either line (plan X4b, chunk lighte2e): an agent
// holding only a Sapling spending key and a lightwalletd URL pays shielded x402 requirements from the
// Rust light client, over real HTTP agent → merchant → facilitator.
//
// - lightwalletd-dd runs against the devnet (node 0); `x402-light serve` is started by
//   scripts/light-agent.sh with a fresh key (ZIP-32 master key of a random seed) and syncs from it;
// - the merchant's key: made on node 0, its viewing key imported into node 1 (stock), the
//   self-hosted facilitator's node; merchant and facilitator issue addresses offline from the viewing
//   key (the viewing-key merchant of viewkey.http.devnet.test.ts); the facilitator serves
//   `sapling-proof` and `sapling` (X402_SHIELDED_METHODS);
// - the agent process gets AGENT_SAPLING_BUILDER=<x402-light URL> and nothing else: no node RPC, no
//   lightwalletd client of its own, no WIF;
// - (a) `sapling`: the light client builds (nExpiryHeight from its lightwalletd's tip), the facilitator
//   verifies, the resource runs, settle broadcasts; the receipt verifies;
// - (b) `sapling-proof`: the light client sends, the facilitator finds the note; the receipt verifies;
// - (c) over the facilitator's HTTP: another request's address is refused, a repeat is
//   duplicate_settlement, for both methods;
// - timings: light sync, build+prove, verify/settle, end-to-end per method.
//
//   scripts/devnet.sh up dd 361; lightwalletd on 9428 (light/scripts/regtest.sh KEEP=1 does both);
//   X402_DEVNET_JSON=…/dd-361/devnet.json X402_LWD_URL=127.0.0.1:9428 X402_LIGHT_BIN=…/x402-light \
//     npx vitest run --dir test/devnet light.http -w x402-ycash-example-merchant-express
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { blake2b } from "@noble/hashes/blake2.js";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exact, shielded, tx, verifyReceipt, type DecodedTransaction, type ZSendManyOptions } from "x402-ycash-mechanism";
import { DEVNET_JSON, devnet, record, waitFor, type Devnet } from "../../../../packages/ycash/test/devnet/harness.js";
import { REPO, runAgent, startService, type Proc } from "./procs.js";

const NETWORK = "ycash:regtest";
const PRICE = 1_500_000n;
const LWD = process.env.X402_LWD_URL;
const LIGHT_BIN = process.env.X402_LIGHT_BIN;
const PARAMS = process.env.X402_LIGHT_PARAMS ?? [join(homedir(), ".zcash-params"), join(homedir(), "Library/Application Support/ZcashParams")].find((d) => {
  try {
    readFileSync(join(d, "sapling-output.params"), { flag: "r" });
    return true;
  } catch {
    return false;
  }
});
const describeLight = (DEVNET_JSON && LWD && LIGHT_BIN ? describe : describe.skip) as typeof describe;

// Jubjub's scalar field order r (Sapling spec §5.4.9.3).
const R = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
const utf8 = (s: string) => new TextEncoder().encode(s);
const le32 = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const leNum = (b: Uint8Array) => b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);

/**
 * TEST ONLY: a fresh ZIP-32 Sapling master spending key, `secret-extended-key-regtest1…` (the
 * z_exportkey form x402-light imports), so no node wallet ever holds the agent's key.
 *
 * @param seed - 32 random bytes.
 * @returns The bech32 extended spending key.
 */
function masterSpendingKey(seed: Uint8Array): string {
  const i = blake2b(seed, { dkLen: 64, personalization: utf8("ZcashIP32Sapling") });
  const sk = i.slice(0, 32);
  const expand = (t: number) => blake2b.create({ dkLen: 64, personalization: utf8("Zcash_ExpandSeed") }).update(sk).update(Uint8Array.of(t)).digest();
  const bytes = new Uint8Array(169); // depth 0, parent tag 0, child index 0, then c, ask, nsk, ovk, dk
  bytes.set(i.slice(32), 9);
  bytes.set(le32(leNum(expand(0)) % R), 41);
  bytes.set(le32(leNum(expand(1)) % R), 73);
  bytes.set(expand(2).slice(0, 32), 105);
  bytes.set(expand(0x10).slice(0, 32), 137);
  return shielded.bech32Encode("secret-extended-key-regtest", bytes);
}

interface PaidLine {
  i: number;
  status: number;
  ms: number;
  settlement?: { success: boolean; transaction: string; errorReason?: string; extra?: Record<string, unknown>; extensions?: Record<string, unknown> };
  body: unknown;
}

describeLight("the private agent: a Sapling key and lightwalletd, paying sapling and sapling-proof through the light client", () => {
  let d: Devnet;
  let dir: string;
  let lightData: string;
  let light: shielded.LightClient;
  let lightUrl: string;
  let lightAddress: string;
  let fac: Proc & { url: string };
  let shop: Proc & { url: string };
  let receiptPub: Uint8Array;
  const procs: Proc[] = [];
  const devnetJson = DEVNET_JSON as string;
  const timings: Record<string, unknown> = {};
  const script = join(REPO, "scripts/light-agent.sh");

  /** Mines one block on the stock node, then has the light client sync to it. */
  async function mineAndSync(): Promise<number> {
    await d.mine(1, d.stock);
    return syncTo(await d.tip());
  }

  /** Waits for lightwalletd to ingest `height`, then syncs; returns the sync's milliseconds. */
  async function syncTo(height: number): Promise<number> {
    await waitFor(async () => (await light.call<{ lwdLatestHeight: number }>("status")).lwdLatestHeight >= height, { timeoutMs: 60_000, pollMs: 300, what: `lightwalletd at ${height}` });
    const t0 = performance.now();
    const r = await light.sync();
    const ms = Math.round(performance.now() - t0);
    expect(r.tipHeight).toBeGreaterThanOrEqual(height);
    return ms;
  }

  async function agent(path: string): Promise<{ line: PaidLine; start: Record<string, unknown> }> {
    // Exactly the private agent's environment: the network, the resource, the cap, the light client.
    const env = { X402_NETWORK: NETWORK, RESOURCE_URL: `${shop.url}${path}`, AGENT_SAPLING_BUILDER: lightUrl, MAX_PAYMENT_ZAT: "5000000" };
    const p = runAgent(env);
    procs.push(p);
    const code = await p.exited;
    if (code !== 0) throw new Error(`agent exited ${code}: ${p.stderr.join("")} ${JSON.stringify(p.lines.slice(-3))}`);
    // (d) the agent had no ycashd RPC configured at all: nothing in its environment names a node or
    // lightwalletd, and it says so itself.
    expect(Object.keys(env).filter((k) => /RPC|DEVNET|LWD|WIF|SHIELDED_FROM/.test(k))).toEqual([]);
    const start = p.lines.find((l) => l.msg === "agent") as Record<string, unknown>;
    expect(start).toMatchObject({ nodeRpc: null, signer: `light client ${lightUrl} (shielded only)`, chain: `light client ${lightUrl}`, schemes: ["exact (sapling-proof, sapling)"] });
    return { line: p.lines.find((l) => typeof l.i === "number") as unknown as PaidLine, start };
  }

  async function offer(path: string): Promise<{ req: PaymentRequirements; resource: unknown }> {
    const res = await fetch(`${shop.url}${path}`);
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") as string);
    return { req: pr.accepts[0] as PaymentRequirements, resource: pr.resource };
  }

  const post = async (op: "verify" | "settle", req: PaymentRequirements, resource: unknown, payload: Record<string, string>) =>
    (await (
      await fetch(`${fac.url}/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2, resource, accepted: req, payload }, paymentRequirements: req }),
      })
    ).json()) as Record<string, unknown>;

  const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
    const t0 = performance.now();
    const v = await f();
    return [v, Math.round(performance.now() - t0)];
  };

  beforeAll(async () => {
    d = await devnet();
    dir = mkdtempSync(join(tmpdir(), "x402-light-e2e-"));
    lightData = join(dir, "light");

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
      PRICE_SHIELDED_ZAT: PRICE.toString(),
    });
    procs.push(shop);

    // The light agent: a fresh key, birthday at the tip, served on loopback by scripts/light-agent.sh.
    const birthday = await d.tip();
    const out = execFileSync(script, ["start", "--data", lightData, "--lwd", LWD as string, "--network", "regtest", "--birthday", String(birthday), "--sync-every", "5", ...(PARAMS ? ["--params", PARAMS] : [])], {
      encoding: "utf8",
      env: { ...process.env, X402_LIGHT_BIN: LIGHT_BIN as string, X402_LIGHT_KEY: masterSpendingKey(tx.randomPrivKey()) },
    });
    lightUrl = /AGENT_SAPLING_BUILDER=(\S+)/.exec(out)?.[1] as string;
    expect(lightUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    light = new shielded.LightClient(lightUrl);
    lightAddress = (await light.call<{ address: string }>("address")).address;
    expect(lightAddress).toMatch(/^yregtestsapling1/);

    // Fund it from node 0: three notes (t → z, one per transparent coin), so payments do not wait on change.
    const tOpts: ZSendManyOptions = d.line === "v6" ? { minconf: 1, privacyPolicy: "AllowFullyTransparent" } : { minconf: 1 };
    const taddrs = [await d.wallet.getNewAddress(), await d.wallet.getNewAddress(), await d.wallet.getNewAddress()];
    for (const a of taddrs) await d.fund(a, 100_000_000n);
    await d.mine(1);
    for (const a of taddrs) await d.wallet.zSendManyAndWait(a, [{ address: lightAddress, amount: 50_000_000n }], tOpts);
    await d.mine(1);
    timings.initialSyncMs = await syncTo(await d.tip());
    const status = await light.status();
    expect(status).toMatchObject({ network: "regtest", hasKey: true, address: lightAddress });
    expect(status.balance.spendableZat).toBe(150_000_000);
    timings.blocksFromBirthday = (await d.tip()) - birthday;

    // The merchant turns the sapling route on once the facilitator lists it.
    const supported = (await (await fetch(`${fac.url}/supported`)).json()) as { kinds: { scheme: string; extra?: { assetTransferMethods?: string[] } }[] };
    expect(supported.kinds.find((k) => k.scheme === "exact")?.extra?.assetTransferMethods).toEqual(["transparent", "sapling-proof", "sapling"]);
    await waitFor(async () => (await fetch(`${shop.url}/shielded/private-report`)).status === 402, { timeoutMs: 30_000, pollMs: 1000, what: "the merchant's sapling route" });
    record(d.line, "light e2e setup", { facilitator: fac.url, merchant: shop.url, light: lightUrl, lwd: LWD, lightAddress, ...timings });
  });

  afterAll(async () => {
    await Promise.all(procs.map((p) => p.stop()));
    procs.forEach((p, i) => writeFileSync(join(dir, `${i}-${p.name}.log`), [...p.lines.map((l) => JSON.stringify(l)), ...p.stderr].join("\n")));
    if (lightData) execFileSync(script, ["stop", "--data", lightData], { encoding: "utf8" });
    record(d?.line ?? "?", "light e2e timings", timings);
    console.log(`light e2e logs: ${dir}`);
  });

  it("(a) sapling: the light client's transaction is verified before the resource and broadcast after, with a verifiable receipt", async () => {
    const { line: r } = await agent("/shielded/private-report");
    expect(r).toMatchObject({ status: 200, body: { paidWith: "exact/sapling" }, settlement: { success: true, extra: { status: "mempool", receivedZat: PRICE.toString() } } });
    const txid = r.settlement!.transaction;
    const receipt = (r.settlement!.extensions as { "offer-receipt": { info: { receipt: Parameters<typeof verifyReceipt>[0] } } })["offer-receipt"].info.receipt;
    expect(verifyReceipt(receipt, { trustedPublicKeys: [receiptPub] })).toMatchObject({ network: NETWORK, payer: "anonymous", transaction: txid });
    // The facilitator broadcast it; the light client never did.
    expect(await d.stock.getRawMempool()).toContain(txid);
    const shape = await d.stock.call<DecodedTransaction>("getrawtransaction", [txid, 1]);
    expect(shape.vin).toHaveLength(0); // z→z: nothing transparent (tier P2)
    expect(shape.vShieldedSpend?.length ?? 0).toBeGreaterThan(0);
    timings.saplingEndToEndMs = r.ms;
    timings.saplingSyncAfterMineMs = await mineAndSync();
    record(d.line, "light sapling agent", { txid, ms: r.ms, expiryHeight: shape.expiryheight, saplingSpends: shape.vShieldedSpend?.length, saplingOutputs: shape.vShieldedOutput?.length });
  });

  it("(b) sapling-proof: the light client pays the issued address with the memo and the facilitator settles the txid", async () => {
    const { line: r } = await agent("/shielded/report");
    expect(r).toMatchObject({ status: 200, body: { paidWith: "exact/sapling-proof" }, settlement: { success: true, extra: { receivedZat: PRICE.toString() } } });
    const txid = r.settlement!.transaction;
    const receipt = (r.settlement!.extensions as { "offer-receipt": { info: { receipt: Parameters<typeof verifyReceipt>[0] } } })["offer-receipt"].info.receipt;
    expect(verifyReceipt(receipt, { trustedPublicKeys: [receiptPub] })).toMatchObject({ network: NETWORK, payer: "anonymous", transaction: txid });
    const shape = await d.stock.call<DecodedTransaction>("getrawtransaction", [txid, 1]);
    expect(shape.vin).toHaveLength(0);
    timings.saplingProofEndToEndMs = r.ms;
    timings.saplingProofSyncAfterMineMs = await mineAndSync();
    record(d.line, "light sapling-proof agent", { txid, ms: r.ms });
  });

  it("(c) sapling over the facilitator's HTTP: another request's address is refused, verify is repeatable, settle once, then duplicate", async () => {
    const a = await offer("/shielded/private-report");
    const b = await offer("/shielded/private-report");
    const expiryHeight = exact.clientExpiryHeight(await light.getBlockCount(), a.req.maxTimeoutSeconds);
    const [built, buildMs] = await timed(() => light.build({ to: a.req.payTo, amountZat: a.req.amount, memoHex: shielded.memoToHex(a.req.extra.memo as string), expiryHeight }));
    const decoded = tx.parseTx(built.txHex);
    expect(decoded.expiryHeight).toBe(expiryHeight);
    expect(tx.txFee(decoded, [])).toBeGreaterThanOrEqual(tx.feeFloor(decoded));
    expect(await d.stock.getRawMempool()).not.toContain(built.txid);

    expect(await post("verify", b.req, b.resource, { transaction: built.txHex })).toMatchObject({ isValid: false, invalidReason: "invalid_exact_ycash_sapling_output" });
    const [v1, verifyMs] = await timed(() => post("verify", a.req, a.resource, { transaction: built.txHex }));
    expect(v1).toMatchObject({ isValid: true, extra: { receivedZat: PRICE.toString() } });
    expect(await d.stock.getRawMempool()).not.toContain(built.txid);
    const [s1, settleMs] = await timed(() => post("settle", a.req, a.resource, { transaction: built.txHex }));
    expect(s1).toMatchObject({ success: true, transaction: built.txid, extra: { status: "mempool" } });
    expect(await post("verify", a.req, a.resource, { transaction: built.txHex })).toMatchObject({ isValid: false, invalidReason: "duplicate_settlement" });
    Object.assign(timings, { saplingBuildProveMs: buildMs, saplingVerifyMs: verifyMs, saplingSettleMs: settleMs, saplingFeeZat: tx.txFee(decoded, []).toString() });
    await mineAndSync();
    record(d.line, "light sapling facilitator http", { txid: built.txid, buildMs, verifyMs, settleMs, expiryHeight });
  });

  it("(c) sapling-proof over the facilitator's HTTP: the txid for another request is refused, a repeat settle is duplicate_settlement", async () => {
    const p = await offer("/shielded/report");
    const q = await offer("/shielded/report");
    const [sent, sendMs] = await timed(() => light.send({ to: p.req.payTo, amountZat: p.req.amount, memoHex: shielded.memoToHex(p.req.extra.memo as string) }));
    await waitFor(async () => (await d.stock.getRawMempool()).includes(sent.txid), { timeoutMs: 30_000, what: "the light client's payment in node 1's mempool" });
    const wrong = await post("settle", q.req, q.resource, { txid: sent.txid });
    expect(wrong).toMatchObject({ success: false });
    const [s1, settleMs] = await timed(() => post("settle", p.req, p.resource, { txid: sent.txid }));
    expect(s1).toMatchObject({ success: true, transaction: sent.txid });
    expect(await post("settle", p.req, p.resource, { txid: sent.txid })).toMatchObject({ success: false, errorReason: "duplicate_settlement" });
    Object.assign(timings, { saplingProofSendMs: sendMs, saplingProofSettleMs: settleMs, saplingProofFeeZat: sent.feeZat });
    await mineAndSync();
    record(d.line, "light sapling-proof facilitator http", { txid: sent.txid, sendMs, settleMs, wrongRequest: wrong.errorReason });
  });

  it("the light wallet's balance accounts for every payment and fee", async () => {
    const status = await light.status();
    const fees = [timings.saplingFeeZat, timings.saplingProofFeeZat].map((f) => Number(f));
    // Four payments of PRICE; the two agent-run ones paid the ZIP-317 fee too (10,000 for 1 spend, 2 outputs).
    expect(status.balance.totalZat).toBeLessThanOrEqual(150_000_000 - 4 * Number(PRICE) - fees[0]! - fees[1]!);
    expect(status.balance.totalZat).toBeGreaterThanOrEqual(150_000_000 - 4 * Number(PRICE) - 4 * 20_000);
    record(d.line, "light balance after", status.balance);
  });
});
