// The keys that the system remembers for documents ("Ingat di komputer ini"), seen from the application: whether they may be used at all, how many there are, and forgetting them. The sealing itself is the
// operating system's (Electron's safeStorage: the Keychain on macOS, DPAPI on Windows) behind the `SecretBox` of documents/safestorage.ts, and the files are those of the key cache of documents/keywrap.ts
// (one per document file, bound to the key the file holds); what is added here is the rule that makes the feature safe to have in the application: it is off until the person turns it on, and the system's
// keystore is not asked anything until then (asking can bring up a prompt of the system, and a test or a person who never turned it on must never see one). Forgetting only deletes files and so needs no keystore.
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { makeKeyCache, type KeyCache, type SecretBox } from '../documents/keywrap.js';

export type KeystoreDeps = {
  /** The seal of the system (electronSecretBox(safeStorage) in main.ts). */
  box: SecretBox;
  /** The folder of the key files, in the data folder of the application. */
  dir: string;
  /** Whether the person allows keys to be remembered (the setting `keys.allow`). */
  allowed(): boolean;
};
// what the key cache writes: a key, and the file it is written through before it is renamed into place
const KEY_FILE = /^[0-9a-f]{32}\.key$/;
const LEFTOVER = /^[0-9a-f]{32}\.key\.[0-9a-f]{12}\.tmp$/;
const isMissing = (error: unknown): boolean => (error as { code?: unknown }).code === 'ENOENT';

export class Keystore {
  /** The key cache of the documents. What it does to the files is followed here: the number of keys is counted again after every call that may have changed it. */
  readonly cache: KeyCache;
  #known = 0;
  readonly #listeners = new Set<() => void>();
  constructor(private readonly deps: KeystoreDeps) {
    const inner = makeKeyCache(deps.box, deps.dir);
    this.cache = {
      put: async (docId, fingerprint, key) => { try { return await inner.put(docId, fingerprint, key); } finally { await this.refresh(); } },
      get: async (docId, fingerprint) => { const found = await inner.get(docId, fingerprint); if (!found) await this.refresh(); return found; },      // a lookup may find a key stale and delete it
      forget: async (docId) => { try { await inner.forget(docId); } finally { await this.refresh(); } },
    };
  }

  /** How many keys are remembered, as far as is known without asking the disk: counted at `refresh()` and after every change made through this keystore. The menu asks this, often. */
  known(): number { return this.#known; }

  /** Counts the keys on the disk again, and tells those who follow when the number is another. A folder that cannot be read leaves the number as it was. */
  async refresh(): Promise<void> {
    let count: number;
    try { count = await this.count(); } catch { return; }
    if (count === this.#known) return;
    this.#known = count;
    for (const listener of [...this.#listeners]) { try { listener(); } catch { /* a follower that fails is its own trouble */ } }
  }

  /** `listener` is told when the number of keys is another; the function that comes back stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Whether the system can seal a key at all; a keystore that falls over is none. Asking can bring up a prompt of the system, so this is asked only once the person has allowed keys (or is turning them on). */
  available(): boolean {
    try { return this.deps.box.available(); } catch { return false; }
  }

  /** Whether keys are remembered and used now: the person allows it and the system can seal. The system is not asked while it is not allowed. */
  usable(): boolean {
    try { return this.deps.allowed() && this.available(); } catch { return false; }
  }

  /** How many keys are remembered. */
  async count(): Promise<number> { return (await this.names()).filter((name) => KEY_FILE.test(name)).length; }

  /** Forgets the key of one file; says whether there was one. */
  async forget(path: string): Promise<boolean> {
    const before = await this.count();
    await this.cache.forget(path);
    return (await this.count()) < before;
  }

  /**
   * Forgets every key, and the leftovers of writes that stopped; says how many keys it deleted. Files that are not the key cache's are left alone. A file that cannot be deleted does not keep the others
   * from being deleted, and is an error at the end: this never says it forgot what it did not.
   */
  async forgetAll(): Promise<number> {
    let keys = 0;
    let failure: unknown;
    try {
      for (const name of await this.names()) {
        const key = KEY_FILE.test(name);
        if (!key && !LEFTOVER.test(name)) continue;
        try { await unlink(join(this.deps.dir, name)); if (key) keys++; } catch (error) { if (!isMissing(error)) failure ??= error; }
      }
    } finally { await this.refresh(); }
    if (failure !== undefined) throw failure;
    return keys;
  }

  /** The names in the folder of the keys: none when there is no folder; a folder that cannot be read is an error, not "no keys". */
  private async names(): Promise<string[]> {
    try { return await readdir(this.deps.dir); } catch (error) { if (isMissing(error) || (error as { code?: unknown }).code === 'ENOTDIR') return []; throw error; }
  }
}
