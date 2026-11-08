// IPC for the window of the settings (a window of its own, not the window of the application): it asks for the settings, changes them one at a time, forgets every key that the system remembers (after a
// question that the main process asks, not the window) and clears the list of recent documents. Every channel checks its sender first (main.ts hands in the check that sender is the window of the
// settings, at its own page); what arrives is validated before anything is done with it, and what goes back is numbers and words: no path, no name of a document, no key.
// A setting is changed by its name and a value, the answer is the settings after it, and the main process tells the window the same thing (`view`) when something else changed them (a menu, another copy).
import { THEME_CHOICES } from './commands.js';
import { SettingsError, type OptionName, type SettingsValues } from './settings.js';
import type { ShellIpc } from './shell-ipc.js';

/** What the window of the settings needs of the keys that the system remembers (Keystore satisfies it): whether the system can seal at all, how many keys there are, and forgetting all of them (the number that there were). */
export type SettingsKeystore = { available(): boolean; count(): Promise<number>; forgetAll(): Promise<number> };
export type SettingsRecent = { list(): readonly unknown[]; clear(): Promise<boolean> };
export type SettingsApi = {
  values(): SettingsValues;
  setTheme(choice: unknown): Promise<SettingsValues>;
  setToolbar(patch: unknown): Promise<SettingsValues>;
  setOption(name: OptionName, on: unknown): Promise<SettingsValues>;
};
export type SettingsIpcDeps = {
  ipc: ShellIpc;
  /** Throws when the sender is not the window of the settings. */
  check(event: unknown): void;
  settings: SettingsApi;
  keystore?: SettingsKeystore;
  recent?: SettingsRecent;
  /** The question before all the keys are forgotten; `count` keys are about to go. */
  confirmForget(count: number): Promise<boolean>;
  report(error: unknown): void;
};
/** What the window of the settings is told. `usable` is null while the keys are not allowed: the keystore of the system is not asked about them until they are. */
export type SettingsView = {
  readonly ok: true;
  readonly theme: SettingsValues['theme'];
  readonly toolbar: { readonly visible: boolean };
  readonly tabs: { readonly colorize: boolean };
  readonly fullscreen: { readonly extended: boolean };
  readonly keys: { readonly allow: boolean; readonly usable: boolean | null; readonly count: number };
  readonly recent: { readonly count: number };
};
const NAMES = ['theme', 'toolbar.visible', 'tabs.colorize', 'fullscreen.extended', 'keys.allow'] as const;
type Name = (typeof NAMES)[number];
const fail = (code: string, message: string) => ({ ok: false as const, code, message });
const MESSAGES = {
  invalid: 'Perubahan itu tidak dikenal.',
  io: 'Pengaturan tidak dapat disimpan di komputer ini.',
  keystore: 'Penyimpanan kunci milik sistem tidak tersedia di komputer ini, jadi kunci tidak dapat diingat.',
  cancelled: 'Dibatalkan.',
  forget: 'Tidak semua kunci dapat dilupakan; sebagian masih ada di komputer ini.',
  'recent-file': 'Daftar sudah dibersihkan, tetapi berkasnya tidak dapat ditulis; daftar lama dapat muncul lagi saat aplikasi dibuka berikutnya.',
};

export function registerSettingsIpc(deps: SettingsIpcDeps): { view(): Promise<SettingsView> } {
  const { ipc, check, settings, keystore, recent } = deps;

  async function view(): Promise<SettingsView> {
    const count = keystore ? await keystore.count().catch(() => 0) : 0;      // counted first: the settings are read after the wait, so that what is told is what they are when it ends (a change that came in the meantime is not lost)
    const values = settings.values();
    const allow = values.keys.allow;
    let usable: boolean | null = null;
    if (allow) { try { usable = keystore ? keystore.available() : false; } catch { usable = false; } }
    return {
      ok: true, theme: values.theme, toolbar: { visible: values.toolbar.visible }, tabs: { colorize: values.tabs.colorize }, fullscreen: { extended: values.fullscreen.extended },
      keys: { allow, usable, count }, recent: { count: recent?.list().length ?? 0 },
    };
  }
  /** A change that failed: a wrong request is said so, the rest is the person's own computer and is told in words, with the cause kept in the main process. */
  function failed(error: unknown, message: string = MESSAGES.io) {
    if (error instanceof SettingsError && error.code === 'invalid') return fail('invalid', MESSAGES.invalid);
    deps.report(error);
    return fail('io', message);
  }

  ipc.handle('settings:get', async (event) => {
    check(event);
    return view();
  });

  ipc.handle('settings:set', async (event, payload) => {
    check(event);
    const keys = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? Object.keys(payload) : [];
    if (keys.length !== 2 || !Object.hasOwn(payload as object, 'name') || !Object.hasOwn(payload as object, 'value')) return fail('invalid', MESSAGES.invalid);
    const { name, value } = payload as { name: unknown; value: unknown };
    if (typeof name !== 'string' || !(NAMES as readonly string[]).includes(name)) return fail('invalid', MESSAGES.invalid);
    try {
      switch (name as Name) {
        case 'theme': if (typeof value !== 'string' || !(THEME_CHOICES as readonly string[]).includes(value)) return fail('invalid', MESSAGES.invalid); await settings.setTheme(value); break;
        case 'toolbar.visible': if (typeof value !== 'boolean') return fail('invalid', MESSAGES.invalid); await settings.setToolbar({ visible: value }); break;
        case 'keys.allow': {
          if (typeof value !== 'boolean') return fail('invalid', MESSAGES.invalid);
          if (value && !(keystore && keystore.available())) return fail('keystore', MESSAGES.keystore);
          await settings.setOption('keys.allow', value);
          break;
        }
        default: if (typeof value !== 'boolean') return fail('invalid', MESSAGES.invalid); await settings.setOption(name as OptionName, value);
      }
    } catch (error) { return failed(error); }
    return view();
  });

  if (keystore) {
    ipc.handle('settings:forget-keys', async (event) => {
      check(event);
      try {
        const count = await keystore.count();
        if (count === 0) return { ok: true as const, forgot: 0 };
        if (!(await deps.confirmForget(count))) return fail('cancelled', MESSAGES.cancelled);
        return { ok: true as const, forgot: await keystore.forgetAll() };
      } catch (error) { return failed(error, MESSAGES.forget); }
    });
  }

  if (recent) {
    ipc.handle('settings:clear-recent', async (event) => {
      check(event);
      if (!(await recent.clear())) return fail('io', MESSAGES['recent-file']);
      return view();
    });
  }

  return { view };
}
