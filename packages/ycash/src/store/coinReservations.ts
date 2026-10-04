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

/** A reservation is over once the spend can no longer be mined (expiry is inclusive, X-F8) or its time is up. */
export function reservationLapsed(r: CoinReservation, tip: number, now = Date.now()): boolean {
  if (r.expiryHeight > 0) return tip > r.expiryHeight;
  return r.untilMs !== undefined && now >= r.untilMs;
}

function heldByOther(get: (outpoint: string) => CoinReservation | undefined, outpoints: readonly string[], spentBy: string): boolean {
  return outpoints.some((o) => {
    const r = get(o);
    return r !== undefined && r.spentBy !== spentBy;
  });
}

export class InMemoryCoinReservationStore implements CoinReservationStore {
  private readonly held = new Map<string, CoinReservation>();

  async reserve(outpoints: readonly string[], r: CoinReservation): Promise<boolean> {
    if (heldByOther((o) => this.held.get(o), outpoints, r.spentBy)) return false;
    for (const o of outpoints) this.held.set(o, { ...r });
    return true;
  }

  async list(): Promise<Map<string, CoinReservation>> {
    return new Map([...this.held].map(([k, v]) => [k, { ...v }]));
  }

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

  constructor(path: string, opts?: JsonFileOptions) {
    this.file = new JsonFile<ReservationsDoc>(path, () => ({ version: 1, coins: {} }), opts);
  }

  reserve(outpoints: readonly string[], r: CoinReservation): Promise<boolean> {
    return this.file.update((doc) => {
      if (heldByOther((o) => (Object.hasOwn(doc.coins, o) ? doc.coins[o] : undefined), outpoints, r.spentBy)) return { result: false, write: false };
      for (const o of outpoints) doc.coins[o] = { ...r };
      return { result: true, write: true };
    });
  }

  async list(): Promise<Map<string, CoinReservation>> {
    return new Map(Object.entries((await this.file.read()).coins));
  }

  release(outpoints: readonly string[]): Promise<void> {
    return this.file.update((doc) => {
      const present = outpoints.filter((o) => Object.hasOwn(doc.coins, o));
      for (const o of present) delete doc.coins[o];
      return { result: undefined, write: present.length > 0 };
    });
  }
}
