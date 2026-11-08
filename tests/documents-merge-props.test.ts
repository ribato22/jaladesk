import assert from 'node:assert/strict';
import test from 'node:test';
import { merge3 } from '../src/documents/merge.js';
import { validateDocument, type Doc, type Json } from '../src/documents/model.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const make = (props: Record<string, Json>): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'D', revision: 0, objects: { [id(1)]: { id: id(1), type: 'connection', name: 'c', parentId: null, order: 0, props } } });

test('a property named like something every object has (toString, constructor, valueOf) is a property like any other in a merge, and the result is a document', () => {
  for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    const base = make({ host: 'a' });
    const added = merge3(base, make({ host: 'a', [key]: 1 }), make({ host: 'b' }));          // I added it; they changed something else
    assert.deepEqual(added.conflicts, [], key);
    assert.deepEqual(added.merged.objects[id(1)]!.props, { host: 'b', [key]: 1 }, key);
    assert.doesNotThrow(() => validateDocument(added.merged), key);
    const theirs = merge3(base, make({ host: 'b' }), make({ host: 'a', [key]: 'x' }));        // and the other way round
    assert.deepEqual(theirs.conflicts, [], key);
    assert.deepEqual(theirs.merged.objects[id(1)]!.props, { host: 'b', [key]: 'x' }, key);
    const removed = merge3(make({ host: 'a', [key]: 1 }), make({ host: 'a' }), make({ host: 'b', [key]: 1 }));   // I took it away
    assert.deepEqual(removed.merged.objects[id(1)]!.props, { host: 'b' }, key);
  }
});
