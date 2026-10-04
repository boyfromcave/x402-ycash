// The devnet harness: a Yellowback regtest devnet of either line, started by
// `scripts/devnet.sh up {dd|6} <seed>`, read from the devnet.json named by X402_DEVNET_JSON.
// Without it every devnet suite is skipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "vitest";
import { RPC_INVALID_ADDRESS_OR_KEY, RpcError, YcashRpc, type NodeCapabilities, type TxOutInfo } from "../../src/node/index.js";

export const DEVNET_JSON = process.env.X402_DEVNET_JSON;

/** `describe` when a devnet is configured, `describe.skip` otherwise. */
export const describeDevnet: typeof describe = (DEVNET_JSON ? describe : describe.skip) as typeof describe;

interface DevnetState {
  num_nodes: number;
  auto_pools?: number[];
  pools?: number[];
  dir: string;
}

export interface Devnet {
  /** node 0: the funded wallet, run with -yellowback */
  wallet: YcashRpc;
  /** node 1: stock, no -yellowback */
  stock: YcashRpc;
  /** an automated pool (node 2): its blocks carry a quote tag, so mining here keeps prices live */
  pool: YcashRpc;
  nodes: YcashRpc[];
  caps: NodeCapabilities;
  /** short label for test output: "v4" or "v6" */
  line: string;
  /** Sends `yec` from node 0's wallet to `address` (not mined); returns the txid. */
  fund(address: string, yec: number | bigint): Promise<string>;
  /** Mines n blocks on `node` (default the pool) after the mempools agree, then waits for every node. */
  mine(n: number, node?: YcashRpc): Promise<string[]>;
  tip(): Promise<number>;
  syncMempools(): Promise<void>;
  syncBlocks(): Promise<void>;
  /** Locates the output of `txid` that pays `address`. */
  findVout(txid: string, address: string): Promise<{ n: number; zat: bigint }>;
  /** A fresh, confirmed, non-coinbase output of `zat` owned by `owner`'s wallet, locked against its coin selection. */
  utxo(owner: YcashRpc, zat: bigint): Promise<{ txid: string; vout: number; address: string; zat: bigint }>;
}

export async function waitFor<T>(cond: () => Promise<T | undefined | null | false>, opts: { timeoutMs?: number; pollMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? "condition"}`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 200));
  }
}

let cached: Promise<Devnet> | undefined;

export function devnet(): Promise<Devnet> {
  if (!DEVNET_JSON) throw new Error("X402_DEVNET_JSON is not set");
  cached ??= load(DEVNET_JSON);
  return cached;
}

async function load(path: string): Promise<Devnet> {
  const state = JSON.parse(readFileSync(path, "utf8")) as DevnetState;
  const nodes = Array.from({ length: state.num_nodes }, (_, i) => YcashRpc.fromDevnetJson(path, i, { timeoutMs: 60_000 }));
  const poolIndex = state.auto_pools?.[0] ?? state.pools?.[0] ?? 2;
  const [wallet, stock, pool] = [nodes[0], nodes[1], nodes[poolIndex]] as [YcashRpc, YcashRpc, YcashRpc];
  const caps = await wallet.capabilities();

  // v4.5.0 scores 10 per relayed transaction already expired by two blocks (ycash-dd src/main.cpp:876-883)
  // and drops the peer at 100. Suites that mine fast past short expiries make that routine, so over a
  // long run the devnet's one-shot connections fall apart and the mesh can split ({0,1,4} and {2,3}
  // was seen). A reconnect does not replay the mempool, so heal both: re-add every peer, then hand each
  // node the mempool transactions it lacks. Errors are ignored: a refusal is the node's to make.
  const p2pPorts = nodes.map((_, i) => /^port=(\d+)$/m.exec(readFileSync(join(state.dir, `node${i}`, "ycash.conf"), "utf8"))?.[1]);
  const heal = async (pools: string[][]) => {
    for (const [i, node] of nodes.entries()) {
      const others = p2pPorts.filter((port, j) => j !== i && port);
      for (const port of others) await node.call("addnode", [`127.0.0.1:${port}`, "onetry"]).catch(() => undefined);
    }
    for (const txid of new Set(pools.flat())) {
      const holder = nodes[pools.findIndex((p) => p.includes(txid))] as YcashRpc;
      const hex = await holder.call<string>("getrawtransaction", [txid]).catch(() => undefined);
      const lacking = nodes.filter((_, i) => !pools[i]?.includes(txid));
      if (hex) for (const node of lacking) await node.sendRawTransaction(hex).catch(() => undefined);
    }
  };
  const syncMempools = async () => {
    const healAt = Date.now() + 5_000;
    let healed = false;
    await waitFor(
      async () => {
        const pools = await Promise.all(nodes.map((n) => n.getRawMempool()));
        const first = JSON.stringify([...(pools[0] ?? [])].sort());
        if (pools.every((p) => JSON.stringify([...p].sort()) === first)) return true;
        if (!healed && Date.now() > healAt) {
          healed = true;
          await heal(pools);
        }
        return false;
      },
      { what: "mempools to agree" },
    );
  };
  const syncBlocks = async () => {
    await waitFor(
      async () => {
        const hashes = await Promise.all(nodes.map((n) => n.call<string>("getbestblockhash")));
        return hashes.every((h) => h === hashes[0]);
      },
      { what: "tips to agree" },
    );
  };
  // Both lines notify the wallet of a block asynchronously. Until it catches up, a wallet tx just
  // mined is neither in the mempool nor known to be in a block, so its inputs look unspent and
  // sendtoaddress double spends them ("Transaction not valid"). Wait until every wallet sees each
  // of its transactions in the new blocks as confirmed.
  const syncWallets = async (hashes: string[]) => {
    const txids = (await Promise.all(hashes.map((h) => wallet.call<{ tx: string[] }>("getblock", [h])))).flatMap((b) => b.tx);
    for (const node of [wallet, stock, pool]) {
      for (const txid of txids) {
        await waitFor(
          async () => {
            try {
              return (await node.call<{ confirmations: number }>("gettransaction", [txid])).confirmations > 0;
            } catch (e) {
              if (e instanceof RpcError && e.code === RPC_INVALID_ADDRESS_OR_KEY) return true; // not a wallet tx of this node
              throw e;
            }
          },
          { what: `wallet to see ${txid} confirmed` },
        );
      }
    }
  };
  const self: Devnet = {
    wallet,
    stock,
    pool,
    nodes,
    caps,
    line: caps.line,
    fund: (address, yec) => wallet.sendToAddress(address, typeof yec === "bigint" ? yec : BigInt(Math.round(yec * 1e8))),
    async mine(n, node = pool) {
      await syncMempools();
      const hashes = await node.generate(n);
      await syncBlocks();
      await syncWallets(hashes);
      return hashes;
    },
    tip: () => wallet.getBlockCount(),
    syncMempools,
    syncBlocks,
    async findVout(txid, address) {
      const tx = await wallet.decodeRawTransaction(await wallet.call<string>("getrawtransaction", [txid]));
      const out = tx.vout.find((o) => o.scriptPubKey.addresses?.includes(address));
      if (!out) throw new Error(`${txid} pays nothing to ${address}`);
      return { n: out.n, zat: BigInt(out.valueZat ?? Math.round(out.value * 1e8)) };
    },
    async utxo(owner, zat) {
      const address = await owner.getNewAddress();
      const txid = await self.fund(address, zat);
      await self.mine(1);
      const { n } = await self.findVout(txid, address);
      // Keep the owner's wallet from spending it: v4.5.0 and 6.21.0 tell the wallet about a
      // sendrawtransaction'd spend of its coin only later, and sendtoaddress would double spend it.
      await owner.call("lockunspent", [false, [{ txid, vout: n }]]);
      return { txid, vout: n, address, zat };
    },
  };
  return self;
}

/** Confirmations of an output, or null; a tiny helper for readable assertions. */
export function depth(out: TxOutInfo | null): number | null {
  return out ? out.confirmations : null;
}

/** Findings are logged in one greppable form so a run can be quoted exactly. */
export function record(line: string, item: string, value: unknown): void {
  console.log(`FINDING ${line} ${item}: ${JSON.stringify(value)}`);
}
