import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentLibrary, LibraryError } from '../src/documents/library.js';
import type { KeyCache } from '../src/documents/keywrap.js';
import { realFs, type StoreFs } from '../src/documents/store.js';

const kdf = { logN: 14, r: 8, p: 1 };
const where = async () => { const dir = await mkdtemp(join(tmpdir(), 'rwkeys-')); return { dir, file: join(dir, 'lab.rwdoc') }; };
/** A key cache that holds what it is given in memory, and remembers what it was asked. */
function memory(options: { put?: boolean } = {}) {
  const held = new Map<string, { fp: string; key: Buffer }>();
  const calls: { put: { docId: string; fp: string; key: Buffer }[]; get: string[]; forget: string[] } = { put: [], get: [], forget: [] };
  const cache: KeyCache = {
    async put(docId, fp, key) { calls.put.push({ docId, fp, key }); if (options.put === false) return false; held.set(docId, { fp, key: Buffer.from(key) }); return true; },
    async get(docId, fp) { calls.get.push(docId); const found = held.get(docId); return found && found.fp === fp ? Buffer.from(found.key) : undefined; },
    async forget(docId) { calls.forget.push(docId); held.delete(docId); },
  };
  return { cache, held, calls };
}
const failing = (code: string) => (error: unknown) => error instanceof LibraryError && error.code === code;

test('the key of an open document is given to the keystore under the path of the file and the fingerprint of its key, and the copy that was taken is wiped afterwards', async () => {
  const { file } = await where();
  const library = new DocumentLibrary({ kdf });
  const created = await library.create(file, 'Lab', 'sandi-uji-1');
  const { cache, calls, held } = memory();
  assert.equal(await library.rememberKey(created.id, cache), true);
  assert.equal(calls.put.length, 1);
  const [put] = calls.put;
  assert.equal(put!.docId, library.view(created.id).path, 'the file is what the key is kept for');
  assert.match(put!.fp, /^[0-9a-f]{64}$/);
  assert.equal(put!.key.length, 32);
  assert.ok(put!.key.every((byte) => byte === 0), 'the copy that was handed over is zeroes once the keystore has it');
  assert.ok(held.get(put!.docId)!.key.some((byte) => byte !== 0), 'and what the keystore kept is the key');
});

test('a document is opened with the key that the keystore remembers, without a password, and is the same document', async () => {
  const { file } = await where();
  const first = new DocumentLibrary({ kdf });
  const created = await first.create(file, 'Lab', 'sandi-uji-1');
  first.add(created.id, { parentId: null, type: 'folder', name: 'Server' });
  await first.save(created.id);
  const { cache } = memory();
  await first.rememberKey(created.id, cache);
  first.closeAll();
  const second = new DocumentLibrary({ kdf });
  const opened = await second.openRemembered(file, cache);
  assert.ok(opened);
  assert.equal(opened!.name, 'Lab');
  assert.deepEqual(second.snapshot(opened!.id).objects.map((o) => o.name), ['Server']);
  assert.equal(second.views().length, 1);
  assert.equal(await second.openRemembered(file, cache).catch((error) => (error as LibraryError).code), 'already-open', 'a document that is open is not opened twice');
});

test('without a key that works, nothing is opened and nothing fails: the caller asks for the password; a key that is not the file\'s, or a stale one, is no key', async () => {
  const { dir, file } = await where();
  const library = new DocumentLibrary({ kdf });
  await library.create(file, 'Lab', 'sandi-uji-1');
  const empty = memory();
  library.closeAll();
  assert.equal(await library.openRemembered(file, empty.cache), undefined, 'the keystore has nothing');
  assert.deepEqual(empty.calls.get, [file]);
  // a key of another document under this file's name
  const other = await library.create(join(dir, 'lain.rwdoc'), 'Lain', 'sandi-uji-2');
  const stranger = memory();
  await library.rememberKey(other.id, stranger.cache);
  const key = stranger.held.get(library.view(other.id).path)!;
  library.closeAll();
  const wrong = memory();
  wrong.held.set(file, { fp: await fingerprintOf(file), key: key.key });
  assert.equal(await library.openRemembered(file, wrong.cache), undefined, 'a key of another file opens nothing');
  // a stale key: the file was made again with another password
  const { cache, held } = memory();
  const again = await library.open(file, 'sandi-uji-1');
  await library.rememberKey(again.id, cache);
  library.closeAll();
  await unlink(file);
  await library.create(file, 'Lab', 'sandi-baru-3');
  library.closeAll();
  assert.equal(held.size, 1);
  assert.equal(await library.openRemembered(file, cache), undefined, 'the password changed: the key is stale and the password is asked for again');
});

async function fingerprintOf(file: string): Promise<string> {
  const { keyFingerprint } = await import('../src/documents/envelope.js');
  return keyFingerprint(await readFile(file));
}

test('a file that is not there is told before anything else is asked: assertExists passes for a file and refuses a name with nothing behind it', async () => {
  const { dir, file } = await where();
  const library = new DocumentLibrary({ kdf });
  await assert.rejects(library.assertExists(file), failing('not-found'));
  await library.create(file, 'Lab', 'sandi-uji-1');
  await library.assertExists(file);
  await assert.rejects(library.assertExists(join(dir, 'tidak-ada.rwdoc')), failing('not-found'));
});

test('a file that is not there or not a document is told as such, and is not "no key"', async () => {
  const { dir, file } = await where();
  const library = new DocumentLibrary({ kdf });
  const { cache } = memory();
  await assert.rejects(library.openRemembered(join(dir, 'tidak-ada.rwdoc'), cache), failing('not-found'));
  await writeFile(file, 'bukan dokumen sama sekali, hanya teks biasa yang panjang cukup untuk dibaca');
  await assert.rejects(library.openRemembered(file, cache), (error: unknown) => error instanceof LibraryError && ['unreadable', 'io'].includes(error.code));
  assert.equal(library.views().length, 0);
});

test('the keystore that will not take the key is told to the caller as false, a document that is not open is refused, and a keystore that fails is a failure the caller sees', async () => {
  const { file } = await where();
  const library = new DocumentLibrary({ kdf });
  const created = await library.create(file, 'Lab', 'sandi-uji-1');
  const refusing = memory({ put: false });
  assert.equal(await library.rememberKey(created.id, refusing.cache), false);
  assert.ok(refusing.calls.put[0]!.key.every((byte) => byte === 0), 'the copy is wiped whether or not it was kept');
  await assert.rejects(library.rememberKey('00000000-0000-4000-8000-000000000000', refusing.cache), failing('unknown-document'));
  const throwing: KeyCache = { put: async () => { throw new Error('the keystore is not there'); }, get: async () => undefined, forget: async () => undefined };
  await assert.rejects(library.rememberKey(created.id, throwing), /keystore is not there/);
});

// The independent review of the spike (slice 2): the key that the keystore hands over is wiped, only a key that does not fit is "stale", and only "there is no such file" is told as that.
test('the key that the keystore handed over is wiped once the document is open, and the document still opens, changes and saves', async () => {
  const { file } = await where();
  const first = new DocumentLibrary({ kdf });
  const created = await first.create(file, 'Lab', 'sandi-uji-1');
  const { cache } = memory();
  await first.rememberKey(created.id, cache);
  first.closeAll();
  const handed: Buffer[] = [];
  const spy: KeyCache = { ...cache, get: async (docId, fp) => { const key = await cache.get(docId, fp); if (key) handed.push(key); return key; } };
  const second = new DocumentLibrary({ kdf });
  const opened = await second.openRemembered(file, spy);
  assert.ok(opened);
  assert.equal(handed.length, 1);
  assert.ok(handed[0]!.every((byte) => byte === 0), 'the copy that came from the keystore is zeroes');
  second.add(opened!.id, { parentId: null, type: 'folder', name: 'Server' });
  assert.equal((await second.save(opened!.id)).saved, true, 'the document has a key of its own');
  second.closeAll();
  assert.deepEqual((await new DocumentLibrary({ kdf }).open(file, 'sandi-uji-1').then((s) => s.name)), 'Lab');
});

test('a key that does not fit is a stale key and the password is asked for, but a file that cannot be read is not that: it is told', async () => {
  const { file } = await where();
  const first = new DocumentLibrary({ kdf });
  const created = await first.create(file, 'Lab', 'sandi-uji-1');
  const { cache } = memory();
  await first.rememberKey(created.id, cache);
  first.closeAll();
  const eio = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
  const unreadable: StoreFs = { ...realFs, readFile: async () => { throw eio; } };
  await assert.rejects(new DocumentLibrary({ kdf, fs: unreadable }).openRemembered(file, cache), failing('io'));
  assert.equal(await new DocumentLibrary({ kdf }).openRemembered(file, { ...cache, get: async () => Buffer.alloc(32, 7) }), undefined, 'a key that opens nothing falls back to the password');
});

test('only "there is no such file" is told as a file that is not there: a file that cannot be looked at is an I/O failure and the list keeps it', async () => {
  const { file } = await where();
  await new DocumentLibrary({ kdf }).create(file, 'Lab', 'sandi-uji-1');
  for (const [code, expected] of [['ENOENT', 'not-found'], ['ENOTDIR', 'not-found'], ['EACCES', 'io'], ['EIO', 'io'], ['ELOOP', 'io'], ['ETIMEDOUT', 'io']] as const) {
    const fs: StoreFs = { ...realFs, stat: async () => { throw Object.assign(new Error(code), { code }); } };
    await assert.rejects(new DocumentLibrary({ kdf, fs }).assertExists(file), failing(expected), code);
  }
  await assert.rejects(new DocumentLibrary({ kdf, fs: { ...realFs, stat: async () => { throw new Error('no code at all'); } } }).assertExists(file), failing('io'), 'an error without a code is not "not found"');
});

// What the review after the execution (23 October 2026) found.

test('a file reached through a link is the file the link points to everywhere: the key is kept and found under the real path, and a save leaves the link a link', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rwkeys-')));      // the folder for tests may itself be behind a link (macOS): the real path is what the library must come to
  const file = join(dir, 'lab.rwdoc'), link = join(dir, 'tautan.rwdoc');
  const library = new DocumentLibrary({ kdf });
  const created = await library.create(file, 'Lab', 'sandi-uji-1');
  library.close(created.id);
  await symlink(file, link);
  const { cache, calls } = memory();
  const viaLink = await library.open(link, 'sandi-uji-1');
  assert.equal(library.view(viaLink.id).path, file, 'registered under the real path, not under the link');
  assert.equal(await library.rememberKey(viaLink.id, cache), true);
  assert.equal(calls.put[0]!.docId, file, 'the key is kept for the real file');
  library.close(viaLink.id);
  const again = await library.openRemembered(link, cache);
  assert.ok(again, 'the key is found when the document is reached through the link again');
  assert.equal(calls.get.at(-1), file, 'by the real path');
  assert.equal(library.view(again!.id).path, file);
  library.add(again!.id, { parentId: null, type: 'folder', name: 'Server' });
  await library.save(again!.id);
  assert.equal((await lstat(link)).isSymbolicLink(), true, 'a save did not replace the link with a copy');
  assert.equal((await lstat(file)).isSymbolicLink(), false);
});

test('a file that is open already is refused before the keystore is asked for its key', async () => {
  const { file } = await where();
  const library = new DocumentLibrary({ kdf });
  const created = await library.create(file, 'Lab', 'sandi-uji-1');
  const { cache, calls } = memory();
  await library.rememberKey(created.id, cache);
  await assert.rejects(library.openRemembered(file, cache), failing('already-open'));
  assert.deepEqual(calls.get, [], 'the keystore was not asked');
});
