// The menu of the application, as plain data: what the items say, which key does them, whether they can be chosen now and whether they are on, for one platform and one state of the
// window. Nothing here touches Electron (menu.ts makes the real menu from this), so everything the menu says and does can be tested without a window.
//
// The keyboard has two owners. Most of the time it is the application's: the keys of the commands work wherever the focus is. But a connected remote session that has the focus takes
// every key: renderer.ts sends them all to the other machine and calls preventDefault. In Electron the page is offered a key before the menu (the menu only gets the keys the page left alone;
// before-input-event comes before both), so with the page doing that the menu never sees those keys. This file does not rely on that order: while a session holds the keyboard the menu is
// made WITHOUT keys, so that a platform that offered the menu first could not take Ctrl+S, Ctrl+W or Ctrl+C from the session either, except the few that are the system's (Cmd+Q, the full
// screen and the three keys of the system's own items on macOS) or that give the keyboard back (session.release); the items stay there for the pointer. Sunting does nothing then: its standard
// items would take Copy, Paste and Undo from the session. Because the page consumes every key, the kept keys cannot work through the menu: shell.ts takes them before the page does.
import { MAX_RECENT, keysFor, recentIndex, spec, type CommandId, type Platform, type Report, type ThemeChoice } from './commands.js';

/**
 * What the main process knows that the window does not: the theme, whether the toolbar is shown, the full screen, whether a window of its own (a password) is open and, when its process died, that the page
 * is gone (absent means it is there). Since 02-B3b also whether the tabs show the colour of their object (absent: they do), whether the extended full screen is chosen (absent: it is not) and the names of the
 * recent documents, newest first (absent: there are none); the menu holds a place for ten of them whatever the list holds, and shows the ones there are.
 */
export type Flags = {
  readonly theme: ThemeChoice; readonly toolbar: boolean; readonly fullscreen: boolean; readonly prompt: boolean; readonly pageGone?: boolean;
  readonly colorTabs?: boolean; readonly extendedFullscreen?: boolean; readonly recent?: readonly string[];
  /** How many keys the system remembers (absent: none): forgetting the key of a document is there to do only when there is a key somewhere to forget. */
  readonly keys?: number;
  /** Another window of the application than the main window has the focus (the settings): the menu of the Mac is one for all the windows, so the commands of the main window are off meanwhile (absent: the main window has it). */
  readonly away?: boolean;
};
/** The standard items of the system, which work on whatever has the focus (a box takes Copy, the window takes Minimize) and bring their own keys. */
export type Role = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'minimize' | 'zoom' | 'front' | 'hide' | 'hideOthers' | 'unhide' | 'services';
export type Entry =
  | { readonly kind: 'separator' }
  /** `hidden`: there, but not shown (the place of a recent document there is none for). */
  | { readonly kind: 'command'; readonly id: CommandId; readonly label: string; readonly accelerator?: string; readonly enabled: boolean; readonly control?: 'checkbox' | 'radio'; readonly checked?: boolean; readonly hidden?: true }
  | { readonly kind: 'role'; readonly role: Role; readonly label: string; readonly enabled: true }
  /** An item that is there and does nothing: what stands in for a standard item while a session holds the keyboard. */
  | { readonly kind: 'plain'; readonly label: string; readonly enabled: false }
  | { readonly kind: 'submenu'; readonly label: string; readonly items: readonly Entry[] };
export type Section = Extract<Entry, { kind: 'submenu' }>;
export type Menu = readonly Section[];

/** The commands that keep their keys while a connected session holds the keyboard: Cmd+Q and the full screen are the system's on macOS, and Windows and Linux give up only the key that gives the keyboard back. */
export const RESERVED_IN_CAPTURE: Readonly<Record<Platform, readonly CommandId[]>> = {
  darwin: ['app.quit', 'view.fullscreen', 'session.release'],
  win32: ['session.release'],
  linux: ['session.release'],
};
/** The keys that the standard items of the system bring by themselves: Hide, Hide Others and Minimize on macOS stay in the menu with their keys (the menu cannot take them away) while a session holds the keyboard. The application does not take these keys the way it takes the reserved ones, and the page gets a key before the menu, so whether they work from the screen of a session is for a person to see (Task 14a); the list of keys says so. */
export const SYSTEM_KEYS_IN_CAPTURE: Readonly<Record<Platform, readonly { readonly label: string; readonly key: string }[]>> = {
  darwin: [{ label: 'Sembunyikan', key: 'Cmd+H' }, { label: 'Sembunyikan yang Lain', key: 'Alt+Cmd+H' }, { label: 'Minimalkan', key: 'Cmd+M' }],
  win32: [],
  linux: [],
};
const AUTOSAVE_MODES: readonly CommandId[] = ['doc.autosave.off', 'doc.autosave.close', 'doc.autosave.edit'];
const NEEDS_NOTHING_FROM_THE_WINDOW: readonly CommandId[] = ['find', 'adhoc.focus', 'view.customizeToolbar', 'help.shortcuts'];
const SEPARATOR: Entry = { kind: 'separator' };

export type MenuInput = { platform: Platform; appName: string; report: Report; flags: Flags };

/**
 * Whether a command can be done now: quitting always can; while a window of the main process asks for a password nothing else can; the commands of the main process can otherwise; the commands of
 * the window cannot when its page is gone, nor while a dialog of the window is open, and then depend on what the window reported (the controls it has and can use) or, for the tabs and giving the keyboard back, on the
 * number of tabs and on whether a session holds the keyboard. The menu and the toolbar both ask this, so that they cannot disagree.
 */
export function isAvailable(id: CommandId, report: Report, flags: Pick<Flags, 'prompt' | 'pageGone' | 'recent' | 'keys' | 'away'>): boolean {
  if (id === 'app.quit') return true;
  if (flags.prompt) return false;
  if (id === 'doc.recent.clear') return (flags.recent?.length ?? 0) > 0;      // the main process's own, but with nothing to do when the list is empty
  if (spec(id).owner === 'main') return true;
  if (flags.pageGone === true || flags.away === true || report.dialog) return false;
  const recent = recentIndex(id);
  if (recent !== undefined) return recent < Math.min(flags.recent?.length ?? 0, MAX_RECENT);      // the window cannot say which documents are recent: the menu shows the ones there are
  if (id === 'doc.forgetKey') return (flags.keys ?? 0) > 0 && report.enabled.includes('doc.close');      // a key is remembered somewhere, and a document is selected as far as the window can tell: it is when closing it can be done
  if (id === 'tab.moveLeft') return report.tab > 0;
  if (id === 'tab.moveRight') return report.tab >= 0 && report.tab < report.tabs - 1;
  if (id === 'tab.next' || id === 'tab.previous') return report.tabs >= 2;
  if (id === 'tab.last') return report.tabs >= 1;
  if (id.startsWith('tab.')) return report.tabs >= Number(id.slice(4));
  if (id === 'session.release') return report.capture;
  if (NEEDS_NOTHING_FROM_THE_WINDOW.includes(id)) return true;
  return report.enabled.includes(id);
}

export function buildMenu({ platform, appName, report, flags }: MenuInput): Menu {
  const mac = platform === 'darwin';
  // a window of the main process in front (a password) has the keyboard, whatever the page still thinks has the focus
  const held = report.capture && !flags.prompt;
  const reserved = new Set(RESERVED_IN_CAPTURE[platform]);
  const available = (id: CommandId) => isAvailable(id, report, flags);
  function labelOf(id: CommandId): string {
    switch (id) {
      case 'view.toolbar': return flags.toolbar ? 'Sembunyikan Toolbar' : 'Tampilkan Toolbar';
      case 'view.fullscreen': return flags.fullscreen ? 'Keluar dari Layar Penuh' : 'Masuk Layar Penuh';
      case 'app.about': return `Tentang ${appName}`;
      case 'app.quit': return mac ? `Keluar dari ${appName}` : 'Keluar';
      default: {
        const recent = recentIndex(id);
        return recent !== undefined ? (flags.recent?.[recent] ?? spec(id).label) : spec(id).label;
      }
    }
  }
  function command(id: CommandId): Entry {
    const key = keysFor(spec(id), platform);
    const accelerator = held && !reserved.has(id) ? undefined : key;
    let control: 'checkbox' | 'radio' | undefined, checked: boolean | undefined;
    // the system turns the first radio item of a group on by itself when none is: the menu says the same, so that it never shows a choice that was not made (and shows only one, whatever it was told)
    if (id.startsWith('doc.autosave.')) { control = 'radio'; checked = id === (AUTOSAVE_MODES.find((mode) => report.checked.includes(mode)) ?? 'doc.autosave.off'); }
    else if (/^tab\.[1-9]$/.test(id)) { control = 'checkbox'; checked = report.tab === Number(id.slice(4)) - 1; }
    else if (id === 'obj.favorite') { control = 'checkbox'; checked = report.checked.includes(id); }
    else if (id.startsWith('view.theme.')) { control = 'radio'; checked = flags.theme === id.slice('view.theme.'.length); }
    else if (id === 'view.colorizeTabs') { control = 'checkbox'; checked = flags.colorTabs !== false; }
    else if (id === 'view.extendedFullscreen') { control = 'checkbox'; checked = flags.extendedFullscreen === true; }
    const place = recentIndex(id);
    return {
      kind: 'command', id, label: labelOf(id), ...(accelerator !== undefined ? { accelerator } : {}), enabled: available(id), ...(control ? { control, checked: checked! } : {}),
      ...(place !== undefined && place >= Math.min(flags.recent?.length ?? 0, MAX_RECENT) ? { hidden: true as const } : {}),
    };
  }
  const role = (name: Role, label: string): Entry => ({ kind: 'role', role: name, label, enabled: true });
  // Sunting's items work on the box that has the focus; with a session holding the keyboard they are items that do nothing, because their standard form would bring Copy and Paste keys
  const standard = (name: Role, label: string): Entry => held ? { kind: 'plain', label, enabled: false } : role(name, label);
  const submenu = (label: string, items: readonly Entry[]): Section => ({ kind: 'submenu', label, items });
  const sep = SEPARATOR;

  const nothingRecent = (flags.recent?.length ?? 0) === 0;
  const recents = submenu('Buka Terbaru', [
    ...Array.from({ length: MAX_RECENT }, (_, n) => command(`doc.recent.${n + 1}` as CommandId)),
    ...(nothingRecent ? [] : [sep]), command('doc.recent.clear'),      // no line above Bersihkan Daftar when there is nothing above it to tell it from
  ]);
  const application = submenu(appName, [command('app.about'), sep, command('app.settings'), sep, role('services', 'Layanan'), sep, role('hide', `Sembunyikan ${appName}`), role('hideOthers', 'Sembunyikan yang Lain'), role('unhide', 'Tampilkan Semua'), sep, command('app.quit')]);
  const file = submenu('Berkas', [
    command('doc.new'), command('doc.open'), recents, command('doc.vault'), command('doc.properties'),command('doc.password'), sep,
    command('doc.save'), submenu('Simpan Otomatis', [command('doc.autosave.off'), command('doc.autosave.close'), command('doc.autosave.edit')]),
    command('doc.reload'), command('doc.conflicts'), command('doc.history'), command('doc.forgetKey'), sep,
    command('doc.close'), command('session.closeTab'),
    ...(mac ? [] : [sep, command('app.settings'), sep, command('app.quit')]),
  ]);
  const edit = submenu('Sunting', [standard('undo', 'Urungkan'), standard('redo', 'Ulangi'), sep, standard('cut', 'Potong'), standard('copy', 'Salin'), standard('paste', 'Tempel'), standard('selectAll', 'Pilih Semua'), sep, command('find')]);
  const objects = submenu('Objek', [
    command('obj.connect'), command('session.reconnect'), command('session.disconnect'), command('session.release'), sep,
    command('obj.addFolder'), command('obj.addConnection'), sep,
    command('obj.templates'), command('obj.edit'), command('obj.duplicate'), command('obj.transfer'), command('obj.bulk'), command('obj.favorite'), command('obj.remove'), sep,
    command('tree.expandAll'), command('tree.collapseAll'), sep,
    command('adhoc.focus'),
  ]);
  const view = submenu('Tampilan', [
    command('view.toolbar'), command('view.customizeToolbar'), sep,
    command('view.colorizeTabs'), sep,
    submenu('Tema', [command('view.theme.system'), command('view.theme.light'), command('view.theme.dark')]), sep,
    command('view.fullscreen'), command('view.extendedFullscreen'),
  ]);
  const tabs = submenu('Pilih Tab', [command('tab.1'), command('tab.2'), command('tab.3'), command('tab.4'), command('tab.5'), command('tab.6'), command('tab.7'), command('tab.8'), command('tab.9'), command('tab.last')]);
  const window = submenu('Jendela', [
    // Minimize brings Ctrl+M on Windows and Linux, which is Enter in a remote shell: there it does nothing while a session holds the keyboard (the title bar has the button); Cmd+M is the system's on macOS
    mac ? role('minimize', 'Minimalkan') : standard('minimize', 'Minimalkan'), ...(mac ? [role('zoom', 'Perbesar')] : []), sep,
    command('tab.next'), command('tab.previous'), command('tab.moveLeft'), command('tab.moveRight'), tabs,
    ...(mac ? [sep, role('front', 'Bawa Semua ke Depan')] : []),
  ]);
  const help = submenu('Bantuan', [command('help.shortcuts'), ...(mac ? [] : [sep, command('app.about')])]);
  return [...(mac ? [application] : []), file, edit, objects, view, window, help];
}

/** The item of a command, wherever it is in the menu; nothing when it is not there. */
export function findCommand(menu: readonly Entry[], id: CommandId): Extract<Entry, { kind: 'command' }> | undefined {
  for (const entry of menu) {
    if (entry.kind === 'command' && entry.id === id) return entry;
    if (entry.kind === 'submenu') {
      const found = findCommand(entry.items, id);
      if (found) return found;
    }
  }
  return undefined;
}
