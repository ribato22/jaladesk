// "Remember unlock" without storing the password: the document key (DEK) is sealed by the operating system's keystore
// (Electron safeStorage: Keychain on macOS, DPAPI on Windows) and kept in the app's private data folder, bound to the file's key
// fingerprint, so a password change makes the cached key useless. This is a convenience, not the portable protection: the portable
// file stays protected by the password alone, and safeStorage does not protect against other apps running as the same user.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SecretBox { available(): boolean; seal(plain: Buffer): Buffer; open(blob: Buffer): Buffer }
export interface KeyCache {
  put(docId: string, fingerprint: string, key: Buffer): Promise<boolean>;
  get(docId: string, fingerprint: string): Promise<Buffer | undefined>;
  forget(docId: string): Promise<void>;
}

export function makeKeyCache(box: SecretBox, dir: string): KeyCache {
  const file = (docId: string) => join(dir, `${createHash('sha256').update(docId).digest('hex').slice(0, 32)}.key`);
  return {
    async put(docId, fingerprint, key) {
      if (!box.available()) return false;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file(docId)}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify({ v: 1, fp: fingerprint, blob: box.seal(key).toString('base64') }), { mode: 0o600 });
        await rename(tmp, file(docId));
      } catch (error) {
        await unlink(tmp).catch(() => undefined); // nothing is left of a write that did not happen
        throw error;
      }
      return true;
    },
    async get(docId, fingerprint) {
      const path = file(docId);
      let text: string;
      try { text = await readFile(path, 'utf8'); } catch { return undefined; } // no key is kept for this file (or it cannot be read): ask for the password
      const useless = async (): Promise<undefined> => { await unlink(path).catch(() => undefined); return undefined; }; // a key that can never be used again is not kept
      let entry: { v?: unknown; fp?: unknown; blob?: unknown } | null;
      try { entry = JSON.parse(text) as typeof entry; } catch { return useless(); }
      if (typeof entry !== 'object' || entry === null || entry.v !== 1 || typeof entry.fp !== 'string' || typeof entry.blob !== 'string') return useless();
      if (entry.fp !== fingerprint) return useless(); // the file was made again with another password
      if (!box.available()) return undefined;
      try { return box.open(Buffer.from(entry.blob, 'base64')); } catch { return undefined; } // sealed by another user, or the keychain refused just now: ask for the password, and keep the key for a time it works
    },
    async forget(docId) { await unlink(file(docId)).catch((error: unknown) => { if ((error as { code?: unknown }).code !== 'ENOENT') throw error; }); }, // no file is nothing to forget; a file that stays is not forgotten
  };
}
