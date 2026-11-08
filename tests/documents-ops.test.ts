import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentError, validateDocument, type Doc, type ObjectNode } from '../src/documents/model.js';
import { compareSiblings } from '../src/documents/order.js';
import { applyOp, OpError, type Env, type Op } from '../src/documents/ops.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const folder = (n: number, over: Partial<ObjectNode> = {}) => node(n, { type: 'folder', name: `f${n}`, ...over });
const doc = (...nodes: ObjectNode[]): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'ws', revision: 0, objects: Object.fromEntries(nodes.map((o) => [o.id, o])) });
const counter = (from = 500) => { let next = from; return (): string => id(next++); };
const env = (limits?: Env['limits']): Env => ({ newId: counter(), ...(limits ? { limits } : {}) });
const kids = (d: Doc, parentId: string | null) => Object.values(d.objects).filter((o) => o.parentId === parentId).sort(compareSiblings).map((o) => o.name);
const refuses = (run: () => unknown, kind: typeof DocumentError | typeof OpError, code: string) =>
  assert.throws(run, (error: unknown) => error instanceof kind && (error as { code: string }).code === code, `expected ${kind.name} ${code}`);

// A small tree: top level f1 (a, b, c inside) and the connection n6; f2 is an empty folder at the top.
const sample = () => doc(folder(1, { order: 0 }), node(2, { parentId: id(1), order: 0 }), node(3, { parentId: id(1), order: 1 }), node(4, { parentId: id(1), order: 2 }), folder(5, { order: 1 }), node(6, { order: 2 }));

test('add puts an object last by default, or at a position that moves the objects after it up; the old document is not changed', () => {
  const before = sample();
  const frozen = structuredClone(before);
  const last = applyOp(before, { op: 'add', id: id(10), parentId: id(1), type: 'connection', name: 'last', props: {} }, env());
  assert.deepEqual(kids(last.doc, id(1)), ['n2', 'n3', 'n4', 'last']);
  assert.deepEqual([last.created, last.change.upsert.map((o) => o.name), last.change.remove], [id(10), ['last'], []], 'appending moves nobody');
  const first = applyOp(before, { op: 'add', id: id(11), parentId: id(1), type: 'folder', name: 'first', props: {}, index: 0 }, env());
  assert.deepEqual(kids(first.doc, id(1)), ['first', 'n2', 'n3', 'n4']);
  assert.deepEqual(first.change.upsert.map((o) => o.name).sort(), ['first', 'n2', 'n3', 'n4'], 'the objects after it moved up and are part of the change');
  const middle = applyOp(before, { op: 'add', id: id(12), parentId: id(1), type: 'connection', name: 'middle', props: {}, index: 2 }, env());
  assert.deepEqual(kids(middle.doc, id(1)), ['n2', 'n3', 'middle', 'n4']);
  assert.deepEqual(middle.change.upsert.map((o) => o.name).sort(), ['middle', 'n4']);
  assert.deepEqual(before, frozen, 'an operation returns a new document and leaves the old one as it was');
  assert.notEqual(last.doc.objects, before.objects);
  assert.equal(last.doc.objects[id(2)], before.objects[id(2)], 'objects it did not touch are shared, not copied');
});

test('add copies the properties it is given, so later changes to them do not reach the document', () => {
  const props = { host: 'a', nested: { list: [1, 2] } };
  const applied = applyOp(sample(), { op: 'add', id: id(10), parentId: null, type: 'connection', name: 'x', props }, env());
  props.host = 'changed'; (props.nested.list as number[]).push(3);
  assert.deepEqual(applied.doc.objects[id(10)]!.props, { host: 'a', nested: { list: [1, 2] } });
});

test('update copies the properties it is given too, so later changes to them do not reach the document', () => {
  const props = { host: 'a', nested: { list: [1, 2] } };
  const applied = applyOp(sample(), { op: 'update', id: id(6), props }, env());
  props.host = 'changed'; (props.nested.list as number[]).push(3);
  assert.deepEqual(applied.doc.objects[id(6)]!.props, { host: 'a', nested: { list: [1, 2] } });
});

test('add is refused for a taken id, a parent that is not a folder, a bad position, bad data, and the limits', () => {
  const d = sample();
  const add = (over: Partial<Extract<Op, { op: 'add' }>>, limits?: Env['limits']) => () => applyOp(d, { op: 'add', id: id(10), parentId: null, type: 'connection', name: 'x', props: {}, ...over }, env(limits));
  refuses(add({ id: id(2) }), OpError, 'exists');
  refuses(add({ parentId: id(2) }), DocumentError, 'bad-parent');            // a connection is not a folder
  refuses(add({ parentId: id(99) }), DocumentError, 'bad-parent');           // no such parent
  refuses(add({ parentId: '__proto__' }), DocumentError, 'bad-parent');
  for (const index of [-1, 1.5, 4, Number.NaN]) refuses(add({ parentId: id(1), index }), OpError, 'bad-index');
  refuses(add({ name: 'x'.repeat(257) }), DocumentError, 'bad-name');
  refuses(add({ props: { 'bad key': 1 } }), DocumentError, 'bad-props');
  refuses(add({ id: 'not-an-id' }), DocumentError, 'bad-id');
  refuses(add({ type: 'spaceship' as never }), DocumentError, 'bad-type');
  refuses(add({}, { maxObjects: 6 }), DocumentError, 'too-many-objects');
  refuses(add({ parentId: id(1) }, { maxDepth: 1 }), DocumentError, 'too-deep');
  assert.doesNotThrow(add({ parentId: id(1) }, { maxDepth: 2 }));
});

test('update changes the name and replaces the properties; changing nothing is no change at all (the same document, an empty change)', () => {
  const d = doc(folder(1), node(2, { parentId: id(1), props: { host: 'a', port: 3389 } }));
  const renamed = applyOp(d, { op: 'update', id: id(2), name: 'web' }, env());
  assert.deepEqual([renamed.doc.objects[id(2)]!.name, renamed.doc.objects[id(2)]!.props, renamed.change.upsert.length], ['web', { host: 'a', port: 3389 }, 1]);
  const reprop = applyOp(d, { op: 'update', id: id(2), props: { host: 'b' } }, env());
  assert.deepEqual(reprop.doc.objects[id(2)]!.props, { host: 'b' }, 'the properties are replaced, not merged');
  for (const same of [{ name: 'n2' }, { props: { port: 3389, host: 'a' } }, { name: 'n2', props: { host: 'a', port: 3389 } }, {}]) {
    const noop = applyOp(d, { op: 'update', id: id(2), ...same }, env());
    assert.equal(noop.doc, d, JSON.stringify(same));
    assert.deepEqual(noop.change, { upsert: [], remove: [] });
  }
  for (const changed of [{ props: { host: 'b', port: 3389 } }, { props: { host: 'a', port: 3390 } }]) { // the same keys with another value is a change
    const applied = applyOp(d, { op: 'update', id: id(2), ...changed }, env());
    assert.notEqual(applied.doc, d, JSON.stringify(changed));
    assert.equal(applied.change.upsert.length, 1);
  }
  const fewer = applyOp(d, { op: 'update', id: id(2), props: { host: 'a' } }, env());           // a property that is only taken away is a change too
  assert.notEqual(fewer.doc, d);
  assert.deepEqual(fewer.doc.objects[id(2)]!.props, { host: 'a' });
  const deep = doc(node(2, { props: { list: [1, { deep: 'x' }] } }));
  assert.notEqual(applyOp(deep, { op: 'update', id: id(2), props: { list: [1, { deep: 'y' }] } }, env()).doc, deep, 'a value deep inside counts');
  assert.equal(applyOp(deep, { op: 'update', id: id(2), props: { list: [1, { deep: 'x' }] } }, env()).doc, deep, 'and the same value deep inside does not');
  refuses(() => applyOp(d, { op: 'update', id: id(2), name: 'x'.repeat(257) }, env()), DocumentError, 'bad-name');
  refuses(() => applyOp(d, { op: 'update', id: id(99), name: 'x' }, env()), OpError, 'unknown-object');
  refuses(() => applyOp(d, { op: 'update', id: '__proto__', name: 'x' }, env()), OpError, 'unknown-object');
});

test('remove takes the object and everything below it, and says which ids are gone', () => {
  const d = sample();
  const applied = applyOp(d, { op: 'remove', id: id(1) }, env());
  assert.deepEqual(Object.keys(applied.doc.objects).sort(), [id(5), id(6)]);
  assert.deepEqual([...applied.change.remove].sort(), [id(1), id(2), id(3), id(4)]);
  assert.deepEqual(applied.change.upsert, []);
  assert.deepEqual(Object.keys(applyOp(d, { op: 'remove', id: id(2) }, env()).doc.objects).length, 5);
  refuses(() => applyOp(d, { op: 'remove', id: id(99) }, env()), OpError, 'unknown-object');
  refuses(() => applyOp(d, { op: 'remove', id: 'constructor' }, env()), OpError, 'unknown-object');
});

test('move reorders within a folder, goes into a folder (last, or at a position), and out to the top level', () => {
  const d = sample();
  const down = applyOp(d, { op: 'move', id: id(2), parentId: id(1), index: 2 }, env());
  assert.deepEqual(kids(down.doc, id(1)), ['n3', 'n4', 'n2'], 'position 2 is the final position, counted without the object itself');
  assert.deepEqual(down.change.upsert.map((o) => o.name), ['n2'], 'moving later costs one object when the orders have room (n3 and n4 keep theirs)');
  const up = applyOp(d, { op: 'move', id: id(4), parentId: id(1), index: 0 }, env());
  assert.deepEqual(kids(up.doc, id(1)), ['n4', 'n2', 'n3']);
  const into = applyOp(d, { op: 'move', id: id(6), parentId: id(5) }, env());
  assert.deepEqual([kids(into.doc, id(5)), kids(into.doc, null)], [['n6'], ['f1', 'f5']]);
  assert.deepEqual(into.change.upsert.map((o) => o.name), ['n6'], 'a move to the end of a folder changes only the moved object');
  const out = applyOp(d, { op: 'move', id: id(3), parentId: null, index: 1 }, env());
  assert.deepEqual([kids(out.doc, null), kids(out.doc, id(1))], [['f1', 'n3', 'f5', 'n6'], ['n2', 'n4']]);
  assert.equal(out.doc.objects[id(3)]!.parentId, null);
});

test('move that changes nothing is no change at all; a bad position, a cycle, a parent that is not a folder and the depth limit are refused', () => {
  const d = sample();
  for (const same of [{ parentId: id(1), index: 0 }, { parentId: id(1) , index: 2 }]) {
    const target = same.index === 0 ? id(2) : id(4);
    const noop = applyOp(d, { op: 'move', id: target, ...same }, env());
    assert.equal(noop.doc, d, `${target} to ${same.index}`);
  }
  refuses(() => applyOp(d, { op: 'move', id: id(2), parentId: id(1), index: 3 }, env()), OpError, 'bad-index');
  refuses(() => applyOp(d, { op: 'move', id: id(1), parentId: id(1) }, env()), DocumentError, 'cycle');
  const deep = doc(folder(1), folder(2, { parentId: id(1) }), folder(3, { parentId: id(2) }), node(4, { parentId: id(3) }));
  refuses(() => applyOp(deep, { op: 'move', id: id(1), parentId: id(3) }, env()), DocumentError, 'cycle');
  refuses(() => applyOp(d, { op: 'move', id: id(6), parentId: id(2) }, env()), DocumentError, 'bad-parent');
  refuses(() => applyOp(d, { op: 'move', id: id(99), parentId: null }, env()), OpError, 'unknown-object');
  const tall = doc(folder(1), folder(2, { parentId: id(1) }), folder(3), node(4, { parentId: id(3) }));
  refuses(() => applyOp(tall, { op: 'move', id: id(1), parentId: id(3) }, env({ maxDepth: 2 })), DocumentError, 'too-deep'); // f3 > f1 > f2 is three levels
  assert.doesNotThrow(() => applyOp(tall, { op: 'move', id: id(1), parentId: id(3) }, env({ maxDepth: 3 })));
});

test('duplicate copies the object and everything below it with new ids, right after the original, and leaves the original alone', () => {
  const d = doc(folder(1), node(2, { parentId: id(1), order: 0, props: { host: 'a' } }), folder(3, { parentId: id(1), order: 1 }), node(4, { parentId: id(3), props: { host: 'b' } }), node(5, { order: 1 }));
  const e = env();
  const applied = applyOp(d, { op: 'duplicate', id: id(1), name: 'f1 salinan' }, e);
  assert.deepEqual(kids(applied.doc, null), ['f1', 'f1 salinan', 'n5'], 'the copy sits right after the original, and the object after it moved up');
  const copy = applied.doc.objects[applied.created!]!;
  assert.equal(copy.name, 'f1 salinan');
  assert.deepEqual(kids(applied.doc, copy.id), ['n2', 'f3'], 'with its contents, in the same order');
  assert.equal(Object.keys(applied.doc.objects).length, 5 + 4);
  assert.equal(new Set(Object.keys(applied.doc.objects)).size, 9, 'every id is new');
  const innerCopy = Object.values(applied.doc.objects).find((o) => o.parentId === Object.values(applied.doc.objects).find((f) => f.parentId === copy.id && f.type === 'folder')!.id)!;
  assert.deepEqual(innerCopy.props, { host: 'b' });
  innerCopy.props.host = 'changed';
  assert.deepEqual(d.objects[id(4)]!.props, { host: 'b' }, 'the properties were copied, not shared');
  assert.deepEqual(applied.change.upsert.map((o) => o.id).sort(), [...Object.keys(applied.doc.objects).filter((k) => !Object.hasOwn(d.objects, k)), id(5)].sort(), 'the copies and the sibling that moved up');
  assert.deepEqual(kids(d, null), ['f1', 'n5']);
  refuses(() => applyOp(d, { op: 'duplicate', id: id(99), name: 'x' }, e), OpError, 'unknown-object');
  refuses(() => applyOp(d, { op: 'duplicate', id: id(1), name: 'x'.repeat(257) }, e), DocumentError, 'bad-name');
  refuses(() => applyOp(d, { op: 'duplicate', id: id(1), name: 'x' }, env({ maxObjects: 8 })), DocumentError, 'too-many-objects');
});

// ---- the operations held to validateDocument: random sequences, checked after every step --------------------------------------------------

function random(seed: number): () => number {
  let a = seed;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A document that obeys the depth limit, with orders 0, 1, 2 ... among siblings. */
function randomDoc(next: () => number, size: number, maxDepth: number): Doc {
  const nodes: ObjectNode[] = [];
  const depth = new Map<string, number>();
  const counts = new Map<string | null, number>();
  for (let n = 1; n <= size; n++) {
    const parents = nodes.filter((o) => o.type === 'folder' && depth.get(o.id)! < maxDepth);
    const parentId = parents.length > 0 && next() < 0.7 ? parents[Math.floor(next() * parents.length)]!.id : null;
    const order = counts.get(parentId) ?? 0;
    counts.set(parentId, order + 1);
    const made = next() < 0.55 ? folder(n, { parentId, order }) : node(n, { parentId, order, props: { host: `h${n}` } });
    depth.set(made.id, parentId === null ? 1 : depth.get(parentId)! + 1);
    nodes.push(made);
  }
  return doc(...nodes);
}

/** The same edit made without any checking, so that validateDocument alone decides whether the result is a document. */
function unchecked(d: Doc, op: Op, ids: () => string): Doc {
  const objects = { ...d.objects };
  const below = (root: string): string[] => [root, ...Object.values(objects).filter((o) => o.parentId === root).flatMap((o) => below(o.id))];
  switch (op.op) {
    case 'add': objects[op.id] = { id: op.id, type: op.type, name: op.name, parentId: op.parentId, order: 0, props: op.props }; break;
    case 'update': objects[op.id] = { ...objects[op.id]!, ...(op.name === undefined ? {} : { name: op.name }), ...(op.props === undefined ? {} : { props: op.props }) }; break;
    case 'remove': for (const gone of below(op.id)) delete objects[gone]; break;
    case 'move': objects[op.id] = { ...objects[op.id]!, parentId: op.parentId }; break;
    case 'duplicate': {
      const copies = new Map(below(op.id).map((o) => [o, ids()]));
      for (const [from, to] of copies) objects[to] = { ...objects[from]!, id: to, parentId: from === op.id ? objects[from]!.parentId : copies.get(objects[from]!.parentId!)!, name: from === op.id ? op.name : objects[from]!.name };
      break;
    }
  }
  return { ...d, objects };
}

test('whatever the operations accept is a document and whatever they refuse is not, over random sequences; the change always carries exactly what differs', () => {
  const limits = { maxDepth: 5, maxObjects: 40 };
  let accepted = 0, refused = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    let current = randomDoc(next, 3 + Math.floor(next() * 12), limits.maxDepth);
    validateDocument(current, limits); // the starting point is a document under these limits
    const ids = counter();
    for (let step = 0; step < 25; step++) {
      const all = Object.values(current.objects);
      const pick = () => (all.length === 0 ? id(99_999) : all[Math.floor(next() * all.length)]!.id);
      const folders = all.filter((o) => o.type === 'folder');
      const parent = () => (folders.length === 0 || next() < 0.2 ? null : folders[Math.floor(next() * folders.length)]!.id);
      const roll = next();
      if (all.length === 0 && roll >= 0.3) continue; // nothing left to change but adding
      const op: Op = roll < 0.3 ? { op: 'add', id: ids(), parentId: next() < 0.15 ? pick() : parent(), type: next() < 0.5 ? 'folder' : 'connection', name: `new${step}`, props: {} }
        : roll < 0.45 ? { op: 'update', id: pick(), name: `renamed${step}`, props: { host: `x${step}` } }
        : roll < 0.6 ? { op: 'remove', id: pick() }
        : roll < 0.9 ? { op: 'move', id: pick(), parentId: next() < 0.15 ? pick() : parent() }
        : { op: 'duplicate', id: pick(), name: `copy${step}` };
      if (op.op === 'move' && next() < 0.3) { // a position, sometimes
        const wanted = Object.values(current.objects).filter((o) => o.parentId === op.parentId && o.id !== op.id).length;
        op.index = Math.floor(next() * (wanted + 1));
      }
      const judge = (candidate: Doc) => { try { validateDocument(candidate, limits); return true; } catch (error) { assert.ok(error instanceof DocumentError, String(error)); return false; } };
      const reference = judge(unchecked(current, op, counter(100_000)));
      let applied;
      try { applied = applyOp(current, op, { newId: ids, limits }); } catch (error) {
        assert.ok(error instanceof DocumentError, `${JSON.stringify(op)}: ${error}`); // never an OpError here: every id exists, every position is in range
        assert.equal(reference, false, `refused, but the same edit made without checks is a document: ${JSON.stringify(op)}`);
        refused++;
        continue;
      }
      accepted++;
      assert.doesNotThrow(() => validateDocument(applied.doc, limits), `accepted, but the result is not a document: ${JSON.stringify(op)}`);
      assert.equal(reference, true, `accepted, but the same edit made without checks is not a document: ${JSON.stringify(op)}`);
      const rebuilt = { ...current.objects };
      for (const gone of applied.change.remove) delete rebuilt[gone];
      for (const changed of applied.change.upsert) rebuilt[changed.id] = changed;
      assert.deepEqual(rebuilt, applied.doc.objects, `the change does not turn the old document into the new one: ${JSON.stringify(op)}`);
      for (const changed of applied.change.upsert) assert.notDeepEqual(changed, current.objects[changed.id], 'a change lists only objects that differ');
      const groups = new Map<string | null, number[]>();
      for (const o of Object.values(applied.doc.objects).sort(compareSiblings)) groups.set(o.parentId, [...(groups.get(o.parentId) ?? []), o.order]);
      for (const orders of groups.values()) assert.deepEqual(orders, [...orders].sort((x, y) => x - y).filter((v, i, a) => i === 0 || v > a[i - 1]!), 'orders stay strictly increasing');
      current = applied.doc;
    }
  }
  assert.ok(accepted > 1500 && refused > 300, `the run exercised both sides: ${accepted} accepted, ${refused} refused`);
});

test('a move, and the siblings that a position moves up, keep everything but their place: name, type and properties', () => {
  const d = doc(folder(1), node(2, { parentId: id(1), order: 0, props: { host: 'h', port: 3389, nested: { list: [1, 2] } } }), node(3, { parentId: id(1), order: 1, props: { host: 'other' } }), node(4, { order: 5, props: { x: 1 } }));
  const moved = applyOp(d, { op: 'move', id: id(4), parentId: id(1), index: 0 }, env());
  assert.deepEqual(moved.doc.objects[id(4)], { ...d.objects[id(4)]!, parentId: id(1), order: 0 });
  for (const n of [2, 3]) assert.deepEqual(moved.doc.objects[id(n)], { ...d.objects[id(n)]!, order: d.objects[id(n)]!.order + 1 }, `n${n} only moved up`);
  const added = applyOp(d, { op: 'add', id: id(10), parentId: id(1), type: 'connection', name: 'new', props: {}, index: 0 }, env());
  for (const n of [2, 3]) assert.deepEqual(added.doc.objects[id(n)], { ...d.objects[id(n)]!, order: d.objects[id(n)]!.order + 1 }, `n${n} only moved up by an add`);
  const copied = applyOp(d, { op: 'duplicate', id: id(2), name: 'copy' }, env());
  const copy = copied.doc.objects[copied.created!]!;
  assert.deepEqual([copy.type, copy.props, copy.name, copy.parentId], ['connection', d.objects[id(2)]!.props, 'copy', id(1)]);
  assert.deepEqual(copied.doc.objects[id(3)], { ...d.objects[id(3)]!, order: 2 }, 'the sibling after the original only moved up');
});

test('the object limit is reached, not exceeded: the last free place can be used and one more is refused, for add and for duplicate', () => {
  const d = sample();                                                // six objects; the folder f1 has three below it
  const add = (limit: number) => () => applyOp(d, { op: 'add', id: id(10), parentId: null, type: 'connection', name: 'x', props: {} }, env({ maxObjects: limit }));
  assert.doesNotThrow(add(7));
  refuses(add(6), DocumentError, 'too-many-objects');
  const copy = (limit: number) => () => applyOp(d, { op: 'duplicate', id: id(1), name: 'copy' }, env({ maxObjects: limit }));
  assert.doesNotThrow(copy(10));                                       // 6 + 4
  refuses(copy(9), DocumentError, 'too-many-objects');
});

test('a folder with very many children is removed and copied with all of them, and the copy has nothing in common with the original', () => {
  const kidsCount = 40_000;
  const objects: ObjectNode[] = [folder(1)];
  for (let i = 0; i < kidsCount; i++) objects.push(node(i + 2, { parentId: id(1), order: i }));
  const d = doc(...objects);
  const removed = applyOp(d, { op: 'remove', id: id(1) }, env());
  assert.equal(removed.change.remove.length, kidsCount + 1);
  assert.deepEqual(Object.keys(removed.doc.objects), []);
  const copied = applyOp(d, { op: 'duplicate', id: id(1), name: 'copy' }, { newId: counter(1_000_000) });   // ids that no object has
  assert.equal(copied.change.upsert.length, kidsCount + 1);
  assert.equal(Object.keys(copied.doc.objects).length, 2 * (kidsCount + 1));
});
