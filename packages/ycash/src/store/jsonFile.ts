import { randomBytes } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";

export interface JsonFileOptions {
  /** A lock older than this is taken to belong to a crashed process and is broken (default 30 s). */
  staleLockMs?: number;
  /** Give up acquiring the lock after this long (default 10 s). */
  lockTimeoutMs?: number;
}

/**
 * One JSON document on disk, updated under an O_EXCL lock file so that read-modify-write is atomic
 * across processes. Writes go to a temporary file that is fsynced and renamed over the document, so a
 * reader without the lock always sees a whole document and a crash never leaves a torn one.
 */
export class JsonFile<T> {
  readonly path: string;
  private readonly lockPath: string;
  private readonly staleLockMs: number;
  private readonly lockTimeoutMs: number;
  private readonly empty: () => T;

  /**
   * Binds the document at `path`; nothing is read or created until first use.
   *
   * @param path - The document's path; the lock is `<path>.lock`.
   * @param empty - The document to use while the file does not exist.
   * @param opts - Lock timing.
   */
  constructor(path: string, empty: () => T, opts: JsonFileOptions = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.empty = empty;
    this.staleLockMs = opts.staleLockMs ?? 30_000;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;
  }

  /**
   * Reads the document without the lock (safe: writes are atomic renames).
   *
   * @returns The parsed document, or `empty()` when the file does not exist.
   */
  async read(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw e;
    }
  }

  /**
   * Runs fn on the current document under the lock; writes it back when fn returns `write: true`.
   *
   * @param fn - Mutates the document in place and says whether to persist it.
   * @returns The `result` fn returned.
   * @throws Error when the lock cannot be acquired within `lockTimeoutMs`.
   */
  async update<R>(fn: (doc: T) => { result: R; write: boolean }): Promise<R> {
    const token = await this.lock();
    try {
      const doc = await this.read();
      const { result, write } = fn(doc);
      if (write) await this.write(doc);
      return result;
    } finally {
      await this.unlock(token);
    }
  }

  /**
   * Writes the document to a fsynced temporary file and renames it over the document.
   *
   * @param doc - The document.
   */
  private async write(doc: T): Promise<void> {
    const tmp = `${this.path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(doc));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
  }

  /**
   * Acquires the O_EXCL lock file, backing off up to 20 ms between attempts and breaking stale locks.
   *
   * @returns The random token written into the lock, needed to release it.
   * @throws Error when `lockTimeoutMs` passes.
   */
  private async lock(): Promise<string> {
    const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let wait = 1;
    for (;;) {
      try {
        const fh = await open(this.lockPath, "wx");
        try {
          await fh.writeFile(token);
        } finally {
          await fh.close();
        }
        return token;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      await this.breakIfStale();
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${this.lockPath}`);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 20);
    }
  }

  /**
   * Removes the lock only if it is still ours: if it was broken as stale, someone else may hold it now.
   *
   * @param token - The token {@link JsonFile.lock} returned.
   */
  private async unlock(token: string): Promise<void> {
    try {
      if ((await readFile(this.lockPath, "utf8")) === token) await unlink(this.lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  /**
   * Breaks a lock left by a crashed holder. The lock is renamed aside rather than unlinked, then
   * checked: if what was moved is not the stale lock that was inspected (another process broke it
   * and took a fresh one in between), it is linked back.
   */
  private async breakIfStale(): Promise<void> {
    let seen: string;
    try {
      const st = await stat(this.lockPath);
      if (Date.now() - st.mtimeMs < this.staleLockMs) return;
      seen = await readFile(this.lockPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    const aside = `${this.lockPath}.stale.${randomBytes(4).toString("hex")}`;
    try {
      await rename(this.lockPath, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if ((await readFile(aside, "utf8")) !== seen) {
      await link(aside, this.lockPath).catch(() => undefined);
    }
    await unlink(aside);
  }
}
