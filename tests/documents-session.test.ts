import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentSession } from '../src/documents/session.js';
import { makeKeyCache, type SecretBox } from '../src/documents/keywrap.js';
import { keyFingerprint } from '../src/documents/envelope.js';
import { DocumentError, type Doc, type ObjectNode } from '../src/documents/model.js';
import { readFile } from 'node:fs/promises';

const kdf = { logN: 14, r: 8, p: 1 };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const start = (): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'ws', revision: 0, objects: { [id(1)]: node(1, { props: { host: 'a' } }), [id(2)]: node(2, { order: 1 }) } });
const where = async () => join(await mkdtemp(join(tmpdir(), 'rwsess-')), 'ws.rwdoc');

test('two sessions edit different things: the second save merges and succeeds; the same field is held back until resolved', async () => {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  const b = await DocumentSession.open(path, { password: 'pw' }, { kdf });
  a.update((d) => { d.objects[id(1)]!.props.host = 'from-a'; });
  assert.deepEqual(await a.save(), { saved: true });
  b.update((d) => { d.objects[id(2)]!.name = 'from-b'; });
  assert.deepEqual(await b.save(), { saved: true, merged: true }, 'a clean merge is saved at once, and the result says it took the other writer changes in');
  assert.equal(b.merges, 1, 'the session counts the merge, so that whoever shows the document knows it has to take it again');
  assert.equal(a.merges, 0, 'and a session that took nothing in has counted nothing');
  const reopened = await DocumentSession.open(path, { password: 'pw' }, { kdf });
  assert.equal(reopened.doc.objects[id(1)]!.props.host, 'from-a');
  assert.equal(reopened.doc.objects[id(2)]!.name, 'from-b');
  assert.equal(reopened.doc.revision, 2);

  a.update((d) => { d.objects[id(1)]!.props.host = 'a-again'; });
  b.update((d) => { d.objects[id(1)]!.props.host = 'b-again'; });
  assert.deepEqual(await a.save(), { saved: true, merged: true }, 'a is behind the file too: its save takes the other writer changes in first');
  const held = await b.save();
  assert.equal(held.saved, false);
  assert.equal((await DocumentSession.open(path, { password: 'pw' }, { kdf })).doc.objects[id(1)]!.props.host, 'a-again', 'nothing was written while the conflict is open');
  const conflict = b.conflicts[0]!;
  assert.equal(conflict.kind, 'field');
  b.resolve(conflict as never, 'mine');
  assert.deepEqual(await b.save(), { saved: true });
  assert.equal((await DocumentSession.open(path, { password: 'pw' }, { kdf })).doc.objects[id(1)]!.props.host, 'b-again');
});

test('an edit that would make the document invalid is refused and leaves the working copy alone', async () => {
  const a = await DocumentSession.create(await where(), start(), 'pw', { kdf });
  assert.throws(() => a.update((d) => { d.objects[id(1)]!.parentId = id(2); }), DocumentError); // a connection is not a folder
  assert.equal(a.doc.objects[id(1)]!.parentId, null);
});

test('reopening with the keystore cache needs no password; a stale cache falls back to the password', async () => {
  const path = await where();
  const box: SecretBox = { available: () => true, seal: (b) => Buffer.from(b.map((x) => x ^ 1)), open: (b) => Buffer.from(b.map((x) => x ^ 1)) };
  const cache = makeKeyCache(box, join(path, '..', 'keys'));
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  await cache.put(path, keyFingerprint(await readFile(path)), a.handle.unlocked.exportKey());
  const quick = await DocumentSession.open(path, { cache }, { kdf });
  assert.equal(quick.doc.name, 'ws');
  await cache.forget(path);
  await assert.rejects(DocumentSession.open(path, { cache }, { kdf }));
  assert.equal((await DocumentSession.open(path, { cache, password: 'pw' }, { kdf })).doc.name, 'ws');
});
