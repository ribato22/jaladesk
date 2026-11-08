import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS, EMPTY_REPORT, type CommandId, type Platform, type Report } from '../src/desktop/commands.js';
import { closesWindow, type KeyInput } from '../src/desktop/key-match.js';
import { buildMenu, findCommand, isAvailable, type Flags } from '../src/desktop/menu-model.js';
import { createShell, type WindowLike } from '../src/desktop/shell.js';
import { Settings } from '../src/desktop/settings.js';
import type { TemplateItem } from '../src/desktop/menu.js';

// The independent review of the spike (slice 3): the menu of the Mac is one for all the windows, so while the window of the settings has the focus the commands of the main window (Tutup Tab on Cmd+W) must not be
// done by a key that was meant for the settings window; that window closes itself on Cmd+W.
const FLAGS: Flags = { theme: 'system', toolbar: true, fullscreen: false, prompt: false };
const report: Report = { ...EMPTY_REPORT, enabled: COMMANDS.map((c) => c.id), tabs: 3, tab: 1, capture: false };
const press = (key: string, code: string, modifiers: Partial<Pick<KeyInput, 'meta' | 'control' | 'alt' | 'shift'>> = {}, more: Partial<KeyInput> = {}): KeyInput =>
  ({ type: 'keyDown', key, code, isAutoRepeat: false, meta: false, control: false, alt: false, shift: false, ...modifiers, ...more });

test('while another window of the application has the focus the commands of the main window cannot be done and the main process\'s own can', () => {
  for (const spec of COMMANDS) {
    const here = isAvailable(spec.id, report, { ...FLAGS, recent: ['A'], keys: 1 });
    const away = isAvailable(spec.id, report, { ...FLAGS, recent: ['A'], keys: 1, away: true });
    if (spec.owner === 'window') assert.equal(away, false, `${spec.id} belongs to the window that does not have the focus`);
    else assert.equal(away, here, `${spec.id} is the main process's own`);
  }
  assert.equal(isAvailable('session.closeTab', report, FLAGS), true);
  assert.equal(isAvailable('session.closeTab', report, { ...FLAGS, away: true }), false);
  assert.equal(isAvailable('app.quit', report, { ...FLAGS, away: true }), true);
  assert.equal(isAvailable('app.settings', report, { ...FLAGS, away: true }), true, 'Pengaturan brings the window to the front');
  const menu = buildMenu({ platform: 'darwin', appName: 'RW', report, flags: { ...FLAGS, away: true } });
  assert.equal(findCommand(menu, 'session.closeTab')!.enabled, false);
  assert.equal(findCommand(menu, 'view.theme.dark')!.enabled, true);
});

test('the key that closes a window with no menu of its own is Cmd+W on the Mac and Ctrl+W elsewhere, pressed once and with nothing else held', () => {
  assert.equal(closesWindow('darwin', press('w', 'KeyW', { meta: true })), true);
  assert.equal(closesWindow('darwin', press('W', 'KeyW', { meta: true })), true, 'Caps Lock');
  assert.equal(closesWindow('darwin', press('w', 'KeyW', { control: true })), false, 'Ctrl+W is not the key of the Mac');
  assert.equal(closesWindow('darwin', press('w', 'KeyW')), false, 'a letter w is a letter w');
  assert.equal(closesWindow('darwin', press('w', 'KeyW', { meta: true, shift: true })), false);
  assert.equal(closesWindow('darwin', press('w', 'KeyW', { meta: true, alt: true })), false);
  assert.equal(closesWindow('darwin', press('q', 'KeyQ', { meta: true })), false);
  for (const platform of ['win32', 'linux'] as const) {
    assert.equal(closesWindow(platform, press('w', 'KeyW', { control: true })), true, platform);
    assert.equal(closesWindow(platform, press('w', 'KeyW', { meta: true })), false, platform);
    assert.equal(closesWindow(platform, press('w', 'KeyW', { control: true, alt: true })), false, `${platform}: AltGr`);
  }
  assert.equal(closesWindow('darwin', press('w', 'KeyW', { meta: true }, { type: 'keyUp' })), false, 'the release of the key');
  assert.equal(closesWindow('darwin', press('w', 'KeyW', { meta: true }, { isAutoRepeat: true })), false, 'a key held down closes one window, not every window that follows');
});

function walk(items: readonly TemplateItem[]): TemplateItem[] { return items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])]); }
function fixture(platform: Platform = 'darwin') {
  const view = { template: [] as TemplateItem[], installs: 0 };
  const window: WindowLike = { send: () => undefined, isFullScreen: () => false, setFullScreen: () => undefined, setBackgroundColor: () => undefined };
  const shell = createShell({
    platform, appName: 'RW', settings: Settings.memory(), setApplicationMenu: (template) => { view.template = template; view.installs++; }, window: () => window,
    nativeTheme: { setSource: () => undefined, isDark: () => false }, showAbout: () => undefined, quit: () => undefined, report: () => undefined,
  });
  const item = (id: CommandId) => walk(view.template).find((i) => i.id === id)!;
  return { shell, view, item };
}

test('the shell follows which window has the focus: the menu is made again when it changes and not when it does not', () => {
  const f = fixture();
  f.shell.start();
  f.shell.report({ ...report });
  assert.equal(f.item('session.closeTab').enabled, true);
  const installs = f.view.installs;
  f.shell.setAway(true);
  assert.equal(f.item('session.closeTab').enabled, false);
  assert.equal(f.item('view.theme.dark').enabled, true);
  assert.equal(f.view.installs, installs + 1);
  f.shell.setAway(true);
  assert.equal(f.view.installs, installs + 1, 'the same menu stays');
  f.shell.setAway(false);
  assert.equal(f.item('session.closeTab').enabled, true);
  assert.equal(f.view.installs, installs + 2);
});

test('a command of the window that is clicked while another window has the focus does nothing', async () => {
  const f = fixture();
  f.shell.start();
  f.shell.report({ ...report });
  f.shell.setAway(true);
  assert.equal(await f.shell.run('session.closeTab' as CommandId), false, 'a command of the window is not run here in any case');
  f.item('session.closeTab').click?.();
  assert.equal(f.shell.state().flags.away, true);
});
