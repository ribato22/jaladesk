import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_RECENT } from '../src/desktop/commands.js';
import { CHOICE_MS, MAX_FILE_BYTES, Recent, recentLabels, type RecentItem } from '../src/desktop/recent.js';
import { realFs, type StoreFs } from '../src/documents/store.js';

const mulberry32 = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const where = async () => { const dir = await mkdtemp(join(tmpdir(), 'rwrecent-')); return { dir, path: join(dir, 'recent.json') }; };
const text = (path: string) => readFile(path, 'utf8');
const doc = (n: number): RecentItem => ({ path: `/dokumen/berkas-${n}.rwdoc` });
const eio = () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
/** A file system that can be told to fail. */
function failing() {
  const state = { rename: false, read: false, renames: 0 };
  const fs: StoreFs = {
    ...realFs,
    rename: async (from, to) => { state.renames++; if (state.rename) throw eio(); await realFs.rename(from, to); },
    readFile: async (path) => { if (state.read) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return realFs.readFile(path); },
  };
  return { fs, state };
}

// The list of recent documents holds PATHS and nothing else: the name of a document is inside the encrypted file, and a list in the clear that told it would tell what the file keeps secret.
test('without a file the list is empty, and nothing is written until a document is added', async () => {
  const { dir, path } = await where();
  const recent = await Recent.open(path);
  assert.deepEqual(recent.list(), []);
  assert.deepEqual(await readdir(dir), []);
});

test('a document that is added goes to the top, is kept in the file as a path and nothing else, and is read back when the app starts again', async () => {
  const { path } = await where();
  const recent = await Recent.open(path);
  assert.equal(await recent.add(doc(1).path), true);
  assert.equal(await recent.add(doc(2).path), true);
  assert.deepEqual(recent.list(), [doc(2), doc(1)]);
  assert.equal(await text(path), `{"version":1,"items":[{"path":"${doc(2).path}"},{"path":"${doc(1).path}"}]}\n`);
  assert.deepEqual((await Recent.open(path)).list(), [doc(2), doc(1)]);
});

test('a file that an earlier version wrote with names in it is read for its paths, and the names are gone from the next file that is written', async () => {
  const { path } = await where();
  await writeFile(path, JSON.stringify({ version: 1, items: [{ path: '/a/x.rwdoc', name: 'Server produksi bank' }, { path: '/a/y.rwdoc', name: 'Lain' }] }));
  const recent = await Recent.open(path);
  assert.deepEqual(recent.list(), [{ path: '/a/x.rwdoc' }, { path: '/a/y.rwdoc' }]);
  await recent.add('/a/z.rwdoc');
  assert.equal(await text(path), '{"version":1,"items":[{"path":"/a/z.rwdoc"},{"path":"/a/x.rwdoc"},{"path":"/a/y.rwdoc"}]}\n');
  assert.ok(!(await text(path)).includes('produksi'));
});

test('the same file added again moves to the top; on Windows and macOS a different case is the same file, on macOS a different normalisation of the same letters too, on Linux none of that is', async () => {
  const nfc = '/dokumen/caf\u00e9.rwdoc', nfd = '/dokumen/cafe\u0301.rwdoc';
  for (const [platform, sameCase, sameForm] of [['win32', true, false], ['darwin', true, true], ['linux', false, false]] as const) {
    const { path } = await where();
    const recent = await Recent.open(path, { platform });
    await recent.add('/Dokumen/Kantor.rwdoc');
    await recent.add('/dokumen/lain.rwdoc');
    await recent.add('/dokumen/kantor.rwdoc');
    assert.equal(recent.list().length, sameCase ? 2 : 3, platform);
    assert.deepEqual(recent.list()[0], { path: '/dokumen/kantor.rwdoc' }, platform);
    const forms = await Recent.open((await where()).path, { platform });
    await forms.add(nfc);
    await forms.add(nfd);
    assert.equal(forms.list().length, sameForm ? 1 : 2, `${platform}: the same letters written another way`);
  }
  const { path } = await where();
  const recent = await Recent.open(path);
  await recent.add('/a/../a/x.rwdoc');
  await recent.add('/a/x.rwdoc');
  assert.deepEqual(recent.list(), [{ path: '/a/x.rwdoc' }], 'a path is compared as it resolves');
});

test('the list holds ten, and the oldest falls off the end', async () => {
  const { path } = await where();
  const recent = await Recent.open(path);
  for (let n = 1; n <= 13; n++) await recent.add(doc(n).path);
  assert.equal(MAX_RECENT, 10);
  assert.deepEqual(recent.list().map((i) => i.path), Array.from({ length: 10 }, (_, k) => doc(13 - k).path));
  assert.equal(JSON.parse(await text(path)).items.length, 10);
});

test('a file of a newer version is not believed even if its items are good, and neither is one with no version', async () => {
  const { path } = await where();
  await writeFile(path, JSON.stringify({ version: 2, items: [{ path: '/a/x.rwdoc' }] }));
  assert.deepEqual((await Recent.open(path)).list(), [], 'a newer file is not a list of ours');
  await writeFile(path, JSON.stringify({ items: [{ path: '/a/x.rwdoc' }] }));
  assert.deepEqual((await Recent.open(path)).list(), [], 'and neither is a file with no version');
});

test('a file whose size cannot be asked is still not read when it is too big once read', async () => {
  const { path } = await where();
  const items = Array.from({ length: 10 }, (_, n) => ({ path: `/a/${n}.rwdoc` }));
  await writeFile(path, JSON.stringify({ version: 1, items, pad: 'x'.repeat(70 * 1024) }));
  const blind: StoreFs = { ...realFs, stat: async () => ({ mtimeMs: 0 }) };
  assert.deepEqual((await Recent.open(path, { fs: blind })).list(), [], 'too big, whatever stat says');
  await writeFile(path, JSON.stringify({ version: 1, items: items.slice(0, 2) }));
  assert.equal((await Recent.open(path, { fs: blind })).list().length, 2, 'and a file that is not too big is read');
});

test('a document that is already first and is added again changes nothing: nothing is written and nobody is told', async () => {
  const { path } = await where();
  const recent = await Recent.open(path);
  await recent.add('/a/x.rwdoc');
  const heard: number[] = [];
  recent.subscribe((items) => heard.push(items.length));
  const writes: string[] = [];
  const watching: StoreFs = { ...realFs, rename: async (from, to) => { writes.push(to); await realFs.rename(from, to); } };
  const again = await Recent.open(path, { fs: watching });
  assert.equal(await again.add('/a/x.rwdoc'), true);
  assert.deepEqual(writes, [], 'the same list: no write');
  assert.equal(await recent.add('/a/x.rwdoc'), true);
  assert.deepEqual(heard, [], 'nothing changed: nobody is told');
  await recent.add('/a/y.rwdoc');
  assert.deepEqual(heard, [2], 'another document is a change');
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
  const recent = await Recent.open(path, { fs });
  assert.equal(await recent.add(doc(1).path), true);
  assert.deepEqual(calls, ['mkdir', 'open wx 600', 'write', 'sync', 'close', 'rename', 'syncDir']);
});

test('a folder that cannot be synced does not make a change that was written fail, and the folder that is synced is the folder of the file', async () => {
  const { dir, path } = await where();
  const synced: string[] = [];
  const fs: StoreFs = { ...realFs, syncDir: async (folder) => { synced.push(folder); throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); } };
  const recent = await Recent.open(path, { fs });
  assert.equal(await recent.add(doc(1).path), true, 'the change was written');
  assert.deepEqual(JSON.parse(await text(path)), { version: 1, items: [doc(1)] });
  assert.deepEqual(synced, [dir], 'the folder is synced, not the file');
});

test('on Linux two paths are the same file when they resolve to the same path, and a path of another case is another file', async () => {
  const { path } = await where();
  const recent = await Recent.open(path, { platform: 'linux' });
  await recent.add('/a/../a/x.rwdoc');
  await recent.add('/a/x.rwdoc');
  assert.deepEqual(recent.list(), [{ path: '/a/x.rwdoc' }]);
  await recent.add('/a/X.rwdoc');
  assert.equal(recent.list().length, 2);
});

test('changes are written in the order they were asked for even if an earlier write is held up, and the file is made for its owner only', async () => {
  const { path } = await where();
  const modes: number[] = [];
  const written = new Map<string, string>();      // what each temporary file holds, and what the file holds after the renames: in memory, so that nothing here waits for the disk
  const renames: string[] = [];
  let letGo: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { letGo = resolve; });
  const held: StoreFs = {
    ...realFs,
    mkdir: async () => undefined,
    open: async (p, _flags, mode) => {
      modes.push(mode);
      return { writeFile: async (data) => { written.set(p, Buffer.from(data).toString('utf8')); }, sync: async () => undefined, close: async () => undefined };
    },
    rename: async (from, to) => { renames.push(from); if (renames.length === 1) await gate; written.set(to, written.get(from)!); written.delete(from); },
    syncDir: async () => undefined,
    unlink: async () => undefined,
  };
  const recent = await Recent.open(path, { fs: held });
  const both = Promise.all([recent.add(doc(1).path), recent.add(doc(2).path)]);
  await new Promise((resolve) => setImmediate(resolve));      // everything that can run without the gate has run: it is all promises, with no disk and no timer in between
  assert.equal(renames.length, 1, 'the second change waits for the first: only one write has got as far as its rename');
  letGo();
  await both;
  assert.equal(renames.length, 2);
  assert.deepEqual(JSON.parse(written.get(path)!), { version: 1, items: [doc(2), doc(1)] }, 'the last change is the file, however long the first was held up');
  assert.deepEqual(modes, [0o600, 0o600], 'a file only its owner can read: it holds the folders of a person');
});

test('a document is taken off the list, and the list is cleared; both are kept', async () => {
  const { path } = await where();
  const recent = await Recent.open(path);
  for (const n of [1, 2, 3]) await recent.add(doc(n).path);
  assert.equal(await recent.remove(doc(2).path), true);
  assert.deepEqual(recent.list(), [doc(3), doc(1)]);
  assert.equal(await recent.remove('/tidak/ada.rwdoc'), true, 'taking off what is not there is not a failure');
  assert.deepEqual((await Recent.open(path)).list(), [doc(3), doc(1)]);
  assert.equal(await recent.clear(), true);
  assert.deepEqual(recent.list(), []);
  assert.equal(await text(path), '{"version":1,"items":[]}\n');
  assert.deepEqual((await Recent.open(path)).list(), []);
});

test('a file that cannot be understood is an empty list and nothing more: the list is a convenience, so it is replaced at the next change and nobody is told', async () => {
  const { path } = await where();
  for (const bad of ['', 'not json', '[]', '{}', '{"version":2,"items":[]}', '{"version":1}', '{"version":1,"items":3}', '"x"', 'null', '\u0000\u0000']) {
    await writeFile(path, bad);
    const recent = await Recent.open(path);
    assert.deepEqual(recent.list(), [], JSON.stringify(bad));
    await recent.add(doc(1).path);
    assert.deepEqual((await Recent.open(path)).list(), [doc(1)], 'and the next change writes a good file');
  }
});

test('an item of the file that is not a document is left out and the rest are kept: a path that is not absolute, not text, with a NUL, too long, a repeat', async () => {
  const { path } = await where();
  const items = [{ path: doc(1).path }, { path: 'relatif/x.rwdoc' }, { path: 3 }, {}, null, 'x', [], { path: '/a\u0000b.rwdoc' }, { path: `/${'a'.repeat(5000)}` }, { path: '' }, { path: doc(1).path }, { path: doc(7).path }];
  await writeFile(path, JSON.stringify({ version: 1, items }));
  assert.deepEqual((await Recent.open(path)).list(), [doc(1), doc(7)]);
  await writeFile(path, JSON.stringify({ version: 1, items: Array.from({ length: 30 }, (_, k) => doc(k + 1)) }));
  assert.equal((await Recent.open(path)).list().length, 10, 'a file with more than the menu holds is cut');
  await writeFile(path, `\uFEFF${JSON.stringify({ version: 1, items: [doc(1)] })}`);
  assert.deepEqual((await Recent.open(path)).list(), [doc(1)], 'a byte order mark in front is not a damaged file');
  await writeFile(path, `{"version":1,"items":[${'{"path":"/x"},'.repeat(10000)}{"path":"/x"}]}`);
  assert.deepEqual((await Recent.open(path)).list(), [], 'a file far bigger than ten items can hold is not read');
});

test('what is added must be a path the list can hold: one that is not absolute, is empty, has a NUL or is too long is refused and changes nothing', async () => {
  const { path } = await where();
  const recent = await Recent.open(path);
  await recent.add(doc(1).path);
  for (const p of ['relatif.rwdoc', '', '/x\u0000.rwdoc', `/${'a'.repeat(5000)}`]) assert.equal(await recent.add(p), false, p.slice(0, 20));
  assert.equal(await recent.add(`/${'a'.repeat(4000)}`), true, 'a long path that is allowed');
  assert.deepEqual(recent.list().length, 2);
  assert.deepEqual((await Recent.open(path)).list().length, 2);
});

test('a list that cannot be written is still the list for as long as the app runs, and saying so is all that happens; the next change that can be written writes it all', async () => {
  const { path } = await where();
  const { fs, state } = failing();
  const recent = await Recent.open(path, { fs });
  await recent.add(doc(1).path);
  state.rename = true;
  assert.equal(await recent.add(doc(2).path), false);
  assert.deepEqual(recent.list(), [doc(2), doc(1)], 'the menu still has it');
  assert.deepEqual((await readdir(join(path, '..'))).filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left (looked at before the list is opened again, which would sweep it)');
  assert.deepEqual((await Recent.open(path)).list(), [doc(1)], 'but the file does not have it');
  state.rename = false;
  assert.equal(await recent.add(doc(3).path), true);
  assert.deepEqual((await Recent.open(path)).list(), [doc(3), doc(2), doc(1)]);
  state.read = true;
  assert.deepEqual((await Recent.open(path, { fs })).list(), [], 'a file that cannot be read is an empty list');
});

test('a write that failed is tried again by the next request even if that changes nothing in memory, so that clearing a list the file still holds is not forgotten', async () => {
  const { path } = await where();
  const { fs, state } = failing();
  const recent = await Recent.open(path, { fs });
  const heard: number[] = [];
  recent.subscribe((items) => heard.push(items.length));
  await recent.add(doc(1).path);
  state.rename = true;
  assert.equal(await recent.clear(), false, 'the list is empty in memory, the file still holds the document');
  assert.deepEqual(recent.list(), []);
  assert.equal(await recent.clear(), false, 'and it says so again while the file cannot be written');
  assert.deepEqual(heard, [1, 0], 'the retry changes nothing in the list, so nobody is told again');
  assert.deepEqual((await Recent.open(path)).list(), [doc(1)]);
  state.rename = false;
  assert.equal(await recent.clear(), true, 'an empty list cleared again is written, because the file is not what the list is');
  assert.deepEqual((await Recent.open(path)).list(), [], 'and now the file is empty too');
  const written = state.renames;
  assert.equal(await recent.clear(), true);
  assert.equal(state.renames, written, 'once the file is what the list is, a request that changes nothing writes nothing');
  const writes: string[] = [];
  const watching: StoreFs = { ...realFs, rename: async (from, to) => { writes.push(to); await realFs.rename(from, to); } };
  const quiet = await Recent.open(path, { fs: watching });
  await quiet.clear();
  assert.deepEqual(writes, [], 'when the file is what the list is, nothing is written');
});

test('the leftovers of writes that stopped are swept when the list is opened, and nothing else in the folder is touched', async () => {
  const { dir, path } = await where();
  const mine = [`recent.json.${'a'.repeat(12)}.tmp`, `recent.json.${'0123456789ab'}.tmp`];
  const others = ['recent.json.tmp', 'recent.json.zzzzzzzzzzzz.tmp', `recent.json.${'a'.repeat(11)}.tmp`, `recent.json.${'a'.repeat(13)}.tmp`, `settings.json.${'a'.repeat(12)}.tmp`, `${'x'.repeat(11)}.${'a'.repeat(12)}.tmp`, 'notes.txt', `recent.json.${'a'.repeat(12)}.tmp.bak`];
  for (const name of [...mine, ...others]) await writeFile(join(dir, name), 'x');
  await writeFile(path, JSON.stringify({ version: 1, items: [doc(1)] }));
  const recent = await Recent.open(path);
  assert.deepEqual(recent.list(), [doc(1)]);
  assert.deepEqual((await readdir(dir)).sort(), ['recent.json', ...others].sort());
  await Recent.open(join(dir, 'in', 'nowhere', 'recent.json'));       // a folder that is not there is not a failure
});

test('changes that come one after the other are written in the order they came, and the file is the last of them', async () => {
  const { path } = await where();
  const recent = await Recent.open(path);
  const results = await Promise.all([recent.add(doc(1).path), recent.add(doc(2).path), recent.remove(doc(1).path), recent.add(doc(3).path), recent.add(doc(2).path)]);
  assert.deepEqual(results, [true, true, true, true, true]);
  assert.deepEqual(recent.list(), [doc(2), doc(3)]);
  assert.deepEqual((await Recent.open(path)).list(), [doc(2), doc(3)]);
});

test('whoever follows the list is told of every change, and not of what changes nothing', async () => {
  const { path } = await where();
  const recent = await Recent.open(path);
  const heard: number[] = [];
  const stop = recent.subscribe((items) => heard.push(items.length));
  await recent.add(doc(1).path);
  await recent.add(doc(1).path);
  await recent.add(doc(2).path);
  await recent.remove('/tidak/ada.rwdoc');
  await recent.clear();
  await recent.clear();
  assert.deepEqual(heard, [1, 2, 0], 'adding the same document again, taking off what is not there and clearing an empty list change nothing');
  stop();
  await recent.add(doc(3).path);
  assert.deepEqual(heard, [1, 2, 0]);
  recent.subscribe(() => { throw new Error('a follower that fails'); });
  assert.equal(await recent.add(doc(4).path), true, 'is its own trouble');
});

test('a list that is only kept while the app runs works the same without a file', async () => {
  const recent = Recent.memory();
  await recent.add(doc(1).path);
  await recent.add(doc(2).path);
  assert.deepEqual(recent.list(), [doc(2), doc(1)]);
  assert.equal(await recent.clear(), true);
  assert.deepEqual(recent.list(), []);
});

test('what is handed out is a copy: changing it does not change the list', async () => {
  const recent = Recent.memory();
  await recent.add(doc(1).path);
  const list = recent.list() as RecentItem[];
  list.push(doc(9));
  (list[0] as { path: string }).path = '/changed.rwdoc';
  assert.deepEqual(recent.list(), [doc(1)]);
});

// The window cannot open a recent document by itself: only a click of the person on its place in the menu lets it, once, for a few seconds.
test('a place the person chose lets that document be opened once, and nothing else: not another document, not a second time, not later', async () => {
  let now = 1_000_000;
  const recent = Recent.memory({ now: () => now });
  for (const n of [1, 2, 3]) await recent.add(doc(n).path);      // [3, 2, 1]
  assert.equal(CHOICE_MS, 10_000);
  assert.equal(recent.chosen(doc(3).path), false, 'nobody chose');
  recent.choose(1);
  assert.equal(recent.chosen(doc(3).path), false, 'a document other than the one chosen');
  assert.equal(recent.chosen(doc(2).path), true);
  assert.equal(recent.chosen(doc(2).path), false, 'used up');
  recent.choose(0);
  recent.choose(2);
  assert.equal(recent.chosen(doc(3).path), false, 'a later choice takes the place of an earlier one');
  assert.equal(recent.chosen(doc(1).path), true);
  recent.choose(0);
  now += CHOICE_MS;
  assert.equal(recent.chosen(doc(3).path), true, 'still good at the last moment');
  recent.choose(0);
  now += CHOICE_MS + 1;
  assert.equal(recent.chosen(doc(3).path), false, 'but not after it');
  recent.choose(0);
  assert.equal(recent.chosen('/dokumen/../dokumen/berkas-3.rwdoc'), true, 'the same file spelled another way is the same file');
});

test('a place with no document behind it, or one that is not a place, chooses nothing, and a choice is made nothing by the list changing', async () => {
  const recent = Recent.memory();
  await recent.add(doc(1).path);
  for (const place of [1, 5, 9, -1, 10, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    recent.choose(0);
    recent.choose(place);
    assert.equal(recent.chosen(doc(1).path), false, `place ${place}: an earlier choice does not survive a later one that is nothing`);
  }
  recent.choose(0);
  await recent.remove(doc(1).path);
  await recent.add(doc(2).path);
  assert.equal(recent.chosen(doc(1).path), true, 'what the person chose is the document they saw, whatever the list is now');
  assert.equal(recent.chosen(doc(2).path), false);
});

// The words of the menu are made from the names of the files: the list holds no other name.
test('the words of the menu are the names of the files without their ending, with the folder said when two have the same name, and the two folders above it when that is the same too', () => {
  const item = (path: string): RecentItem => ({ path });
  assert.deepEqual(recentLabels([item('/a/kantor.rwdoc'), item('/a/rumah.RWDOC'), item('/a/tanpa-akhiran')]), ['kantor', 'rumah', 'tanpa-akhiran']);
  assert.deepEqual(recentLabels([item('/kantor/x.rwdoc'), item('/rumah/x.rwdoc'), item('/rumah/y.rwdoc')]), ['x — kantor', 'x — rumah', 'y']);
  assert.deepEqual(recentLabels([item('/a/kantor/x.rwdoc'), item('/b/kantor/x.rwdoc'), item('/b/rumah/x.rwdoc')]), ['x — a/kantor', 'x — b/kantor', 'x — rumah'], 'two that share the folder name are told apart by the one above it, and the one that is told apart already is left as it is');
  assert.deepEqual(recentLabels([]), []);
  assert.deepEqual(recentLabels([item('/x.rwdoc')]), ['x']);
  assert.deepEqual(recentLabels([item('/.rwdoc')]), ['.rwdoc'], 'a file that is nothing but its ending is called that');
});

test('the words of the menu are fit to be a menu item: an ampersand is always doubled, control characters are spaces, marks that turn the text round or hide are taken out, and a name of nothing is the file name', () => {
  const label = (name: string) => recentLabels([{ path: `/a/${name}.rwdoc` }])[0]!;
  assert.equal(label('Tom & Jerry'), 'Tom && Jerry', 'on every platform: the menu of Electron takes a lone ampersand for the mark of a key, also on the Mac');
  assert.equal(label('a&&b'), 'a&&&&b');
  assert.equal(label('baris\nbaru\tdan\u0007bel'), 'baris baru dan bel');
  assert.equal(label('hapus\u007fini'), 'hapus ini');
  assert.equal(label('garis\u2028baru\u2029lagi'), 'garis baru lagi');
  assert.equal(label('kendali\u0085c1\u009fdua'), 'kendali c1 dua', 'the controls of the second block too');
  assert.equal(label('abc\u202edef'), 'abcdef', 'the mark that makes a name read backwards is taken out');
  assert.equal(label('a\u200eb\u200fc\u202ad\u202be\u2066f\u2067g\u2068h\u2069i\u061cj\ufeffk'), 'abcdefghijk');
  assert.equal(label('zwj\u200dzwnj\u200c'), 'zwj\u200dzwnj\u200c', 'the joiners that some scripts need stay');
  assert.equal(recentLabels([{ path: '/a/ \t .rwdoc' }])[0], '.rwdoc', 'a name of blanks is the file name');
});

test('a long name is cut, the part that tells two apart is kept, and a pair of halves is one character', () => {
  const long = recentLabels([{ path: `/a/${'n'.repeat(100)}.rwdoc` }])[0]!;
  assert.equal(Array.from(long).length, 60);
  assert.ok(long.endsWith('…'));
  const emoji = recentLabels([{ path: `/a/${'😀'.repeat(100)}.rwdoc` }])[0]!;
  assert.equal(Array.from(emoji).length, 60, 'counted in characters, not in halves of one');
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no half of a pair is left at the cut');
  const same = recentLabels([{ path: `/kantor/${'n'.repeat(100)}.rwdoc` }, { path: `/rumah/${'n'.repeat(100)}.rwdoc` }]);
  assert.ok(same[0]!.endsWith(' — kantor') && same[1]!.endsWith(' — rumah'), 'the folder is what tells them apart, so the name gives way and the folder stays');
  assert.ok(same.every((l) => Array.from(l).length <= 60));
  assert.notEqual(same[0], same[1]);
  const deep = recentLabels([{ path: `/${'k'.repeat(70)}/x.rwdoc` }, { path: `/${'l'.repeat(70)}/x.rwdoc` }]);
  assert.ok(deep.every((l) => Array.from(l).length <= 60) && deep[0] !== deep[1], 'a folder name too long to keep is cut too, and the labels stay two');
});

test('two documents that cannot be told apart by their folders get a number, and whatever the list holds the labels are different and fit a menu', () => {
  const same = recentLabels([{ path: '/a/x/b/f.rwdoc' }, { path: '/c/x/b/f.rwdoc' }, { path: '/d/x/b/f.rwdoc' }]);
  assert.equal(new Set(same).size, 3);
  assert.equal(same[0], 'f — x/b', 'the newest keeps the plain words');
  assert.deepEqual(same.slice(1), ['f — x/b (2)', 'f — x/b (3)']);
  const random = mulberry32(11);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  for (let round = 0; round < 300; round++) {
    const items: RecentItem[] = [];
    for (let n = 0; n < 1 + Math.floor(random() * 10); n++) items.push({ path: `/${pick(['a', 'b', 'a'])}/${pick(['x', 'y', 'x'])}/${pick(['k', 'm'])}/${pick(['f', 'g', 'f', 'p'.repeat(80)])}.rwdoc` });
    const unique = [...new Map(items.map((i) => [i.path, i])).values()];
    const labels = recentLabels(unique);
    assert.equal(new Set(labels).size, unique.length, JSON.stringify(unique));
    for (const label of labels) {
      assert.ok(Array.from(label.replace(/&&/g, '&')).length <= 60, label);
      assert.doesNotMatch(label, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    }
  }
});

test('a document in the top folder is told by that folder when another file has the same name', () => {
  assert.deepEqual(recentLabels([{ path: '/x.rwdoc' }, { path: '/a/x.rwdoc' }]), ['x — /', 'x — a']);
});

test('what tells two documents apart is counted in characters too: a folder named with pairs of halves leaves the room it should', () => {
  const folder = '😀'.repeat(10), other = '😁'.repeat(10);
  const labels = recentLabels([{ path: `/${folder}/${'n'.repeat(100)}.rwdoc` }, { path: `/${other}/${'n'.repeat(100)}.rwdoc` }]);
  assert.deepEqual(labels.map((label) => Array.from(label).length), [60, 60], 'each label fills the room of a menu item and not more');
  assert.ok(labels[0]!.endsWith(` — ${folder}`) && labels[1]!.endsWith(` — ${other}`));
});

// What the review after the execution (23 October 2026) found: the labels of long folders, a name of nothing that can be seen, and limits and defaults that nothing pinned.

test('what tells two documents apart is squeezed in the middle when it is too long, so that either end of a path stays, and the number is never cut', () => {
  const at = (folder: string): RecentItem => ({ path: `/data/${folder}/x.rwdoc` });
  const k = 'k'.repeat(70);
  const ends = recentLabels([at(`${k}A`), at(`${k}B`)]);
  assert.notEqual(ends[0], ends[1], 'folders that differ only at their end are two labels');
  assert.ok(ends[0]!.endsWith('A') && ends[1]!.endsWith('B'), 'the end of the folder is kept');
  const starts = recentLabels([at(`A${k}`), at(`B${k}`)]);
  assert.ok(starts[0] !== starts[1] && starts[0]!.includes('A') && starts[1]!.includes('B'), 'and so is the start of it');
  const middle = (n: number) => at(`A${'k'.repeat(40)}${n}${'k'.repeat(40)}Z`);
  const hidden = recentLabels([middle(1), middle(2)]);
  assert.ok(hidden[0] !== hidden[1] && hidden[1]!.endsWith(' (2)'), 'what the squeeze takes away leaves the number to tell them apart, and the number stays whole');
  assert.equal(hidden[0], `x — A${'k'.repeat(27)}…${'k'.repeat(26)}Z`, 'the room is the 60 of a menu item: the name, the dash, the folder squeezed to what is left');
  assert.equal(hidden[1], `x — A${'k'.repeat(25)}…${'k'.repeat(24)}Z (2)`, 'and the number takes its room first, so the folder is squeezed a little more');
  const ten = recentLabels(Array.from({ length: 10 }, (_, n) => middle(n)));
  assert.equal(new Set(ten).size, 10);
  assert.ok(ten[9]!.endsWith(' (10)'), 'the longest number a menu needs is whole too');
  const named = recentLabels([{ path: `/data/${k}A/${'n'.repeat(30)}.rwdoc` }, { path: `/data/${k}B/${'n'.repeat(30)}.rwdoc` }]);
  assert.ok(named.every((label) => label.startsWith(`${'n'.repeat(7)}… — `)), 'a long name keeps only its start, and the room goes to what tells the two apart');
  for (const label of [...ends, ...starts, ...hidden, ...ten, ...named]) assert.ok(Array.from(label).length <= 60, label);
});

test('a name gives way to what tells it apart down to a few characters and no further: the folder stays whole while there is room for the start of the name', () => {
  const folder = 'f'.repeat(37);      // " — " and the folder take 40 of the 60 characters
  const labels = recentLabels([{ path: `/${folder}/${'n'.repeat(100)}.rwdoc` }, { path: `/other/${'n'.repeat(100)}.rwdoc` }]);
  assert.equal(labels[0], `${'n'.repeat(19)}… — ${folder}`, 'twenty characters are left for the name, and the folder is whole');
  assert.equal(labels[1], `${'n'.repeat(51)}… — other`);
});

test('a name of nothing that can be seen is the path, and the path is made fit for a menu too', () => {
  assert.equal(recentLabels([{ path: '/x‮y/‎' }])[0], '/xy/', 'no mark that turns the text round is left in what stands for the name');
  assert.equal(recentLabels([{ path: '/a/\u0007\u0008' }])[0], '/a/', 'and no control character');
});

test('a document directly under the root is told by its folder alone when the folder above is asked for, with no empty piece before it', () => {
  assert.deepEqual(recentLabels([{ path: '/q/f.rwdoc' }, { path: '/z/q/f.rwdoc' }]), ['f — q', 'f — z/q']);
});

test('the limits are exact: a file of 64 KiB is read and one byte more is not, a path of 4096 characters is held and one more is not', async () => {
  const { path } = await where();
  const sized = (bytes: number) => {
    const base = JSON.stringify({ version: 1, items: [doc(1)], pad: '' });
    return JSON.stringify({ version: 1, items: [doc(1)], pad: 'x'.repeat(bytes - Buffer.byteLength(base)) });
  };
  assert.equal(Buffer.byteLength(sized(MAX_FILE_BYTES)), MAX_FILE_BYTES);
  const blind: StoreFs = { ...realFs, stat: async () => ({ mtimeMs: 0 }) };
  for (const [fs, how] of [[realFs, 'by its size'], [blind, 'by reading it']] as const) {
    await writeFile(path, sized(MAX_FILE_BYTES));
    assert.deepEqual((await Recent.open(path, { fs })).list(), [doc(1)], `exactly the limit is read (judged ${how})`);
    await writeFile(path, sized(MAX_FILE_BYTES + 1));
    assert.deepEqual((await Recent.open(path, { fs })).list(), [], `and one byte more is not (judged ${how})`);
  }
  const long = (n: number) => `/${'a'.repeat(n - 1)}.rwdoc`.slice(0, n);      // exactly n characters, absolute
  assert.equal(long(4096).length, 4096);
  const recent = Recent.memory();
  assert.equal(await recent.add(long(4096)), true, '4096 characters are held');
  assert.equal(await recent.add(long(4097)), false, 'and 4097 are not');
  await writeFile(path, JSON.stringify({ version: 1, items: [{ path: long(4097) }, { path: long(4096) }] }));
  assert.deepEqual((await Recent.open(path)).list(), [{ path: long(4096) }], 'the same in a file: the one that is too long is left out and the other is kept');
});

test('without a platform in the options the list follows the machine it runs on', async () => {
  const folded = process.platform !== 'linux';      // macOS and Windows take letters of either case for one file, Linux does not
  const memory = Recent.memory();
  await memory.add('/A/X.rwdoc');
  await memory.add('/a/x.rwdoc');
  assert.equal(memory.list().length, folded ? 1 : 2);
  const { path } = await where();
  const opened = await Recent.open(path);
  await opened.add('/A/X.rwdoc');
  await opened.add('/a/x.rwdoc');
  assert.equal(opened.list().length, folded ? 1 : 2);
});

test('on Windows two paths are the same file when they come to the same path, whatever the case: a step back in a path does not make another file', async () => {
  const recent = Recent.memory({ platform: 'win32' });
  await recent.add('/a/../a/X.rwdoc');
  await recent.add('/A/x.rwdoc');
  assert.equal(recent.list().length, 1);
});

test('a follower of the list is handed a copy: what it does to it does not change the list', async () => {
  const recent = Recent.memory();
  recent.subscribe((items) => { (items as RecentItem[]).length = 0; });
  await recent.add(doc(1).path);
  assert.deepEqual(recent.list(), [doc(1)]);
});
