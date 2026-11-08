import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { realFs, type StoreFs } from '../src/documents/store.js';
import { Preferences, PreferencesError } from '../src/desktop/preferences.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DOC = id(900), OTHER = id(901);
const where = async () => { const dir = await mkdtemp(join(tmpdir(), 'rwprefs-')); return { dir, path: join(dir, 'preferences.json') }; };
const failing = (code: string, run: () => Promise<unknown>) => assert.rejects(run, (error: unknown) => error instanceof PreferencesError && error.code === code, `expected PreferencesError ${code}`);
const fileOf = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

test('saving by itself is off until it is chosen; the choice is kept for each document and is read back when the app starts again', async () => {
  const { path } = await where();
  const prefs = await Preferences.open(path);
  assert.equal(prefs.autosaveOf(DOC), undefined);
  assert.equal(await prefs.setAutosave(DOC, 'edit'), 'edit');
  assert.equal(await prefs.setAutosave(OTHER, 'close'), 'close');
  assert.deepEqual([prefs.autosaveOf(DOC), prefs.autosaveOf(OTHER), prefs.autosaveOf(id(902))], ['edit', 'close', undefined]);
  assert.deepEqual(await fileOf(path), { version: 2, favorites: {}, autosave: { [DOC]: 'edit', [OTHER]: 'close' } });
  const again = await Preferences.open(path);
  assert.deepEqual([again.autosaveOf(DOC), again.autosaveOf(OTHER)], ['edit', 'close']);
});

test('off takes the choice away, and the file is the version 1 that it was when nothing is chosen any more; choosing what is chosen already writes nothing', async () => {
  const { path } = await where();
  let renames = 0;
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { renames++; await realFs.rename(from, to); } };
  const prefs = await Preferences.open(path, { fs });
  await prefs.setFavorite(DOC, id(1), true);
  assert.deepEqual(await fileOf(path), { version: 1, favorites: { [DOC]: [id(1)] } });
  await prefs.setAutosave(DOC, 'edit');
  assert.equal((await fileOf(path)).version, 2);
  const written = renames;
  assert.equal(await prefs.setAutosave(DOC, 'edit'), 'edit');
  assert.equal(await prefs.setAutosave(OTHER, 'off'), undefined);
  assert.equal(renames, written, 'nothing was different: nothing was written');
  assert.equal(await prefs.setAutosave(DOC, 'off'), undefined);
  assert.equal(prefs.autosaveOf(DOC), undefined);
  assert.deepEqual(await fileOf(path), { version: 1, favorites: { [DOC]: [id(1)] } }, 'what a version of the app that does not know it can read');
});

test('the favourites and the choice are one file, and neither erases the other', async () => {
  const { path } = await where();
  const prefs = await Preferences.open(path);
  await prefs.setAutosave(DOC, 'close');
  await prefs.setFavorite(DOC, id(1), true);
  await prefs.setFavorite(OTHER, id(2), true);
  assert.deepEqual(await fileOf(path), { version: 2, favorites: { [DOC]: [id(1)], [OTHER]: [id(2)] }, autosave: { [DOC]: 'close' } });
  await prefs.setFavorite(DOC, id(1), false);
  assert.equal(prefs.autosaveOf(DOC), 'close');
  assert.deepEqual(prefs.favoritesOf(DOC), []);
});

test('an id that is not an id and a mode that is not a mode are refused before anything is written', async () => {
  const { dir, path } = await where();
  const prefs = await Preferences.open(path);
  await failing('invalid', () => prefs.setAutosave('not an id', 'edit'));
  await failing('invalid', () => prefs.setAutosave(DOC, 'always' as never));
  await failing('invalid', () => prefs.setAutosave(DOC, '__proto__' as never));
  assert.deepEqual(await readdir(dir), []);
});

test('a version 1 file is read as it is; a version 2 file whose choices are not modes of documents is damage and is set aside; a version 3 file is newer and is left alone', async () => {
  const { dir, path } = await where();
  await writeFile(path, JSON.stringify({ version: 1, favorites: { [DOC]: [id(1)] } }));
  const old = await Preferences.open(path);
  assert.deepEqual([old.favoritesOf(DOC), old.autosaveOf(DOC)], [[id(1)], undefined]);
  const bad = [JSON.stringify({ version: 2, favorites: {} }), JSON.stringify({ version: 2, favorites: {}, autosave: [] }), JSON.stringify({ version: 2, favorites: {}, autosave: null }),
    JSON.stringify({ version: 2, favorites: {}, autosave: { [DOC]: 'always' } }), JSON.stringify({ version: 2, favorites: {}, autosave: { [DOC]: 'off' } }), JSON.stringify({ version: 2, favorites: {}, autosave: { 'not an id': 'edit' } }), JSON.stringify({ version: 2, favorites: {}, autosave: { [DOC]: 1 } })];
  for (const text of bad) {
    await writeFile(path, text);
    const prefs = await Preferences.open(path);
    assert.equal(prefs.autosaveOf(DOC), undefined, text);
    assert.ok(prefs.setAside !== undefined, `set aside: ${text}`);
    assert.equal(await readFile(prefs.setAside!, 'utf8'), text, 'kept as it was');
  }
  const aside = await readdir(dir);
  const newer = JSON.stringify({ version: 3, favorites: {}, autosave: { [DOC]: 'edit' } });
  await writeFile(path, newer);
  await failing('too-new', () => Preferences.open(path));
  assert.equal(await readFile(path, 'utf8'), newer);
  assert.deepEqual((await readdir(dir)).sort(), [...aside, 'preferences.json'].sort(), 'and nothing was set aside for it');
});

test('a change starts from what the file holds now: another copy of the app that chose for another document is not erased, and a file that is gone is written again from what is known', async () => {
  const { path } = await where();
  const first = await Preferences.open(path), second = await Preferences.open(path);
  await first.setAutosave(DOC, 'edit');
  await second.setAutosave(OTHER, 'close');
  await first.setFavorite(DOC, id(1), true);
  assert.deepEqual((await fileOf(path)).autosave, { [DOC]: 'edit', [OTHER]: 'close' });
  assert.deepEqual([first.autosaveOf(OTHER), second.autosaveOf(DOC)], ['close', 'edit'], 'each copy knows what the file held when it last changed it');
  await rm(path);
  await first.setAutosave(id(902), 'edit');
  assert.deepEqual((await fileOf(path)).autosave, { [DOC]: 'edit', [OTHER]: 'close', [id(902)]: 'edit' });
});

test('changes made at the same time are all written, one after the other; a write that fails leaves the choice as it was', async () => {
  const { path } = await where();
  let fail = false;
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (fail) throw Object.assign(new Error('EIO'), { code: 'EIO' }); await realFs.rename(from, to); } };
  const prefs = await Preferences.open(path, { fs });
  await Promise.all([prefs.setAutosave(DOC, 'edit'), prefs.setAutosave(OTHER, 'close'), prefs.setFavorite(DOC, id(1), true)]);
  assert.deepEqual(await fileOf(path), { version: 2, favorites: { [DOC]: [id(1)] }, autosave: { [DOC]: 'edit', [OTHER]: 'close' } });
  fail = true;
  await failing('io', () => prefs.setAutosave(DOC, 'off'));
  assert.equal(prefs.autosaveOf(DOC), 'edit', 'in memory too');
  fail = false;
  assert.equal(await prefs.setAutosave(DOC, 'off'), undefined);
});

test('a choice is refused rather than another one forgotten when there are too many documents', async () => {
  const { path } = await where();
  const prefs = await Preferences.open(path, { maxDocuments: 2 });
  await prefs.setAutosave(id(1), 'edit');
  await prefs.setAutosave(id(2), 'close');
  await failing('too-many', () => prefs.setAutosave(id(3), 'edit'));
  assert.deepEqual([prefs.autosaveOf(id(1)), prefs.autosaveOf(id(2)), prefs.autosaveOf(id(3))], ['edit', 'close', undefined]);
  assert.equal(await prefs.setAutosave(id(1), 'close'), 'close', 'one that has a choice can change it');
  assert.equal(await prefs.setAutosave(id(2), 'off'), undefined);
  assert.equal(await prefs.setAutosave(id(3), 'edit'), 'edit', 'and there is room again');
  await writeFile(path, JSON.stringify({ version: 2, favorites: {}, autosave: { [id(1)]: 'edit', [id(2)]: 'edit', [id(3)]: 'edit' } }));
  const crowded = await Preferences.open(path, { maxDocuments: 2 });
  assert.ok(crowded.setAside !== undefined, 'a file with more than the limit is set aside, as the favourites are');
});

test('a file with exactly as many choices as may be kept is read; one with more is damage', async () => {
  const { dir, path } = await where();
  await writeFile(path, JSON.stringify({ version: 2, favorites: {}, autosave: { [DOC]: 'edit', [OTHER]: 'close' } }));
  const exact = await Preferences.open(path, { maxDocuments: 2 });
  assert.deepEqual([exact.autosaveOf(DOC), exact.autosaveOf(OTHER)], ['edit', 'close']);
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.bad-')), []);
  await writeFile(path, JSON.stringify({ version: 2, favorites: {}, autosave: { [DOC]: 'edit', [OTHER]: 'close', [id(902)]: 'edit' } }));
  const more = await Preferences.open(path, { maxDocuments: 2 });
  assert.equal(more.autosaveOf(DOC), undefined);
  assert.equal((await readdir(dir)).filter((name) => name.includes('.bad-')).length, 1, 'set aside, not thrown away');
});
