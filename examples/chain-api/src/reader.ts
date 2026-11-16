// Copyright (c) 2026 The Ycash developers. MIT License.
//
// Every node call the API makes, in one place. Method names are literals in this file: nothing a
// client sends picks an RPC method. Only stock read RPCs, the read-only `vault_getinfo` and `yed_*`
// reads, and `sendrawtransaction` for the paid relay (repository rule: no node change). Answers
// are trimmed to known fields and bounded lists, so a paid request returns a bounded body.
import { RPC_INVALID_ADDRESS_OR_KEY, RPC_METHOD_NOT_FOUND, RpcError } from "x402-ycash-mechanism";

/** The one node surface the reader needs; `YcashRpc` satisfies it. */
export interface RpcCaller {
  call<T>(method: string, params?: readonly unknown[]): Promise<T>;
}

/** A client-facing failure: the HTTP status and a short reason (no stack, no node internals). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The Vault network upgrade's branch id (both node lines, `UPGRADE_VAULT`). */
export const VAULT_BRANCH_ID = "6d5b7a31";

/** Most entries any list in an answer carries; the answer says how many there were. */
export const LIST_CAP = 100;
/** Most mempool entries the fee picture reads. */
export const MEMPOOL_SCAN_CAP = 5_000;
/** Most previous transactions read to price a transaction's fee when the node's spent index is off. */
export const PREVOUT_LOOKUPS_CAP = 25;

const ZAT = 100_000_000;
/** A node amount (YEC, a JSON number) as whole zatoshis. */
export const zatOf = (yec: number): number => Math.round(yec * ZAT);

/**
 * Maps a node error to the client's answer: a missing object is 404, a disabled index 503 with the
 * reason, a transport failure 503; anything else 502 with the node's own message (it carries no
 * secret: the node's messages are the public RPC errors).
 *
 * @param e - The error.
 * @param what - What was being read, for the message.
 * @returns The ApiError to answer with.
 */
export function apiErrorOf(e: unknown, what: string): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof RpcError) {
    if (e.transport) return new ApiError(503, "node_unavailable", "the node did not answer; try again shortly");
    if (/is disabled/i.test(e.message)) return new ApiError(503, "index_off", `${what} needs the node's address index (-insightexplorer), which is off on this node`);
    if (e.code === RPC_INVALID_ADDRESS_OR_KEY || e.code === -8) return new ApiError(404, "not_found", `${what}: ${e.message}`);
    if (e.code === RPC_METHOD_NOT_FOUND) return new ApiError(501, "not_supported", `${what} is not supported by this node`);
    return new ApiError(502, "node_error", `${what}: ${e.message}`);
  }
  return new ApiError(500, "internal", "internal error");
}

interface RawVin {
  txid?: string;
  vout?: number;
  coinbase?: string;
  sequence?: number;
  /** -insightexplorer's spent index adds the spent output's value and address. */
  valueSat?: number;
  value?: number;
  address?: string;
}
interface RawVout {
  n: number;
  value: number;
  valueZat?: number;
  scriptPubKey?: { type?: string; addresses?: string[] };
}
interface RawTx {
  txid: string;
  version: number;
  overwintered?: boolean;
  versiongroupid?: string;
  locktime: number;
  expiryheight?: number;
  size?: number;
  vin: RawVin[];
  vout: RawVout[];
  vjoinsplit?: { vpub_oldZat?: number; vpub_newZat?: number; vpub_old?: number; vpub_new?: number }[];
  valueBalanceZat?: number;
  valueBalance?: number;
  vShieldedSpend?: unknown[];
  vShieldedOutput?: unknown[];
  blockhash?: string;
  height?: number;
  confirmations?: number;
  time?: number;
  blocktime?: number;
}

const voutZat = (o: RawVout): number => o.valueZat ?? zatOf(o.value);

/** The transparent-pool type of an output's script, as the node names it (pubkeyhash, scripthash, pqpubkeyhash, vault, …). */
const typeOf = (o: RawVout): string => o.scriptPubKey?.type ?? "unknown";

export class ChainReader {
  constructor(
    private readonly rpc: RpcCaller,
    private readonly opts: { historyWindowBlocks: number } = { historyWindowBlocks: 10_000 },
  ) {}

  /**
   * A transaction, decoded, with its confirmations and fee.
   *
   * @param txid - 64 hex characters (validated by the caller).
   * @returns The trimmed transaction.
   */
  async transaction(txid: string): Promise<Record<string, unknown>> {
    let raw: RawTx;
    try {
      raw = await this.rpc.call<RawTx>("getrawtransaction", [txid, 1]);
    } catch (e) {
      const err = apiErrorOf(e, "transaction");
      if (err.status === 404) throw new ApiError(404, "not_found", "no such transaction in the chain or the mempool");
      throw err;
    }
    const coinbase = raw.vin.length > 0 && raw.vin[0]?.coinbase !== undefined;
    const fee = coinbase ? { feeZat: null, feeNote: "coinbase: no fee" } : await this.feeOf(raw);
    const outZat = raw.vout.reduce((s, o) => s + voutZat(o), 0);
    return {
      txid: raw.txid,
      version: raw.version,
      overwintered: raw.overwintered ?? false,
      ...(raw.versiongroupid ? { versionGroupId: raw.versiongroupid } : {}),
      size: raw.size ?? null,
      lockTime: raw.locktime,
      expiryHeight: raw.expiryheight ?? null,
      confirmations: raw.confirmations ?? 0,
      inMempool: !raw.blockhash,
      ...(raw.blockhash ? { blockHash: raw.blockhash, height: raw.height ?? null, blockTime: raw.blocktime ?? raw.time ?? null } : {}),
      coinbase,
      ...fee,
      transparentOutZat: outZat,
      saplingValueBalanceZat: raw.valueBalanceZat ?? (raw.valueBalance !== undefined ? zatOf(raw.valueBalance) : 0),
      counts: {
        transparentInputs: raw.vin.length,
        transparentOutputs: raw.vout.length,
        saplingSpends: raw.vShieldedSpend?.length ?? 0,
        saplingOutputs: raw.vShieldedOutput?.length ?? 0,
        joinSplits: raw.vjoinsplit?.length ?? 0,
      },
      vin: raw.vin.slice(0, LIST_CAP).map((i) =>
        i.coinbase !== undefined
          ? { coinbase: true }
          : { txid: i.txid, vout: i.vout, ...(i.valueSat !== undefined ? { valueZat: i.valueSat } : {}), ...(i.address ? { address: i.address } : {}) },
      ),
      vout: raw.vout.slice(0, LIST_CAP).map((o) => ({ n: o.n, valueZat: voutZat(o), type: typeOf(o), addresses: o.scriptPubKey?.addresses ?? [] })),
      ...(raw.vin.length > LIST_CAP || raw.vout.length > LIST_CAP ? { truncated: `lists cut at ${LIST_CAP} entries` } : {}),
    };
  }

  /**
   * The fee: transparent in + Sprout out of the pool + Sapling value balance − transparent out −
   * Sprout into the pool. Input values come from the spent index when the node has it, else from
   * the previous transactions (at most PREVOUT_LOOKUPS_CAP of them, which needs -txindex).
   *
   * @param raw - The decoded transaction.
   * @returns The fee in zatoshis, or null with the reason it is unknown.
   */
  private async feeOf(raw: RawTx): Promise<{ feeZat: number | null; feeNote?: string }> {
    const inputs: number[] = [];
    const missing = raw.vin.filter((i) => i.valueSat === undefined);
    const prevTxids = [...new Set(missing.map((i) => i.txid as string))];
    if (prevTxids.length > PREVOUT_LOOKUPS_CAP) return { feeZat: null, feeNote: `more than ${PREVOUT_LOOKUPS_CAP} previous transactions to read` };
    const prev = new Map<string, RawTx>();
    try {
      for (const id of prevTxids) prev.set(id, await this.rpc.call<RawTx>("getrawtransaction", [id, 1]));
    } catch {
      return { feeZat: null, feeNote: "an input's previous transaction is not available (the node needs -txindex)" };
    }
    for (const i of raw.vin) {
      if (i.valueSat !== undefined) inputs.push(i.valueSat);
      else {
        const o = prev.get(i.txid as string)?.vout.find((v) => v.n === i.vout);
        if (!o) return { feeZat: null, feeNote: "an input's previous output was not found" };
        inputs.push(voutZat(o));
      }
    }
    const js = raw.vjoinsplit ?? [];
    const vpubOld = js.reduce((s, j) => s + (j.vpub_oldZat ?? zatOf(j.vpub_old ?? 0)), 0);
    const vpubNew = js.reduce((s, j) => s + (j.vpub_newZat ?? zatOf(j.vpub_new ?? 0)), 0);
    const balance = raw.valueBalanceZat ?? zatOf(raw.valueBalance ?? 0);
    const fee = inputs.reduce((s, v) => s + v, 0) + vpubNew + balance - raw.vout.reduce((s, o) => s + voutZat(o), 0) - vpubOld;
    return { feeZat: fee };
  }

  /**
   * An address's balance, unspent outputs and recent history, from the node's address index.
   *
   * @param address - A transparent address of this network (validated by the caller).
   * @returns Balance, received, unspent outputs (largest first, capped), recent txids and mempool deltas.
   */
  async address(address: string): Promise<Record<string, unknown>> {
    const q = { addresses: [address] };
    try {
      const tip = await this.rpc.call<number>("getblockcount");
      const start = Math.max(1, tip - this.opts.historyWindowBlocks + 1);
      const balance = await this.rpc.call<{ balance: number; received: number }>("getaddressbalance", [q]);
      const utxos = await this.rpc.call<{ txid: string; outputIndex: number; satoshis: number; height: number }[]>("getaddressutxos", [q]);
      const txids = await this.rpc.call<string[]>("getaddresstxids", [{ ...q, start, end: tip }]);
      const mempool = await this.rpc.call<{ txid: string; satoshis: number }[]>("getaddressmempool", [q]);
      const sorted = [...utxos].sort((a, b) => b.satoshis - a.satoshis);
      const pendingIn = mempool.filter((m) => m.satoshis > 0).reduce((s, m) => s + m.satoshis, 0);
      const pendingOut = mempool.filter((m) => m.satoshis < 0).reduce((s, m) => s - m.satoshis, 0);
      return {
        address,
        tip,
        balanceZat: balance.balance,
        receivedZat: balance.received,
        utxoCount: utxos.length,
        utxos: sorted.slice(0, LIST_CAP).map((u) => ({ txid: u.txid, vout: u.outputIndex, valueZat: u.satoshis, height: u.height })),
        history: { fromHeight: start, toHeight: tip, count: txids.length, newestFirst: txids.slice(-LIST_CAP).reverse() },
        mempool: { count: mempool.length, incomingZat: pendingIn, outgoingZat: pendingOut, txids: [...new Set(mempool.map((m) => m.txid))].slice(0, LIST_CAP) },
      };
    } catch (e) {
      throw apiErrorOf(e, "address lookup");
    }
  }

  /**
   * A block by height or hash, with its chain value pools and transparent pools by type.
   *
   * @param id - A height (decimal) or a block hash (64 hex), validated by the caller.
   * @returns The trimmed block.
   */
  async block(id: string): Promise<Record<string, unknown>> {
    let hash = id;
    try {
      if (/^\d+$/.test(id)) hash = await this.rpc.call<string>("getblockhash", [Number(id)]);
    } catch (e) {
      const err = apiErrorOf(e, "block");
      if (err.status === 404) throw new ApiError(404, "not_found", "no block at that height");
      throw err;
    }
    let b: Record<string, unknown> & { tx?: string[] };
    try {
      b = await this.rpc.call<Record<string, unknown> & { tx?: string[] }>("getblock", [hash, 1]);
    } catch (e) {
      const err = apiErrorOf(e, "block");
      if (err.status === 404) throw new ApiError(404, "not_found", "no such block");
      throw err;
    }
    const txs = b.tx ?? [];
    const pick = (k: string): Record<string, unknown> => (b[k] !== undefined ? { [k]: b[k] } : {});
    return {
      ...pick("hash"),
      ...pick("height"),
      ...pick("confirmations"),
      ...pick("time"),
      ...pick("size"),
      ...pick("version"),
      ...pick("difficulty"),
      ...pick("bits"),
      ...pick("chainwork"),
      ...pick("previousblockhash"),
      ...pick("nextblockhash"),
      ...pick("blockfee"),
      ...pick("chainSupply"),
      ...pick("valuePools"),
      // beta3 nodes: the transparent pool split by type (design note N-2); older nodes lack it.
      ...(b.transparentPools !== undefined ? { transparentPools: b.transparentPools } : { transparentPools: null, transparentPoolsNote: "this node does not report transparent pools by type (a node before beta3)" }),
      txCount: txs.length,
      tx: txs.slice(0, LIST_CAP),
      ...(txs.length > LIST_CAP ? { truncated: `tx cut at ${LIST_CAP} entries` } : {}),
    };
  }

  /**
   * The chain in one answer: tip, difficulty, network solution rate, mempool size and fee picture.
   *
   * @returns The summary.
   */
  async chain(): Promise<Record<string, unknown>> {
    try {
      const info = await this.rpc.call<Record<string, unknown> & { upgrades?: Record<string, { name: string; activationheight: number; status: string }> }>("getblockchaininfo");
      const solps = await this.rpc.call<number>("getnetworksolps");
      const mem = await this.rpc.call<{ size: number; bytes: number; usage?: number }>("getmempoolinfo");
      const net = await this.rpc.call<{ relayfee?: number; subversion?: string }>("getnetworkinfo");
      const entries = await this.rpc.call<Record<string, { fee: number; size: number }>>("getrawmempool", [true]);
      const pick = (k: string): Record<string, unknown> => (info[k] !== undefined ? { [k]: info[k] } : {});
      return {
        ...pick("chain"),
        ...pick("testnetprofile"),
        ...pick("blocks"),
        ...pick("headers"),
        ...pick("bestblockhash"),
        ...pick("difficulty"),
        ...pick("verificationprogress"),
        ...pick("chainSupply"),
        ...pick("valuePools"),
        ...(info.transparentPools !== undefined ? { transparentPools: info.transparentPools } : {}),
        upgrades: Object.entries(info.upgrades ?? {}).map(([branch, u]) => ({ branch, name: u.name, activationHeight: u.activationheight, status: u.status })),
        networkSolPs: solps,
        node: net.subversion ?? null,
        mempool: { size: mem.size, bytes: mem.bytes, fees: feePicture(entries) },
        relayFeeZatPerKb: net.relayfee !== undefined ? zatOf(net.relayfee) : null,
      };
    } catch (e) {
      throw apiErrorOf(e, "chain summary");
    }
  }

  /**
   * Yellowback where the network has it: the Vault upgrade's status, the vault primitive's state
   * (`vault_getinfo`) and the YED module's reads (`yed_getinfo`, `yed_getprice`, `yed_getstats`).
   *
   * @returns The state, or `active: false` with the reason.
   */
  async yellowback(): Promise<Record<string, unknown>> {
    let upgrades: Record<string, { name: string; activationheight: number; status: string }>;
    try {
      upgrades = (await this.rpc.call<{ upgrades?: typeof upgrades }>("getblockchaininfo")).upgrades ?? {};
    } catch (e) {
      throw apiErrorOf(e, "Yellowback state");
    }
    const vault = upgrades[VAULT_BRANCH_ID];
    if (!vault || vault.status !== "active") {
      return {
        active: false,
        reason: "not active on this network: the vault network upgrade (branch 6d5b7a31) is " + (vault ? `${vault.status} (activation height ${vault.activationheight})` : "not scheduled on this node"),
      };
    }
    const read = async (method: "vault_getinfo" | "yed_getinfo" | "yed_getprice" | "yed_getstats"): Promise<Record<string, unknown>> => {
      try {
        return { available: true, result: await this.rpc.call<unknown>(method) };
      } catch (e) {
        if (e instanceof RpcError && e.code === RPC_METHOD_NOT_FOUND) return { available: false, reason: "the node does not run this module (-yellowback)" };
        if (e instanceof RpcError && !e.transport) return { available: false, reason: e.message };
        throw apiErrorOf(e, "Yellowback state");
      }
    };
    return {
      active: true,
      upgrade: { name: vault.name, activationHeight: vault.activationheight },
      vault: await read("vault_getinfo"),
      yed: { info: await read("yed_getinfo"), price: await read("yed_getprice"), stats: await read("yed_getstats") },
    };
  }

  /**
   * The paid relay: hands a signed transaction to the node's mempool. High fees are never allowed.
   *
   * @param hex - The raw transaction, validated hex (caller).
   * @returns The txid.
   */
  async broadcast(hex: string): Promise<{ txid: string }> {
    try {
      return { txid: await this.rpc.call<string>("sendrawtransaction", [hex]) };
    } catch (e) {
      if (e instanceof RpcError && !e.transport) throw new ApiError(422, "rejected", `the node refused the transaction: ${e.message}`);
      throw apiErrorOf(e, "broadcast");
    }
  }

  /**
   * The cheap liveness read behind /healthz (polled, never per request).
   *
   * @returns The tip height.
   */
  tip(): Promise<number> {
    return this.rpc.call<number>("getblockcount");
  }
}

/**
 * The mempool's fee picture from `getrawmempool true`: fee rates in zatoshis per 1000 bytes.
 *
 * @param entries - The verbose mempool.
 * @returns Count read, min, median, 90th percentile, max and the total of fees.
 */
export function feePicture(entries: Record<string, { fee: number; size: number }>): Record<string, unknown> {
  const all = Object.values(entries);
  const list = all.slice(0, MEMPOOL_SCAN_CAP);
  const rates = list.filter((e) => e.size > 0).map((e) => Math.round((zatOf(e.fee) * 1000) / e.size)).sort((a, b) => a - b);
  const at = (q: number): number | null => (rates.length === 0 ? null : (rates[Math.min(rates.length - 1, Math.floor(q * rates.length))] as number));
  return {
    read: list.length,
    ...(all.length > list.length ? { truncated: `fee rates from the first ${MEMPOOL_SCAN_CAP} entries` } : {}),
    totalFeesZat: list.reduce((s, e) => s + zatOf(e.fee), 0),
    rateZatPerKb: { min: at(0), median: at(0.5), p90: at(0.9), max: rates.length === 0 ? null : rates[rates.length - 1] },
  };
}
