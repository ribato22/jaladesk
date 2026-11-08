// The list of keys that the window shows (Bantuan > Pintasan Papan Ketik), made from the list of commands and so never different from what the menu really binds, and the sentence that says
// how the keyboard is shared with a remote session. Plain data: the window draws it (shell-ui.ts).
import { COMMANDS, describeKeys, keysFor, spec, type CommandId, type Platform } from './commands.js';
import { RESERVED_IN_CAPTURE, SYSTEM_KEYS_IN_CAPTURE } from './menu-model.js';

export type ShortcutRow = { readonly id: CommandId; readonly label: string; readonly keys: string };
// The words of a command that the menu changes with what is on (Tampilkan or Sembunyikan) are told here as what the key does in both cases.
const WORDS: Readonly<Partial<Record<CommandId, string>>> = { 'view.toolbar': 'Tampilkan atau Sembunyikan Toolbar' };

/** A row for every command that has a key on the platform, in the order of the list of commands; the nine ways to choose a tab by its number are one row. */
export function shortcutRows(platform: Platform): ShortcutRow[] {
  return COMMANDS.flatMap((command): ShortcutRow[] => {
    const key = keysFor(command, platform);
    if (key === undefined || /^tab\.[2-9]$/.test(command.id)) return [];
    if (command.id === 'tab.1') return [{ id: command.id, label: 'Tab 1 sampai 9', keys: `${describeKeys(key, platform)} … ${describeKeys(keysFor(spec('tab.9'), platform)!, platform)}` }];
    return [{ id: command.id, label: WORDS[command.id] ?? command.label, keys: describeKeys(key, platform) }];
  });
}

/**
 * What the tree does with a key when it has the focus (documents-ui.ts, the handler of its keys). They are keys of the page and not of the menu, so that a note that is being typed is never duplicated or
 * made a favourite by one of them; shell-shortcuts.test.ts reads the handler to see that the list says only what it does.
 */
export const TREE_KEYS: readonly { readonly label: string; readonly mac: string; readonly other: string }[] = [
  { label: 'Hubungkan', mac: '↩', other: 'Enter' },
  { label: 'Duplikat', mac: '⌘D', other: 'Ctrl+D' },
  { label: 'Favorit', mac: '⌘B', other: 'Ctrl+B' },
  { label: 'Hapus', mac: 'Delete atau Backspace', other: 'Delete atau Backspace' },
  { label: 'Pindah', mac: '⌥ + panah', other: 'Alt + panah' },
];
export function treeRows(platform: Platform): { label: string; keys: string }[] {
  return TREE_KEYS.map((row) => ({ label: row.label, keys: platform === 'darwin' ? row.mac : row.other }));
}

/** What a tab does with a key when it has the focus (tabs-ui.ts): moves; shell-shortcuts-b3b.test.ts reads that source to see that the list says only what it does. */
export const TAB_KEYS: readonly { readonly label: string; readonly mac: string; readonly other: string }[] = [
  { label: 'Pindahkan tab', mac: '⌥ + panah kiri atau kanan', other: 'Alt + panah kiri atau kanan' },
];
export function tabRows(platform: Platform): { label: string; keys: string }[] {
  return TAB_KEYS.map((row) => ({ label: row.label, keys: platform === 'darwin' ? row.mac : row.other }));
}

/** What is said about a connected session that holds the keyboard: everything goes to the session, but for the few keys that stay the application's (and the three that the standard items of macOS bring). */
export function captureNote(platform: Platform): string {
  const kept = RESERVED_IN_CAPTURE[platform].flatMap((id) => {
    const key = keysFor(spec(id), platform);
    return key === undefined ? [] : [`${spec(id).label} (${describeKeys(key, platform)})`];
  });
  const system = SYSTEM_KEYS_IN_CAPTURE[platform].map(({ label, key }) => `${label} (${describeKeys(key, platform)})`);
  const note = `Saat sesi remote yang terhubung memegang papan ketik, semua tombol diteruskan ke sesi. Yang tetap milik aplikasi: ${kept.join(', ')}.`;
  // the items of the system that the menu cannot take the keys from are still in the menu, but their keys are not taken by the application: the page gets a key before the menu, so from the screen of a session they reach the session
  return system.length === 0 ? note : `${note} ${system.join(', ')} tetap ada di menu, tetapi tombolnya milik sistem dan tidak diambil aplikasi: bila tidak bekerja dari layar sesi, pilih itemnya dengan tetikus.`;
}
