import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyDelta, modelOf } from '../src/desktop/docmodel.js';
import { DocumentLibrary } from '../src/documents/library.js';
import { compareFor } from '../src/documents/meta.js';
import type { Json } from '../src/documents/model.js';
import { compareSiblings } from '../src/documents/order.js';

const kdf = { logN: 14, r: 8, p: 1 };
const library = () => new DocumentLibrary({ kdf });
const where = async () => join(await mkdtemp(join(tmpdir(), 'rwmeta-')), 'lab.rwdoc');
const SORT: Json = [{ by: 'name', dir: 'asc' }];
/** The children of a folder as the window shows them: in the sort of the folder, or in the manual order. */
const shown = (lib: DocumentLibrary, id: string, parentId: string | null) => {
  const objects = lib.snapshot(id).objects;
  const sort = objects.find((o) => o.id === parentId)?.props.sort;
  const compare = sort === undefined ? compareSiblings : compareFor(sort as { by: 'name'; dir: 'asc' }[]);
  return objects.filter((o) => o.parentId === parentId).sort(compare).map((o) => o.name);
};

test('update takes a patch that is applied to the properties as the document holds them now, not as the caller last saw them', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const web = lib.add(id, { parentId: null, type: 'connection', name: 'web', props: { protocol: 'rdp', host: 'old.example' } }).objectId;
  lib.update(id, web, { props: { protocol: 'rdp', host: 'new.example' } });            // somebody else changed the host
  const delta = lib.update(id, web, { patch: { set: { color: 'red', notes: 'hello' } } });   // the caller still thinks it is old.example, and does not say
  assert.deepEqual(delta.upsert.map((o) => o.props), [{ protocol: 'rdp', host: 'new.example', color: 'red', notes: 'hello' }]);
  assert.deepEqual([delta.from, delta.seq, delta.remove], [2, 3, []]);
  const gone = lib.update(id, web, { patch: { unset: ['color', 'notes'] } });
  assert.deepEqual(gone.upsert[0]!.props, { protocol: 'rdp', host: 'new.example' });
  assert.equal(lib.view(id).dirty, true);
});

test('a patch that changes nothing, and one that is refused, leave the seq where it was', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const web = lib.add(id, { parentId: null, type: 'connection', name: 'web', props: { color: 'red' } }).objectId;
  const seq = lib.view(id).seq;
  const same = lib.update(id, web, { patch: { set: { color: 'red' } } });
  assert.deepEqual([same.upsert, same.remove, same.from, same.seq], [[], [], seq, seq]);
  assert.throws(() => lib.update(id, web, { props: {}, patch: { set: { a: 1 } } }), /patched|replaced/i);
  assert.equal(lib.view(id).seq, seq);
});

test('update can spread a sort setting to the folders below: one change, one step of the seq, and a window that takes it in agrees with the library', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const top = lib.add(id, { parentId: null, type: 'folder', name: 'top' }).objectId;
  const mid = lib.add(id, { parentId: top, type: 'folder', name: 'mid' }).objectId;
  lib.add(id, { parentId: mid, type: 'folder', name: 'low' });
  lib.add(id, { parentId: mid, type: 'connection', name: 'web' });
  lib.add(id, { parentId: null, type: 'folder', name: 'beside' });
  const model = modelOf(lib.snapshot(id));
  const delta = lib.update(id, top, { patch: { set: { sort: SORT } }, spreadSort: true });
  assert.deepEqual(delta.upsert.map((o) => o.name).sort(), ['low', 'mid', 'top']);
  assert.equal(delta.seq - delta.from, 1);
  assert.equal(applyDelta(model, delta), 'applied');
  assert.deepEqual([...model.objects.values()].map((o) => [o.name, o.props.sort !== undefined]).sort(), [['beside', false], ['low', true], ['mid', true], ['top', true], ['web', false]]);
  assert.deepEqual(model.objects.get(delta.upsert[0]!.id)!.props, delta.upsert[0]!.props);
});

test('a position means nothing in a sorted folder: add and move put the object where the sort puts it, whatever index is given', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const sorted = lib.add(id, { parentId: null, type: 'folder', name: 'sorted', props: { sort: SORT } }).objectId;
  lib.add(id, { parentId: sorted, type: 'connection', name: 'b' });
  lib.add(id, { parentId: sorted, type: 'connection', name: 'd' });
  const order = (name: string) => lib.snapshot(id).objects.find((o) => o.name === name)!.order;
  lib.add(id, { parentId: sorted, type: 'connection', name: 'c', index: 0 });         // asked for the first place; the sort decides
  assert.deepEqual(shown(lib, id, sorted), ['b', 'c', 'd']);
  assert.equal(order('c') > order('d'), true, 'it was put last among the manual order, which a sorted folder does not use');
  lib.add(id, { parentId: sorted, type: 'connection', name: 'a', index: 99 });        // an index past the end is not an error either
  assert.deepEqual(shown(lib, id, sorted), ['a', 'b', 'c', 'd']);
  const outside = lib.add(id, { parentId: null, type: 'connection', name: 'e' }).objectId;
  lib.move(id, outside, sorted, 0);
  assert.deepEqual(shown(lib, id, sorted), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(order('e') > order('d'), true);
});

test('where the folder is not sorted a position is still the place among the siblings the window sees, and a folder that is not sorted any more takes positions again', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const folder = lib.add(id, { parentId: null, type: 'folder', name: 'plain' }).objectId;
  lib.add(id, { parentId: folder, type: 'connection', name: 'b' });
  lib.add(id, { parentId: folder, type: 'connection', name: 'c' });
  lib.add(id, { parentId: folder, type: 'connection', name: 'a', index: 0 });
  assert.deepEqual(shown(lib, id, folder), ['a', 'b', 'c']);
  lib.update(id, folder, { patch: { set: { sort: [{ by: 'name', dir: 'desc' }] } } });
  assert.deepEqual(shown(lib, id, folder), ['c', 'b', 'a'], 'sorted: the manual order is not what is shown');
  lib.update(id, folder, { patch: { unset: ['sort'] } });
  lib.add(id, { parentId: folder, type: 'connection', name: 'z', index: 0 });
  assert.deepEqual(shown(lib, id, folder), ['z', 'a', 'b', 'c'], 'not sorted any more: the index is a place again');
  await assert.rejects(async () => lib.add(id, { parentId: folder, type: 'connection', name: 'bad', index: 99 }), /outside the folder|invalid/i);
});

test('a folder that is sorted keeps its manual order underneath: sort off gives back the order the objects had', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const folder = lib.add(id, { parentId: null, type: 'folder', name: 'plain' }).objectId;
  for (const name of ['c', 'a', 'b']) lib.add(id, { parentId: folder, type: 'connection', name });
  assert.deepEqual(shown(lib, id, folder), ['c', 'a', 'b']);
  lib.update(id, folder, { patch: { set: { sort: SORT } } });
  assert.deepEqual(shown(lib, id, folder), ['a', 'b', 'c']);
  lib.update(id, folder, { patch: { unset: ['sort'] } });
  assert.deepEqual(shown(lib, id, folder), ['c', 'a', 'b']);
});

test('a spreadSort that is false is no request: the folders below are left as they are', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const top = lib.add(id, { parentId: null, type: 'folder', name: 'top' }).objectId;
  lib.add(id, { parentId: top, type: 'folder', name: 'low' });
  const delta = lib.update(id, top, { patch: { set: { sort: SORT } }, spreadSort: false });
  assert.deepEqual(delta.upsert.map((o) => o.name), ['top']);
});

test('moving an object inside a sorted folder is no change: the manual place kept underneath is left alone, whatever position is given', async () => {
  const lib = library();
  const { id } = await lib.create(await where(), 'Lab', 'pw');
  const f = lib.add(id, { parentId: null, type: 'folder', name: 'f', props: { sort: SORT } }).objectId;
  const a = lib.add(id, { parentId: f, type: 'connection', name: 'a' }).objectId;
  lib.add(id, { parentId: f, type: 'connection', name: 'b' });
  const before = lib.snapshot(id).objects.map((o) => [o.name, o.order]);
  const seq = lib.view(id).seq;
  for (const index of [0, 1, 2, undefined]) {
    const delta = lib.move(id, a, f, index);
    assert.deepEqual([delta.upsert, delta.remove, delta.from, delta.seq], [[], [], seq, seq], `index ${String(index)}`);
  }
  assert.deepEqual(lib.snapshot(id).objects.map((o) => [o.name, o.order]), before);
  const other = lib.add(id, { parentId: null, type: 'connection', name: 'other' }).objectId;
  assert.equal(lib.move(id, other, f).upsert.length, 1, 'an object from outside does go in');
  assert.throws(() => lib.move(id, '00000000-0000-4000-8000-0000000000ee', f), /does not exist/i, 'and an object that is not there is still refused');
});
