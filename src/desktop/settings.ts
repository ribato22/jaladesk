// What a person chose for the application on this computer, as opposed to what a shared document says and to what they chose for a document (preferences.ts): the theme, whether the toolbar
// is shown and what is on it, and (since 02-B3b) three choices that are on or off: whether the tabs show the colour of their object, whether the full screen is the extended one, and whether the keys of documents may be
// remembered by the system. The file is still version 1: a part that is not there is the default, and a part this version does not know is not read. One small JSON file in the application's data folder. It is a file of its own so that the file of the favourites (keyed by the id of a DOCUMENT, with versions of its own)
// stays as it was, and so that one of them being damaged does not empty the other. A choice that is the default is not written (the file is `{"version":1}` when nothing differs), so a person who
// never chose anything has no file. A part of the file that is wrong costs only that part (a theme that is not a theme is the default, a layout that holds what is not offered is mended), a file
// that cannot be understood at all is set aside (kept, not deleted) and the defaults are used, and one that a newer version of the app wrote is left alone and the settings cannot be used.
// A change is written whole and atomically (a temporary file, then a rename), one change after the other, starting from what the file holds at that moment (another copy of the app may have
// written it since); whoever follows the settings is told of every change that was made.
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { realFs, type StoreFs } from '../documents/store.js';
import type { ThemeChoice } from './commands.js';
import { parseThemeChoice } from './theme.js';
import { DEFAULT_LAYOUT, repairLayout, sameLayout, type Layout } from './toolbar-model.js';

export const MAX_FILE_BYTES = 256 * 1024;
export type SettingsErrorCode = 'invalid' | 'too-new' | 'io';
export class SettingsError extends Error {
  constructor(readonly code: SettingsErrorCode, message: string, readonly cause?: unknown) { super(message); this.name = 'SettingsError'; }
}
export type SettingsValues = {
  readonly theme: ThemeChoice;
  readonly toolbar: { readonly visible: boolean; readonly items: Layout };
  readonly tabs: { readonly colorize: boolean };
  readonly fullscreen: { readonly extended: boolean };
  readonly keys: { readonly allow: boolean };
};
export const DEFAULTS: SettingsValues = { theme: 'system', toolbar: { visible: true, items: DEFAULT_LAYOUT }, tabs: { colorize: true }, fullscreen: { extended: false }, keys: { allow: false } };
/** The choices that are on or off, by the name they have in the file (a part, then the choice). */
export const OPTIONS = ['tabs.colorize', 'fullscreen.extended', 'keys.allow'] as const;
export type OptionName = (typeof OPTIONS)[number];
export function optionOf(values: SettingsValues, name: OptionName): boolean {
  switch (name) {
    case 'tabs.colorize': return values.tabs.colorize;
    case 'fullscreen.extended': return values.fullscreen.extended;
    case 'keys.allow': return values.keys.allow;
  }
}
function withOption(values: SettingsValues, name: OptionName, on: boolean): SettingsValues {
  switch (name) {
    case 'tabs.colorize': return { ...values, tabs: { colorize: on } };
    case 'fullscreen.extended': return { ...values, fullscreen: { extended: on } };
    case 'keys.allow': return { ...values, keys: { allow: on } };
  }
}
const isOption = (name: unknown): name is OptionName => typeof name === 'string' && (OPTIONS as readonly string[]).includes(name);
export type SettingsOptions = { fs?: StoreFs };
type Loaded = { kind: 'good'; values: SettingsValues } | { kind: 'new' } | { kind: 'missing' } | { kind: 'damaged' };

const copy = (values: SettingsValues): SettingsValues => ({ theme: values.theme, toolbar: { visible: values.toolbar.visible, items: [...values.toolbar.items] }, tabs: { ...values.tabs }, fullscreen: { ...values.fullscreen }, keys: { ...values.keys } });
const same = (a: SettingsValues, b: SettingsValues) => a.theme === b.theme && a.toolbar.visible === b.toolbar.visible && sameLayout(a.toolbar.items, b.toolbar.items) && OPTIONS.every((name) => optionOf(a, name) === optionOf(b, name));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(text: string): Loaded {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { kind: 'damaged' }; }
  if (!isObject(data)) return { kind: 'damaged' };
  const version = data.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { kind: 'damaged' };
  if (version > 1) return { kind: 'new' };
  const toolbar = isObject(data.toolbar) ? data.toolbar : {};
  const part = (name: string): Record<string, unknown> => (isObject(data[name]) ? (data[name] as Record<string, unknown>) : {});
  const flag = (value: unknown, otherwise: boolean) => (typeof value === 'boolean' ? value : otherwise);
  return {
    kind: 'good',
    values: {
      theme: parseThemeChoice(data.theme) ?? DEFAULTS.theme, toolbar: { visible: typeof toolbar.visible === 'boolean' ? toolbar.visible : DEFAULTS.toolbar.visible, items: repairLayout(toolbar.items) ?? DEFAULTS.toolbar.items },
      tabs: { colorize: flag(part('tabs').colorize, DEFAULTS.tabs.colorize) }, fullscreen: { extended: flag(part('fullscreen').extended, DEFAULTS.fullscreen.extended) }, keys: { allow: flag(part('keys').allow, DEFAULTS.keys.allow) },
    },
  };
}

async function load(fs: StoreFs, path: string): Promise<Loaded> {
  let bytes: Buffer;
  try {
    // a file far too big is not read at all (readFile would load it whole, or refuse it for another reason than its size): the size is asked for first
    const size = (await fs.stat(path)).size;
    if (size !== undefined && size > MAX_FILE_BYTES) return { kind: 'damaged' };
    bytes = await fs.readFile(path);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    throw new SettingsError('io', 'The settings cannot be read', error);
  }
  return bytes.length > MAX_FILE_BYTES ? { kind: 'damaged' } : parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));   // an editor of Windows may put a byte order mark in front
}

/** Moves a file that cannot be understood out of the way, keeping it. When it cannot be moved it stays, and that is an error: it is not written over. */
async function setAside(fs: StoreFs, path: string): Promise<string> {
  const kept = `${path}.bad-${Date.now()}-${randomBytes(3).toString('hex')}`;   // the random part: two files set aside in the same millisecond must not be one
  try { await fs.rename(path, kept); } catch (error) { throw new SettingsError('io', 'The damaged settings cannot be set aside', error); }
  return kept;
}

export async function renameInto(fs: StoreFs, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; } catch (error) {
      // Windows refuses to replace a file that another process has open for a moment (antivirus, indexer, sync client).
      if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as { code?: string }).code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 3 ** attempt));
    }
  }
}

function serialize(values: SettingsValues): string {
  const body: Record<string, unknown> = { version: 1 };
  if (values.theme !== DEFAULTS.theme) body.theme = values.theme;
  const toolbar: Record<string, unknown> = {};
  if (values.toolbar.visible !== DEFAULTS.toolbar.visible) toolbar.visible = values.toolbar.visible;
  if (!sameLayout(values.toolbar.items, DEFAULTS.toolbar.items)) toolbar.items = values.toolbar.items;
  if (Object.keys(toolbar).length > 0) body.toolbar = toolbar;
  if (values.tabs.colorize !== DEFAULTS.tabs.colorize) body.tabs = { colorize: values.tabs.colorize };
  if (values.fullscreen.extended !== DEFAULTS.fullscreen.extended) body.fullscreen = { extended: values.fullscreen.extended };
  if (values.keys.allow !== DEFAULTS.keys.allow) body.keys = { allow: values.keys.allow };
  return `${JSON.stringify(body)}\n`;
}

export class Settings {
  #queue: Promise<unknown> = Promise.resolve();
  #listeners = new Set<(values: SettingsValues) => void>();
  #announced: SettingsValues;   // what the followers last heard: they are told whenever the settings are something else
  private constructor(private readonly path: string, private readonly fs: StoreFs, private current: SettingsValues,
    /** Where the file that could not be understood was put, if there was one. */ readonly setAside?: string, private readonly persistent = true) { this.#announced = copy(current); }

  /** Settings that are kept only while the app runs: for when the file cannot be used (a newer version wrote it, or it cannot be read), so that the theme and the toolbar can still be changed. */
  static memory(): Settings { return new Settings('', realFs, copy(DEFAULTS), undefined, false); }

  static async open(path: string, options: SettingsOptions = {}): Promise<Settings> {
    const fs = options.fs ?? realFs;
    const loaded = await load(fs, path);
    switch (loaded.kind) {
      case 'good': return new Settings(path, fs, loaded.values);
      case 'missing': return new Settings(path, fs, copy(DEFAULTS));
      case 'new': throw new SettingsError('too-new', 'The settings were written by a newer version of this app');
      case 'damaged': return new Settings(path, fs, copy(DEFAULTS), await setAside(fs, path));
    }
  }

  /** The settings now; what is handed out is a copy. */
  values(): SettingsValues { return copy(this.current); }

  /** Chooses the theme; answers with the settings after it. Anything that is not one of the three words is refused. */
  setTheme(choice: unknown): Promise<SettingsValues> {
    const theme = parseThemeChoice(choice);
    if (!theme) return Promise.reject(new SettingsError('invalid', 'Not a theme'));
    return this.#queued(() => this.#apply((values) => ({ ...values, theme })));
  }

  /** Chooses whether the toolbar is shown (`visible`) and what is on it (`items`, a layout, mended before it is kept); a patch with nothing in it changes nothing. */
  setToolbar(patch: unknown): Promise<SettingsValues> {
    if (!isObject(patch) || Object.keys(patch).some((key) => key !== 'visible' && key !== 'items')) return Promise.reject(new SettingsError('invalid', 'Not a change of the toolbar'));
    if ('visible' in patch && typeof patch.visible !== 'boolean') return Promise.reject(new SettingsError('invalid', 'Shown or not is yes or no'));
    const items = 'items' in patch ? repairLayout(patch.items) : undefined;
    if ('items' in patch && !items) return Promise.reject(new SettingsError('invalid', 'Not a layout'));
    const visible = 'visible' in patch ? (patch.visible as boolean) : undefined;
    return this.#queued(() => this.#apply((values) => ({ ...values, toolbar: { visible: visible ?? values.toolbar.visible, items: items ?? values.toolbar.items } })));
  }

  /** Turns a choice on or off; anything that is not the name of a choice and a yes or no is refused. */
  setOption(name: unknown, on: unknown): Promise<SettingsValues> {
    if (!isOption(name) || typeof on !== 'boolean') return Promise.reject(new SettingsError('invalid', 'Not a choice that can be on or off'));
    return this.#queued(() => this.#apply((values) => withOption(values, name, on)));
  }

  /** Flips a choice, in its turn: what flips is what the change before left (or what another copy of the app wrote), not what was known when this one was asked for. */
  toggleOption(name: unknown): Promise<SettingsValues> {
    if (!isOption(name)) return Promise.reject(new SettingsError('invalid', 'Not a choice that can be on or off'));
    return this.#queued(() => this.#apply((values) => withOption(values, name, !optionOf(values, name))));
  }

  /** Shows the toolbar when it is hidden and hides it when it is shown, in its turn: what flips is what the change before left, not what was known when this one was asked for. */
  toggleToolbar(): Promise<SettingsValues> {
    return this.#queued(() => this.#apply((values) => ({ ...values, toolbar: { visible: !values.toolbar.visible, items: values.toolbar.items } })));
  }

  /** `listener` is told of every change, with the settings as they are then; the function that comes back stops it. A listener that fails does not stop the others, or the change. */
  subscribe(listener: (values: SettingsValues) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** One change at a time: what runs here starts when the one before it has ended, from what the file holds then. */
  #queued<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #apply(edit: (values: SettingsValues) => SettingsValues): Promise<SettingsValues> {
    if (this.persistent) await this.#refresh();     // may bring news: another copy of the app (or a hand) changed the file since the last look
    const next = edit(this.current);
    if (!same(next, this.current)) {
      if (this.persistent) {
        try { await this.#write(next); } catch (error) { this.#tell(); throw error; }   // a change that cannot be written is refused, but what the file held is still news
      }
      this.current = next;
    }
    this.#tell();
    return this.values();
  }

  /** Tells the followers what the settings are, when that is not what they last heard. */
  #tell(): void {
    if (same(this.current, this.#announced)) return;
    this.#announced = copy(this.current);
    for (const listener of [...this.#listeners]) { try { listener(this.values()); } catch { /* a follower that fails is its own trouble */ } }
  }

  /** What the file holds now replaces what was known, because another copy of the app may have written it. A file that is gone is carried on without; a damaged one is set aside first; one that cannot be read, or that a newer version wrote, refuses the change. */
  async #refresh(): Promise<void> {
    const loaded = await load(this.fs, this.path);
    if (loaded.kind === 'good') this.current = loaded.values;
    else if (loaded.kind === 'new') throw new SettingsError('too-new', 'The settings were written by a newer version of this app');
    else if (loaded.kind === 'damaged') await setAside(this.fs, this.path);
  }

  async #write(values: SettingsValues): Promise<void> {
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await this.fs.mkdir(dirname(this.path));
      const handle = await this.fs.open(tmp, 'wx', 0o600);
      try { await handle.writeFile(Buffer.from(serialize(values))); await handle.sync(); } finally { await handle.close(); }
      await renameInto(this.fs, tmp, this.path);
    } catch (error) {
      await this.fs.unlink(tmp).catch(() => undefined);
      throw new SettingsError('io', 'The settings cannot be written', error);
    }
    await this.fs.syncDir(dirname(this.path)).catch(() => undefined);
  }
}
