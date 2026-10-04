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

  constructor(path: string, opts?: JsonFileOptions) {
    this.file = new JsonFile<ClaimsDoc>(path, () => ({ version: 1, claims: {} }), opts);
  }

  async claim(key: string, retainUntilHeight: number): Promise<boolean> {
    checkRetainUntil(retainUntilHeight);
    return this.file.update((doc) => {
      if (Object.hasOwn(doc.claims, key)) return { result: false, write: false };
      doc.claims[key] = retainUntilHeight === RETAIN_FOREVER ? null : retainUntilHeight;
      return { result: true, write: true };
    });
  }

  release(key: string): Promise<void> {
    return this.file.update((doc) => {
      if (!Object.hasOwn(doc.claims, key)) return { result: undefined, write: false };
      delete doc.claims[key];
      return { result: undefined, write: true };
    });
  }

  async isClaimed(key: string): Promise<boolean> {
    return Object.hasOwn((await this.file.read()).claims, key);
  }

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
