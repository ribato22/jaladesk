import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TAB_KEYS, shortcutRows, tabRows } from '../src/desktop/shortcuts-view.js';
import { moveKeyDelta } from '../src/desktop/tab-order.js';

test('the list of keys has the settings, with the key of the system for them on each platform', () => {
  const mac = new Map(shortcutRows('darwin').map((r) => [r.id, r]));
  assert.deepEqual([mac.get('app.settings')!.label, mac.get('app.settings')!.keys], ['Pengaturan…', '⌘,']);
  const win = new Map(shortcutRows('win32').map((r) => [r.id, r]));
  assert.deepEqual([win.get('app.settings')!.label, win.get('app.settings')!.keys], ['Pengaturan…', 'Ctrl+,']);
  assert.equal(new Map(shortcutRows('linux').map((r) => [r.id, r])).get('app.settings')!.keys, 'Ctrl+,');
});

test('the keys of a tab are told in a list of their own: they work only with the focus on a tab, and the page asks the function that does what the list says', async () => {
  assert.deepEqual(tabRows('darwin'), [{ label: 'Pindahkan tab', keys: '⌥ + panah kiri atau kanan' }]);
  assert.deepEqual(tabRows('win32'), [{ label: 'Pindahkan tab', keys: 'Alt + panah kiri atau kanan' }]);
  assert.equal(tabRows('linux').length, TAB_KEYS.length);
  assert.deepEqual(tabRows('linux'), tabRows('win32'), 'Linux has the keys of Windows, not those of the Mac');
  const source = await readFile(fileURLToPath(new URL('../../src/desktop/tabs-ui.ts', import.meta.url)), 'utf8');
  assert.match(source, /moveKeyDelta\(event\)/, 'the page asks the function that is tested for what a key does to a tab');
  const press = (key: string, altKey: boolean) => ({ key, altKey, ctrlKey: false, metaKey: false, shiftKey: false });
  assert.deepEqual([moveKeyDelta(press('ArrowLeft', true)), moveKeyDelta(press('ArrowRight', true)), moveKeyDelta(press('ArrowLeft', false))], [-1, 1, undefined], 'and the function does what the list says: Alt and the arrows to the left and to the right'); 
});
