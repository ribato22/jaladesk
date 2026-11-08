import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { seal, Unlocked } from '../src/documents/envelope.js';
import type { Doc, ObjectNode } from '../src/documents/model.js';
import { DocumentSession } from '../src/documents/session.js';
import { openDocument, realFs, saveDocument, type StoreFs } from '../src/documents/store.js';

const kdf = { logN: 14, r: 8, p: 1 };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const start = (): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'ws', revision: 0, objects: { [id(1)]: node(1), [id(2)]: node(2, { order: 1 }) } });
const where = async () => join(await mkdtemp(join(tmpdir(), 'rwrace-')), 'ws.rwdoc');

/** A file system that stops, once armed, at the commit of a save (the rename that puts the new file in place) or at the read of the document that a save starts with, until the test lets it go. */
function pausingFs(on: 'rename' | 'readFile' = 'rename') {
  let armed = false;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atPause = new Promise<void>((resolve) => { reached = resolve; });
  const hold = async (here: typeof on) => { if (armed && here === on) { armed = false; reached(); await gate; } };
  const fs: StoreFs = {
    ...realFs,
    rename: async (from, to) => { await hold('rename'); await realFs.rename(from, to); },
    readFile: async (path) => { await hold('readFile'); return realFs.readFile(path); },
  };
  return { fs, arm: () => { armed = true; }, atPause, release };
}

test('an edit made while a save is being written is kept, and the session still counts it as unsaved', { timeout: 20_000 }, async () => {
  const path = await where();
  const slow = pausingFs();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf, fs: slow.fs });
  assert.equal(a.dirty, false, 'a document that was just created has nothing to save');
  a.update((d) => { d.objects[id(1)]!.name = 'first'; });
  assert.equal(a.dirty, true);
  slow.arm();
  const saving = a.save();
  await slow.atPause; // the file is being replaced right now
  a.update((d) => { d.objects[id(2)]!.name = 'during'; });
  slow.release();
  assert.deepEqual(await saving, { saved: true });
  assert.equal(a.doc.objects[id(2)]!.name, 'during', 'the edit made during the save is not thrown away');
  assert.equal(a.dirty, true, 'and it has not been written yet');
  assert.deepEqual(await a.save(), { saved: true });
  assert.equal(a.dirty, false);
  const again = await DocumentSession.open(path, { password: 'pw' }, { kdf });
  assert.equal(again.doc.objects[id(1)]!.name, 'first');
  assert.equal(again.doc.objects[id(2)]!.name, 'during');
  assert.equal(again.doc.revision, 2);
});

test('opening, saving and merging leave the session clean or dirty as they should', async () => {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  const b = await DocumentSession.open(path, { password: 'pw' }, { kdf });
  assert.equal(b.dirty, false);
  b.update((d) => { d.objects[id(1)]!.props.host = 'b'; });
  a.update((d) => { d.objects[id(1)]!.props.host = 'a'; });
  assert.deepEqual(await a.save(), { saved: true });
  assert.equal(a.dirty, false);
  assert.equal((await b.save()).saved, false); // a conflict: nothing written
  assert.equal(b.dirty, true, 'a held-back merge is still unsaved');
  b.resolve(b.conflicts[0] as never, 'mine');
  assert.deepEqual(await b.save(), { saved: true });
  assert.equal(b.dirty, false);
});

/** The file as another writer leaves it: a document that this session can decrypt (same key) but cannot use. */
async function otherWriterSavesNewerSchema(path: string): Promise<Buffer> {
  const { handle } = await openDocument(path, 'pw', { kdf });
  await saveDocument(handle, Buffer.from(JSON.stringify({ schemaVersion: 3, id: id(900), kind: 'workspace', name: 'ws', revision: 5, objects: {} })), { kdf });
  handle.unlocked.dispose();
  return readFile(path);
}

test('a version of the file that cannot be merged is never written over: the next save is a conflict again, not an overwrite', async () => {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  a.update((d) => { d.objects[id(1)]!.name = 'mine'; });
  const theirs = await otherWriterSavesNewerSchema(path);
  await assert.rejects(a.save(), /Schema version not supported/, 'a file from a newer version cannot be merged');
  assert.equal(a.dirty, true);
  await assert.rejects(a.save(), /Schema version not supported/, 'saving again does not get past it');
  assert.deepEqual(await readFile(path), theirs, 'the other writer\'s file is as they left it');
  assert.equal(a.doc.objects[id(1)]!.name, 'mine', 'and the working copy is kept');
});

test('a save that is held back stays held back: saving again writes nothing over the other writer', async () => {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  const b = await DocumentSession.open(path, { password: 'pw' }, { kdf });
  a.update((d) => { d.objects[id(1)]!.props.host = 'a'; });
  b.update((d) => { d.objects[id(1)]!.props.host = 'b'; });
  assert.deepEqual(await b.save(), { saved: true });
  const theirs = await readFile(path);
  const first = await a.save();
  assert.equal(first.saved, false);
  const second = await a.save();
  assert.deepEqual([second.saved, second.saved ? 0 : second.conflicts.length], [false, 1]);
  assert.deepEqual(await readFile(path), theirs, 'nothing was written by either attempt');
  assert.equal(a.dirty, true);
});

test('an edit made while a conflicting save is waiting for the file is merged in, not dropped', { timeout: 20_000 }, async () => {
  const path = await where();
  const slow = pausingFs('readFile');
  const a = await DocumentSession.create(path, start(), 'pw', { kdf, fs: slow.fs });
  const b = await DocumentSession.open(path, { password: 'pw' }, { kdf });
  a.update((d) => { d.objects[id(1)]!.name = 'a-first'; });
  b.update((d) => { d.objects[id(2)]!.props.host = 'from-b'; });
  assert.deepEqual(await b.save(), { saved: true });
  slow.arm();
  const saving = a.save();
  await slow.atPause; // a has taken its copy and is about to look at the file, which b has changed
  a.update((d) => { d.objects[id(3)] = node(3, { order: 2 }); });
  slow.release();
  assert.deepEqual(await saving, { saved: true, merged: true });
  const again = await DocumentSession.open(path, { password: 'pw' }, { kdf });
  assert.equal(again.doc.objects[id(1)]!.name, 'a-first', 'the edit it was saving');
  assert.ok(again.doc.objects[id(3)], 'the edit made meanwhile');
  assert.equal(again.doc.objects[id(2)]!.props.host, 'from-b', 'and what the other writer saved');
  assert.equal(a.dirty, false);
});

test('a file that opens but cannot be used (written by a newer version) leaves no key behind', async () => {
  const path = await where();
  const { file, unlocked } = await seal(Buffer.from(JSON.stringify({ schemaVersion: 3, id: id(900), kind: 'workspace', name: 'x', revision: 0, objects: {} })), 'pw', { kdf });
  unlocked.dispose();
  await writeFile(path, file);
  const dispose = Unlocked.prototype.dispose;
  let wiped = 0;
  Unlocked.prototype.dispose = function (this: Unlocked) { wiped++; return dispose.call(this); };
  try {
    await assert.rejects(DocumentSession.open(path, { password: 'pw' }, { kdf }), /Schema version not supported/);
  } finally {
    Unlocked.prototype.dispose = dispose;
  }
  assert.equal(wiped, 1, 'the document key was wiped when the file turned out to be unusable');
});
