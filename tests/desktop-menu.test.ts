import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_IDS, EMPTY_REPORT, type CommandId, type Platform } from '../src/desktop/commands.js';
import { buildMenu, type Flags } from '../src/desktop/menu-model.js';
import { toTemplate, type TemplateItem } from '../src/desktop/menu.js';

const FLAGS: Flags = { theme: 'system', toolbar: true, fullscreen: false, prompt: false };
const model = (platform: Platform, report = EMPTY_REPORT, flags = FLAGS) => buildMenu({ platform, appName: 'Remote Workspace', report, flags });
function walk(items: readonly TemplateItem[]): TemplateItem[] { return items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])]); }

test('the menu of the model becomes the template that Electron builds a menu from, item for item', () => {
  const clicked: CommandId[] = [];
  const template = toTemplate(model('darwin', { ...EMPTY_REPORT, enabled: ['doc.save', 'obj.favorite'], checked: ['obj.favorite'], tabs: 2, tab: 0 }), (id) => clicked.push(id));
  assert.deepEqual(template.map((t) => t.label), ['Remote Workspace', 'Berkas', 'Sunting', 'Objek', 'Tampilan', 'Jendela', 'Bantuan']);
  const items = walk(template);
  const save = items.find((i) => i.id === 'doc.save')!;
  assert.deepEqual({ label: save.label, accelerator: save.accelerator, enabled: save.enabled, type: save.type }, { label: 'Simpan', accelerator: 'Cmd+S', enabled: true, type: 'normal' });
  const favorite = items.find((i) => i.id === 'obj.favorite')!;
  assert.deepEqual({ type: favorite.type, checked: favorite.checked, enabled: favorite.enabled }, { type: 'checkbox', checked: true, enabled: true });
  const radio = items.find((i) => i.id === 'view.theme.system')!;
  assert.deepEqual({ type: radio.type, checked: radio.checked }, { type: 'radio', checked: true });
  assert.equal(items.find((i) => i.id === 'view.theme.dark')!.checked, false);
  assert.equal(items.find((i) => i.id === 'doc.close')!.enabled, false);
  assert.equal(items.find((i) => i.id === 'doc.close')!.accelerator, 'Shift+Cmd+W');
  assert.equal(items.find((i) => i.id === 'doc.reload')!.accelerator, undefined, 'an item without a key has no key, not an empty one');
  assert.ok(!('accelerator' in items.find((i) => i.id === 'doc.reload')!));
  assert.ok(!('checked' in save), 'a plain item has no checked state');
  save.click!();
  favorite.click!();
  assert.deepEqual(clicked, ['doc.save', 'obj.favorite']);
});

test('the standard items of the system are handed over by role, with the words of the menu, and nothing happens when one is chosen except what the system does', () => {
  const items = walk(toTemplate(model('darwin'), () => assert.fail('a role does not run a command')));
  const roles = items.filter((i) => i.role !== undefined);
  assert.deepEqual(roles.map((i) => i.role), ['services', 'hide', 'hideOthers', 'unhide', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'minimize', 'zoom', 'front']);
  assert.deepEqual(roles.slice(4, 6).map((i) => i.label), ['Urungkan', 'Ulangi']);
  for (const role of roles) assert.ok(role.click === undefined && role.accelerator === undefined && role.submenu === undefined, String(role.role));
});

test('an item that does nothing now has no role and no key, and cannot be chosen', () => {
  const held = walk(toTemplate(model('win32', { ...EMPTY_REPORT, capture: true, tabs: 1, tab: 0 }), () => assert.fail('nothing to run')));
  const edit = held.filter((i) => ['Urungkan', 'Ulangi', 'Potong', 'Salin', 'Tempel', 'Pilih Semua'].includes(i.label ?? ''));
  assert.equal(edit.length, 6);
  for (const item of edit) assert.deepEqual([item.enabled, item.role, item.accelerator, item.click, item.id], [false, undefined, undefined, undefined, undefined], item.label);
});

test('a separator is a separator and a submenu holds its items, to any depth', () => {
  const template = toTemplate(model('win32'), () => undefined);
  const file = template.find((t) => t.label === 'Berkas')!;
  assert.ok(file.submenu!.some((i) => i.type === 'separator'));
  for (const separator of walk(template).filter((i) => i.type === 'separator')) assert.deepEqual(Object.keys(separator), ['type']);
  const autosave = file.submenu!.find((i) => i.label === 'Simpan Otomatis')!;
  assert.deepEqual(autosave.submenu!.map((i) => i.id), ['doc.autosave.off', 'doc.autosave.close', 'doc.autosave.edit']);
  const tabs = walk(template).find((i) => i.label === 'Pilih Tab')!;
  assert.equal(tabs.submenu!.length, 10);
});

test('every command is an item once and has an id of its own, so that a test or a script can find it by the id', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const ids = walk(toTemplate(model(platform), () => undefined)).flatMap((i) => (i.id !== undefined ? [i.id] : []));
    assert.deepEqual([...ids].sort(), [...COMMAND_IDS].sort(), platform);
  }
});

test('building a template changes nothing in the menu it is made from', () => {
  const menu = model('darwin');
  const before = JSON.stringify(menu);
  toTemplate(menu, () => undefined);
  assert.equal(JSON.stringify(menu), before);
});
