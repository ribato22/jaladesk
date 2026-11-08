import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS, COMMAND_IDS, MAX_RECENT, isCommand, keysFor, recentIndex, spec, type CommandId } from '../src/desktop/commands.js';

// What package 02-B3b adds to the list of commands: the settings, the recent documents, forgetting a remembered key, moving a tab, the two switches of the view. The tests of 02-B3 about the list stay as they were,
// but for the two things that had to change on purpose (a comma is a key now, and the main process owns more commands): shell-commands.test.ts.
const NEW: readonly CommandId[] = [
  'doc.forgetKey', 'doc.recent.1', 'doc.recent.2', 'doc.recent.3', 'doc.recent.4', 'doc.recent.5', 'doc.recent.6', 'doc.recent.7', 'doc.recent.8', 'doc.recent.9', 'doc.recent.10', 'doc.recent.clear',
  'tab.moveLeft', 'tab.moveRight', 'view.colorizeTabs', 'view.extendedFullscreen', 'app.settings',
];

test('the original 46 commands and seventeen B3b additions remain beside two C2 entries and C3 document properties, without duplicates', () => {
  assert.equal(COMMAND_IDS.length, 69);
  assert.equal(new Set(COMMAND_IDS).size, 69);
  for (const id of NEW) { assert.ok(COMMAND_IDS.includes(id), id); assert.ok(isCommand(id), id); }
  assert.deepEqual(COMMAND_IDS.filter((id) => !NEW.includes(id) && !['doc.vault','obj.templates','doc.properties','doc.password','obj.transfer','obj.bulk'].includes(id)).length, 46, 'the 46 that were there are all still there');
  assert.equal(spec('app.settings').label, 'Pengaturan…');
  assert.equal(spec('doc.forgetKey').label, 'Lupakan Kunci yang Diingat');
  assert.equal(spec('doc.recent.clear').label, 'Bersihkan Daftar');
  assert.equal(spec('tab.moveLeft').label, 'Pindahkan Tab ke Kiri');
  assert.equal(spec('tab.moveRight').label, 'Pindahkan Tab ke Kanan');
  assert.equal(spec('view.colorizeTabs').label, 'Warnai Tab');
  assert.equal(spec('view.extendedFullscreen').label, 'Layar Penuh yang Diperluas');
  for (let n = 1; n <= 10; n++) assert.equal(spec(`doc.recent.${n}` as CommandId).label, `Terbaru ${n}`);
});

test('who does what: the main process owns the settings, the switches of the view and clearing the list; the window owns the rest', () => {
  for (const id of ['app.settings', 'view.colorizeTabs', 'view.extendedFullscreen', 'doc.recent.clear'] as const) assert.equal(spec(id).owner, 'main', id);
  for (const id of ['doc.forgetKey', 'tab.moveLeft', 'tab.moveRight', 'doc.recent.1', 'doc.recent.10'] as const) assert.equal(spec(id).owner, 'window', id);
  assert.deepEqual(COMMANDS.filter((c) => c.owner === 'main').map((c) => c.id),
    ['doc.recent.clear', 'view.toolbar', 'view.colorizeTabs', 'view.theme.system', 'view.theme.light', 'view.theme.dark', 'view.fullscreen', 'view.extendedFullscreen', 'app.settings', 'app.about', 'app.quit']);
});

test('only the settings have a key: the comma, with Cmd on macOS and Ctrl elsewhere, as every application of the system has them', () => {
  assert.equal(keysFor(spec('app.settings'), 'darwin'), 'Cmd+,');
  assert.equal(keysFor(spec('app.settings'), 'win32'), 'Ctrl+,');
  assert.equal(keysFor(spec('app.settings'), 'linux'), 'Ctrl+,');
  for (const id of NEW.filter((n) => n !== 'app.settings')) for (const platform of ['darwin', 'win32', 'linux'] as const) assert.equal(keysFor(spec(id), platform), undefined, `${platform} ${id}: a tab is moved with Alt and the arrows when it has the focus (and from the menu), the rest are for the menu and the pointer`);
});

test('the recent documents are ten, and a command says which one of them it is', () => {
  assert.equal(MAX_RECENT, 10);
  for (let n = 1; n <= 10; n++) assert.equal(recentIndex(`doc.recent.${n}` as CommandId), n - 1);
  for (const id of COMMAND_IDS.filter((c) => !/^doc\.recent\.\d+$/.test(c))) assert.equal(recentIndex(id), undefined, id);
  assert.equal(recentIndex('doc.recent.0' as CommandId), undefined, 'there is no place zero');
  assert.equal(recentIndex('doc.recent.11' as CommandId), undefined, 'and none after the tenth');
  assert.equal(isCommand('doc.recent.0'), false);
  assert.equal(isCommand('doc.recent.11'), false);
  assert.equal(isCommand('doc.recent.01'), false);
  assert.equal(isCommand('doc.recent.'), false);
});

test('forgetting a remembered key has no button of its own: the window does it, and the menu says when (menu-model.ts)', () => {
  assert.equal(spec('doc.forgetKey').button, undefined);
  assert.equal(spec('doc.forgetKey').owner, 'window');
});

test('the new commands are not offered on the toolbar: none has short words or a picture', () => {
  for (const id of NEW) { assert.equal(spec(id).short, undefined, id); assert.equal(spec(id).icon, undefined, id); }
});
