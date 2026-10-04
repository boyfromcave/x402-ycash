import { JsonFile, type JsonFileOptions } from "./jsonFile.js";

/**
 * Why a coin is held: a local-key client signs a spend and hands it to someone else to broadcast
 * (the facilitator, the channel server), often through another node. Until the client's own node
 * sees that spend, `gettxout(…, true)` still reports the coin unspent, so the next payment, in this
 * process or the next, would pick it again and be refused as a conflict (rule 6, X-F10).
 */
export interface CoinReservation {
  /** txid of the signed spend holding the coin */
  spentBy: string;
  /** that spend's nExpiryHeight; 0 when it never expires (a channel funding), see `untilMs` */
  expiryHeight: number;
  /** wall-clock release (ms since the epoch) for a spend that never expires */
  untilMs?: number;
}

/** Coins held by signed, not yet confirmed spends, keyed by outpoint (`txid:vout`). */
export interface CoinReservationStore {
  /** Holds every outpoint for one spend, all or none; false if any is held by another spend. */
  reserve(outpoints: readonly string[], r: CoinReservation): Promise<boolean>;
  list(): Promise<Map<string, CoinReservation>>;
  release(outpoints: readonly string[]): Promise<void>;
}

/**
 * A reservation is over once the spend can no longer be mined (expiry is inclusive, X-F8) or its time is up.
 *
 * @param r - The reservation.
 * @param tip - The current chain height.
 * @param now - The current time, ms since the epoch.
 * @returns Whether the coin may be spent again.
 */
export function reservationLapsed(r: CoinReservation, tip: number, now = Date.now()): boolean {
  if (r.expiryHeight > 0) return tip > r.expiryHeight;
  return r.untilMs !== undefined && now >= r.untilMs;
}

/**
 * The outpoints still held at `tip`. Releases those whose spend lapsed and, given `spentInBlock`
 * (`gettxout(…, false)` is null), those a block already spent: the spend confirmed.
 *
 * @param store - The reservation store.
 * @param tip - The current chain height.
 * @param spentInBlock - Optional check whether a block has spent an outpoint.
 * @returns The outpoints (`txid:vout`) still held.
 */
export async function heldOutpoints(store: CoinReservationStore, tip: number, spentInBlock?: (txid: string, vout: number) => Promise<boolean>): Promise<Set<string>> {
  const all = await store.list();
  const held = new Set<string>();
  const over: string[] = [];
  for (const [o, r] of all) {
    const [txid, vout] = o.split(":") as [string, string];
    if (reservationLapsed(r, tip) || (spentInBlock && (await spentInBlock(txid, Number(vout))))) over.push(o);
    else held.add(o);
  }
  if (over.length > 0) await store.release(over);
  return held;
}

/**
 * Whether any of `outpoints` is held by a spend other than `spentBy`; re-reserving for the same
 * spend is allowed.
 *
 * @param get - Looks up an outpoint's reservation.
 * @param outpoints - The outpoints to reserve.
 * @param spentBy - The txid of the spend reserving them.
 * @returns True when another spend holds one of them.
 */
function heldByOther(get: (outpoint: string) => CoinReservation | undefined, outpoints: readonly string[], spentBy: string): boolean {
  return outpoints.some((o) => {
    const r = get(o);
    return r !== undefined && r.spentBy !== spentBy;
  });
}

/** Process-local reservations: a single client process, or tests. */
export class InMemoryCoinReservationStore implements CoinReservationStore {
  private readonly held = new Map<string, CoinReservation>();

  /**
   * Holds every outpoint for one spend, all or none.
   *
   * @param outpoints - The outpoints (`txid:vout`) the spend consumes.
   * @param r - The reservation.
   * @returns False when another spend holds any of them.
   */
  async reserve(outpoints: readonly string[], r: CoinReservation): Promise<boolean> {
    if (heldByOther((o) => this.held.get(o), outpoints, r.spentBy)) return false;
    for (const o of outpoints) this.held.set(o, { ...r });
    return true;
  }

  /**
   * Lists every reservation, lapsed or not.
   *
   * @returns Copies keyed by outpoint.
   */
  async list(): Promise<Map<string, CoinReservation>> {
    return new Map([...this.held].map(([k, v]) => [k, { ...v }]));
  }

  /**
   * Drops the reservations of `outpoints`.
   *
   * @param outpoints - The outpoints to release; unknown ones are ignored.
   */
  async release(outpoints: readonly string[]): Promise<void> {
    for (const o of outpoints) this.held.delete(o);
  }
}

interface ReservationsDoc {
  version: 1;
  coins: Record<string, CoinReservation>;
}

/** Reservations in one JSON file, shared by every agent process using the same key on one host. */
export class FileCoinReservationStore implements CoinReservationStore {
  private readonly file: JsonFile<ReservationsDoc>;

  /**
   * Opens (lazily) the store at `path`; the file is created on the first write.
   *
   * @param path - The JSON document's path.
   * @param opts - Lock timing.
   */
  constructor(path: string, opts?: JsonFileOptions) {
    this.file = new JsonFile<ReservationsDoc>(path, () => ({ version: 1, coins: {} }), opts);
  }

  /**
   * Holds every outpoint for one spend, all or none, under the file lock.
   *
   * @param outpoints - The outpoints (`txid:vout`) the spend consumes.
   * @param r - The reservation.
   * @returns False when another spend holds any of them.
   */
  reserve(outpoints: readonly string[], r: CoinReservation): Promise<boolean> {
    return this.file.update((doc) => {
      if (heldByOther((o) => (Object.hasOwn(doc.coins, o) ? doc.coins[o] : undefined), outpoints, r.spentBy)) return { result: false, write: false };
      for (const o of outpoints) doc.coins[o] = { ...r };
      return { result: true, write: true };
    });
  }

  /**
   * Lists every reservation, lapsed or not, without taking the lock.
   *
   * @returns The reservations keyed by outpoint.
   */
  async list(): Promise<Map<string, CoinReservation>> {
    return new Map(Object.entries((await this.file.read()).coins));
  }

  /**
   * Drops the reservations of `outpoints` under the file lock.
   *
   * @param outpoints - The outpoints to release; unknown ones are ignored.
   * @returns Resolves once the document is written.
   */
  release(outpoints: readonly string[]): Promise<void> {
    return this.file.update((doc) => {
      const present = outpoints.filter((o) => Object.hasOwn(doc.coins, o));
      for (const o of present) delete doc.coins[o];
      return { result: undefined, write: present.length > 0 };
    });
  }
}
