import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_IDS, EMPTY_REPORT, MAX_RECENT, keysFor, recentIndex, spec, type CommandId, type Platform, type Report } from '../src/desktop/commands.js';
import { buildMenu, findCommand, isAvailable, type Entry, type Flags, type Menu } from '../src/desktop/menu-model.js';

// What package 02-B3b adds to the menu: Buka Terbaru, Pengaturan, Lupakan Kunci, the two switches of the view and the two ways to move a tab. The tests of 02-B3 about the menu stay as they were (but for the ones
// that had to change on purpose: shell-menu-model.test.ts, shell-menu-golden.test.ts).
const FLAGS: Flags = { theme: 'system', toolbar: true, fullscreen: false, prompt: false };
const NAME = 'Remote Workspace';
const menu = (platform: Platform, report: Partial<Report> = {}, flags: Partial<Flags> = {}): Menu => buildMenu({ platform, appName: NAME, report: { ...EMPTY_REPORT, ...report }, flags: { ...FLAGS, ...flags } });
type Command = Extract<Entry, { kind: 'command' }>;
const section = (m: Menu, label: string) => m.find((s) => s.label === label)!;
const sub = (m: Menu, ...path: string[]): Extract<Entry, { kind: 'submenu' }> => {
  let items: readonly Entry[] = m;
  let found: Entry | undefined;
  for (const label of path) { found = items.find((e) => e.kind === 'submenu' && e.label === label); assert.ok(found, `${label} is there`); items = (found as Extract<Entry, { kind: 'submenu' }>).items; }
  return found as Extract<Entry, { kind: 'submenu' }>;
};
const ids = (items: readonly Entry[]) => items.map((e) => (e.kind === 'command' ? e.id : e.kind === 'separator' ? '-' : e.kind === 'submenu' ? `${e.label}>` : e.label));

test('Berkas has Buka Terbaru right after Buka Dokumen: ten items that follow the list, a separator (when there is a list) and Bersihkan Daftar', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const file = section(menu(platform), 'Berkas').items;
    const at = file.findIndex((e) => e.kind === 'command' && e.id === 'doc.open');
    assert.equal(ids([file[at + 1]!])[0], 'Buka Terbaru>', platform);
    const recent = sub(menu(platform), 'Berkas', 'Buka Terbaru').items;
    assert.deepEqual(ids(recent), [...Array.from({ length: MAX_RECENT }, (_, n) => `doc.recent.${n + 1}`), 'doc.recent.clear'], platform);      // an empty list: no line above the last item
    assert.deepEqual(ids(sub(menu(platform, {}, { recent: ['A'] }), 'Berkas', 'Buka Terbaru').items).slice(-2), ['-', 'doc.recent.clear'], platform);
  }
});

test('the recent documents show the names the list holds, as many as it holds, and the rest are not shown; the separator and Bersihkan Daftar follow them', () => {
  const none = sub(menu('darwin'), 'Berkas', 'Buka Terbaru').items;
  for (const entry of none) assert.equal(entry.kind === 'command' && (entry.hidden === true || entry.id === 'doc.recent.clear'), true, 'with an empty list nothing is shown but a clear that cannot be pressed');
  const clear = (items: readonly Entry[]) => findCommand(items, 'doc.recent.clear')!;
  assert.equal(clear(none).enabled, false);
  const two = sub(menu('darwin', {}, { recent: ['Kantor', 'Rumah'] }), 'Berkas', 'Buka Terbaru').items;
  const shown = two.filter((e) => e.kind === 'command' && e.hidden !== true && recentIndex(e.id) !== undefined) as Command[];
  assert.deepEqual(shown.map((e) => [e.id, e.label, e.enabled]), [['doc.recent.1', 'Kantor', true], ['doc.recent.2', 'Rumah', true]]);
  const hidden = two.filter((e) => e.kind === 'command' && e.hidden === true) as Command[];
  assert.equal(hidden.length, 8);
  for (const entry of hidden) { assert.equal(entry.enabled, false, `${entry.id} cannot be chosen`); assert.equal(entry.label, spec(entry.id).label); }
  assert.equal(two.filter((e) => e.kind === 'separator').length, 1, 'a line shows above Bersihkan Daftar when there is a list');
  assert.equal(none.filter((e) => e.kind === 'separator').length, 0, 'and none without one: a line above the only item shown is a stray line');
  assert.equal(clear(two).enabled, true);
  const full = sub(menu('win32', {}, { recent: Array.from({ length: 12 }, (_, n) => `D${n + 1}`) }), 'Berkas', 'Buka Terbaru').items as Command[];
  assert.equal(full.filter((e) => e.kind === 'command' && e.hidden !== true && recentIndex(e.id) !== undefined).length, MAX_RECENT, 'a list longer than the menu is cut');
  assert.equal(findCommand(full, 'doc.recent.10')!.label, 'D10');
});

test('a recent document cannot be chosen while a dialog of the window or a prompt of the main process is open, or when the page is gone; Bersihkan Daftar is the main process\'s own', () => {
  const recent = ['A', 'B'];
  const flags = { ...FLAGS, recent };
  assert.equal(isAvailable('doc.recent.1', EMPTY_REPORT, flags), true);
  assert.equal(isAvailable('doc.recent.2', EMPTY_REPORT, flags), true);
  assert.equal(isAvailable('doc.recent.3', EMPTY_REPORT, flags), false, 'no third one');
  assert.equal(isAvailable('doc.recent.1', { ...EMPTY_REPORT, dialog: true }, flags), false);
  assert.equal(isAvailable('doc.recent.1', EMPTY_REPORT, { ...flags, prompt: true }), false);
  assert.equal(isAvailable('doc.recent.1', EMPTY_REPORT, { ...flags, pageGone: true }), false);
  assert.equal(isAvailable('doc.recent.1', EMPTY_REPORT, FLAGS), false, 'no list, no item');
  assert.equal(isAvailable('doc.recent.clear', EMPTY_REPORT, flags), true);
  assert.equal(isAvailable('doc.recent.clear', { ...EMPTY_REPORT, dialog: true }, flags), true, 'a list can be cleared whatever the page is doing');
  assert.equal(isAvailable('doc.recent.clear', EMPTY_REPORT, { ...flags, prompt: true }), false);
  assert.equal(isAvailable('doc.recent.clear', EMPTY_REPORT, { ...flags, recent: [] }), false, 'nothing to clear');
});

test('Pengaturan is after About in the menu of the application on macOS, and before Keluar in Berkas elsewhere; it keeps its key unless a session holds the keyboard', () => {
  const mac = menu('darwin');
  assert.deepEqual(ids(section(mac, NAME).items).slice(0, 4), ['app.about', '-', 'app.settings', '-']);
  assert.equal(findCommand(mac, 'app.settings')!.accelerator, 'Cmd+,');
  for (const platform of ['win32', 'linux'] as const) {
    const file = section(menu(platform), 'Berkas').items;
    assert.deepEqual(ids(file).slice(-4), ['-', 'app.settings', '-', 'app.quit'], platform);
    assert.equal(findCommand(menu(platform), 'app.settings')!.accelerator, 'Ctrl+,');
  }
  for (const platform of ['darwin', 'win32'] as const) assert.equal(findCommand(menu(platform, { capture: true }), 'app.settings')!.accelerator, undefined, `${platform}: a session that holds the keyboard keeps every key but the few the application keeps`);
  assert.equal(findCommand(menu('darwin', {}, { prompt: true }), 'app.settings')!.enabled, false, 'a prompt of the main process is in front: only quitting');
  assert.equal(isAvailable('app.settings', { ...EMPTY_REPORT, dialog: true }, FLAGS), true, 'the settings are the main process\'s own and open whatever the page is doing');
});

test('Tampilan has the two switches: Warnai Tab (on unless told otherwise) and Layar Penuh yang Diperluas (off unless told otherwise)', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const view = section(menu(platform), 'Tampilan').items;
    assert.deepEqual(ids(view), ['view.toolbar', 'view.customizeToolbar', '-', 'view.colorizeTabs', '-', 'Tema>', '-', 'view.fullscreen', 'view.extendedFullscreen'], platform);
    const colour = findCommand(menu(platform), 'view.colorizeTabs')!;
    assert.deepEqual([colour.control, colour.checked, colour.enabled], ['checkbox', true, true]);
    const extended = findCommand(menu(platform), 'view.extendedFullscreen')!;
    assert.deepEqual([extended.control, extended.checked, extended.enabled], ['checkbox', false, true]);
    assert.equal(findCommand(menu(platform, {}, { colorTabs: false }), 'view.colorizeTabs')!.checked, false);
    assert.equal(findCommand(menu(platform, {}, { colorTabs: true }), 'view.colorizeTabs')!.checked, true);
    assert.equal(findCommand(menu(platform, {}, { extendedFullscreen: true }), 'view.extendedFullscreen')!.checked, true);
    assert.equal(findCommand(menu(platform, {}, { extendedFullscreen: false }), 'view.extendedFullscreen')!.checked, false);
  }
  assert.equal(findCommand(menu('darwin'), 'view.colorizeTabs')!.label, 'Warnai Tab');
  assert.equal(findCommand(menu('darwin'), 'view.extendedFullscreen')!.label, 'Layar Penuh yang Diperluas');
  assert.equal(findCommand(menu('darwin', {}, { prompt: true }), 'view.colorizeTabs')!.enabled, false);
});

test('Jendela has the two ways to move a tab after the two ways to step through them, and they can be done only where there is room to move', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const window = section(menu(platform), 'Jendela').items;
    const order = ids(window);
    const at = order.indexOf('tab.next');
    assert.deepEqual(order.slice(at, at + 5), ['tab.next', 'tab.previous', 'tab.moveLeft', 'tab.moveRight', 'Pilih Tab>'], platform);
  }
  const state = (tabs: number, tab: number) => ({ ...EMPTY_REPORT, tabs, tab });
  const can = (id: CommandId, report: Report) => isAvailable(id, report, FLAGS);
  assert.deepEqual([can('tab.moveLeft', state(0, -1)), can('tab.moveRight', state(0, -1))], [false, false], 'no tab');
  assert.deepEqual([can('tab.moveLeft', state(1, 0)), can('tab.moveRight', state(1, 0))], [false, false], 'one tab has nowhere to go');
  assert.deepEqual([can('tab.moveLeft', state(3, 0)), can('tab.moveRight', state(3, 0))], [false, true], 'the first can only go right');
  assert.deepEqual([can('tab.moveLeft', state(3, 1)), can('tab.moveRight', state(3, 1))], [true, true]);
  assert.deepEqual([can('tab.moveLeft', state(3, 2)), can('tab.moveRight', state(3, 2))], [true, false], 'the last can only go left');
  assert.deepEqual([can('tab.moveLeft', state(3, -1)), can('tab.moveRight', state(3, -1))], [false, false], 'no tab in front');
  assert.equal(can('tab.moveLeft', { ...state(3, 1), dialog: true }), false);
  assert.equal(isAvailable('tab.moveLeft', state(3, 1), { ...FLAGS, prompt: true }), false);
  assert.equal(isAvailable('tab.moveRight', state(3, 1), { ...FLAGS, pageGone: true }), false);
});

test('Lupakan Kunci yang Diingat is in Berkas after Riwayat Revisi and can be done when the window says a document is selected and the system remembers a key', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const order = ids(section(menu(platform), 'Berkas').items);
    const at = order.indexOf('doc.history');
    assert.equal(order[at + 1], 'doc.forgetKey', platform);
  }
  assert.equal(findCommand(menu('darwin'), 'doc.forgetKey')!.enabled, false);
  assert.equal(findCommand(menu('darwin', { enabled: ['doc.close'] }, { keys: 2 }), 'doc.forgetKey')!.enabled, true, 'closing the document can be done: a document is selected, and a key is remembered');
  assert.equal(findCommand(menu('darwin', { enabled: ['doc.close'] }), 'doc.forgetKey')!.enabled, false, 'no key is remembered at all: there is nothing to forget');
  assert.equal(findCommand(menu('darwin', { enabled: ['doc.close'] }, { keys: 0 }), 'doc.forgetKey')!.enabled, false);
  assert.equal(findCommand(menu('darwin', { enabled: ['doc.close'], dialog: true }, { keys: 1 }), 'doc.forgetKey')!.enabled, false);
  assert.equal(findCommand(menu('darwin', { enabled: ['doc.save'] }, { keys: 1 }), 'doc.forgetKey')!.enabled, false, 'saving is not closing');
  assert.equal(findCommand(menu('darwin', { enabled: ['doc.close'] }, { pageGone: true, keys: 1 }), 'doc.forgetKey')!.enabled, false);
  assert.equal(findCommand(menu('darwin', { enabled: ['doc.close'] }, { prompt: true, keys: 1 }), 'doc.forgetKey')!.enabled, false);
  assert.equal(findCommand(menu('darwin', {}, { recent: ['A'], keys: 1 }), 'doc.forgetKey')!.enabled, false, 'a list of recent documents is not a selected document');
});

test('every command is in the menu once on every platform, whatever the list of recent documents holds; only the ones the list holds are shown', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    for (const recent of [[], ['A'], Array.from({ length: 10 }, (_, n) => `N${n}`)]) {
      const found: CommandId[] = [];
      const walk = (entries: readonly Entry[]) => { for (const e of entries) { if (e.kind === 'command') found.push(e.id); if (e.kind === 'submenu') walk(e.items); } };
      walk(menu(platform, {}, { recent }));
      assert.deepEqual([...found].sort(), [...COMMAND_IDS].sort(), `${platform} ${recent.length}`);
    }
  }
});

test('the keys of the new commands are the keys of the list: only Pengaturan has one, and the menu says so', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    for (const id of ['doc.forgetKey', 'doc.recent.1', 'doc.recent.clear', 'tab.moveLeft', 'tab.moveRight', 'view.colorizeTabs', 'view.extendedFullscreen'] as const) assert.equal(findCommand(menu(platform), id)!.accelerator, keysFor(spec(id), platform), `${platform} ${id}`);
  }
});
