// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The checks before the API binds: the node is on the configured network, and on ycash:testnet it
// runs the fast profile (x402 demonstrations note D-6: fast, slow and legacy share the id
// ycash:testnet and the chain name "test"); and whether it keeps the address index.
import { RpcError, YCASH_REGTEST, YCASH_TESTNET, type YcashNetwork } from "x402-ycash-mechanism";
import type { RpcCaller } from "./reader.js";

const CHAIN_OF: Readonly<Record<YcashNetwork, string>> = { "ycash:mainnet": "main", [YCASH_TESTNET]: "test", [YCASH_REGTEST]: "regtest" };

export class WrongNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongNetworkError";
  }
}

export interface NodeFacts {
  chain: string;
  testnetProfile?: string;
  tip: number;
  /** The address index answers (`-insightexplorer` or `-lightwalletd`). */
  addressIndex: boolean;
}

/**
 * Reads the node's network and refuses a mismatch; a node still starting is retried until `waitMs`.
 *
 * @param rpc - The node.
 * @param network - The configured network.
 * @param testnetProfile - On ycash:testnet, the profile the node must report.
 * @param probeAddress - Any valid address of the network (the API's payTo), to probe the address index.
 * @param waitMs - How long to wait for a node that does not answer yet.
 * @param sleep - Injected for tests.
 * @returns What the node reported.
 * @throws WrongNetworkError at once on another chain or profile; the last error after `waitMs`.
 */
export async function checkNode(
  rpc: RpcCaller,
  network: YcashNetwork,
  testnetProfile: string | undefined,
  probeAddress: string,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<NodeFacts> {
  const deadline = Date.now() + waitMs;
  let info: { chain: string; testnetprofile?: string; blocks: number };
  for (let attempt = 1; ; attempt++) {
    try {
      info = await rpc.call("getblockchaininfo");
      break;
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await sleep(Math.min(1000 * attempt, 5000));
    }
  }
  if (info.chain !== CHAIN_OF[network]) throw new WrongNetworkError(`${network} needs a node on chain "${CHAIN_OF[network]}", but the node reports "${info.chain}"`);
  if (testnetProfile !== undefined && info.testnetprofile !== testnetProfile) {
    throw new WrongNetworkError(`the API serves the ${testnetProfile} testnet only, but the node reports profile ${info.testnetprofile === undefined ? "none" : `"${info.testnetprofile}"`}`);
  }
  let addressIndex = true;
  try {
    await rpc.call("getaddressbalance", [{ addresses: [probeAddress] }]);
  } catch (e) {
    if (e instanceof RpcError && !e.transport) addressIndex = false;
    else throw e;
  }
  return { chain: info.chain, ...(info.testnetprofile !== undefined ? { testnetProfile: info.testnetprofile } : {}), tip: info.blocks, addressIndex };
}

/**
 * The facilitator's /healthz, read from the configured URL (never a client's): it must be healthy,
 * on the same network, and, where the API needs a testnet profile, enforce that same profile
 * itself (X402_TESTNET_PROFILE), so a payment can only settle on the fast testnet (D-6).
 *
 * @param facilitatorUrl - The facilitator's base URL (configuration).
 * @param network - The API's network.
 * @param testnetProfile - The profile the API requires, if any.
 * @param f - fetch (tests).
 * @returns undefined when acceptable, else the reason; throws when the facilitator cannot be reached.
 */
export async function checkFacilitator(facilitatorUrl: string, network: YcashNetwork, testnetProfile: string | undefined, f: typeof fetch = fetch): Promise<string | undefined> {
  const res = await f(new URL("/healthz", facilitatorUrl), { signal: AbortSignal.timeout(10_000) });
  let body: { status?: unknown; network?: unknown; testnetProfile?: unknown; node?: { testnetProfile?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return `the facilitator's /healthz answered ${res.status} without JSON`;
  }
  if (body.network !== network) return `the facilitator serves ${String(body.network)}, not ${network}`;
  if (testnetProfile !== undefined && body.testnetProfile !== testnetProfile) {
    return `the facilitator does not enforce the ${testnetProfile} testnet profile (start it with X402_TESTNET_PROFILE=${testnetProfile})`;
  }
  if (!res.ok || body.status !== "ok") return `the facilitator is unhealthy (${String(body.status)})`;
  return undefined;
}

/**
 * Waits for the facilitator at startup: a refusal (wrong network or profile) fails at once; an
 * unreachable or unhealthy facilitator is retried until `waitMs`.
 *
 * @param check - The check (checkFacilitator bound to the configuration).
 * @param waitMs - How long to wait.
 * @param sleep - Injected for tests.
 * @throws WrongNetworkError on a network or profile refusal; Error after the wait.
 */
export async function waitForFacilitator(check: () => Promise<string | undefined>, waitMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 1; ; attempt++) {
    let reason: string | undefined;
    try {
      reason = await check();
    } catch (e) {
      reason = `the facilitator does not answer: ${(e as Error).message}`;
    }
    if (reason === undefined) return;
    if (/serves|does not enforce/.test(reason)) throw new WrongNetworkError(reason);
    if (Date.now() >= deadline) throw new Error(reason);
    await sleep(Math.min(1000 * attempt, 5000));
  }
}

/**
 * The private routes' base address: the node's wallet must hold its spending key, or
 * z_getnewdiversifiedaddress refuses and every private 402 would fail.
 *
 * @param rpc - The node.
 * @param baseAddress - API_SAPLING_BASE_ADDRESS.
 * @throws Error when the wallet does not answer or does not own the address.
 */
export async function checkShieldedBase(rpc: RpcCaller, baseAddress: string): Promise<void> {
  let v: { isvalid?: boolean; ismine?: boolean; type?: string };
  try {
    v = await rpc.call("z_validateaddress", [baseAddress]);
  } catch (e) {
    throw new Error(`the private routes need the node's wallet, but z_validateaddress failed: ${(e as Error).message}`);
  }
  if (v.isvalid !== true || v.type !== "sapling") throw new Error(`API_SAPLING_BASE_ADDRESS is not a Sapling address of this network`);
  if (v.ismine !== true) throw new Error(`the node's wallet does not hold the spending key of API_SAPLING_BASE_ADDRESS ${baseAddress}`);
}
