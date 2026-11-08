import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { realFs, type StoreFs } from '../src/documents/store.js';
import { EMPTY_REPORT, type CommandId, type Platform, type ThemeChoice } from '../src/desktop/commands.js';
import { BACKGROUNDS } from '../src/desktop/theme.js';
import { Settings } from '../src/desktop/settings.js';
import type { TemplateItem } from '../src/desktop/menu.js';
import type { KeyInput } from '../src/desktop/key-match.js';
import { createShell, NOT_SAVED, type WindowLike } from '../src/desktop/shell.js';

function walk(items: readonly TemplateItem[]): TemplateItem[] { return items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])]); }

function fixture(options: { platform?: Platform; settings?: Settings; systemDark?: boolean; noWindow?: boolean; defer?: boolean; failInstalls?: number; failAttempts?: number[]; fallback?: boolean; fallbackThrows?: boolean; failSource?: boolean; aboutThrows?: boolean } = {}) {
  const sent: { channel: string; payload: unknown }[] = [];
  const calls: string[] = [];
  const errors: unknown[] = [];
  const view = { template: [] as TemplateItem[], installs: 0, attempts: 0, fullscreen: false, background: '', systemDark: options.systemDark ?? false, source: 'unset' as string, dark: false };
  const deferred: (() => void)[] = [];
  const window: WindowLike = {
    send: (channel, payload) => { sent.push({ channel, payload }); },
    isFullScreen: () => view.fullscreen,
    setFullScreen: (on) => { view.fullscreen = on; calls.push(`fullscreen ${on}`); },
    setBackgroundColor: (color) => { view.background = color; },
  };
  const settings = options.settings ?? Settings.memory();
  const shell = createShell({
    platform: options.platform ?? 'darwin', appName: 'Remote Workspace', settings,
    setApplicationMenu: (template) => { view.attempts++; if (view.attempts <= (options.failInstalls ?? 0) || (options.failAttempts ?? []).includes(view.attempts)) throw new Error('the menu was refused'); view.template = template; view.installs++; },
    window: () => (options.noWindow ? undefined : window),
    nativeTheme: { setSource: (choice: ThemeChoice) => { if (options.failSource) throw new Error('the theme was refused'); view.source = choice; view.dark = choice === 'dark' || (choice === 'system' && view.systemDark); }, isDark: () => view.dark },
    showAbout: () => { if (options.aboutThrows) throw new Error('no dialog'); calls.push('about'); }, quit: () => calls.push('quit'), report: (error) => errors.push(error),
    ...(options.defer ? { defer: (run: () => void) => { deferred.push(run); } } : {}),
    ...(options.fallback || options.fallbackThrows ? { fallbackMenu: () => { if (options.fallbackThrows) throw new Error('no plain menu'); calls.push('fallback'); } } : {}),
  });
  const item = (id: CommandId) => walk(view.template).find((i) => i.id === id)!;
  const flush = () => { while (deferred.length > 0) deferred.shift()!(); };
  return { shell, settings, sent, calls, errors, view, item, flush, deferred };
}
const press = (key: string, code: string, modifiers: Partial<Pick<KeyInput, 'meta' | 'control' | 'alt' | 'shift'>> = {}, more: Partial<KeyInput> = {}): KeyInput =>
  ({ type: 'keyDown', key, code, isAutoRepeat: false, meta: false, control: false, alt: false, shift: false, ...modifiers, ...more });
const settled = () => new Promise((resolve) => setImmediate(resolve));
/** Waits until `done` is true (a change that goes through the file system takes more than one turn of the loop). */
async function eventually(done: () => boolean, what: string) { for (let n = 0; n < 400 && !done(); n++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(done(), what); }

test('when it starts the shell puts the menu in place with nothing reported yet, and the theme that was chosen is the theme of the system and of the window', async () => {
  const dark = await Settings.open(join(await mkdtemp(join(tmpdir(), 'rwshell-')), 'settings.json'));
  await dark.setTheme('dark');
  const f = fixture({ settings: dark });
  assert.equal(f.view.installs, 0, 'nothing before it starts');
  f.shell.start();
  assert.equal(f.view.installs, 1);
  assert.equal(f.view.source, 'dark');
  assert.equal(f.view.background, BACKGROUNDS.page.dark);
  assert.deepEqual(f.view.template.map((t) => t.label), ['Remote Workspace', 'Berkas', 'Sunting', 'Objek', 'Tampilan', 'Jendela', 'Bantuan']);
  assert.equal(f.item('doc.save').enabled, false, 'nothing is reported, so nothing that needs a document is on');
  assert.equal(f.item('find').enabled, true);
  assert.equal(f.item('view.theme.dark').checked, true);
  assert.deepEqual(f.shell.state().report, EMPTY_REPORT);
  const light = fixture();
  light.shell.start();
  assert.equal(light.view.source, 'system');
  assert.equal(light.view.background, BACKGROUNDS.page.light);
  const system = fixture({ systemDark: true });
  system.shell.start();
  assert.equal(system.view.background, BACKGROUNDS.page.dark, 'the theme of the system, when the choice is the system\'s');
});

test('what the window reports is what the menu shows, and a report that says nothing new does not make the menu again', () => {
  const f = fixture();
  f.shell.start();
  assert.equal(f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'] }), true);
  assert.equal(f.view.installs, 2);
  assert.equal(f.item('doc.save').enabled, true);
  assert.equal(f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'] }), false);
  assert.equal(f.view.installs, 2, 'the same state: the same menu stays');
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'], tabs: 2, tab: 0 });
  assert.equal(f.view.installs, 3);
  assert.equal(f.item('tab.2').enabled, true);
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'], tabs: 2, tab: 1, capture: true });
  assert.equal(f.view.installs, 4);
  assert.equal(f.item('doc.save').accelerator, undefined, 'a session holds the keyboard: the menu has no key of it');
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'], tabs: 2, tab: 1, capture: false });
  assert.equal(f.item('doc.save').accelerator, 'Cmd+S', 'and has it again when the keyboard is free');
});

test('choosing an item of the window sends its command to the window; an item that cannot be chosen now sends nothing, even if a click on it arrives', () => {
  const f = fixture();
  f.shell.start();
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save', 'doc.new'] });
  f.item('doc.save').click!();
  assert.deepEqual(f.sent, [{ channel: 'shell:command', payload: { id: 'doc.save' } }]);
  const stale = f.item('doc.close');
  assert.equal(stale.enabled, false);
  stale.click!();
  assert.equal(f.sent.length, 1, 'a click that arrives for an item that is off: the menu was rebuilt, or a script clicked it');
  f.item('find').click!();
  assert.deepEqual(f.sent.at(-1), { channel: 'shell:command', payload: { id: 'find' } });
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'], dialog: true });
  const old = f.item('doc.save');
  old.click!();
  assert.equal(f.sent.length, 2, 'while a dialog is open the commands of the window are off');
});

test('a click that arrives when there is no window is not an error, and tells nobody', () => {
  const f = fixture({ noWindow: true });
  f.shell.start();
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'] });
  f.item('doc.save').click!();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.errors, []);
});

test('choosing the theme keeps it, makes it the theme of the system and of the window, shows it in the menu and tells the window', async () => {
  const f = fixture();
  f.shell.start();
  f.item('view.theme.dark').click!();
  await settled();
  assert.equal(f.settings.values().theme, 'dark');
  assert.equal(f.view.source, 'dark');
  assert.equal(f.view.background, BACKGROUNDS.page.dark);
  assert.equal(f.item('view.theme.dark').checked, true);
  assert.equal(f.item('view.theme.system').checked, false);
  const pushed = f.sent.filter((s) => s.channel === 'shell:settings-changed');
  assert.equal(pushed.length, 1);
  assert.deepEqual((pushed[0]!.payload as { theme: string }).theme, 'dark');
  assert.equal(await f.shell.run('view.theme.light'), true);
  assert.equal(f.view.background, BACKGROUNDS.page.light);
  assert.equal(await f.shell.run('view.theme.system'), true);
  assert.equal(f.view.source, 'system');
  assert.equal(f.view.background, BACKGROUNDS.page.light, 'the system is light, and so is the window');
});

test('when the system changes its theme and the choice is the system\'s, the window follows', () => {
  const f = fixture({ systemDark: false });
  f.shell.start();
  assert.equal(f.view.background, BACKGROUNDS.page.light);
  f.view.systemDark = true;
  f.view.dark = true;      // what nativeTheme says after the change
  f.shell.themeChanged();
  assert.equal(f.view.background, BACKGROUNDS.page.dark);
  f.view.dark = false;
  f.shell.themeChanged();
  assert.equal(f.view.background, BACKGROUNDS.page.light);
});

test('showing and hiding the toolbar is a choice that is kept, shown in the menu by what the item says, and told to the window', async () => {
  const f = fixture();
  f.shell.start();
  assert.equal(f.item('view.toolbar').label, 'Sembunyikan Toolbar');
  assert.equal(await f.shell.run('view.toolbar'), true);
  assert.equal(f.settings.values().toolbar.visible, false);
  assert.equal(f.item('view.toolbar').label, 'Tampilkan Toolbar');
  assert.deepEqual(f.sent.at(-1)!.channel, 'shell:settings-changed');
  assert.equal((f.sent.at(-1)!.payload as { toolbar: { visible: boolean } }).toolbar.visible, false);
  assert.equal(await f.shell.run('view.toolbar'), true);
  assert.equal(f.settings.values().toolbar.visible, true);
  assert.equal(f.item('view.toolbar').label, 'Sembunyikan Toolbar');
});

test('a change of the settings that the window made itself (what is on the toolbar) is followed by the menu and told to every follower once', async () => {
  const f = fixture();
  f.shell.start();
  await f.settings.setToolbar({ visible: false });
  assert.equal(f.item('view.toolbar').label, 'Tampilkan Toolbar');
  assert.equal(f.sent.filter((s) => s.channel === 'shell:settings-changed').length, 1);
  await f.settings.setToolbar({ items: ['doc.new'] });
  assert.equal(f.sent.filter((s) => s.channel === 'shell:settings-changed').length, 2);
});

test('the full screen is entered and left from the menu, and what the window did (a green button, a key) is shown in the menu too', async () => {
  const f = fixture();
  f.shell.start();
  assert.equal(f.item('view.fullscreen').label, 'Masuk Layar Penuh');
  assert.equal(await f.shell.run('view.fullscreen'), true);
  assert.deepEqual(f.calls, ['fullscreen true']);
  f.shell.fullScreenChanged(true);
  assert.equal(f.item('view.fullscreen').label, 'Keluar dari Layar Penuh');
  assert.equal(await f.shell.run('view.fullscreen'), true);
  assert.deepEqual(f.calls, ['fullscreen true', 'fullscreen false']);
  const installs = f.view.installs;
  f.shell.fullScreenChanged(true);
  assert.equal(f.view.installs, installs, 'the menu already says so');
  f.shell.fullScreenChanged(false);
  assert.equal(f.item('view.fullscreen').label, 'Masuk Layar Penuh');
});

test('About and Keluar are done by the main process, and nothing else is done by a command of the window or one that does not exist', async () => {
  const f = fixture();
  f.shell.start();
  assert.equal(await f.shell.run('app.about'), true);
  assert.equal(await f.shell.run('app.quit'), true);
  assert.deepEqual(f.calls, ['about', 'quit']);
  f.item('app.about').click!();
  f.item('app.quit').click!();
  await settled();
  assert.deepEqual(f.calls, ['about', 'quit', 'about', 'quit']);
  for (const id of ['doc.save', 'find', 'tab.1', 'session.release', 'help.shortcuts', 'nothing', 'constructor']) assert.equal(await f.shell.run(id as CommandId), false, id);
  assert.deepEqual(f.calls, ['about', 'quit', 'about', 'quit']);
  assert.deepEqual(f.sent, []);
});

test('while a window of the main process asks for a password nothing can be done but quitting, and what is open at the same time is counted', () => {
  const f = fixture();
  f.shell.start();
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'] });
  assert.equal(f.item('doc.save').enabled, true);
  f.shell.setPrompt(true);
  assert.equal(f.item('doc.save').enabled, false);
  assert.equal(f.item('app.quit').enabled, true);
  assert.equal(f.item('view.theme.dark').enabled, false);
  f.shell.setPrompt(true);
  f.shell.setPrompt(false);
  assert.equal(f.item('doc.save').enabled, false, 'one is still open');
  f.shell.setPrompt(false);
  assert.equal(f.item('doc.save').enabled, true);
  f.shell.setPrompt(false);
  f.shell.setPrompt(true);
  assert.equal(f.item('doc.save').enabled, false, 'a window that closes twice does not make a window that is not there');
  f.shell.setPrompt(false);
  assert.equal(f.item('doc.save').enabled, true);
});

test('a choice that cannot be kept is not made, and the window is told in words', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rwshell-'));
  let failing = false;
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (failing) throw Object.assign(new Error('EIO'), { code: 'EIO' }); await realFs.rename(from, to); } };
  const settings = await Settings.open(join(dir, 'settings.json'), { fs });
  const f = fixture({ settings });
  f.shell.start();
  failing = true;
  assert.equal(await f.shell.run('view.theme.dark'), false);
  assert.equal(f.view.source, 'system');
  assert.equal(f.item('view.theme.system').checked, true);
  assert.deepEqual(f.sent.at(-1), { channel: 'shell:notice', payload: { text: NOT_SAVED } });
  assert.equal(f.errors.length, 1);
  assert.match(NOT_SAVED, /tidak dapat disimpan/);
  failing = false;
  assert.equal(await f.shell.run('view.theme.dark'), true, 'and the next try is a try');
  assert.equal(f.view.source, 'dark');
});

test('when the shell is stopped it follows the settings no more', async () => {
  const f = fixture();
  f.shell.start();
  f.shell.stop();
  await f.settings.setToolbar({ visible: false });
  assert.deepEqual(f.sent, []);
  assert.equal(f.item('view.toolbar').label, 'Sembunyikan Toolbar');
});

test('the menu of Windows has no menu of the application, and the same state gives the same menu on every start', () => {
  const win = fixture({ platform: 'win32' });
  win.shell.start();
  assert.deepEqual(win.view.template.map((t) => t.label), ['Berkas', 'Sunting', 'Objek', 'Tampilan', 'Jendela', 'Bantuan']);
  assert.equal(win.item('app.quit').accelerator, undefined);
  const a = fixture(), b = fixture();
  a.shell.start();
  b.shell.start();
  assert.equal(JSON.stringify(a.view.template.map(function strip(t): unknown { return { ...t, click: undefined, submenu: t.submenu?.map(strip) }; })), JSON.stringify(b.view.template.map(function strip(t): unknown { return { ...t, click: undefined, submenu: t.submenu?.map(strip) }; })));
});

test('Electron turns a check box or a radio item on or off before it handles the click: when the choice is not made the menu is put right again, and when it is made the menu is put in place once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rwshell-'));
  let failing = false;
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (failing) throw Object.assign(new Error('EIO'), { code: 'EIO' }); await realFs.rename(from, to); } };
  const f = fixture({ settings: await Settings.open(join(dir, 'settings.json'), { fs }) });
  f.shell.start();
  failing = true;
  const first = f.view.installs;
  f.item('view.theme.dark').click!();
  await eventually(() => f.sent.some((s) => s.channel === 'shell:notice') && f.view.installs > first, 'the choice was refused');
  assert.equal(f.view.installs, first + 1, 'the menu is put in place again');
  assert.equal(f.item('view.theme.system').checked, true);
  assert.equal(f.item('view.theme.dark').checked, false);
  failing = false;
  f.item('view.theme.dark').click!();
  await eventually(() => f.view.source === 'dark', 'the choice was made');
  assert.equal(f.view.installs, first + 2, 'a choice that is made changes the menu, and that is the one time');
  assert.equal(f.item('view.theme.dark').checked, true);
  // the favourite belongs to the window: the menu is put right at once, and again when the window says what it did
  f.shell.report({ ...EMPTY_REPORT, enabled: ['obj.favorite', 'doc.save'] });
  const before = f.view.installs;
  f.item('obj.favorite').click!();
  assert.equal(f.view.installs, before + 1);
  f.shell.report({ ...EMPTY_REPORT, enabled: ['obj.favorite', 'doc.save'], checked: ['obj.favorite'] });
  assert.equal(f.view.installs, before + 2);
  assert.equal(f.item('obj.favorite').checked, true);
  // an item that has no control has nothing to put right
  const quiet = f.view.installs;
  f.item('doc.save').click!();
  assert.equal(f.view.installs, quiet);
});

test('what a click on an item does is done after the click has returned, so that the menu is never replaced in the middle of the action of one of its own items', () => {
  const f = fixture({ defer: true });
  f.shell.start();
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'] });
  f.item('doc.save').click!();
  f.item('app.about').click!();
  assert.deepEqual(f.sent, [], 'not yet');
  assert.deepEqual(f.calls, []);
  assert.equal(f.deferred.length, 2);
  f.flush();
  assert.deepEqual(f.sent, [{ channel: 'shell:command', payload: { id: 'doc.save' } }]);
  assert.deepEqual(f.calls, ['about']);
});

test('a menu that could not be put in place is reported, and tried again at the next change even if the menu is the same', () => {
  const f = fixture({ failInstalls: 1 });
  f.shell.start();
  assert.equal(f.errors.length, 1);
  assert.equal(f.view.installs, 0);
  f.shell.fullScreenChanged(false);       // nothing changed, but nothing is in place: it is made again
  assert.equal(f.view.installs, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.item('find').enabled, true);
  f.shell.fullScreenChanged(false);
  assert.equal(f.view.installs, 1, 'and once it is in place the same menu is not made again');
});

test('a step of following the settings that fails is reported and does not stop the others: the menu is made and the window is told', async () => {
  const f = fixture({ failSource: true });
  f.shell.start();                       // the theme cannot be applied, and the menu and the following go on
  assert.equal(f.errors.length, 1);
  assert.equal(f.view.installs, 1);
  await f.settings.setToolbar({ visible: false });
  assert.equal(f.errors.length, 2, 'the theme is refused again');
  assert.equal(f.item('view.toolbar').label, 'Tampilkan Toolbar');
  assert.equal(f.sent.filter((s) => s.channel === 'shell:settings-changed').length, 1, 'and the window hears of the change');
});

test('a command of the main process that cannot be done now is refused and changes nothing, except quitting, which can always be done', async () => {
  const f = fixture();
  f.shell.start();
  f.shell.setPrompt(true);
  assert.equal(await f.shell.run('view.theme.dark'), false);
  assert.equal(f.settings.values().theme, 'system');
  assert.equal(await f.shell.run('view.toolbar'), false);
  assert.equal(await f.shell.run('view.fullscreen'), false);
  assert.equal(await f.shell.run('app.about'), false);
  assert.deepEqual(f.calls, []);
  assert.equal(await f.shell.run('app.quit'), true);
  assert.deepEqual(f.calls, ['quit']);
});

test('the full screen without a window is not done and not an error, and a dialog that cannot be shown is reported and stops nothing', async () => {
  const none = fixture({ noWindow: true });
  none.shell.start();
  assert.equal(await none.shell.run('view.fullscreen'), false);
  assert.deepEqual(none.errors, []);
  const f = fixture({ aboutThrows: true });
  f.shell.start();
  f.item('app.about').click!();
  await settled();
  assert.equal(f.errors.length, 1, 'reported');
  assert.equal(await f.shell.run('app.quit'), true, 'and the next thing works');
});

test('while a session holds the keyboard the few keys that stay the application\'s are taken before the page sees them: Cmd+Q quits, the full screen key enters it, the key that gives the keyboard back tells the window', () => {
  const f = fixture();
  f.shell.start();
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true })), false, 'no session holds the keyboard: the key is the menu\'s as always');
  f.shell.report({ ...EMPTY_REPORT, capture: true, tabs: 1, tab: 0 });
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true })), true);
  assert.deepEqual(f.calls, ['quit']);
  assert.equal(f.shell.keyDown(press('f', 'KeyF', { control: true, meta: true })), true);
  assert.deepEqual(f.calls, ['quit', 'fullscreen true']);
  assert.equal(f.shell.keyDown(press('˚', 'KeyK', { control: true, alt: true, meta: true })), true);
  assert.deepEqual(f.sent.at(-1), { channel: 'shell:command', payload: { id: 'session.release' } });
  // any other key is the session\'s, and so is one of these with another modifier
  for (const other of [press('s', 'KeyS', { meta: true }), press('w', 'KeyW', { meta: true }), press('c', 'KeyC', { meta: true }), press('a', 'KeyA'), press('Control', 'ControlLeft', { control: true }), press('q', 'KeyQ', { meta: true, shift: true })]) assert.equal(f.shell.keyDown(other), false, `${other.key} ${other.code}`);
  f.shell.report({ ...EMPTY_REPORT, capture: false });
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true })), false, 'and the page and the menu have them again when the keyboard is free');
  assert.deepEqual(f.calls, ['quit', 'fullscreen true']);
});

test('a key that is taken is taken once: held down it does nothing more; a release is not a press and is never taken', () => {
  const f = fixture();
  f.shell.start();
  f.shell.report({ ...EMPTY_REPORT, capture: true, tabs: 1, tab: 0 });
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true })), true);
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true }, { isAutoRepeat: true })), true, 'held: taken, and not acted on again');
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true }, { isAutoRepeat: true })), true);
  assert.deepEqual(f.calls, ['quit']);
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true }, { type: 'keyUp' })), false, 'Chromium does not deliver the release of a key that was taken; one that comes is the page\'s');
  assert.deepEqual(f.calls, ['quit'], 'and does nothing');
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true }, { type: 'char' })), false, 'not a key press');
});

test('on Windows and Linux only the key that gives the keyboard back is taken, and a window of the main process in front has the keyboard so that none is taken', () => {
  const w = fixture({ platform: 'win32' });
  w.shell.start();
  w.shell.report({ ...EMPTY_REPORT, capture: true, tabs: 1, tab: 0 });
  assert.equal(w.shell.keyDown(press('F11', 'F11')), false, 'F11 is the session\'s');
  assert.equal(w.shell.keyDown(press('q', 'KeyQ', { control: true })), false);
  assert.equal(w.shell.keyDown(press('K', 'KeyK', { control: true, alt: true, shift: true })), true);
  assert.deepEqual(w.sent.at(-1), { channel: 'shell:command', payload: { id: 'session.release' } });
  w.shell.setPrompt(true);
  assert.equal(w.shell.keyDown(press('K', 'KeyK', { control: true, alt: true, shift: true })), false, 'a password is being asked for: the keyboard is not the session\'s');
  const m = fixture();
  m.shell.start();
  m.shell.report({ ...EMPTY_REPORT, capture: true, tabs: 1, tab: 0 });
  m.shell.setPrompt(true);
  assert.equal(m.shell.keyDown(press('f', 'KeyF', { control: true, meta: true })), false);
  assert.deepEqual(m.calls, []);
});

// ---- review of the execution (22 October 2026)
test('a menu that could not be put in place at all leaves the application with a plain menu of its own and not with the default menu of Electron (Reload, the tools of the developer); a menu that was in place stays', () => {
  const f = fixture({ failInstalls: 1, fallback: true });
  f.shell.start();
  assert.equal(f.view.installs, 0);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.calls, ['fallback'], 'the plain menu is put in place');
  f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'] });
  assert.equal(f.view.installs, 1, 'the next change puts the real menu in place');
  assert.deepEqual(f.calls, ['fallback'], 'and the plain one is not put in place again');
  const later = fixture({ failAttempts: [2], fallback: true });
  later.shell.start();
  later.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'] });
  assert.equal(later.errors.length, 1);
  assert.deepEqual(later.calls, [], 'the menu that is in place is not replaced by the plain one');
  const none = fixture({ failInstalls: 1 });      // the plain menu is for main.ts to hand in: without it a failure is only reported
  none.shell.start();
  assert.equal(none.errors.length, 1);
  // two refusals in a row: the plain menu is put in place once, and not again for every refusal
  const twice = fixture({ failInstalls: 2, fallback: true });
  twice.shell.start();
  twice.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'] });
  assert.equal(twice.errors.length, 2);
  assert.deepEqual(twice.calls, ['fallback'], 'put in place once');
  // a plain menu that cannot be put in place is reported too, and nothing is thrown at the one who asked
  const worse = fixture({ failInstalls: 1, fallbackThrows: true });
  assert.doesNotThrow(() => worse.shell.start());
  assert.equal(worse.errors.length, 2, 'the menu, and then the plain menu');
});

test('a menu that cannot even be worked out is reported like a menu that cannot be put in place: the report that asked for it is not an error', () => {
  const settings = Settings.memory();
  const values = settings.values.bind(settings);
  let broken = false;
  settings.values = () => { if (broken) throw new Error('the settings cannot be read'); return values(); };
  const f = fixture({ settings, fallback: true });
  f.shell.start();
  broken = true;
  assert.doesNotThrow(() => f.shell.report({ ...EMPTY_REPORT, enabled: ['doc.save'] }));
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.calls, [], 'a menu is in place already');
});

test('showing and hiding the toolbar twice at once ends where it began: each one flips what the one before left', async () => {
  const f = fixture();
  f.shell.start();
  assert.deepEqual(await Promise.all([f.shell.run('view.toolbar'), f.shell.run('view.toolbar')]), [true, true]);
  assert.equal(f.settings.values().toolbar.visible, true);
  assert.deepEqual(await Promise.all([f.shell.run('view.toolbar'), f.shell.run('view.toolbar'), f.shell.run('view.toolbar')]), [true, true, true]);
  assert.equal(f.settings.values().toolbar.visible, false);
});

// Review of the execution (22 October 2026): when the process of the page dies the menu went on saying what the page had last said
test('a page that is gone leaves the menu saying that nothing of the window can be done, and a page that reports again brings it back, even when it says what was said before', () => {
  const f = fixture();
  f.shell.start();
  const before = { ...EMPTY_REPORT, enabled: ['doc.save', 'doc.close'] as CommandId[], tabs: 1, tab: 0 };
  f.shell.report(before);
  assert.equal(f.item('doc.save').enabled, true);
  assert.equal(f.item('find').enabled, true);
  f.shell.pageGone();
  assert.equal(f.item('doc.save').enabled, false, 'what the page said it could do is not true any more');
  assert.equal(f.item('tab.1').enabled, false);
  assert.equal(f.item('find').enabled, false, 'what needs nothing from the window needs the window');
  assert.equal(f.item('view.theme.dark').enabled, true, 'what is the main process\'s can still be done');
  assert.equal(f.item('app.quit').enabled, true);
  assert.deepEqual(f.shell.state().report, EMPTY_REPORT, 'what the page said is forgotten');
  assert.equal(f.shell.state().flags.pageGone, true);
  const installs = f.view.installs;
  f.shell.pageGone();
  assert.equal(f.view.installs, installs, 'saying it twice makes no other menu');
  // a page comes back and says what it said before it went: that is news, because the menu is not what it said then
  assert.equal(f.shell.report(before), true);
  assert.equal(f.item('doc.save').enabled, true);
  assert.equal(f.item('find').enabled, true);
  assert.equal(f.shell.state().flags.pageGone, false);
  // and a new page that has nothing to say yet is news too
  f.shell.pageGone();
  assert.equal(f.shell.report(EMPTY_REPORT), true);
  assert.equal(f.item('find').enabled, true);
  assert.equal(f.shell.report(EMPTY_REPORT), false, 'but the same thing said again is not');
});

test('a key that is taken is dealt with after the key event has returned, like the click of an item: the menu is never replaced in the middle of a key event', () => {
  const f = fixture({ defer: true });
  f.shell.start();
  f.shell.report({ ...EMPTY_REPORT, capture: true, tabs: 1, tab: 0 });
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true })), true, 'taken at once: the page must not see it');
  assert.equal(f.shell.keyDown(press('q', 'KeyQ', { meta: true }, { isAutoRepeat: true })), true);
  assert.deepEqual(f.calls, [], 'not yet done');
  assert.equal(f.deferred.length, 1, 'and held down it is one');
  f.flush();
  assert.deepEqual(f.calls, ['quit']);
});

