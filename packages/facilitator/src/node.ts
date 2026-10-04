// The facilitator's view of its node: build the RPC client from config, map the x402 network id to
// the node's chain name, and wait for the node at startup.
import { YcashRpc, YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET, type NodeCapabilities, type YcashNetwork } from "x402-ycash-mechanism";
import type { RpcSource } from "./config.js";
import type { Logger } from "./logger.js";

/**
 * `getblockchaininfo.chain` for each network (`ycash-dd/src/chainparams.cpp:87,339,550` strNetworkID
 * "main" / "test" / "regtest"; `ycash6` `:90,385,615`). The facilitator rejects a network whose node
 * reports another chain (plan §5.3).
 */
export const CHAIN_OF_NETWORK: Readonly<Record<YcashNetwork, string>> = {
  [YCASH_MAINNET]: "main",
  [YCASH_TESTNET]: "test",
  [YCASH_REGTEST]: "regtest",
};

export function createRpc(source: RpcSource): YcashRpc {
  const timeout = source.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {};
  switch (source.kind) {
    case "devnet":
      return YcashRpc.fromDevnetJson(source.path, source.node, timeout);
    case "cookie":
      return new YcashRpc({ url: source.url, cookieFile: source.cookieFile, ...timeout });
    case "password":
      return new YcashRpc({ url: source.url, user: source.user, password: source.password, ...timeout });
  }
}

export class ChainMismatchError extends Error {
  constructor(
    readonly network: YcashNetwork,
    readonly chain: string,
  ) {
    super(`network ${network} expects chain "${CHAIN_OF_NETWORK[network]}" but the node reports "${chain}"`);
    this.name = "ChainMismatchError";
  }
}

export function assertChain(network: YcashNetwork, caps: NodeCapabilities): void {
  if (caps.chain !== CHAIN_OF_NETWORK[network]) throw new ChainMismatchError(network, caps.chain);
}

/** The minimal node surface the service itself uses (schemes take the full YcashRpc). */
export type NodeProbe = Pick<YcashRpc, "capabilities" | "getBlockCount">;

/**
 * Polls `capabilities()` until the node answers or `waitMs` passes. A node still warming up
 * (`-28`) or not yet listening is retried; a wrong chain fails at once.
 */
export async function waitForNode(
  rpc: NodeProbe,
  network: YcashNetwork,
  waitMs: number,
  log: Logger,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
): Promise<NodeCapabilities> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const caps = await rpc.capabilities();
      assertChain(network, caps);
      return caps;
    } catch (e) {
      if (e instanceof ChainMismatchError || Date.now() >= deadline) throw e;
      log.warn("node not ready, retrying", { attempt, error: e });
      await sleep(Math.min(1000 * attempt, 5000));
    }
  }
}
