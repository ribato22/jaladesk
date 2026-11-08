import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_IDS, EMPTY_REPORT, keysFor, spec, type CommandId, type Platform, type Report } from '../src/desktop/commands.js';
import { RESERVED_IN_CAPTURE, SYSTEM_KEYS_IN_CAPTURE, buildMenu, findCommand, isAvailable, type Entry, type Flags, type Menu, type Role } from '../src/desktop/menu-model.js';

const FLAGS: Flags = { theme: 'system', toolbar: true, fullscreen: false, prompt: false };
const NAME = 'Remote Workspace';
const menu = (platform: Platform, report: Partial<Report> = {}, flags: Partial<Flags> = {}): Menu => buildMenu({ platform, appName: NAME, report: { ...EMPTY_REPORT, ...report }, flags: { ...FLAGS, ...flags } });

type Command = Extract<Entry, { kind: 'command' }>;
/** Every entry of the menu, depth first, each with the labels of the submenus above it. */
function walk(entries: readonly Entry[], path: string[] = []): { entry: Entry; path: string[] }[] {
  return entries.flatMap((entry) => entry.kind === 'submenu' ? [{ entry, path }, ...walk(entry.items, [...path, entry.label])] : [{ entry, path }]);
}
const all = (m: Menu) => walk(m);
const commands = (m: Menu): Command[] => all(m).flatMap(({ entry }) => entry.kind === 'command' ? [entry] : []);
const find = (m: Menu, id: CommandId): Command => { const found = commands(m).filter((c) => c.id === id); assert.equal(found.length, 1, `${id} appears once`); return found[0]!; };
const labels = (m: Menu) => m.map((s) => s.label);
const section = (m: Menu, label: string) => m.find((s) => s.label === label)!;

test('on macOS the menu has the menu of the application and five more, in the order a Mac user looks for them', () => {
  assert.deepEqual(labels(menu('darwin')), [NAME, 'Berkas', 'Sunting', 'Objek', 'Tampilan', 'Jendela', 'Bantuan']);
});

test('on Windows and Linux there is no menu of the application: quitting is in Berkas and About is in Bantuan', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const m = menu(platform);
    assert.deepEqual(labels(m), ['Berkas', 'Sunting', 'Objek', 'Tampilan', 'Jendela', 'Bantuan'], platform);
    const file = section(m, 'Berkas').items;
    assert.equal((file.at(-1) as Command).id, 'app.quit', platform);
    assert.equal(file.at(-2)!.kind, 'separator');
    assert.equal((section(m, 'Bantuan').items.at(-1) as Command).id, 'app.about', platform);
  }
  const mac = menu('darwin');
  assert.equal((section(mac, NAME).items[0] as Command).id, 'app.about');
  assert.equal((section(mac, NAME).items.at(-1) as Command).id, 'app.quit');
  assert.equal(section(mac, NAME).items.at(-1)!.kind === 'command' && (section(mac, NAME).items.at(-1) as Command).label, `Keluar dari ${NAME}`);
  assert.equal(find(menu('win32'), 'app.quit').label, 'Keluar');
});

test('every command is in the menu once, on every platform, and nothing in it is a command that does not exist', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const ids = commands(menu(platform)).map((c) => c.id);
    assert.deepEqual([...ids].sort(), [...COMMAND_IDS].sort(), platform);
  }
});

test('the keys of the items are the keys of the commands for the platform, and an item without a key has none', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    for (const c of commands(menu(platform))) assert.equal(c.accelerator, keysFor(spec(c.id), platform), `${platform} ${c.id}`);
  }
});

test('the words of the items are the words of the commands, except the ones that say what a press does now or name the application', () => {
  const m = menu('darwin');
  for (const c of commands(m)) {
    if (['view.toolbar', 'view.fullscreen', 'app.about', 'app.quit'].includes(c.id)) continue;
    assert.equal(c.label, spec(c.id).label, c.id);
  }
  assert.equal(find(menu('darwin', {}, { toolbar: true }), 'view.toolbar').label, 'Sembunyikan Toolbar');
  assert.equal(find(menu('darwin', {}, { toolbar: false }), 'view.toolbar').label, 'Tampilkan Toolbar');
  assert.equal(find(menu('darwin', {}, { fullscreen: false }), 'view.fullscreen').label, 'Masuk Layar Penuh');
  assert.equal(find(menu('darwin', {}, { fullscreen: true }), 'view.fullscreen').label, 'Keluar dari Layar Penuh');
  assert.equal(find(menu('win32'), 'app.about').label, `Tentang ${NAME}`);
  const other = buildMenu({ platform: 'darwin', appName: 'Aplikasi Lain', report: EMPTY_REPORT, flags: FLAGS });
  assert.equal(find(other, 'app.about').label, 'Tentang Aplikasi Lain');
  assert.equal(find(other, 'app.quit').label, 'Keluar dari Aplikasi Lain');
  assert.equal(section(other, 'Aplikasi Lain').label, 'Aplikasi Lain', 'the menu of the application carries its name');
});

test('Jendela has the standard items in the words of the menu, then the tabs in the order a person goes through them', () => {
  const words = (m: Menu) => section(m, 'Jendela').items.map((e) => e.kind === 'separator' ? '|' : e.label);
  assert.deepEqual(words(menu('darwin')), ['Minimalkan', 'Perbesar', '|', 'Tab Berikutnya', 'Tab Sebelumnya', 'Pindahkan Tab ke Kiri', 'Pindahkan Tab ke Kanan', 'Pilih Tab', '|', 'Bawa Semua ke Depan']);      // 02-B3b: the two ways to move a tab
  assert.deepEqual(words(menu('win32')), ['Minimalkan', '|', 'Tab Berikutnya', 'Tab Sebelumnya', 'Pindahkan Tab ke Kiri', 'Pindahkan Tab ke Kanan', 'Pilih Tab']);
  const picks = section(menu('darwin'), 'Jendela').items.find((e) => e.kind === 'submenu' && e.label === 'Pilih Tab');
  assert.deepEqual(picks!.kind === 'submenu' && picks!.items.map((e) => (e as Command).id), ['tab.1', 'tab.2', 'tab.3', 'tab.4', 'tab.5', 'tab.6', 'tab.7', 'tab.8', 'tab.9', 'tab.last']);
});

test('the standard items of Sunting and Jendela are the standard ones of the system, so that they work on whatever has the focus', () => {
  const roles = (m: Menu, name: string) => section(m, name).items.flatMap((e) => e.kind === 'role' ? [e.role] : []);
  assert.deepEqual(roles(menu('darwin'), 'Sunting'), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  assert.deepEqual(roles(menu('win32'), 'Sunting'), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  assert.deepEqual(roles(menu('darwin'), 'Jendela'), ['minimize', 'zoom', 'front']);
  assert.deepEqual(roles(menu('win32'), 'Jendela'), ['minimize']);
  assert.deepEqual(roles(menu('darwin'), NAME), ['services', 'hide', 'hideOthers', 'unhide']);
  assert.deepEqual(roles(menu('win32'), 'Berkas'), []);
  const edit = section(menu('darwin'), 'Sunting').items;
  assert.equal((edit.at(-1) as Command).id, 'find', 'Cari is the last of Sunting');
  assert.equal(edit.at(-2)!.kind, 'separator');
  assert.deepEqual(section(menu('darwin'), NAME).items.flatMap((e) => e.kind === 'role' ? [e.label] : []), ['Layanan', 'Sembunyikan Remote Workspace', 'Sembunyikan yang Lain', 'Tampilkan Semua']);
});

test('what cannot be done now is off: when the window has said nothing only the commands that need nothing from it are on', () => {
  const on = commands(menu('darwin')).filter((c) => c.enabled).map((c) => c.id).sort();
  // 02-B3b adds the settings and the two switches of the view, which are the main process's own; clearing the list of recent documents is too, but there is nothing to clear
  assert.deepEqual(on, ['adhoc.focus', 'app.about', 'app.quit', 'app.settings', 'find', 'help.shortcuts', 'view.colorizeTabs', 'view.customizeToolbar', 'view.extendedFullscreen', 'view.fullscreen', 'view.theme.dark', 'view.theme.light', 'view.theme.system', 'view.toolbar']);
});

test('a command that the window says can be done is on, and one that it does not say is off', () => {
  const m = menu('darwin', { enabled: ['doc.new', 'doc.open', 'doc.save', 'obj.connect'] });
  for (const id of ['doc.new', 'doc.open', 'doc.save', 'obj.connect'] as const) assert.equal(find(m, id).enabled, true, id);
  for (const id of ['doc.close', 'doc.reload', 'obj.edit', 'obj.remove', 'session.reconnect', 'session.closeTab', 'tree.expandAll'] as const) assert.equal(find(m, id).enabled, false, id);
  const none = menu('darwin');
  assert.equal(find(none, 'doc.new').enabled, false, 'what the window did not say is off, even the commands that nothing stops');
  for (const id of ['find', 'adhoc.focus', 'help.shortcuts', 'view.customizeToolbar', 'app.about', 'app.quit', 'view.toolbar', 'view.fullscreen', 'view.theme.dark'] as const) assert.equal(find(none, id).enabled, true, id);
});

test('the tabs are chosen only when they are there, and the keyboard is given back only when it is held', () => {
  const none = menu('darwin');
  for (const id of ['tab.next', 'tab.previous', 'tab.1', 'tab.9', 'tab.last', 'session.release'] as const) assert.equal(find(none, id).enabled, false, id);
  const one = menu('darwin', { tabs: 1, tab: 0 });
  assert.equal(find(one, 'tab.1').enabled, true);
  assert.equal(find(one, 'tab.2').enabled, false);
  assert.equal(find(one, 'tab.last').enabled, true);
  assert.equal(find(one, 'tab.next').enabled, false, 'one tab: nowhere to go');
  assert.equal(find(one, 'tab.previous').enabled, false);
  const three = menu('darwin', { tabs: 3, tab: 1 });
  assert.deepEqual([1, 2, 3, 4, 9].map((n) => find(three, `tab.${n}` as CommandId).enabled), [true, true, true, false, false]);
  assert.equal(find(three, 'tab.next').enabled && find(three, 'tab.previous').enabled && find(three, 'tab.last').enabled, true);
  assert.equal(find(three, 'session.release').enabled, false);
  assert.equal(find(menu('darwin', { tabs: 3, tab: 1, capture: true }), 'session.release').enabled, true);
  const nine = menu('darwin', { tabs: 9, tab: 8 });
  assert.equal(find(nine, 'tab.9').enabled, true);
});

test('the tab in front is marked in Pilih Tab: Tab 1 to 9 are check boxes, and one of them is on when there is a tab in front', () => {
  const m = menu('darwin', { tabs: 3, tab: 1 });
  for (let n = 1; n <= 9; n++) {
    const item = find(m, `tab.${n}` as CommandId);
    assert.equal(item.control, 'checkbox', `Tab ${n}`);
    assert.equal(item.checked, n === 2, `Tab ${n}`);
  }
  assert.equal(find(m, 'tab.last').control, undefined);
  assert.equal(find(m, 'tab.next').control, undefined);
  for (const none of [menu('darwin'), menu('darwin', { tabs: 3, tab: -1 })]) for (let n = 1; n <= 9; n++) assert.equal(find(none, `tab.${n}` as CommandId).checked, false, `no tab in front: Tab ${n}`);
  assert.equal(find(menu('win32', { tabs: 9, tab: 8 }), 'tab.9').checked, true);
});

test('while a dialog of the window is open the commands of the window are off, and the ones of the main process stay on', () => {
  const m = menu('darwin', { enabled: ['doc.new', 'doc.save', 'obj.edit'], tabs: 2, tab: 0, dialog: true });
  for (const c of commands(m)) assert.equal(c.enabled, spec(c.id).owner === 'main' && c.id !== 'doc.recent.clear', c.id);      // 02-B3b: clearing the list is the main process's own, but needs a list
});

test('while a window of the main process asks for a password nothing can be done but quitting', () => {
  const m = menu('darwin', { enabled: ['doc.new', 'doc.save'], tabs: 2, tab: 0 }, { prompt: true });
  assert.deepEqual(commands(m).filter((c) => c.enabled).map((c) => c.id), ['app.quit']);
  const w = menu('win32', { enabled: ['doc.new'] }, { prompt: true });
  assert.deepEqual(commands(w).filter((c) => c.enabled).map((c) => c.id), ['app.quit']);
});

// Review of the execution (22 October 2026): a page whose process died can do nothing, and the commands that need nothing from the window need the window to be there
test('a page that is gone can do nothing: of the commands only those of the main process are on, and the ones that need nothing from the window are not', () => {
  const everything = { enabled: [...COMMAND_IDS], tabs: 3, tab: 0, capture: true };
  const m = menu('darwin', everything, { pageGone: true });
  for (const c of commands(m)) assert.equal(c.enabled, spec(c.id).owner === 'main' && c.id !== 'doc.recent.clear', c.id);      // 02-B3b: clearing the list is the main process's own, but needs a list
  for (const id of ['find', 'adhoc.focus', 'view.customizeToolbar', 'help.shortcuts'] as const) assert.equal(find(m, id).enabled, false, id);
  for (const id of ['app.quit', 'app.about', 'view.toolbar', 'view.fullscreen', 'view.theme.dark'] as const) assert.equal(find(m, id).enabled, true, id);
  // a window of the main process in front still turns off everything but quitting
  assert.deepEqual(commands(menu('darwin', {}, { pageGone: true, prompt: true })).filter((c) => c.enabled).map((c) => c.id), ['app.quit']);
  // and a page that is there is as it was
  for (const c of commands(menu('darwin', everything, { pageGone: false }))) assert.equal(c.enabled, isAvailable(c.id, { ...EMPTY_REPORT, ...everything }, { prompt: false }), c.id);
});

test('while a window of the main process is open the keyboard is not the session\'s, even if the canvas of a session still has the focus of the page: the items of Sunting are the standard ones and every key is there', () => {
  const m = menu('darwin', { capture: true, enabled: ['doc.save'] }, { prompt: true });
  const items = section(m, 'Sunting').items;
  assert.equal(items.filter((e) => e.kind === 'role').length, 6, 'Cmd+V reaches the box of the password');
  assert.equal(items.filter((e) => e.kind === 'plain').length, 0);
  assert.equal(find(m, 'doc.save').accelerator, 'Cmd+S');
  assert.equal(find(m, 'doc.open').accelerator, 'Cmd+O');
  const w = menu('win32', { capture: true }, { prompt: true });
  assert.equal(find(w, 'view.fullscreen').accelerator, 'F11');
});

test('in every group of radio items exactly one is on, whatever the window says: the system turns the first on by itself when none is, and the menu must say the same', () => {
  let seed = 5;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const groups = [['doc.autosave.off', 'doc.autosave.close', 'doc.autosave.edit'], ['view.theme.system', 'view.theme.light', 'view.theme.dark']] as const;
  for (let n = 0; n < 200; n++) {
    const report: Report = { ...EMPTY_REPORT, checked: COMMAND_IDS.filter(() => random() < 0.3), enabled: COMMAND_IDS.filter(() => random() < 0.5) };
    const flags: Flags = { ...FLAGS, theme: (['system', 'light', 'dark'] as const)[Math.floor(random() * 3)]! };
    const m = buildMenu({ platform: 'darwin', appName: NAME, report, flags });
    for (const group of groups) {
      const on = group.filter((id) => find(m, id).checked);
      assert.equal(on.length, 1, `${JSON.stringify(report.checked)}: ${on.join(', ')}`);
    }
  }
  const nothing = menu('darwin');
  assert.equal(find(nothing, 'doc.autosave.off').checked, true, 'with no document the first one shows, as it would anyway');
  assert.equal(find(menu('darwin', { checked: ['doc.autosave.edit'] }), 'doc.autosave.off').checked, false);
  assert.equal(find(menu('darwin', { checked: ['doc.autosave.edit'] }), 'doc.autosave.edit').checked, true);
});

test('what is chosen is shown: the way of saving by itself, the favourite, the theme', () => {
  const m = menu('darwin', { enabled: ['doc.autosave.off', 'doc.autosave.close', 'doc.autosave.edit', 'obj.favorite'], checked: ['doc.autosave.close', 'obj.favorite'] }, { theme: 'dark' });
  assert.deepEqual(['doc.autosave.off', 'doc.autosave.close', 'doc.autosave.edit'].map((id) => [find(m, id as CommandId).control, find(m, id as CommandId).checked]), [['radio', false], ['radio', true], ['radio', false]]);
  assert.deepEqual(['view.theme.system', 'view.theme.light', 'view.theme.dark'].map((id) => [find(m, id as CommandId).control, find(m, id as CommandId).checked]), [['radio', false], ['radio', false], ['radio', true]]);
  assert.deepEqual([find(m, 'obj.favorite').control, find(m, 'obj.favorite').checked], ['checkbox', true]);
  for (const theme of ['system', 'light', 'dark'] as const) {
    const checked = commands(menu('win32', {}, { theme })).filter((c) => c.id.startsWith('view.theme.') && c.checked).map((c) => c.id);
    assert.deepEqual(checked, [`view.theme.${theme}`]);
  }
  assert.equal(find(menu('darwin'), 'doc.save').control, undefined, 'a plain command is not a checkbox');
});

test('the way of saving by itself and the themes are submenus of their own, and the tabs too', () => {
  const m = menu('darwin');
  const paths = new Map(all(m).flatMap(({ entry, path }) => entry.kind === 'command' ? [[entry.id, path.join(' > ')] as const] : []));
  assert.equal(paths.get('doc.autosave.edit'), 'Berkas > Simpan Otomatis');
  assert.equal(paths.get('view.theme.light'), 'Tampilan > Tema');
  assert.equal(paths.get('tab.4'), 'Jendela > Pilih Tab');
  assert.equal(paths.get('tab.next'), 'Jendela');
  assert.equal(paths.get('session.release'), 'Objek');
  assert.equal(paths.get('doc.save'), 'Berkas');
  assert.equal(paths.get('find'), 'Sunting');
});

/** The key that Electron gives a standard item by itself (its documentation of roles): the menu does not write it, the system does. */
const ROLE_KEYS: Record<Role, { mac?: string; other?: string }> = {
  undo: { mac: 'Cmd+Z', other: 'Ctrl+Z' }, redo: { mac: 'Shift+Cmd+Z', other: 'Ctrl+Y' }, cut: { mac: 'Cmd+X', other: 'Ctrl+X' }, copy: { mac: 'Cmd+C', other: 'Ctrl+C' },
  paste: { mac: 'Cmd+V', other: 'Ctrl+V' }, selectAll: { mac: 'Cmd+A', other: 'Ctrl+A' }, minimize: { mac: 'Cmd+M', other: 'Ctrl+M' }, hide: { mac: 'Cmd+H' }, hideOthers: { mac: 'Alt+Cmd+H' },
  zoom: {}, front: {}, unhide: {}, services: {},
};
/** Every key that the menu would take while a session holds the keyboard: the keys of the commands that have one, and the keys of the standard items that are there. */
function keysTaken(m: Menu, platform: Platform): string[] {
  const keys: string[] = [];
  for (const { entry } of all(m)) {
    if (entry.kind === 'command' && entry.accelerator !== undefined) keys.push(entry.accelerator);
    if (entry.kind === 'role') { const key = platform === 'darwin' ? ROLE_KEYS[entry.role].mac : ROLE_KEYS[entry.role].other; if (key !== undefined) keys.push(key); }
  }
  return keys.sort();
}

test('while a connected session has the keyboard the menu takes no key but the few that are the system\'s or give the keyboard back: written out for each platform, standard items included', () => {
  const expected: Record<Platform, string[]> = {
    darwin: ['Alt+Cmd+H', 'Cmd+H', 'Cmd+M', 'Cmd+Q', 'Ctrl+Alt+Cmd+K', 'Ctrl+Cmd+F'],
    win32: ['Ctrl+Alt+Shift+K'],
    linux: ['Ctrl+Alt+Shift+K'],
  };
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    assert.deepEqual(keysTaken(menu(platform, { enabled: [...COMMAND_IDS], capture: true, tabs: 2, tab: 0 }), platform), expected[platform].sort(), platform);
    assert.ok(keysTaken(menu(platform), platform).length > expected[platform].length + 20, `${platform}: with the keyboard free there are many more`);
  }
  assert.deepEqual([...RESERVED_IN_CAPTURE.darwin].sort(), ['app.quit', 'session.release', 'view.fullscreen']);
  assert.deepEqual(RESERVED_IN_CAPTURE.win32, ['session.release'], 'F11 and Ctrl+Q are the session\'s on Windows');
  assert.deepEqual(RESERVED_IN_CAPTURE.linux, ['session.release']);
  assert.deepEqual(SYSTEM_KEYS_IN_CAPTURE.darwin.map((k: { key: string }) => k.key).sort(), ['Alt+Cmd+H', 'Cmd+H', 'Cmd+M']);
  assert.deepEqual(SYSTEM_KEYS_IN_CAPTURE.win32, []);
  assert.deepEqual(SYSTEM_KEYS_IN_CAPTURE.linux, []);
  // everything else is still there to be chosen with the pointer
  const held = menu('darwin', { enabled: ['doc.save', 'doc.new'], capture: true, tabs: 1, tab: 0 });
  assert.equal(find(held, 'doc.save').enabled, true);
  assert.equal(find(held, 'doc.save').accelerator, undefined);
  assert.equal(find(held, 'view.fullscreen').accelerator, 'Ctrl+Cmd+F');
  assert.equal(find(held, 'session.release').accelerator, 'Ctrl+Alt+Cmd+K');
  assert.equal(find(held, 'app.quit').accelerator, 'Cmd+Q');
  const win = menu('win32', { capture: true, tabs: 1, tab: 0 });
  assert.equal(find(win, 'view.fullscreen').accelerator, undefined, 'F11 reaches the session');
  assert.equal(find(win, 'session.release').accelerator, 'Ctrl+Alt+Shift+K');
  assert.equal(find(menu('win32'), 'view.fullscreen').accelerator, 'F11', 'and is the full screen again when the keyboard is free');
});

test('on Windows and Linux Minimalkan does nothing while a session holds the keyboard (Ctrl+M is Enter in a remote shell; the title bar has the button); on macOS Cmd+M stays the system\'s', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const free = section(menu(platform), 'Jendela').items[0]!;
    assert.deepEqual([free.kind, free.kind !== 'separator' && free.label], ['role', 'Minimalkan'], platform);
    const held = section(menu(platform, { capture: true }), 'Jendela').items[0]!;
    assert.deepEqual([held.kind, held.kind !== 'separator' && held.label, held.kind === 'plain' && held.enabled], ['plain', 'Minimalkan', false], platform);
  }
  const mac = section(menu('darwin', { capture: true }), 'Jendela').items[0]!;
  assert.deepEqual([mac.kind, mac.kind !== 'separator' && mac.label], ['role', 'Minimalkan']);
});

test('while a connected session has the keyboard the items of Sunting do nothing: no key of copying, pasting or undoing is taken from the session', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const items = section(menu(platform, { capture: true }), 'Sunting').items;
    const held = items.flatMap((e) => e.kind === 'plain' ? [e] : []);
    assert.equal(items.filter((e) => e.kind === 'role').length, 0, `${platform}: no standard item, so no key of it`);
    assert.equal(held.length, 6, platform);
    for (const e of held) assert.equal(e.enabled, false, `${platform} ${e.label}`);
    assert.deepEqual(held.map((e) => e.label), ['Urungkan', 'Ulangi', 'Potong', 'Salin', 'Tempel', 'Pilih Semua']);
  }
  const free = section(menu('darwin'), 'Sunting').items.filter((e) => e.kind === 'role');
  assert.equal(free.length, 6, 'with the keyboard free they are the standard items');
  // the items of the system for the application and the window stay what they are
  const roles = (m: Menu) => all(m).flatMap(({ entry }) => entry.kind === 'role' ? [entry.role] : []);
  assert.deepEqual(roles(menu('darwin', { capture: true })), ['services', 'hide', 'hideOthers', 'unhide', 'minimize', 'zoom', 'front']);
  assert.deepEqual(roles(menu('win32', { capture: true })), [], 'nothing of the system is left on Windows');
});

test('the same state gives the same menu, and building it changes nothing it was given', () => {
  const report: Report = { enabled: ['doc.new', 'doc.save'], checked: ['obj.favorite'], capture: false, dialog: false, tabs: 2, tab: 1 };
  const flags: Flags = { ...FLAGS, theme: 'light' };
  const before = JSON.stringify([report, flags]);
  const a = buildMenu({ platform: 'darwin', appName: NAME, report, flags }), b = buildMenu({ platform: 'darwin', appName: NAME, report, flags });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify([report, flags]), before);
  assert.notDeepEqual(a, buildMenu({ platform: 'darwin', appName: NAME, report: { ...report, tabs: 3 }, flags }));
});

test('a menu has no separator at its start or end, none next to another, no empty submenu, and no two items of a submenu with the same words', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    for (const report of [EMPTY_REPORT, { ...EMPTY_REPORT, capture: true, tabs: 2, tab: 0 }]) {
      const m = menu(platform, report);
      for (const { entry } of all(m)) {
        if (entry.kind !== 'submenu') continue;
        assert.ok(entry.items.length > 0, `${platform} ${entry.label}: not empty`);
        assert.notEqual(entry.items[0]!.kind, 'separator', `${platform} ${entry.label}: starts with an item`);
        assert.notEqual(entry.items.at(-1)!.kind, 'separator', `${platform} ${entry.label}: ends with an item`);
        entry.items.forEach((e, i) => { if (e.kind === 'separator') assert.notEqual(entry.items[i + 1]!.kind, 'separator', `${platform} ${entry.label}: two separators`); });
        const words = entry.items.flatMap((e) => e.kind === 'separator' ? [] : [e.label]);
        assert.equal(new Set(words).size, words.length, `${platform} ${entry.label}: ${words.join(', ')}`);
      }
    }
  }
});

test('the words of the menu are words: no leftover marks, no English words of the default menu', () => {
  const ENGLISH = /\b(File|Edit|View|Window|Help|Quit|Hide|Services|Reload|Toggle|Developer|Zoom In|Zoom Out|Actual Size|Close Window|Undo|Redo|Cut|Copy|Paste|Select All)\b/;
  for (const platform of ['darwin', 'win32'] as const) {
    for (const { entry } of all(menu(platform))) {
      if (entry.kind === 'separator') continue;
      assert.match(entry.label, /\S/);
      assert.doesNotMatch(entry.label, ENGLISH, entry.label);
      assert.ok(!entry.label.includes('&'), entry.label);
    }
  }
});

test('a command is found in a menu by its id, wherever it is, and nothing is found for a command that is not there', () => {
  const m = menu('darwin', { enabled: ['doc.save'] });
  for (const id of COMMAND_IDS) assert.equal(findCommand(m, id)?.id, id, id);
  assert.equal(findCommand(m, 'doc.save')?.enabled, true);
  assert.equal(findCommand(m, 'doc.close')?.enabled, false);
  assert.equal(findCommand(m, 'nothing' as CommandId), undefined);
  assert.equal(findCommand([], 'doc.save'), undefined);
});

/** The rule for whether a command can be done, written out again from the description (not from the code) as a second opinion. */
function expectedOn(id: CommandId, report: Report, prompt: boolean, recent: readonly string[] = [], keys = 0): boolean {
  if (id === 'app.quit') return true;
  if (prompt) return false;
  if (id === 'doc.recent.clear') return recent.length > 0;      // 02-B3b: the main process's own, with something to clear
  if (['view.toolbar', 'view.colorizeTabs', 'view.theme.system', 'view.theme.light', 'view.theme.dark', 'view.fullscreen', 'view.extendedFullscreen', 'app.settings', 'app.about'].includes(id)) return true;
  if (report.dialog) return false;
  const place = id.match(/^doc\.recent\.([1-9]|10)$/);
  if (place) return Number(place[1]) <= recent.length;
  if (id === 'doc.forgetKey') return report.enabled.includes('doc.close') && keys > 0;
  if (id === 'tab.moveLeft') return report.tab > 0;
  if (id === 'tab.moveRight') return report.tab >= 0 && report.tab < report.tabs - 1;
  const number = id.match(/^tab\.([1-9])$/);
  if (number) return report.tabs >= Number(number[1]);
  if (id === 'tab.last') return report.tabs >= 1;
  if (id === 'tab.next' || id === 'tab.previous') return report.tabs > 1;
  if (id === 'session.release') return report.capture;
  if (['find', 'adhoc.focus', 'view.customizeToolbar', 'help.shortcuts'].includes(id)) return true;
  return report.enabled.includes(id);
}

test('whether a command can be done is one function, which the menu and the toolbar both ask, and it says what the description says', () => {
  let seed = 11;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const some = () => COMMAND_IDS.filter(() => random() < 0.4);
  for (let n = 0; n < 300; n++) {
    const tabs = Math.floor(random() * 11);
    const report: Report = { enabled: some(), checked: some(), capture: random() < 0.3, dialog: random() < 0.3, tabs, tab: tabs === 0 || random() < 0.1 ? -1 : Math.floor(random() * tabs) };      // 02-B3b: now and then no tab is in front though there are tabs
    const flags: Flags = { theme: 'system', toolbar: random() < 0.5, fullscreen: random() < 0.5, prompt: random() < 0.2, recent: Array.from({ length: Math.floor(random() * 13) }, (_, i) => `D${i}`), keys: Math.floor(random() * 3) };
    for (const platform of ['darwin', 'win32'] as const) {
      const built = buildMenu({ platform, appName: NAME, report, flags });
      for (const id of COMMAND_IDS) {
        assert.equal(findCommand(built, id)?.enabled, isAvailable(id, report, flags), `${platform} ${id}: the menu and the function`);
        assert.equal(isAvailable(id, report, flags), expectedOn(id, report, flags.prompt, flags.recent, flags.keys), `${platform} ${id}: the function and the description`);
      }
    }
  }
  assert.equal(isAvailable('find', EMPTY_REPORT, { prompt: false }), true);
  assert.equal(isAvailable('find', EMPTY_REPORT, { prompt: true }), false);
  assert.equal(isAvailable('app.quit', { ...EMPTY_REPORT, dialog: true }, { prompt: true }), true);
  assert.equal(isAvailable('doc.save', { ...EMPTY_REPORT, enabled: ['doc.save'], dialog: true }, { prompt: false }), false);
});
