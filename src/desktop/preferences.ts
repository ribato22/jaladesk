// What a person chose for themselves on this computer, as opposed to what the shared document says: which objects are favourites, and whether a document saves by itself. One small JSON
// file in the application's data folder, keyed by the id of the DOCUMENT (not the session and not the file name, so a document that is moved or renamed keeps
// its favourites). Only ids (and the name of a mode of saving) are stored: no names, hosts, notes or secrets. The file is version 1 while no document saves by itself, so that
// a version of the app that does not know about it reads it; with a choice in it, it is version 2. A favourite is never forgotten because an object is not in the file that was opened
// (another copy of the same document, an older one, may have it); the ids of objects that are gone cost a few bytes and are never told to the window.
// A file that cannot be understood is set aside (kept, not deleted) and the preferences start empty; one that a newer version of the app wrote is left alone and the
// favourites are unavailable; a change is written whole and atomically (a temporary file, then a rename), one change after the other, starting from what the file
// holds at that moment (another copy of the app may have written it since).
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { realFs, type StoreFs } from '../documents/store.js';

export const MAX_DOCUMENTS = 500;
export const MAX_FAVORITES = 5000; // per document

export type PreferencesErrorCode = 'invalid' | 'too-many' | 'too-new' | 'io';
export class PreferencesError extends Error {
  constructor(readonly code: PreferencesErrorCode, message: string, readonly cause?: unknown) { super(message); this.name = 'PreferencesError'; }
}
export type PreferencesOptions = { fs?: StoreFs; maxDocuments?: number; maxFavorites?: number };
/** When a document saves by itself: when it is closed, or a few seconds after the last edit. "Off" (the default) is not stored. */
export type AutosaveMode = 'close' | 'edit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Favorites = Map<string, string[]>; // by document id; the order of the entries is the order they were last chosen from, oldest first
type Autosave = Map<string, AutosaveMode>; // by document id
type Limits = { documents: number; favorites: number };
/** What a file holds: preferences this app wrote, preferences a newer version wrote, nothing (the file is not there), or something that is neither. */
type Loaded = { kind: 'good'; favorites: Favorites; autosave: Autosave } | { kind: 'new' } | { kind: 'missing' } | { kind: 'damaged' };

function parse(text: string, limits: Limits): Loaded {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { kind: 'damaged' }; }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { kind: 'damaged' };
  const version = (data as { version?: unknown }).version;
  if (typeof version === 'number' && version > 2) return { kind: 'new' };
  const raw = (data as { favorites?: unknown }).favorites;
  if ((version !== 1 && version !== 2) || typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > limits.documents) return { kind: 'damaged' };
  const found: Favorites = new Map();
  for (const [doc, list] of Object.entries(raw)) {
    if (!UUID.test(doc) || !Array.isArray(list) || list.length > limits.favorites || list.some((x) => typeof x !== 'string' || !UUID.test(x)) || new Set(list).size !== list.length) return { kind: 'damaged' };
    if (list.length > 0) found.set(doc, [...list]);
  }
  const autosave: Autosave = new Map();
  if (version === 2) {
    const choices = (data as { autosave?: unknown }).autosave;
    if (typeof choices !== 'object' || choices === null || Array.isArray(choices) || Object.keys(choices).length > limits.documents) return { kind: 'damaged' };
    for (const [doc, mode] of Object.entries(choices)) {
      if (!UUID.test(doc) || (mode !== 'close' && mode !== 'edit')) return { kind: 'damaged' };
      autosave.set(doc, mode);
    }
  }
  return { kind: 'good', favorites: found, autosave };
}

async function load(fs: StoreFs, path: string, limits: Limits): Promise<Loaded> {
  let text: string;
  try { text = (await fs.readFile(path)).toString('utf8'); } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    throw new PreferencesError('io', 'The preferences cannot be read', error);
  }
  return parse(text, limits);
}

/** Moves a file that cannot be understood out of the way, keeping it. When it cannot be moved it stays, and that is an error: it is not written over. */
async function setAside(fs: StoreFs, path: string): Promise<string> {
  const kept = `${path}.bad-${Date.now()}`;
  try { await fs.rename(path, kept); } catch (error) { throw new PreferencesError('io', 'The damaged preferences cannot be set aside', error); }
  return kept;
}

async function renameInto(fs: StoreFs, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; } catch (error) {
      // Windows refuses to replace a file that another process has open for a moment (antivirus, indexer, sync client).
      if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as { code?: string }).code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 3 ** attempt));
    }
  }
}

export class Preferences {
  #queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly path: string, private readonly fs: StoreFs, private favorites: Favorites, private autosave: Autosave, private readonly limits: Limits,
    /** Where the file that could not be understood was put, if there was one. */ readonly setAside?: string) {}

  static async open(path: string, options: PreferencesOptions = {}): Promise<Preferences> {
    const fs = options.fs ?? realFs;
    const limits = { documents: options.maxDocuments ?? MAX_DOCUMENTS, favorites: options.maxFavorites ?? MAX_FAVORITES };
    const loaded = await load(fs, path, limits);
    switch (loaded.kind) {
      case 'good': return new Preferences(path, fs, loaded.favorites, loaded.autosave, limits);
      case 'missing': return new Preferences(path, fs, new Map(), new Map(), limits);
      case 'new': throw new PreferencesError('too-new', 'The preferences were written by a newer version of this app');
      case 'damaged': return new Preferences(path, fs, new Map(), new Map(), limits, await setAside(fs, path));
    }
  }

  favoritesOf(docId: string): string[] { return [...(this.favorites.get(docId) ?? [])]; }

  /** When the document saves by itself; nothing when it does not. */
  autosaveOf(docId: string): AutosaveMode | undefined { return this.autosave.get(docId); }

  /** Chooses when a document saves by itself, or that it does not ("off"); answers with what is chosen now. A choice is refused, and no other one forgotten, when there are too many documents. */
  setAutosave(docId: string, mode: AutosaveMode | 'off'): Promise<AutosaveMode | undefined> {
    if (!UUID.test(docId) || (mode !== 'off' && mode !== 'close' && mode !== 'edit')) return Promise.reject(new PreferencesError('invalid', 'Not a document id or a mode of saving'));
    const wanted = mode === 'off' ? undefined : mode;
    return this.#queued(async () => {
      await this.#refresh();
      if (this.autosave.get(docId) === wanted) return wanted;
      const candidate: Autosave = new Map(this.autosave);
      if (wanted === undefined) candidate.delete(docId);
      else {
        if (!candidate.has(docId) && candidate.size >= this.limits.documents) throw new PreferencesError('too-many', 'Too many documents save by themselves');
        candidate.set(docId, wanted);
      }
      await this.#write(this.favorites, candidate);
      this.autosave = candidate;
      return wanted;
    });
  }

  /** Makes an object a favourite of a document, or not one any more; answers with the favourites of that document. */
  setFavorite(docId: string, objectId: string, on: boolean): Promise<string[]> {
    if (!UUID.test(docId) || !UUID.test(objectId)) return Promise.reject(new PreferencesError('invalid', 'Not a document or object id'));
    return this.#change(docId, (list) => {
      if (list.includes(objectId) === on) return undefined;
      if (on && list.length >= this.limits.favorites) throw new PreferencesError('too-many', 'Too many favourites in this document');
      return on ? [...list, objectId] : list.filter((x) => x !== objectId);
    });
  }

  /** What the file holds now replaces what was known, because another copy of the app may have written it. A file that is gone is carried on without; a damaged one is set aside first; one that cannot be read, or that a newer version wrote, refuses the change. */
  async #refresh(): Promise<void> {
    const loaded = await load(this.fs, this.path, this.limits);   // one that cannot be read is an error here too: the change is refused, the file is not written over
    if (loaded.kind === 'good') { this.favorites = loaded.favorites; this.autosave = loaded.autosave; }
    else if (loaded.kind === 'new') throw new PreferencesError('too-new', 'The preferences were written by a newer version of this app');
    else if (loaded.kind === 'damaged') await setAside(this.fs, this.path);
  }

  /** One change at a time: what runs here starts when the one before it has ended, from what the file holds then. */
  #queued<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** `edit` gets the favourites of the document and answers with the new ones, or nothing when there is nothing to change. */
  #change(docId: string, edit: (list: string[]) => string[] | undefined): Promise<string[]> {
    return this.#queued(async (): Promise<string[]> => {
      await this.#refresh();
      const list = this.favorites.get(docId) ?? [];
      const next = edit(list);
      if (next === undefined) return [...list];
      const candidate: Favorites = new Map(this.favorites);
      candidate.delete(docId); // chosen from just now: it goes to the end of the line
      if (next.length > 0) {
        if (candidate.size >= this.limits.documents) candidate.delete(candidate.keys().next().value!); // the document chosen from longest ago makes room
        candidate.set(docId, next);
      }
      await this.#write(candidate, this.autosave);
      this.favorites = candidate;
      return [...next];
    });
  }

  async #write(favorites: Favorites, autosave: Autosave): Promise<void> {
    const body = autosave.size > 0 ? { version: 2, favorites: Object.fromEntries(favorites), autosave: Object.fromEntries(autosave) } : { version: 1, favorites: Object.fromEntries(favorites) };
    const text = `${JSON.stringify(body)}\n`;
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await this.fs.mkdir(dirname(this.path));
      const handle = await this.fs.open(tmp, 'wx', 0o600);
      try { await handle.writeFile(Buffer.from(text)); await handle.sync(); } finally { await handle.close(); }
      await renameInto(this.fs, tmp, this.path);
    } catch (error) {
      await this.fs.unlink(tmp).catch(() => undefined);
      throw new PreferencesError('io', 'The preferences cannot be written', error);
    }
    await this.fs.syncDir(dirname(this.path)).catch(() => undefined);
  }
}
