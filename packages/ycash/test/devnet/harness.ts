// The devnet harness: a Yellowback regtest devnet of either line, started by
// `scripts/devnet.sh up {dd|6} <seed>`, read from the devnet.json named by X402_DEVNET_JSON.
// Without it every devnet suite is skipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "vitest";
import { randomBytes } from "node:crypto";
import { RPC_INVALID_ADDRESS_OR_KEY, RpcError, YcashRpc, type NodeCapabilities, type TxOutInfo } from "../../src/node/index.js";
import * as pq from "../../src/pq/index.js";
import * as T from "../../src/tx/index.js";

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
  // Each node's P2P port from the devnet's node<i>/ycash.conf; a node list without them skips the reconnect.
  const p2pPort = (i: number): string | undefined => {
    try {
      return /^port=(\d+)$/m.exec(readFileSync(join(state.dir, `node${i}`, "ycash.conf"), "utf8"))?.[1];
    } catch {
      return undefined;
    }
  };
  const heal = async (pools: string[][]) => {
    const p2pPorts = nodes.map((_, i) => p2pPort(i));
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

/**
 * Whether Falcon applies to the next block on node 0 (quantum spec TOK-PQ): from the node's Falcon height
 * YED is held by Falcon (scheme-2) TX_PQPKH holders only. The default devnet mirrors mainnet, Falcon from
 * the vault activation (owner D-Q-2); `X402_NODE_ARGS=-pqfalconheight=<h>` rehearses the regime before it.
 */
export async function falconNext(d: Devnet): Promise<boolean> {
  const info = await d.wallet.call<{ params: { pq?: { falconHeight?: number } } }>("yed_getinfo");
  const f = info.params.pq?.falconHeight ?? -1;
  return f >= 0 && (await d.tip()) + 1 >= f;
}

/**
 * A YED holder whose key the test holds: P2PKH (`priv`) before the Falcon height, a Falcon TX_PQPKH from it.
 * `address` is always the P2PKH `s…` form of `priv`, for the holder's plain YEC (fee coins).
 */
export interface YedHolder {
  priv: Uint8Array;
  /** the YED holding script: P2PKH(priv), or the Falcon TX_PQPKH of `pq` */
  script: Uint8Array;
  /** the holding script's Yellowback address (20-byte yr… or 53-character post-quantum yr…) */
  yr: string;
  /** the P2PKH address of `priv` (YEC) */
  address: string;
  /** the P2PKH script of `priv` (YEC) */
  p2pkh: Uint8Array;
  pq?: pq.PQKeyPair;
}

export function newYedHolder(network: "ycash:regtest", falcon: boolean): YedHolder {
  const priv = T.randomPrivKey();
  const h = T.hash160(T.pubkeyFromPriv(priv));
  const p2pkh = T.p2pkhScript(h);
  const address = T.encodeAddress(network, "p2pkh", h);
  if (!falcon) return { priv, script: p2pkh, yr: T.encodeAddress(network, "yed", h), address, p2pkh };
  const kp = pq.pqKeygen(pq.SCHEME_FN_DSA_512, randomBytes(pq.SEED_SIZE));
  const id = pq.keyIdOf(pq.SCHEME_FN_DSA_512, kp.publicKey);
  return { priv, script: pq.pqpkhScript(id), yr: T.encodePQAddress(network, "yedpq", id), address, p2pkh, pq: kp };
}

/**
 * Signs vin[i] SIGHASH_ALL in place: a coin of the holder's post-quantum script with its Falcon key, any other
 * (its P2PKH) with `priv`.
 */
export function signHolderInput(tx: T.Tx, i: number, h: YedHolder, spk: Uint8Array, value: bigint, branchId: number): void {
  const digest = T.sighashV4(tx, i, spk, value, T.SIGHASH.ALL, branchId);
  const vin = tx.vin[i] as (typeof tx.vin)[number];
  if (h.pq && T.equalBytes(spk, h.script)) {
    const sig = T.concatBytes(pq.pqSign(h.pq.scheme, h.pq.secretKey, digest), Uint8Array.of(T.SIGHASH.ALL));
    vin.scriptSig = T.buildScript(pq.pqSpendItems(h.pq.publicKey, sig));
  } else {
    vin.scriptSig = T.p2pkhScriptSig(T.signInput(digest, h.priv, T.SIGHASH.ALL), T.pubkeyFromPriv(h.priv));
  }
}

/** The Yellowback address of a YED-holding script (P2PKH or TX_PQPKH). */
export function yedAddressOfScript(network: "ycash:regtest", spk: Uint8Array): string {
  const id = pq.pqpkhKeyId(spk);
  if (id) return T.encodePQAddress(network, "yedpq", id);
  const h = T.p2pkhHash(spk);
  if (!h) throw new Error(`not a YED holder script: ${T.bytesToHex(spk)}`);
  return T.encodeAddress(network, "yed", h);
}

/**
 * Mines on the pool (its blocks carry quote tags) until node 0's yed_getprice holds a pMid and a pSlow price:
 * a run of stock-mined blocks empties the windows, and USD pricing (YedGetPriceSource) reads them.
 */
export async function ensurePrice(d: Devnet): Promise<void> {
  await waitFor(async () => {
    const p = await d.wallet.call<{ pMid?: number; pSlow?: number }>("yed_getprice");
    if ((p.pMid ?? 0) > 0 && (p.pSlow ?? 0) > 0) return true;
    await d.mine(4, d.pool);
    return false;
  }, { timeoutMs: 300_000, pollMs: 100, what: "a pMid and pSlow price" });
}

/** yed_send from `node`'s wallet, retried (mining) while its YED settles into the index; a TOK-PQ refusal is final. */
export async function yedSendFrom(d: Devnet, node: YcashRpc, to: string, cents: number): Promise<string> {
  let txid = "";
  await waitFor(async () => {
    try {
      txid = await node.call<string>("yed_send", [to, cents]);
      return true;
    } catch (e) {
      if (/bad-yed-holder|not-a-yellowback-address/.test((e as Error).message)) throw e;
      await d.mine(1);
      return false;
    }
  }, { timeoutMs: 60_000, what: "yed_send" });
  return txid;
}
