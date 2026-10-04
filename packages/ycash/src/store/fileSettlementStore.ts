import { JsonFile, type JsonFileOptions } from "./jsonFile.js";
import { RETAIN_FOREVER, checkRetainUntil, type SettlementStore } from "./settlementStore.js";

interface ClaimsDoc {
  version: 1;
  /** key -> retainUntilHeight; null is RETAIN_FOREVER (JSON has no Infinity). */
  claims: Record<string, number | null>;
}

/**
 * A settlement store in one JSON file, safe across processes on one host (O_EXCL lock, atomic
 * rename). For several hosts use a shared database with the same interface.
 */
export class FileSettlementStore implements SettlementStore {
  private readonly file: JsonFile<ClaimsDoc>;

  /**
   * Opens (lazily) the store at `path`; the file is created on the first write.
   *
   * @param path - The JSON document's path.
   * @param opts - Lock timing.
   */
  constructor(path: string, opts?: JsonFileOptions) {
    this.file = new JsonFile<ClaimsDoc>(path, () => ({ version: 1, claims: {} }), opts);
  }

  /**
   * Takes `key` under the file lock.
   *
   * @param key - The consumption key.
   * @param retainUntilHeight - The last height the claim must survive, or RETAIN_FOREVER.
   * @returns False when the key is already claimed.
   * @throws Error when `retainUntilHeight` is neither an integer nor RETAIN_FOREVER.
   */
  async claim(key: string, retainUntilHeight: number): Promise<boolean> {
    checkRetainUntil(retainUntilHeight);
    return this.file.update((doc) => {
      if (Object.hasOwn(doc.claims, key)) return { result: false, write: false };
      doc.claims[key] = retainUntilHeight === RETAIN_FOREVER ? null : retainUntilHeight;
      return { result: true, write: true };
    });
  }

  /**
   * Gives a claim back under the file lock.
   *
   * @param key - The consumption key; an unclaimed key is ignored.
   * @returns Resolves once the document is written.
   */
  release(key: string): Promise<void> {
    return this.file.update((doc) => {
      if (!Object.hasOwn(doc.claims, key)) return { result: undefined, write: false };
      delete doc.claims[key];
      return { result: undefined, write: true };
    });
  }

  /**
   * Checks a key without taking the lock.
   *
   * @param key - The consumption key.
   * @returns Whether it is claimed.
   */
  async isClaimed(key: string): Promise<boolean> {
    return Object.hasOwn((await this.file.read()).claims, key);
  }

  /**
   * Drops every claim whose retention height is below `currentHeight`; RETAIN_FOREVER claims stay.
   *
   * @param currentHeight - The chain tip height.
   * @returns How many claims were dropped.
   */
  prune(currentHeight: number): Promise<number> {
    return this.file.update((doc) => {
      let n = 0;
      for (const [key, until] of Object.entries(doc.claims)) {
        if (until !== null && until < currentHeight) {
          delete doc.claims[key];
          n++;
        }
      }
      return { result: n, write: n > 0 };
    });
  }
}
