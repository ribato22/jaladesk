import { credentialRecord } from '../src/credentials/model.js';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConflictError, type ConflictView } from '../src/documents/conflicts.js';
import { DocumentLibrary, LibraryError, translate, type ChangeEvent, type Delta } from '../src/documents/library.js';
import { openDocument, realFs, saveDocument, StoreError } from '../src/documents/store.js';

const kdf = { logN: 14, r: 8, p: 1 };
// Assertions still inspect the private credential value; schema 2 keeps it outside the node's public props.
function credentialProps(library: DocumentLibrary, documentId: string, objectId: string): { password: string | undefined } {
  const record = credentialRecord(library.privateDocument(documentId).doc, library.node(documentId, objectId)!);
  assert.ok(record, 'the credential reference must remain closed');
  return { password: record.password };
}

const where = async () => join(await mkdtemp(join(tmpdir(), 'rwsafelib-')), 'lab.rwdoc');
const failsWith = (code: string, run: () => unknown) =>
  assert.rejects(async () => run(), (error: unknown) => error instanceof LibraryError && error.code === code, `expected a LibraryError with code ${code}`);
/** A library with a clock that the test moves, so that the revisions get names that tell the order. */
function timed() {
  let clock = 1_700_000_000_000;
  return { lib: new DocumentLibrary({ kdf, now: () => clock }), tick: (ms = 1000) => { clock += ms; } };
}
const names = (delta: Delta) => delta.upsert.map((o) => o.name).sort();
type FieldView = Extract<ConflictView, { kind: 'field' }>;
type DeleteEditView = Extract<ConflictView, { kind: 'delete-edit' }>;
const viewOf = <K extends ConflictView['kind']>(views: ConflictView[], kind: K) => views.find((v) => v.kind === kind) as Extract<ConflictView, { kind: K }>;

/**
 * Two libraries on one file (two programs). `one` saves first: another host for web, `old` deleted, another password in a credential that the window never sees.
 * `two` has edited the same objects meanwhile (another host, `old` renamed, another password), so its save is held back with three conflicts.
 */
async function held() {
  const path = await where();
  const one = new DocumentLibrary({ kdf }), two = new DocumentLibrary({ kdf });
  const a = (await one.create(path, 'Lab', 'pw')).id;
  const web = one.add(a, { parentId: null, type: 'connection', name: 'web', props: { host: 'base' } }).objectId;
  const old = one.add(a, { parentId: null, type: 'connection', name: 'old' }).objectId;
  const cred = one.writeCredential(a, { parentId: null, name: 'Secret', record: { kind: 'credential', username: '', domain: '', password: 'pw-secret' } }).objectId;
  await one.save(a);
  const b = (await two.open(path, 'pw')).id;
  one.update(a, web, { props: { host: 'from-one' } });
  one.remove(a, old);
  one.writeCredential(a, { objectId: cred, name: one.node(a, cred)!.name, record: { kind: 'credential', username: '', domain: '', password: 'from-one-secret' } });
  await one.save(a);
  two.update(b, web, { props: { host: 'from-two' } });
  two.update(b, old, { name: 'edited' });
  two.writeCredential(b, { objectId: cred, name: two.node(b, cred)!.name, record: { kind: 'credential', username: '', domain: '', password: 'from-two-secret' } });
  const result = await two.save(b);
  assert.deepEqual([result.saved, result.conflicts], [false, 3]);
  return { path, one, two, b, web, old, cred };
}

test('the conflicts of a document are told to the window without an id, and without the name or the value of what the window never sees', async () => {
  const { two, b, web, old, cred } = await held();
  const { views, total } = two.conflicts(b);
  assert.equal(total, 3);
  assert.deepEqual(views.map((v) => v.kind).sort(), ['delete-edit', 'field', 'hidden']);
  const host = viewOf(views, 'field') as FieldView;
  assert.deepEqual([host.object, host.what, host.property, host.base, host.mine, host.theirs], ['web', 'property', 'host', { text: 'base' }, { text: 'from-two' }, { text: 'from-one' }]);
  const deleted = viewOf(views, 'delete-edit') as DeleteEditView;
  assert.deepEqual([deleted.object, deleted.deletedBy], ['edited', 'theirs']);
  const text = JSON.stringify(views);
  for (const leak of ['pw-secret', 'from-one-secret', 'from-two-secret', 'Secret', web, old, cred]) assert.equal(text.includes(leak), false, `${leak}: neither a secret nor an id`);
  assert.equal(two.view(b).conflicts, 3, 'the state of the document says how many there are');
});

test('a list of conflicts that is long is cut where the window cannot use more, and says how many there are', async () => {
  const path = await where();
  const one = new DocumentLibrary({ kdf }), two = new DocumentLibrary({ kdf });
  const a = (await one.create(path, 'Lab', 'pw')).id;
  const ids = Array.from({ length: 230 }, (_, i) => one.add(a, { parentId: null, type: 'connection', name: `c${i}` }).objectId);
  await one.save(a);
  const b = (await two.open(path, 'pw')).id;
  for (const id of ids) { one.update(a, id, { name: 'by one' }); two.update(b, id, { name: 'by two' }); }
  await one.save(a);
  assert.equal((await two.save(b)).conflicts, 230);
  const { views, total } = two.conflicts(b);
  assert.deepEqual([views.length, total], [200, 230]);
  assert.equal(new Set(views.map((v) => v.key)).size, 200);
  two.resolve(b, { all: 'theirs' });
  assert.equal(two.view(b).conflicts, 0, 'a decision for everything is not held to what the window was shown');
  assert.equal(two.snapshot(b).objects.filter((o) => o.name === 'by one').length, 230);
});

test('conflicts are decided by their keys, and what is decided is saved: the window is told to start again, and the other program sees the result', async () => {
  const { path, two, b, web, old, cred } = await held();
  const { views } = two.conflicts(b);
  const delta = two.resolve(b, { items: [{ key: viewOf(views, 'field').key, choice: 'theirs' }, { key: viewOf(views, 'delete-edit').key, choice: 'delete' }, { key: viewOf(views, 'hidden').key, choice: 'mine' }] });
  assert.deepEqual([delta.reset, delta.conflicts, delta.dirty], [true, 0, true]);
  assert.deepEqual(names(delta), ['web'], 'every object the window sees, as it is now: old is gone');
  assert.equal(two.node(b, old), undefined);
  assert.equal((await two.save(b)).saved, true);
  const third = new DocumentLibrary({ kdf });
  const c = (await third.open(path, 'pw')).id;
  assert.deepEqual([third.node(c, web)!.props, third.node(c, old), credentialProps(third, c, cred)], [{ host: 'from-one' }, undefined, { password: 'from-two-secret' }]);
});

test('"mine for everything" and "theirs for everything" decide every conflict, the ones the window does not see too, each in the way that side has', async () => {
  const theirs = await held();
  const delta = theirs.two.resolve(theirs.b, { all: 'theirs' });
  assert.deepEqual([delta.conflicts, theirs.two.node(theirs.b, theirs.web)!.props, theirs.two.node(theirs.b, theirs.old), credentialProps(theirs.two, theirs.b, theirs.cred)], [0, { host: 'from-one' }, undefined, { password: 'from-one-secret' }]);
  const mine = await held();
  mine.two.resolve(mine.b, { all: 'mine' });
  assert.deepEqual([mine.two.view(mine.b).conflicts, mine.two.node(mine.b, mine.web)!.props, mine.two.node(mine.b, mine.old)!.name, credentialProps(mine.two, mine.b, mine.cred)], [0, { host: 'from-two' }, 'edited', { password: 'from-two-secret' }], 'they deleted old and it was edited here: mine keeps it');
  assert.equal((await mine.two.save(mine.b)).saved, true);
});

test('"mine for everything" deletes what this side deleted together with its folder, also when the other side edited it; "theirs for everything" keeps their edit', async () => {
  const build = async () => {
    const path = await where();
    const one = new DocumentLibrary({ kdf }), two = new DocumentLibrary({ kdf });
    const a = (await one.create(path, 'Lab', 'pw')).id;
    const dir = one.add(a, { parentId: null, type: 'folder', name: 'F' }).objectId;
    const child = one.add(a, { parentId: dir, type: 'connection', name: 'child' }).objectId;
    await one.save(a);
    const b = (await two.open(path, 'pw')).id;
    one.update(a, child, { name: 'edited by one' });
    await one.save(a);
    two.remove(b, dir);                                    // the folder is deleted here, and the child with it
    assert.equal((await two.save(b)).saved, false);
    assert.deepEqual(two.conflicts(b).views.map((v) => v.kind).sort(), ['delete-edit', 'orphan'], 'the child is both: deleted here and edited there, and its folder is gone');
    return { two, b, child };
  };
  const mine = await build();
  mine.two.resolve(mine.b, { all: 'mine' });
  assert.equal(mine.two.node(mine.b, mine.child), undefined, 'what this side deleted stays deleted');
  assert.equal((await mine.two.save(mine.b)).saved, true);
  const theirs = await build();
  theirs.two.resolve(theirs.b, { all: 'theirs' });
  assert.deepEqual([theirs.two.node(theirs.b, theirs.child)?.name, theirs.two.node(theirs.b, theirs.child)?.parentId], ['edited by one', null], 'their edit stays, at the top level');
});

test('a key that is not there, a choice that is not for its conflict and a conflict decided twice are refused, and nothing is decided', async () => {
  const { two, b } = await held();
  const field = viewOf(two.conflicts(b).views, 'field');
  await failsWith('unknown-conflict', () => two.resolve(b, { items: [{ key: 'c-0000000000000000', choice: 'mine' }] }));
  await failsWith('invalid', () => two.resolve(b, { items: [{ key: field.key, choice: 'keep' }] }));
  await failsWith('invalid', () => two.resolve(b, { items: [{ key: field.key, choice: 'mine' }, { key: field.key, choice: 'theirs' }] }));
  await failsWith('unknown-document', () => two.resolve('nope', { all: 'mine' }));
  assert.equal(two.view(b).conflicts, 3);
});

test('reload throws away what was changed here and what was held back, and takes the file as it is, in one step the window can take', async () => {
  const { two, b, web, old } = await held();
  const delta = await two.reload(b);
  assert.deepEqual([delta.reset, delta.dirty, delta.conflicts], [true, false, 0]);
  assert.deepEqual([two.node(b, web)!.props, two.node(b, old)], [{ host: 'from-one' }, undefined]);
  assert.deepEqual(two.snapshot(b).objects.map((o) => o.name).sort(), ['web']);
  two.update(b, web, { props: { host: 'after' } });
  assert.equal((await two.save(b)).saved, true);
});

test('a reload that cannot take the file says why and changes nothing; a document cannot be closed while it is being reloaded', { timeout: 20_000 }, async () => {
  const path = await where();
  let armed = false;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atRead = new Promise<void>((resolve) => { reached = resolve; });
  const fs = { ...realFs, readFile: async (file: string) => { if (armed) { armed = false; reached(); await gate; } return realFs.readFile(file); } };
  const lib = new DocumentLibrary({ kdf, fs });
  const { id, docId } = await lib.create(path, 'Lab', 'pw');
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  const other = (await openDocument(path, 'pw', { kdf })).handle;
  await saveDocument(other, Buffer.from(JSON.stringify({ schemaVersion: 3, id: docId, kind: 'workspace', name: 'Lab', revision: 9, objects: {} })), { kdf });
  await failsWith('too-new', () => lib.reload(id));
  assert.deepEqual([lib.view(id).dirty, lib.snapshot(id).objects.map((o) => o.name)], [true, ['A']], 'what was changed here is still here');
  await saveDocument(other, Buffer.from(JSON.stringify({ schemaVersion: 1, id: docId, kind: 'workspace', name: 'Lab', revision: 10, objects: {} })), { kdf });
  armed = true;
  const reloading = lib.reload(id);
  await atRead;
  await failsWith('busy', () => lib.close(id, { discard: true }));
  release();
  await reloading;
  assert.equal(lib.view(id).dirty, false);
  lib.close(id);
});

test('a save that a timer made keeps the file it replaces only when the newest revision is old enough', async () => {
  const { lib, tick } = timed();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const edit = (name: string) => lib.add(id, { parentId: null, type: 'folder', name });
  edit('one');
  assert.equal((await lib.save(id, { auto: true })).saved, true);
  assert.equal((await lib.revisions(id)).length, 1, 'no revision yet: the file it replaced is kept');
  tick(60_000);
  edit('two');
  await lib.save(id, { auto: true });
  assert.equal((await lib.revisions(id)).length, 1, 'a minute later: no');
  tick(600_000);
  edit('three');
  await lib.save(id, { auto: true });
  assert.equal((await lib.revisions(id)).length, 2, 'eleven minutes later: yes');
  tick(1000);
  edit('four');
  await lib.save(id);
  assert.equal((await lib.revisions(id)).length, 3, 'a save that was asked for: always');
});

/** A document with three saves behind it: Servers holds web, db and a credential; then web is another host and has another name, db and the credential are removed and fresh is added; then last is added. */
async function history() {
  const { lib, tick } = timed();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const folder = lib.add(id, { parentId: null, type: 'folder', name: 'Servers' }).objectId;
  const web = lib.add(id, { parentId: folder, type: 'connection', name: 'web', props: { host: 'a' } }).objectId;
  const db = lib.add(id, { parentId: folder, type: 'connection', name: 'db' }).objectId;
  const cred = lib.writeCredential(id, { parentId: folder, name: 'Secret', record: { kind: 'credential', username: '', domain: '', password: 'pw-secret' } }).objectId;
  tick(); await lib.save(id);
  lib.update(id, web, { name: 'web2', props: { host: 'b' } });
  lib.remove(id, db);
  lib.remove(id, cred);
  lib.add(id, { parentId: null, type: 'connection', name: 'fresh' });
  tick(); await lib.save(id);
  tick(); lib.add(id, { parentId: null, type: 'folder', name: 'last' }); await lib.save(id);
  return { lib, id, folder, web, db, cred, list: await lib.revisions(id) };
}

test('the revisions of a document are listed, newest first, with the time each was taken', async () => {
  const { list } = await history();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((r) => r.at), [...list.map((r) => r.at)].sort((x, y) => y - x));
  for (const r of list) assert.match(r.name, /^\d{8}T\d{9}Z-[0-9a-f]{12}\.rwdoc$/);
  assert.equal(new Set(list.map((r) => r.at)).size, 3);
});

test('a revision is opened for the window as the objects it shows, with what the document does not have any more, what is different, and how many are new; nothing about what the window never sees', async () => {
  const { lib, id, web, db, cred, list } = await history();
  const view = await lib.revision(id, list[1]!.name); // the document as it was before the second save
  assert.deepEqual(view.objects.map((o) => o.name).sort(), ['Servers', 'db', 'web']);
  assert.deepEqual([view.name, view.at, view.docName], [list[1]!.name, list[1]!.at, 'Lab']);
  assert.deepEqual(view.gone, [db], 'db was removed; the credential was too, and the window is not told');
  assert.deepEqual(view.changed, [web]);
  assert.equal(view.added, 2, 'fresh and last: the credential is not counted');
  const text = JSON.stringify(view);
  for (const leak of ['Secret', 'pw-secret', cred]) assert.equal(text.includes(leak), false, leak);
  assert.equal(lib.view(id).dirty, false, 'looking at a revision changes nothing');
});

test('a revision that is not there, that is not a name of one, or that another key sealed, is told as such', async () => {
  const { lib, id, list } = await history();
  await failsWith('invalid', () => lib.revision(id, '../../etc/passwd'));
  await failsWith('not-found', () => lib.revision(id, '20200101T000000000Z-000000000000.rwdoc'));
  const stranger = await where();
  await new DocumentLibrary({ kdf }).create(stranger, 'Other', 'pw');
  await copyFile(stranger, join(`${lib.views()[0]!.path}.revisions`, '20200101T000000000Z-111111111111.rwdoc'));
  await failsWith('revision-key', () => lib.revision(id, '20200101T000000000Z-111111111111.rwdoc'));
  await failsWith('unknown-document', () => lib.revision('nope', list[0]!.name));
  await failsWith('unknown-document', () => lib.revisions('nope'));
});

test('objects of a revision are restored into a new folder at the top level, as an edit that is unsaved; a folder brings what is in it, the credential too, and the window is told of what it sees', async () => {
  const { lib, id, folder, web, db, cred, list } = await history();
  const before = lib.size(id);
  const result = await lib.restore(id, list[1]!.name, { ids: [folder], folderName: 'Restored' });
  assert.equal(lib.node(id, result.created!)!.name, 'Restored');
  assert.deepEqual(names(result.delta), ['Restored', 'Servers', 'db', 'web']);
  assert.equal(lib.size(id), before + 1 + 4, 'the folder, Servers, web, db and the credential, which the window is not told of');
  assert.equal(lib.node(id, db)!.name, 'db', 'db is gone from the document: it comes back with its own id');
  assert.equal(credentialProps(lib, id, cred).password, 'pw-secret');
  assert.equal(lib.node(id, web)!.name, 'web2', 'web is in the document: it is as it is, and the copy has another id');
  assert.equal(lib.view(id).dirty, true);
  assert.equal((await lib.save(id)).saved, true);
});

test('a restore that names what is not there, what the window never sees, nothing, or a name that is not a name, is refused and changes nothing', async () => {
  const { lib, id, cred, list } = await history();
  const before = lib.size(id);
  const some = (await lib.revision(id, list[1]!.name)).objects[0]!.id;
  await failsWith('unknown-object', () => lib.restore(id, list[1]!.name, { ids: ['00000000-0000-4000-8000-0000000000aa'], folderName: 'Restored' }));
  await failsWith('unknown-object', () => lib.restore(id, list[1]!.name, { ids: [cred], folderName: 'Restored' }));
  await failsWith('invalid', () => lib.restore(id, list[1]!.name, { ids: [], folderName: 'Restored' }));
  await failsWith('invalid', () => lib.restore(id, list[1]!.name, { ids: [some], folderName: ' ' }));
  await failsWith('invalid', () => lib.restore(id, list[1]!.name, { ids: [some], folderName: 'x'.repeat(257) }));
  assert.equal(lib.size(id), before);
  assert.equal(lib.view(id).dirty, false);
});

test('the whole document can be made what a revision was: an edit that is unsaved, that decides what was held back, and that the window takes from the start', async () => {
  const { lib, id, list } = await history();
  const delta = (await lib.restore(id, list[1]!.name, { all: true })).delta;
  assert.deepEqual([delta.reset, delta.dirty], [true, true]);
  assert.deepEqual(names(delta), ['Servers', 'db', 'web']);
  assert.deepEqual(lib.snapshot(id).objects.map((o) => o.name).sort(), ['Servers', 'db', 'web']);
  assert.equal((await lib.save(id)).saved, true);
  const { two, b } = await held();
  const [newest] = await two.revisions(b);
  const decided = (await two.restore(b, newest!.name, { all: true })).delta;
  assert.deepEqual([decided.conflicts, decided.dirty], [0, true], 'what was held back is decided by it');
  assert.equal((await two.save(b)).saved, true);
});

test('whoever listens is told when a document changes, is saved, is decided or closed; one that stops listening is told nothing, and one that fails does not stop the edit', async () => {
  const lib = new DocumentLibrary({ kdf });
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const heard: string[] = [];
  const stop = lib.onChange((event) => heard.push(`${event.closed ? 'closed' : event.dirty ? 'dirty' : 'clean'}${event.conflicts > 0 ? `+${event.conflicts}` : ''}`));
  lib.onChange(() => { throw new Error('a listener that is broken'); });
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  assert.deepEqual(heard, ['dirty'], 'the edit went through although the second listener threw');
  await lib.save(id);
  assert.deepEqual(heard, ['dirty', 'clean']);
  stop();
  lib.add(id, { parentId: null, type: 'folder', name: 'B' });
  assert.deepEqual(heard, ['dirty', 'clean'], 'it stopped listening');
  const quiet = new DocumentLibrary({ kdf });
  const second = (await quiet.create(await where(), 'Lab', 'pw')).id;
  const closing: string[] = [];
  quiet.onChange((event) => closing.push(event.closed ? 'closed' : 'changed'));
  quiet.close(second);
  assert.deepEqual(closing, ['closed']);
  const { two, b } = await held();
  const decisions: string[] = [];
  two.onChange((event) => decisions.push(`${event.dirty ? 'dirty' : 'clean'}+${event.conflicts}`));
  two.resolve(b, { all: 'mine' });
  assert.deepEqual(decisions, ['dirty+0'], 'a decision is a change: the count of what is held back is in it');
});

test('what the store and the conflicts refuse is told with the code the window knows', () => {
  assert.equal(translate(new ConflictError('unknown-conflict', 'x'), 'edit').code, 'unknown-conflict');
  assert.equal(translate(new ConflictError('bad-choice', 'x'), 'edit').code, 'invalid');
  assert.equal(translate(new StoreError('bad-revision', 'x'), 'read').code, 'invalid');
  assert.equal(translate(new StoreError('rekeyed', 'x'), 'read').code, 'rekeyed');
  assert.equal(translate(new StoreError('busy', 'x'), 'write').code, 'busy', 'another save holds the lock');
  assert.equal(translate(new StoreError('conflict', 'x'), 'write').code, 'busy', 'a document that keeps changing on disk');
  assert.equal(translate(new StoreError('damaged', 'x'), 'read').code, 'unreadable');
  assert.equal(translate(new StoreError('io', 'x'), 'read').code, 'io');
});

test('a listener that fails is reported, and the edit goes through; a report that fails does not stop it either', async () => {
  const reported: unknown[] = [];
  const lib = new DocumentLibrary({ kdf, report: (error) => reported.push(error) });
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const broken = new Error('a listener that is broken');
  lib.onChange(() => { throw broken; });
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  assert.deepEqual(reported, [broken]);
  assert.equal(lib.view(id).dirty, true);
  const loud = new DocumentLibrary({ kdf, report: () => { throw new Error('and so is the report'); } });
  const second = (await loud.create(await where(), 'Lab', 'pw')).id;
  loud.onChange(() => { throw broken; });
  loud.add(second, { parentId: null, type: 'folder', name: 'B' });
  assert.equal(loud.view(second).dirty, true);
});

/** A file system whose next read of a revision waits until it is let go: the document can be closed meanwhile. */
function gatedReads() {
  let armed = false;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atRead = new Promise<void>((resolve) => { reached = resolve; });
  const fs = { ...realFs, readFile: async (file: string) => { if (armed && file.includes('.revisions')) { armed = false; reached(); await gate; } return realFs.readFile(file); } };
  return { fs, atRead, arm: () => { armed = true; }, release: () => release() };
}

for (const action of ['looked at', 'put back'] as const) {
  test(`a document that is closed while a revision of it is being ${action} is not open any more; it is not a document that cannot be read`, { timeout: 20_000 }, async () => {
    const { fs, atRead, arm, release } = gatedReads();
    const lib = new DocumentLibrary({ kdf, fs });
    const { id } = await lib.create(await where(), 'Lab', 'pw');
    lib.add(id, { parentId: null, type: 'folder', name: 'A' });
    await lib.save(id);
    const [revision] = await lib.revisions(id);
    arm();
    const working = action === 'looked at' ? lib.revision(id, revision!.name) : lib.restore(id, revision!.name, { all: true });
    await atRead;
    lib.close(id, { discard: true });
    release();
    await failsWith('unknown-document', () => working);
  });
}

test('a revision that is damaged is told as unreadable, not as sealed with another key', async () => {
  const { lib, id, list } = await history();
  const file = join(`${lib.views()[0]!.path}.revisions`, list[0]!.name);
  const bytes = await readFile(file);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(file, bytes);
  await failsWith('unreadable', () => lib.revision(id, list[0]!.name));
  assert.equal(lib.view(id).dirty, false);
});

test('a revision that the key of the document opens but that is of another document is told as unreadable, and nothing of it is shown', async () => {
  const { lib, id } = await history();
  const path = lib.views()[0]!.path;
  const other = (await openDocument(path, 'pw', { kdf })).handle; // the same password and salt, so the same key
  await saveDocument(other, Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'workspace', name: 'Other', revision: 1, objects: {} })), { kdf });
  const name = '20200101T000000000Z-222222222222.rwdoc';
  await copyFile(path, join(`${path}.revisions`, name));
  await failsWith('unreadable', () => lib.revision(id, name));
  await failsWith('unreadable', () => lib.restore(id, name, { all: true }));
  assert.equal(lib.view(id).dirty, false);
});

test('an edit of an object that the window never sees is still an edit: the document is unsaved, the picture moves on, and whoever listens is told', async () => {
  const lib = new DocumentLibrary({ kdf });
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const secret = lib.writeCredential(id, { parentId: null, name: 'Secret', record: { kind: 'credential', username: '', domain: '', password: 'pw-secret' } }).objectId;
  await lib.save(id);
  const heard: ChangeEvent[] = [];
  lib.onChange((event) => heard.push(event));
  const before = lib.view(id);
  assert.equal(before.dirty, false);
  const delta = lib.remove(id, secret);
  assert.deepEqual([delta.dirty, delta.upsert.length, delta.remove.length, delta.from, delta.seq], [true, 0, 0, before.seq, before.seq + 1], 'nothing is told of the object, but the document is not the same');
  assert.deepEqual(heard, [{ id, dirty: true, conflicts: 0 }]);
});

test('a folder of revisions that cannot be read is told as an error of the disk, not as a document without earlier versions', async () => {
  const path = await where();
  let armed = false;
  const fs = { ...realFs, readdir: async (dir: string) => { if (armed && dir.endsWith('.revisions')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return realFs.readdir(dir); } };
  const lib = new DocumentLibrary({ kdf, fs });
  const { id } = await lib.create(path, 'Lab', 'pw');
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  await lib.save(id);
  assert.equal((await lib.revisions(id)).length, 1);
  armed = true;
  await failsWith('io', () => lib.revisions(id));
});

test('deciding nothing is not a change: a document without conflicts is not started again, and nobody is told', async () => {
  const lib = new DocumentLibrary({ kdf });
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const heard: ChangeEvent[] = [];
  lib.onChange((event) => heard.push(event));
  const seq = lib.view(id).seq;
  for (const how of [{ all: 'mine' }, { all: 'theirs' }, { items: [] }] as const) {
    const delta = lib.resolve(id, how);
    assert.deepEqual([delta.reset, delta.from, delta.seq, delta.upsert.length, delta.remove.length], [undefined, seq, seq, 0, 0], JSON.stringify(how));
  }
  assert.deepEqual(heard, []);
  await failsWith('invalid', () => lib.resolve(id, { all: 'nobody' } as never));
});

test('putting back the revision that the document is already changes nothing: it is not unsaved, and the window is not started again', async () => {
  const { lib, id, list } = await history();
  await lib.restore(id, list[1]!.name, { all: true });
  await lib.save(id);
  const seq = lib.view(id).seq;
  const heard: ChangeEvent[] = [];
  lib.onChange((event) => heard.push(event));
  const again = await lib.restore(id, list[1]!.name, { all: true });
  assert.deepEqual([again.delta.reset, again.delta.dirty, again.delta.seq, heard.length], [undefined, false, seq, 0]);
});

test('whoever listens is told how many conflicts hold a save back; a save that changes nothing tells nobody; closing everything tells of every document', async () => {
  const path = await where();
  const one = new DocumentLibrary({ kdf }), two = new DocumentLibrary({ kdf });
  const a = (await one.create(path, 'Lab', 'pw')).id;
  const web = one.add(a, { parentId: null, type: 'connection', name: 'web', props: { host: 'base' } }).objectId;
  await one.save(a);
  const b = (await two.open(path, 'pw')).id;
  one.update(a, web, { props: { host: 'from-one' } });
  await one.save(a);
  two.update(b, web, { props: { host: 'from-two' } });
  const heard: string[] = [];
  two.onChange((event) => heard.push(`${event.dirty ? 'dirty' : 'clean'}+${event.conflicts}${event.closed ? ' closed' : ''}`));
  assert.deepEqual([(await two.save(b)).saved], [false]);
  assert.deepEqual(heard, ['dirty+1'], 'the save is held back by one conflict, and the listener is told so');
  await two.save(b);
  assert.deepEqual(heard, ['dirty+1'], 'held back again, in the same way: nothing is different');
  const third = (await two.open(await where().then(async (file) => { await new DocumentLibrary({ kdf }).create(file, 'Third', 'pw'); return file; }), 'pw')).id;
  assert.ok(third);
  two.closeAll();
  assert.equal(heard.filter((line) => line.endsWith('closed')).length, 2, 'both documents are told as closed');
});

test('a revision tells nothing of what the window never sees: a credential that changed or came since is neither different nor new', async () => {
  const { lib, tick } = timed();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  lib.add(id, { parentId: null, type: 'connection', name: 'web' });
  const cred = lib.writeCredential(id, { parentId: null, name: 'Secret', record: { kind: 'credential', username: '', domain: '', password: 'one' } }).objectId;
  tick(); await lib.save(id);
  lib.writeCredential(id, { objectId: cred, name: lib.node(id, cred)!.name, record: { kind: 'credential', username: '', domain: '', password: 'two' } });
  lib.writeCredential(id, { parentId: null, name: 'Other', record: { kind: 'credential', username: '', domain: '', password: 'x' } });
  tick(); await lib.save(id);
  const [newest] = await lib.revisions(id);
  const view = await lib.revision(id, newest!.name);
  assert.deepEqual([view.changed, view.gone, view.added], [[], [], 0]);
  assert.equal(JSON.stringify(view).includes(cred), false);
});

test('a file that is a document with damaged content cannot be reloaded, and is told as unreadable', async () => {
  const path = await where();
  const lib = new DocumentLibrary({ kdf });
  const { id } = await lib.create(path, 'Lab', 'pw');
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  const other = (await openDocument(path, 'pw', { kdf })).handle;
  await saveDocument(other, Buffer.from('this is not a document'), { kdf });
  await failsWith('unreadable', () => lib.reload(id));
  assert.equal(lib.view(id).dirty, true, 'what was changed here is still here');
});

test('a reload that cannot take the file leaves the next save unable to write over it', async () => {
  const path = await where();
  const lib = new DocumentLibrary({ kdf });
  const { id, docId } = await lib.create(path, 'Lab', 'pw');
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  const other = (await openDocument(path, 'pw', { kdf })).handle;
  await saveDocument(other, Buffer.from(JSON.stringify({ schemaVersion: 3, id: docId, kind: 'workspace', name: 'Lab', revision: 9, objects: {} })), { kdf });
  const newer = await readFile(path);
  await failsWith('too-new', () => lib.reload(id));
  await failsWith('too-new', () => lib.save(id));
  assert.deepEqual(await readFile(path), newer, 'the file of the newer version is as the other program left it');
});

test('only an id of an object of the revision is an id to restore: a list that holds the id is not it', async () => {
  const { lib, id, web, list } = await history();
  await failsWith('unknown-object', () => lib.restore(id, list[1]!.name, { ids: [[web]] as never, folderName: 'x' }));
  await failsWith('unknown-object', () => lib.restore(id, list[1]!.name, { ids: [{ toString: () => web }] as never, folderName: 'x' }));
  assert.equal(lib.view(id).dirty, false);
});

test('putting the whole document back says whether it changed anything: the version that the working copy already is changes nothing', async () => {
  const { lib, tick } = timed();
  const id = (await lib.create(await where(), 'Lab', 'pw')).id;
  lib.add(id, { parentId: null, type: 'folder', name: 'one' });
  await lib.save(id);
  tick();
  lib.add(id, { parentId: null, type: 'folder', name: 'two' });
  await lib.save(id);
  const [newest] = await lib.revisions(id);              // the document as it was before the second save: it holds "one" only
  const first = await lib.restore(id, newest!.name, { all: true });
  assert.deepEqual([first.changed, first.delta.dirty], [true, true]);
  const again = await lib.restore(id, newest!.name, { all: true });
  assert.deepEqual([again.changed, again.delta.dirty], [false, true], 'nothing changed; it is still unsaved, as it was');
  const objects = await lib.restore(id, newest!.name, { ids: [lib.snapshot(id).objects[0]!.id], folderName: 'Back' });
  assert.equal('changed' in objects, false, 'only the whole document says it: an object restored makes a folder, always');
});
