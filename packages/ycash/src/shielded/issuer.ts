// Where a `sapling-proof` server gets its per-request addresses (plan X4-M verdict (ii)). Two ways:
// the merchant's spending-key wallet (`z_getnewdiversifiedaddress`), or offline from the full viewing
// key, so the request path holds no spending key and needs no wallet at all.
import { createHash } from "node:crypto";
import type { YcashNetwork } from "../constants.js";
import { JsonFile, type JsonFileOptions } from "../store/index.js";
import { SAPLING_HRP } from "./constants.js";
import { decodeSaplingViewingKey, findSaplingAddress, MAX_DIVERSIFIER_INDEX, type SaplingIncomingKey } from "./sapling/address.js";

export type AddressIssuerKind = "node-wallet" | "offline";

/** A source of Sapling addresses, each handed out once. */
export interface AddressIssuer {
  readonly kind: AddressIssuerKind;
  /** A fresh diversified address of `network`. */
  issue(network: YcashNetwork): Promise<string>;
}

/** The wallet calls the node-wallet issuer makes. `YcashRpc` satisfies it. */
export interface NodeWalletIssuerRpc {
  zGetNewAddress(): Promise<string>;
  zGetNewDiversifiedAddress(base: string): Promise<string>;
}

/**
 * Issues from the merchant's wallet, which must hold the base address's spending key: both lines
 * refuse a diversified address without it (`ycash-dd/src/wallet/rpcdump.cpp:869-870`,
 * `ycash6/src/wallet/rpcdump.cpp:1425-1427`).
 */
export class NodeWalletIssuer implements AddressIssuer {
  readonly kind = "node-wallet" as const;
  private basePromise: Promise<string> | undefined;

  /** `baseAddress` default: one `z_getnewaddress sapling`, made once. */
  constructor(
    private readonly rpc: NodeWalletIssuerRpc,
    baseAddress?: string,
  ) {
    if (baseAddress) this.basePromise = Promise.resolve(baseAddress);
  }

  private base(): Promise<string> {
    this.basePromise ??= this.rpc.zGetNewAddress().catch((e: unknown) => {
      this.basePromise = undefined;
      throw e;
    });
    return this.basePromise;
  }

  async issue(network: YcashNetwork): Promise<string> {
    const base = await this.base();
    const hrp = SAPLING_HRP[network] + "1";
    if (!base.startsWith(hrp)) throw new Error(`base address ${base} is not a ${network} Sapling address`);
    return this.rpc.zGetNewDiversifiedAddress(base);
  }
}

/**
 * The default first index of the offline range. Both wallets walk upward from a low index:
 * v4.5.0 from 1, skipping addresses it holds (`ycash-dd/src/wallet/rpcdump.cpp:877-905`), 6.21.0
 * from the base address's index (`ycash6/src/wallet/rpcdump.cpp:1432-1468`). From 2^40 the ranges
 * never meet in practice (plan X-F49).
 */
export const OFFLINE_ISSUER_DEFAULT_START = 1n << 40n;
/** Below this the offline range could meet a wallet's walk; refused. */
export const OFFLINE_ISSUER_MIN_START = 1n << 32n;

/** The index file: the next index to try, bound to the key it belongs to. */
interface IndexDoc {
  v: 1;
  /** sha256(ivk || dk), first 16 hex: refuses a file that belongs to another key ("" before the first issue) */
  key: string;
  /** decimal; the next diversifier index to try */
  next: string;
}

export interface OfflineAddressIssuerConfig {
  /** The merchant's Sapling viewing key, as `z_exportviewingkey` prints it (`zxview…`). */
  viewingKey: string;
  /** The network the key and every issued address belong to (their HRPs are per network). */
  network: YcashNetwork;
  /** Where the next index is kept, so a restart never reissues an address. */
  indexPath: string;
  /** The first index when the file is new (default 2^40; at least 2^32). */
  startIndex?: bigint;
  /** Lock options of the index file. */
  fileOptions?: JsonFileOptions;
}

/** A short fingerprint of the key's incoming half, stored in the index file. */
export function incomingKeyFingerprint(key: SaplingIncomingKey): string {
  const ivk = Buffer.from(key.ivk.toString(16).padStart(64, "0"), "hex");
  return createHash("sha256").update(ivk).update(key.dk).digest("hex").slice(0, 16);
}

/**
 * Derives addresses from the full viewing key (sapling/address.ts) at indices from `startIndex`
 * upward. The next index is written, under the file's lock, before an address is returned: a crash
 * can skip an index, never reuse one. Several processes may share the file.
 */
export class OfflineAddressIssuer implements AddressIssuer {
  readonly kind = "offline" as const;
  readonly network: YcashNetwork;
  private readonly key: SaplingIncomingKey;
  private readonly fingerprint: string;
  private readonly start: bigint;
  private readonly file: JsonFile<IndexDoc>;

  constructor(config: OfflineAddressIssuerConfig) {
    this.network = config.network;
    this.key = decodeSaplingViewingKey(config.viewingKey, config.network);
    this.fingerprint = incomingKeyFingerprint(this.key);
    this.start = config.startIndex ?? OFFLINE_ISSUER_DEFAULT_START;
    if (this.start < OFFLINE_ISSUER_MIN_START || this.start > MAX_DIVERSIFIER_INDEX) {
      throw new RangeError(`startIndex must be in [2^32, 2^88): the wallets walk the low indices (got ${this.start})`);
    }
    this.file = new JsonFile<IndexDoc>(config.indexPath, () => ({ v: 1, key: "", next: "" }), config.fileOptions);
  }

  /** The address at index 0, which `z_getnewaddress sapling` returned for this key: a check that key and node agree. */
  defaultAddress(): string {
    return findSaplingAddress(this.key, 0n).address;
  }

  async issue(network: YcashNetwork): Promise<string> {
    if (network !== this.network) throw new Error(`this issuer's key is a ${this.network} key, not ${network}`);
    return this.file.update((doc) => {
      if (doc.key && doc.key !== this.fingerprint) throw new Error(`${this.file.path} belongs to another viewing key`);
      const found = findSaplingAddress(this.key, doc.key ? BigInt(doc.next) : this.start);
      Object.assign(doc, { v: 1, key: this.fingerprint, next: (found.index + 1n).toString() });
      return { result: found.address, write: true };
    });
  }

  /** The next index the file holds, or the start index when there is no file yet. */
  async nextIndex(): Promise<bigint> {
    const doc = await this.file.read();
    return doc.key ? BigInt(doc.next) : this.start;
  }
}
