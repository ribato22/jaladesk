import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_REPORT, type CommandId, type Platform, type ThemeChoice } from '../src/desktop/commands.js';
import { Recent, recentLabels } from '../src/desktop/recent.js';
import { Settings } from '../src/desktop/settings.js';
import type { TemplateItem } from '../src/desktop/menu.js';
import { createShell, NOT_CLEARED, NOT_SAVED, type WindowLike } from '../src/desktop/shell.js';

// What package 02-B3b adds to the shell of the main process: the recent documents in the menu, the settings window, the two switches of the view and the state of the view that the window is told, and the menus that open
// where the window says. The tests of 02-B3 about the shell stay as they were.
function walk(items: readonly TemplateItem[]): TemplateItem[] { return items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])]); }
async function eventually(done: () => boolean, what: string) { for (let n = 0; n < 400 && !done(); n++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(done(), what); }

function fixture(options: { platform?: Platform; settings?: Settings; recent?: Recent; noRecent?: boolean; clearFails?: boolean; chooseThrows?: boolean; keys?: { known(): number; subscribe(listener: () => void): () => void }; noSettingsWindow?: boolean; noPopup?: boolean; popupThrows?: boolean; defer?: boolean; sendThrows?: boolean } = {}) {
  const sent: { channel: string; payload: unknown }[] = [];
  const calls: string[] = [];
  const errors: unknown[] = [];
  const popups: { template: TemplateItem[]; at?: { x: number; y: number }; target?: unknown }[] = [];
  const chosen: { index: number; commandsSent: number }[] = [];
  const view = { template: [] as TemplateItem[], installs: 0, fullscreen: false };
  const deferred: (() => void)[] = [];
  const window: WindowLike = {
    send: (channel, payload) => { if (options.sendThrows && channel === 'shell:view-changed') throw new Error('no window'); sent.push({ channel, payload }); },
    isFullScreen: () => view.fullscreen,
    setFullScreen: (on) => { view.fullscreen = on; calls.push(`fullscreen ${on}`); },
    setBackgroundColor: () => undefined,
  };
  const settings = options.settings ?? Settings.memory();
  const recent = options.recent ?? Recent.memory();
  const shell = createShell({
    platform: options.platform ?? 'darwin', appName: 'Remote Workspace', settings,
    setApplicationMenu: (template) => { view.template = template; view.installs++; },
    window: () => window,
    nativeTheme: { setSource: (_choice: ThemeChoice) => undefined, isDark: () => false },
    showAbout: () => calls.push('about'), quit: () => calls.push('quit'), report: (error) => errors.push(error),
    ...(options.defer ? { defer: (run: () => void) => { deferred.push(run); } } : {}),
    ...(options.noRecent ? {} : { recent: { labels: () => recentLabels(recent.list()), clear: async () => { calls.push('clear'); const done = await recent.clear(); return options.clearFails ? false : done; }, subscribe: (listener: () => void) => recent.subscribe(listener), choose: (index: number) => { chosen.push({ index, commandsSent: sent.filter((s) => s.channel === 'shell:command').length }); if (options.chooseThrows) throw new Error('could not choose'); recent.choose(index); } } }),
    ...(options.keys ? { keys: options.keys } : {}),
    ...(options.noSettingsWindow ? {} : { openSettings: () => { calls.push('settings'); } }),
    ...(options.noPopup ? {} : { popup: (template: TemplateItem[], at?: { x: number; y: number }, target?: unknown) => { if (options.popupThrows) throw new Error('no menu'); popups.push({ template, ...(at ? { at } : {}), ...(target !== undefined ? { target } : {}) }); } }),
  });
  const item = (id: CommandId) => walk(view.template).find((i) => i.id === id)!;
  const flush = () => { while (deferred.length > 0) deferred.shift()!(); };
  const told = (channel: string) => sent.filter((s) => s.channel === channel).map((s) => s.payload);
  return { shell, settings, recent, sent, calls, errors, view, item, flush, popups, told, chosen };
}

test('the menu shows the recent documents by the names of their files, and is made again when the list changes and not when it does not', async () => {
  const f = fixture();
  f.shell.start();
  assert.equal(f.view.installs, 1);
  assert.equal(f.item('doc.recent.1').visible, false);
  assert.equal(f.item('doc.recent.clear').enabled, false);
  await f.recent.add('/a/kantor.rwdoc');
  assert.equal(f.view.installs, 2);
  assert.deepEqual([f.item('doc.recent.1').label, f.item('doc.recent.1').visible, f.item('doc.recent.1').enabled], ['kantor', undefined, true]);
  assert.equal(f.item('doc.recent.clear').enabled, true);
  await f.recent.add('/a/kantor.rwdoc');
  assert.equal(f.view.installs, 2, 'the same list: the same menu stays');
  await f.recent.add('/a/rumah.rwdoc');
  assert.deepEqual([f.item('doc.recent.1').label, f.item('doc.recent.2').label], ['rumah', 'kantor']);
  f.shell.stop();
  await f.recent.add('/a/lain.rwdoc');
  assert.equal(f.item('doc.recent.1').label, 'rumah', 'a shell that was stopped does not follow the list');
});

test('a recent document is a command of the window: choosing it tells the window which one, and only when the list has it', async () => {
  const f = fixture();
  f.shell.start();
  await f.recent.add('/a/kantor.rwdoc');
  f.item('doc.recent.1').click!();
  assert.deepEqual(f.told('shell:command'), [{ id: 'doc.recent.1' }]);
  f.item('doc.recent.2').click!();
  assert.deepEqual(f.told('shell:command'), [{ id: 'doc.recent.1' }], 'a place there is no document for does nothing');
});

test('Bersihkan Daftar clears the list and is refused when there is none; the menu follows', async () => {
  const f = fixture();
  f.shell.start();
  assert.equal(await f.shell.run('doc.recent.clear'), false);
  assert.deepEqual(f.calls, []);
  await f.recent.add('/a/kantor.rwdoc');
  assert.equal(await f.shell.run('doc.recent.clear'), true);
  assert.deepEqual(f.calls, ['clear']);
  assert.deepEqual(f.recent.list(), []);
  assert.equal(f.item('doc.recent.clear').enabled, false);
  const without = fixture({ noRecent: true });
  without.shell.start();
  assert.equal(await without.shell.run('doc.recent.clear'), false, 'a shell with no list has nothing to clear');
});

test('Pengaturan opens the window of the settings, and does nothing when the app has none or a window of the main process is asking something', async () => {
  const f = fixture();
  f.shell.start();
  assert.equal(await f.shell.run('app.settings'), true);
  assert.deepEqual(f.calls, ['settings']);
  f.shell.setPrompt(true);
  assert.equal(await f.shell.run('app.settings'), false);
  assert.deepEqual(f.calls, ['settings']);
  assert.equal(f.item('app.settings').enabled, false);
  f.shell.setPrompt(false);
  assert.equal(f.item('app.settings').enabled, true);
  const none = fixture({ noSettingsWindow: true });
  none.shell.start();
  assert.equal(await none.shell.run('app.settings'), false);
  f.item('app.settings').click!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, ['settings', 'settings'], 'and the item of the menu does the same');
});

test('Warnai Tab and Layar Penuh yang Diperluas are choices that are kept: the menu shows them, and one that cannot be kept is not made and the window is told', async () => {
  const f = fixture();
  f.shell.start();
  assert.deepEqual([f.item('view.colorizeTabs').checked, f.item('view.extendedFullscreen').checked], [true, false]);
  assert.equal(await f.shell.run('view.colorizeTabs'), true);
  assert.equal(f.settings.values().tabs.colorize, false);
  assert.equal(f.item('view.colorizeTabs').checked, false);
  assert.equal(await f.shell.run('view.extendedFullscreen'), true);
  assert.equal(f.settings.values().fullscreen.extended, true);
  assert.equal(f.item('view.extendedFullscreen').checked, true);
  assert.equal(await f.shell.run('view.extendedFullscreen'), true);
  assert.equal(f.item('view.extendedFullscreen').checked, false);
  const broken = fixture({ settings: Object.assign(Settings.memory(), { toggleOption: () => Promise.reject(new Error('not written')) }) });
  broken.shell.start();
  assert.equal(await broken.shell.run('view.colorizeTabs'), false);
  assert.deepEqual(broken.told('shell:notice'), [{ text: NOT_SAVED }]);
  assert.equal(broken.errors.length, 1);
});

test('the window is told how it should look: the colour of the tabs, and the extended full screen only while the window is in the full screen', async () => {
  const f = fixture();
  f.shell.start();
  assert.deepEqual(f.shell.view(), { colorTabs: true, extended: false });
  await f.shell.run('view.extendedFullscreen');
  assert.deepEqual(f.shell.view(), { colorTabs: true, extended: false }, 'chosen, but the window is not in the full screen');
  assert.deepEqual(f.told('shell:view-changed'), [], 'so the window has nothing to be told');
  f.shell.fullScreenChanged(true);
  assert.deepEqual(f.shell.view(), { colorTabs: true, extended: true });
  assert.deepEqual(f.told('shell:view-changed'), [{ colorTabs: true, extended: true }]);
  f.shell.fullScreenChanged(true);
  assert.equal(f.told('shell:view-changed').length, 1, 'the same view is not told again');
  await f.shell.run('view.colorizeTabs');
  assert.deepEqual(f.told('shell:view-changed').at(-1), { colorTabs: false, extended: true });
  await f.shell.run('view.extendedFullscreen');
  assert.deepEqual(f.told('shell:view-changed').at(-1), { colorTabs: false, extended: false }, 'switched off while in the full screen: the window gets its panels back at once');
  f.shell.fullScreenChanged(false);
  assert.equal(f.told('shell:view-changed').length, 3);
  await f.shell.run('view.theme.dark');
  await f.shell.run('view.toolbar');
  assert.equal(f.told('shell:view-changed').length, 3, 'the theme and the toolbar are not part of the view');
});

test('a context menu is shown where the window asked, with the items that apply, and choosing an item does what the item of the menu of the application does', async () => {
  const f = fixture({ defer: true });
  f.shell.start();
  f.shell.report({ ...EMPTY_REPORT, enabled: ['obj.connect', 'obj.edit'], tabs: 0, tab: -1 });
  f.shell.context({ kind: 'tree', x: 40, y: 70 });
  assert.equal(f.popups.length, 1);
  assert.deepEqual(f.popups[0]!.at, { x: 40, y: 70 });
  assert.deepEqual(f.popups[0]!.template.filter((i) => i.type !== 'separator').map((i) => i.id), ['obj.connect', 'obj.edit']);
  f.popups[0]!.template[0]!.click!();
  assert.deepEqual(f.told('shell:command'), [], 'after the click has returned');
  f.flush();
  assert.deepEqual(f.told('shell:command'), [{ id: 'obj.connect' }]);
  f.shell.context({ kind: 'toolbar', x: 1, y: 2 });
  const toolbar = f.popups[1]!.template.find((i) => i.id === 'view.toolbar')!;
  assert.equal(toolbar.label, 'Sembunyikan Toolbar');
  toolbar.click!();
  f.flush();
  await eventually(() => !f.settings.values().toolbar.visible, 'a command of the main process is done by the main process');
});

test('no context menu is shown when nothing applies, while a window of the main process asks something, or when the page is gone; a menu that cannot be shown is reported and nothing more', () => {
  const f = fixture();
  f.shell.start();
  f.shell.context({ kind: 'tree', x: 1, y: 1 });
  f.shell.context({ kind: 'tab', x: 1, y: 1 });
  assert.equal(f.popups.length, 0, 'nothing is selected');
  f.shell.report({ ...EMPTY_REPORT, enabled: ['obj.edit'] });
  f.shell.setPrompt(true);
  f.shell.context({ kind: 'tree', x: 1, y: 1 });
  f.shell.context({ kind: 'toolbar', x: 1, y: 1 });
  assert.equal(f.popups.length, 0, 'a prompt is in front');
  f.shell.setPrompt(false);
  f.shell.pageGone();
  f.shell.context({ kind: 'toolbar', x: 1, y: 1 });
  assert.equal(f.popups.length, 0, 'a page that is gone asks for nothing, and what still arrives from it is not answered');
  const quiet = fixture({ noPopup: true });
  quiet.shell.start();
  quiet.shell.report({ ...EMPTY_REPORT, enabled: ['obj.edit'] });
  quiet.shell.context({ kind: 'tree', x: 1, y: 1 });
  assert.deepEqual(quiet.errors, []);
  const broken = fixture({ popupThrows: true });
  broken.shell.start();
  broken.shell.report({ ...EMPTY_REPORT, enabled: ['obj.edit'] });
  broken.shell.context({ kind: 'tree', x: 1, y: 1 });
  assert.equal(broken.errors.length, 1);
});

test('a box that can be typed in gets the editing menu, as the browser describes it, and a click on it runs nothing of the application', () => {
  const f = fixture();
  f.shell.start();
  const flags = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true };
  f.shell.editContext({ isEditable: true, selectionText: '', editFlags: flags });
  assert.equal(f.popups.length, 1);
  assert.deepEqual(f.popups[0]!.template.map((i) => i.role ?? i.label ?? i.type), ['Urungkan', 'Ulangi', 'separator', 'Potong', 'Salin', 'paste', 'separator', 'selectAll']);
  assert.equal(f.popups[0]!.at, undefined, 'it opens where the pointer is');
  f.shell.editContext({ isEditable: false, selectionText: '', editFlags: flags });
  assert.equal(f.popups.length, 1, 'nothing to offer');
  f.shell.editContext({ isEditable: true, selectionText: '', editFlags: flags });
  assert.equal(f.popups.length, 2, 'asked for again, shown again');
});

// The independent review of the spike (slice 2 and 3): a click on a recent document is the person's choice and is recorded before the window hears of it; a list that cannot be cleared on disk is told.
test('choosing a recent document records the choice before the window hears of it, for the place that was chosen, and a place with nothing in it chooses nothing', async () => {
  const f = fixture();
  f.shell.start();
  await f.recent.add('/a/kantor.rwdoc');
  await f.recent.add('/a/rumah.rwdoc');
  f.item('doc.recent.2').click!();
  assert.deepEqual(f.chosen, [{ index: 1, commandsSent: 0 }], 'recorded when the window had been told nothing yet');
  assert.deepEqual(f.told('shell:command'), [{ id: 'doc.recent.2' }]);
  f.item('doc.recent.3').click!();
  assert.equal(f.chosen.length, 1, 'no document there: nothing is chosen');
  assert.equal(f.recent.chosen('/a/kantor.rwdoc'), true, 'and the list has it');
});

test('a choice that cannot be recorded is reported, and the window is still told (it will be refused, which is the safe way to fail)', async () => {
  const f = fixture({ chooseThrows: true });
  f.shell.start();
  await f.recent.add('/a/kantor.rwdoc');
  f.item('doc.recent.1').click!();
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.told('shell:command'), [{ id: 'doc.recent.1' }]);
});

test('the commands of the window other than a recent document choose nothing', async () => {
  const f = fixture();
  f.shell.start();
  await f.recent.add('/a/kantor.rwdoc');
  f.item('doc.open').click!();
  assert.deepEqual(f.chosen, []);
});

test('Bersihkan Daftar that cannot be kept on disk is done in the menu and told: the list is empty now and may come back when the app is opened', async () => {
  const f = fixture({ clearFails: true });
  f.shell.start();
  await f.recent.add('/a/kantor.rwdoc');
  assert.equal(await f.shell.run('doc.recent.clear'), false);
  assert.deepEqual(f.recent.list(), []);
  assert.deepEqual(f.told('shell:notice'), [{ text: NOT_CLEARED }]);
  assert.match(NOT_CLEARED, /berkas/);
  const fine = fixture();
  fine.shell.start();
  await fine.recent.add('/a/kantor.rwdoc');
  assert.equal(await fine.shell.run('doc.recent.clear'), true);
  assert.deepEqual(fine.told('shell:notice'), []);
});

test('Lupakan Kunci follows the number of keys that are remembered: the menu is made again when the number goes between none and some, and a shell that was stopped does not follow', async () => {
  let count = 0;
  const listeners = new Set<() => void>();
  const keys = { known: () => count, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const f = fixture({ keys });
  f.shell.start();
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.close'], tabs: 0, tab: -1 });
  assert.equal(f.item('doc.forgetKey').enabled, false);
  const installs = f.view.installs;
  count = 1;
  for (const listener of listeners) listener();
  assert.equal(f.item('doc.forgetKey').enabled, true);
  assert.equal(f.view.installs, installs + 1);
  for (const listener of listeners) listener();
  assert.equal(f.view.installs, installs + 1, 'the same menu stays');
  f.shell.stop();
  assert.equal(listeners.size, 0);
  count = 0;
  for (const listener of listeners) listener();
  assert.equal(f.item('doc.forgetKey').enabled, true, 'a stopped shell does not follow');
  const none = fixture();
  none.shell.start();
  none.shell.report({ ...EMPTY_REPORT, enabled: ['doc.close'], tabs: 0, tab: -1 });
  assert.equal(none.item('doc.forgetKey').enabled, false, 'a shell with no keystore knows of no key');
});

test('the editing menu opens on the window that asked for it: a box in a window of the main process (a password) has a menu of its own, and one in the main window opens where it always did', () => {
  const f = fixture();
  f.shell.start();
  const params = { isEditable: true, selectionText: '', editFlags: { canPaste: true, canCut: false, canCopy: false, canSelectAll: true, canUndo: false, canRedo: false } };
  f.shell.setPrompt(true);
  f.shell.editContext(params, 'the password window');
  assert.equal(f.popups.length, 1, 'also while a window of the main process is asking: that window is where the box is');
  assert.equal(f.popups[0]!.target, 'the password window');
  assert.equal(f.popups[0]!.at, undefined, 'where the pointer is');
  f.shell.setPrompt(false);
  f.shell.editContext(params);
  assert.equal(f.popups.length, 2);
  assert.equal('target' in f.popups[1]!, false, 'the main window is the default');
});

// What the review after the execution (23 October 2026) found: a menu or a view that cannot be shown was only tested for one of the ways it is asked for.

test('an editing menu that cannot be shown, and a view that cannot be told to the window, are a report to the main process and nothing more', async () => {
  const edit = fixture({ popupThrows: true });
  edit.shell.start();
  edit.shell.editContext({ isEditable: true, selectionText: '', editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }, 'the password window');
  assert.equal(edit.errors.length, 1, 'the editing menu that cannot be shown');
  const settings = Settings.memory();
  await settings.setOption('fullscreen.extended', true);
  const told = fixture({ sendThrows: true, settings });
  told.shell.start();
  const before = told.errors.length;
  told.shell.fullScreenChanged(true);      // the view is another now, and the window cannot be told
  assert.equal(told.errors.length, before + 1, 'the view that cannot be told');
  assert.equal(told.shell.view().extended, true, 'and what the shell knows of the view is not lost for that');
});
