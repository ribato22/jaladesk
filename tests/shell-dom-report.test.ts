import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS, MAX_TABS, parseReport, type CommandId } from '../src/desktop/commands.js';
import { readReport, stepTab, type Reader } from '../src/desktop/dom-report.js';

/** A page as the report sees it: which controls are there and can be used, which toggle is pressed, what the choice of saving by itself holds, the tabs, the session and the focus. */
function page(parts: { usable?: string[]; missing?: string[]; pressed?: string[]; value?: Record<string, string>; tabs?: { count: number; active: number }; session?: string; screen?: boolean; dialog?: boolean } = {}): Reader {
  const usable = new Set(parts.usable ?? []);
  return {
    enabled: (id) => (usable.has(id) ? true : (parts.missing ?? []).includes(id) ? undefined : false),
    pressed: (id) => (parts.pressed ?? []).includes(id),
    value: (id) => parts.value?.[id],
    tabs: () => parts.tabs ?? { count: 0, active: -1 },
    session: () => parts.session ?? 'none',
    focusOnScreen: () => parts.screen ?? false,
    dialogOpen: () => parts.dialog ?? false,
  };
}
const buttons = COMMANDS.filter((c) => c.button !== undefined && !c.id.startsWith('doc.autosave.'));

test('a page with nothing in it says nothing can be done and no session holds the keyboard', () => {
  const report = readReport(page({ missing: COMMANDS.flatMap((c) => (c.button !== undefined ? [c.button] : [])) }));
  assert.deepEqual(report, { enabled: [], checked: [], capture: false, dialog: false, tabs: 0, tab: -1 });
});

test('a command can be done when the control of the page that does it can be used, and not when it cannot or is not there', () => {
  const report = readReport(page({ usable: ['doc-save', 'obj-connect', 'close-tab'], missing: ['tree-expand'] }));
  assert.deepEqual(report.enabled, ['doc.save', 'obj.connect', 'session.closeTab']);
  assert.deepEqual(readReport(page()).enabled, [], 'every control is there and none can be used');
  const all = readReport(page({ usable: buttons.map((c) => c.button!) }));
  assert.deepEqual(all.enabled, buttons.map((c) => c.id), 'in the order of the list of commands');
  for (const c of buttons) assert.deepEqual(readReport(page({ usable: [c.button!] })).enabled, [c.id], c.id);
});

test('the way of saving by itself is three commands that are on together when its choice can be made, and the one that is chosen is checked', () => {
  const on = (value: string) => readReport(page({ usable: ['doc-autosave'], value: { 'doc-autosave': value } }));
  assert.deepEqual(on('edit').enabled, ['doc.autosave.off', 'doc.autosave.close', 'doc.autosave.edit']);
  assert.deepEqual(on('edit').checked, ['doc.autosave.edit']);
  assert.deepEqual(on('off').checked, ['doc.autosave.off']);
  assert.deepEqual(on('close').checked, ['doc.autosave.close']);
  assert.deepEqual(on('unknown').checked, [], 'a value that is none of the three checks none');
  assert.deepEqual(on('').checked, []);
  const off = readReport(page({ value: { 'doc-autosave': 'edit' } }));
  assert.deepEqual([off.enabled, off.checked], [[], []], 'a choice that cannot be made shows none, so that nothing that may be wrong is shown');
  assert.deepEqual(readReport(page({ usable: ['doc-autosave'] })).checked, [], 'no value at all');
});

test('the favourite is checked when its button is pressed', () => {
  assert.deepEqual(readReport(page({ usable: ['obj-favorite'], pressed: ['obj-favorite'] })).checked, ['obj.favorite']);
  assert.deepEqual(readReport(page({ usable: ['obj-favorite'] })).checked, []);
  assert.deepEqual(readReport(page({ pressed: ['obj-favorite'] })).checked, ['obj.favorite'], 'pressed says what the star shows, whether or not it can be pressed');
});

test('a connected session that has the focus holds the keyboard, and nothing else does', () => {
  const held = (session: string, screen: boolean) => readReport(page({ session, screen })).capture;
  assert.equal(held('connected', true), true);
  assert.equal(held('connected', false), false, 'the focus is elsewhere');
  assert.equal(held('connecting', true), false, 'a session that is still connecting takes no key');
  assert.equal(held('closed', true), false);
  assert.equal(held('failed', true), false);
  assert.equal(held('none', true), false);
  assert.equal(held('', true), false);
});

test('a dialog that is open and the tabs are told as they are', () => {
  assert.equal(readReport(page({ dialog: true })).dialog, true);
  assert.equal(readReport(page({ dialog: false })).dialog, false);
  const tabs = readReport(page({ tabs: { count: 3, active: 1 } }));
  assert.deepEqual([tabs.tabs, tabs.tab], [3, 1]);
  assert.deepEqual([readReport(page({ tabs: { count: 3, active: -1 } })).tabs, readReport(page({ tabs: { count: 3, active: -1 } })).tab], [3, -1]);
});

test('a number of tabs that does not make sense is made to: never more than a report accepts, never a tab that is not there', () => {
  assert.deepEqual(readReport(page({ tabs: { count: 3, active: 3 } })).tab, -1);
  assert.deepEqual(readReport(page({ tabs: { count: 0, active: 0 } })), { enabled: [], checked: [], capture: false, dialog: false, tabs: 0, tab: -1 });
  assert.equal(readReport(page({ tabs: { count: MAX_TABS + 50, active: MAX_TABS + 10 } })).tabs, MAX_TABS);
  assert.equal(readReport(page({ tabs: { count: MAX_TABS + 50, active: MAX_TABS + 10 } })).tab, -1);
  assert.equal(readReport(page({ tabs: { count: -3, active: -5 } })).tabs, 0);
  assert.equal(readReport(page({ tabs: { count: 2.5, active: 0.5 } })).tabs, 2);
  assert.equal(readReport(page({ tabs: { count: 2.5, active: 0.5 } })).tab, -1);
  assert.equal(readReport(page({ tabs: { count: Number.NaN, active: Number.NaN } })).tabs, 0);
  assert.equal(readReport(page({ tabs: { count: Number.POSITIVE_INFINITY, active: 0 } })).tabs, 0, 'a number of tabs that is not a number that can be counted');
  assert.equal(readReport(page({ tabs: { count: Number.NEGATIVE_INFINITY, active: 0 } })).tabs, 0);
});

test('whatever the page is like, what is reported is a report that the main process accepts', () => {
  let seed = 7;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const ids = COMMANDS.flatMap((c) => (c.button !== undefined ? [c.button] : []));
  const sessions = ['none', 'connecting', 'connected', 'closed', 'failed', 'x'];
  for (let n = 0; n < 500; n++) {
    const usable = ids.filter(() => random() < 0.5), pressed = ids.filter(() => random() < 0.3);
    const report = readReport(page({ usable, pressed, value: { 'doc-autosave': ['off', 'close', 'edit', 'x'][Math.floor(random() * 4)]! }, session: sessions[Math.floor(random() * sessions.length)]!, screen: random() < 0.5, dialog: random() < 0.3, tabs: { count: Math.floor(random() * 12) - 1, active: Math.floor(random() * 14) - 2 } }));
    assert.deepEqual(parseReport(report), report, JSON.stringify(report));
  }
  const unchecked: CommandId[] = [];
  for (const c of COMMANDS) if (c.owner === 'main') unchecked.push(c.id);
  const all = readReport(page({ usable: ids, pressed: ids, value: { 'doc-autosave': 'edit' } }));
  for (const id of unchecked) assert.ok(!all.enabled.includes(id) && !all.checked.includes(id), `${id} is the main process's, not the page's`);
  for (const id of ['find', 'adhoc.focus', 'tab.next', 'session.release', 'view.customizeToolbar', 'help.shortcuts'] as const) assert.ok(!all.enabled.includes(id), `${id} is decided by the menu model, not reported`);
});

test('only the favourite and the way of saving by itself are ever checked, whatever else is pressed', () => {
  const ids = buttons.map((c) => c.button!);
  assert.deepEqual(readReport(page({ usable: ids, pressed: ids })).checked, ['obj.favorite']);
  assert.deepEqual(readReport(page({ usable: [...ids, 'doc-autosave'], pressed: ids, value: { 'doc-autosave': 'close' } })).checked, ['doc.autosave.close', 'obj.favorite']);
});

test('the tab that Tab Berikutnya and Tab Sebelumnya go to goes around at the ends, and there is nowhere to go with fewer than two tabs', () => {
  assert.deepEqual([0, 1, 2].map((at) => stepTab(at, 3, 1)), [1, 2, 0]);
  assert.deepEqual([0, 1, 2].map((at) => stepTab(at, 3, -1)), [2, 0, 1]);
  assert.deepEqual([stepTab(-1, 3, 1), stepTab(-1, 3, -1)], [1, 2], 'no tab in front counts as the first');
  assert.deepEqual([stepTab(0, 2, 1), stepTab(1, 2, 1), stepTab(0, 2, -1), stepTab(1, 2, -1)], [1, 0, 1, 0]);
  assert.deepEqual([stepTab(0, 1, 1), stepTab(0, 1, -1), stepTab(0, 0, 1), stepTab(-1, 0, -1)], [undefined, undefined, undefined, undefined]);
  let at = 4;
  for (let n = 0; n < 7; n++) at = stepTab(at, 7, 1)!;
  assert.equal(at, 4, 'seven steps forward through seven tabs come back to where they began');
  for (let n = 0; n < 7; n++) at = stepTab(at, 7, -1)!;
  assert.equal(at, 4);
  assert.equal(stepTab(8, 9, 1), 0);
  assert.equal(stepTab(0, 9, -1), 8);
});
