import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { realFs, type StoreFs } from '../src/documents/store.js';
import { DEFAULTS, MAX_FILE_BYTES, Settings, SettingsError } from '../src/desktop/settings.js';
import { DEFAULT_LAYOUT } from '../src/desktop/toolbar-model.js';

const where = async () => { const dir = await mkdtemp(join(tmpdir(), 'rwsettings-')); return { dir, path: join(dir, 'settings.json') }; };
const failing = (code: string, run: () => Promise<unknown>) => assert.rejects(run, (error: unknown) => error instanceof SettingsError && error.code === code, `expected SettingsError ${code}`);
/** A file system that counts what is renamed into place and can be told to fail. */
function counting() {
  const state = { renames: 0, failRename: false, failRead: false, failOpen: false };
  const fs: StoreFs = {
    ...realFs,
    rename: async (from, to) => { if (state.failRename) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' }); state.renames++; await realFs.rename(from, to); },
    readFile: async (path) => { if (state.failRead) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return realFs.readFile(path); },
    open: async (path, flags, mode) => { if (state.failOpen) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); return realFs.open(path, flags, mode); },
  };
  return { fs, state };
}
const text = async (path: string) => (await readFile(path, 'utf8'));

test('without a file the settings are the defaults, and nothing is written until something is chosen', async () => {
  const { dir, path } = await where();
  const settings = await Settings.open(path);
  assert.deepEqual(settings.values(), DEFAULTS);
  assert.equal(DEFAULTS.theme, 'system');
  assert.deepEqual(DEFAULTS.toolbar, { visible: true, items: DEFAULT_LAYOUT });
  assert.deepEqual(await readdir(dir), []);
  assert.equal(settings.setAside, undefined);
});

test('the theme that is chosen is kept, read back when the app starts again, and not written when it is the default', async () => {
  const { path } = await where();
  const first = await Settings.open(path);
  assert.equal((await first.setTheme('dark')).theme, 'dark');
  assert.equal(await text(path), '{"version":1,"theme":"dark"}\n');
  assert.equal((await Settings.open(path)).values().theme, 'dark');
  assert.equal((await first.setTheme('light')).theme, 'light');
  assert.equal(await text(path), '{"version":1,"theme":"light"}\n');
  assert.equal((await first.setTheme('system')).theme, 'system');
  assert.equal(await text(path), '{"version":1}\n', 'the default is not a choice: it is not written');
  assert.equal((await Settings.open(path)).values().theme, 'system');
});

test('the toolbar that is chosen is kept: whether it is shown, and what is on it', async () => {
  const { path } = await where();
  const settings = await Settings.open(path);
  assert.equal((await settings.setToolbar({ visible: false })).toolbar.visible, false);
  assert.equal(await text(path), '{"version":1,"toolbar":{"visible":false}}\n');
  const items = ['doc.new', '|', 'obj.connect'] as const;
  const after = await settings.setToolbar({ items });
  assert.deepEqual(after.toolbar, { visible: false, items });
  assert.equal(await text(path), '{"version":1,"toolbar":{"visible":false,"items":["doc.new","|","obj.connect"]}}\n');
  const again = await Settings.open(path);
  assert.deepEqual(again.values().toolbar, { visible: false, items });
  assert.equal((await again.setToolbar({ visible: true })).toolbar.visible, true);
  assert.equal(await text(path), '{"version":1,"toolbar":{"items":["doc.new","|","obj.connect"]}}\n', 'shown is the default: not written');
  assert.deepEqual((await again.setToolbar({ items: DEFAULT_LAYOUT })).toolbar, { visible: true, items: DEFAULT_LAYOUT });
  assert.equal(await text(path), '{"version":1}\n', 'the default layout is not written either');
  assert.deepEqual((await again.setToolbar({ items: [] })).toolbar.items, [], 'an empty toolbar is a choice');
  assert.equal(await text(path), '{"version":1,"toolbar":{"items":[]}}\n');
  assert.deepEqual((await Settings.open(path)).values().toolbar.items, []);
});

test('what is handed out is a copy, so that changing it changes nothing', async () => {
  const { path } = await where();
  const settings = await Settings.open(path);
  const values = settings.values() as unknown as { theme: string; toolbar: { visible: boolean; items: string[] } };      // 02-B3b: the values have more parts than this, so the cast goes through unknown
  values.theme = 'dark';
  values.toolbar.visible = false;
  (values.toolbar.items as string[]).push('doc.close');
  assert.deepEqual(settings.values(), DEFAULTS);
  const set = await settings.setToolbar({ items: ['doc.new'] });
  (set.toolbar.items as string[]).push('doc.open');
  assert.deepEqual(settings.values().toolbar.items, ['doc.new']);
});

test('a choice that is not one is refused and changes nothing', async () => {
  const { dir, path } = await where();
  const settings = await Settings.open(path);
  for (const wrong of ['', 'Dark', 'auto', 'constructor', 1, null, undefined, {}, ['dark']]) await failing('invalid', () => settings.setTheme(wrong));
  for (const wrong of [null, undefined, 'visible', 3, [], { visible: 'no' }, { visible: 1 }, { visible: null }, { items: 'doc.new' }, { items: [1] }, { items: null }, { items: {} }, { unknown: true }, { visible: true, extra: 1 }]) await failing('invalid', () => settings.setToolbar(wrong));
  assert.deepEqual(settings.values(), DEFAULTS);
  assert.deepEqual(await readdir(dir), []);
  assert.deepEqual(await settings.setToolbar({}), settings.values(), 'a change of nothing is nothing');
  assert.deepEqual(await readdir(dir), [], 'and writes nothing');
});

test('a layout that holds what is not offered is mended before it is kept: the rest of it stands', async () => {
  const { path } = await where();
  const settings = await Settings.open(path);
  const after = await settings.setToolbar({ items: ['doc.new', 'nonsense', 'doc.new', '|', '|', 'app.quit', 'doc.open', '|'] });
  assert.deepEqual(after.toolbar.items, ['doc.new', '|', 'doc.open']);
  assert.equal(await text(path), '{"version":1,"toolbar":{"items":["doc.new","|","doc.open"]}}\n');
});

test('a file that cannot be understood is set aside and the settings start from the defaults', async () => {
  for (const bad of ['', 'not json', '[]', '"text"', 'null', '7', '{}', '{"version":0}', '{"version":"1"}', '{"version":1.5}', '{"version":-1}', '{"theme":"dark"}']) {
    const { dir, path } = await where();
    await writeFile(path, bad);
    const settings = await Settings.open(path);
    assert.deepEqual(settings.values(), DEFAULTS, bad);
    assert.ok(settings.setAside && settings.setAside.startsWith(`${path}.bad-`), `${bad}: set aside`);
    assert.equal(await readFile(settings.setAside!, 'utf8'), bad, 'kept, not deleted');
    assert.deepEqual((await readdir(dir)).sort(), [settings.setAside!.slice(dir.length + 1)], bad);
    assert.equal((await settings.setTheme('dark')).theme, 'dark', 'and works');
  }
});

test('one thing wrong in a file that is otherwise fine does not cost the person the rest: the part that is wrong is the default', async () => {
  const { path } = await where();
  await writeFile(path, JSON.stringify({ version: 1, theme: 'sepia', toolbar: { visible: 'yes', items: ['doc.new', 'nope', 'doc.new'], more: 1 }, other: true }));
  const settings = await Settings.open(path);
  assert.equal(settings.setAside, undefined);
  assert.deepEqual(settings.values(), { theme: 'system', toolbar: { visible: true, items: ['doc.new'] }, tabs: { colorize: true }, fullscreen: { extended: false }, keys: { allow: false } }, 'the layout is mended, the others are the default');      // 02-B3b: and so are the three new choices
  await writeFile(path, JSON.stringify({ version: 1, theme: 'dark', toolbar: 'wide' }));
  assert.deepEqual((await Settings.open(path)).values(), { theme: 'dark', toolbar: DEFAULTS.toolbar, tabs: DEFAULTS.tabs, fullscreen: DEFAULTS.fullscreen, keys: DEFAULTS.keys });
  await writeFile(path, JSON.stringify({ version: 1, theme: 'light', toolbar: { visible: false, items: 'all' } }));
  assert.deepEqual((await Settings.open(path)).values(), { theme: 'light', toolbar: { visible: false, items: DEFAULT_LAYOUT }, tabs: { colorize: true }, fullscreen: { extended: false }, keys: { allow: false } });
});

test('a file that a newer version of the app wrote is left alone, and the settings cannot be used', async () => {
  const { path } = await where();
  const newer = JSON.stringify({ version: 2, theme: 'dark', more: 'that this version does not know' });
  await writeFile(path, newer);
  await failing('too-new', () => Settings.open(path));
  assert.equal(await text(path), newer);
});

test('a file that is too big is not read, it is set aside', async () => {
  const { path } = await where();
  await writeFile(path, JSON.stringify({ version: 1, pad: 'x'.repeat(MAX_FILE_BYTES) }));
  const settings = await Settings.open(path);
  assert.deepEqual(settings.values(), DEFAULTS);
  assert.ok(settings.setAside);
  assert.ok(MAX_FILE_BYTES >= 16 * 1024 && MAX_FILE_BYTES <= 1024 * 1024);
});

test('a file that cannot be read is an error, and is not written over', async () => {
  const { path } = await where();
  await writeFile(path, '{"version":1,"theme":"dark"}\n');
  const { fs, state } = counting();
  state.failRead = true;
  await failing('io', () => Settings.open(path, { fs }));
  state.failRead = false;
  const settings = await Settings.open(path, { fs });
  assert.equal(settings.values().theme, 'dark');
  state.failRead = true;
  await failing('io', () => settings.setTheme('light'));
  assert.equal(settings.values().theme, 'dark', 'refused: nothing changed');
  state.failRead = false;
  assert.equal(await text(path), '{"version":1,"theme":"dark"}\n');
});

test('a change is written whole and in one step: the file is the old one or the new one, never part of one, and a write that fails leaves no trace', async () => {
  const { dir, path } = await where();
  const { fs, state } = counting();
  const settings = await Settings.open(path, { fs });
  await settings.setTheme('dark');
  assert.equal(state.renames, 1);
  state.failRename = true;
  await failing('io', () => settings.setTheme('light'));
  assert.equal(settings.values().theme, 'dark', 'the setting that was not written is not the setting');
  assert.equal(await text(path), '{"version":1,"theme":"dark"}\n');
  assert.deepEqual(await readdir(dir), ['settings.json'], 'the temporary file went');
  state.failRename = false;
  state.failOpen = true;
  await failing('io', () => settings.setToolbar({ visible: false }));
  state.failOpen = false;
  assert.deepEqual(await readdir(dir), ['settings.json']);
  assert.deepEqual(settings.values().toolbar, DEFAULTS.toolbar);
  assert.equal((await settings.setToolbar({ visible: false })).toolbar.visible, false, 'and the next change works');
});

test('the file is the person\'s own: it is made with a mode of its own and its folder is made when it is not there', async () => {
  const { dir } = await where();
  const path = join(dir, 'deep', 'er', 'settings.json');
  const settings = await Settings.open(path);
  await settings.setTheme('dark');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('two copies of the app that share a folder do not undo one another: a change starts from what the file holds then', async () => {
  const { path } = await where();
  const a = await Settings.open(path), b = await Settings.open(path);
  await a.setTheme('dark');
  await b.setToolbar({ visible: false });
  assert.deepEqual(JSON.parse(await text(path)), { version: 1, theme: 'dark', toolbar: { visible: false } }, 'the theme that the other copy chose is still there');
  assert.equal(b.values().theme, 'dark', 'and is known now');
  await b.setTheme('light');
  await a.setToolbar({ items: ['doc.new'] });
  assert.deepEqual(JSON.parse(await text(path)), { version: 1, theme: 'light', toolbar: { visible: false, items: ['doc.new'] } });
  await writeFile(path, '{"version":1,"theme":"dark"}\n');   // the file changes under a copy that is running: a layout that the file no longer holds is gone from it too
  assert.equal((await a.setToolbar({ visible: false })).theme, 'dark');
});

test('a file that went away or was spoiled while the app runs does not stop a change: it starts again from what is known', async () => {
  const { dir, path } = await where();
  const settings = await Settings.open(path);
  await settings.setTheme('dark');
  await writeFile(path, 'garbage');
  assert.equal((await settings.setToolbar({ visible: false })).toolbar.visible, false);
  assert.deepEqual(JSON.parse(await text(path)), { version: 1, theme: 'dark', toolbar: { visible: false } }, 'what the app knew stands: the choice of the theme is not lost with the file');
  assert.ok((await readdir(dir)).some((name) => name.startsWith('settings.json.bad-')), 'and it was kept');
  const newer = JSON.stringify({ version: 3 });
  await writeFile(path, newer);
  await failing('too-new', () => settings.setTheme('light'));
  assert.equal(await text(path), newer);
});

test('changes are made one after the other, in the order they were asked for', async () => {
  const { path } = await where();
  const settings = await Settings.open(path);
  const results = await Promise.all([settings.setTheme('dark'), settings.setToolbar({ visible: false }), settings.setTheme('light'), settings.setToolbar({ items: ['doc.open'] })]);
  assert.deepEqual(results.map((r) => r.theme), ['dark', 'dark', 'light', 'light']);
  assert.deepEqual(JSON.parse(await text(path)), { version: 1, theme: 'light', toolbar: { visible: false, items: ['doc.open'] } });
  const queued = Promise.all([settings.setTheme('bogus'), settings.setTheme('dark')]);
  await assert.rejects(queued);
  assert.equal((await settings.setTheme('dark')).theme, 'dark', 'a refused change does not stop the ones after it');
});

test('whoever follows the settings is told of every change, once, with the settings as they are, and not of a change that did not happen', async () => {
  const { path } = await where();
  const { fs, state } = counting();
  const settings = await Settings.open(path, { fs });
  const seen: string[] = [];
  const stop = settings.subscribe((values) => seen.push(`${values.theme}/${values.toolbar.visible}`));
  await settings.setTheme('dark');
  await settings.setToolbar({ visible: false });
  await settings.setTheme('dark');
  assert.deepEqual(seen, ['dark/true', 'dark/false'], 'a choice that is already the choice is not a change');
  state.failRename = true;
  await failing('io', () => settings.setTheme('light'));
  state.failRename = false;
  assert.deepEqual(seen, ['dark/true', 'dark/false']);
  const other: string[] = [];
  settings.subscribe(() => { throw new Error('a follower that fails'); });
  settings.subscribe((values) => other.push(values.theme));
  await settings.setTheme('light');
  assert.deepEqual(other, ['light'], 'a follower that fails does not stop the others, or the change');
  assert.equal(settings.values().theme, 'light');
  stop();
  await settings.setTheme('system');
  assert.deepEqual(seen, ['dark/true', 'dark/false', 'light/false'], 'no longer told, and told once of the change before it went');
});

test('settings that cannot be kept are held in memory for as long as the app runs: changes are made, checked and followed like any, and nothing is written', async () => {
  const settings = Settings.memory();
  assert.deepEqual(settings.values(), DEFAULTS);
  assert.equal(settings.setAside, undefined);
  const seen: string[] = [];
  settings.subscribe((values) => seen.push(`${values.theme}/${values.toolbar.visible}/${values.toolbar.items.length}`));
  assert.equal((await settings.setTheme('dark')).theme, 'dark');
  assert.deepEqual((await settings.setToolbar({ visible: false, items: ['doc.new', 'nonsense', 'doc.open'] })).toolbar, { visible: false, items: ['doc.new', 'doc.open'] });
  await failing('invalid', () => settings.setTheme('sepia'));
  await failing('invalid', () => settings.setToolbar({ items: 'all' }));
  assert.equal((await settings.setTheme('dark')).theme, 'dark');
  assert.deepEqual(seen, ['dark/true/18', 'dark/false/2'], 'every change that was made, and none that was not');
  assert.equal(settings.values().theme, 'dark');
  assert.deepEqual(Settings.memory().values(), DEFAULTS, 'each is its own');
});

/** A file system whose rename is refused `failures` times with the given reason, and then works. */
function flaky(code: string, failures: number) {
  const state = { attempts: 0 };
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { state.attempts++; if (state.attempts <= failures) throw Object.assign(new Error(`${code}: refused`), { code }); await realFs.rename(from, to); } };
  return { fs, state };
}

test('Windows refuses to replace a file that another program has open for a moment (antivirus, indexer): a rename is tried again, three times at most, and only for those reasons', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const { path } = await where();
    const { fs, state } = flaky(code, 2);
    const settings = await Settings.open(path, { fs });
    assert.equal((await settings.setTheme('dark')).theme, 'dark', code);
    assert.equal(state.attempts, 3, `${code}: refused twice, then it works`);
    assert.equal(await text(path), '{"version":1,"theme":"dark"}\n');
  }
  const stuck = flaky('EPERM', 99);
  const there = await where();
  const settings = await Settings.open(there.path, { fs: stuck.fs });
  await failing('io', () => settings.setTheme('dark'));
  assert.equal(stuck.state.attempts, 4, 'the first try and three more');
  assert.deepEqual(await readdir(there.dir), [], 'and nothing is left behind');
  for (const code of ['EIO', 'ENOSPC', 'ENOENT']) {
    const once = flaky(code, 99), here = await where();
    const other = await Settings.open(here.path, { fs: once.fs });
    await failing('io', () => other.setTheme('dark'));
    assert.equal(once.state.attempts, 1, `${code}: not tried again`);
  }
});

// Review of the execution (22 October 2026): the tests counted the tries and never looked at the waits between them
test('a rename that is refused is tried again after a wait that grows: 20, then 60, then 180 milliseconds', async () => {
  const waits: number[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((run: () => void, ms?: number) => { waits.push(ms ?? 0); return real(run, 0); }) as typeof setTimeout;
  try {
    const { fs } = flaky('EBUSY', 3);
    const { path } = await where();
    assert.equal((await (await Settings.open(path, { fs })).setTheme('dark')).theme, 'dark');
  } finally { globalThis.setTimeout = real; }
  assert.deepEqual(waits, [20, 60, 180]);
});

test('the temporary file has a name of its own every time: a file that something left behind with another name does not stop a change from being written, and is not touched', async () => {
  const { path } = await where();
  await writeFile(`${path}.000000.tmp`, 'left behind');
  const settings = await Settings.open(path);
  assert.equal((await settings.setTheme('dark')).theme, 'dark');
  assert.equal(await text(path), '{"version":1,"theme":"dark"}\n');
  assert.equal(await text(`${path}.000000.tmp`), 'left behind');
});

test('a change is written the careful way: the temporary file is new and private, written, synced and closed, then renamed into place, and then the folder is synced', async () => {
  const calls: string[] = [];
  const fs: StoreFs = {
    ...realFs,
    mkdir: async (path) => { calls.push('mkdir'); await realFs.mkdir(path); },
    open: async (path, flags, mode) => {
      calls.push(`open ${flags} ${mode.toString(8)}`);
      const handle = await realFs.open(path, flags, mode);
      return { writeFile: async (data) => { calls.push('write'); await handle.writeFile(data); }, sync: async () => { calls.push('sync'); await handle.sync(); }, close: async () => { calls.push('close'); await handle.close(); } };
    },
    rename: async (from, to) => { calls.push('rename'); await realFs.rename(from, to); },
    syncDir: async (path) => { calls.push('syncDir'); await realFs.syncDir(path); },
  };
  const { path } = await where();
  const settings = await Settings.open(path, { fs });
  await settings.setTheme('dark');
  assert.deepEqual(calls, ['mkdir', 'open wx 600', 'write', 'sync', 'close', 'rename', 'syncDir']);
});

test('a folder that cannot be synced does not make a change that was written fail', async () => {
  const { path } = await where();
  const fs: StoreFs = { ...realFs, syncDir: async () => { throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); } };
  const settings = await Settings.open(path, { fs });
  assert.equal((await settings.setTheme('dark')).theme, 'dark');
  assert.equal(await text(path), '{"version":1,"theme":"dark"}\n');
});

test('the limit of the size of the file is 256 KiB: a file of exactly that is read, one byte more is set aside, and a file that is far too big is not even read', async () => {
  assert.equal(MAX_FILE_BYTES, 256 * 1024);
  const body = '{"version":1,"theme":"dark"}';
  const exact = body + ' '.repeat(MAX_FILE_BYTES - body.length);
  const a = await where();
  await writeFile(a.path, exact);
  assert.equal((await stat(a.path)).size, MAX_FILE_BYTES);
  const read = await Settings.open(a.path);
  assert.equal(read.values().theme, 'dark');
  assert.equal(read.setAside, undefined);
  const b = await where();
  await writeFile(b.path, `${exact} `);
  assert.ok((await Settings.open(b.path)).setAside, 'one byte more');
  const c = await where();
  await writeFile(c.path, 'x');
  const fs: StoreFs = { ...realFs, stat: async () => ({ mtimeMs: 0, size: 10 * 1024 ** 3 }), readFile: async () => { throw new Error('a file of that size must not be read'); } };
  const huge = await Settings.open(c.path, { fs });
  assert.ok(huge.setAside, 'set aside by its size');
  assert.deepEqual(huge.values(), DEFAULTS);
  assert.equal(await readFile(huge.setAside!, 'utf8'), 'x');
});

test('a file that is set aside is never written over by the next one that is: every damaged file is kept', async () => {
  const { dir, path } = await where();
  const now = Date.now;
  Date.now = () => 1_700_000_000_000;      // every file is set aside in the same millisecond: the name must not rest on the time alone
  try {
    for (let n = 0; n < 6; n++) { await writeFile(path, `garbage ${n}`); await Settings.open(path); }
  } finally { Date.now = now; }
  const kept = (await readdir(dir)).filter((name) => name.startsWith('settings.json.bad-'));
  assert.equal(kept.length, 6);
  assert.deepEqual((await Promise.all(kept.map((name) => readFile(join(dir, name), 'utf8')))).sort(), [0, 1, 2, 3, 4, 5].map((n) => `garbage ${n}`));
});

test('a damaged file that cannot be set aside is an error, and it stays where it is: it is not written over', async () => {
  const { path } = await where();
  await writeFile(path, 'garbage');
  const { fs, state } = counting();
  state.failRename = true;
  await failing('io', () => Settings.open(path, { fs }));
  assert.equal(await text(path), 'garbage');
});

test('a follower hears of what another copy chose when the change that is asked for turns out to be the same, and when it cannot be written', async () => {
  const { path } = await where();
  const { fs, state } = counting();
  const a = await Settings.open(path), b = await Settings.open(path, { fs });
  const seen: string[] = [];
  b.subscribe((values) => seen.push(`${values.theme}/${values.toolbar.visible}`));
  await a.setTheme('dark');                  // the other copy chooses
  assert.equal((await b.setTheme('dark')).theme, 'dark');   // this one is asked for the same: nothing to write, but nobody here has heard
  assert.deepEqual(seen, ['dark/true']);
  await b.setTheme('dark');
  assert.deepEqual(seen, ['dark/true'], 'and it is told once');
  await a.setToolbar({ visible: false });
  state.failRename = true;
  await failing('io', () => b.setTheme('light'));   // the file is read again and holds news, then the write fails
  state.failRename = false;
  assert.deepEqual(seen, ['dark/true', 'dark/false'], 'the news is told although the change was refused');
  assert.deepEqual([b.values().theme, b.values().toolbar.visible], ['dark', false]);
});

test('a follower is not told of what the file already held when the app started: only of what changes after that', async () => {
  const { path } = await where();
  await writeFile(path, '{"version":1,"theme":"dark","toolbar":{"visible":false}}\n');
  const settings = await Settings.open(path);
  const seen: string[] = [];
  settings.subscribe((values) => seen.push(`${values.theme}/${values.toolbar.visible}`));
  await settings.setTheme('dark');
  await settings.setToolbar({ visible: false });
  assert.deepEqual(seen, [], 'nothing changed');
  await settings.setTheme('light');
  assert.deepEqual(seen, ['light/false']);
});

// ---- review of the execution (22 October 2026)
test('a file that an editor of Windows saved with a byte order mark is read, not set aside as damaged', async () => {
  const { dir, path } = await where();
  await writeFile(path, '\uFEFF{"version":1,"theme":"dark"}\n');
  const settings = await Settings.open(path);
  assert.equal(settings.values().theme, 'dark');
  assert.equal(settings.setAside, undefined);
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('the toolbar is shown or hidden by a change that is made in its turn: two at once end where they began, and each flips what the one before left', async () => {
  const { path } = await where();
  const settings = await Settings.open(path);
  const heard: boolean[] = [];
  settings.subscribe((values) => heard.push(values.toolbar.visible));
  await Promise.all([settings.toggleToolbar(), settings.toggleToolbar()]);
  assert.equal(settings.values().toolbar.visible, true);
  assert.deepEqual(heard, [false, true]);
  assert.equal(await text(path), '{"version":1}\n');
  assert.equal((await settings.toggleToolbar()).toolbar.visible, false);
  assert.equal(await text(path), '{"version":1,"toolbar":{"visible":false}}\n');
  const memory = Settings.memory();
  await Promise.all([memory.toggleToolbar(), memory.toggleToolbar(), memory.toggleToolbar()]);
  assert.equal(memory.values().toolbar.visible, false);
});

test('a file that goes away while the app runs is carried on without: the next change writes what is known', async () => {
  const { dir, path } = await where();
  const settings = await Settings.open(path);
  await settings.setTheme('dark');
  await rm(path);
  await settings.setToolbar({ visible: false });
  assert.equal(await text(path), '{"version":1,"theme":"dark","toolbar":{"visible":false}}\n', 'the theme that was chosen is not forgotten with the file');
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('a change that cannot be written at any step leaves no trace: the file that was opened is closed, nothing is left behind, and the change was not made', async () => {
  for (const step of ['writeFile', 'sync'] as const) {
    const { dir, path } = await where();
    const closed: number[] = [];
    const fs: StoreFs = {
      ...realFs,
      open: async (file, flags, mode) => {
        const handle = await realFs.open(file, flags, mode);
        return {
          writeFile: step === 'writeFile' ? async () => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); } : (data) => handle.writeFile(data),
          sync: step === 'sync' ? async () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); } : () => handle.sync(),
          close: async () => { closed.push(1); await handle.close(); },
        };
      },
    };
    const settings = await Settings.open(path, { fs });
    await failing('io', () => settings.setTheme('dark'));
    assert.equal(closed.length, 1, `${step}: the file that was opened is closed`);
    assert.deepEqual(await readdir(dir), [], `${step}: nothing is left behind`);
    assert.equal(settings.values().theme, 'system', `${step}: and the change was not made`);
  }
});

test('the size of a file is asked for first and checked again on what was read: a file that says it is small and is not is set aside; the folder is synced, not the file', async () => {
  const { dir, path } = await where();
  await writeFile(path, 'x'.repeat(MAX_FILE_BYTES + 1));
  const lying: StoreFs = { ...realFs, stat: async (file) => ({ ...(await realFs.stat(file)), size: 1 }) };
  const settings = await Settings.open(path, { fs: lying });
  assert.ok(settings.setAside, 'set aside by what was read');
  assert.equal((await stat(settings.setAside!)).size, MAX_FILE_BYTES + 1);
  const synced: string[] = [];
  const recording: StoreFs = { ...realFs, syncDir: async (folder) => { synced.push(folder); } };
  await (await Settings.open(path, { fs: recording })).setTheme('light');
  assert.deepEqual(synced, [dir], 'the folder that holds the file');
});

test('what was read is too big even when it is good: a file that says it is small, is not, and holds settings that could be understood, is set aside and its choices are not taken', async () => {
  const { path } = await where();
  await writeFile(path, `{"version":1,"theme":"dark"}${' '.repeat(MAX_FILE_BYTES)}`);
  const lying: StoreFs = { ...realFs, stat: async (file) => ({ ...(await realFs.stat(file)), size: 1 }) };
  const settings = await Settings.open(path, { fs: lying });
  assert.ok(settings.setAside, 'set aside');
  assert.equal(settings.values().theme, 'system', 'what it said is not taken');
});

test('a toolbar change names only the shown and the items, and a shown that is not yes or no is refused even when it is not there at all', async () => {
  const settings = Settings.memory();
  await failing('invalid', () => settings.setToolbar({ visible: undefined }));
  await failing('invalid', () => settings.setToolbar({ visible: 'yes' }));
  assert.equal((await settings.setToolbar({})).toolbar.visible, true, 'a patch with nothing in it changes nothing');
});

