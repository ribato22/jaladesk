import assert from 'node:assert/strict';
import test from 'node:test';
import type { Snapshot } from '../src/documents/library.js';
import type { ObjectNode } from '../src/documents/model.js';
import { modelOf } from '../src/desktop/docmodel.js';
import { buildRows, documentKey, objectKey } from '../src/desktop/navigation.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: n, props: {}, ...over });
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({ id: 's1', docId: id(900), name: 'Lab', revision: 1, dirty: false, conflicts: 0, seq: 1, objects: [node(1, { type: 'folder' }), node(2, { parentId: id(1) })], ...over });

test('a document row says how many conflicts are held back, only when there are some', () => {
  const none = buildRows([modelOf(snapshot())], new Set([documentKey('s1')]));
  assert.equal('conflicts' in none[0]!, false);
  const held = buildRows([modelOf(snapshot({ conflicts: 3 }))], new Set([documentKey('s1')]));
  assert.equal(held[0]!.conflicts, 3);
  assert.equal(held.slice(1).some((r) => 'conflicts' in r), false, 'not the objects');
});

test('the rows of an earlier version can be marked by the key of the object: gone from the document, or different', () => {
  const compared = new Map<string, 'gone' | 'changed'>([[objectKey('s1', id(1)), 'changed'], [objectKey('s1', id(2)), 'gone']]);
  const rows = buildRows([modelOf(snapshot())], new Set([documentKey('s1'), objectKey('s1', id(1))]), { compared });
  assert.deepEqual(rows.map((r) => [r.name, r.compared]), [['Lab', undefined], ['n1', 'changed'], ['n2', 'gone']]);
  assert.equal(buildRows([modelOf(snapshot())], new Set([documentKey('s1')]))[0]!.compared, undefined);
});
