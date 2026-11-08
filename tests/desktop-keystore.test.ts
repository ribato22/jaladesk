import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Keystore } from '../src/desktop/keystore.js';
import type { SecretBox } from '../src/documents/keywrap.js';

/** A seal that is not one (the real one is the operating system's and is never used in a test): it prefixes, and says how often it was asked. */
function fakeBox(state = { available: true, asked: 0, throws: false, openThrows: false }): { box: SecretBox; state: typeof state } {
  const box: SecretBox = {
    available: () => { state.asked++; if (state.throws) throw new Error('the keystore fell over'); return state.available; },
    seal: (plain) => Buffer.concat([Buffer.from('sealed:'), plain]),
    open: (blob) => { if (state.openThrows) throw new Error('the keychain refused'); return blob.subarray(7); },
  };
  return { box, state };
}
const where = async () => join(await mkdtemp(join(tmpdir(), 'rwkeystore-')), 'keys');
const key = (n: number) => Buffer.alloc(32, n);

test('keys are used only when the person allows them and the system can seal them, and the system is not even asked while they are not allowed', async () => {
  const { box, state } = fakeBox();
  let allowed = false;
  const store = new Keystore({ box, dir: await where(), allowed: () => allowed });
  assert.equal(store.usable(), false);
  assert.equal(state.asked, 0, 'nothing is asked of the keystore of the system until the person has allowed it: asking can bring up a prompt of the system');
  allowed = true;
  assert.equal(store.usable(), true);
  assert.equal(state.asked, 1);
  state.available = false;
  assert.equal(store.usable(), false, 'allowed, but there is no keystore to seal with');
  state.throws = true;
  assert.equal(store.usable(), false, 'and one that falls over is none');
});

test('a person\'s setting that cannot be read is no permission', async () => {
  const { box } = fakeBox();
  const store = new Keystore({ box, dir: await where(), allowed: () => { throw new Error('the settings fell over'); } });
  assert.equal(store.usable(), false);
});

test('whether the system can seal is asked on its own, and an answer that is an error is no', async () => {
  const { box, state } = fakeBox();
  const store = new Keystore({ box, dir: await where(), allowed: () => false });
  assert.equal(store.available(), true, 'asked for, whatever the person has allowed');
  assert.equal(state.asked, 1);
  state.available = false;
  assert.equal(store.available(), false);
  state.throws = true;
  assert.equal(store.available(), false);
});

test('a key that is remembered is counted, and is found again by the cache with the same file and the same fingerprint', async () => {
  const { box } = fakeBox();
  const store = new Keystore({ box, dir: await where(), allowed: () => true });
  assert.equal(await store.count(), 0, 'no folder yet');
  assert.equal(await store.cache.put('/dokumen/a.rwdoc', 'fp-a', key(1)), true);
  assert.equal(await store.cache.put('/dokumen/b.rwdoc', 'fp-b', key(2)), true);
  assert.equal(await store.count(), 2);
  assert.deepEqual(await store.cache.get('/dokumen/a.rwdoc', 'fp-a'), key(1));
  assert.equal(await store.cache.get('/dokumen/a.rwdoc', 'fp-lain'), undefined);
  await store.cache.put('/dokumen/a.rwdoc', 'fp-a2', key(3));
  assert.equal(await store.count(), 2, 'one key for a file');
});

test('the key of one file is forgotten, and the answer says whether there was one', async () => {
  const { box } = fakeBox();
  const store = new Keystore({ box, dir: await where(), allowed: () => true });
  await store.cache.put('/dokumen/a.rwdoc', 'fp-a', key(1));
  await store.cache.put('/dokumen/b.rwdoc', 'fp-b', key(2));
  assert.equal(await store.forget('/dokumen/a.rwdoc'), true);
  assert.equal(await store.count(), 1);
  assert.equal(await store.cache.get('/dokumen/a.rwdoc', 'fp-a'), undefined);
  assert.deepEqual(await store.cache.get('/dokumen/b.rwdoc', 'fp-b'), key(2), 'the other stays');
  assert.equal(await store.forget('/dokumen/a.rwdoc'), false, 'nothing to forget the second time');
  assert.equal(await store.forget('/dokumen/tidak-ada.rwdoc'), false);
});

test('forgetting works while the keys are not allowed and while the system has no keystore: it only deletes files', async () => {
  const { box, state } = fakeBox();
  let allowed = true;
  const store = new Keystore({ box, dir: await where(), allowed: () => allowed });
  await store.cache.put('/dokumen/a.rwdoc', 'fp-a', key(1));
  allowed = false;
  state.available = false;
  const asked = state.asked;
  assert.equal(await store.forget('/dokumen/a.rwdoc'), true);
  assert.equal(await store.count(), 0);
  assert.equal(state.asked, asked, 'and the keystore of the system was not asked about it');
});

test('all keys are forgotten, the number that there were is told, the files that are not keys are left alone, and an empty or missing folder is zero', async () => {
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  assert.equal(await store.forgetAll(), 0, 'no folder');
  for (const n of [1, 2, 3]) await store.cache.put(`/dokumen/${n}.rwdoc`, `fp-${n}`, key(n));
  await writeFile(join(dir, 'catatan.txt'), 'bukan kunci');
  await writeFile(join(dir, `${'0'.repeat(32)}.key.${'a'.repeat(12)}.tmp`), 'sisa penulisan yang terhenti');
  await writeFile(join(dir, 'abc.key.123456.tmp'), 'bukan sisa penulisan kita');
  await writeFile(join(dir, 'kunci-orang-lain.key'), 'bukan kunci kita');
  assert.equal(await store.count(), 3, 'a file that only ends in .key is not one of ours');
  assert.equal(await store.forgetAll(), 3);
  assert.deepEqual((await readdir(dir)).sort(), ['abc.key.123456.tmp', 'catatan.txt', 'kunci-orang-lain.key'], 'the keys and the leftover of a write that stopped are gone, what is not ours is not');
  assert.equal(await store.count(), 0);
  assert.equal(await store.forgetAll(), 0);
});

// What happens to the files of the keys when something goes wrong (the independent review of the spike, slice 2): a key that can never be used again is not kept, a write that fails leaves nothing behind, and forgetting
// never says it did what it did not.
const fileOf = (docId: string) => `${createHash('sha256').update(docId).digest('hex').slice(0, 32)}.key`;
const keyFiles = async (dir: string) => (await readdir(dir)).filter((name) => name.endsWith('.key'));
const leftovers = async (dir: string) => (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
/** A key-looking name that is a folder with something in it: it cannot be deleted like a file, and it is not ENOENT. */
async function blocked(dir: string, docId: string): Promise<void> {
  await mkdir(join(dir, fileOf(docId)), { recursive: true });
  await writeFile(join(dir, fileOf(docId), 'x'), 'x');
}

test('a key that can never be used again is not kept: a stale entry, a damaged one and one of another shape are removed when they are looked up; one that the system cannot open now is kept', async () => {
  const { box, state } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  await store.cache.put('/d/a.rwdoc', 'fp-a', key(1));
  assert.equal(await store.cache.get('/d/a.rwdoc', 'fp-lain'), undefined);
  assert.equal(await store.count(), 0, 'stale: the file was made again with another password');
  for (const text of ['{ damaged', '{"v":2,"fp":"fp-b","blob":"AA=="}', '{"v":1,"fp":"fp-b"}', '{"v":1,"fp":7,"blob":"AA=="}', '[]', 'null', '7', '']) {
    await store.cache.put('/d/b.rwdoc', 'fp-b', key(2));
    await writeFile(join(dir, fileOf('/d/b.rwdoc')), text);
    assert.equal(await store.cache.get('/d/b.rwdoc', 'fp-b'), undefined, JSON.stringify(text));
    assert.equal(await store.count(), 0, `${JSON.stringify(text)} is not kept`);
  }
  await store.cache.put('/d/c.rwdoc', 'fp-c', key(3));
  state.openThrows = true;
  assert.equal(await store.cache.get('/d/c.rwdoc', 'fp-c'), undefined, 'the keychain refused (or is locked) just now');
  state.openThrows = false;
  state.available = false;
  assert.equal(await store.cache.get('/d/c.rwdoc', 'fp-c'), undefined, 'and there is no keystore at the moment');
  assert.equal(await store.count(), 1, 'a key that may work later is not thrown away');
  state.available = true;
  assert.deepEqual(await store.cache.get('/d/c.rwdoc', 'fp-c'), key(3));
});

test('a write that fails leaves nothing behind: no temporary file, and the key that was there stays', async () => {
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  await store.cache.put('/d/a.rwdoc', 'fp-a', key(1));
  const sealThrows: SecretBox = { available: () => true, seal: () => { throw new Error('the keychain refused'); }, open: box.open };
  const refusing = new Keystore({ box: sealThrows, dir, allowed: () => true });
  await assert.rejects(refusing.cache.put('/d/a.rwdoc', 'fp-a2', key(2)), /keychain refused/);
  assert.deepEqual(await leftovers(dir), []);
  assert.deepEqual(await store.cache.get('/d/a.rwdoc', 'fp-a'), key(1), 'and the key that was there is still there');
  await blocked(dir, '/d/b.rwdoc');      // the place of this key is taken by a folder, so the rename fails after the file was written
  await assert.rejects(store.cache.put('/d/b.rwdoc', 'fp-b', key(3)));
  assert.deepEqual(await leftovers(dir), [], 'the file written for the rename is removed when the rename fails');
});

test('forgetting a key that cannot be deleted says so: only a file that is not there is "nothing to forget"', async () => {
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  await store.cache.put('/d/a.rwdoc', 'fp-a', key(1));
  await blocked(dir, '/d/b.rwdoc');
  await assert.rejects(store.forget('/d/b.rwdoc'));
  await assert.rejects(store.cache.forget('/d/b.rwdoc'));
  assert.equal(await store.forget('/d/niemand.rwdoc'), false, 'no file: nothing to forget, and no failure');
  assert.equal(await store.forget('/d/a.rwdoc'), true);
});

test('forgetting all keys tells the truth: everything that can be deleted is, the number is of the keys that were deleted, and a key that cannot be deleted is an error after the others are gone', async () => {
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  for (const n of [1, 2, 3]) await store.cache.put(`/d/${n}.rwdoc`, `fp-${n}`, key(n));
  await blocked(dir, '/d/4.rwdoc');
  await assert.rejects(store.forgetAll());
  assert.deepEqual(await keyFiles(dir), [fileOf('/d/4.rwdoc')], 'the three keys are gone, the one that could not be deleted is not');
  assert.equal(await (async () => { try { return await store.forgetAll(); } catch { return -1; } })(), -1, 'and it is still an error the next time');
});

test('keys that cannot be counted are an error and not zero: a folder that cannot be read; a folder that is not there is zero', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('permissions cannot take the right to read away here'); return; }
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  assert.equal(await store.count(), 0, 'no folder');
  assert.equal(await store.forgetAll(), 0, 'no folder');
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o000);
  try {
    await assert.rejects(store.count());
    await assert.rejects(store.forgetAll());
  } finally { await chmod(dir, 0o700); }
});

test('how many keys there are is known without asking the disk, follows every change made through the keystore, and those who follow are told only when the number is another', async () => {
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  const heard: number[] = [];
  store.subscribe(() => heard.push(store.known()));
  assert.equal(store.known(), 0);
  await store.cache.put('/d/a.rwdoc', 'fp-a', key(1));
  assert.deepEqual([store.known(), heard], [1, [1]]);
  await store.cache.put('/d/a.rwdoc', 'fp-a2', key(2));
  assert.deepEqual([store.known(), heard], [1, [1]], 'the same number: nobody is told');
  await store.cache.put('/d/b.rwdoc', 'fp-b', key(3));
  assert.deepEqual([store.known(), heard], [2, [1, 2]]);
  assert.equal(await store.cache.get('/d/a.rwdoc', 'fp-lain'), undefined);
  assert.deepEqual([store.known(), heard], [1, [1, 2, 1]], 'a lookup that found a key stale and deleted it');
  assert.equal(await store.forget('/d/b.rwdoc'), true);
  assert.deepEqual([store.known(), heard], [0, [1, 2, 1, 0]]);
  await store.cache.put('/d/c.rwdoc', 'fp-c', key(4));
  await store.cache.put('/d/d.rwdoc', 'fp-d', key(5));
  assert.equal(await store.forgetAll(), 2);
  assert.equal(store.known(), 0);
  assert.equal(heard.at(-1), 0);
  const other = new Keystore({ box, dir, allowed: () => true });
  await store.cache.put('/d/e.rwdoc', 'fp-e', key(6));
  assert.equal(other.known(), 0, 'a keystore that has not looked does not know');
  await other.refresh();
  assert.equal(other.known(), 1, 'and one that looks does');
  const stop = store.subscribe(() => { throw new Error('a follower that fails'); });
  const after = heard.length;
  await store.cache.put('/d/f.rwdoc', 'fp-f', key(7));
  assert.equal(heard.length, after + 1, 'a follower that fails does not stop the others');
  stop();
  let calls = 0;
  const stopCounting = store.subscribe(() => { calls++; });
  await store.cache.put('/d/g.rwdoc', 'fp-g', key(8));
  assert.equal(calls, 1);
  stopCounting();
  await store.cache.put('/d/h.rwdoc', 'fp-h', key(9));
  assert.equal(calls, 1, 'a follower that was stopped is told nothing more');
});

test('a failed write still counts again, and a folder that cannot be read leaves the number as it was', async (t) => {
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  await store.cache.put('/d/a.rwdoc', 'fp-a', key(1));
  await blocked(dir, '/d/b.rwdoc');
  await assert.rejects(store.cache.put('/d/b.rwdoc', 'fp-b', key(2)));
  assert.equal(store.known(), 2, 'the folder that stands in the place of a key is counted by its name, and the count is of what is on the disk');
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('permissions cannot take the right to read away here'); return; }
  await chmod(dir, 0o000);
  try { await store.refresh(); assert.equal(store.known(), 2, 'not 0: the folder was not read'); } finally { await chmod(dir, 0o700); }
});

test('the key files are for their owner only: the folder and each file in it', async (t) => {
  if (process.platform === 'win32') { t.skip('the modes of the files are not the rights of Windows'); return; }
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  await store.cache.put('/d/a.rwdoc', 'fp-a', key(1));
  assert.equal((await stat(dir)).mode & 0o777, 0o700, 'the folder');
  const [file] = await keyFiles(dir);
  assert.equal((await stat(join(dir, file!))).mode & 0o777, 0o600, 'the file of a key');
});

// What the review after the execution (23 October 2026) found: the names that are swept were written by hand in the tests, and a few paths of the code had no test.

test('what is swept is what the key cache leaves: a key file is 32 hex and .key, a write that stopped leaves its name and twelve hex and .tmp, and nothing shorter or longer is taken for one', async () => {
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  await store.cache.put('/d/a.rwdoc', 'fp-a', key(1));
  const [real] = await keyFiles(dir);
  assert.match(real!, /^[0-9a-f]{32}\.key$/, 'a key file as the cache really names it');
  const source = await readFile(fileURLToPath(new URL('../../src/documents/keywrap.ts', import.meta.url)), 'utf8');
  assert.match(source, /const tmp = `\$\{file\(docId\)\}\.\$\{randomBytes\(6\)\.toString\('hex'\)\}\.tmp`;/, 'and a temporary file as the cache really names it: the name of the key, twelve hex, .tmp');
  const mine = `${real}.${'a'.repeat(12)}.tmp`;
  const others = [`${'a'.repeat(31)}.key`, `${'a'.repeat(33)}.key`, `${real}.${'a'.repeat(11)}.tmp`, `${real}.${'a'.repeat(13)}.tmp`, `${'a'.repeat(31)}.key.${'a'.repeat(12)}.tmp`, `${'a'.repeat(33)}.key.${'a'.repeat(12)}.tmp`];
  for (const name of [mine, ...others]) await writeFile(join(dir, name), 'x');
  assert.equal(await store.count(), 1, 'only the real key is a key');
  assert.equal(await store.forgetAll(), 1);
  assert.deepEqual((await readdir(dir)).sort(), [...others].sort(), 'the key and the leftover are gone, and every name that only looks like them is still there');
});

test('a folder of keys that sits under a file is no folder: there are no keys and nothing fails', async () => {
  const { box } = fakeBox();
  const base = await mkdtemp(join(tmpdir(), 'rwkeystore-'));
  await writeFile(join(base, 'bukan-folder'), 'x');
  const store = new Keystore({ box, dir: join(base, 'bukan-folder', 'keys'), allowed: () => true });
  assert.equal(await store.count(), 0);
  assert.equal(await store.forgetAll(), 0);
});

test('forgetting everything goes on after a key that cannot be deleted, and the error that is told is the first one', async () => {
  const { box } = fakeBox();
  const dir = await where();
  const store = new Keystore({ box, dir, allowed: () => true });
  for (const n of [1, 2, 3]) await store.cache.put(`/d/${n}.rwdoc`, `fp-${n}`, key(n));
  const names = await keyFiles(dir);      // in the order the keystore meets them
  for (const docId of ['/d/1.rwdoc', '/d/2.rwdoc']) { await rm(join(dir, fileOf(docId))); await blocked(dir, docId); }
  const order = (await readdir(dir)).filter((name) => name.endsWith('.key') && names.includes(name));
  const folders = order.filter((name) => name === fileOf('/d/1.rwdoc') || name === fileOf('/d/2.rwdoc'));
  assert.equal(folders.length, 2);
  await assert.rejects(store.forgetAll(), (error: Error) => { assert.ok(error.message.includes(folders[0]!), `the first failure is the one that is told: ${error.message}`); assert.ok(!error.message.includes(folders[1]!)); return true; });
  assert.deepEqual((await readdir(dir)).sort(), folders.slice().sort(), 'the key that could be deleted was, and the two that could not are still there');
});

test('a follower that joins while the others are being told is not told in the same round', async () => {
  const { box } = fakeBox();
  const store = new Keystore({ box, dir: await where(), allowed: () => true });
  const told: string[] = [];
  store.subscribe(() => { told.push('first'); store.subscribe(() => { told.push('joined'); }); });
  await store.cache.put('/d/a.rwdoc', 'fp-a', key(1));
  assert.deepEqual(told, ['first'], 'the one that joined during the round is told of the next change, not of this one');
  await store.cache.put('/d/b.rwdoc', 'fp-b', key(2));
  assert.deepEqual(told, ['first', 'first', 'joined']);
});
