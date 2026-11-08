import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_REPORT, type Platform } from '../src/desktop/commands.js';
import { buildMenu, type Flags } from '../src/desktop/menu-model.js';
import { toTemplate, type TemplateItem } from '../src/desktop/menu.js';

const FLAGS: Flags = { theme: 'system', toolbar: true, fullscreen: false, prompt: false };
const model = (platform: Platform, flags: Flags = FLAGS) => buildMenu({ platform, appName: 'Remote Workspace', report: EMPTY_REPORT, flags });
function walk(items: readonly TemplateItem[]): TemplateItem[] { return items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])]); }

test('a place for a recent document that there is none for is handed to Electron as an item that is not visible, and every other item has no visibility of its own', () => {
  const items = walk(toTemplate(model('darwin', { ...FLAGS, recent: ['Kantor', 'Rumah'] }), () => undefined));
  const hidden = items.filter((i) => i.visible === false).map((i) => i.id);
  assert.deepEqual(hidden, ['doc.recent.3', 'doc.recent.4', 'doc.recent.5', 'doc.recent.6', 'doc.recent.7', 'doc.recent.8', 'doc.recent.9', 'doc.recent.10']);
  for (const item of items) if (item.visible !== false) assert.ok(!('visible' in item), `${item.id ?? item.label}: an item that shows says nothing about it`);
  assert.deepEqual(items.filter((i) => i.id?.startsWith('doc.recent.') && i.visible !== false).map((i) => [i.id, i.label, i.enabled]), [['doc.recent.1', 'Kantor', true], ['doc.recent.2', 'Rumah', true], ['doc.recent.clear', 'Bersihkan Daftar', true]]);
});

test('with no recent documents all ten places are there and not visible, and Bersihkan Daftar cannot be chosen', () => {
  const items = walk(toTemplate(model('win32'), () => undefined));
  assert.equal(items.filter((i) => i.visible === false).length, 10);
  assert.equal(items.find((i) => i.id === 'doc.recent.clear')!.enabled, false);
});

test('choosing a recent document runs the command of its place, so that the window can say which one', () => {
  const clicked: string[] = [];
  const items = walk(toTemplate(model('darwin', { ...FLAGS, recent: ['A', 'B', 'C'] }), (id) => clicked.push(id)));
  items.find((i) => i.id === 'doc.recent.3')!.click!();
  items.find((i) => i.id === 'doc.recent.clear')!.click!();
  assert.deepEqual(clicked, ['doc.recent.3', 'doc.recent.clear']);
});
