import assert from 'node:assert/strict';
import test from 'node:test';
import { merge3, resolveField } from '../src/documents/merge.js';
import { keyOf, resolveMany } from '../src/documents/conflicts.js';
import type { Doc2 } from '../src/documents/model.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixture = () => {
  const base: Doc2 = { schemaVersion: 2, id: id(900), kind: 'workspace', name: 'fixture', revision: 0, meta: { createdAt: null, updatedAt: null, sort: [] }, defaults: { groups: {} }, objects: {}, secrets: { [id(11)]: { kind: 'credential', username: 'lab', domain: '', password: 'BASE-CANARY' } } };
  const mine = structuredClone(base), theirs = structuredClone(base); (mine.secrets[id(11)] as any).username = 'mine'; (theirs.secrets[id(11)] as any).password = 'THEIRS-CANARY';
  const result = merge3(base, mine, theirs); const conflict = result.conflicts[0]!; assert.equal(conflict.kind, 'field');
  return { base, mine, theirs, ...result, conflict };
};
test('resolveField secret choice owns its record; later result mutation cannot change source or conflict sides', () => {
  const f = fixture(), before = structuredClone(f.theirs);
  const resolved = resolveField(f.merged, f.conflict as any, 'theirs') as Doc2;
  (resolved.secrets[id(11)] as any).password = 'RESULT-CHANGE-CANARY';
  assert.deepEqual(f.theirs, before); assert.equal((f.conflict as any).theirs.password, 'THEIRS-CANARY');
});
test('resolveMany secret choice owns its record; later result mutation cannot change source or conflict sides', () => {
  const f = fixture(), before = structuredClone(f.theirs);
  const resolved = resolveMany(f.merged, f.conflicts, [{ key: keyOf(f.conflict), choice: 'theirs' }]).doc as Doc2;
  (resolved.secrets[id(11)] as any).password = 'RESULT-CHANGE-CANARY';
  assert.deepEqual(f.theirs, before); assert.equal((f.conflict as any).theirs.password, 'THEIRS-CANARY');
});
