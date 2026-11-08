import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS, spec, type CommandId } from '../src/desktop/commands.js';
import { DEFAULT_LAYOUT, MAX_ITEMS, OFFERED, SEPARATOR, addSeparator, buttons, move, removeAt, repairLayout, rovingNext, rovingStop, sameLayout, tidy, toggle, type Item, type Layout } from '../src/desktop/toolbar-model.js';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** What every layout is: nothing but offered commands and separators, no command twice, no separator at an end or next to another, and not too long. */
function assertValid(layout: Layout, why = '') {
  assert.ok(layout.length <= MAX_ITEMS, `${why}: not too long`);
  const seen = new Set<string>();
  layout.forEach((item, i) => {
    if (item === SEPARATOR) {
      assert.ok(i > 0 && i < layout.length - 1, `${why}: a separator at an end`);
      assert.notEqual(layout[i + 1], SEPARATOR, `${why}: two separators`);
    } else {
      assert.ok((OFFERED as readonly string[]).includes(item), `${why}: ${item} is offered`);
      assert.ok(!seen.has(item), `${why}: ${item} twice`);
      seen.add(item);
    }
  });
}

test('the toolbar offers the commands that have words and a picture for a button, in the order of the list of commands', () => {
  assert.deepEqual(OFFERED, COMMANDS.filter((c) => c.short !== undefined).map((c) => c.id));
  assert.ok(OFFERED.length >= 20);
  for (const id of OFFERED) assert.ok(spec(id).icon !== undefined && spec(id).short !== undefined, id);
  assert.equal(SEPARATOR, '|');
  assert.ok(MAX_ITEMS >= OFFERED.length + 8, 'room for everything that is offered and a few separators');
});

test('the layout that the toolbar starts with is valid and has what is used most: documents, connecting, the objects, favourites and search', () => {
  assertValid(DEFAULT_LAYOUT, 'default');
  for (const id of ['doc.new', 'doc.open', 'doc.save', 'obj.connect', 'session.reconnect', 'session.disconnect', 'obj.addFolder', 'obj.addConnection', 'obj.edit', 'obj.duplicate', 'obj.remove', 'obj.favorite', 'find', 'adhoc.focus'] as const) assert.ok(DEFAULT_LAYOUT.includes(id), id);
  assert.ok(DEFAULT_LAYOUT.filter((i) => i === SEPARATOR).length >= 3, 'in groups');
  for (const id of ['doc.close', 'doc.reload', 'view.fullscreen', 'tree.expandAll'] as const) assert.equal(DEFAULT_LAYOUT.includes(id), false, `${id} is offered but not in front`);
  assert.deepEqual(DEFAULT_LAYOUT.slice(0, 4), ['doc.new', 'doc.open', 'doc.save', SEPARATOR]);
  assert.deepEqual(DEFAULT_LAYOUT, [
    'doc.new', 'doc.open', 'doc.save', SEPARATOR,
    'obj.connect', 'session.reconnect', 'session.disconnect', SEPARATOR,
    'obj.addFolder', 'obj.addConnection', 'obj.edit', 'obj.duplicate', 'obj.remove', SEPARATOR,
    'obj.favorite', SEPARATOR,
    'find', 'adhoc.focus',
  ], 'the whole of it, in this order');
});

test('a layout that is read from a file is repaired, not refused: what is unknown is dropped, a command is kept once, and the separators are put right', () => {
  assert.deepEqual(repairLayout(['doc.new', 'doc.open']), ['doc.new', 'doc.open']);
  assert.deepEqual(repairLayout([]), []);
  assert.deepEqual(repairLayout(['doc.new', 'nonsense', 'doc.open']), ['doc.new', 'doc.open'], 'a command of a newer version');
  assert.deepEqual(repairLayout(['doc.new', 'doc.new', 'doc.open']), ['doc.new', 'doc.open'], 'twice');
  assert.deepEqual(repairLayout(['app.quit', 'tab.1', 'doc.new']), ['doc.new'], 'a command that is not offered');
  assert.deepEqual(repairLayout([SEPARATOR, 'doc.new', SEPARATOR, SEPARATOR, 'doc.open', SEPARATOR]), ['doc.new', SEPARATOR, 'doc.open']);
  assert.deepEqual(repairLayout(['doc.new', 'nonsense', SEPARATOR, 'nonsense', 'doc.open']), ['doc.new', SEPARATOR, 'doc.open'], 'what is dropped leaves no empty group');
  assert.deepEqual(repairLayout([SEPARATOR, SEPARATOR]), []);
  const long = [...OFFERED.flatMap((id) => [id, SEPARATOR]), ...OFFERED.flatMap((id) => [id, SEPARATOR])];
  assertValid(repairLayout(long)!, 'long');
  for (const wrong of [undefined, null, 'doc.new', 7, {}, { 0: 'doc.new' }, [1], [null], ['doc.new', 5], [['doc.new']]]) assert.equal(repairLayout(wrong), undefined, JSON.stringify(wrong));
  for (const prototype of ['constructor', '__proto__', 'toString']) assert.deepEqual(repairLayout([prototype, 'doc.new']), ['doc.new'], prototype);
  // the separators that tidying would drop do not count towards the limit: fifty of them before the commands cost the commands nothing
  const padded = [...Array<string>(50).fill(SEPARATOR), ...OFFERED.slice(0, 5)];
  assert.deepEqual(repairLayout(padded), OFFERED.slice(0, 5));
  const crowded = OFFERED.flatMap((id) => [id, SEPARATOR, SEPARATOR]);
  const mended = repairLayout(crowded)!;
  assertValid(mended, 'crowded');
  assert.deepEqual(mended.filter((i) => i !== SEPARATOR), OFFERED.slice(0, mended.filter((i) => i !== SEPARATOR).length), 'the first commands are the ones that stay');
  // twenty commands each followed by a separator, then two more: 42 entries, cut at 40 (the last of them a separator, which goes): the first twenty commands with a separator between each pair
  const cut = repairLayout([...OFFERED.slice(0, 20).flatMap((id) => [id, SEPARATOR]), ...OFFERED.slice(20, 22)])!;
  assert.deepEqual(cut, OFFERED.slice(0, 20).flatMap((id, i) => (i === 0 ? [id] : [SEPARATOR, id])));
  assert.equal(cut.length, MAX_ITEMS - 1);
});

test('tidying puts the separators right and keeps everything else as it was', () => {
  assert.deepEqual(tidy([SEPARATOR, 'doc.new', SEPARATOR, SEPARATOR, 'doc.open', SEPARATOR]), ['doc.new', SEPARATOR, 'doc.open']);
  assert.deepEqual(tidy(['doc.new', 'doc.open']), ['doc.new', 'doc.open']);
  assert.deepEqual(tidy([]), []);
  const layout: Item[] = ['doc.new', SEPARATOR, 'doc.open'];
  assert.notEqual(tidy(layout), layout, 'a new list');
});

test('a command is put on the toolbar at the end or taken off, and what is not offered or does not fit is left alone', () => {
  assert.deepEqual(toggle(['doc.new'], 'doc.open'), ['doc.new', 'doc.open']);
  assert.deepEqual(toggle(['doc.new', 'doc.open'], 'doc.new'), ['doc.open']);
  assert.deepEqual(toggle(['doc.new', SEPARATOR, 'doc.open'], 'doc.open'), ['doc.new'], 'the separator that would be left at the end goes with it');
  assert.deepEqual(toggle(['doc.new', SEPARATOR, 'doc.open', 'doc.save'], 'doc.open'), ['doc.new', SEPARATOR, 'doc.save']);
  assert.deepEqual(toggle(['doc.new', SEPARATOR, 'doc.open'], 'doc.new'), ['doc.open'], 'nor one at the start');
  const base: Layout = ['doc.new'];
  assert.equal(toggle(base, 'app.quit' as CommandId), base, 'not offered');
  assert.equal(toggle(base, 'constructor' as CommandId), base);
  // a layout as long as one can be: twenty commands with a separator between each pair is 39 entries, one more command makes 40, and nothing more fits
  const spaced: Layout = OFFERED.slice(0, 20).flatMap((id, i) => (i === 0 ? [id] : [SEPARATOR, id]));
  assert.equal(spaced.length, MAX_ITEMS - 1);
  assertValid(spaced, 'spaced');
  const complete = toggle(spaced, OFFERED[20]!);
  assert.equal(complete.length, MAX_ITEMS, 'one more fits');
  assertValid(complete, 'complete');
  assert.equal(toggle(complete, OFFERED[21]!), complete, 'a layout that is full takes nothing more');
  assert.equal(toggle(complete, OFFERED[20]!).length, MAX_ITEMS - 1, 'but a command can still be taken off');
});

test('an item moves one place up or down, and only where the result is a valid layout', () => {
  const layout: Layout = ['doc.new', 'doc.open', SEPARATOR, 'doc.save', 'find'];
  assert.deepEqual(move(layout, 1, -1), ['doc.open', 'doc.new', SEPARATOR, 'doc.save', 'find']);
  assert.deepEqual(move(layout, 0, 1), ['doc.open', 'doc.new', SEPARATOR, 'doc.save', 'find']);
  assert.equal(move(layout, 0, -1), layout, 'there is nothing above the first');
  assert.equal(move(layout, 4, 1), layout, 'and nothing below the last');
  assert.equal(move(layout, -1, 1), layout);
  assert.equal(move(layout, 9, -1), layout);
  assert.equal(move(layout, 1.5, 1), layout);
  assert.deepEqual(move(layout, 3, -1), ['doc.new', 'doc.open', 'doc.save', SEPARATOR, 'find'], 'past a separator');
  assert.deepEqual(move(layout, 2, -1), ['doc.new', SEPARATOR, 'doc.open', 'doc.save', 'find'], 'a separator moves like an item');
  assert.equal(move(['doc.new', SEPARATOR, 'doc.open'], 1, -1).join(), 'doc.new,|,doc.open', 'a separator cannot go to the start');
  assert.equal(move(['doc.new', SEPARATOR, 'doc.open'], 1, 1).join(), 'doc.new,|,doc.open', 'nor to the end');
  assert.deepEqual(move(['doc.new', SEPARATOR, 'doc.open', 'doc.save'], 1, 1), ['doc.new', 'doc.open', SEPARATOR, 'doc.save']);
  const two: Layout = ['doc.new', SEPARATOR, 'doc.open', SEPARATOR, 'doc.save'];
  assert.equal(move(two, 2, -1), two, 'an item cannot go between two separators and leave them side by side');
  assert.equal(move(two, 2, 1), two);
});

test('a separator is put between two items, not at an end and not next to another, and any item can be taken off', () => {
  const layout: Layout = ['doc.new', 'doc.open', 'doc.save'];
  assert.deepEqual(addSeparator(layout, 1), ['doc.new', SEPARATOR, 'doc.open', 'doc.save']);
  assert.deepEqual(addSeparator(layout, 2), ['doc.new', 'doc.open', SEPARATOR, 'doc.save']);
  assert.equal(addSeparator(layout, 0), layout, 'not at the start');
  assert.equal(addSeparator(layout, 3), layout, 'not at the end');
  assert.equal(addSeparator(layout, -1), layout);
  assert.equal(addSeparator(layout, 9), layout);
  assert.equal(addSeparator(layout, 1.5), layout);
  const once = addSeparator(layout, 1);
  assert.equal(addSeparator(once, 1), once, 'not next to another one (before it)');
  assert.equal(addSeparator(once, 2), once, 'nor after it');
  assert.deepEqual(removeAt(once, 1), layout);
  assert.deepEqual(removeAt(once, 0), ['doc.open', 'doc.save'], 'the separator that is left at the start goes');
  assert.deepEqual(removeAt(once, 3), ['doc.new', SEPARATOR, 'doc.open'], 'the last one goes');
  assert.equal(removeAt(once, 7), once);
  assert.equal(removeAt(once, -1), once);
  assert.equal(removeAt(once, 0.5), once);
  // twenty-one commands with a separator before all but the second: 40 entries, and a place where a separator would be allowed but does not fit
  const full: Layout = OFFERED.slice(0, 21).flatMap((id, i) => (i < 2 ? [id] : [SEPARATOR, id]));
  assert.equal(full.length, MAX_ITEMS);
  assertValid(full, 'full');
  assert.equal(addSeparator(full, 1), full, 'a layout that is full takes nothing more');
});

test('whatever a person does with the toolbar it stays a valid layout, and each change touches only what it should', () => {
  const random = mulberry32(2026102201);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const commandsOf = (layout: Layout) => new Set(layout.filter((i) => i !== SEPARATOR));
  let layout: Layout = DEFAULT_LAYOUT;
  const used = new Set<string>();
  const changed = { added: 0, removed: 0 };
  for (let n = 0; n < 4000; n++) {
    const action = pick(['toggle', 'toggle', 'move', 'separator', 'remove', 'reset']);
    used.add(action);
    const before = commandsOf(layout), length = layout.length;
    if (action === 'toggle') layout = toggle(layout, pick(OFFERED));
    else if (action === 'move') layout = move(layout, Math.floor(random() * (layout.length + 2)) - 1, pick([-1, 1] as const));
    else if (action === 'separator') layout = addSeparator(layout, Math.floor(random() * (layout.length + 2)) - 1);
    else if (action === 'remove') layout = removeAt(layout, Math.floor(random() * (layout.length + 2)) - 1);
    else layout = random() < 0.05 ? DEFAULT_LAYOUT : layout;
    assertValid(layout, `step ${n} ${action}`);
    const after = commandsOf(layout);
    const added = [...after].filter((id) => !before.has(id)), removed = [...before].filter((id) => !after.has(id));
    if (action === 'move' || action === 'separator') { assert.deepEqual([added, removed], [[], []], `step ${n}: ${action} keeps every command`); }
    else if (action === 'toggle') assert.ok(added.length + removed.length <= 1 && (added.length === 0 || removed.length === 0), `step ${n}: toggle adds or removes one`);
    else if (action === 'remove') assert.ok(added.length === 0 && removed.length <= 1, `step ${n}: remove takes at most one`);
    if (action === 'separator') assert.ok(layout.length === length || layout.length === length + 1, `step ${n}: a separator adds one item`);
    changed.added += added.length; changed.removed += removed.length;
  }
  assert.deepEqual([...used].sort(), ['move', 'remove', 'reset', 'separator', 'toggle'], 'every kind of change was tried');
  assert.ok(changed.added > 100 && changed.removed > 100, `commands came and went: ${changed.added} and ${changed.removed}`);
});

test('two layouts are the same when they hold the same items in the same order', () => {
  assert.equal(sameLayout(['doc.new', SEPARATOR, 'doc.open'], ['doc.new', SEPARATOR, 'doc.open']), true);
  assert.equal(sameLayout(['doc.new', 'doc.open'], ['doc.open', 'doc.new']), false);
  assert.equal(sameLayout(['doc.new'], ['doc.new', 'doc.open']), false);
  assert.equal(sameLayout([], []), true);
});

test('what the window draws for a layout: a button with its words and its picture for a command, and a gap for a separator', () => {
  const list = buttons(['doc.new', SEPARATOR, 'obj.connect']);
  assert.deepEqual(list, [
    { kind: 'button', id: 'doc.new', label: 'Baru', icon: 'new', title: 'Dokumen Baru…' },
    { kind: 'separator' },
    { kind: 'button', id: 'obj.connect', label: 'Hubungkan', icon: 'connect', title: 'Hubungkan' },
  ]);
  assert.deepEqual(buttons([]), []);
  for (const item of buttons(DEFAULT_LAYOUT)) if (item.kind === 'button') assert.ok(item.label.length > 0 && item.icon.length > 0 && item.title.length > 0);
});

test('the arrow keys move along the toolbar over the buttons that can be reached, around at the ends, and Home and End go to the first and the last', () => {
  const reach = [true, false, true, true, false, true];
  assert.equal(rovingNext(reach, 0, 'ArrowRight'), 2, 'over one that is off');
  assert.equal(rovingNext(reach, 2, 'ArrowRight'), 3);
  assert.equal(rovingNext(reach, 5, 'ArrowRight'), 0, 'around');
  assert.equal(rovingNext(reach, 0, 'ArrowLeft'), 5, 'around, the other way');
  assert.equal(rovingNext(reach, 3, 'ArrowLeft'), 2);
  assert.equal(rovingNext(reach, 2, 'ArrowLeft'), 0, 'over one that is off, the other way');
  assert.equal(rovingNext(reach, 3, 'Home'), 0);
  assert.equal(rovingNext(reach, 3, 'End'), 5);
  assert.equal(rovingNext([false, true, false], 1, 'ArrowRight'), 1, 'the only one that can be reached');
  assert.equal(rovingNext([false, false], 0, 'ArrowRight'), undefined, 'none can be reached');
  assert.equal(rovingNext([], 0, 'Home'), undefined);
  assert.equal(rovingNext(reach, 3, 'ArrowDown'), undefined, 'a key that is not for the toolbar');
  assert.equal(rovingNext(reach, 3, 'a'), undefined);
  assert.equal(rovingNext([false, true, true], 0, 'ArrowRight'), 1, 'from a button that is off now');
  assert.equal(rovingNext([true, true, false], -1, 'ArrowRight'), 0, 'from nowhere');
});

test('one button of the toolbar is in the order of the Tab key: the one that was last in front if it can still be reached, else the first that can', () => {
  assert.equal(rovingStop([true, true, true], 1), 1);
  assert.equal(rovingStop([true, false, true], 1), 0, 'the one that was in front is off now');
  assert.equal(rovingStop([false, false, true], 0), 2);
  assert.equal(rovingStop([false, false], 0), -1, 'none');
  assert.equal(rovingStop([], 0), -1);
  assert.equal(rovingStop([true, true], 5), 0, 'a place that is not there');
  assert.equal(rovingStop([true, true], -1), 0);
});

// Review of the execution (22 October 2026): the words and the picture of every button that can be on the toolbar, written out
test('every button that can be on the toolbar has the words, the picture and the tooltip that were read and approved', () => {
  assert.deepEqual(buttons(OFFERED).filter((b) => b.kind === 'button').map((b) => b.kind === 'button' ? [b.id, b.label, b.icon, b.title] : []), [
  ['doc.new', 'Baru', 'new', 'Dokumen Baru…'],
  ['doc.open', 'Buka', 'open', 'Buka Dokumen…'],
  ['doc.save', 'Simpan', 'save', 'Simpan'],
  ['doc.close', 'Tutup', 'close', 'Tutup Dokumen'],
  ['doc.reload', 'Muat ulang', 'reload', 'Muat Ulang Dokumen…'],
  ['doc.conflicts', 'Konflik', 'conflict', 'Konflik…'],
  ['doc.history', 'Riwayat', 'history', 'Riwayat Revisi…'],
  ['obj.connect', 'Hubungkan', 'connect', 'Hubungkan'],
  ['obj.addFolder', 'Folder', 'folder-add', 'Folder Baru…'],
  ['obj.addConnection', 'Koneksi', 'connection-add', 'Koneksi Baru…'],
  ['obj.edit', 'Properti', 'properties', 'Properti…'],
  ['obj.duplicate', 'Duplikat', 'duplicate', 'Duplikat'],
  ['obj.favorite', 'Favorit', 'favorite', 'Favorit'],
  ['obj.remove', 'Hapus', 'remove', 'Hapus'],
  ['tree.expandAll', 'Buka semua', 'expand', 'Buka Semua Folder'],
  ['tree.collapseAll', 'Tutup semua', 'collapse', 'Tutup Semua Folder'],
  ['find', 'Cari', 'search', 'Cari…'],
  ['adhoc.focus', 'Koneksi cepat', 'quick', 'Koneksi Cepat'],
  ['session.reconnect', 'Hubungkan ulang', 'reconnect', 'Hubungkan Ulang'],
  ['session.disconnect', 'Putuskan', 'disconnect', 'Putuskan'],
  ['session.closeTab', 'Tutup tab', 'close-tab', 'Tutup Tab'],
  ['view.fullscreen', 'Layar penuh', 'fullscreen', 'Layar Penuh'],
  ]);
});
