import assert from 'node:assert/strict';
import test from 'node:test';
import { merge3 } from '../src/documents/merge.js';
import { validateDocument, type Doc, type ObjectNode } from '../src/documents/model.js';
import { compareSiblings } from '../src/documents/order.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const doc = (...nodes: ObjectNode[]): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'ws', revision: 1, objects: Object.fromEntries(nodes.map((o) => [o.id, o])) });
const withOrders = (d: Doc, orders: Record<number, number>): Doc => ({ ...d, objects: Object.fromEntries(Object.values(d.objects).map((o) => [o.id, { ...o, order: orders[Number(o.id.slice(-12))] ?? o.order }])) });
const names = (d: Doc) => Object.values(d.objects).sort(compareSiblings).map((o) => o.name);

const base = () => doc(node(1, { order: 0 }), node(2, { order: 1 }), node(3, { order: 2 }), node(4, { order: 3 }));

test('two people putting the same folder in a different order is not a conflict: mine wins where both moved, the siblings are numbered again', () => {
  const mine = withOrders(base(), { 3: 0, 1: 1, 2: 2, 4: 3 });    // n3 first
  const theirs = withOrders(base(), { 2: 0, 3: 1, 4: 2, 1: 3 });  // n1 last
  const { merged, conflicts } = merge3(base(), mine, theirs);
  assert.deepEqual(conflicts, [], 'no conflict, whichever side moved what');
  assert.deepEqual(names(merged), ['n3', 'n1', 'n2', 'n4'], 'n3, n1 and n2 moved on both sides, so the merge is mine; n4 moved only on theirs and takes theirs, which ties with n2 and the id settles');
  assert.deepEqual(Object.values(merged.objects).map((o) => o.order).sort(), [0, 1, 2, 3], 'and the numbers are 0, 1, 2 ... again');
  validateDocument(merged);
});

test('an order that only one side changed is that side\'s; an object the other side moved is not touched by mine', () => {
  const mine = withOrders(base(), { 4: 0, 1: 1, 2: 2, 3: 3 });    // n4 first (everything else shifts down)
  const theirs = base();                                           // unchanged
  assert.deepEqual(names(merge3(base(), mine, theirs).merged), ['n4', 'n1', 'n2', 'n3']);
  assert.deepEqual(names(merge3(base(), theirs, mine).merged), ['n4', 'n1', 'n2', 'n3'], 'and the same from the other side');
});

test('a real conflict on another field is still reported when order moves too', () => {
  const mine = { ...withOrders(base(), { 2: 0, 1: 1 }), objects: { ...withOrders(base(), { 2: 0, 1: 1 }).objects } };
  mine.objects[id(3)] = { ...mine.objects[id(3)]!, name: 'mine' };
  const theirs = withOrders(base(), { 1: 5 });
  theirs.objects[id(3)] = { ...theirs.objects[id(3)]!, name: 'theirs' };
  const { conflicts } = merge3(base(), mine, theirs);
  assert.deepEqual(conflicts.map((c) => c.kind === 'field' ? c.field : c.kind), ['name']);
});

test('an object that was only shifted by a new place before it is not edited: the other side deleting it is no conflict, from either side', () => {
  const mine = withOrders(base(), { 2: 2, 3: 3, 4: 4 });         // something was put at place 1: n2, n3 and n4 moved up one place
  mine.objects[id(5)] = node(5, { order: 1 });                    // and that something is n5
  const theirs = base();
  delete theirs.objects[id(4)];                                   // the other writer deleted n4
  for (const [one, other] of [[mine, theirs], [theirs, mine]] as const) {
    const { merged, conflicts } = merge3(base(), one, other);
    assert.deepEqual(conflicts, [], 'the delete wins: n4 was not edited, only shifted');
    assert.deepEqual(names(merged), ['n1', 'n5', 'n2', 'n3']);
    validateDocument(merged);
  }
});

test('an object that was deleted on one side and really edited on the other is still a conflict and stays, also when it was shifted as well', () => {
  const mine = withOrders(base(), { 3: 3, 4: 4 });
  mine.objects[id(4)] = { ...mine.objects[id(4)]!, name: 'edited' };
  const theirs = base();
  delete theirs.objects[id(4)];
  for (const [one, other] of [[mine, theirs], [theirs, mine]] as const) {
    const { merged, conflicts } = merge3(base(), one, other);
    assert.deepEqual(conflicts.map((c) => c.kind), ['delete-edit']);
    assert.equal(merged.objects[id(4)]?.name, 'edited', 'the edited object is kept');
  }
});

test('an object that one side moved to another folder takes the place that side gave it there, not the place the other side gave it in the folder it left', () => {
  // p holds n1 and n2, q holds n3. Mine puts n1 at the top of q (n3 moves down, n1 has place 0 there, which is also the place it had in p); theirs puts n1 behind n2 in p.
  const tree = () => doc(node(8, { type: 'folder', order: 0 }), node(9, { type: 'folder', order: 1 }), node(1, { parentId: id(8), order: 0 }), node(2, { parentId: id(8), order: 1 }), node(3, { parentId: id(9), order: 0 }));
  const mine = tree();
  mine.objects[id(1)] = { ...mine.objects[id(1)]!, parentId: id(9), order: 0 };
  mine.objects[id(3)] = { ...mine.objects[id(3)]!, order: 1 };
  const theirs = tree();
  theirs.objects[id(1)] = { ...theirs.objects[id(1)]!, order: 2 };
  for (const [one, other] of [[mine, theirs], [theirs, mine]] as const) {
    const { merged, conflicts } = merge3(tree(), one, other);
    assert.deepEqual(conflicts, [], 'moving to another folder on one side and ordering in the folder on the other is not a conflict');
    const inside = (n: number) => Object.values(merged.objects).filter((o) => o.parentId === id(n)).sort(compareSiblings).map((o) => o.name);
    assert.deepEqual(inside(9), ['n1', 'n3'], 'n1 is where it was put: the top of q');
    assert.deepEqual(inside(8), ['n2']);
    validateDocument(merged);
  }
});
