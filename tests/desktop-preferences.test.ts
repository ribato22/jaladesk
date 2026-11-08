import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { realFs, type StoreFs } from '../src/documents/store.js';
import { MAX_DOCUMENTS, MAX_FAVORITES, Preferences, PreferencesError } from '../src/desktop/preferences.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DOC = id(900), OTHER = id(901);
const where = async () => { const dir = await mkdtemp(join(tmpdir(), 'rwprefs-')); return { dir, path: join(dir, 'preferences.json') }; };
const failing = (code: string, run: () => Promise<unknown>) => assert.rejects(run, (error: unknown) => error instanceof PreferencesError && error.code === code, `expected PreferencesError ${code}`);
/** A file system that counts what is renamed into place and can be told to fail. */
function counting() {
  const state = { renames: 0, fail: false };
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (state.fail) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' }); state.renames++; await realFs.rename(from, to); } };
  return { fs, state };
}

test('a new file starts empty, and favourites are kept per document in the order they were chosen', async () => {
  const { path } = await where();
  const prefs = await Preferences.open(path);
  assert.deepEqual(prefs.favoritesOf(DOC), []);
  assert.deepEqual(await prefs.setFavorite(DOC, id(3), true), [id(3)]);
  assert.deepEqual(await prefs.setFavorite(DOC, id(1), true), [id(3), id(1)]);
  assert.deepEqual(await prefs.setFavorite(OTHER, id(1), true), [id(1)], 'another document has its own');
  assert.deepEqual(prefs.favoritesOf(DOC), [id(3), id(1)]);
  assert.deepEqual(await prefs.setFavorite(DOC, id(3), false), [id(1)]);
  const copy = prefs.favoritesOf(DOC); copy.push('changed outside');
  assert.deepEqual(prefs.favoritesOf(DOC), [id(1)], 'what is handed out is a copy');
});

test('the favourites are read back when the app starts again, and the file holds ids and nothing else', async () => {
  const { path } = await where();
  const first = await Preferences.open(path);
  await first.setFavorite(DOC, id(1), true);
  await first.setFavorite(DOC, id(2), true);
  await first.setFavorite(OTHER, id(7), true);
  const again = await Preferences.open(path);
  assert.deepEqual(again.favoritesOf(DOC), [id(1), id(2)]);
  assert.deepEqual(again.favoritesOf(OTHER), [id(7)]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, favorites: { [DOC]: [id(1), id(2)], [OTHER]: [id(7)] } });
});

test('choosing a favourite that is one, or removing one that is not, writes nothing', async () => {
  const { path } = await where();
  const { fs, state } = counting();
  const prefs = await Preferences.open(path, { fs });
  await prefs.setFavorite(DOC, id(1), true);
  assert.equal(state.renames, 1);
  await prefs.setFavorite(DOC, id(1), true);
  await prefs.setFavorite(DOC, id(2), false);
  await prefs.setFavorite(OTHER, id(2), false);
  assert.equal(state.renames, 1);
});

test('a document with no favourites left is not kept in the file', async () => {
  const { path } = await where();
  const prefs = await Preferences.open(path);
  await prefs.setFavorite(DOC, id(1), true);
  await prefs.setFavorite(DOC, id(1), false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, favorites: {} });
});

test('a file that is damaged or of the wrong shape is set aside and the preferences start empty, with the old file kept', async () => {
  const bad = ['{ not json', JSON.stringify({ version: 0, favorites: {} }), JSON.stringify({ version: 'two', favorites: {} }), JSON.stringify({ version: 1, favorites: [] }), JSON.stringify({ version: 1, favorites: { x: [id(1)] } }),
    JSON.stringify({ version: 1, favorites: { [DOC]: ['not an id'] } }), JSON.stringify({ version: 1, favorites: { [DOC]: [id(1), id(1)] } }), JSON.stringify({ version: 1, favorites: { [DOC]: 'nope' } }), '[]', '', 'null',
    JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, favorites: null }), JSON.stringify({ version: 1, favorites: 7 }), JSON.stringify({ version: 1, favorites: 'x' }), JSON.stringify({ favorites: {} })];
  for (const text of bad) {
    const { dir, path } = await where();
    await writeFile(path, text);
    const prefs = await Preferences.open(path);
    assert.deepEqual(prefs.favoritesOf(DOC), [], text);
    assert.equal(prefs.setAside !== undefined, true, `${text}: the app can say that it set a file aside`);
    const names = await readdir(dir);
    const kept = names.find((n) => n.startsWith('preferences.json.bad-'));
    assert.ok(kept, `${text}: the old file is kept`);
    assert.equal(await readFile(join(dir, kept!), 'utf8'), text);
    await prefs.setFavorite(DOC, id(1), true);   // and it works afterwards
    assert.deepEqual((await Preferences.open(path)).favoritesOf(DOC), [id(1)]);
  }
});

test('a file with no favourites in it is not damage: it is read as it is and left where it is, and an empty list is not written again', async () => {
  for (const text of [JSON.stringify({ version: 1, favorites: {} }), JSON.stringify({ version: 1, favorites: { [DOC]: [] } })]) {
    const { dir, path } = await where();
    await writeFile(path, text);
    const prefs = await Preferences.open(path);
    assert.equal(prefs.setAside, undefined, text);
    assert.deepEqual(await readdir(dir), ['preferences.json'], text);
    assert.deepEqual(prefs.favoritesOf(DOC), []);
  }
  const { path } = await where();
  await writeFile(path, JSON.stringify({ version: 1, favorites: { [DOC]: [], [OTHER]: [id(1)] } }));
  await (await Preferences.open(path)).setFavorite(id(902), id(2), true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).favorites, { [OTHER]: [id(1)], [id(902)]: [id(2)] }, 'a document with an empty list is not a document with favourites');
});

test('a file that is not there is not damage', async () => {
  const { dir, path } = await where();
  const prefs = await Preferences.open(path);
  assert.equal(prefs.setAside, undefined);
  assert.deepEqual(await readdir(dir), []);
});

test('a write that fails leaves the preferences as they were, says so, and the next one works', async () => {
  const { dir, path } = await where();
  const { fs, state } = counting();
  const prefs = await Preferences.open(path, { fs });
  await prefs.setFavorite(DOC, id(1), true);
  state.fail = true;
  await failing('io', () => prefs.setFavorite(DOC, id(2), true));
  assert.deepEqual(prefs.favoritesOf(DOC), [id(1)], 'in memory too');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).favorites[DOC], [id(1)], 'on disk too');
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), [], 'no half-written file is left');
  state.fail = false;
  assert.deepEqual(await prefs.setFavorite(DOC, id(2), true), [id(1), id(2)]);
});

test('a change is made durable before it counts: the temporary file is made for its owner alone and never over another file, written and synced, renamed into place, and the folder synced after that', async () => {
  const { dir, path } = await where();
  const log: string[] = [];
  const spy: StoreFs = {
    ...realFs,
    open: async (file, flags, mode) => {
      const handle = await realFs.open(file, flags, mode);
      log.push(`open ${flags} ${mode.toString(8)}`);
      return { writeFile: async (data) => { log.push('write'); await handle.writeFile(data); }, sync: async () => { log.push('sync'); await handle.sync(); }, close: async () => { log.push('close'); await handle.close(); } };
    },
    rename: async (from, to) => { log.push(`rename onto the file: ${to === path}`); await realFs.rename(from, to); },
    syncDir: async (folder) => { log.push(`syncDir of its folder: ${folder === dir}`); await realFs.syncDir(folder); },
  };
  await (await Preferences.open(path, { fs: spy })).setFavorite(DOC, id(1), true);
  assert.deepEqual(log, ['open wx 600', 'write', 'sync', 'close', 'rename onto the file: true', 'syncDir of its folder: true']);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600, 'only its owner can read it');
});

test('ids that are not ids are refused before anything is written', async () => {
  const { dir, path } = await where();
  const prefs = await Preferences.open(path);
  await failing('invalid', () => prefs.setFavorite('not an id', id(1), true));
  await failing('invalid', () => prefs.setFavorite(DOC, '__proto__', true));
  await failing('invalid', () => prefs.setFavorite(DOC, '', false));
  assert.deepEqual(await readdir(dir), []);
  assert.deepEqual(prefs.favoritesOf('not an id'), [], 'asking about something that is not an id is not an error');
});

test('a document keeps at most so many favourites, and when there are too many documents the one chosen from longest ago makes room', async () => {
  const { path } = await where();
  const prefs = await Preferences.open(path, { maxFavorites: 3, maxDocuments: 2 });
  for (const n of [1, 2, 3]) await prefs.setFavorite(DOC, id(n), true);
  await failing('too-many', () => prefs.setFavorite(DOC, id(4), true));
  assert.deepEqual(prefs.favoritesOf(DOC), [id(1), id(2), id(3)]);
  await prefs.setFavorite(DOC, id(1), false);
  await prefs.setFavorite(DOC, id(4), true);
  await prefs.setFavorite(OTHER, id(1), true);
  await prefs.setFavorite(id(902), id(1), true);   // a third document: the one chosen from longest ago (DOC) goes
  assert.deepEqual([prefs.favoritesOf(DOC), prefs.favoritesOf(OTHER), prefs.favoritesOf(id(902))], [[], [id(1)], [id(1)]]);
  await prefs.setFavorite(OTHER, id(2), true);       // OTHER is chosen from again, so the next to go is id(902)
  await prefs.setFavorite(DOC, id(1), true);
  assert.deepEqual([prefs.favoritesOf(OTHER), prefs.favoritesOf(id(902)), prefs.favoritesOf(DOC)], [[id(1), id(2)], [], [id(1)]]);
});

test('changes made at the same time are written one after the other, and every one of them ends up in the file', async () => {
  const { path } = await where();
  const prefs = await Preferences.open(path);
  await Promise.all(Array.from({ length: 25 }, (_, n) => prefs.setFavorite(DOC, id(n + 1), true)));
  const again = await Preferences.open(path);
  assert.deepEqual(again.favoritesOf(DOC).sort(), Array.from({ length: 25 }, (_, n) => id(n + 1)).sort());
  assert.equal(again.favoritesOf(DOC).length, 25);
});

test('a file with more than the limits allow is set aside, and one that is exactly at the limits is read', async () => {
  for (const [options, content] of [[{ maxFavorites: 2 }, { [DOC]: [id(1), id(2), id(3)] }], [{ maxDocuments: 1 }, { [DOC]: [id(1)], [OTHER]: [id(1)] }]] as const) {
    const { dir, path } = await where();
    await writeFile(path, JSON.stringify({ version: 1, favorites: content }));
    const prefs = await Preferences.open(path, options);
    assert.equal(prefs.setAside !== undefined, true, JSON.stringify(options));
    assert.deepEqual(prefs.favoritesOf(DOC), []);
    assert.ok((await readdir(dir)).some((n) => n.startsWith('preferences.json.bad-')), 'and the old file is kept');
  }
  const { path } = await where();
  await writeFile(path, JSON.stringify({ version: 1, favorites: { [DOC]: [id(1), id(2)], [OTHER]: [id(1)] } }));
  const fine = await Preferences.open(path, { maxFavorites: 2, maxDocuments: 2 });
  assert.equal(fine.setAside, undefined);
  assert.deepEqual(fine.favoritesOf(DOC), [id(1), id(2)]);
});

test('a file that cannot be read, for a reason other than being missing, is an error: it is not taken for an empty one, set aside or written over', async () => {
  const { dir, path } = await where();
  await writeFile(path, JSON.stringify({ version: 1, favorites: { [DOC]: [id(1)] } }));
  const denied: StoreFs = { ...realFs, readFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
  await failing('io', () => Preferences.open(path, { fs: denied }));
  assert.deepEqual(await readdir(dir), ['preferences.json'], 'the file is as it was');
});

test('a file that becomes unreadable while the app runs is not written over either: the change is refused, the file stays, and the next change works once it can be read', async () => {
  const { dir, path } = await where();
  let unreadable = false;
  const flaky: StoreFs = { ...realFs, readFile: async (file) => { if (unreadable) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return realFs.readFile(file); } };
  const prefs = await Preferences.open(path, { fs: flaky });
  assert.deepEqual(await prefs.setFavorite(DOC, id(1), true), [id(1)]);
  const kept = await readFile(path, 'utf8');
  unreadable = true;
  await failing('io', () => prefs.setFavorite(DOC, id(2), true));
  unreadable = false;
  assert.equal(await readFile(path, 'utf8'), kept, 'the file is as it was');
  assert.deepEqual(await readdir(dir), ['preferences.json'], 'and nothing is left beside it');
  assert.deepEqual(prefs.favoritesOf(DOC), [id(1)]);
  assert.deepEqual(await prefs.setFavorite(DOC, id(2), true), [id(1), id(2)], 'and it works again when the file can be read');
});

test('a file written by a newer version of the app is not damage and is not touched: the favourites are unavailable, with that said', async () => {
  const { dir, path } = await where();
  const text = JSON.stringify({ version: 3, favorites: { [DOC]: [id(1)] }, more: 'that this version does not know' });
  await writeFile(path, text);
  await failing('too-new', () => Preferences.open(path));
  assert.deepEqual(await readdir(dir), ['preferences.json'], 'nothing is set aside or written');
  assert.equal(await readFile(path, 'utf8'), text);
});

test('a damaged file that cannot be set aside is an error: it is not written over (nothing is lost for want of a place to keep it)', async () => {
  const { dir, path } = await where();
  await writeFile(path, '{ not json');
  const stuck: StoreFs = { ...realFs, rename: async () => { throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }); } };
  await failing('io', () => Preferences.open(path, { fs: stuck }));
  assert.deepEqual(await readdir(dir), ['preferences.json']);
  assert.equal(await readFile(path, 'utf8'), '{ not json');
});

test('a change starts from what the file holds now: two copies of the app on one file do not erase each other\'s favourites', async () => {
  const { path } = await where();
  const first = await Preferences.open(path), second = await Preferences.open(path);
  await first.setFavorite(DOC, id(1), true);
  await second.setFavorite(DOC, id(2), true);              // the second copy started before the first one wrote
  await first.setFavorite(OTHER, id(3), true);             // and the first one has not heard of it
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).favorites, { [DOC]: [id(1), id(2)], [OTHER]: [id(3)] });
  assert.deepEqual(first.favoritesOf(DOC), [id(1), id(2)], 'a copy knows what it read last');
});

test('a file that is removed, damaged or replaced by a newer version while the app runs is met at the next change: written again, set aside, or left alone', async () => {
  const { dir, path } = await where();
  const prefs = await Preferences.open(path);
  await prefs.setFavorite(DOC, id(1), true);
  await rm(path);
  await prefs.setFavorite(DOC, id(2), true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).favorites[DOC], [id(1), id(2)], 'removed: written again from what is known');
  await writeFile(path, '{ damaged by somebody');
  await prefs.setFavorite(DOC, id(3), true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).favorites[DOC], [id(1), id(2), id(3)], 'damaged: written again from what is known');
  assert.ok((await readdir(dir)).some((n) => n.startsWith('preferences.json.bad-')), 'and the damaged file is kept');
  const newer = JSON.stringify({ version: 3, favorites: {} });
  await writeFile(path, newer);
  await failing('too-new', () => prefs.setFavorite(DOC, id(4), true));
  assert.equal(await readFile(path, 'utf8'), newer, 'newer: left alone');
  assert.deepEqual(prefs.favoritesOf(DOC), [id(1), id(2), id(3)], 'and what was known is still known');
});

test('a rename that Windows refuses for a moment (EPERM, EBUSY, EACCES) is tried again a few times, and when it keeps being refused it is an error with nothing left behind', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const { dir, path } = await where();
    let refusals = 2;
    const brief: StoreFs = { ...realFs, rename: async (from, to) => { if (refusals-- > 0) throw Object.assign(new Error(code), { code }); await realFs.rename(from, to); } };
    assert.deepEqual(await (await Preferences.open(path, { fs: brief })).setFavorite(DOC, id(1), true), [id(1)], `${code} twice, then it works`);
    let attempts = 0;
    const stubborn: StoreFs = { ...realFs, rename: async () => { attempts++; throw Object.assign(new Error(code), { code }); } };
    await failing('io', async () => (await Preferences.open(path, { fs: stubborn })).setFavorite(DOC, id(2), true));
    assert.equal(attempts, 4, `${code}: one try and three more`);
    assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), [], 'no half-written file is left');
    assert.deepEqual((await Preferences.open(path)).favoritesOf(DOC), [id(1)], 'and what was written before is as it was');
  }
});

test('the folder of the file need not exist yet, and the limits are those that were chosen: 5,000 favourites in a document and 500 documents', async () => {
  const { dir } = await where();
  const path = join(dir, 'not', 'there', 'yet', 'preferences.json');
  await (await Preferences.open(path)).setFavorite(DOC, id(1), true);
  assert.deepEqual((await Preferences.open(path)).favoritesOf(DOC), [id(1)]);
  assert.deepEqual([MAX_DOCUMENTS, MAX_FAVORITES], [500, 5000]);
  for (const favorites of [Object.fromEntries(Array.from({ length: 501 }, (_, n) => [id(1000 + n), [id(1)]])), { [DOC]: Array.from({ length: 5001 }, (_, n) => id(n + 1)) }]) {
    const here = await where();
    await writeFile(here.path, JSON.stringify({ version: 1, favorites }));
    assert.equal((await Preferences.open(here.path)).setAside !== undefined, true, 'more than the default limits: set aside');
  }
  const exact = await where();
  await writeFile(exact.path, JSON.stringify({ version: 1, favorites: { [DOC]: Array.from({ length: 5000 }, (_, n) => id(n + 1)) } }));
  assert.equal((await Preferences.open(exact.path)).favoritesOf(DOC).length, 5000, 'exactly the limit is read');
});
