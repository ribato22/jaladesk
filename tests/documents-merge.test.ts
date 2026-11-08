import test from 'node:test';
import assert from 'node:assert/strict';
import { merge3, resolveField } from '../src/documents/merge.js';
import { validateDocument, type Doc, type ObjectNode } from '../src/documents/model.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const doc = (revision: number, ...nodes: ObjectNode[]): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'test', revision, objects: Object.fromEntries(nodes.map((x) => [x.id, x])) });
const edit = (d: Doc, n: number, change: (o: ObjectNode) => void, revision = d.revision + 1): Doc => {
  const copy = structuredClone(d);
  change(copy.objects[id(n)]!);
  copy.revision = revision;
  return copy;
};
const base = () => doc(5, node(1, { type: 'folder' }), node(2, { parentId: id(1), order: 0, props: { host: 'a', port: 3389 } }), node(3, { parentId: id(1), order: 1 }));

test('edits to different objects, and to different properties of one object, merge without conflict', () => {
  const b = base();
  const mine = edit(b, 2, (o) => { o.props.host = 'mine'; });
  const theirs = edit(edit(b, 3, (o) => { o.name = 'theirs'; }), 2, (o) => { o.props.port = 4000; }, 7);
  const { merged, conflicts } = merge3(b, mine, theirs);
  assert.deepEqual(conflicts, []);
  assert.equal(merged.objects[id(2)]!.props.host, 'mine');
  assert.equal(merged.objects[id(2)]!.props.port, 4000);
  assert.equal(merged.objects[id(3)]!.name, 'theirs');
  assert.equal(merged.revision, 7, 'the merged revision is the highest of the two sides');
  validateDocument(merged);
});

test('the same property changed to different values is a conflict, never last-writer-wins; the same value on both sides is not', () => {
  const b = base();
  const mine = edit(b, 2, (o) => { o.props.host = 'mine'; o.name = 'same'; });
  const theirs = edit(b, 2, (o) => { o.props.host = 'theirs'; o.name = 'same'; });
  const { merged, conflicts } = merge3(b, mine, theirs);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], { kind: 'field', id: id(2), field: 'props.host', base: 'a', mine: 'mine', theirs: 'theirs' });
  assert.equal(merged.objects[id(2)]!.props.host, 'mine', 'provisional value until the user resolves it');
  assert.equal(resolveField(merged, conflicts[0] as never, 'theirs').objects[id(2)]!.props.host, 'theirs');
});

test('objects added on one or both sides are all kept; deleting on both sides deletes', () => {
  const b = base();
  const mine = structuredClone(b); mine.objects[id(10)] = node(10, { parentId: id(1), order: 2 }); delete mine.objects[id(3)];
  const theirs = structuredClone(b); theirs.objects[id(11)] = node(11, { parentId: id(1), order: 2 }); delete theirs.objects[id(3)];
  const { merged, conflicts } = merge3(b, mine, theirs);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(Object.keys(merged.objects).sort(), [id(1), id(10), id(11), id(2)].sort());
  const siblings = Object.values(merged.objects).filter((o) => o.parentId === id(1)).sort((x, y) => x.order - y.order);
  assert.deepEqual(siblings.map((o) => o.order), [0, 1, 2], 'sibling order is normalised after concurrent inserts');
});

test('deleting an object that the other side edited is a conflict and the edited object is kept', () => {
  const b = base();
  const mine = structuredClone(b); delete mine.objects[id(2)];
  const theirs = edit(b, 2, (o) => { o.name = 'renamed'; });
  const { merged, conflicts } = merge3(b, mine, theirs);
  assert.deepEqual(conflicts, [{ kind: 'delete-edit', id: id(2), deletedBy: 'mine' }]);
  assert.equal(merged.objects[id(2)]!.name, 'renamed');
  const same = merge3(b, mine, structuredClone(b)); // the other side did not touch it: the delete wins
  assert.deepEqual(same.conflicts, []);
  assert.equal(id(2) in same.merged.objects, false);
});

test('an object added under a folder that the other side deleted is reattached to the top level and reported', () => {
  const b = base();
  const mine = structuredClone(b); mine.objects[id(10)] = node(10, { parentId: id(1), order: 2 });
  const theirs = structuredClone(b); delete theirs.objects[id(1)]; delete theirs.objects[id(2)]; delete theirs.objects[id(3)];
  const { merged, conflicts } = merge3(b, mine, theirs);
  assert.deepEqual(conflicts, [{ kind: 'orphan', id: id(10), parentId: id(1) }]);
  assert.equal(merged.objects[id(10)]!.parentId, null);
  validateDocument(merged);
});

test('two moves that together would make a cycle are reported and both folders keep their old parents', () => {
  const b = doc(1, node(1, { type: 'folder' }), node(2, { type: 'folder' }));
  const mine = edit(b, 1, (o) => { o.parentId = id(2); });
  const theirs = edit(b, 2, (o) => { o.parentId = id(1); });
  const { merged, conflicts } = merge3(b, mine, theirs);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.kind, 'cycle');
  assert.equal(merged.objects[id(1)]!.parentId, null);
  assert.equal(merged.objects[id(2)]!.parentId, null);
  validateDocument(merged);
});

test('documents that are not the same document cannot be merged', () => {
  const b = base();
  assert.throws(() => merge3(b, { ...b, id: id(901) }, b), /same document/);
});

test('merging changes none of the documents it was given, also when it has to reattach, untangle and number the siblings again', () => {
  const gap = doc(5, node(1, { type: 'folder' }), node(2, { parentId: id(1), order: 0 }), node(3, { parentId: id(1), order: 1 }), node(4, { parentId: id(1), order: 2 }), node(5, { type: 'folder', order: 1 }), node(6, { type: 'folder', order: 2 }));
  const cases: [string, Doc, Doc][] = [
    ['numbering again (the other side removed the one in the middle)', gap, (() => { const d = structuredClone(gap); delete d.objects[id(3)]; d.revision = 6; return d; })()],
    ['reattaching (the other side removed the folder an added object is in)', (() => { const d = structuredClone(gap); d.objects[id(7)] = node(7, { parentId: id(5), order: 0 }); d.revision = 6; return d; })(), (() => { const d = structuredClone(gap); delete d.objects[id(5)]; d.revision = 6; return d; })()],
    ['untangling (two moves that make a cycle)', (() => { const d = structuredClone(gap); d.objects[id(5)]!.parentId = id(6); d.revision = 6; return d; })(), (() => { const d = structuredClone(gap); d.objects[id(6)]!.parentId = id(5); d.revision = 6; return d; })()],
  ];
  for (const [what, mine, theirs] of cases) {
    const copies = [structuredClone(gap), structuredClone(mine), structuredClone(theirs)];
    merge3(gap, mine, theirs);
    assert.deepEqual([gap, mine, theirs], copies, `${what}: base, mine and theirs are as they were`);
  }
});
