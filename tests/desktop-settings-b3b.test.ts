import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { realFs, type StoreFs } from '../src/documents/store.js';
import { DEFAULTS, OPTIONS, Settings, SettingsError, optionOf, type OptionName } from '../src/desktop/settings.js';
import { DEFAULT_LAYOUT } from '../src/desktop/toolbar-model.js';

// What package 02-B3b adds to the settings: whether the tabs show the colour of their object, whether the full screen is the extended one, and whether the keys of documents may be remembered. The file stays
// version 1 and the new parts are written only when they are not the default, so a file that 02-B3 wrote is a file of 02-B3b. The other way round, 02-B3 reads a file of 02-B3b (it ignores the parts it does not know) but
// writes it back without them: going back to the earlier version of the app loses the choices of the new parts. That is a limit, and the plan says so.
const where = async () => { const dir = await mkdtemp(join(tmpdir(), 'rwsettings3b-')); return { dir, path: join(dir, 'settings.json') }; };
const text = (path: string) => readFile(path, 'utf8');
const failing = (code: string, run: () => Promise<unknown>) => assert.rejects(run, (error: unknown) => error instanceof SettingsError && error.code === code, `expected SettingsError ${code}`);

test('the new choices start as: tabs coloured, full screen as it is, keys not remembered; nothing is written until something is chosen', async () => {
  const { dir, path } = await where();
  const settings = await Settings.open(path);
  assert.deepEqual(settings.values(), DEFAULTS);
  assert.deepEqual([DEFAULTS.tabs, DEFAULTS.fullscreen, DEFAULTS.keys], [{ colorize: true }, { extended: false }, { allow: false }]);
  assert.deepEqual(DEFAULTS.toolbar, { visible: true, items: DEFAULT_LAYOUT }, 'and what was there is as it was');
  assert.deepEqual(await readdir(dir), []);
  assert.deepEqual([...OPTIONS], ['tabs.colorize', 'fullscreen.extended', 'keys.allow']);
  assert.deepEqual(OPTIONS.map((name) => optionOf(DEFAULTS, name)), [true, false, false]);
});

test('each choice is kept, read back when the app starts again, and not written when it is the default; they sit in the file next to the others', async () => {
  const { path } = await where();
  const settings = await Settings.open(path);
  assert.equal((await settings.setOption('tabs.colorize', false)).tabs.colorize, false);
  assert.equal(await text(path), '{"version":1,"tabs":{"colorize":false}}\n');
  assert.equal((await settings.setOption('fullscreen.extended', true)).fullscreen.extended, true);
  assert.equal(await text(path), '{"version":1,"tabs":{"colorize":false},"fullscreen":{"extended":true}}\n');
  assert.equal((await settings.setOption('keys.allow', true)).keys.allow, true);
  await settings.setTheme('dark');
  await settings.setToolbar({ visible: false });
  assert.equal(await text(path), '{"version":1,"theme":"dark","toolbar":{"visible":false},"tabs":{"colorize":false},"fullscreen":{"extended":true},"keys":{"allow":true}}\n');
  const again = await Settings.open(path);
  assert.deepEqual(OPTIONS.map((name) => optionOf(again.values(), name)), [false, true, true]);
  await again.setOption('tabs.colorize', true);
  await again.setOption('fullscreen.extended', false);
  await again.setOption('keys.allow', false);
  assert.equal(await text(path), '{"version":1,"theme":"dark","toolbar":{"visible":false}}\n', 'the defaults are not choices: they are not written');
});

test('a choice that is made again does not write the file again, and one that cannot be understood is refused', async () => {
  const { path } = await where();
  const writes: string[] = [];
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { writes.push(to); await realFs.rename(from, to); } };
  const settings = await Settings.open(path, { fs });
  await settings.setOption('keys.allow', true);
  await settings.setOption('keys.allow', true);
  assert.equal(writes.length, 1);
  for (const [name, value] of [['tabs', true], ['keys.allow', 'yes'], ['keys.allow', 1], ['keys.allow', null], ['keys.allow', undefined], ['theme', true], ['__proto__', true], ['constructor', true], [undefined, true], [3, true], ['keys.allow ', true], ['KEYS.ALLOW', true]] as const) {
    await failing('invalid', () => settings.setOption(name, value));
  }
  assert.equal(writes.length, 1);
  assert.equal(optionOf(settings.values(), 'keys.allow'), true);
});

test('a choice can be flipped, and what flips is what the file holds at that moment, even if another copy of the app changed it', async () => {
  const { path } = await where();
  const a = await Settings.open(path);
  const b = await Settings.open(path);
  assert.equal((await a.toggleOption('fullscreen.extended')).fullscreen.extended, true);
  assert.equal((await b.toggleOption('fullscreen.extended')).fullscreen.extended, false, 'b flips what a left: it is on in the file, so it goes off');
  assert.equal(await text(path), '{"version":1}\n');
  const results = await Promise.all([a.toggleOption('tabs.colorize'), a.toggleOption('tabs.colorize'), a.toggleOption('tabs.colorize')]);
  assert.deepEqual(results.map((values) => values.tabs.colorize), [false, true, false], 'one after the other, each from what the one before left');
  await failing('invalid', () => a.toggleOption('nonsense' as OptionName));
});

test('a part of the file that is wrong costs only that part, and the parts of 02-B3 and the new ones do not disturb each other', async () => {
  const { path } = await where();
  await writeFile(path, JSON.stringify({ version: 1, theme: 'dark', toolbar: { visible: false }, tabs: { colorize: 'no' }, fullscreen: 3, keys: [], other: { allow: true } }));
  const wrong = await Settings.open(path);
  assert.deepEqual(OPTIONS.map((name) => optionOf(wrong.values(), name)), [true, false, false], 'the defaults');
  assert.equal(wrong.values().theme, 'dark');
  assert.equal(wrong.values().toolbar.visible, false);
  await writeFile(path, JSON.stringify({ version: 1, tabs: { colorize: false, more: 1 }, keys: { allow: true, extra: 'x' } }));
  const some = await Settings.open(path);
  assert.deepEqual(OPTIONS.map((name) => optionOf(some.values(), name)), [false, false, true]);
  await writeFile(path, '{"version":1,"theme":"light"}\n');       // exactly what 02-B3 writes
  const old = await Settings.open(path);
  assert.deepEqual([old.values().theme, ...OPTIONS.map((name) => optionOf(old.values(), name))], ['light', true, false, false]);
  assert.equal(old.setAside, undefined, 'it is not damaged: it is older');
});

test('whoever follows the settings is told of a change of a choice, with the settings as they are then, and of nothing when nothing changes', async () => {
  const { path } = await where();
  const settings = await Settings.open(path);
  const heard: string[] = [];
  settings.subscribe((values) => heard.push(OPTIONS.map((name) => (optionOf(values, name) ? '1' : '0')).join('')));
  await settings.setOption('keys.allow', true);
  await settings.setOption('keys.allow', true);
  await settings.toggleOption('tabs.colorize');
  await settings.setOption('fullscreen.extended', true);
  assert.deepEqual(heard, ['101', '001', '011']);
});

test('a change that cannot be written is refused and the choice stays what it was', async () => {
  const { dir, path } = await where();
  let fail = false;
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (fail) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); await realFs.rename(from, to); } };
  const settings = await Settings.open(path, { fs });
  fail = true;
  await failing('io', () => settings.setOption('keys.allow', true));
  assert.equal(optionOf(settings.values(), 'keys.allow'), false);
  await failing('io', () => settings.toggleOption('tabs.colorize'));
  assert.equal(optionOf(settings.values(), 'tabs.colorize'), true);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  fail = false;
  assert.equal(optionOf(await settings.setOption('keys.allow', true), 'keys.allow'), true, 'and the next change works');
});

test('settings that are kept only while the app runs take the choices too, and what is handed out is a copy', async () => {
  const memory = Settings.memory();
  assert.equal(optionOf(await memory.setOption('fullscreen.extended', true), 'fullscreen.extended'), true);
  assert.equal(optionOf(await memory.toggleOption('keys.allow'), 'keys.allow'), true);
  const values = memory.values() as { tabs: { colorize: boolean }; fullscreen: { extended: boolean }; keys: { allow: boolean } };
  values.tabs.colorize = false;
  values.fullscreen.extended = false;
  values.keys.allow = false;
  assert.deepEqual(OPTIONS.map((name) => optionOf(memory.values(), name)), [true, true, true]);
  assert.deepEqual(DEFAULTS.keys, { allow: false }, 'the defaults are not touched either');
});
