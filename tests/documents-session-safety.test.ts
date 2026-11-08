import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConflictError, keyOf, type Choice } from '../src/documents/conflicts.js';
import type { Conflict } from '../src/documents/merge.js';
import { DocumentError, parseDocument, type Doc, type ObjectNode } from '../src/documents/model.js';
import { applyOp, type Env } from '../src/documents/ops.js';
import { restoreObjects } from '../src/documents/restore.js';
import { DocumentSession } from '../src/documents/session.js';
import { listRevisions, openDocument, openRevision, realFs, saveDocument, type StoreFs } from '../src/documents/store.js';

const kdf = { logN: 14, r: 8, p: 1 };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: n, props: {}, ...over });
const folder = (n: number, over: Partial<ObjectNode> = {}) => node(n, { type: 'folder', name: `f${n}`, ...over });
const env: Env = { newId: () => { throw new Error('No ids are made here'); } };
const where = async () => join(await mkdtemp(join(tmpdir(), 'rwsafe-')), 'ws.rwdoc');
const open = (path: string) => DocumentSession.open(path, { password: 'pw' }, { kdf });
/** A file system that stops, once armed, at the commit of a save (the rename that puts the new file in place), until the test lets it go. */
function pausingFs() {
  let armed = false;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atPause = new Promise<void>((resolve) => { reached = resolve; });
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (armed) { armed = false; reached(); await gate; } await realFs.rename(from, to); } };
  return { fs, arm: () => { armed = true; }, atPause, release };
}
const make = (nodes: ObjectNode[]): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'ws', revision: 0, objects: Object.fromEntries(nodes.map((o) => [o.id, o])) });
// f1 holds n2; n3 and n7 are at the top level, and so are f5, f6 and f8.
const start = () => make([folder(1), node(2, { parentId: id(1), order: 0, props: { host: 'a' } }), node(3), folder(5), folder(6), node(7), folder(8)]);

/**
 * Two sessions on one file. `a` saves first: another host for n2, n3 deleted, f5 moved into f6 and f8 deleted. `b` edits the same document at the same time: another
 * host for n2, another name for n3, f6 moved into f5 and a new connection n9 in f8. So b's save finds one conflict of each kind and is held back.
 */
async function held() {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  const b = await open(path);
  a.update((d) => { d.objects[id(2)]!.props.host = 'from-a'; });
  a.apply({ op: 'remove', id: id(3) }, env);
  a.apply({ op: 'move', id: id(5), parentId: id(6) }, env);
  a.apply({ op: 'remove', id: id(8) }, env);
  assert.deepEqual(await a.save(), { saved: true });
  b.update((d) => { d.objects[id(2)]!.props.host = 'from-b'; d.objects[id(3)]!.name = 'renamed'; });
  b.apply({ op: 'move', id: id(6), parentId: id(5) }, env);
  b.apply({ op: 'add', id: id(9), parentId: id(8), type: 'connection', name: 'n9', props: {} }, env);
  const result = await b.save();
  assert.equal(result.saved, false);
  assert.deepEqual(b.conflicts.map((c) => c.kind).sort(), ['cycle', 'delete-edit', 'field', 'orphan']);
  return { path, a, b };
}
const kindOf = (b: DocumentSession, kind: Conflict['kind']) => b.conflicts.find((c) => c.kind === kind)!;
const theirs: (c: Conflict) => Choice = (c) => (c.kind === 'field' ? 'theirs' : c.kind === 'delete-edit' ? 'delete' : c.kind === 'orphan' ? 'keep' : 'accept');

test('every kind of conflict is decided in the session, together, and what was decided is what the next save writes', async () => {
  const { path, b } = await held();
  b.resolveMany(b.conflicts.map((c) => ({ key: keyOf(c), choice: theirs(c) })));
  assert.deepEqual(b.conflicts, []);
  assert.deepEqual(await b.save(), { saved: true }, 'nothing is left to decide: the document is written');
  const written = (await open(path)).doc;
  assert.equal(written.objects[id(2)]!.props.host, 'from-a', 'theirs for the field');
  assert.equal(Object.hasOwn(written.objects, id(3)), false, 'they deleted n3 and it was edited here: deleted');
  assert.equal(written.objects[id(9)]!.parentId, null, 'n9 was added to a folder that they deleted: kept at the top level');
  assert.deepEqual([written.objects[id(5)]!.parentId, written.objects[id(6)]!.parentId], [null, null], 'the folders that were moved into each other are where they were');
});

test('one at a time: a choice that does not belong to its conflict, and a conflict that is not pending, are refused and decide nothing', async () => {
  const { path, b } = await held();
  const field = kindOf(b, 'field');
  assert.throws(() => b.resolve(field, 'keep'), (e: unknown) => e instanceof ConflictError && e.code === 'bad-choice');
  assert.throws(() => b.resolve({ ...field }, 'mine'), (e: unknown) => e instanceof ConflictError && e.code === 'unknown-conflict' && /Not a pending conflict/.test(e.message), 'a copy of a conflict is not the conflict');
  assert.throws(() => b.resolveMany([{ key: 'c-0000000000000000', choice: 'mine' }]), (e: unknown) => e instanceof ConflictError && e.code === 'unknown-conflict');
  assert.equal(b.conflicts.length, 4);
  for (const conflict of [...b.conflicts]) b.resolve(conflict, conflict.kind === 'field' ? 'mine' : conflict.kind === 'delete-edit' ? 'keep' : conflict.kind === 'orphan' ? 'delete' : 'accept');
  assert.deepEqual(b.conflicts, []);
  assert.deepEqual(await b.save(), { saved: true });
  const written = (await open(path)).doc;
  assert.deepEqual([written.objects[id(2)]!.props.host, written.objects[id(3)]!.name, Object.hasOwn(written.objects, id(9))], ['from-b', 'renamed', false], 'mine for the field, n3 kept as it was edited here, the orphan deleted');
});

test('a choice that would not leave a document is refused whole, and the working copy and the conflicts are as they were', async () => {
  const path = await where();
  const a = await DocumentSession.create(path, make([folder(1), folder(2), node(3, { parentId: id(1), order: 0 }), folder(4, { order: 3 })]), 'pw', { kdf });
  const b = await open(path);
  a.apply({ op: 'move', id: id(3), parentId: id(2) }, env);
  await a.save();
  b.apply({ op: 'remove', id: id(2) }, env);
  b.apply({ op: 'move', id: id(3), parentId: id(4) }, env);
  assert.equal((await b.save()).saved, false);
  const [conflict] = b.conflicts;
  assert.deepEqual(b.conflicts.map((c) => c.kind), ['field'], 'they moved n3 into f2, which was deleted here');
  const doc = b.doc;
  assert.throws(() => b.resolve(conflict!, 'theirs'), (e: unknown) => e instanceof DocumentError && e.code === 'bad-parent');
  assert.throws(() => b.resolveMany([{ key: keyOf(conflict!), choice: 'theirs' }]), DocumentError);
  assert.equal(b.doc, doc, 'the working copy is the very one it was');
  assert.deepEqual(b.conflicts, [conflict]);
  b.resolve(conflict!, 'mine');
  assert.deepEqual(await b.save(), { saved: true });
  assert.equal((await open(path)).doc.objects[id(3)]!.parentId, id(4));
});

test('an edit settles what is pending: a conflict about what it deleted is gone, "mine" follows what was typed since, and a field that now holds their value is no conflict', async () => {
  const { b } = await held();
  const before = [...b.conflicts];
  const field = kindOf(b, 'field') as Extract<Conflict, { kind: 'field' }>;
  b.update((d) => { d.objects[id(7)]!.name = 'unrelated'; });
  assert.deepEqual(b.conflicts, before, 'an edit of something else leaves every conflict alone');
  b.conflicts.forEach((c, i) => assert.equal(c, before[i], 'the very same objects'));
  b.update((d) => { d.objects[id(2)]!.props.host = 'typed'; });
  assert.equal(b.conflicts.length, 4);
  const typed = kindOf(b, 'field') as Extract<Conflict, { kind: 'field' }>;
  assert.deepEqual([typed.mine, typed.theirs, typed.base], ['typed', 'from-a', 'a'], 'what is shown as mine is what the document holds now');
  assert.equal(keyOf(typed), keyOf(field), 'and it is the same conflict');
  b.update((d) => { d.objects[id(2)]!.props.host = 'from-a'; });
  assert.deepEqual(b.conflicts.map((c) => c.kind).sort(), ['cycle', 'delete-edit', 'orphan'], 'both sides hold one value: nothing to decide');
  b.apply({ op: 'remove', id: id(9) }, env);
  assert.deepEqual(b.conflicts.map((c) => c.kind).sort(), ['cycle', 'delete-edit'], 'the orphan was deleted');
  b.apply({ op: 'remove', id: id(3) }, env);
  assert.deepEqual(b.conflicts.map((c) => c.kind), ['cycle'], 'and so was n3');
  b.update((d) => { d.objects[id(2)]!.props.host = 'x'; });
  assert.deepEqual(b.conflicts.map((c) => c.kind), ['cycle'], 'a conflict that was settled does not come back');
});

test('reload throws away what was changed here and what was held back, and takes the file as it is; the next save is an ordinary one', async () => {
  const { path, a, b } = await held();
  assert.equal(b.merges, 1);
  await b.reload();
  assert.deepEqual(b.conflicts, []);
  assert.equal(b.dirty, false);
  assert.equal(b.merges, 2, 'the window has to take the document again');
  assert.deepEqual(b.doc, a.doc);
  assert.equal(b.doc.objects[id(2)]!.props.host, 'from-a');
  b.update((d) => { d.objects[id(7)]!.name = 'after'; });
  assert.deepEqual(await b.save(), { saved: true });
  assert.equal((await open(path)).doc.objects[id(7)]!.name, 'after');
});

test('a reload that cannot take the file (it is in a newer format) keeps the working copy, and the next save still does not write over it', async () => {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  a.update((d) => { d.objects[id(2)]!.name = 'mine'; });
  const other = (await openDocument(path, 'pw', { kdf })).handle;
  await saveDocument(other, Buffer.from(JSON.stringify({ schemaVersion: 3, id: id(900), kind: 'workspace', name: 'ws', revision: 9, objects: {} })), { kdf });
  const theirs = await readFile(path);
  const doc = a.doc;
  await assert.rejects(a.reload(), (e: unknown) => e instanceof DocumentError && e.code === 'unsupported-schema');
  assert.equal(a.doc, doc);
  assert.equal(a.dirty, true);
  await assert.rejects(a.save(), (e: unknown) => e instanceof DocumentError && e.code === 'unsupported-schema');
  assert.deepEqual(await readFile(path), theirs, 'the newer file is as the other program left it');
});

test('the working copy can be made another version of the document (a revision, say): it is unsaved like any edit and decides what was pending; another document, or no document, is refused', async () => {
  const { path, b } = await held();
  const old = start();
  b.replaceWith({ ...old, revision: 3 });
  assert.deepEqual(b.conflicts, [], 'everything that was pending is decided');
  assert.equal(b.dirty, true);
  assert.deepEqual(await b.save(), { saved: true });
  const written = (await open(path)).doc;
  assert.deepEqual(written.objects, old.objects, 'what was restored is what the file holds now');
  assert.equal(written.revision, 4, 'the number goes on from the highest there was: the file had 1, the revision that was put in has 3');
  const doc = b.doc;
  assert.throws(() => b.replaceWith({ ...old, id: id(901) }), (e: unknown) => e instanceof DocumentError && e.code === 'bad-document');
  assert.throws(() => b.replaceWith({ ...old, kind: 'vault' }), (e: unknown) => e instanceof DocumentError && e.code === 'bad-document');
  assert.throws(() => b.replaceWith({ ...old, objects: { [id(1)]: node(1, { parentId: id(99) }) } }), DocumentError);
  assert.equal(b.doc, doc);
});

test('a save that a timer made keeps the file it replaces only when the newest revision is old enough, and writes nothing while a conflict is open', async () => {
  const path = await where();
  let clock = 1_700_000_000_000;
  const a = await DocumentSession.create(path, start(), 'pw', { kdf, now: () => clock });
  const edit = (name: string) => a.update((d) => { d.objects[id(7)]!.name = name; });
  edit('one');
  assert.deepEqual(await a.save({ auto: true }), { saved: true });
  assert.equal((await listRevisions(path)).length, 1, 'there was no revision: the file it replaced is kept');
  clock += 60_000;
  edit('two');
  await a.save({ auto: true });
  assert.equal((await listRevisions(path)).length, 1, 'a minute later: no');
  clock += 1_000;
  edit('three');
  await a.save();
  assert.equal((await listRevisions(path)).length, 2, 'a save that was asked for always keeps it');
  assert.equal((await open(path)).doc.objects[id(7)]!.name, 'three');
  const { path: heldPath, b } = await held();
  const file = await readFile(heldPath);
  assert.deepEqual(await b.save({ auto: true }), { saved: false, conflicts: b.conflicts });
  assert.deepEqual(await readFile(heldPath), file, 'with a conflict open nothing is written');
});

test('an edit that something other than an operation works out (a restore) is applied like one: it is unsaved, it settles what is pending, and one that is refused changes nothing', async () => {
  const { b } = await held();
  const before = b.doc, pending = [...b.conflicts];
  let ids = 0;
  const made: Env = { newId: () => `ffffffff-0000-4000-8000-${String(++ids).padStart(12, '0')}` };
  const restored = b.change((doc) => restoreObjects(doc, start(), [id(3)], made, 'Restored'));
  assert.equal(b.doc.objects[restored.created!]!.name, 'Restored');
  assert.equal(b.dirty, true);
  assert.deepEqual(b.conflicts, pending, 'nothing that is pending was touched');
  const doc = b.doc;
  assert.throws(() => b.change((d) => restoreObjects(d, start(), [id(99)], made, 'Restored')), /does not have that object/);
  assert.equal(b.doc, doc);
  b.change((d) => applyOp(d, { op: 'remove', id: id(9) }, env));
  assert.deepEqual(b.conflicts.map((c) => c.kind).sort(), ['cycle', 'delete-edit', 'field'], 'the orphan went with the object that was removed');
  assert.notEqual(b.doc, before);
});

test('the first save by a timer after a decision that throws something away keeps the file it replaces, whatever the age of the newest revision; the next one is an ordinary one', async () => {
  const path = await where();
  let clock = 1_700_000_000_000;
  const a = await DocumentSession.create(path, start(), 'pw', { kdf, now: () => clock });
  a.update((d) => { d.objects[id(7)]!.name = 'one'; });
  await a.save();
  assert.equal((await listRevisions(path)).length, 1);
  clock += 60_000;
  a.update((d) => { d.objects[id(7)]!.name = 'two'; });
  await a.save({ auto: true });
  assert.equal((await listRevisions(path)).length, 1, 'a minute after the newest revision a save by a timer keeps nothing');
  a.replaceWith({ ...start(), revision: 1 });                  // a whole earlier version is put in: the file that the timer replaces holds the work of the last minute
  clock += 5_000;
  await a.save({ auto: true });
  const kept = await listRevisions(path);
  assert.equal(kept.length, 2, 'the file with "two" is kept');
  assert.equal(parseDocument(await openRevision(path, 'pw', kept[0]!, { kdf })).objects[id(7)]!.name, 'two');
  clock += 5_000;
  a.update((d) => { d.objects[id(7)]!.name = 'three'; });
  await a.save({ auto: true });
  assert.equal((await listRevisions(path)).length, 2, 'and only that one: the next save by a timer is an ordinary one');
});

test('the same after conflicts were decided: the file that the other writer saved is kept when the decision replaces what they wrote', async () => {
  const { path, b } = await held();
  const before = await listRevisions(path);
  b.resolveMany(b.conflicts.map((c) => ({ key: keyOf(c), choice: c.kind === 'field' ? 'mine' : c.kind === 'delete-edit' ? 'keep' : c.kind === 'orphan' ? 'keep' : 'accept' })));
  assert.deepEqual(await b.save({ auto: true }), { saved: true });
  const after = await listRevisions(path);
  assert.equal(after.length, before.length + 1, 'a revision of a moment ago exists, and the file of the other writer is kept all the same');
  assert.equal(parseDocument(await openRevision(path, 'pw', after[0]!, { kdf })).objects[id(2)]!.props.host, 'from-a', 'it is what they wrote');
  assert.equal((await open(path)).doc.objects[id(2)]!.props.host, 'from-b', 'and mine is what the file holds now');
  const one = await held();
  one.b.resolve(kindOf(one.b, 'field'), 'theirs');
  one.b.resolve(kindOf(one.b, 'delete-edit'), 'delete');
  one.b.resolve(kindOf(one.b, 'orphan'), 'keep');
  one.b.resolve(kindOf(one.b, 'cycle'), 'accept');
  const kept = (await listRevisions(one.path)).length;
  await one.b.save({ auto: true });
  assert.equal((await listRevisions(one.path)).length, kept + 1, 'deciding one at a time is a decision too');
});

test('putting in a version that is what the working copy already is changes nothing: not unsaved, not another working copy, and nothing is kept at the next save', async () => {
  const path = await where();
  let clock = 1_700_000_000_000;
  const a = await DocumentSession.create(path, start(), 'pw', { kdf, now: () => clock });
  const doc = a.doc;
  a.replaceWith({ ...start(), revision: 9 });
  assert.equal(a.dirty, false);
  assert.equal(a.doc, doc, 'the very same working copy');
  a.update((d) => { d.objects[id(2)]!.name = 'edited'; });
  const edited = a.doc;
  a.replaceWith({ ...structuredClone(a.doc), revision: 3 });
  assert.equal(a.doc, edited);
  assert.equal(a.dirty, true, 'and it is as unsaved as it was');
  assert.deepEqual(await a.save(), { saved: true });
  assert.equal((await listRevisions(path)).length, 1, 'asked for: the file it replaces is kept');
  clock += 60_000;
  a.update((d) => { d.objects[id(2)]!.name = 'again'; });
  a.replaceWith({ ...structuredClone(a.doc), revision: 4 });
  await a.save({ auto: true });
  assert.equal((await listRevisions(path)).length, 1, 'nothing was thrown away by putting in what was there: a minute after the newest revision a save by a timer keeps nothing');
});

test('putting in a version that is what the working copy is while conflicts are pending decides them (the working copy is what is kept); one that differs only in the name of the document is another working copy', async () => {
  const { b } = await held();
  assert.equal(b.conflicts.length, 4);
  const doc = b.doc;
  b.replaceWith(structuredClone(doc));
  assert.deepEqual(b.conflicts, [], 'what the working copy holds is what was chosen');
  assert.notEqual(b.doc, doc, 'it is the version that was put in');
  const named = b.doc;
  b.replaceWith({ ...structuredClone(named), name: 'another name', revision: 9 });
  assert.equal(b.doc.name, 'another name');
  assert.notEqual(b.doc, named, 'the name of the document is part of what is compared');
});

test('after a reload nothing is thrown away by the save that follows, whatever was decided before: a save by a timer keeps the file only as a timer does', async () => {
  const { path, b } = await held();
  b.resolve(kindOf(b, 'field'), 'theirs');                         // a decision: the next save would keep the file it replaces
  await b.reload();
  const before = (await listRevisions(path)).length;
  b.update((d) => { d.objects[id(7)]!.name = 'after'; });
  assert.deepEqual(await b.save({ auto: true }), { saved: true });
  assert.equal((await listRevisions(path)).length, before, 'the working copy was the file: there was nothing to throw away');
});

test('a conflict about a property that is named like one every object has is told apart from the property: an edit of something else leaves it the very conflict it was', async () => {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  a.update((d) => { d.objects[id(2)]!.props['constructor'] = 'base'; });
  await a.save();
  const b = await open(path);
  a.update((d) => { d.objects[id(2)]!.props['constructor'] = 'theirs'; });
  await a.save();
  b.update((d) => { delete d.objects[id(2)]!.props['constructor']; });
  assert.equal((await b.save()).saved, false);
  const [conflict] = b.conflicts;
  assert.deepEqual([b.conflicts.length, conflict!.kind], [1, 'field']);
  b.update((d) => { d.objects[id(7)]!.name = 'unrelated'; });
  assert.equal(b.conflicts[0], conflict, 'this side removed the property: that is what the document holds, and the conflict is untouched');
});

test('a reload of a file that holds another document is refused and changes nothing, and the next save does not write over that file', async () => {
  for (const other of [{ id: id(901), kind: 'workspace' }, { id: id(900), kind: 'vault' }]) {
    const path = await where();
    const a = await DocumentSession.create(path, start(), 'pw', { kdf });
    a.update((d) => { d.objects[id(2)]!.name = 'mine'; });
    const handle = (await openDocument(path, 'pw', { kdf })).handle;
    await saveDocument(handle, Buffer.from(JSON.stringify({ schemaVersion: 1, ...other, name: 'Another', revision: 3, objects: {} })), { kdf });
    const theirs = await readFile(path);
    const doc = a.doc;
    await assert.rejects(a.reload(), (e: unknown) => e instanceof DocumentError && e.code === 'bad-document', JSON.stringify(other));
    assert.equal(a.doc, doc);
    assert.equal(a.dirty, true);
    await assert.rejects(a.save(), /not the same document/);
    assert.deepEqual(await readFile(path), theirs, 'the other file is as it was left');
  }
});

test('deciding one conflict takes with it the conflicts about what it deleted', async () => {
  const path = await where();
  const a = await DocumentSession.create(path, make([folder(1), node(2, { parentId: id(1), order: 0 })]), 'pw', { kdf });
  const b = await open(path);
  a.apply({ op: 'remove', id: id(1) }, env);
  assert.deepEqual(await a.save(), { saved: true });
  b.update((d) => { d.objects[id(1)]!.name = 'F b'; d.objects[id(2)]!.name = 'C b'; });
  assert.equal((await b.save()).saved, false);
  assert.deepEqual(b.conflicts.map((c) => c.kind), ['delete-edit', 'delete-edit']);
  b.resolve(b.conflicts.find((c) => c.kind === 'delete-edit' && c.id === id(1))!, 'delete');
  assert.deepEqual(b.conflicts, [], 'the folder went, and so did what was in it: nothing is left to decide');
  assert.deepEqual(Object.keys(b.doc.objects), []);
});

/** a renames n2, n3 and the document; b has renamed the same: three field conflicts, and a move of n3 that both did. */
async function sameFields() {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  const b = await open(path);
  a.update((d) => { d.name = 'ws a'; d.objects[id(2)]!.name = 'a2'; d.objects[id(2)]!.props.tags = ['x']; });
  a.apply({ op: 'move', id: id(3), parentId: id(5) }, env);
  assert.deepEqual(await a.save(), { saved: true });
  b.update((d) => { d.name = 'ws b'; d.objects[id(2)]!.name = 'b2'; d.objects[id(2)]!.props.tags = ['y']; });
  b.apply({ op: 'move', id: id(3), parentId: id(6) }, env);
  assert.equal((await b.save()).saved, false);
  return b;
}
const fieldOf = (b: DocumentSession, field: string) => b.conflicts.find((c) => c.kind === 'field' && c.field === field) as Extract<Conflict, { kind: 'field' }>;

test('"mine" in a conflict follows what is typed since, for the name of the document, a name, a folder and a value that is a list; an edit of something else leaves the very same conflicts', async () => {
  const b = await sameFields();
  const before = [...b.conflicts];
  assert.deepEqual(['document.name', 'name', 'parentId', 'props.tags'].map((f) => fieldOf(b, f)?.kind), ['field', 'field', 'field', 'field'], 'all four are conflicts');
  b.update((d) => { d.objects[id(7)]!.name = 'unrelated'; });
  b.conflicts.forEach((c, i) => assert.equal(c, before[i], 'the very same object, also for a value that is a list'));
  b.update((d) => { d.name = 'typed name'; d.objects[id(2)]!.name = 'typed 2'; d.objects[id(3)]!.parentId = id(8); d.objects[id(2)]!.props.tags = ['typed']; });
  assert.deepEqual([fieldOf(b, 'document.name').mine, fieldOf(b, 'name').mine, fieldOf(b, 'parentId').mine, fieldOf(b, 'props.tags').mine], ['typed name', 'typed 2', id(8), ['typed']]);
  b.update((d) => { d.name = 'ws a'; });
  assert.equal(fieldOf(b, 'document.name'), undefined, 'the document holds their name: no conflict');
});

test('deciding nothing is not a decision: the next save by a timer keeps the file only as a timer does', async () => {
  const path = await where();
  let clock = 1_700_000_000_000;
  const a = await DocumentSession.create(path, start(), 'pw', { kdf, now: () => clock });
  a.update((d) => { d.objects[id(7)]!.name = 'one'; });
  await a.save();
  assert.equal((await listRevisions(path)).length, 1);
  clock += 60_000;
  a.update((d) => { d.objects[id(7)]!.name = 'two'; });
  a.resolveMany([]);
  await a.save({ auto: true });
  assert.equal((await listRevisions(path)).length, 1, 'nothing was thrown away: a minute after the newest revision a save by a timer keeps nothing');
});

test('a save that was already being written when a whole version was put in does not use that decision up: the next save by a timer keeps what it wrote', { timeout: 20_000 }, async () => {
  const path = await where();
  let clock = 1_700_000_000_000;
  const slow = pausingFs();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf, now: () => clock, fs: slow.fs });
  a.update((d) => { d.objects[id(7)]!.name = 'one'; });
  await a.save();
  clock += 60_000;
  a.update((d) => { d.objects[id(7)]!.name = 'two'; });
  slow.arm();
  const saving = a.save({ auto: true });
  await slow.atPause;                                  // the file with "two" is being put in place
  a.replaceWith({ ...start(), revision: 1 });          // and a whole earlier version is put in meanwhile
  slow.release();
  assert.deepEqual(await saving, { saved: true });
  assert.equal(a.dirty, true, 'the version that was put in is not written yet');
  clock += 5_000;
  await a.save({ auto: true });
  const kept = await listRevisions(path);
  assert.equal(kept.length, 2, 'the save that began before the decision did not keep the file: the next one keeps what that save wrote');
  assert.equal(parseDocument(await openRevision(path, 'pw', kept[0]!, { kdf })).objects[id(7)]!.name, 'two');
});

test('a decision made while a save that carries an earlier decision is being written is a decision of its own: the next save by a timer keeps what that save wrote', { timeout: 20_000 }, async () => {
  const path = await where();
  let clock = 1_700_000_000_000;
  const slow = pausingFs();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf, now: () => clock, fs: slow.fs });
  a.update((d) => { d.objects[id(7)]!.name = 'one'; });
  await a.save();
  clock += 60_000;
  const version = (name: string): Doc => { const d = start(); d.objects[id(7)]!.name = name; return { ...d, revision: 1 }; };
  a.replaceWith(version('first'));                     // the first decision: the save that follows keeps the file it replaces
  slow.arm();
  const saving = a.save({ auto: true });
  await slow.atPause;
  a.replaceWith(version('second'));                    // the second one, while that save is being written
  slow.release();
  assert.deepEqual(await saving, { saved: true });
  assert.equal((await listRevisions(path)).length, 2, 'the first decision kept the file with "one"');
  clock += 5_000;
  await a.save({ auto: true });
  const kept = await listRevisions(path);
  assert.equal(kept.length, 3, 'the second decision keeps the file that holds "first"');
  assert.equal(parseDocument(await openRevision(path, 'pw', kept[0]!, { kdf })).objects[id(7)]!.name, 'first');
});

test('an edit that deletes what a conflict was about throws away what the other writer saved about it: the next save by a timer keeps their file', async () => {
  const { path, b } = await held();
  const before = (await listRevisions(path)).length;
  b.apply({ op: 'remove', id: id(9) }, env);                      // the orphan: n9 was added to a folder that they deleted
  b.apply({ op: 'remove', id: id(3) }, env);                      // the object that was edited here and deleted there
  b.update((d) => { d.objects[id(2)]!.props.host = 'from-a'; });  // their value
  b.apply({ op: 'remove', id: id(5) }, env);                      // one of the folders of the cycle
  assert.deepEqual(b.conflicts, [], 'nothing is left to decide');
  assert.deepEqual(await b.save({ auto: true }), { saved: true });
  assert.equal((await listRevisions(path)).length, before + 1, 'their file is kept: what they changed in n9, n3 and the folders is not in what is written');
});

test('an edit that only makes a field hold their value settles that conflict without throwing anything away: a save by a timer is an ordinary one', async () => {
  const path = await where();
  const a = await DocumentSession.create(path, start(), 'pw', { kdf });
  const b = await open(path);
  a.update((d) => { d.objects[id(2)]!.props.host = 'from-a'; });
  await a.save();
  b.update((d) => { d.objects[id(2)]!.props.host = 'from-b'; });
  assert.equal((await b.save()).saved, false);
  assert.equal(b.conflicts.length, 1);
  const before = (await listRevisions(path)).length;
  b.update((d) => { d.objects[id(2)]!.props.host = 'from-a'; });
  assert.deepEqual(b.conflicts, []);
  assert.deepEqual(await b.save({ auto: true }), { saved: true });
  assert.equal((await listRevisions(path)).length, before, 'both sides hold one value: nothing of theirs goes, and the file is kept only as a timer keeps it');
});

test('what was chosen to be kept stays kept when the folder it is in is decided later, in another set of choices or one choice at a time', async () => {
  for (const how of ['sets', 'single'] as const) {
    const path = await where();
    const a = await DocumentSession.create(path, make([folder(1), node(2, { parentId: id(1), order: 0 }), node(3, { order: 1 })]), 'pw', { kdf });
    const b = await open(path);
    a.apply({ op: 'remove', id: id(1) }, env);                     // they delete f1, and n2 with it
    assert.deepEqual(await a.save(), { saved: true });
    b.update((d) => { d.objects[id(1)]!.name = 'F b'; d.objects[id(2)]!.name = 'C b'; });
    assert.equal((await b.save()).saved, false);
    const [f, c] = [1, 2].map((n) => b.conflicts.find((x) => x.kind === 'delete-edit' && x.id === id(n))!);
    assert.ok(f && c, 'both were edited here: two conflicts');
    if (how === 'sets') { b.resolveMany([{ key: keyOf(c!), choice: 'keep' }]); b.update((d) => { d.objects[id(3)]!.name = 'typed meanwhile'; }); b.resolveMany([{ key: keyOf(f!), choice: 'delete' }]); } // an edit between the two does not make it forget
    else { b.resolve(c!, 'keep'); b.resolve(f!, 'delete'); }
    assert.deepEqual(b.conflicts, [], how);
    assert.equal(Object.hasOwn(b.doc.objects, id(1)), false, `${how}: the folder is deleted`);
    assert.deepEqual([b.doc.objects[id(2)]?.name, b.doc.objects[id(2)]?.parentId], ['C b', null], `${how}: what was chosen to be kept is at the top level, not deleted with the folder`);
    assert.deepEqual(await b.save(), { saved: true });
    assert.equal((await open(path)).doc.objects[id(2)]!.name, 'C b', how);
  }
});

test('an object that was put in a folder by choosing their parent is not deleted with that folder when it is deleted in a later set of choices: it goes to the top level; in one set the same choices are refused', async () => {
  const build = async () => {
    const path = await where();
    const a = await DocumentSession.create(path, make([folder(1), folder(2), node(3, { parentId: id(1), order: 0 }), folder(4, { order: 3 })]), 'pw', { kdf });
    const b = await open(path);
    a.update((d) => { d.objects[id(2)]!.name = 'F2 a'; });
    a.apply({ op: 'move', id: id(3), parentId: id(2) }, env);   // they edit f2 and move n3 into it
    await a.save();
    b.apply({ op: 'remove', id: id(2) }, env);                   // here f2 is deleted and n3 goes into f4
    b.apply({ op: 'move', id: id(3), parentId: id(4) }, env);
    assert.equal((await b.save()).saved, false);
    assert.deepEqual(b.conflicts.map((c) => c.kind).sort(), ['delete-edit', 'field']);
    return { path, b, move: keyOf(kindOf(b, 'field')), gone: keyOf(kindOf(b, 'delete-edit')) };
  };
  const { path, b, move, gone } = await build();
  b.resolveMany([{ key: move, choice: 'theirs' }]);              // n3 goes into f2, where they put it
  assert.equal(b.doc.objects[id(3)]!.parentId, id(2));
  b.resolveMany([{ key: gone, choice: 'delete' }]);              // and now f2 is deleted: n3 must not go with it
  assert.deepEqual([Object.hasOwn(b.doc.objects, id(2)), b.doc.objects[id(3)]?.parentId], [false, null]);
  assert.deepEqual(await b.save(), { saved: true });
  assert.equal(Object.hasOwn((await open(path)).doc.objects, id(3)), true);
  const whole = await build();
  assert.throws(() => whole.b.resolveMany([{ key: whole.move, choice: 'theirs' }, { key: whole.gone, choice: 'delete' }]), (e: unknown) => e instanceof DocumentError && e.code === 'bad-parent');
  assert.equal(whole.b.conflicts.length, 2, 'refused whole: nothing is decided');
});
