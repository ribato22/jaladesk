import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentError, LIMITS, validateDocument, type Doc, type ObjectNode } from '../src/documents/model.js';
import { OpError, type Env } from '../src/documents/ops.js';
import { compare, restoreAll, restoreObjects } from '../src/documents/restore.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const folder = (n: number, over: Partial<ObjectNode> = {}) => node(n, { type: 'folder', name: `f${n}`, ...over });
const secret = (n: number, over: Partial<ObjectNode> = {}) => node(n, { type: 'credential', name: `s${n}`, props: { password: `pw${n}` }, ...over });
const doc = (revision: number, name: string, ...nodes: ObjectNode[]): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name, revision, objects: Object.fromEntries(nodes.map((o) => [o.id, o])) });
/** Ids that are not the ones of any document in these tests, in the order they are asked for. */
const env = (limits?: Env['limits']): Env => { let n = 0; return { newId: () => `ffffffff-0000-4000-8000-${String(++n).padStart(12, '0')}`, ...(limits ? { limits } : {}) }; };

// What the document was (a revision): f1 holds n2, n3, a credential s4 and n11; f5 holds n6 and f8, which holds n9; n7 is at the top level.
const revision = () => doc(3, 'Old lab',
  folder(1), node(2, { parentId: id(1), order: 0, props: { host: 'a', port: 3389 } }), node(3, { parentId: id(1), order: 1 }), secret(4, { parentId: id(1), order: 2 }), node(11, { parentId: id(1), order: 3 }),
  folder(5, { order: 1 }), node(6, { parentId: id(5), order: 0 }), folder(8, { parentId: id(5), order: 1 }), node(9, { parentId: id(8), order: 0 }),
  node(7, { order: 2 }));
// What it is now: n2 has another host and n3 another name; s4, n6, f8 with n9, and n7 are gone; n11 has another place among its siblings; n10 is new.
const current = () => doc(7, 'Lab',
  folder(1), node(2, { parentId: id(1), order: 0, props: { host: 'b', port: 3389 } }), node(3, { name: 'renamed', parentId: id(1), order: 1 }), node(11, { parentId: id(1), order: 0 }),
  folder(5, { order: 1 }), node(10, { order: 2 }));

test('a revision is compared with the document: what is not there any more, what is different, and how many objects are new', () => {
  assert.deepEqual(compare(current(), revision()), { gone: [id(4), id(6), id(7), id(8), id(9)], changed: [id(2), id(3)], added: 1 }, 'n11 only has another place among its siblings: that is not a difference');
  assert.deepEqual(compare(revision(), revision()), { gone: [], changed: [], added: 0 });
  const retyped = current(), r = revision();
  retyped.objects[id(7)] = node(7, { type: 'credential', order: 2 });
  assert.deepEqual(compare(retyped, r).changed, [id(2), id(3), id(7)], 'another kind of object is a difference');
  const moved = current();
  moved.objects[id(2)] = node(2, { parentId: id(5), order: 0, props: { host: 'a', port: 3389 } });
  assert.ok(compare(moved, r).changed.includes(id(2)), 'so is another folder');
  assert.deepEqual(compare(current(), doc(3, 'Empty')), { gone: [], changed: [], added: 6 });
});

test('an object that is gone is restored into a new folder at the end of the top level, with its own id', () => {
  const now = current(), before = structuredClone(now);
  const applied = restoreObjects(now, revision(), [id(7)], env(), 'Restored');
  const folderId = applied.created!;
  assert.deepEqual(applied.doc.objects[folderId], { id: folderId, type: 'folder', name: 'Restored', parentId: null, order: 3, props: {} }, 'after f1, f5 and n10');
  assert.deepEqual(applied.doc.objects[id(7)], { ...revision().objects[id(7)]!, parentId: folderId, order: 0 });
  assert.deepEqual(applied.change.remove, []);
  assert.deepEqual(applied.change.upsert.map((o) => o.id).sort(), [folderId, id(7)].sort());
  validateDocument(applied.doc);
  assert.deepEqual(now, before, 'the document that was given is as it was');
  assert.equal(applied.doc.revision, now.revision, 'it is an edit like the others: the revision number is for the save to count');
});

test('a folder is restored with everything below it, kinds of objects that the window does not see included, the structure kept; an id that is taken is not used again, and what is below follows', () => {
  const applied = restoreObjects(current(), revision(), [id(1)], env(), 'Restored');
  const folderId = applied.created!, objects = applied.doc.objects;
  const copy = Object.values(objects).filter((o) => o.parentId === folderId);
  assert.equal(copy.length, 1);
  const f1 = copy[0]!;
  assert.deepEqual([f1.type, f1.name, f1.order, f1.id === id(1)], ['folder', 'f1', 0, false], 'f1 is in the document: the copy has another id');
  const kids = Object.values(objects).filter((o) => o.parentId === f1.id).sort((a, b) => a.order - b.order);
  assert.deepEqual(kids.map((o) => [o.name, o.order, o.id === id(Number(o.name.slice(1)))]), [['n2', 0, false], ['n3', 1, false], ['s4', 2, true], ['n11', 3, false]], 's4 is gone: it keeps its id, the others are in the document and do not');
  assert.deepEqual(kids[0]!.props, { host: 'a', port: 3389 }, 'with the properties of the revision, not of the document');
  assert.deepEqual([kids[2]!.type, kids[2]!.props], ['credential', { password: 'pw4' }], 'a credential comes back too: the connections need it');
  assert.equal(Object.keys(objects).length, Object.keys(current().objects).length + 1 + 5);
  assert.equal(applied.change.upsert.length, 6);
  validateDocument(applied.doc);
  const below = restoreObjects(current(), revision(), [id(5)], env(), 'Restored');
  const f5 = Object.values(below.doc.objects).find((o) => o.parentId === below.created)!;
  assert.notEqual(f5.id, id(5), 'f5 is in the document');
  assert.deepEqual(below.doc.objects[id(6)], { ...revision().objects[id(6)]!, parentId: f5.id }, 'n6 is gone: its id is free, its parent is the copy of f5');
  assert.deepEqual([below.doc.objects[id(8)]!.parentId, below.doc.objects[id(9)]!.parentId], [f5.id, id(8)]);
});

test('what is named twice, or is below what is named, is copied once; several are put in the order they were named', () => {
  const once = restoreObjects(current(), revision(), [id(5), id(6), id(8), id(9), id(5)], env(), 'Restored');
  assert.equal(Object.values(once.doc.objects).filter((o) => o.name === 'n6').length, 1);
  assert.equal(Object.keys(once.doc.objects).length, Object.keys(current().objects).length + 1 + 4, 'f5, n6, f8 and n9, and the folder');
  const ordered = restoreObjects(current(), revision(), [id(7), id(6), id(9)], env(), 'Restored');
  const top = Object.values(ordered.doc.objects).filter((o) => o.parentId === ordered.created).sort((a, b) => a.order - b.order);
  assert.deepEqual(top.map((o) => [o.name, o.order, o.parentId === ordered.created]), [['n7', 0, true], ['n6', 1, true], ['n9', 2, true]], 'n6 and n9 were below folders that were not named: they come by themselves, in the order named');
  validateDocument(ordered.doc);
});

test('nothing named, an object that the revision does not have and a name that is not a name are refused, and nothing changes', () => {
  const now = current(), before = structuredClone(now), r = revision();
  assert.throws(() => restoreObjects(now, r, [], env(), 'Restored'), (e: unknown) => e instanceof OpError && e.code === 'unknown-object');
  for (const bad of [id(99), '__proto__', 'constructor', 'toString']) {
    assert.throws(() => restoreObjects(now, r, [id(7), bad], env(), 'Restored'), (e: unknown) => e instanceof OpError && e.code === 'unknown-object', bad);
  }
  assert.throws(() => restoreObjects(now, r, [id(7)], env(), 'x'.repeat(257)), (e: unknown) => e instanceof DocumentError && e.code === 'bad-name');
  assert.deepEqual(now, before);
});

test('a restore that would be too many objects, or nest too deep, is refused', () => {
  const size = Object.keys(current().objects).length;
  assert.throws(() => restoreObjects(current(), revision(), [id(5)], env({ maxObjects: size + 4 }), 'Restored'), (e: unknown) => e instanceof DocumentError && e.code === 'too-many-objects', 'the folder and four objects: five more');
  assert.doesNotThrow(() => restoreObjects(current(), revision(), [id(5)], env({ maxObjects: size + 5 }), 'Restored'));
  assert.throws(() => restoreObjects(current(), revision(), [id(5)], env({ maxDepth: 3 }), 'Restored'), (e: unknown) => e instanceof DocumentError && e.code === 'too-deep', 'the folder, the copy of f5, f8 and n9 make four levels');
  assert.doesNotThrow(() => restoreObjects(current(), revision(), [id(5)], env({ maxDepth: 4 }), 'Restored'));
});

test('the whole document can be made what the revision was: its objects and its name, with the identity and the revision number of the document', () => {
  const now = current(), before = structuredClone(now);
  const all = restoreAll(now, revision());
  assert.deepEqual(all, { ...revision(), id: now.id, kind: now.kind, revision: now.revision });
  assert.equal(all.name, 'Old lab');
  assert.deepEqual(now, before);
  validateDocument(all);
  assert.throws(() => restoreAll(now, { ...revision(), id: id(901) }), (e: unknown) => e instanceof DocumentError && e.code === 'bad-document', 'a revision of another document');
  assert.throws(() => restoreAll(now, { ...revision(), kind: 'vault' }), (e: unknown) => e instanceof DocumentError && e.code === 'bad-document');
});

// A seeded generator (mulberry32) that gives a whole number below `n`.
function prng(seed: number): (n: number) => number {
  let a = seed;
  return (n) => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
}

test('whatever the document and the revision are, a restore keeps everything the document has, copies exactly what was named with everything below it, and is a document (random documents)', () => {
  const random = prng(34);
  const seen = { rounds: 0, copied: 0, kept: 0, fresh: 0, hidden: 0, shapes: new Set<number>() };
  const kids = (d: Doc, parent: string | null) => Object.values(d.objects).filter((o) => o.parentId === parent).sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1)); // the names are different: the copies have other ids
  const shape = (d: Doc, o: ObjectNode): unknown => [o.type, o.name, o.props, kids(d, o.id).map((k) => shape(d, k))];
  const below = (d: Doc, o: ObjectNode): ObjectNode[] => [o, ...kids(d, o.id).flatMap((k) => below(d, k))];
  for (let round = 0; round < 300; round++) {
    const nodes: ObjectNode[] = [folder(1), folder(2, { order: 1 })];
    for (let n = 3; n <= 30; n++) {
      const folders = nodes.filter((o) => o.type === 'folder');
      const kind = random(6) === 0 ? 'credential' : random(3) === 0 ? 'folder' : 'connection';
      nodes.push(node(n, { type: kind, name: `n${n}`, parentId: random(4) === 0 ? null : folders[random(folders.length)]!.id, order: random(4), props: kind === 'credential' ? { password: `s${n}` } : { host: `h${n}` } }));
    }
    const edit = (d: Doc): Doc => {
      let copy = structuredClone(d);
      for (let step = 0, steps = 1 + random(6); step < steps; step++) {
        const o = copy.objects[id(1 + random(30))];
        if (!o) continue;
        if (random(3) === 0) { const doomed = new Set(below(copy, o).map((x) => x.id)); for (const gone of doomed) delete copy.objects[gone]; } else o.name = `${o.name}-${random(2)}`;
      }
      copy.revision++;
      return copy;
    };
    const base = doc(1, 'Lab', ...nodes), old = edit(base), now = edit(base);
    const ids = Object.keys(old.objects);
    if (ids.length === 0) continue;
    const named = Array.from({ length: 1 + random(4) }, () => ids[random(ids.length)]!);
    const before = structuredClone(now);
    const applied = restoreObjects(now, old, named, env(), 'Restored');
    seen.rounds++;
    validateDocument(applied.doc);
    assert.deepEqual(now, before, `round ${round}: the document that was given is as it was`);
    for (const o of Object.values(now.objects)) assert.deepEqual(applied.doc.objects[o.id], o, `round ${round}: everything the document had is as it was`);
    const folderId = applied.created!;
    const top = kids(applied.doc, folderId);
    const named1 = [...new Set(named)].filter((n) => { for (let up = old.objects[n]!.parentId; up !== null; up = old.objects[up]!.parentId) if (named.includes(up)) return false; return true; });
    assert.deepEqual(top.map((o) => shape(applied.doc, o)), named1.map((n) => shape(old, old.objects[n]!)), `round ${round}: what was named is there, in the order named, with everything below it as it was`);
    const wanted = new Set(named1.flatMap((n) => below(old, old.objects[n]!)).map((o) => o.id));
    assert.equal(Object.keys(applied.doc.objects).length, Object.keys(now.objects).length + 1 + wanted.size, `round ${round}: only that is added, and the folder`);
    assert.equal(applied.change.upsert.length, 1 + wanted.size);
    const taken = (n: string) => Object.hasOwn(now.objects, n);
    for (const n of wanted) { if (taken(n)) seen.fresh++; else { seen.kept++; assert.equal(applied.doc.objects[n]?.name, old.objects[n]!.name, `round ${round}: a free id is kept`); } if (old.objects[n]!.type === 'credential') seen.hidden++; }
    seen.copied += wanted.size; seen.shapes.add(named1.length);
    const comparison = compare(now, old);
    assert.deepEqual(comparison.gone, ids.filter((n) => !taken(n)).sort(), `round ${round}: gone is what the document does not have`);
    assert.deepEqual(comparison.changed, ids.filter((n) => taken(n) && (now.objects[n]!.name !== old.objects[n]!.name || now.objects[n]!.parentId !== old.objects[n]!.parentId)).sort(), `round ${round}: changed is what is not the same`);
    assert.equal(comparison.added, Object.keys(now.objects).filter((n) => !Object.hasOwn(old.objects, n)).length);
  }
  assert.ok(seen.rounds >= 250 && seen.copied >= 500 && seen.kept >= 50 && seen.fresh >= 200 && seen.hidden >= 20 && seen.shapes.size >= 3, `the restores are of every kind: ${JSON.stringify({ ...seen, shapes: [...seen.shapes] })}`);
});

test('an id that the document already has is never written over, whatever the generator hands out', () => {
  const now = current(), before = structuredClone(now);
  assert.throws(() => restoreObjects(now, revision(), [id(7)], { newId: () => id(1) }, 'Restored'), (e: unknown) => e instanceof OpError && e.code === 'exists');
  assert.deepEqual(now, before, 'the document is as it was');
});

test('into a document with nothing at the top level the new folder is the first', () => {
  const applied = restoreObjects(doc(1, 'Empty'), revision(), [id(7)], env(), 'Restored');
  assert.equal(applied.doc.objects[applied.created!]!.order, 0);
});

test('a copy owns its properties: what is done to them does not reach the revision', () => {
  const rev = revision();
  const applied = restoreObjects(current(), rev, [id(2)], env(), 'Restored');
  const copy = applied.change.upsert.find((o) => o.name === 'n2' && o.id !== id(2))!;
  assert.notEqual(copy.props, rev.objects[id(2)]!.props);
  copy.props.host = 'changed';
  assert.equal(rev.objects[id(2)]!.props.host, 'a');
});

test('what is different is told in the order of the ids, whatever order the revision keeps its objects in', () => {
  const rev = doc(1, 'r', node(5, { name: 'x' }), node(2, { name: 'y' }), node(9, { name: 'z' }), node(1, { name: 'w' }));
  const now = doc(1, 'n', node(5, { name: 'x2' }), node(2, { name: 'y2' }));
  assert.deepEqual(compare(now, rev), { gone: [id(1), id(9)], changed: [id(2), id(5)], added: 0 });
});

test('without limits given, those of the model apply: a restore that would pass the number of objects, or nest deeper than the folders may, is refused', () => {
  const many = doc(1, 'Many', ...Array.from({ length: LIMITS.maxObjects }, (_, i) => node(i + 1000)));
  assert.throws(() => restoreObjects(many, revision(), [id(7)], env(), 'R'), (e: unknown) => e instanceof DocumentError && e.code === 'too-many-objects');
  const chain = doc(1, 'Chain', ...Array.from({ length: LIMITS.maxDepth }, (_, i) => folder(i + 1, { parentId: i === 0 ? null : id(i), order: 0 })));
  assert.throws(() => restoreObjects(doc(2, 'Empty'), chain, [id(1)], env(), 'R'), (e: unknown) => e instanceof DocumentError && e.code === 'too-deep');
});

test('a generator that hands out the same id twice is refused, not silently written over', () => {
  const same: Env = { newId: () => 'ffffffff-0000-4000-8000-000000000001' };
  assert.throws(() => restoreObjects(current(), revision(), [id(2), id(3)], same, 'R'), (e: unknown) => e instanceof OpError && e.code === 'exists');
});

test('the new folder ends the top level: its place is the one after the last place at the top level, not after the highest place anywhere', () => {
  const now = doc(1, 'Lab', node(1, { order: 1 }), folder(2, { order: 0 }), node(3, { parentId: id(2), order: 9 }));
  const applied = restoreObjects(now, revision(), [id(7)], env(), 'Restored');
  assert.equal(applied.doc.objects[applied.created!]!.order, 2, 'the top level has the places 0 and 1: the next is 2, though a folder holds an object at 9');
});
