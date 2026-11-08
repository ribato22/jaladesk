import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDelta, modelOf, sortedChildren, type DocModel } from '../src/desktop/docmodel.js';
import type { Delta, Snapshot } from '../src/documents/library.js';
import { compareFor, sortOf } from '../src/documents/meta.js';
import type { Json, ObjectNode } from '../src/documents/model.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, name: string, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name, parentId: null, order: 0, props: {}, ...over });
const folder = (n: number, name: string, over: Partial<ObjectNode> = {}) => node(n, name, { type: 'folder', ...over });
const NAME_DESC: Json = [{ by: 'name', dir: 'desc' }];
const snapshot = (objects: ObjectNode[]): Snapshot => ({ id: 'doc', docId: id(900), name: 'Doc', revision: 0, dirty: false, conflicts: 0, seq: 1, objects });
const delta = (model: DocModel, upsert: ObjectNode[], remove: string[] = [], reset = false): Delta =>
  ({ id: model.id, docId: model.docId, name: model.name, revision: model.revision, dirty: false, conflicts: 0, seq: model.seq + 1, from: model.seq, upsert, remove, ...(reset ? { reset: true as const } : {}) });
const names = (model: DocModel, parentId: string | null) => sortedChildren(model, parentId).map((o) => o.name);

test('the children of a sorted folder come in the order of its sort setting; the top level and the other folders keep the manual order', () => {
  const model = modelOf(snapshot([
    folder(1, 'sorted', { props: { sort: NAME_DESC } }), node(2, 'b', { parentId: id(1) }), node(3, 'a', { parentId: id(1), order: 5 }), node(4, 'c', { parentId: id(1), order: 9 }),
    folder(5, 'plain', { order: 1 }), node(6, 'y', { parentId: id(5), order: 1 }), node(7, 'x', { parentId: id(5), order: 2 }),
    node(8, 'z', { order: 4 }),
  ]));
  assert.deepEqual(names(model, id(1)), ['c', 'b', 'a'], 'name, descending: the manual order does not count');
  assert.deepEqual(names(model, id(5)), ['y', 'x']);
  assert.deepEqual(names(model, null), ['sorted', 'plain', 'z']);
  assert.deepEqual(names(model, id(77)), [], 'a folder that is not there has no children');
});

test('a delta that changes the sort setting of a folder reorders its children at once, and one that removes the setting gives the manual order back', () => {
  const folderNode = folder(1, 'f');
  const model = modelOf(snapshot([folderNode, node(2, 'b', { parentId: id(1), order: 1 }), node(3, 'a', { parentId: id(1), order: 2 }), node(4, 'c', { parentId: id(1), order: 0 })]));
  assert.deepEqual(names(model, id(1)), ['c', 'b', 'a']);
  applyDelta(model, delta(model, [{ ...folderNode, props: { sort: [{ by: 'name', dir: 'asc' }] } }]));
  assert.deepEqual(names(model, id(1)), ['a', 'b', 'c']);
  applyDelta(model, delta(model, [{ ...folderNode, props: { sort: NAME_DESC } }]));
  assert.deepEqual(names(model, id(1)), ['c', 'b', 'a']);
  applyDelta(model, delta(model, [{ ...folderNode, props: {} }]));
  assert.deepEqual(names(model, id(1)), ['c', 'b', 'a'], 'manual order again: c (0), b (1), a (2)');
  applyDelta(model, delta(model, [{ ...folderNode, props: { sort: 'nonsense' } }]));
  assert.deepEqual(names(model, id(1)), ['c', 'b', 'a'], 'a setting that is not one is no sort');
});

test('a child that is renamed, added, removed or moved to another folder is in the right place afterwards', () => {
  const home = folder(1, 'sorted', { props: { sort: [{ by: 'name', dir: 'asc' }] } });
  const other = folder(2, 'other', { props: { sort: [{ by: 'name', dir: 'asc' }] } });
  const model = modelOf(snapshot([home, other, node(3, 'b', { parentId: id(1) }), node(4, 'd', { parentId: id(1) }), node(5, 'q', { parentId: id(2) })]));
  assert.deepEqual(names(model, id(1)), ['b', 'd']);
  applyDelta(model, delta(model, [node(6, 'c', { parentId: id(1) })]));
  assert.deepEqual(names(model, id(1)), ['b', 'c', 'd'], 'added');
  applyDelta(model, delta(model, [node(3, 'e', { parentId: id(1) })]));
  assert.deepEqual(names(model, id(1)), ['c', 'd', 'e'], 'renamed');
  applyDelta(model, delta(model, [node(4, 'd', { parentId: id(2) })]));
  assert.deepEqual([names(model, id(1)), names(model, id(2))], [['c', 'e'], ['d', 'q']], 'moved to the other folder: both lists are right');
  applyDelta(model, delta(model, [], [id(6)]));
  assert.deepEqual(names(model, id(1)), ['e'], 'removed');
});

test('a delta that starts again makes the lists again', () => {
  const home = folder(1, 'f', { props: { sort: NAME_DESC } });
  const model = modelOf(snapshot([home, node(2, 'a', { parentId: id(1) }), node(3, 'b', { parentId: id(1) })]));
  assert.deepEqual(names(model, id(1)), ['b', 'a']);
  applyDelta(model, delta(model, [folder(1, 'f'), node(2, 'a', { parentId: id(1), order: 0 }), node(3, 'b', { parentId: id(1), order: 1 }), node(4, 'c', { parentId: id(1), order: 2 })], [], true));
  assert.deepEqual(names(model, id(1)), ['a', 'b', 'c']);
});

test('the list is made once while nothing changes, and made again for the folder that did change only', () => {
  const model = modelOf(snapshot([folder(1, 'f'), node(2, 'a', { parentId: id(1) }), folder(3, 'g'), node(4, 'z', { parentId: id(3) })]));
  const first = sortedChildren(model, id(1)), second = sortedChildren(model, id(3));
  assert.equal(sortedChildren(model, id(1)), first);
  assert.equal(sortedChildren(model, id(3)), second);
  applyDelta(model, delta(model, [node(5, 'b', { parentId: id(1) })]));
  assert.notEqual(sortedChildren(model, id(1)), first, 'the folder that got a child');
  assert.equal(sortedChildren(model, id(3)), second, 'the other folder keeps its list');
});

/** A seeded generator (mulberry32) that gives a whole number below `n`. A congruential generator computed in float64 loses its low bits and soon gives the same number every time. */
function prng(seed: number): (n: number) => number {
  let a = seed;
  return (n) => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
}

test('after any run of deltas the list of every folder is what a fresh sort of its children gives (random changes)', () => {
  const random = prng(3);
  const seen = { removed: 0, sorted: 0, moved: 0 };
  const words = ['alpha', 'Alpha', 'beta', 'srv1', 'srv2', 'srv10', 'émile', 'zeta', 'mu'];
  const settings: (Json | undefined)[] = [undefined, [{ by: 'name', dir: 'asc' }], NAME_DESC, [{ by: 'type', dir: 'asc' }], [{ by: 'type', dir: 'desc' }, { by: 'name', dir: 'asc' }]];
  const folders = [1, 2, 3, 4];
  const initial: ObjectNode[] = folders.map((n) => folder(n, `f${n}`, { order: n }));
  for (let n = 10; n < 40; n++) initial.push(random(3) ? node(n, words[random(words.length)]!, { parentId: id(folders[random(4)]!), order: random(5) }) : folder(n, words[random(words.length)]!, { parentId: id(folders[random(4)]!), order: random(5) }));
  const model = modelOf(snapshot(initial));
  for (let step = 0; step < 300; step++) {
    const n = random(4) === 0 ? folders[random(4)]! : 10 + random(40);
    const current = model.objects.get(id(n));
    const action = random(4);
    if (action === 0 && current && !folders.includes(n)) { applyDelta(model, delta(model, [], [id(n)])); seen.removed++; }
    else if (action === 1 && folders.includes(n)) { const props: Record<string, Json> = {}; const setting = settings[random(settings.length)]; if (setting !== undefined) props.sort = setting; applyDelta(model, delta(model, [{ ...model.objects.get(id(n))!, props }])); seen.sorted++; }
    else if (!folders.includes(n) || action === 2) {
      const base = current ?? node(n, 'x');
      const parent = id(folders[random(4)]!);
      if (folders.includes(n)) continue;
      applyDelta(model, delta(model, [{ ...base, name: words[random(words.length)]!, parentId: parent, order: random(5) }]));
      seen.moved++;
    }
    for (const parent of [null, ...folders.map(id)]) {
      const sort = parent === null ? [] : sortOf(model.objects.get(parent)?.props ?? {});
      const fresh = [...(model.children.get(parent) ?? [])].map((child) => model.objects.get(child)!).sort(compareFor(sort)).map((o) => o.id);
      assert.deepEqual(sortedChildren(model, parent).map((o) => o.id), fresh, `step ${step}, folder ${parent}`);
    }
  }
  assert.ok(seen.removed >= 25 && seen.sorted >= 7 && seen.moved >= 80, `the run applies deltas of every kind: ${JSON.stringify(seen)}`);
});

test('a delta that starts again forgets the list of a folder that is not in the document any more', () => {
  const model = modelOf(snapshot([folder(1, 'f'), node(2, 'a', { parentId: id(1) })]));
  assert.deepEqual(names(model, id(1)), ['a']);        // the list of f is made
  applyDelta(model, delta(model, [folder(5, 'other')], [], true));
  assert.deepEqual(names(model, id(1)), [], 'a folder that is gone has no children, not the ones it had');
});
