import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObjectNode } from '../src/documents/model.js';
import { compareSiblings } from '../src/documents/order.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, name: string, order = 0): ObjectNode => ({ id: id(n), type: 'connection', name, parentId: null, order, props: {} });
const shown = (...nodes: ObjectNode[]) => [...nodes].sort(compareSiblings).map((o) => o.name);

test('siblings come in the order that was set by hand first, then by name', () => {
  assert.deepEqual(shown(node(1, 'b', 1), node(2, 'a', 2), node(3, 'c', 0)), ['c', 'b', 'a']);
  assert.deepEqual(shown(node(1, 'b'), node(2, 'a'), node(3, 'c')), ['a', 'b', 'c']);
});

test('names are compared without regard to case or accents, and digits are read as numbers', () => {
  assert.deepEqual(shown(node(1, 'srv10'), node(2, 'srv2'), node(3, 'Srv1')), ['Srv1', 'srv2', 'srv10']);
  // the same name in another case is the same name: the id decides (the capitalised one has the smaller id, so a comparison that sees the case would put it last)
  assert.deepEqual([node(1, 'SRV'), node(2, 'srv')].sort(compareSiblings).map((o) => o.id), [id(1), id(2)]);
  assert.deepEqual([node(1, 'Émile'), node(2, 'emile')].sort(compareSiblings).map((o) => o.id), [id(1), id(2)]);
});

test('siblings that look the same are ordered by id, so the result never depends on the order they arrive in', () => {
  const x = node(1, 'same'), y = node(2, 'same');
  assert.deepEqual([x, y].sort(compareSiblings).map((o) => o.id), [id(1), id(2)]);
  assert.deepEqual([y, x].sort(compareSiblings).map((o) => o.id), [id(1), id(2)]);
});
