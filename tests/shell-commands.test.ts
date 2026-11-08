import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMANDS, COMMAND_IDS, EMPTY_REPORT, MAX_TABS, THEME_CHOICES, describeKeys, isCommand, keysFor, makeReport, parseReport, platformFrom, sameReport, spec, type CommandId, type Platform } from '../src/desktop/commands.js';

const PLATFORMS: Platform[] = ['darwin', 'win32', 'linux'];
const page = async () => readFile(fileURLToPath(new URL('../../src/desktop/index.html', import.meta.url)), 'utf8');

test('every command is listed once, with words, an owner and, when it has keys, keys in the syntax the menu reads', () => {
  assert.deepEqual(COMMAND_IDS, COMMANDS.map((c) => c.id));
  assert.equal(new Set(COMMAND_IDS).size, COMMAND_IDS.length, 'one entry per command');
  const KEYS = /^(?:(?:Cmd|Ctrl|Alt|Shift)\+)+(?:[A-Z0-9]|Return|Tab)$|^F(?:[1-9]|1[0-2])$/;
  const SETTINGS_KEYS = /^(?:Cmd|Ctrl)\+,$/;      // 02-B3b: the comma is the key of the system for the settings and of no other command
  for (const c of COMMANDS) {
    assert.ok(c.label.trim() === c.label && c.label.length > 0 && !c.label.includes('&'), `${c.id}: words, without a mnemonic mark`);
    assert.ok(c.owner === 'window' || c.owner === 'main', `${c.id}: an owner`);
    for (const key of [c.keys?.mac, c.keys?.other]) if (key !== undefined) assert.match(key, c.id === 'app.settings' ? SETTINGS_KEYS : KEYS, `${c.id}: ${key}`);
    if (c.keys?.mac !== undefined) assert.match(c.keys.mac, /^F|Cmd|Ctrl/, `${c.id}: a macOS key has a modifier`);
    if (c.keys?.other !== undefined) assert.doesNotMatch(c.keys.other, /Cmd/, `${c.id}: the other platforms have no Cmd`);
    if (c.short !== undefined) assert.ok(c.short.length > 0 && c.short.length <= 16 && c.icon !== undefined, `${c.id}: a toolbar button has short words and an icon`);
    if (c.short === undefined) assert.equal(c.icon, undefined, `${c.id}: an icon without a button`);
  }
  assert.ok(COMMANDS.filter((c) => c.short !== undefined).length >= 12, 'the toolbar can offer a dozen commands or more');
});

test('no two commands share a key on one platform, and no key belongs to something the window must leave alone', () => {
  // Page reload and the developer tools are not offered at all; Backspace with a modifier and the editing keys belong to the box that has the focus; Alt+F4 and Cmd+H, Cmd+M, Cmd+Q are the system's.
  const LEFT_ALONE = ['Cmd+R', 'Ctrl+R', 'Alt+Cmd+I', 'Ctrl+Shift+I', 'F12', 'Cmd+Backspace', 'Ctrl+Backspace', 'Cmd+Z', 'Shift+Cmd+Z', 'Ctrl+Z', 'Ctrl+Y', 'Cmd+X', 'Cmd+C', 'Cmd+V', 'Cmd+A', 'Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'Ctrl+A', 'Cmd+H', 'Alt+Cmd+H', 'Cmd+M', 'Alt+F4'];
  for (const platform of PLATFORMS) {
    const seen = new Map<string, CommandId>();
    for (const c of COMMANDS) {
      const key = keysFor(c, platform);
      if (key === undefined) continue;
      assert.equal(seen.get(key), undefined, `${platform}: ${key} is ${seen.get(key)} and ${c.id}`);
      seen.set(key, c.id);
      assert.ok(!LEFT_ALONE.includes(key), `${platform}: ${c.id} would take ${key}`);
    }
    assert.ok(seen.size >= 20, `${platform}: the commands that matter most have keys`);
  }
});

test('a key is chosen by platform: Cmd on macOS, Ctrl elsewhere, and the same command keeps the same letter', () => {
  const save = spec('doc.save');
  assert.equal(keysFor(save, 'darwin'), 'Cmd+S');
  assert.equal(keysFor(save, 'win32'), 'Ctrl+S');
  assert.equal(keysFor(save, 'linux'), 'Ctrl+S');
  assert.equal(keysFor(spec('view.fullscreen'), 'darwin'), 'Ctrl+Cmd+F');
  assert.equal(keysFor(spec('view.fullscreen'), 'win32'), 'F11');
  assert.equal(keysFor(spec('doc.reload'), 'darwin'), undefined, 'reloading a document from its file has no key: it throws work away');
  assert.equal(keysFor(spec('obj.remove'), 'darwin'), undefined, 'Hapus has no key of its own: Delete in the tree does it, and Cmd+Backspace belongs to the box with the focus');
  // Two commands have another letter elsewhere on purpose: Ctrl+Alt+letter is what AltGr sends on Windows (a letter typed with AltGr would run the command), and Ctrl+Alt+T is the terminal of Ubuntu.
  const OTHER_LETTER = ['view.toolbar', 'obj.addConnection'];
  for (const c of COMMANDS) {
    const mac = c.keys?.mac, other = c.keys?.other;
    if (mac !== undefined && other !== undefined && !/^F\d/.test(mac) && !/^F\d/.test(other) && !OTHER_LETTER.includes(c.id)) assert.equal(mac.split('+').at(-1), other.split('+').at(-1), `${c.id}: the same letter on both`);
  }
  assert.equal(keysFor(spec('view.toolbar'), 'win32'), 'Ctrl+Shift+B');
  assert.equal(keysFor(spec('obj.addConnection'), 'linux'), 'Ctrl+Shift+C');
  assert.equal(keysFor(spec('view.toolbar'), 'darwin'), 'Alt+Cmd+T');
  assert.equal(keysFor(spec('obj.addConnection'), 'darwin'), 'Alt+Cmd+N');
});

test('no key of Windows or Linux asks for Ctrl and Alt together with a letter, which is what AltGr sends: only the key that gives the keyboard back does, and only while a session holds the keyboard', () => {
  for (const c of COMMANDS) {
    const key = c.keys?.other;
    if (key === undefined || c.id === 'session.release') continue;
    assert.doesNotMatch(key, /(?=.*Ctrl)(?=.*Alt)/, `${c.id}: ${key}`);
  }
  assert.equal(keysFor(spec('session.release'), 'win32'), 'Ctrl+Alt+Shift+K');
});

test('the keys that the tree handles itself when it has the focus are not keys of the menu: a note that is being typed is never duplicated or made a favourite by a key', () => {
  for (const id of ['obj.duplicate', 'obj.favorite', 'obj.remove'] as const) for (const platform of ['darwin', 'win32'] as const) assert.equal(keysFor(spec(id), platform), undefined, `${platform} ${id}`);
  // Review of the execution: Cmd+Return would connect the selected object from the box of a quick connection too (a menu key works from every box of the page), so connecting has Enter in the tree and the buttons
  for (const platform of ['darwin', 'win32'] as const) assert.equal(keysFor(spec('obj.connect'), platform), undefined, `${platform} connecting has no key of the menu`);
});

test('the platform of the process is told as the shell knows it: Windows and Linux are themselves and anything else is macOS', () => {
  assert.equal(platformFrom('win32'), 'win32');
  assert.equal(platformFrom('linux'), 'linux');
  assert.equal(platformFrom('darwin'), 'darwin');
  for (const other of ['freebsd', '', undefined, null, 42, 'Win32']) assert.equal(platformFrom(other), 'darwin', String(other));
});

test('keys are told to a person in the way of the platform: symbols on macOS, words elsewhere', () => {
  assert.equal(describeKeys('Cmd+N', 'darwin'), '⌘N');
  assert.equal(describeKeys('Shift+Cmd+W', 'darwin'), '⇧⌘W');
  assert.equal(describeKeys('Alt+Cmd+T', 'darwin'), '⌥⌘T');
  assert.equal(describeKeys('Ctrl+Cmd+F', 'darwin'), '⌃⌘F');
  assert.equal(describeKeys('Cmd+Shift+Alt+Ctrl+K', 'darwin'), '⌃⌥⇧⌘K', 'the symbols come in the order of the system: Control, Option, Shift, Command, whatever the order they were written in');
  assert.equal(describeKeys('Cmd+Return', 'darwin'), '⌘↩');
  assert.equal(describeKeys('Ctrl+Shift+Tab', 'darwin'), '⌃⇧⇥');
  assert.equal(describeKeys('Cmd+1', 'darwin'), '⌘1');
  assert.equal(describeKeys('Ctrl+Shift+W', 'win32'), 'Ctrl+Shift+W');
  assert.equal(describeKeys('Shift+Alt+Ctrl+K', 'linux'), 'Ctrl+Alt+Shift+K', 'and the words in the order Ctrl, Alt, Shift');
  assert.equal(describeKeys('Ctrl+Return', 'linux'), 'Ctrl+Enter');
  assert.equal(describeKeys('F11', 'win32'), 'F11');
  assert.equal(describeKeys('F11', 'darwin'), 'F11');
});

test('the commands that act on the documents and the sessions have the control of the page that does the same, and the page has it', async () => {
  const html = await page();
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const buttons = COMMANDS.filter((c) => c.button !== undefined);
  assert.ok(buttons.length >= 18, 'the buttons of the documents, the objects, the tree and the session');
  for (const c of buttons) assert.ok(ids.has(c.button!), `${c.id}: #${c.button} is on the page`);
  const controls = new Set([...html.matchAll(/<(?:button|select)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const c of buttons) assert.ok(controls.has(c.button!), `${c.id}: #${c.button} is a button or a choice, not some other element`);
  const mapped = new Map(buttons.map((c) => [c.id, c.button]));
  // which control does what, written out (review of the execution: the list of commands was the only place that said it, so two controls swapped in it were swapped in the menu, the toolbar and the scenarios alike)
  assert.deepEqual(Object.fromEntries(mapped), {
    'doc.new': 'doc-new', 'doc.password':'doc-password-open','doc.properties': 'doc-properties-open', 'doc.vault': 'credentials-open', 'obj.templates': 'templates-open', 'doc.open': 'doc-open', 'doc.save': 'doc-save', 'doc.close': 'doc-close', 'doc.reload': 'doc-reload', 'doc.conflicts': 'doc-conflicts', 'doc.history': 'doc-history',
    'doc.autosave.off': 'doc-autosave', 'doc.autosave.close': 'doc-autosave', 'doc.autosave.edit': 'doc-autosave',
    'obj.connect': 'obj-connect', 'obj.addFolder': 'obj-add-folder', 'obj.addConnection': 'obj-add-connection', 'obj.edit': 'obj-edit', 'obj.duplicate': 'obj-duplicate', 'obj.transfer':'obj-transfer', 'obj.bulk':'obj-bulk', 'obj.favorite': 'obj-favorite', 'obj.remove': 'obj-remove',
    'tree.expandAll': 'tree-expand', 'tree.collapseAll': 'tree-collapse', 'session.reconnect': 'reconnect', 'session.disconnect': 'disconnect', 'session.closeTab': 'close-tab',
  });
  // and the control says in its own words what the command says (the page's words begin with the short words of the command)
  for (const c of buttons) {
    if (c.short === undefined) continue;
    const found = html.match(new RegExp(`<button\\b[^>]*\\bid="${c.button}"[^>]*>([^<]*)`));
    assert.ok(found && found[1]!.replace('…', '').trim().toLowerCase().startsWith(c.short.toLowerCase()), `${c.id}: #${c.button} says "${found?.[1] ?? ''}"`);
  }
  const owned = new Set(buttons.map((c) => c.button));
  assert.equal(owned.size, buttons.length - 2, 'one control per command, except the three ways of saving by themselves that share one choice');
  for (const c of COMMANDS) if (c.owner === 'main') assert.equal(c.button, undefined, `${c.id}: the main process owns it, no control of the page`);
});

test('the commands that only the window can do and the ones that only the main process can do are told apart', () => {
  const main = COMMANDS.filter((c) => c.owner === 'main').map((c) => c.id);
  assert.deepEqual(main, ['doc.recent.clear', 'view.toolbar', 'view.colorizeTabs', 'view.theme.system', 'view.theme.light', 'view.theme.dark', 'view.fullscreen', 'view.extendedFullscreen', 'app.settings', 'app.about', 'app.quit']);      // 02-B3b adds four
  assert.deepEqual(THEME_CHOICES, ['system', 'light', 'dark']);
  for (const choice of THEME_CHOICES) assert.equal(spec(`view.theme.${choice}`).owner, 'main');
  assert.equal(spec('tab.last').owner, 'window');
  assert.equal(spec('session.release').owner, 'window');
});

test('the nine ways to choose a tab, and the last one, are there', () => {
  for (let n = 1; n <= 9; n++) {
    assert.equal(spec(`tab.${n}` as CommandId).label, `Tab ${n}`);
    assert.equal(keysFor(spec(`tab.${n}` as CommandId), 'darwin'), `Cmd+${n}`);
    assert.equal(keysFor(spec(`tab.${n}` as CommandId), 'win32'), `Ctrl+${n}`);
  }
  assert.equal(spec('tab.last').label, 'Tab Terakhir');
  assert.equal(keysFor(spec('tab.next'), 'darwin'), 'Ctrl+Tab');
  assert.equal(keysFor(spec('tab.previous'), 'win32'), 'Ctrl+Shift+Tab');
});

test('what the main process is told is a command it knows, and nothing that happens to be a property of an object', () => {
  for (const id of COMMAND_IDS) assert.equal(isCommand(id), true, id);
  for (const wrong of ['', 'doc', 'doc.save ', 'DOC.SAVE', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'tab.10', 'tab.0', 1, null, undefined, {}, ['doc.save']]) assert.equal(isCommand(wrong), false, String(wrong));
  assert.throws(() => spec('constructor' as CommandId), /unknown command/);
});

const VALID = { enabled: ['doc.new', 'doc.open'], checked: ['obj.favorite'], capture: false, dialog: false, tabs: 2, tab: 1 };

test('a report from the window is taken in only when every part of it is what it should be', () => {
  assert.deepEqual(parseReport(VALID), VALID);
  assert.deepEqual(parseReport({ ...VALID, enabled: [], checked: [], tabs: 0, tab: -1 }), { ...VALID, enabled: [], checked: [], tabs: 0, tab: -1 });
  const bad: unknown[] = [
    undefined, null, 'doc.new', 7, [], [VALID],
    { ...VALID, enabled: 'doc.new' }, { ...VALID, enabled: ['doc.nope'] }, { ...VALID, enabled: ['doc.new', 'doc.new'] }, { ...VALID, enabled: ['constructor'] }, { ...VALID, enabled: [1] },
    { ...VALID, checked: ['doc.nope'] }, { ...VALID, checked: ['doc.new', 'doc.new'] }, { ...VALID, checked: null },
    { ...VALID, capture: 1 }, { ...VALID, capture: 'true' }, { ...VALID, dialog: undefined },
    { ...VALID, tabs: -1 }, { ...VALID, tabs: 1.5 }, { ...VALID, tabs: MAX_TABS + 1 }, { ...VALID, tabs: '2' },
    { ...VALID, tab: 2 }, { ...VALID, tab: -2 }, { ...VALID, tab: 0.5 }, { ...VALID, tabs: 0, tab: 0 },
    { ...VALID, extra: true }, { enabled: [], checked: [], capture: false, dialog: false, tabs: 0 }, { enabled: [], checked: [], capture: false, dialog: false, tabs: 0, extra: -1 },
    Object.assign([], { enabled: [], checked: [], capture: false, dialog: false, tabs: 0, tab: -1 }),
    Object.assign(Object.create({ tab: -1 }), { enabled: [], checked: [], capture: false, dialog: false, tabs: 0, extra: 1 }),
    Object.assign(Object.create({ capture: true }), { enabled: [], checked: [], dialog: false, tabs: 0, tab: -1 }),
  ];
  for (const value of bad) assert.equal(parseReport(value), undefined, JSON.stringify(value));
  assert.equal(parseReport({ ...VALID, tabs: MAX_TABS, tab: MAX_TABS - 1 })?.tabs, MAX_TABS);
  assert.equal(MAX_TABS, 1000, 'the limit is written once, here');
  assert.equal(parseReport({ ...VALID, tabs: 1000, tab: 999 })?.tabs, 1000);
  assert.equal(parseReport({ ...VALID, tabs: 1001, tab: 0 }), undefined);
  assert.deepEqual(parseReport(EMPTY_REPORT), EMPTY_REPORT, 'the report of a window with nothing in it is a report');
  assert.deepEqual(parseReport({ ...VALID, enabled: ['doc.save', 'doc.new'], checked: ['obj.favorite', 'doc.autosave.off'] })?.enabled, ['doc.new', 'doc.save'], 'what is told in another order is kept in the order of the list of commands');
  assert.deepEqual(parseReport({ ...VALID, checked: ['obj.favorite', 'doc.autosave.off'] })?.checked, ['doc.autosave.off', 'obj.favorite']);
  assert.equal(parseReport({ ...VALID, enabled: [...COMMAND_IDS], checked: [...COMMAND_IDS] })?.enabled.length, COMMAND_IDS.length);
});

test('a report is made the same way whatever the order it was gathered in, so that two equal ones are told apart from two different ones by comparing them', () => {
  const a = makeReport({ enabled: new Set<CommandId>(['doc.open', 'doc.new']), checked: new Set<CommandId>(), capture: false, dialog: false, tabs: 0, tab: -1 });
  const b = makeReport({ enabled: new Set<CommandId>(['doc.new', 'doc.open']), checked: new Set<CommandId>(), capture: false, dialog: false, tabs: 0, tab: -1 });
  assert.deepEqual(a.enabled, ['doc.new', 'doc.open'], 'in the order of the list of commands');
  assert.equal(sameReport(a, b), true);
  assert.equal(sameReport(a, makeReport({ enabled: new Set<CommandId>(['doc.new']), checked: new Set<CommandId>(), capture: false, dialog: false, tabs: 0, tab: -1 })), false);
  const tabsOnly = makeReport({ enabled: new Set<CommandId>(), checked: new Set<CommandId>(), capture: false, dialog: false, tabs: 3, tab: 0 });
  assert.equal(sameReport(tabsOnly, { ...tabsOnly, tabs: 4 }), false, 'the number of tabs alone');
  assert.equal(sameReport(tabsOnly, { ...tabsOnly, tab: 1 }), false, 'the tab in front alone');
  assert.equal(sameReport(a, { ...a, checked: ['obj.favorite'] }), false, 'what is chosen alone');
  const only = (id: CommandId) => makeReport({ enabled: new Set<CommandId>([id]), checked: new Set<CommandId>(), capture: false, dialog: false, tabs: 0, tab: -1 });
  assert.equal(sameReport(only('doc.new'), only('doc.open')), false, 'another command on, though as many are on');
  assert.deepEqual(makeReport({ enabled: new Set<CommandId>(), checked: new Set<CommandId>(['obj.favorite', 'doc.autosave.close']), capture: false, dialog: false, tabs: 0, tab: -1 }).checked, ['doc.autosave.close', 'obj.favorite'], 'what is chosen is listed in the order of the list of commands too');
  assert.deepEqual(EMPTY_REPORT, { enabled: [], checked: [], capture: false, dialog: false, tabs: 0, tab: -1 });
  for (const change of [{ capture: true }, { dialog: true }, { tabs: 1, tab: 0 }, { checked: new Set<CommandId>(['obj.favorite']) }]) {
    assert.equal(sameReport(a, makeReport({ enabled: new Set<CommandId>(['doc.new', 'doc.open']), checked: new Set<CommandId>(), capture: false, dialog: false, tabs: 0, tab: -1, ...change })), false, JSON.stringify([...Object.keys(change)]));
  }
  assert.deepEqual(parseReport(a), a, 'what is made is what is accepted');
});
