import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKeyCache, type SecretBox } from '../src/documents/keywrap.js';
import { seal, rewrap, resume, keyFingerprint, EnvelopeError } from '../src/documents/envelope.js';

const fast = { logN: 14, r: 8, p: 1 };
// A stand-in for safeStorage: reversible, authenticated by a prefix, and "unavailable" on demand.
const fakeBox = (available = true): SecretBox => ({
  available: () => available,
  seal: (plain) => Buffer.concat([Buffer.from('BOX1'), Buffer.from(plain.map((b) => b ^ 0x5a))]),
  open: (blob) => { if (blob.subarray(0, 4).toString() !== 'BOX1') throw new Error('not sealed by this box'); return Buffer.from(blob.subarray(4).map((b) => b ^ 0x5a)); },
});
const dir = () => mkdtemp(join(tmpdir(), 'rwkey-'));

test('a cached key reopens the document without the password, and never touches the disk in the clear', async () => {
  const { file, unlocked } = await seal(Buffer.from('secret doc'), 'pw', { kdf: fast });
  const key = unlocked.exportKey();
  const where = await dir();
  const cache = makeKeyCache(fakeBox(), where);
  assert.equal(await cache.put('doc-1', keyFingerprint(file), key), true);
  const stored = await readFile(join(where, (await readdir(where))[0]!), 'utf8');
  assert.ok(!stored.includes(key.toString('base64')) && !stored.includes(key.toString('hex')), 'the key is not stored in the clear');
  const back = await cache.get('doc-1', keyFingerprint(file));
  assert.ok(back);
  assert.equal(resume(file, back!).plaintext.toString(), 'secret doc');
  assert.throws(() => resume(file, Buffer.alloc(32, 1)), (e: unknown) => e instanceof EnvelopeError && e.code === 'auth');
});

test('the cache misses after a password change, after forget, with a damaged entry, and when the keystore is unavailable', async () => {
  const { file, unlocked } = await seal(Buffer.from('x'), 'old', { kdf: fast });
  const where = await dir();
  const cache = makeKeyCache(fakeBox(), where);
  await cache.put('doc-1', keyFingerprint(file), unlocked.exportKey());
  const changed = await rewrap(file, 'old', 'new', { kdf: fast });
  assert.notEqual(keyFingerprint(changed), keyFingerprint(file));
  assert.ok(await cache.get('doc-1', keyFingerprint(file)));
  assert.equal(await cache.get('doc-1', keyFingerprint(changed)), undefined);
  assert.equal(await cache.get('doc-1', keyFingerprint(file)), undefined, 'and the lookup that found the key stale removed it: a key that can never be used again is not kept');
  await cache.put('doc-1', keyFingerprint(file), unlocked.exportKey());
  await writeFile(join(where, (await readdir(where))[0]!), '{ damaged');
  assert.equal(await cache.get('doc-1', keyFingerprint(file)), undefined);
  await cache.put('doc-1', keyFingerprint(file), unlocked.exportKey());
  await cache.forget('doc-1');
  assert.equal(await cache.get('doc-1', keyFingerprint(file)), undefined);
  const off = makeKeyCache(fakeBox(false), await dir());
  assert.equal(await off.put('doc-1', keyFingerprint(file), unlocked.exportKey()), false);
});
