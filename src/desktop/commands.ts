// The commands of the window, as the menu, the toolbar and the list of keys know them: one list, so that a command has the same words, the same key and the same control of the page
// wherever it is offered. Most of them are things the window already does with a button (save, connect, add a folder, reconnect a tab): the command then names that button, and what the
// window tells the main process about what can be done now is read from the buttons themselves (shell-ui.ts), so that a menu item and its button can never disagree. The rest is done by
// the window without a button (find, a tab, giving the keyboard back) or by the main process (the theme, the full screen, the dialog About, quitting).
// Nothing here knows about Electron: the keys are strings in the syntax Electron reads, per platform (Cmd on macOS, Ctrl elsewhere). A few commands have no key here on purpose: the tree handles Duplikat (Cmd/Ctrl+D),
// Favorit (Cmd/Ctrl+B) and Hapus (Delete) itself when it has the focus (documents-ui.ts), and a key of the menu would also run them from a box that a note is being typed in.

export type Platform = 'darwin' | 'win32' | 'linux';
/** Who does it: the page of the window (documents, objects, sessions, tabs) or the main process (the theme, the full screen, the toolbar's visibility, About, quitting). */
export type Owner = 'window' | 'main';
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

const list = [
  // ---- documents
  { id: 'doc.new', label: 'Dokumen Baru…', owner: 'window', keys: { mac: 'Cmd+N', other: 'Ctrl+N' }, button: 'doc-new', short: 'Baru', icon: 'new' },
  { id:'doc.password',label:'Ganti Password Dokumen…',owner:'window',button:'doc-password-open' },
  { id: 'doc.properties', label:'Properti Dokumen…',owner:'window',button:'doc-properties-open' },
  { id: 'doc.vault', label: 'Vault dan Kredensial…', owner: 'window', button: 'credentials-open' },
  { id: 'obj.templates', label: 'Template…', owner: 'window', button: 'templates-open' },
  { id: 'doc.open', label: 'Buka Dokumen…', owner: 'window', keys: { mac: 'Cmd+O', other: 'Ctrl+O' }, button: 'doc-open', short: 'Buka', icon: 'open' },
  { id: 'doc.save', label: 'Simpan', owner: 'window', keys: { mac: 'Cmd+S', other: 'Ctrl+S' }, button: 'doc-save', short: 'Simpan', icon: 'save' },
  { id: 'doc.close', label: 'Tutup Dokumen', owner: 'window', keys: { mac: 'Shift+Cmd+W', other: 'Ctrl+Shift+W' }, button: 'doc-close', short: 'Tutup', icon: 'close' },
  { id: 'doc.reload', label: 'Muat Ulang Dokumen…', owner: 'window', button: 'doc-reload', short: 'Muat ulang', icon: 'reload' },
  { id: 'doc.conflicts', label: 'Konflik…', owner: 'window', button: 'doc-conflicts', short: 'Konflik', icon: 'conflict' },
  { id: 'doc.history', label: 'Riwayat Revisi…', owner: 'window', button: 'doc-history', short: 'Riwayat', icon: 'history' },
  // 02-B3b: the key that the system remembers for a document is forgotten when a document is selected (menu-model.ts: when closing it can be done), and the recent documents are ten items that the main process fills with names
  { id: 'doc.forgetKey', label: 'Lupakan Kunci yang Diingat', owner: 'window' },
  { id: 'doc.recent.1', label: 'Terbaru 1', owner: 'window' },
  { id: 'doc.recent.2', label: 'Terbaru 2', owner: 'window' },
  { id: 'doc.recent.3', label: 'Terbaru 3', owner: 'window' },
  { id: 'doc.recent.4', label: 'Terbaru 4', owner: 'window' },
  { id: 'doc.recent.5', label: 'Terbaru 5', owner: 'window' },
  { id: 'doc.recent.6', label: 'Terbaru 6', owner: 'window' },
  { id: 'doc.recent.7', label: 'Terbaru 7', owner: 'window' },
  { id: 'doc.recent.8', label: 'Terbaru 8', owner: 'window' },
  { id: 'doc.recent.9', label: 'Terbaru 9', owner: 'window' },
  { id: 'doc.recent.10', label: 'Terbaru 10', owner: 'window' },
  { id: 'doc.recent.clear', label: 'Bersihkan Daftar', owner: 'main' },
  { id: 'doc.autosave.off', label: 'Mati', owner: 'window', button: 'doc-autosave' },
  { id: 'doc.autosave.close', label: 'Saat Ditutup', owner: 'window', button: 'doc-autosave' },
  { id: 'doc.autosave.edit', label: 'Saat Diedit', owner: 'window', button: 'doc-autosave' },
  // ---- objects and the tree
  { id: 'obj.connect', label: 'Hubungkan', owner: 'window', button: 'obj-connect', short: 'Hubungkan', icon: 'connect' },
  { id: 'obj.addFolder', label: 'Folder Baru…', owner: 'window', keys: { mac: 'Shift+Cmd+N', other: 'Ctrl+Shift+N' }, button: 'obj-add-folder', short: 'Folder', icon: 'folder-add' },
  { id: 'obj.addConnection', label: 'Koneksi Baru…', owner: 'window', keys: { mac: 'Alt+Cmd+N', other: 'Ctrl+Shift+C' }, button: 'obj-add-connection', short: 'Koneksi', icon: 'connection-add' },
  { id: 'obj.edit', label: 'Properti…', owner: 'window', keys: { mac: 'Cmd+I', other: 'Ctrl+I' }, button: 'obj-edit', short: 'Properti', icon: 'properties' },
  { id:'obj.bulk',label:'Batch / Koneksi Banyak…',owner:'window',button:'obj-bulk' },
  { id:'obj.transfer',label:'Salin / Pindah ke Dokumen…',owner:'window',button:'obj-transfer' },
  { id: 'obj.duplicate', label: 'Duplikat', owner: 'window', button: 'obj-duplicate', short: 'Duplikat', icon: 'duplicate' },
  { id: 'obj.favorite', label: 'Favorit', owner: 'window', button: 'obj-favorite', short: 'Favorit', icon: 'favorite' },
  { id: 'obj.remove', label: 'Hapus', owner: 'window', button: 'obj-remove', short: 'Hapus', icon: 'remove' },
  { id: 'tree.expandAll', label: 'Buka Semua Folder', owner: 'window', button: 'tree-expand', short: 'Buka semua', icon: 'expand' },
  { id: 'tree.collapseAll', label: 'Tutup Semua Folder', owner: 'window', button: 'tree-collapse', short: 'Tutup semua', icon: 'collapse' },
  { id: 'find', label: 'Cari…', owner: 'window', keys: { mac: 'Cmd+F', other: 'Ctrl+F' }, short: 'Cari', icon: 'search' },
  { id: 'adhoc.focus', label: 'Koneksi Cepat', owner: 'window', keys: { mac: 'Cmd+L', other: 'Ctrl+L' }, short: 'Koneksi cepat', icon: 'quick' },
  // ---- sessions
  { id: 'session.reconnect', label: 'Hubungkan Ulang', owner: 'window', keys: { mac: 'Shift+Cmd+R', other: 'Ctrl+Shift+R' }, button: 'reconnect', short: 'Hubungkan ulang', icon: 'reconnect' },
  { id: 'session.disconnect', label: 'Putuskan', owner: 'window', button: 'disconnect', short: 'Putuskan', icon: 'disconnect' },
  { id: 'session.closeTab', label: 'Tutup Tab', owner: 'window', keys: { mac: 'Cmd+W', other: 'Ctrl+W' }, button: 'close-tab', short: 'Tutup tab', icon: 'close-tab' },
  { id: 'session.release', label: 'Lepas Papan Ketik dari Sesi', owner: 'window', keys: { mac: 'Ctrl+Alt+Cmd+K', other: 'Ctrl+Alt+Shift+K' } },
  // ---- tabs
  { id: 'tab.next', label: 'Tab Berikutnya', owner: 'window', keys: { mac: 'Ctrl+Tab', other: 'Ctrl+Tab' } },
  { id: 'tab.previous', label: 'Tab Sebelumnya', owner: 'window', keys: { mac: 'Ctrl+Shift+Tab', other: 'Ctrl+Shift+Tab' } },
  { id: 'tab.1', label: 'Tab 1', owner: 'window', keys: { mac: 'Cmd+1', other: 'Ctrl+1' } },
  { id: 'tab.2', label: 'Tab 2', owner: 'window', keys: { mac: 'Cmd+2', other: 'Ctrl+2' } },
  { id: 'tab.3', label: 'Tab 3', owner: 'window', keys: { mac: 'Cmd+3', other: 'Ctrl+3' } },
  { id: 'tab.4', label: 'Tab 4', owner: 'window', keys: { mac: 'Cmd+4', other: 'Ctrl+4' } },
  { id: 'tab.5', label: 'Tab 5', owner: 'window', keys: { mac: 'Cmd+5', other: 'Ctrl+5' } },
  { id: 'tab.6', label: 'Tab 6', owner: 'window', keys: { mac: 'Cmd+6', other: 'Ctrl+6' } },
  { id: 'tab.7', label: 'Tab 7', owner: 'window', keys: { mac: 'Cmd+7', other: 'Ctrl+7' } },
  { id: 'tab.8', label: 'Tab 8', owner: 'window', keys: { mac: 'Cmd+8', other: 'Ctrl+8' } },
  { id: 'tab.9', label: 'Tab 9', owner: 'window', keys: { mac: 'Cmd+9', other: 'Ctrl+9' } },
  { id: 'tab.last', label: 'Tab Terakhir', owner: 'window' },
  // 02-B3b: a tab is moved with the pointer, with Alt and the arrows when it has the focus (tabs-ui.ts), and from the menu; none has a key of the menu
  { id: 'tab.moveLeft', label: 'Pindahkan Tab ke Kiri', owner: 'window' },
  { id: 'tab.moveRight', label: 'Pindahkan Tab ke Kanan', owner: 'window' },
  // ---- view
  { id: 'view.toolbar', label: 'Toolbar', owner: 'main', keys: { mac: 'Alt+Cmd+T', other: 'Ctrl+Shift+B' } },
  { id: 'view.customizeToolbar', label: 'Sesuaikan Toolbar…', owner: 'window' },
  { id: 'view.colorizeTabs', label: 'Warnai Tab', owner: 'main' },
  { id: 'view.theme.system', label: 'Otomatis', owner: 'main' },
  { id: 'view.theme.light', label: 'Terang', owner: 'main' },
  { id: 'view.theme.dark', label: 'Gelap', owner: 'main' },
  { id: 'view.fullscreen', label: 'Layar Penuh', owner: 'main', keys: { mac: 'Ctrl+Cmd+F', other: 'F11' }, short: 'Layar penuh', icon: 'fullscreen' },
  { id: 'view.extendedFullscreen', label: 'Layar Penuh yang Diperluas', owner: 'main' },
  // ---- help and the application
  { id: 'help.shortcuts', label: 'Pintasan Papan Ketik…', owner: 'window' },
  { id: 'app.settings', label: 'Pengaturan…', owner: 'main', keys: { mac: 'Cmd+,', other: 'Ctrl+,' } },
  { id: 'app.about', label: 'Tentang Remote Workspace', owner: 'main' },
  { id: 'app.quit', label: 'Keluar', owner: 'main', keys: { mac: 'Cmd+Q' } },
] as const;

export type CommandId = (typeof list)[number]['id'];
export type CommandSpec = {
  readonly id: CommandId;
  /** The words of the menu item. */
  readonly label: string;
  readonly owner: Owner;
  /** The key that does it, in the syntax Electron reads: `mac` on macOS, `other` on the rest. */
  readonly keys?: { readonly mac?: string; readonly other?: string };
  /** The id of the control of the page that does the same; what the window tells about this command is read from it. */
  readonly button?: string;
  /** The words of the button in the toolbar (the commands that have none are not offered there) and the picture that goes with them (toolbar-icons.ts). */
  readonly short?: string;
  readonly icon?: string;
};
export const COMMANDS: readonly CommandSpec[] = list;
export const COMMAND_IDS: readonly CommandId[] = list.map((c) => c.id);
const byId = new Map<string, CommandSpec>(COMMANDS.map((c) => [c.id, c]));
/** A tab is chosen by its number up to this many; the window never has more tabs than a person can look at, and a report that claims more is not believed. */
export const MAX_TABS = 1000;
/** How many recent documents the menu holds: one command for each of them (the main process knows their names, the window only which one is chosen). */
export const MAX_RECENT = 10;
/** Which recent document a command is (counting from 0), or nothing for any other command (clearing the list is not one of them). */
export function recentIndex(id: CommandId): number | undefined {
  const found = id.match(/^doc\.recent\.([1-9]|10)$/);
  return found ? Number(found[1]) - 1 : undefined;
}

export function isCommand(value: unknown): value is CommandId { return typeof value === 'string' && byId.has(value); }
export function spec(id: CommandId): CommandSpec {
  const found = byId.get(id);
  if (!found) throw new Error(`unknown command: ${String(id)}`);
  return found;
}
export function keysFor(command: CommandSpec, platform: Platform): string | undefined { return platform === 'darwin' ? command.keys?.mac : command.keys?.other; }
/** The platform of the process as the shell knows it: Windows and Linux are themselves, anything else is macOS. */
export function platformFrom(name: unknown): Platform { return name === 'win32' || name === 'linux' ? name : 'darwin'; }

const MAC_SYMBOLS: Readonly<Record<string, string>> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
const OTHER_ORDER = ['Ctrl', 'Alt', 'Shift'];
/** A key told to a person: the symbols of macOS (⇧⌘W), or words elsewhere (Ctrl+Shift+W). */
export function describeKeys(accelerator: string, platform: Platform): string {
  const parts = accelerator.split('+');
  const key = parts.pop()!;
  if (platform === 'darwin') {
    const shown = key === 'Return' ? '↩' : key === 'Tab' ? '⇥' : key;
    return MAC_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_SYMBOLS[m]).join('') + shown;
  }
  return [...OTHER_ORDER.filter((m) => parts.includes(m)), key === 'Return' ? 'Enter' : key].join('+');
}

/**
 * What the window tells the main process, as a small piece of data: the commands that can be done now (read from the buttons of the page and from what the window itself knows),
 * the ones that are on or chosen (a favourite, the way of saving by itself), whether the keyboard belongs to a remote screen (a connected session has the focus: every key must reach it),
 * whether a dialog of the page is open, and the tabs (how many, which one is in front).
 */
export type Report = {
  readonly enabled: readonly CommandId[];
  readonly checked: readonly CommandId[];
  readonly capture: boolean;
  readonly dialog: boolean;
  readonly tabs: number;
  readonly tab: number;
};
export const EMPTY_REPORT: Report = { enabled: [], checked: [], capture: false, dialog: false, tabs: 0, tab: -1 };

/** A report made from sets, in the order of the list of commands: two reports of the same state are equal whatever order they were gathered in. */
export function makeReport(input: { enabled: ReadonlySet<CommandId>; checked: ReadonlySet<CommandId>; capture: boolean; dialog: boolean; tabs: number; tab: number }): Report {
  return { enabled: COMMAND_IDS.filter((id) => input.enabled.has(id)), checked: COMMAND_IDS.filter((id) => input.checked.has(id)), capture: input.capture, dialog: input.dialog, tabs: input.tabs, tab: input.tab };
}
export function sameReport(a: Report, b: Report): boolean {
  return a.capture === b.capture && a.dialog === b.dialog && a.tabs === b.tabs && a.tab === b.tab && a.enabled.join() === b.enabled.join() && a.checked.join() === b.checked.join();
}

const REPORT_KEYS = ['enabled', 'checked', 'capture', 'dialog', 'tabs', 'tab'];
function commandList(value: unknown): CommandId[] | undefined {
  if (!Array.isArray(value) || value.length > COMMAND_IDS.length || !value.every(isCommand) || new Set(value).size !== value.length) return undefined;
  return value as CommandId[];
}
/** The report in what arrived, or nothing when any part of it is not what it should be (a stranger's message, or a window that is not this version). Every key must be the report's own, and no other. */
export function parseReport(value: unknown): Report | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== REPORT_KEYS.length || !REPORT_KEYS.every((k) => Object.hasOwn(value, k))) return undefined;
  const v = value as Record<string, unknown>;
  const enabled = commandList(v.enabled), checked = commandList(v.checked);
  if (!enabled || !checked || typeof v.capture !== 'boolean' || typeof v.dialog !== 'boolean') return undefined;
  const { tabs, tab } = v;
  if (typeof tabs !== 'number' || !Number.isInteger(tabs) || tabs < 0 || tabs > MAX_TABS || typeof tab !== 'number' || !Number.isInteger(tab) || tab < -1 || tab >= Math.max(tabs, 1) && tab !== -1) return undefined;
  if (tabs === 0 && tab !== -1) return undefined;
  return makeReport({ enabled: new Set(enabled), checked: new Set(checked), capture: v.capture, dialog: v.dialog, tabs, tab });
}
