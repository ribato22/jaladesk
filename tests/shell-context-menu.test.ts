import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_IDS, EMPTY_REPORT, type CommandId, type Platform, type Report } from '../src/desktop/commands.js';
import { CONTEXT_KINDS, MAX_POINT, contextMenu, editMenu, parseContextRequest, toPoint, type ContextKind, type EditParams } from '../src/desktop/context-menu.js';
import { buildMenu, findCommand, type Entry, type Flags } from '../src/desktop/menu-model.js';

const FLAGS: Flags = { theme: 'system', toolbar: true, fullscreen: false, prompt: false };
const NAME = 'Remote Workspace';
const input = (platform: Platform, report: Partial<Report> = {}, flags: Partial<Flags> = {}) => ({ platform, appName: NAME, report: { ...EMPTY_REPORT, ...report }, flags: { ...FLAGS, ...flags } });
const ids = (entries: readonly Entry[]) => entries.map((e) => (e.kind === 'command' ? e.id : e.kind === 'separator' ? '-' : e.kind === 'role' ? `<${e.role}>` : e.kind === 'plain' ? `(${e.label})` : `${e.label}>`));
const ON: CommandId[] = COMMAND_IDS.filter((id) => !id.startsWith('tab.') && id !== 'session.release' && !id.startsWith('doc.recent.'));

test('the menu of the tree is what can be done with what is selected, in the order of the menu of the objects, and what cannot be done now is not in it', () => {
  // a connection is selected in a document: the buttons of the window that apply are on
  const connection = contextMenu('tree', input('darwin', { enabled: ['doc.save', 'doc.close', 'doc.forgetKey', 'obj.connect', 'obj.edit', 'obj.duplicate', 'obj.favorite', 'obj.remove', 'tree.expandAll', 'tree.collapseAll', 'obj.addFolder', 'obj.addConnection'] }, { keys: 1 }));
  assert.deepEqual(ids(connection), ['obj.connect', '-', 'obj.addFolder', 'obj.addConnection', '-', 'obj.edit', 'obj.duplicate', 'obj.favorite', 'obj.remove', '-', 'doc.save', 'doc.forgetKey', 'doc.close', '-', 'tree.expandAll', 'tree.collapseAll']);
  // a document row: connecting, properties, duplicating and removing are off
  const document = contextMenu('tree', input('darwin', { enabled: ['doc.save', 'doc.reload', 'doc.conflicts', 'doc.history', 'doc.close', 'obj.addFolder', 'obj.addConnection', 'tree.expandAll', 'tree.collapseAll'] }, { keys: 1 }));
  assert.deepEqual(ids(document), ['obj.addFolder', 'obj.addConnection', '-', 'doc.save', 'doc.reload', 'doc.conflicts', 'doc.history', 'doc.forgetKey', 'doc.close', '-', 'tree.expandAll', 'tree.collapseAll']);
  // no key is remembered anywhere: there is nothing to forget, so the item is not offered
  assert.ok(!ids(contextMenu('tree', input('darwin', { enabled: ['doc.save', 'doc.close'] }))).includes('doc.forgetKey'));
  // nothing is selected and nothing is open
  assert.deepEqual(ids(contextMenu('tree', input('darwin'))), [], 'no menu when there is nothing to offer');
});

test('the items of a menu of the tree are the items of the menu of the application, word for word and key for key, with the same state', () => {
  const report = { enabled: ['obj.connect', 'obj.favorite', 'obj.edit', 'doc.save'] as CommandId[], checked: ['obj.favorite'] as CommandId[] };
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const full = buildMenu(input(platform, report));
    for (const entry of contextMenu('tree', input(platform, report))) {
      if (entry.kind !== 'command') continue;
      assert.deepEqual(entry, findCommand(full, entry.id), `${platform} ${entry.id}`);
    }
  }
  const favorite = findCommand(contextMenu('tree', input('darwin', report)), 'obj.favorite')!;
  assert.deepEqual([favorite.control, favorite.checked], ['checkbox', true]);
});

test('no line stands at the top or at the bottom of a menu or twice in a row, whatever is on', () => {
  let seed = 5;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const sizes = new Set<number>();
  for (let n = 0; n < 400; n++) {
    const report = { enabled: ON.filter(() => random() < 0.5), checked: [], capture: random() < 0.2, dialog: random() < 0.2, tabs: Math.floor(random() * 5), tab: -1 } as Report;
    const tab = report.tabs === 0 ? -1 : Math.floor(random() * report.tabs);
    for (const kind of CONTEXT_KINDS) {
      const entries = contextMenu(kind, input('darwin', { ...report, tab }, { prompt: random() < 0.1 }));
      sizes.add(entries.length);
      if (entries.length === 0) continue;
      assert.notEqual(entries[0]!.kind, 'separator', `${kind} top`);
      assert.notEqual(entries.at(-1)!.kind, 'separator', `${kind} bottom`);
      entries.forEach((e, i) => { if (e.kind === 'separator') assert.notEqual(entries[i - 1]!.kind, 'separator', `${kind} twice`); else assert.equal(e.kind, 'command'); });
      for (const e of entries) if (e.kind === 'command') assert.equal(e.enabled, true, `${kind} ${e.id}: what is off is left out, not shown off`);
    }
  }
  assert.ok(sizes.size > 5, 'the data varies');
});

test('the menu of a tab: reconnecting or disconnecting the session, moving the tab, closing it; the ones that cannot be done are not in it', () => {
  const live = contextMenu('tab', input('darwin', { enabled: ['session.disconnect'], tabs: 3, tab: 1 }));
  assert.deepEqual(ids(live), ['session.disconnect', '-', 'tab.moveLeft', 'tab.moveRight']);
  const done = contextMenu('tab', input('darwin', { enabled: ['session.reconnect', 'session.closeTab'], tabs: 3, tab: 0 }));
  assert.deepEqual(ids(done), ['session.reconnect', '-', 'tab.moveRight', '-', 'session.closeTab']);
  const lone = contextMenu('tab', input('win32', { enabled: ['session.reconnect', 'session.closeTab'], tabs: 1, tab: 0 }));
  assert.deepEqual(ids(lone), ['session.reconnect', '-', 'session.closeTab'], 'one tab has nowhere to go');
  assert.deepEqual(ids(contextMenu('tab', input('darwin', { tabs: 0, tab: -1 }))), []);
});

test('the menu of the toolbar: hiding it and changing what is on it; it says Tampilkan when the toolbar is hidden', () => {
  assert.deepEqual(contextMenu('toolbar', input('darwin')).map((e) => e.kind === 'command' ? [e.id, e.label] : '-'), [['view.toolbar', 'Sembunyikan Toolbar'], ['view.customizeToolbar', 'Sesuaikan Toolbar…']]);
  assert.equal((contextMenu('toolbar', input('darwin', {}, { toolbar: false }))[0] as { label: string }).label, 'Tampilkan Toolbar');
  assert.deepEqual(ids(contextMenu('toolbar', input('darwin', { dialog: true }))), ['view.toolbar'], 'a dialog of the window is open: the dialog of the toolbar is not');
  assert.deepEqual(ids(contextMenu('toolbar', input('darwin', {}, { prompt: true }))), [], 'a prompt of the main process is in front');
});

test('a session that holds the keyboard has no keys in a menu of the tree either', () => {
  const held = contextMenu('tree', input('darwin', { capture: true, enabled: ['doc.save', 'obj.edit'] }));
  for (const e of held) if (e.kind === 'command') assert.equal(e.accelerator, undefined, e.id);
  assert.ok(held.length > 0);
});

test('a box that can be typed in gets the editing menu, with what cannot be done now shown off, and anything else gets only Salin where text is selected', () => {
  const flags = (over: Partial<EditParams['editFlags']> = {}): EditParams['editFlags'] => ({ canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true, ...over });
  assert.deepEqual(ids(editMenu({ isEditable: true, selectionText: '', editFlags: flags() })), ['(Urungkan)', '(Ulangi)', '-', '(Potong)', '(Salin)', '<paste>', '-', '<selectAll>']);
  assert.deepEqual(ids(editMenu({ isEditable: true, selectionText: 'abc', editFlags: flags({ canUndo: true, canRedo: true, canCut: true, canCopy: true }) })), ['<undo>', '<redo>', '-', '<cut>', '<copy>', '<paste>', '-', '<selectAll>']);
  assert.deepEqual(ids(editMenu({ isEditable: true, selectionText: '', editFlags: flags({ canPaste: false, canSelectAll: false }) })), ['(Urungkan)', '(Ulangi)', '-', '(Potong)', '(Salin)', '(Tempel)', '-', '(Pilih Semua)']);
  assert.deepEqual(ids(editMenu({ isEditable: false, selectionText: 'teks', editFlags: flags({ canCopy: true }) })), ['<copy>']);
  assert.deepEqual(ids(editMenu({ isEditable: false, selectionText: '   ', editFlags: flags({ canCopy: true }) })), [], 'blanks are not worth a menu');
  assert.deepEqual(ids(editMenu({ isEditable: false, selectionText: 'teks', editFlags: flags({ canCopy: false }) })), [], 'text that cannot be copied has no Salin');
  assert.deepEqual(ids(editMenu({ isEditable: false, selectionText: '', editFlags: flags() })), []);
  const words = editMenu({ isEditable: true, selectionText: '', editFlags: flags() }).flatMap((e) => (e.kind === 'plain' || e.kind === 'role' ? [e.label] : []));
  assert.deepEqual(words, ['Urungkan', 'Ulangi', 'Potong', 'Salin', 'Tempel', 'Pilih Semua'], 'the words of Sunting');
});

test('what the window asks for is a kind of menu and a place, and nothing else; a place is whole pixels in the window', () => {
  assert.deepEqual(parseContextRequest({ kind: 'tree', x: 10, y: 20 }), { kind: 'tree', x: 10, y: 20 });
  assert.deepEqual(parseContextRequest({ kind: 'tab', x: 0, y: 0 }), { kind: 'tab', x: 0, y: 0 });
  assert.deepEqual(parseContextRequest({ kind: 'toolbar', x: 20000, y: 20000 }), { kind: 'toolbar', x: 20000, y: 20000 });
  assert.equal(MAX_POINT, 20000, 'the limit is written once, here');
  assert.equal(parseContextRequest({ kind: 'toolbar', x: 20001, y: 0 }), undefined);
  assert.equal(parseContextRequest({ kind: 'toolbar', x: 0, y: 20001 }), undefined);
  const bad: unknown[] = [undefined, null, 'tree', 7, [], { kind: 'tree' }, { x: 1, y: 1 }, { kind: 'edit', x: 1, y: 1 }, { kind: 'constructor', x: 1, y: 1 }, { kind: 'tree', x: -1, y: 1 }, { kind: 'tree', x: 1, y: -1 }, { kind: 'tree', x: 1.5, y: 1 },
    { kind: 'tree', x: MAX_POINT + 1, y: 1 }, { kind: 'tree', x: '1', y: 1 }, { kind: 'tree', x: Number.NaN, y: 1 }, { kind: 'tree', x: Number.POSITIVE_INFINITY, y: 1 }, { kind: 'tree', x: 1, y: 1, items: ['app.quit'] },
    { kind: 'tree', x: 1, y: 1, extra: true }, Object.assign(Object.create({ kind: 'tree' }), { x: 1, y: 1, z: 1 }), Object.assign([], { kind: 'tree', x: 1, y: 1 })];
  for (const value of bad) assert.equal(parseContextRequest(value), undefined, JSON.stringify(value));
  const kinds: ContextKind[] = ['tree', 'tab', 'toolbar'];
  assert.deepEqual([...CONTEXT_KINDS], kinds);
});

test('the place the window sends is made fit for the main process: whole numbers from 0 up to the largest place it accepts, and a number that is not one is the corner', () => {
  assert.deepEqual(toPoint(10.4, 20.6), { x: 10, y: 21 });
  assert.deepEqual(toPoint(-3.2, -0.4), { x: 0, y: 0 }, 'a tab that is scrolled partly out of the window has its left edge before 0');
  assert.deepEqual(toPoint(MAX_POINT + 5, MAX_POINT * 3), { x: MAX_POINT, y: MAX_POINT });
  assert.deepEqual(toPoint(Number.NaN, Number.POSITIVE_INFINITY), { x: 0, y: 0 });
  assert.deepEqual(toPoint(Number.NEGATIVE_INFINITY, 7), { x: 0, y: 7 });
  for (const [x, y] of [[-9, 4], [4, -9], [MAX_POINT + 1, 0], [0, 0.5], [1e9, 1e9]] as const) {
    const point = toPoint(x, y);
    assert.notEqual(parseContextRequest({ kind: 'tab', ...point }), undefined, `what the window sends is what the main process accepts: ${x}, ${y}`);
  }
});

// What the review after the execution (23 October 2026) found: every flag was set to the same value as the one next to it, so an item shown from the wrong flag was never seen.

test('each item of the editing menu follows its own flag: three states in which no two flags have the same pattern', () => {
  const states = [
    { canUndo: true, canRedo: false, canCut: false, canCopy: true, canPaste: true, canSelectAll: false },
    { canUndo: false, canRedo: true, canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
    { canUndo: false, canRedo: false, canCut: true, canCopy: false, canPaste: true, canSelectAll: true },
  ];
  for (const f of states) {
    const want = [f.canUndo ? '<undo>' : '(Urungkan)', f.canRedo ? '<redo>' : '(Ulangi)', '-', f.canCut ? '<cut>' : '(Potong)', f.canCopy ? '<copy>' : '(Salin)', f.canPaste ? '<paste>' : '(Tempel)', '-', f.canSelectAll ? '<selectAll>' : '(Pilih Semua)'];
    assert.deepEqual(ids(editMenu({ isEditable: true, selectionText: '', editFlags: f })), want, JSON.stringify(f));
  }
});
