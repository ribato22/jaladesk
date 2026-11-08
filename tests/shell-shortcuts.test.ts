import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMANDS, keysFor, spec, type Platform } from '../src/desktop/commands.js';
import { RESERVED_IN_CAPTURE, SYSTEM_KEYS_IN_CAPTURE } from '../src/desktop/menu-model.js';
import { TREE_KEYS, captureNote, shortcutRows, treeRows } from '../src/desktop/shortcuts-view.js';

test('the list of keys has a row for every command that has a key on the platform, in the order of the list of commands, and for none that has not; the nine tabs are one row', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const rows = shortcutRows(platform);
    const expected = COMMANDS.filter((c) => keysFor(c, platform) !== undefined && !/^tab\.[2-9]$/.test(c.id)).map((c) => c.id);
    assert.deepEqual(rows.map((r) => r.id), expected, platform);
    for (const row of rows) assert.ok(row.label.length > 0 && row.keys.length > 0, `${platform} ${row.id}`);
  }
  const mac = new Map(shortcutRows('darwin').map((r) => [r.id, r]));
  assert.deepEqual([mac.get('tab.1')!.label, mac.get('tab.1')!.keys], ['Tab 1 sampai 9', '⌘1 … ⌘9']);
  assert.equal(new Map(shortcutRows('win32').map((r) => [r.id, r])).get('tab.1')!.keys, 'Ctrl+1 … Ctrl+9');
  assert.equal(mac.has('tab.2'), false);
  assert.ok(shortcutRows('darwin').length <= 24, 'short enough to be read at a glance');
});

test('the keys are told in the way of the platform, and the words are the words of the menu, except where the menu changes its words with what is on', () => {
  const mac = new Map(shortcutRows('darwin').map((r) => [r.id, r]));
  assert.deepEqual([mac.get('doc.save')!.label, mac.get('doc.save')!.keys], ['Simpan', '⌘S']);
  assert.equal(mac.get('doc.close')!.keys, '⇧⌘W');
  assert.equal(mac.get('tab.next')!.keys, '⌃⇥');
  assert.equal(mac.get('app.quit')!.keys, '⌘Q');
  const win = new Map(shortcutRows('win32').map((r) => [r.id, r]));
  assert.equal(win.get('doc.save')!.keys, 'Ctrl+S');
  assert.equal(win.has('obj.connect'), false, 'connecting has no key of the menu: Enter in the tree does it');
  assert.equal(win.get('view.fullscreen')!.keys, 'F11');
  assert.equal(win.has('app.quit'), false, 'there is no key for quitting on Windows');
  assert.equal(win.get('view.toolbar')!.label, 'Tampilkan atau Sembunyikan Toolbar');
  assert.equal(mac.get('view.fullscreen')!.label, 'Layar Penuh');
  for (const [id, row] of mac) if (!['view.toolbar', 'tab.1'].includes(id)) assert.equal(row.label, spec(id).label, id);
});

test('what is said about a session that holds the keyboard names the keys that stay the application\'s, the keys of the system that it does not take, and the key that gives the keyboard back', () => {
  const mac = captureNote('darwin');
  assert.match(mac, /semua tombol diteruskan ke sesi/);
  for (const id of RESERVED_IN_CAPTURE.darwin) assert.ok(mac.includes(`${spec(id).label} (`), id);
  for (const { label } of SYSTEM_KEYS_IN_CAPTURE.darwin) assert.ok(mac.includes(`${label} (`), label);
  assert.equal(mac, 'Saat sesi remote yang terhubung memegang papan ketik, semua tombol diteruskan ke sesi. Yang tetap milik aplikasi: Keluar (⌘Q), Layar Penuh (⌃⌘F), Lepas Papan Ketik dari Sesi (⌃⌥⌘K). Sembunyikan (⌘H), Sembunyikan yang Lain (⌥⌘H), Minimalkan (⌘M) tetap ada di menu, tetapi tombolnya milik sistem dan tidak diambil aplikasi: bila tidak bekerja dari layar sesi, pilih itemnya dengan tetikus.');
  const win = captureNote('win32' as Platform);
  assert.equal(win, 'Saat sesi remote yang terhubung memegang papan ketik, semua tombol diteruskan ke sesi. Yang tetap milik aplikasi: Lepas Papan Ketik dari Sesi (Ctrl+Alt+Shift+K).');
  assert.ok(!win.includes('Keluar') && !win.includes('Layar Penuh'), 'on Windows they are the session\'s');
  assert.equal(captureNote('linux'), win);
});

test('the keys of the tree are told in a list of their own: they work only with the focus in the tree, and each key of the list is one that the handler of the tree names (found in its source: the handler is not run here, the scenarios press the keys)', async () => {
  assert.deepEqual(treeRows('darwin'), [
    { label: 'Hubungkan', keys: '↩' }, { label: 'Duplikat', keys: '⌘D' }, { label: 'Favorit', keys: '⌘B' }, { label: 'Hapus', keys: 'Delete atau Backspace' }, { label: 'Pindah', keys: '⌥ + panah' },
  ]);
  assert.deepEqual(treeRows('win32').map((r) => r.keys), ['Enter', 'Ctrl+D', 'Ctrl+B', 'Delete atau Backspace', 'Alt + panah']);
  assert.equal(treeRows('linux').length, TREE_KEYS.length);
  // the page really does what the list says (documents-ui.ts, the handler of the keys of the tree)
  const source = await readFile(fileURLToPath(new URL('../../src/desktop/documents-ui.ts', import.meta.url)), 'utf8');
  assert.match(source, /event\.key\.toLowerCase\(\) === 'd'/, 'Duplikat');
  assert.match(source, /withCommand\(event, 'b'\)/, 'Favorit');
  assert.match(source, /event\.key === 'Delete' \|\| event\.key === 'Backspace'/, 'Hapus');
  assert.match(source, /event\.key === 'Enter'/, 'Hubungkan');
  assert.match(source, /altMoves\[event\.key\]/, 'Pindah');
  // and none of them is also a key of the menu, which would run it from a box that a note is typed in
  const menuKeys = new Set(COMMANDS.flatMap((c) => [keysFor(c, 'darwin'), keysFor(c, 'win32')]).filter((k): k is string => k !== undefined));
  for (const k of ['Cmd+D', 'Ctrl+D', 'Cmd+B', 'Ctrl+B', 'Delete', 'Alt+Up']) assert.equal(menuKeys.has(k), false, k);
});
