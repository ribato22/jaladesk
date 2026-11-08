import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentError, LIMITS, validateDocument, type Doc, type Json, type ObjectNode } from '../src/documents/model.js';
import { applyOp, OpError, type Env, type Patch } from '../src/documents/ops.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const folder = (n: number, over: Partial<ObjectNode> = {}) => node(n, { type: 'folder', name: `f${n}`, ...over });
const doc = (...nodes: ObjectNode[]): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'ws', revision: 0, objects: Object.fromEntries(nodes.map((o) => [o.id, o])) });
const env = (): Env => ({ newId: () => id(999) });
const refuses = (run: () => unknown, kind: typeof DocumentError | typeof OpError, code: string) =>
  assert.throws(run, (error: unknown) => error instanceof kind && (error as { code: string }).code === code, `expected ${kind.name} ${code}`);

const SORT: Json = [{ by: 'name', dir: 'desc' }];
// f1 holds f2 (which holds the folder f3 and the connection n4) and the connection n5; f6 is beside f1 and holds f7.
const tree = () => doc(folder(1), folder(2, { parentId: id(1) }), folder(3, { parentId: id(2) }), node(4, { parentId: id(2) }), node(5, { parentId: id(1), order: 1 }), folder(6, { order: 1 }), folder(7, { parentId: id(6) }));
const withSort = (d: Doc, ...ids: number[]): Doc => ({ ...d, objects: { ...d.objects, ...Object.fromEntries(ids.map((n) => [id(n), { ...d.objects[id(n)]!, props: { ...d.objects[id(n)]!.props, sort: structuredClone(SORT) } }])) } });
const sortedIds = (d: Doc) => Object.values(d.objects).filter((o) => o.props.sort !== undefined).map((o) => o.id).sort();

test('a patch sets and removes properties on the object as it is now, and leaves every other property alone', () => {
  const before = doc(node(1, { props: { host: 'h', icon: 'cloud', keep: 1, nested: { a: [1] } } }), node(2));
  const frozen = structuredClone(before);
  const applied = applyOp(before, { op: 'update', id: id(1), patch: { set: { color: 'red', notes: 'n' }, unset: ['icon'] } }, env());
  assert.deepEqual(applied.doc.objects[id(1)]!.props, { host: 'h', keep: 1, nested: { a: [1] }, color: 'red', notes: 'n' });
  assert.deepEqual(applied.change, { upsert: [applied.doc.objects[id(1)]], remove: [] });
  assert.equal(applied.doc.objects[id(2)], before.objects[id(2)], 'the other objects are shared');
  assert.deepEqual(before, frozen, 'the old document is as it was');
  validateDocument(applied.doc);
  const named = applyOp(before, { op: 'update', id: id(1), name: 'renamed', patch: { set: { color: 'blue' } } }, env());
  assert.deepEqual([named.doc.objects[id(1)]!.name, named.doc.objects[id(1)]!.props.color, named.doc.objects[id(1)]!.props.host], ['renamed', 'blue', 'h'], 'a name and a patch together');
});

test('a patch that changes nothing is no change at all', () => {
  const before = doc(node(1, { props: { color: 'red' } }));
  const patches: Patch[] = [{}, { set: {} }, { unset: [] }, { set: { color: 'red' } }, { unset: ['icon'] }, { set: { color: 'red' }, unset: ['icon'] }];
  for (const patch of patches) {
    const applied = applyOp(before, { op: 'update', id: id(1), patch }, env());
    assert.equal(applied.doc, before, JSON.stringify(patch));
    assert.deepEqual(applied.change, { upsert: [], remove: [] });
  }
});

test('a patch copies the values it is given, so later changes to them do not reach the document', () => {
  const value = { list: [1] };
  const applied = applyOp(doc(node(1)), { op: 'update', id: id(1), patch: { set: { extra: value } } }, env());
  value.list.push(2);
  assert.deepEqual(applied.doc.objects[id(1)]!.props.extra, { list: [1] });
});

test('a patch is refused when it sets and removes the same property, comes together with a whole set of properties, names no object, or would make the object invalid', () => {
  const d = doc(node(1, { props: { host: 'h' } }));
  const frozen = structuredClone(d);
  refuses(() => applyOp(d, { op: 'update', id: id(1), patch: { set: { color: 'red' }, unset: ['color'] } }, env()), OpError, 'bad-patch');
  refuses(() => applyOp(d, { op: 'update', id: id(1), props: {}, patch: { set: { a: 1 } } }, env()), OpError, 'bad-patch');
  refuses(() => applyOp(d, { op: 'update', id: id(1), patch: { set: JSON.parse('{"__proto__": {"x": 1}}') as Record<string, Json> } }, env()), OpError, 'bad-patch');
  refuses(() => applyOp(d, { op: 'update', id: id(1), patch: { set: { 'bad key': 1 } } }, env()), DocumentError, 'bad-props');
  refuses(() => applyOp(d, { op: 'update', id: id(1), patch: { set: { huge: 'x'.repeat(70_000) } } }, env()), DocumentError, 'bad-props');
  refuses(() => applyOp(d, { op: 'update', id: id(77), patch: { set: { a: 1 } } }, env()), OpError, 'unknown-object');
  assert.deepEqual(d, frozen, 'a refusal changes nothing');
});

test('the sort setting of a folder can be spread to every folder below it, and to nothing else', () => {
  const before = tree();
  const applied = applyOp(before, { op: 'update', id: id(1), patch: { set: { sort: SORT } }, spreadSort: true }, env());
  assert.deepEqual(sortedIds(applied.doc), [id(1), id(2), id(3)], 'the folder and the folders below it');
  assert.deepEqual(applied.change.upsert.map((o) => o.id).sort(), [id(1), id(2), id(3)]);
  assert.deepEqual(applied.change.remove, []);
  for (const untouched of [4, 5, 6, 7]) assert.equal(applied.doc.objects[id(untouched)], before.objects[id(untouched)], `n${untouched} is not touched: a connection, or a folder beside it`);
  assert.deepEqual(applied.doc.objects[id(3)]!.props.sort, SORT);
  assert.notEqual(applied.doc.objects[id(3)]!.props.sort, applied.doc.objects[id(1)]!.props.sort, 'the copies are not shared with the folder');
  validateDocument(applied.doc);
});

test('spreading no sort removes the setting from the folders below, and only from those that had one', () => {
  const before = withSort(tree(), 1, 3);
  const applied = applyOp(before, { op: 'update', id: id(1), patch: { unset: ['sort'] }, spreadSort: true }, env());
  assert.deepEqual(sortedIds(applied.doc), []);
  assert.deepEqual(applied.change.upsert.map((o) => o.id).sort(), [id(1), id(3)], 'f2 had none, so it is not part of the change');
  validateDocument(applied.doc);
});

test('a folder that already has the setting is not part of the change, and when nothing differs there is no change', () => {
  const spread = applyOp(tree(), { op: 'update', id: id(1), patch: { set: { sort: SORT } }, spreadSort: true }, env()).doc;
  const again = applyOp(spread, { op: 'update', id: id(1), patch: { set: { sort: SORT } }, spreadSort: true }, env());
  assert.equal(again.doc, spread);
  assert.deepEqual(again.change, { upsert: [], remove: [] });
  const gap = { ...spread, objects: { ...spread.objects, [id(2)]: { ...spread.objects[id(2)]!, props: {} } } };   // f2 lost its setting meanwhile
  const repaired = applyOp(gap, { op: 'update', id: id(1), patch: { set: { sort: SORT } }, spreadSort: true }, env());
  assert.deepEqual(repaired.change.upsert.map((o) => o.id), [id(2)], 'only f2 differs');
});

test('a spread that would make a folder below invalid is refused as a whole, and nothing changes: a folder that already has as many properties as are allowed cannot be given a sort', () => {
  const crowded = Object.fromEntries(Array.from({ length: LIMITS.maxProps }, (_, n) => [`k${n}`, n]));   // every property a folder may have, none of them a sort
  const before = doc(folder(1), folder(2, { parentId: id(1) }), folder(3, { parentId: id(1), props: crowded }));
  const frozen = structuredClone(before);
  refuses(() => applyOp(before, { op: 'update', id: id(1), patch: { set: { sort: SORT } }, spreadSort: true }, env()), DocumentError, 'bad-props');
  assert.deepEqual(before, frozen, 'f2, which could have taken it, did not either');
  const alone = applyOp(before, { op: 'update', id: id(2), patch: { set: { sort: SORT } }, spreadSort: true }, env());
  assert.deepEqual(sortedIds(alone.doc), [id(2)], 'the same spread from a folder that has no such folder below is fine');
});

test('spreading from a connection, or without asking for it, changes the object alone', () => {
  const before = tree();
  const alone = applyOp(before, { op: 'update', id: id(1), patch: { set: { sort: SORT } } }, env());
  assert.deepEqual(sortedIds(alone.doc), [id(1)]);
  const connection = applyOp(before, { op: 'update', id: id(4), patch: { set: { color: 'red' } }, spreadSort: true }, env());
  assert.deepEqual(connection.change.upsert.map((o) => o.id), [id(4)]);
});

/** A seeded generator (mulberry32) that gives a whole number below `n`. A congruential generator computed in float64 loses its low bits and soon gives the same number every time. */
function prng(seed: number): (n: number) => number {
  let a = seed;
  return (n) => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
}

test('after a spread every folder below has exactly the setting of the folder, the change names exactly what differs, and the document is still valid (random trees)', () => {
  const random = prng(11);
  const seen = { rounds: 0, withBelow: 0, below: 0, deepest: 0, set: 0, unset: 0 };
  for (let round = 0; round < 60; round++) {
    const nodes: ObjectNode[] = [folder(1)];
    for (let n = 2; n <= 40; n++) {
      const parents = nodes.filter((o) => o.type === 'folder');
      const parent = parents[random(parents.length)]!;
      const sort: Record<string, Json> = random(3) === 0 ? { sort: structuredClone(SORT) } : {};
      nodes.push(random(2) ? folder(n, { parentId: parent.id, order: random(5), props: sort }) : node(n, { parentId: parent.id, order: random(5), props: sort }));
    }
    const before = doc(...nodes);
    const root = id(1 + random(10));
    if (!before.objects[root] || before.objects[root]!.type !== 'folder') continue;
    const patch: { set?: Record<string, Json>; unset?: string[] } = random(2) ? { set: { sort: [{ by: 'type', dir: 'asc' }, { by: 'name', dir: 'desc' }] } } : { unset: ['sort'] };
    const applied = applyOp(before, { op: 'update', id: root, patch, spreadSort: true }, env());
    const below = new Set<string>();
    let deepest = 0;
    const walk = (parent: string, level: number): void => { for (const o of Object.values(applied.doc.objects)) if (o.parentId === parent) { below.add(o.id); if (o.type === 'folder') deepest = Math.max(deepest, level); walk(o.id, level + 1); } };
    walk(root, 1);
    const foldersBelow = [...below].filter((x) => applied.doc.objects[x]!.type === 'folder').length;
    seen.rounds++; seen.below += foldersBelow; seen.deepest = Math.max(seen.deepest, deepest); seen[patch.set ? 'set' : 'unset']++;
    if (foldersBelow > 0) seen.withBelow++;
    const expected = patch.set?.sort;
    for (const o of Object.values(applied.doc.objects)) {
      if (o.id === root || (below.has(o.id) && o.type === 'folder')) assert.deepEqual(o.props.sort, expected, `round ${round}: ${o.name}`);
      else assert.equal(o, before.objects[o.id], `round ${round}: ${o.name} is not touched`);
    }
    const differing = Object.values(applied.doc.objects).filter((o) => before.objects[o.id] !== o).map((o) => o.id).sort();
    assert.deepEqual(applied.change.upsert.map((o) => o.id).sort(), differing, `round ${round}: the change is what differs`);
    validateDocument(applied.doc);
  }
  assert.ok(seen.rounds >= 20 && seen.withBelow >= 10 && seen.below >= 30 && seen.deepest >= 3 && seen.set >= 5 && seen.unset >= 5, `the trees reach folders below the root, three levels deep, with and without a setting: ${JSON.stringify(seen)}`);
});
