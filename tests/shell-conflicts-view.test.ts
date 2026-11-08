import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConflictView, Value } from '../src/documents/conflicts.js';
import { confirmText, optionsOf, summary, titleOf, valueText } from '../src/desktop/conflicts-view.js';

const field = (over: Partial<Extract<ConflictView, { kind: 'field' }>> = {}): ConflictView => ({ key: 'c-0000000000000001', kind: 'field', choices: ['mine', 'theirs'], object: 'web', objectType: 'connection', field: 'props.host', what: 'property', property: 'host', base: { text: 'a' }, mine: { text: 'mine.example' }, theirs: { text: 'theirs.example' }, ...over });

test('a value is said as it is, and what stands for no value, the top level, a folder that is not there and a value that was cut are each said in words', () => {
  const said = (value: Value) => valueText(value);
  assert.equal(said({ text: 'host.example' }), 'host.example');
  assert.equal(said({ text: '', none: true }), '(tidak ada)');
  assert.equal(said({ text: '', top: true }), '(tingkat atas)');
  assert.equal(said({ text: '', gone: true }), '(folder tidak ada)');
  assert.equal(said({ text: '' }), '(kosong)');
  assert.equal(said({ text: 'abc', cut: true }), 'abc…');
  assert.equal(said({ text: '3390', json: 'number' }), '3390 (angka)', 'a number is not the text that looks like it');
  assert.equal(said({ text: '3390' }), '3390');
  assert.equal(said({ text: 'true', json: 'boolean' }), 'true (benar/salah)');
  assert.equal(said({ text: 'null', json: 'null' }), 'null (tanpa nilai)');
  assert.equal(said({ text: '[1]', json: 'array' }), '[1] (daftar)');
  assert.equal(said({ text: '{"a":1}', json: 'object', cut: true }), '{"a":1}… (objek)');
});

test('every conflict has a title that says what it is about and what happened, in words, without a key or an id', () => {
  assert.equal(titleOf(field()), 'Koneksi “web” — properti host');
  assert.equal(titleOf(field({ what: 'name', field: 'name', objectType: 'folder', object: 'Servers' })), 'Folder “Servers” — nama');
  assert.equal(titleOf(field({ what: 'parent', field: 'parentId' })), 'Koneksi “web” — folder induk');
  assert.equal(titleOf(field({ what: 'type', field: 'type' })), 'Koneksi “web” — jenis');
  assert.equal(titleOf(field({ what: 'document-name', objectType: 'document', object: 'Lab', field: 'document.name' })), 'Nama dokumen');
  assert.equal(titleOf({ key: 'c-1', kind: 'delete-edit', choices: ['keep', 'delete'], object: 'old', objectType: 'connection', deletedBy: 'mine', below: 0 }), 'Koneksi “old” — dihapus di sini, tetapi diubah di tempat lain');
  assert.equal(titleOf({ key: 'c-1', kind: 'delete-edit', choices: ['keep', 'delete'], object: 'old', objectType: 'folder', deletedBy: 'theirs', below: 0 }), 'Folder “old” — dihapus di tempat lain, tetapi diubah di sini');
  assert.equal(titleOf({ key: 'c-1', kind: 'orphan', choices: ['keep', 'delete'], object: 'n9', objectType: 'connection', below: 0 }), 'Koneksi “n9” — folder induknya sudah tidak ada', 'whoever deleted the folder: it is not said to be the other side');
  assert.equal(titleOf({ key: 'c-1', kind: 'cycle', choices: ['accept'], objects: ['f5', 'f6'], total: 2 }), 'Folder “f5”, “f6” — saling memindahkan hingga membentuk lingkaran');
  assert.equal(titleOf({ key: 'c-1', kind: 'cycle', choices: ['accept'], objects: ['f1', 'f2'], total: 5 }), 'Folder “f1”, “f2” dan 3 lainnya — saling memindahkan hingga membentuk lingkaran');
  assert.equal(titleOf({ key: 'c-1', kind: 'hidden', of: 'field', choices: ['mine', 'theirs'] }), 'Objek yang tidak ditampilkan — diubah di dua tempat');
  assert.equal(titleOf({ key: 'c-1', kind: 'hidden', of: 'delete-edit', choices: ['keep', 'delete'] }), 'Objek yang tidak ditampilkan — dihapus di satu tempat, diubah di tempat lain');
  assert.equal(titleOf({ key: 'c-1', kind: 'hidden', of: 'orphan', choices: ['keep', 'delete'] }), 'Objek yang tidak ditampilkan — folder induknya sudah tidak ada');
  assert.equal(titleOf(field({ what: 'name', field: 'name', objectType: 'document', object: 'Lab' })), 'Dokumen “Lab” — nama', 'the word for a document');
});

test('what can be chosen is offered in the order the main process says, each with words, and a field shows what each side holds; nothing is chosen beforehand', () => {
  const field1 = optionsOf(field());
  assert.deepEqual(field1.map((o) => o.choice), ['mine', 'theirs']);
  assert.deepEqual(field1.map((o) => [o.label, o.detail]), [['Milik saya', 'mine.example'], ['Milik mereka', 'theirs.example']]);
  assert.deepEqual(optionsOf(field({ what: 'parent', mine: { text: '', top: true }, theirs: { text: 'f4' } })).map((o) => o.detail), ['(tingkat atas)', 'f4']);
  const mineDeleted = optionsOf({ key: 'c-1', kind: 'delete-edit', choices: ['keep', 'delete'], object: 'x', objectType: 'connection', deletedBy: 'mine', below: 0 });
  assert.deepEqual(mineDeleted.map((o) => [o.choice, o.label]), [['keep', 'Pertahankan (ada perubahan di tempat lain)'], ['delete', 'Hapus (seperti di sini)']]);
  const theirsDeleted = optionsOf({ key: 'c-1', kind: 'delete-edit', choices: ['keep', 'delete'], object: 'x', objectType: 'connection', deletedBy: 'theirs', below: 0 });
  assert.deepEqual(theirsDeleted.map((o) => [o.choice, o.label]), [['keep', 'Pertahankan (perubahan saya)'], ['delete', 'Hapus (seperti di tempat lain)']]);
  assert.deepEqual(optionsOf({ key: 'c-1', kind: 'orphan', choices: ['keep', 'delete'], object: 'x', objectType: 'folder', below: 0 }).map((o) => [o.choice, o.label]), [['keep', 'Pertahankan di tingkat atas'], ['delete', 'Hapus']]);
  assert.deepEqual(optionsOf({ key: 'c-1', kind: 'cycle', choices: ['accept'], objects: ['a', 'b'], total: 2 }).map((o) => [o.choice, o.label]), [['accept', 'Terima: folder kembali ke tempat semula']]);
  const hidden = optionsOf({ key: 'c-1', kind: 'hidden', of: 'field', choices: ['mine', 'theirs'] });
  assert.deepEqual(hidden.map((o) => [o.choice, o.label, o.detail]), [['mine', 'Milik saya', undefined], ['theirs', 'Milik mereka', undefined]], 'what the window may not see is not shown');
  assert.deepEqual(optionsOf({ key: 'c-1', kind: 'hidden', of: 'orphan', choices: ['keep', 'delete'] }).map((o) => [o.choice, o.label]), [['keep', 'Pertahankan'], ['delete', 'Hapus']], 'a hidden object is kept or deleted without more words');
  const reordered = optionsOf({ key: 'c-1', kind: 'orphan', choices: ['delete', 'keep'], object: 'x', objectType: 'folder', below: 0 });
  assert.deepEqual(reordered.map((o) => o.choice), ['delete', 'keep'], 'the order is the main process\'s');
});

test('the count of conflicts says how many there are, and when the list is cut says what is not in it', () => {
  assert.equal(summary(0, 0), 'Tidak ada konflik.');
  assert.equal(summary(1, 1), '1 konflik');
  assert.equal(summary(3, 3), '3 konflik');
  assert.equal(summary(230, 200), 'Menampilkan 200 dari 230 konflik; “Semua milik saya” dan “Semua milik mereka” berlaku untuk seluruhnya.');
});

test('a choice to delete says how many objects go with the one that is deleted, when there are any', () => {
  const folderWith = (below: number): ConflictView => ({ key: 'c-1', kind: 'delete-edit', choices: ['keep', 'delete'], object: 'f', objectType: 'folder', deletedBy: 'theirs', below });
  assert.deepEqual(optionsOf(folderWith(3)).map((o) => [o.choice, o.detail]), [['keep', undefined], ['delete', '3 objek di dalamnya ikut terhapus']]);
  assert.deepEqual(optionsOf(folderWith(0)).map((o) => o.detail), [undefined, undefined], 'nothing is said when nothing goes with it');
  const orphan: ConflictView = { key: 'c-1', kind: 'orphan', choices: ['keep', 'delete'], object: 'f', objectType: 'folder', below: 1 };
  assert.deepEqual(optionsOf(orphan).map((o) => o.detail), [undefined, '1 objek di dalamnya ikut terhapus']);
});

test('the question before "mine for everything" or "theirs for everything" says how many it is for and what it does to each kind of conflict, as the main process does it', () => {
  const mine = confirmText('mine', 3), theirs = confirmText('theirs', 12);
  assert.match(mine, /^Terapkan “Milik saya” untuk 3 konflik\?/);
  assert.match(theirs, /^Terapkan “Milik mereka” untuk 12 konflik\?/);
  assert.match(mine, /yang saya hapus di sini tetap terhapus/i);
  assert.match(mine, /dihapus di tempat lain tetap ada dengan perubahan saya/i);
  assert.match(theirs, /dihapus di tempat lain ikut terhapus di sini/i);
  assert.match(theirs, /yang saya hapus di sini kembali dengan perubahan mereka/i, 'what was deleted here comes back: that is said too');
  for (const text of [mine, theirs]) assert.match(text, /folder induknya sudah tidak ada dipertahankan di tingkat atas/i, 'an object whose folder is gone is kept at the top level on either side');
  assert.notEqual(mine, theirs);
});
