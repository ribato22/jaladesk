import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentLibrary, type Delta, type Snapshot } from '../src/documents/library.js';
import type { ObjectNode } from '../src/documents/model.js';
import { applyDelta, modelOf, sortedChildren } from '../src/desktop/docmodel.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const snapshot = (objects: ObjectNode[], over: Partial<Snapshot> = {}): Snapshot => ({ id: 's1', docId: id(900), name: 'Lab', revision: 1, dirty: false, conflicts: 0, seq: 4, objects, ...over });
const delta = (over: Partial<Delta>): Delta => ({ id: 's1', docId: id(900), name: 'Lab', revision: 1, dirty: true, conflicts: 0, seq: 5, from: 4, upsert: [], remove: [], ...over });
const childrenOf = (m: ReturnType<typeof modelOf>, parent: string | null) => [...(m.children.get(parent) ?? [])].sort();

test('a model is the objects of a snapshot by id, with an index of whose children they are', () => {
  const m = modelOf(snapshot([node(1, { type: 'folder' }), node(2, { parentId: id(1) }), node(3, { parentId: id(1), order: 1 }), node(4)]));
  assert.deepEqual([m.id, m.name, m.seq, m.objects.size], ['s1', 'Lab', 4, 4]);
  assert.deepEqual([childrenOf(m, null), childrenOf(m, id(1))], [[id(1), id(4)], [id(2), id(3)]]);
  assert.deepEqual(sortedChildren(m, id(1)).map((o) => o.name), ['n2', 'n3']);
  assert.deepEqual(sortedChildren(m, id(4)), [], 'a connection has no children');
});

test('the next change is taken in: objects are added, replaced and removed, an object that moves changes folder, and the document\'s own state follows', () => {
  const m = modelOf(snapshot([node(1, { type: 'folder' }), node(2, { parentId: id(1) }), node(3, { type: 'folder', order: 1 })]));
  const taken = applyDelta(m, delta({ upsert: [node(2, { parentId: id(3), name: 'moved' }), node(9, { parentId: id(1) })], remove: [], revision: 2, name: 'Renamed', conflicts: 1 }));
  assert.equal(taken, 'applied');
  assert.deepEqual([childrenOf(m, id(1)), childrenOf(m, id(3))], [[id(9)], [id(2)]], 'it left one folder and joined the other');
  assert.equal(m.objects.get(id(2))!.name, 'moved');
  assert.deepEqual([m.seq, m.dirty, m.revision, m.name, m.conflicts], [5, true, 2, 'Renamed', 1]);
  applyDelta(m, delta({ seq: 6, from: 5, remove: [id(9), id(2)] }));
  assert.deepEqual([[...m.objects.keys()].sort(), m.children.has(id(1)), m.children.has(id(3))], [[id(1), id(3)].sort(), false, false], 'nothing left in a folder: no entry for it');
  assert.equal(applyDelta(m, delta({ seq: 7, from: 6, remove: [id(777)] })), 'applied', 'an id it never had is nothing to remove');
});

test('a change that is old, or the same again, is ignored; one that skips a change is a gap and is not taken in', () => {
  const m = modelOf(snapshot([node(1)]));
  assert.equal(applyDelta(m, delta({ seq: 4, from: 3, upsert: [node(2)] })), 'stale', 'the same seq again');
  assert.equal(applyDelta(m, delta({ seq: 3, from: 2, upsert: [node(2)] })), 'stale', 'older');
  assert.equal(m.objects.size, 1);
  assert.equal(applyDelta(m, delta({ seq: 6, from: 5, upsert: [node(2)] })), 'gap', 'seq 5 never came');
  assert.deepEqual([m.objects.size, m.seq], [1, 4], 'a gap changes nothing: the window asks for a snapshot');
  assert.equal(applyDelta(m, delta({ seq: 5, upsert: [node(2)] })), 'applied');
  assert.equal(applyDelta(m, delta({ seq: 5, upsert: [node(3)] })), 'stale', 'and it is not applied twice');
  assert.deepEqual([...m.objects.keys()].sort(), [id(1), id(2)]);
});

test('a change that says nothing happened but is further on than the window is a gap, not the next change: a change that nobody delivered came before it', () => {
  const m = modelOf(snapshot([node(1)]));                      // at seq 4
  assert.equal(applyDelta(m, delta({ seq: 5, from: 5 })), 'gap', 'it makes no change of its own, the document is one change ahead of the window, and that change never came');
  assert.equal(applyDelta(m, delta({ seq: 6, from: 6 })), 'gap', 'and the same two changes ahead');
  assert.equal(applyDelta(m, delta({ seq: 4, from: 4 })), 'stale', 'one that changes nothing and is level with the window needs nothing');
  assert.equal(applyDelta(m, delta({ seq: 6, from: 5, upsert: [node(2)] })), 'gap', 'a change that follows a change the window did not get');
  assert.equal(m.seq, 4);
});

test('a reset starts the model again from what it carries, whatever the seq before it; an old reset is ignored', () => {
  const m = modelOf(snapshot([node(1), node(2, { type: 'folder' }), node(3, { parentId: id(2) })]));
  assert.equal(applyDelta(m, delta({ seq: 9, from: 8, reset: true, upsert: [node(7)], dirty: false })), 'applied', 'no need for seq 5 to 8: a reset says everything');
  assert.deepEqual([[...m.objects.keys()], childrenOf(m, null), m.children.has(id(2)), m.seq, m.dirty], [[id(7)], [id(7)], false, 9, false]);
  assert.equal(applyDelta(m, delta({ seq: 8, from: 7, reset: true, upsert: [node(8)] })), 'stale');
  assert.deepEqual([...m.objects.keys()], [id(7)]);
});

// ---- the library and the window agree ---------------------------------------------------------------------------------------------------

function random(seed: number): () => number {
  let a = seed;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('a window that only applies the deltas it is sent ends up with the same document as one that asks for a snapshot, after any sequence of edits, saves and another program\'s saves', async () => {
  const kdf = { logN: 14, r: 8, p: 1 };
  let resets = 0, refused = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const next = random(seed);
    const path = join(await mkdtemp(join(tmpdir(), 'rwmodel-')), 'doc.rwdoc');
    const ids = (from: number) => { let next = from; return () => id(next++); };   // the same run, every time
    const lib = new DocumentLibrary({ kdf, newId: ids(seed * 100_000) });
    const other = new DocumentLibrary({ kdf, newId: ids(seed * 100_000 + 50_000) });
    const { id: docId } = await lib.create(path, 'Lab', 'pw');
    await lib.save(docId);
    const otherId = (await other.open(path, 'pw')).id;
    const model = modelOf(lib.snapshot(docId));
    const keep = (d: Delta) => { if (d.reset) resets++; assert.notEqual(applyDelta(model, JSON.parse(JSON.stringify(d)) as Delta), 'gap', `seed ${seed}: a delta was missed`); }; // a copy, as the window gets it
    for (let step = 0; step < 40; step++) {
      const all = lib.snapshot(docId).objects;
      const pick = (kind?: 'folder') => { const pool = kind ? all.filter((o) => o.type === kind) : all; return pool.length === 0 ? undefined : pool[Math.floor(next() * pool.length)]!.id; };
      const roll = next();
      try {
        if (roll < 0.25) keep(lib.add(docId, { parentId: pick('folder') ?? null, type: next() < 0.4 ? 'folder' : 'connection', name: `new${step}` }).delta);
        else if (roll < 0.35 && pick()) keep(lib.update(docId, pick()!, { name: `renamed${step}` }));
        else if (roll < 0.45 && pick()) keep(lib.remove(docId, pick()!));
        else if (roll < 0.7 && pick()) keep(lib.move(docId, pick()!, pick('folder') ?? null, next() < 0.5 ? 0 : undefined));
        else if (roll < 0.8 && pick()) keep(lib.duplicate(docId, pick()!).delta);
        else if (roll < 0.9) keep((await lib.save(docId)).delta);
        else { other.add(otherId, { parentId: null, type: 'connection', name: `theirs${step}` }); await other.save(otherId); }
      } catch (error) {
        assert.equal((error as { name?: string }).name, 'LibraryError', `${error}`); // a refused edit (a cycle, a bad position) is part of the run, and changes nothing
        refused++;
      }
      const asked = modelOf(lib.snapshot(docId));
      assert.deepEqual([...model.objects].sort(([x], [y]) => (x < y ? -1 : 1)), [...asked.objects].sort(([x], [y]) => (x < y ? -1 : 1)), `seed ${seed} step ${step}`);
      assert.deepEqual([model.seq, model.dirty, model.revision, model.name, model.conflicts], [asked.seq, asked.dirty, asked.revision, asked.name, asked.conflicts]);
    }
    for (const [parent, ids] of asked(lib, docId).children) assert.deepEqual([...(model.children.get(parent) ?? [])].sort(), [...ids].sort(), `seed ${seed}: the index of children`);
  }
  assert.ok(resets >= 5 && refused >= 5, `the runs went through merges (${resets}) and refusals (${refused})`);
});

const asked = (lib: DocumentLibrary, docId: string) => modelOf(lib.snapshot(docId));
