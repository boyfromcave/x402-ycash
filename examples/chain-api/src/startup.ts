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
