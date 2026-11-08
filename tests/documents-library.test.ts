import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EnvelopeError, seal } from '../src/documents/envelope.js';
import { DocumentLibrary, LibraryError, translate } from '../src/documents/library.js';
import { DocumentError } from '../src/documents/model.js';
import { compareSiblings } from '../src/documents/order.js';
import { OpError } from '../src/documents/ops.js';
import { applyDelta, modelOf } from '../src/desktop/docmodel.js';
import { listRevisions, openDocument, realFs, saveDocument } from '../src/documents/store.js';

const kdf = { logN: 14, r: 8, p: 1 };
const library = () => new DocumentLibrary({ kdf });
const where = async (name = 'lab.rwdoc') => join(await mkdtemp(join(tmpdir(), 'rwlib-')), name);
const failsWith = (code: string, run: () => unknown) =>
  assert.rejects(async () => run(), (error: unknown) => error instanceof LibraryError && error.code === code, `expected a LibraryError with code ${code}`);
/** What a window would be shown of a document: its objects (folders and connections), as {name, parent name} pairs in display order are easier to read than ids. */
const objectsOf = (lib: DocumentLibrary, id: string) => lib.snapshot(id).objects;
const names = (lib: DocumentLibrary, id: string, parentId: string | null) => objectsOf(lib, id).filter((o) => o.parentId === parentId).sort(compareSiblings).map((o) => o.name);
const reopened = async (path: string, password = 'pw') => { const lib = library(); const summary = await lib.open(path, password); return { lib, summary, objects: objectsOf(lib, summary.id) }; };

test('a new document is empty, clean and encrypted on disk, and opens again with its password', async () => {
  const path = await where();
  const lib = library();
  const created = await lib.create(path, 'Lab', 'secret-1');
  assert.deepEqual([created.name, objectsOf(lib, created.id), created.dirty, created.path, created.conflicts, created.seq], ['Lab', [], false, path, 0, 0]);
  lib.add(created.id, { parentId: null, type: 'folder', name: 'Marker-Folder-Name' });
  assert.equal(lib.view(created.id).dirty, true);
  assert.deepEqual((await lib.save(created.id)).saved, true);
  assert.equal((await readFile(path)).includes(Buffer.from('Marker-Folder-Name')), false, 'no object name appears in the file');
  lib.close(created.id);
  const again = await reopened(path, 'secret-1');
  assert.deepEqual(again.objects.map((o) => o.name), ['Marker-Folder-Name']);
  assert.equal(again.summary.docId, created.docId);
  assert.equal(again.summary.dirty, false);
});

test('add gives siblings increasing order, returns the new id, and refuses a parent that is not a folder', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const a = lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  const b = lib.add(id, { parentId: null, type: 'connection', name: 'B', props: { protocol: 'rdp', host: 'h' } });
  const c = lib.add(id, { parentId: a.objectId, type: 'connection', name: 'C' });
  const objects = Object.fromEntries(objectsOf(lib, id).map((o) => [o.id, o]));
  assert.deepEqual([objects[a.objectId]!.order, objects[b.objectId]!.order, objects[c.objectId]!.order], [0, 1, 0]);
  assert.deepEqual(objects[b.objectId]!.props, { protocol: 'rdp', host: 'h' });
  await failsWith('invalid', () => lib.add(id, { parentId: b.objectId, type: 'folder', name: 'inside a connection' }));
  await failsWith('invalid', () => lib.add(id, { parentId: '00000000-0000-4000-8000-0000000000ff', type: 'folder', name: 'no such parent' }));
  await failsWith('invalid', () => lib.add(id, { parentId: null, type: 'folder', name: 'x'.repeat(257) }));
  await failsWith('invalid', () => lib.add(id, { parentId: null, type: 'folder', name: '   ' }));
  assert.equal(lib.size(id), 3, 'a refused edit changes nothing');
});

test('update renames and replaces the properties; remove takes the whole subtree; unknown ids are named as such', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const folder = lib.add(id, { parentId: null, type: 'folder', name: 'Servers' }).objectId;
  const inner = lib.add(id, { parentId: folder, type: 'folder', name: 'Inner' }).objectId;
  const leaf = lib.add(id, { parentId: inner, type: 'connection', name: 'web', props: { host: 'a' } }).objectId;
  const other = lib.add(id, { parentId: null, type: 'connection', name: 'other' }).objectId;
  lib.update(id, leaf, { name: 'web1', props: { host: 'b', port: 22 } });
  const changed = objectsOf(lib, id).find((o) => o.id === leaf)!;
  assert.deepEqual([changed.name, changed.props], ['web1', { host: 'b', port: 22 }]);
  await failsWith('invalid', () => lib.update(id, leaf, { name: '' }));
  await failsWith('unknown-object', () => lib.update(id, '00000000-0000-4000-8000-0000000000ee', { name: 'x' }));
  assert.equal(lib.subtreeSize(id, folder), 3);
  assert.equal(lib.subtreeSize(id, other), 1);
  lib.remove(id, folder);
  assert.deepEqual(objectsOf(lib, id).map((o) => o.id), [other]);
  await failsWith('unknown-object', () => lib.remove(id, folder));
});

test('save writes once: a clean document is not rewritten, revisions are kept, and two saves at once are one write', async () => {
  const path = await where();
  const lib = library();
  const { id } = await lib.create(path, 'Lab', 'pw');
  const before = (await readFile(path)).toString('hex');
  assert.deepEqual((await lib.save(id)).saved, true);
  assert.equal((await readFile(path)).toString('hex'), before, 'nothing to save, nothing written');
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  const both = await Promise.all([lib.save(id), lib.save(id)]);
  assert.deepEqual(both.map((r) => r.saved), [true, true]);
  const view = lib.view(id);
  assert.deepEqual([view.dirty, view.revision], [false, 1]);
  assert.equal((await listRevisions(path)).length, 1, 'the file before the save is kept as a revision');
});

test('a wrong or empty password is named as such and leaves nothing open', async () => {
  const path = await where();
  const lib = library();
  lib.close((await lib.create(path, 'Lab', 'right-pw')).id);
  await failsWith('wrong-password', () => lib.open(path, 'wrong-pw'));
  await failsWith('wrong-password', () => lib.open(path, ''));
  assert.deepEqual(lib.views(), []);
  assert.equal((await lib.open(path, 'right-pw')).name, 'Lab');
});

test('the same document cannot be open twice, by path or as a copy; it can be opened again after it is closed', async () => {
  const path = await where();
  const lib = library();
  const first = await lib.create(path, 'Lab', 'pw');
  await failsWith('already-open', () => lib.open(path, 'pw'));
  const copy = join(path, '..', 'copy.rwdoc');
  await copyFile(path, copy);
  await failsWith('duplicate-document', () => lib.open(copy, 'pw'));
  assert.equal(lib.views().length, 1);
  lib.close(first.id);
  assert.equal((await lib.open(copy, 'pw')).name, 'Lab');
});

test('close refuses unsaved changes unless they are thrown away on purpose; unknown sessions are named as such', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  assert.deepEqual(lib.dirtyIds(), [id]);
  await failsWith('unsaved', () => lib.close(id));
  assert.equal(lib.views().length, 1);
  lib.close(id, { discard: true });
  assert.deepEqual([lib.views(), lib.dirtyIds()], [[], []]);
  await failsWith('unknown-document', () => lib.view(id));
  await failsWith('unknown-document', () => lib.close(id));
});

test('what cannot be opened says why: missing, damaged, or from a newer version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rwlib-'));
  const lib = library();
  await failsWith('not-found', () => lib.open(join(dir, 'absent.rwdoc'), 'pw'));
  await writeFile(join(dir, 'junk.rwdoc'), Buffer.from('this is not a document at all, just text'));
  await failsWith('unreadable', () => lib.open(join(dir, 'junk.rwdoc'), 'pw'));
  const future = JSON.stringify({ schemaVersion: 3, id: '00000000-0000-4000-8000-000000000900', kind: 'workspace', name: 'x', revision: 0, objects: {} });
  const { file, unlocked } = await seal(Buffer.from(future), 'pw', { kdf });
  unlocked.dispose();
  await writeFile(join(dir, 'future.rwdoc'), file);
  await failsWith('too-new', () => lib.open(join(dir, 'future.rwdoc'), 'pw'));
  assert.deepEqual(lib.views(), []);
});

test('create never overwrites, and refuses a blank name or an empty password', async () => {
  const path = await where();
  const lib = library();
  lib.close((await lib.create(path, 'Lab', 'pw')).id);
  const before = await readFile(path);
  await failsWith('exists', () => lib.create(path, 'Other', 'pw'));
  assert.deepEqual(await readFile(path), before);
  const fresh = await where('b.rwdoc');
  await failsWith('invalid', () => lib.create(fresh, '  ', 'pw'));
  await failsWith('invalid', () => lib.create(fresh, 'Lab', ''));
  await failsWith('invalid', () => lib.create(fresh, 'Lab', 'x'.repeat(1025)));
});

test('two programs editing the same field: the second save is held back with a count and stays unsaved', async () => {
  const path = await where();
  const one = library();
  const two = library();
  const first = await one.create(path, 'Lab', 'pw');
  const node = one.add(first.id, { parentId: null, type: 'connection', name: 'web', props: { host: 'base' } }).objectId;
  await one.save(first.id);
  const second = await two.open(path, 'pw');
  one.update(first.id, node, { props: { host: 'from-one' } });
  two.update(second.id, node, { props: { host: 'from-two' } });
  assert.equal((await one.save(first.id)).saved, true);
  const held = await two.save(second.id);
  assert.deepEqual([held.saved, held.conflicts, held.delta.dirty, held.delta.conflicts], [false, 1, true, 1]);
  assert.equal((await reopened(path)).objects.find((o) => o.id === node)!.props.host, 'from-one', 'nothing was written over the other program\'s save');
});

test('closeAll drops every document without saving', async () => {
  const lib = library();
  const a = await lib.create(await where('a.rwdoc'), 'A', 'pw');
  await lib.create(await where('b.rwdoc'), 'B', 'pw');
  lib.add(a.id, { parentId: null, type: 'folder', name: 'unsaved' });
  lib.closeAll();
  assert.deepEqual(lib.views(), []);
  await failsWith('unknown-document', () => lib.view(a.id));
});

test('isOpen and assertNew answer before any password is asked: an open file, an existing file, a free name', async () => {
  const path = await where();
  const lib = library();
  await lib.assertNew(path);
  const view = await lib.create(path, 'Lab', 'pw');
  assert.equal(lib.isOpen(path), true);
  assert.equal(lib.isOpen(join(path, '..', 'other.rwdoc')), false);
  await failsWith('already-open', () => lib.assertNew(path));
  lib.close(view.id);
  assert.equal(lib.isOpen(path), false);
  await failsWith('exists', () => lib.assertNew(path));
});

test('save always returns a promise, even for a document that is not open (a caller that catches it must not be bypassed by a throw)', async () => {
  const pending = library().save('00000000-0000-4000-8000-0000000000aa');
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, (error: unknown) => error instanceof LibraryError && error.code === 'unknown-document');
});

test('the same file under another spelling is the same file: through a link, or with another case of the name where the volume ignores case', async () => {
  const path = await where('Lab.rwdoc');
  const lib = library();
  await lib.create(path, 'Lab', 'pw');
  const shout = join(path, '..', 'LAB.RWDOC');
  if (existsSync(shout)) { // a volume that ignores case (the default on macOS and Windows)
    assert.equal(lib.isOpen(shout), true);
    await failsWith('already-open', () => lib.open(shout, 'pw'));
  }
  if (process.platform !== 'win32') { // creating a link needs no privilege here
    const link = join(path, '..', 'link.rwdoc');
    await symlink(path, link);
    assert.equal(lib.isOpen(link), true);
    await failsWith('already-open', () => lib.open(link, 'pw'));
  }
  assert.equal(lib.views().length, 1);
});

test('what the window is given is an allow-list: no path, nothing the library may add later; a snapshot, a delta and a state carry exactly these fields', async () => {
  const lib = library();
  const summary = await lib.create(await where(), 'Lab', 'pw');
  const snapshot = lib.snapshot(summary.id);
  const fields = ['conflicts', 'dirty', 'docId', 'id', 'meta', 'name', 'revision', 'seq'];
  assert.deepEqual(Object.keys(snapshot).sort(), [...fields, 'objects'].sort());
  assert.equal('path' in snapshot, false);
  assert.deepEqual(Object.keys(snapshot.meta!).sort(),['createdAt','sort','updatedAt']);assert.equal('defaults' in snapshot,false);assert.equal('secrets' in snapshot,false);
  assert.deepEqual(Object.keys(lib.add(summary.id, { parentId: null, type: 'folder', name: 'A' }).delta).sort(), [...fields, 'from', 'remove', 'upsert'].sort());
  assert.equal('path' in lib.view(summary.id), true, 'the main process keeps the path, and only it');
});

test('an object id that only the prototype chain has is not an object: update, remove, move, duplicate and subtreeSize name it unknown and write nothing to Object.prototype', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  try {
    for (const bogus of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      await failsWith('unknown-object', () => lib.update(id, bogus, { name: 'polluted', props: { polluted: true } }));
      await failsWith('unknown-object', () => lib.remove(id, bogus));
      await failsWith('unknown-object', () => lib.move(id, bogus, null));
      await failsWith('unknown-object', () => lib.duplicate(id, bogus));
      await failsWith('unknown-object', () => lib.subtreeSize(id, bogus));
      assert.equal(lib.node(id, bogus), undefined);
    }
    assert.equal(({} as { name?: string }).name, undefined, 'Object.prototype has no name');
    assert.equal(({} as { props?: unknown }).props, undefined, 'and no props');
    assert.equal(lib.size(id), 1);
  } finally {
    delete (Object.prototype as { name?: string }).name; // a failing run must not poison the tests after it
    delete (Object.prototype as { props?: unknown }).props;
  }
});

test('a save that was held back is held back again when it is asked for a second time: nothing is written over the other program', async () => {
  const path = await where();
  const one = library();
  const two = library();
  const first = await one.create(path, 'Lab', 'pw');
  const node = one.add(first.id, { parentId: null, type: 'connection', name: 'web', props: { host: 'base' } }).objectId;
  await one.save(first.id);
  const second = await two.open(path, 'pw');
  one.update(first.id, node, { props: { host: 'from-one' } });
  two.update(second.id, node, { props: { host: 'from-two' } });
  await one.save(first.id);
  const theirs = await readFile(path);
  const held = await two.save(second.id);
  const again = await two.save(second.id);
  assert.deepEqual([held.saved, again.saved, again.conflicts, again.delta.dirty], [false, false, 1, true]);
  assert.deepEqual(await readFile(path), theirs, 'neither attempt wrote anything');
});

test('a document that another program saved in a newer format is named as such when saving, and is not written over', async () => {
  const path = await where();
  const lib = library();
  const { id, docId } = await lib.create(path, 'Lab', 'pw');
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  const { handle } = await openDocument(path, 'pw', { kdf });
  await saveDocument(handle, Buffer.from(JSON.stringify({ schemaVersion: 3, id: docId, kind: 'workspace', name: 'Lab', revision: 9, objects: {} })), { kdf });
  handle.unlocked.dispose();
  const theirs = await readFile(path);
  await failsWith('too-new', () => lib.save(id));
  await failsWith('too-new', () => lib.save(id));
  assert.deepEqual(await readFile(path), theirs, 'the newer file is as the other program left it');
  assert.equal(lib.view(id).dirty, true, 'and the changes are kept');
});

test('a document cannot be closed while it is being saved: the close is refused as busy and the save still completes', { timeout: 20_000 }, async () => {
  let armed = false;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atCommit = new Promise<void>((resolve) => { reached = resolve; });
  const fs = { ...realFs, rename: async (from: string, to: string) => { if (armed) { reached(); await gate; } await realFs.rename(from, to); } };
  const lib = new DocumentLibrary({ kdf, fs });
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  lib.add(id, { parentId: null, type: 'folder', name: 'A' });
  armed = true;
  const saving = lib.save(id);
  await atCommit;
  await failsWith('busy', () => lib.close(id, { discard: true }));
  assert.equal(lib.views().length, 1, 'still open');
  release();
  assert.equal((await saving).saved, true);
  lib.close(id);
});

test('a link to a document is saved through: the link stays a link and the file it points to gets the change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rwlib-'));
  const real = join(dir, 'real.rwdoc');
  const made = library();
  made.close((await made.create(real, 'Lab', 'pw')).id);
  if (process.platform !== 'win32') { // creating a link needs no privilege here
    const link = join(dir, 'link.rwdoc');
    await symlink(real, link);
    const lib = library();
    const { id } = await lib.open(link, 'pw');
    lib.add(id, { parentId: null, type: 'folder', name: 'Saved through the link' });
    assert.equal((await lib.save(id)).saved, true);
    assert.equal((await lstat(link)).isSymbolicLink(), true, 'the link is still a link');
    lib.close(id);
    assert.deepEqual((await reopened(real)).objects.map((o) => o.name), ['Saved through the link']);
  }
});

test('the window is given folders and connections only: other kinds of object stay in the file and in the main process, in a snapshot and in every delta', async () => {
  const path = await where();
  const lib = library();
  const view = await lib.create(path, 'Lab', 'pw');
  lib.add(view.id, { parentId: null, type: 'folder', name: 'Folder' });
  lib.add(view.id, { parentId: null, type: 'connection', name: 'Conn' });
  const secret = lib.writeCredential(view.id, { parentId: null, name: 'Secret', record: { kind: 'credential', username: '', domain: '', password: 'hunter2-marker' } });
  assert.deepEqual([secret.delta.upsert, secret.delta.remove, secret.delta.dirty], [[], [], true], 'adding what the window never sees is a delta with no objects');
  lib.add(view.id, { parentId: null, type: 'task', name: 'Task' });
  const given = lib.snapshot(view.id);
  assert.deepEqual(given.objects.map((o) => o.name).sort(), ['Conn', 'Folder']);
  assert.equal(JSON.stringify(given).includes('hunter2-marker'), false, 'no secret reaches the window');
  assert.equal(lib.size(view.id), 4, 'the library still holds all four');
  const gone = lib.remove(view.id, secret.objectId);
  assert.deepEqual(gone.remove, [], 'and its id is not mentioned when it goes');
  lib.writeCredential(view.id, { parentId: null, name: 'Again', record: { kind: 'credential', username: '', domain: '' } });
  await lib.save(view.id);
  lib.close(view.id);
  const again = await reopened(path);
  assert.equal(again.lib.size(again.summary.id), 4, 'and a save keeps them in the file');
});

test('a document too large to be written is said to be too large, not unreadable; when reading, the same error means the file is not a document', () => {
  const tooBig = new EnvelopeError('bad-length', 'Document larger than the accepted maximum');
  assert.equal(translate(tooBig, 'write').code, 'too-large');
  assert.equal(translate(tooBig, 'read').code, 'unreadable');
  assert.equal(translate(new EnvelopeError('auth', 'Wrong password or damaged file'), 'read').code, 'wrong-password');
});

test('a refused move or add says why in the library\'s own words: a folder into itself is a cycle, too deep, too many, a bad position is invalid', () => {
  assert.equal(translate(new DocumentError('cycle', 'x'), 'edit').code, 'cycle');
  assert.equal(translate(new DocumentError('too-deep', 'x'), 'edit').code, 'too-deep');
  assert.equal(translate(new DocumentError('too-many-objects', 'x'), 'edit').code, 'too-many');
  assert.equal(translate(new DocumentError('bad-parent', 'x'), 'edit').code, 'invalid');
  assert.equal(translate(new OpError('bad-index', 'x'), 'edit').code, 'invalid');
  assert.equal(translate(new OpError('unknown-object', 'x'), 'edit').code, 'unknown-object');
});

// ---- deltas, snapshots and the operations of 02-B2a -----------------------------------------------------------------------------------------

test('every change is a delta that says exactly what is new or different, with a seq that counts the changes; asking for nothing is answered with nothing', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const folder = lib.add(id, { parentId: null, type: 'folder', name: 'Servers' });
  assert.deepEqual([folder.delta.seq, folder.delta.dirty, folder.delta.upsert.map((o) => o.name), folder.delta.remove], [1, true, ['Servers'], []]);
  const web = lib.add(id, { parentId: folder.objectId, type: 'connection', name: 'web' });
  assert.equal(web.delta.seq, 2);
  const renamed = lib.update(id, web.objectId, { name: 'web1' });
  assert.deepEqual([renamed.seq, renamed.upsert.map((o) => o.name)], [3, ['web1']]);
  const nothing = lib.update(id, web.objectId, { name: 'web1' });
  assert.deepEqual([nothing.seq, nothing.upsert, nothing.remove], [3, [], []], 'the same name again changes nothing, and seq stays');
  const gone = lib.remove(id, folder.objectId);
  assert.deepEqual([gone.seq, gone.upsert, gone.remove.sort()], [4, [], [folder.objectId, web.objectId].sort()]);
  assert.equal(lib.snapshot(id).seq, 4, 'a snapshot says which change it is at');
  assert.equal(lib.view(id).seq, 4);
});

test('a snapshot and the deltas after it give the same document as asking again: the window can keep up from the deltas alone', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const start = lib.snapshot(id);
  const held = new Map(start.objects.map((o) => [o.id, o]));
  const take = (d: { upsert: { id: string }[]; remove: string[] }) => { for (const gone of d.remove) held.delete(gone); for (const o of d.upsert) held.set(o.id, o as never); };
  const a = lib.add(id, { parentId: null, type: 'folder', name: 'A' }); take(a.delta);
  const b = lib.add(id, { parentId: a.objectId, type: 'folder', name: 'B' }); take(b.delta);
  take(lib.add(id, { parentId: b.objectId, type: 'connection', name: 'c', props: { host: 'h' } }).delta);
  take(lib.add(id, { parentId: null, type: 'connection', name: 'z' }, ).delta);
  take(lib.move(id, b.objectId, null, 0));
  take(lib.duplicate(id, a.objectId).delta);
  take(lib.update(id, a.objectId, { name: 'A1' }));
  take(lib.remove(id, a.objectId));
  assert.deepEqual([...held.values()].sort((x, y) => (x.id < y.id ? -1 : 1)), lib.snapshot(id).objects.sort((x, y) => (x.id < y.id ? -1 : 1)));
});

test('move puts an object into a folder or among its siblings; the delta is the moved object and the siblings that had to move up', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const f = lib.add(id, { parentId: null, type: 'folder', name: 'F' }).objectId;
  const [x, y, z] = ['x', 'y', 'z'].map((name) => lib.add(id, { parentId: f, type: 'connection', name }).objectId);
  const top = lib.add(id, { parentId: null, type: 'connection', name: 'top' }).objectId;
  assert.deepEqual(names(lib, id, f), ['x', 'y', 'z']);
  const toFront = lib.move(id, z!, f, 0);
  assert.deepEqual(names(lib, id, f), ['z', 'x', 'y']);
  assert.deepEqual(toFront.upsert.map((o) => o.name).sort(), ['x', 'y', 'z']);
  const down = lib.move(id, z!, f, 2);
  assert.deepEqual([names(lib, id, f), down.upsert.map((o) => o.name)], [['x', 'y', 'z'], ['z']], 'moving down costs one object when the orders have room');
  const into = lib.move(id, top, f);
  assert.deepEqual([names(lib, id, f), names(lib, id, null), into.upsert.map((o) => o.name)], [['x', 'y', 'z', 'top'], ['F'], ['top']]);
  const out = lib.move(id, x!, null, 1);
  assert.deepEqual([names(lib, id, null), names(lib, id, f)], [['F', 'x'], ['y', 'z', 'top']]);
  assert.deepEqual(out.upsert.map((o) => o.name), ['x']);
  void y;
  const same = lib.move(id, x!, null, 1);
  assert.deepEqual([same.upsert, same.seq], [[], out.seq], 'moving to where it is changes nothing');
  await failsWith('cycle', () => lib.move(id, f, f));
  await failsWith('invalid', () => lib.move(id, x!, null, 5));
  await failsWith('invalid', () => lib.move(id, x!, top));                                  // a connection is not a folder
  await failsWith('unknown-object', () => lib.move(id, '00000000-0000-4000-8000-0000000000ee', null));
});

test('duplicate copies an object and everything below it right after the original, with a name that no sibling has yet', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const f = lib.add(id, { parentId: null, type: 'folder', name: 'Servers' }).objectId;
  lib.add(id, { parentId: f, type: 'connection', name: 'web', props: { host: 'a' } });
  lib.add(id, { parentId: null, type: 'connection', name: 'last' });
  const first = lib.duplicate(id, f);
  assert.deepEqual(names(lib, id, null), ['Servers', 'Servers salinan', 'last']);
  assert.deepEqual(names(lib, id, first.objectId), ['web']);
  assert.notEqual(first.objectId, f);
  assert.deepEqual(first.delta.upsert.map((o) => o.name).sort(), ['Servers salinan', 'last', 'web'], 'the copies and the sibling that moved up');
  lib.duplicate(id, f);
  assert.deepEqual(names(lib, id, null), ['Servers', 'Servers salinan 2', 'Servers salinan', 'last']);
  lib.duplicate(id, f);
  assert.deepEqual(names(lib, id, null).filter((n) => n.startsWith('Servers')).sort(), ['Servers', 'Servers salinan', 'Servers salinan 2', 'Servers salinan 3']);
  const long = lib.add(id, { parentId: null, type: 'connection', name: 'n'.repeat(256) }).objectId;
  assert.equal(lib.node(id, lib.duplicate(id, long).objectId)!.name.length, 256, 'a copy of a name that fills the limit is cut to fit it');
  await failsWith('unknown-object', () => lib.duplicate(id, '00000000-0000-4000-8000-0000000000ee'));
});

test('a save that had to take another program\'s changes in gives the window a delta that starts it again from what is there now; an ordinary save does not', async () => {
  const path = await where();
  const one = library();
  const two = library();
  const a = await one.create(path, 'Lab', 'pw');
  const keep = one.add(a.id, { parentId: null, type: 'folder', name: 'Keep' }).objectId;
  await one.save(a.id);
  const b = await two.open(path, 'pw');
  one.add(a.id, { parentId: keep, type: 'connection', name: 'from-one' });
  await one.save(a.id);
  two.add(b.id, { parentId: null, type: 'connection', name: 'from-two' });
  const merged = await two.save(b.id);
  assert.equal(merged.saved, true);
  assert.equal(merged.delta.reset, true, 'the window starts again');
  assert.deepEqual(merged.delta.upsert.map((o) => o.name).sort(), ['Keep', 'from-one', 'from-two'], 'from everything that is there now, the other program\'s change included');
  assert.equal(merged.delta.seq, two.snapshot(b.id).seq);
  two.add(b.id, { parentId: null, type: 'connection', name: 'later' });
  const plain = await two.save(b.id);
  assert.deepEqual([plain.saved, plain.delta.reset, plain.delta.upsert, plain.delta.dirty], [true, undefined, [], false], 'an ordinary save says only that it is saved');
});

test('add can put the new object at a position among its siblings: the ones after it move up and are part of the delta; a position past the end is refused', async () => {
  const lib = library();
  const view = await lib.create(await where(), 'Lab', 'pw');
  for (const name of ['a', 'b', 'c']) lib.add(view.id, { parentId: null, type: 'connection', name });
  const first = lib.add(view.id, { parentId: null, type: 'folder', name: 'first', index: 0 });
  assert.deepEqual(names(lib, view.id, null), ['first', 'a', 'b', 'c']);
  assert.deepEqual(first.delta.upsert.map((o) => o.name).sort(), ['a', 'b', 'c', 'first'], 'the objects after it moved up and the window is told');
  await failsWith('invalid', () => lib.add(view.id, { parentId: null, type: 'folder', name: 'far', index: 9 }));
  assert.deepEqual(names(lib, view.id, null), ['first', 'a', 'b', 'c'], 'and nothing was added');
});

test('the delta that starts the window again carries folders and connections only, like a snapshot', async () => {
  const path = await where();
  const one = library();
  const two = library();
  const a = await one.create(path, 'Lab', 'pw');
  one.writeCredential(a.id, { parentId: null, name: 'Secret', record: { kind: 'credential', username: '', domain: '', password: 'hunter2-marker' } });
  await one.save(a.id);
  const b = await two.open(path, 'pw');
  one.add(a.id, { parentId: null, type: 'connection', name: 'from-one' });
  await one.save(a.id);
  two.add(b.id, { parentId: null, type: 'connection', name: 'from-two' });
  const merged = await two.save(b.id);
  assert.equal(merged.delta.reset, true, 'it did start again');
  assert.deepEqual(merged.delta.upsert.map((o) => o.name).sort(), ['from-one', 'from-two'], 'the credential stays in the main process');
  assert.equal(JSON.stringify(merged.delta).includes('hunter2-marker'), false);
});

test('a delta says which change it follows (from) and which one it makes (seq); one that changes nothing follows and makes the same change', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const first = lib.add(id, { parentId: null, type: 'connection', name: 'a' });
  assert.deepEqual([first.delta.from, first.delta.seq], [0, 1]);
  const second = lib.add(id, { parentId: null, type: 'connection', name: 'b' });
  assert.deepEqual([second.delta.from, second.delta.seq], [1, 2]);
  const nothing = lib.update(id, second.objectId, { name: 'b' });
  assert.deepEqual([nothing.from, nothing.seq], [2, 2]);
  const saved = await lib.save(id);
  assert.deepEqual([saved.delta.from, saved.delta.seq], [2, 3], 'a save changes what the window shows of the document: the unsaved mark and the revision');
  const clean = await lib.save(id);
  assert.deepEqual([clean.delta.from, clean.delta.seq], [3, 3]);
});

test('a save that took another program\'s changes in and then failed still tells the window that it is behind: the answer to its next save makes the window ask again', async () => {
  const path = await where();
  let failing = false;
  const fs = { ...realFs, rename: async (from: string, to: string) => { if (failing) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' }); await realFs.rename(from, to); } };
  const one = library();
  const two = new DocumentLibrary({ kdf, fs });
  const a = await one.create(path, 'Lab', 'pw');
  await one.save(a.id);
  const b = await two.open(path, 'pw');
  one.add(a.id, { parentId: null, type: 'connection', name: 'from-one' });
  await one.save(a.id);
  two.add(b.id, { parentId: null, type: 'connection', name: 'from-two' });
  const model = modelOf(two.snapshot(b.id));
  failing = true;
  await failsWith('io', () => two.save(b.id));
  failing = false;
  assert.ok(two.snapshot(b.id).objects.some((o) => o.name === 'from-one'), 'the other program\'s change is in the working copy now');
  assert.ok(two.view(b.id).seq > model.seq, 'and the library says it is further on than the window knows');
  const next = await two.save(b.id);
  assert.equal(next.saved, true);
  assert.equal(applyDelta(model, next.delta), 'gap', 'so the answer to the next save is not taken as the next change');
});

test('an edit made while a save that took another program\'s changes in is writing does not hide them from the window, also when that write then fails', { timeout: 20_000 }, async () => {
  const path = await where();
  let armed = false;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atCommit = new Promise<void>((resolve) => { reached = resolve; });
  const fs = { ...realFs, rename: async (from: string, to: string) => { if (armed) { reached(); await gate; throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' }); } await realFs.rename(from, to); } };
  const one = library();
  const two = new DocumentLibrary({ kdf, fs });
  const a = await one.create(path, 'Lab', 'pw');
  await one.save(a.id);
  const b = await two.open(path, 'pw');
  one.add(a.id, { parentId: null, type: 'connection', name: 'from-one' });
  await one.save(a.id);
  two.add(b.id, { parentId: null, type: 'connection', name: 'from-two' });
  const model = modelOf(two.snapshot(b.id));
  armed = true;
  const saving = two.save(b.id);                  // the file has changed: the other program's objects are taken in, and the second write waits at its commit
  await atCommit;
  const meanwhile = two.add(b.id, { parentId: null, type: 'connection', name: 'typed meanwhile' }).delta;
  assert.ok(two.snapshot(b.id).objects.some((o) => o.name === 'from-one'), 'the working copy holds the other program\'s change by now');
  applyDelta(model, meanwhile);                   // what the window does with the answer to that edit
  release();
  await failsWith('io', () => saving);
  armed = false;
  // A window that is behind without knowing it is what must never happen: either it holds what the library holds, or it has been told that it is behind.
  const held = (m: ReturnType<typeof modelOf>) => [...m.objects.values()].map((o) => o.name).sort();
  const seen = two.snapshot(b.id);
  const agrees = JSON.stringify(held(model)) === JSON.stringify(seen.objects.map((o) => o.name).sort()) && model.seq === seen.seq;
  assert.ok(agrees || seen.seq > model.seq, `the window holds ${JSON.stringify(held(model))} at seq ${model.seq}, the library ${JSON.stringify(seen.objects.map((o) => o.name).sort())} at seq ${seen.seq}`);
});

test('a position counts the siblings the window sees (folders and connections): other kinds of object are left out of the count, and a position past what is seen is refused', async () => {
  const lib = library();
  const view = await lib.create(await where(), 'Lab', 'pw');
  const a = lib.add(view.id, { parentId: null, type: 'connection', name: 'A' }).objectId;
  lib.writeCredential(view.id, { parentId: null, name: 'K', record: { kind: 'credential', username: '', domain: '' } });   // between A and B, and never shown
  lib.add(view.id, { parentId: null, type: 'connection', name: 'B' });
  lib.add(view.id, { parentId: null, type: 'connection', name: 'C' });
  assert.deepEqual(names(lib, view.id, null), ['A', 'B', 'C']);
  lib.move(view.id, a, null, 1);                                     // the window sees [B, C] without A: position 1 is between them
  assert.deepEqual(names(lib, view.id, null), ['B', 'A', 'C']);
  lib.move(view.id, a, null, 2);                                     // the end of what is seen
  assert.deepEqual(names(lib, view.id, null), ['B', 'C', 'A']);
  lib.move(view.id, a, null, 0);
  assert.deepEqual(names(lib, view.id, null), ['A', 'B', 'C']);
  await failsWith('invalid', () => lib.move(view.id, a, null, 3));  // there are two others: 3 would be a way to count the hidden ones
  lib.add(view.id, { parentId: null, type: 'folder', name: 'N', index: 1 });
  assert.deepEqual(names(lib, view.id, null), ['A', 'N', 'B', 'C']);
  await failsWith('invalid', () => lib.add(view.id, { parentId: null, type: 'folder', name: 'far', index: 5 }));
  assert.deepEqual(names(lib, view.id, null), ['A', 'N', 'B', 'C'], 'and nothing was added');
  assert.equal(lib.size(view.id), 5, 'the credential is still there');
});

test('the name of a copy is chosen among the names the window sees: a hidden object with that name changes nothing, so its name cannot be found out by copying', async () => {
  const lib = library();
  const view = await lib.create(await where(), 'Lab', 'pw');
  const x = lib.add(view.id, { parentId: null, type: 'connection', name: 'x' }).objectId;
  lib.writeCredential(view.id, { parentId: null, name: 'x salinan', record: { kind: 'credential', username: '', domain: '' } });
  const copy = lib.duplicate(view.id, x);
  assert.equal(objectsOf(lib, view.id).find((o) => o.id === copy.objectId)!.name, 'x salinan');
});

test('hidden object values remain private while meaningful metadata updates advance the public sequence', async () => {
  let at=Date.parse('2026-10-24T00:00:00.000Z');const lib=new DocumentLibrary({kdf,now:()=>at+=1000});
  const view=await lib.create(await where(),'Lab','pw');
  const kinds=['credential','task','template','gateway','dynamicProvider'] as const;
  const first=lib.writeCredential(view.id,{parentId:null,name:'hidden-0',record:{kind:'credential',username:'',domain:'',password:'marker-0'}});
  let seq=1;assert.deepEqual([first.delta.upsert,first.delta.seq],[[],seq]);
  for(const [i,kind]of kinds.entries()){
    const added=kind==='credential'?first:lib.add(view.id,{parentId:null,type:kind,name:`hidden-${i}`,props:{opaqueMarker:`marker-${i}`}});
    if(kind!=='credential')seq++;assert.deepEqual([added.delta.upsert,added.delta.remove],[[],[]]);assert.equal(added.delta.seq,seq);
    const renamed=lib.update(view.id,added.objectId,{name:`renamed-${i}`});assert.deepEqual([renamed.upsert,renamed.seq],[[],++seq]);
  }
  assert.equal(JSON.stringify(lib.snapshot(view.id)).includes('marker-'),false);assert.equal(lib.size(view.id),5);
  const gone=lib.remove(view.id,first.objectId);assert.deepEqual([gone.remove,gone.seq],[[],++seq]);
});

test('a save that fails without having taken anything in leaves the seq alone: the window is not told to ask again for nothing', async () => {
  const path = await where();
  let failing = false;
  const fs = { ...realFs, rename: async (from: string, to: string) => { if (failing) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' }); await realFs.rename(from, to); } };
  const lib = new DocumentLibrary({ kdf, fs });
  const view = await lib.create(path, 'Lab', 'pw');
  lib.add(view.id, { parentId: null, type: 'connection', name: 'a' });
  const seen = lib.view(view.id).seq;
  failing = true;
  await failsWith('io', () => lib.save(view.id));
  assert.equal(lib.view(view.id).seq, seen);
});
