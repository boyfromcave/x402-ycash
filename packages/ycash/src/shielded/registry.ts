// The issued-address registry of a `sapling-proof` server: which per-request addresses it issued,
// and the request record behind each (spec, "sapling-proof": an address is never issued twice; the
// server holds every record at least until expiresAt plus the time the policy depth takes).
import { BLOCK_SECONDS } from "../constants.js";
import { JsonFile, type JsonFileOptions } from "../store/index.js";
import type { RequestRecord } from "./request.js";

/** What the server remembers about one issued address. */
export interface IssuedRequest {
  record: RequestRecord;
  /** extra.memo, "x402:" + request hash */
  memo: string;
  /** extra.confirmationPolicy.confirmations in force for this request */
  confirmations: number;
  /** Unix seconds */
  issuedAt: number;
  /** Unix seconds after which the record may be pruned (the address itself is never forgotten) */
  retainUntil: number;
}

/**
 * The retention bound of a record: expiresAt, plus twice the time the policy depth takes at the
 * 75-second target spacing (blocks are Poisson, so one spacing per confirmation is only the mean),
 * plus a grace period for a slow client or merchant node.
 */
export function recordRetainUntil(expiresAt: number, confirmations: number, graceSeconds: number): number {
  return expiresAt + 2 * Math.max(confirmations, 1) * BLOCK_SECONDS + graceSeconds;
}

export interface IssuedAddressRegistry {
  /** Records an issued address; false if the address was ever issued before (it must not be reused). */
  issue(payTo: string, request: IssuedRequest): Promise<boolean>;
  /** The record for `payTo`, while it is held. */
  get(payTo: string): Promise<IssuedRequest | undefined>;
  /** True if `payTo` was ever issued, even after its record was pruned. */
  wasIssued(payTo: string): Promise<boolean>;
  /** Records still held (for an issuance limit). */
  outstanding(nowSeconds: number): Promise<number>;
  /** Drops records whose retainUntil is before `nowSeconds`; keeps the addresses. Returns how many. */
  prune(nowSeconds: number): Promise<number>;
}

/** Process-local registry: tests, or a single process whose restart may forget open requests. */
export class InMemoryIssuedAddressRegistry implements IssuedAddressRegistry {
  private readonly records = new Map<string, IssuedRequest>();
  private readonly issued = new Set<string>();

  async issue(payTo: string, request: IssuedRequest): Promise<boolean> {
    if (this.issued.has(payTo)) return false;
    this.issued.add(payTo);
    this.records.set(payTo, request);
    return true;
  }

  async get(payTo: string): Promise<IssuedRequest | undefined> {
    return this.records.get(payTo);
  }

  async wasIssued(payTo: string): Promise<boolean> {
    return this.issued.has(payTo);
  }

  async outstanding(nowSeconds: number): Promise<number> {
    let n = 0;
    for (const r of this.records.values()) if (r.retainUntil >= nowSeconds) n++;
    return n;
  }

  async prune(nowSeconds: number): Promise<number> {
    let n = 0;
    for (const [k, r] of this.records) {
      if (r.retainUntil < nowSeconds) {
        this.records.delete(k);
        n++;
      }
    }
    return n;
  }
}

interface RegistryDoc {
  version: 1;
  records: Record<string, IssuedRequest>;
  /** Pruned addresses, kept so that none is ever issued again. */
  retired: string[];
}

/** A registry in one JSON file, restart-durable and safe across processes on one host. */
export class FileIssuedAddressRegistry implements IssuedAddressRegistry {
  private readonly file: JsonFile<RegistryDoc>;

  constructor(path: string, opts?: JsonFileOptions) {
    this.file = new JsonFile<RegistryDoc>(path, () => ({ version: 1, records: {}, retired: [] }), opts);
  }

  issue(payTo: string, request: IssuedRequest): Promise<boolean> {
    return this.file.update((doc) => {
      if (Object.hasOwn(doc.records, payTo) || doc.retired.includes(payTo)) return { result: false, write: false };
      doc.records[payTo] = request;
      return { result: true, write: true };
    });
  }

  async get(payTo: string): Promise<IssuedRequest | undefined> {
    const doc = await this.file.read();
    return Object.hasOwn(doc.records, payTo) ? doc.records[payTo] : undefined;
  }

  async wasIssued(payTo: string): Promise<boolean> {
    const doc = await this.file.read();
    return Object.hasOwn(doc.records, payTo) || doc.retired.includes(payTo);
  }

  async outstanding(nowSeconds: number): Promise<number> {
    const doc = await this.file.read();
    return Object.values(doc.records).filter((r) => r.retainUntil >= nowSeconds).length;
  }

  prune(nowSeconds: number): Promise<number> {
    return this.file.update((doc) => {
      let n = 0;
      for (const [k, r] of Object.entries(doc.records)) {
        if (r.retainUntil < nowSeconds) {
          delete doc.records[k];
          doc.retired.push(k);
          n++;
        }
      }
      return { result: n, write: n > 0 };
    });
  }
}
