import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Doc, ObjectNode } from '../src/documents/model.js';
import type { Env, Op } from '../src/documents/ops.js';
import { DocumentSession } from '../src/documents/session.js';
import { realFs, type StoreFs } from '../src/documents/store.js';

const kdf = { logN: 14, r: 8, p: 1 };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const start = (): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'ws', revision: 0, objects: { [id(1)]: node(1, { type: 'folder' }), [id(2)]: node(2, { parentId: id(1) }), [id(3)]: node(3, { order: 1 }) } });
const where = async () => join(await mkdtemp(join(tmpdir(), 'rwops-')), 'ws.rwdoc');
let nextId = 700;
const env: Env = { newId: () => id(nextId++) };
const rename = (n: number, name: string): Op => ({ op: 'update', id: id(n), name });

test('an operation is applied to the working copy and the session counts it as unsaved; one that changes nothing leaves it clean', async () => {
  const s = await DocumentSession.create(await where(), start(), 'pw', { kdf });
  assert.equal(s.dirty, false);
  const same = s.apply(rename(3, 'n3'), env);
  assert.deepEqual([same.change, s.dirty], [{ upsert: [], remove: [] }, false], 'renaming to the same name is nothing');
  const added = s.apply({ op: 'add', id: id(10), parentId: id(1), type: 'folder', name: 'new', props: {} }, env);
  assert.deepEqual([added.created, s.dirty, s.doc.objects[id(10)]!.name], [id(10), true, 'new']);
  assert.throws(() => s.apply({ op: 'move', id: id(1), parentId: id(10) }, env), /cannot be moved into itself/);
  assert.equal(s.doc.objects[id(1)]!.parentId, null, 'a refused operation changes nothing');
});

test('an operation made while a save is being written is kept and stays unsaved, like any other edit', { timeout: 20_000 }, async () => {
  const path = await where();
  let armed = false, release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atCommit = new Promise<void>((resolve) => { reached = resolve; });
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (armed) { armed = false; reached(); await gate; } await realFs.rename(from, to); } };
  const s = await DocumentSession.create(path, start(), 'pw', { kdf, fs });
  s.apply(rename(2, 'first'), env);
  armed = true;
  const saving = s.save();
  await atCommit;
  s.apply(rename(3, 'during'), env);
  release();
  assert.deepEqual(await saving, { saved: true });
  assert.equal(s.doc.objects[id(3)]!.name, 'during');
  assert.equal(s.dirty, true, 'written, but not yet this edit');
  assert.deepEqual(await s.save(), { saved: true });
  const again = await DocumentSession.open(path, { password: 'pw' }, { kdf });
  assert.deepEqual([again.doc.objects[id(2)]!.name, again.doc.objects[id(3)]!.name], ['first', 'during']);
});

test('a save that had to take another writer\'s changes in says so, whether it then wrote or was held back', { timeout: 20_000 }, async () => {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  const b = await DocumentSession.open(path, { password: 'pw' }, { kdf });
  b.apply(rename(2, 'from-b'), env);
  assert.deepEqual(await b.save(), { saved: true }, 'nobody else had written: nothing was taken in');
  a.apply(rename(3, 'from-a'), env);
  assert.deepEqual(await a.save(), { saved: true, merged: true });
  assert.equal(a.doc.objects[id(2)]!.name, 'from-b', 'the working copy holds the other change now');
  a.apply(rename(2, 'a-again'), env);
  b.apply(rename(2, 'b-again'), env);
  assert.deepEqual(await a.save(), { saved: true }, 'a is the last writer, so it is not behind the file');
  const held = await b.save();
  assert.deepEqual([held.saved, held.merged, 'conflicts' in held && held.conflicts.length], [false, true, 1]);
  const second = await b.save();
  assert.deepEqual([second.saved, second.merged], [false, undefined], 'asked again, nothing was merged and nothing changed');
});
