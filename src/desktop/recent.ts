// The documents that were opened last, for the menu Buka Terbaru: up to ten, the newest first, each as the path of its file and nothing else. It is a file of its own in the data folder of the application
// (`recent.json`) and not a part of the settings, because it holds paths (a person's own folders) and because a damaged list must never cost the theme or the toolbar. It holds no name of a document: the name
// is inside the encrypted file, and a list in the clear that told it would tell what the file keeps secret, so the menu says the name of the file. It is a convenience and nothing more: a file that cannot be
// understood, or read, or that was written by something else, is an empty list, and the next change writes a good one; nobody is told. Whether a change could be written is told to whoever made it (a document
// that was opened is no less open because the list could not be kept), the list in memory is the list for as long as the app runs, and a write that failed is tried again by the next request, also one that
// changes nothing in memory (clearing a list that the file still holds must not be forgotten).
// The window never sees a path: the main process holds this list, tells the menu the words (`recentLabels`) and opens a document by its place in the list, and only after the person chose that place in the
// menu (`choose`, `chosen`): a window that asks to open a recent document without a click of the person is refused.
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { realFs, type StoreFs } from '../documents/store.js';
import { MAX_RECENT, platformFrom, type Platform } from './commands.js';
import { renameInto } from './settings.js';

export type RecentItem = { readonly path: string };
export type RecentOptions = { fs?: StoreFs; platform?: Platform; now?: () => number };

/** Far more than ten items of any length can take: a bigger file is not a list of ours and is not read. */
export const MAX_FILE_BYTES = 64 * 1024;
/** How long the choice of a place in the menu lets the window open that document: the window is told at once, so this is only a limit on a request that comes long after the click. */
export const CHOICE_MS = 10_000;
const MAX_PATH = 4096;
const MAX_LABEL = 60;       // characters of a name in a menu
const MIN_STEM = 8;         // the least of a name that is kept when a long name is cut to make room for what tells it apart

/** Whether a path can be an item: an absolute path without a NUL. */
function fits(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= MAX_PATH && !path.includes('\0') && isAbsolute(path);
}

function parse(text: string, same: (a: string, b: string) => boolean): RecentItem[] {
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return []; }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  const { version, items: listed } = data as { version?: unknown; items?: unknown };
  if (version !== 1 || !Array.isArray(listed)) return [];
  const items: RecentItem[] = [];
  for (const item of listed) {
    const path = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as { path?: unknown }).path : undefined;      // a name that an earlier version wrote is not read
    if (!fits(path) || items.some((known) => same(known.path, path))) continue;
    items.push({ path });
    if (items.length === MAX_RECENT) break;
  }
  return items;
}

/** The leftovers of writes that stopped (`recent.json.<12 hex>.tmp`) are removed: only the copy of the app that holds the lock of the data folder writes here, so none of them is a write in progress. */
async function sweep(fs: StoreFs, path: string): Promise<void> {
  const name = basename(path), folder = dirname(path);
  for (const entry of await fs.readdir(folder).catch(() => [] as string[])) {
    if (entry.startsWith(`${name}.`) && /^[0-9a-f]{12}\.tmp$/.test(entry.slice(name.length + 1))) await fs.unlink(join(folder, entry)).catch(() => undefined);
  }
}

export class Recent {
  #queue: Promise<unknown> = Promise.resolve();
  #unsaved = false;      // the file is not what the list is: a write failed and has not been made good
  #chosen: { path: string; until: number } | undefined;
  readonly #listeners = new Set<(items: RecentItem[]) => void>();
  private constructor(private readonly path: string, private readonly fs: StoreFs, private items: RecentItem[], private readonly same: (a: string, b: string) => boolean, private readonly now: () => number) {}

  /** The list the file holds; an empty one when there is no file or it cannot be used. It does not fail. */
  static async open(path: string, options: RecentOptions = {}): Promise<Recent> {
    const fs = options.fs ?? realFs;
    const same = sameFile(options.platform ?? platformFrom(process.platform));
    let items: RecentItem[] = [];
    try {
      const size = (await fs.stat(path)).size;
      if (size === undefined || size <= MAX_FILE_BYTES) {
        const bytes = await fs.readFile(path);
        if (bytes.length <= MAX_FILE_BYTES) items = parse(bytes.toString('utf8'), same);
      }
    } catch { /* no file, or one that cannot be read: an empty list */ }
    await sweep(fs, path);
    return new Recent(path, fs, items, same, options.now ?? Date.now);
  }

  /** A list that is only kept while the app runs. */
  static memory(options: Pick<RecentOptions, 'platform' | 'now'> = {}): Recent { return new Recent('', realFs, [], sameFile(options.platform ?? platformFrom(process.platform)), options.now ?? Date.now); }

  /** The list now, newest first; what is handed out is a copy. */
  list(): RecentItem[] { return this.items.map((item) => ({ ...item })); }

  /** Puts a document at the top (the same file is not twice in the list). Says whether the list could be written; a path that does not fit is refused and changes nothing. */
  add(path: string): Promise<boolean> {
    if (!fits(path)) return Promise.resolve(false);
    return this.#change((items) => [{ path }, ...items.filter((item) => !this.same(item.path, path))].slice(0, MAX_RECENT));
  }

  remove(path: string): Promise<boolean> { return this.#change((items) => items.filter((item) => !this.same(item.path, path))); }

  clear(): Promise<boolean> { return this.#change(() => []); }

  /** The person chose the document at this place of the list (a click on its item in the menu): the window may open that document, once, for `CHOICE_MS`. A place with no document chooses nothing, and ends an earlier choice. */
  choose(place: number): void {
    const item = this.items[place];
    this.#chosen = item ? { path: item.path, until: this.now() + CHOICE_MS } : undefined;
  }

  /** Whether the person chose this document just now. Asking for the one that was chosen uses the choice up; asking for another document leaves it for the one that was chosen. */
  chosen(path: string): boolean {
    const choice = this.#chosen;
    if (choice && this.now() > choice.until) this.#chosen = undefined;
    if (!this.#chosen || !this.same(this.#chosen.path, path)) return false;
    this.#chosen = undefined;
    return true;
  }

  /** `listener` is told of every change, with the list as it is then; the function that comes back stops it. A listener that fails does not stop the others, or the change. */
  subscribe(listener: (items: RecentItem[]) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** One change at a time, in the order they came. The list in memory changes first and the file follows; `false` says the file could not be written, and the next request tries again. */
  #change(edit: (items: RecentItem[]) => RecentItem[]): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const next = edit(this.items);
      const changed = next.length !== this.items.length || next.some((item, i) => item.path !== this.items[i]!.path);
      if (!changed && !this.#unsaved) return true;      // nothing changes and the file is what the list is: nothing is written, nobody is told
      if (changed) {
        this.items = next;
        for (const listener of [...this.#listeners]) { try { listener(this.list()); } catch { /* a follower that fails is its own trouble */ } }
      }
      if (this.path === '') return true;
      try { await this.#write(this.items); this.#unsaved = false; return true; } catch { this.#unsaved = true; return false; }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #write(items: RecentItem[]): Promise<void> {
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await this.fs.mkdir(dirname(this.path));
      const handle = await this.fs.open(tmp, 'wx', 0o600);
      try { await handle.writeFile(Buffer.from(`${JSON.stringify({ version: 1, items })}\n`)); await handle.sync(); } finally { await handle.close(); }
      await renameInto(this.fs, tmp, this.path);
    } catch (error) {
      await this.fs.unlink(tmp).catch(() => undefined);
      throw error;
    }
    await this.fs.syncDir(dirname(this.path)).catch(() => undefined);
  }
}

/**
 * Two paths name one file when they resolve to the same path, with letters of either case on Windows and macOS (the usual volumes there ignore the case) and, on macOS, whichever way the same letters are
 * written (the volume does not tell a letter with its accent as one character from the letter and the accent); with the case and the characters as they are on Linux.
 */
function sameFile(platform: Platform): (a: string, b: string) => boolean {
  if (platform === 'linux') return (a, b) => resolve(a) === resolve(b);
  if (platform === 'darwin') return (a, b) => resolve(a).normalize('NFC').toLowerCase() === resolve(b).normalize('NFC').toLowerCase();
  return (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/** Control characters are blanks; the marks that only turn the direction of the text, or are not seen, are taken out (a name that reads backwards or has a part nobody can see is how a menu is made to lie). The joiners that some scripts need stay. */
const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim();
const characters = (text: string): number => Array.from(text).length;
const cut = (text: string, room: number): string => { const chars = Array.from(text); return chars.length <= room ? text : `${chars.slice(0, Math.max(1, room - 1)).join('')}…`; };
const SEPARATOR = ' — ';
/** A text cut to a room in the middle: its start and its end stay (two paths are told apart at either), and a pair of halves is one character. */
const squeeze = (text: string, room: number): string => {
  const chars = Array.from(text);
  if (chars.length <= room) return text;
  const keep = Math.max(2, room - 1), head = Math.ceil(keep / 2);
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (keep - head)).join('')}`;
};
/**
 * A name and what tells it apart from the others, in the room of a menu item: the name gives way; when there is no room for a name worth reading the name keeps its start and what tells it apart is
 * squeezed in the middle. The number that tells apart what the words cannot (`counter`) is never cut.
 */
function fit(name: string, apart: string, counter = ''): string {
  const room = MAX_LABEL - characters(apart) - characters(counter);
  if (room >= MIN_STEM) return `${cut(name, room)}${apart}${counter}`;
  const stem = cut(name, MIN_STEM);
  return `${stem}${SEPARATOR}${squeeze(apart.slice(SEPARATOR.length), MAX_LABEL - characters(stem) - SEPARATOR.length - characters(counter))}${counter}`;
}

/**
 * The words of the menu for a list: the name of each file without its ending; where two have the same name the folder is said as well, and where that is the same too the folder above it, and where that is
 * the same too a number (the newest keeps the plain words). An ampersand is doubled on every platform: the menu of Electron takes a lone one for the mark of a key, on the Mac as well. Control characters
 * are blanks, and a long name is cut where the name is, not where it is told apart.
 */
export function recentLabels(items: readonly RecentItem[]): string[] {
  const names = items.map((item) => { const file = basename(item.path); return plain(file.replace(/\.rwdoc$/i, '')) || plain(file) || plain(item.path); });
  const level = items.map(() => 0);
  const apart = (i: number, n = level[i]!): string => {
    const folder = plain(basename(dirname(items[i]!.path))) || plain(dirname(items[i]!.path));
    if (n === 0) return '';
    return n === 1 ? `${SEPARATOR}${folder}` : `${SEPARATOR}${[plain(basename(dirname(dirname(items[i]!.path)))), folder].filter(Boolean).join('/')}`;
  };
  for (let round = 0; round < 2; round++) {
    const seen = new Map<string, number>();
    items.forEach((_, i) => { const text = `${names[i]}${apart(i)}`; seen.set(text, (seen.get(text) ?? 0) + 1); });
    items.forEach((_, i) => { if (seen.get(`${names[i]}${apart(i)}`)! > 1) level[i] = Math.min(level[i]! + 1, 2); });
  }
  const taken = new Map<string, number>();
  return items.map((_, i) => {
    const label = fit(names[i]!, apart(i));
    const n = (taken.get(label) ?? 0) + 1;
    taken.set(label, n);
    return (n === 1 ? label : fit(names[i]!, apart(i), ` (${n})`)).replace(/&/g, '&&');
  });
}
