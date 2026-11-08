import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictError, choicesOf, describe, keyOf, prune, resolveConflict, resolveMany, sideChoice, sideItems, type Choice, type ConflictView } from '../src/documents/conflicts.js';
import { merge3, type Conflict } from '../src/documents/merge.js';
import { DocumentError, validateDocument, type Doc, type Json, type ObjectNode } from '../src/documents/model.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const folder = (n: number, over: Partial<ObjectNode> = {}) => node(n, { type: 'folder', name: `f${n}`, ...over });
const doc = (...nodes: ObjectNode[]): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'Lab', revision: 5, objects: Object.fromEntries(nodes.map((o) => [o.id, o])) });
const changed = (d: Doc, n: number, change: (o: ObjectNode) => void): Doc => { const copy = structuredClone(d); change(copy.objects[id(n)]!); copy.revision++; return copy; };
const without = (d: Doc, ...ns: number[]): Doc => { const copy = structuredClone(d); for (const n of ns) delete copy.objects[id(n)]; copy.revision++; return copy; };
/** What removing an object does in the application: it and everything below it. */
const withoutTree = (d: Doc, n: number): Doc => {
  const doomed = new Set([id(n)]);
  for (let grew = true; grew;) { grew = false; for (const o of Object.values(d.objects)) if (o.parentId !== null && doomed.has(o.parentId) && !doomed.has(o.id)) { doomed.add(o.id); grew = true; } }
  const copy = structuredClone(d);
  for (const gone of doomed) delete copy.objects[gone];
  copy.revision++;
  return copy;
};
const joined = (d: Doc, ...nodes: ObjectNode[]): Doc => { const copy = structuredClone(d); for (const o of nodes) copy.objects[o.id] = o; copy.revision++; return copy; };
/** The merge of two edited copies, as the session holds it when a save is held back: the merged document and what is still to be decided. */
const held = (base: Doc, mine: Doc, theirs: Doc) => merge3(base, mine, theirs);
type FieldView = Extract<ConflictView, { kind: 'field' }>;

// f1 holds the connections n2 (host a, port 3389) and n3; f4 holds n5; n6 is at the top level.
const base = () => doc(folder(1), node(2, { parentId: id(1), order: 0, props: { host: 'a', port: 3389 } }), node(3, { parentId: id(1), order: 1 }), folder(4, { order: 1 }), node(5, { parentId: id(4), order: 0 }), node(6, { order: 2 }));

test('every conflict has a key that tells it from the others of the same merge, is the same each time, says nothing about the objects, and has a form the main process can check', () => {
  const b = base();
  const mine = changed(changed(changed(b, 2, (o) => { o.props.host = 'mine'; o.props.port = 1; o.name = 'mine name'; }), 3, (o) => { o.name = 'mine 3'; }), 6, (o) => { o.props.notes = 'x'; });
  const theirs = changed(changed(changed(changed(b, 2, (o) => { o.props.host = 'theirs'; o.props.port = 2; o.name = 'their name'; }), 3, (o) => { o.name = 'their 3'; }), 5, (o) => { o.name = 'edited'; }), 6, (o) => { o.props.notes = 'y'; });
  const { conflicts } = held(b, without(mine, 5), theirs);
  const keys = conflicts.map(keyOf);
  assert.equal(conflicts.length, 6, `five fields and a delete-edit: ${JSON.stringify(conflicts.map((c) => c.kind))}`);
  assert.equal(new Set(keys).size, keys.length, 'no two conflicts share a key');
  assert.deepEqual(conflicts.map(keyOf), keys, 'and the key of a conflict is the same each time');
  for (const key of keys) assert.match(key, /^c-[0-9a-f]{16}$/, key);
  const text = keys.join();
  for (const n of [2, 3, 5, 6]) assert.equal(text.includes(id(n).slice(-6)) || text.includes(`props.`), false, 'no id and no name of a field in a key: the window is not told what the object is');
  const two = doc(folder(1), folder(2));
  const cycle = held(two, changed(two, 1, (o) => { o.parentId = id(2); }), changed(two, 2, (o) => { o.parentId = id(1); })).conflicts;
  assert.equal(cycle.length, 1);
  assert.match(keyOf(cycle[0]!), /^c-[0-9a-f]{16}$/);
  const ids = { kind: 'cycle', ids: [id(2), id(1)] } as Conflict, same = { kind: 'cycle', ids: [id(1), id(2)] } as Conflict;
  assert.equal(keyOf(ids), keyOf(same), 'a cycle is the same cycle whichever folder is named first');
  assert.notEqual(keyOf({ kind: 'field', id: id(2), field: 'name', base: 'a', mine: 'b', theirs: 'c' }), keyOf({ kind: 'field', id: id(2), field: 'props.name', base: 'a', mine: 'b', theirs: 'c' }), 'another field of the same object is another conflict');
  assert.notEqual(keyOf({ kind: 'delete-edit', id: id(2), deletedBy: 'mine' }), keyOf({ kind: 'orphan', id: id(2), parentId: id(1) }), 'and so is another kind');
  const docName = held(b, { ...b, name: 'mine' }, { ...b, name: 'theirs', revision: 6 }).conflicts;
  assert.equal(docName.length, 1, 'the name of the document is a conflict like any other field');
  assert.deepEqual(held(b, changed(b, 6, (o) => { o.name = 'x'; }), b).conflicts, [], 'what one side alone changed is not one');
});

test('a field conflict is shown with the name of the object, what the field is and what each side holds', () => {
  const b = base();
  const { merged, conflicts } = held(b, changed(b, 2, (o) => { o.props.host = 'mine.example'; o.props.port = 4000; }), changed(b, 2, (o) => { o.props.host = 'theirs.example'; o.props.port = 5000; }));
  const views = describe(merged, conflicts) as FieldView[];
  assert.equal(views.length, 2);
  const hostConflict = conflicts.find((c) => c.kind === 'field' && c.field === 'props.host')!;
  const host = views.find((v) => v.property === 'host')!;
  assert.deepEqual(host, { key: keyOf(hostConflict), kind: 'field', choices: ['mine', 'theirs'], object: 'n2', objectType: 'connection', field: 'props.host', what: 'property', property: 'host', base: { text: 'a' }, mine: { text: 'mine.example' }, theirs: { text: 'theirs.example' } });
  const port = views.find((v) => v.property === 'port')!;
  assert.deepEqual([port.base, port.mine, port.theirs], [{ text: '3389', json: 'number' }, { text: '4000', json: 'number' }, { text: '5000', json: 'number' }], 'a number is shown as the number, and says that it is one');
  const noted = held(b, changed(b, 2, (o) => { o.props.notes = 'mine'; }), changed(b, 2, (o) => { o.props.notes = 'theirs'; }));
  const [added] = describe(noted.merged, noted.conflicts) as FieldView[];
  assert.deepEqual(added!.base, { text: '', none: true }, 'a property that neither side had before is shown as not there');
  const renamed = held(b, changed(b, 1, (o) => { o.name = 'mine folder'; }), changed(b, 1, (o) => { o.name = 'their folder'; }));
  const [name] = describe(renamed.merged, renamed.conflicts) as FieldView[];
  assert.deepEqual([name!.what, name!.objectType, name!.object, name!.mine, name!.theirs], ['name', 'folder', 'mine folder', { text: 'mine folder' }, { text: 'their folder' }], 'the object is named as the document holds it now: mine, until it is decided');
  const titled = held(b, { ...b, name: 'My lab' }, { ...b, name: 'Their lab', revision: 6 });
  const [docName] = describe(titled.merged, titled.conflicts) as FieldView[];
  assert.deepEqual([docName!.what, docName!.objectType, docName!.object, docName!.mine, docName!.theirs], ['document-name', 'document', 'My lab', { text: 'My lab' }, { text: 'Their lab' }]);
});

test('the parent of an object is shown by the name of the folder, "top" for the top level and "gone" for a folder that is not there', () => {
  const b = base();
  const { merged, conflicts } = held(b, changed(b, 3, (o) => { o.parentId = id(4); }), changed(b, 3, (o) => { o.parentId = null; }));
  const [view] = describe(merged, conflicts) as FieldView[];
  assert.deepEqual([view!.what, view!.base, view!.mine, view!.theirs], ['parent', { text: 'f1' }, { text: 'f4' }, { text: '', top: true }]);
  const dangling = describe(merged, [{ kind: 'field', id: id(3), field: 'parentId', base: id(1), mine: id(99), theirs: id(4) }]) as FieldView[];
  assert.deepEqual([dangling[0]!.mine, dangling[0]!.theirs], [{ text: '', gone: true }, { text: 'f4' }], 'a folder that is not in the document is not named');
  const lost = held(b, without(b, 4, 5), changed(b, 3, (o) => { o.parentId = id(4); }));
  assert.deepEqual(lost.conflicts.map((c) => c.kind), ['orphan'], 'the other side moved it into a folder that this side deleted');
});

test('a delete-edit, an orphan and a cycle are shown by name, with what each side did', () => {
  const b = base();
  const deleteEdit = held(b, without(b, 6), changed(b, 6, (o) => { o.name = 'edited'; }));
  assert.deepEqual(describe(deleteEdit.merged, deleteEdit.conflicts), [{ key: keyOf(deleteEdit.conflicts[0]!), kind: 'delete-edit', choices: ['keep', 'delete'], object: 'edited', objectType: 'connection', deletedBy: 'mine', below: 0 }]);
  const theirDelete = held(b, changed(b, 6, (o) => { o.name = 'mine edit'; }), without(b, 6));
  assert.equal((describe(theirDelete.merged, theirDelete.conflicts)[0] as { deletedBy: string }).deletedBy, 'theirs');
  const orphan = held(b, joined(b, node(10, { parentId: id(1), order: 5 })), without(b, 1, 2, 3));
  assert.deepEqual(describe(orphan.merged, orphan.conflicts), [{ key: keyOf(orphan.conflicts[0]!), kind: 'orphan', choices: ['keep', 'delete'], object: 'n10', objectType: 'connection', below: 0 }]);
  const two = doc(folder(1), folder(2), folder(3));
  const cycle = held(two, changed(two, 1, (o) => { o.parentId = id(2); }), changed(two, 2, (o) => { o.parentId = id(1); }));
  assert.deepEqual(describe(cycle.merged, cycle.conflicts), [{ key: keyOf(cycle.conflicts[0]!), kind: 'cycle', choices: ['accept'], objects: ['f1', 'f2'], total: 2 }]);
});

test('what belongs to an object of a kind the window never sees is not described: no name, no value, no id, only that there is a conflict and what can be chosen', () => {
  const secret = (over: Partial<ObjectNode> = {}) => node(7, { type: 'credential', name: 'SECRET-NAME', props: { password: 'SECRET-VALUE' }, ...over });
  const b = doc(folder(1), secret());
  const field = held(b, changed(b, 7, (o) => { o.props.password = 'MINE-SECRET'; }), changed(b, 7, (o) => { o.props.password = 'THEIR-SECRET'; }));
  assert.deepEqual(describe(field.merged, field.conflicts), [{ key: keyOf(field.conflicts[0]!), kind: 'hidden', of: 'field', choices: ['mine', 'theirs'] }]);
  const deleted = held(b, without(b, 7), changed(b, 7, (o) => { o.name = 'THEIR-NAME'; }));
  const orphan = held(b, joined(b, secret({ id: id(8), parentId: id(1) })), without(b, 1));
  for (const result of [field, deleted, orphan]) {
    const text = JSON.stringify(describe(result.merged, result.conflicts));
    for (const leak of ['SECRET', 'THEIR-NAME', 'MINE', id(7), id(8)]) assert.equal(text.includes(leak), false, `${leak} does not appear: ${text}`);
  }
  assert.deepEqual(describe(deleted.merged, deleted.conflicts).map((v) => [v.kind, (v as { of?: string }).of, v.choices]), [['hidden', 'delete-edit', ['keep', 'delete']]]);
  assert.deepEqual(describe(orphan.merged, orphan.conflicts).map((v) => [v.kind, (v as { of?: string }).of, v.choices]), [['hidden', 'orphan', ['keep', 'delete']]]);
});

test('a public notes value is cut at 400 characters without splitting a character, and says that it was cut', () => {
  const b = base();
  const long = 'x'.repeat(500), pair = '\u{1F600}'.repeat(300);
  const text = held(b, changed(b, 2, (o) => { o.props.notes = long; }), changed(b, 2, (o) => { o.props.notes = 'short'; }));
  const [note] = describe(text.merged, text.conflicts) as FieldView[];
  assert.deepEqual([note!.mine.text.length, note!.mine.cut, note!.theirs], [400, true, { text: 'short' }]);
  const unicode = held(b, changed(b, 3, (o) => { o.props.notes = pair; }), changed(b, 3, (o) => { o.props.notes = 'short'; }));
  const [tip] = describe(unicode.merged, unicode.conflicts) as FieldView[];
  assert.equal(tip!.mine.cut, true);
  assert.equal(tip!.mine.text.length % 2, 0, 'a character of two units is kept whole or dropped');
  assert.doesNotMatch(tip!.mine.text, /[\ud800-\udbff]$/, 'and the cut never ends in half of one');
  const exact = held(b, changed(b, 2, (o) => { o.props.notes = 'y'.repeat(400); }), changed(b, 2, (o) => { o.props.notes = 'z'; }));
  assert.equal((describe(exact.merged, exact.conflicts)[0] as FieldView).mine.cut, undefined, 'exactly 400 is not cut');
  const structured = held(b, changed(b, 1, (o) => { o.props.sort = [{ by: 'name', dir: 'asc' }]; }), changed(b, 1, (o) => { o.props.sort = [{ by: 'type', dir: 'desc' }]; }));
  const [sort] = describe(structured.merged, structured.conflicts) as FieldView[];
  assert.deepEqual([sort!.mine, sort!.theirs], [{ text: '[{"by":"name","dir":"asc"}]', json: 'array' }, { text: '[{"by":"type","dir":"desc"}]', json: 'array' }], 'valid typed sort arrays retain their JSON presentation');
});

test('what can be chosen depends on the kind of the conflict, and a choice that does not belong to it is refused', () => {
  const field: Conflict = { kind: 'field', id: id(2), field: 'name', base: 'a', mine: 'b', theirs: 'c' };
  const deleteEdit: Conflict = { kind: 'delete-edit', id: id(2), deletedBy: 'mine' }, orphan: Conflict = { kind: 'orphan', id: id(2), parentId: id(1) }, cycle: Conflict = { kind: 'cycle', ids: [id(1), id(2)] };
  assert.deepEqual([choicesOf(field), choicesOf(deleteEdit), choicesOf(orphan), choicesOf(cycle)], [['mine', 'theirs'], ['keep', 'delete'], ['keep', 'delete'], ['accept']]);
  const d = base();
  for (const [conflict, bad] of [[field, 'keep'], [field, 'accept'], [deleteEdit, 'mine'], [orphan, 'theirs'], [cycle, 'delete'], [cycle, 'mine']] as const) {
    assert.throws(() => resolveConflict(d, conflict, bad), (e: unknown) => e instanceof ConflictError && e.code === 'bad-choice', `${conflict.kind} refuses ${bad}`);
  }
  assert.throws(() => resolveConflict(d, field, 'nope' as Choice), ConflictError);
  assert.throws(() => resolveConflict(d, field, '__proto__' as Choice), ConflictError);
});

test('"mine" leaves what the document holds, "theirs" puts their value in: for a name, a property, a property they removed and the name of the document', () => {
  const b = base();
  const r = held(b, changed(b, 2, (o) => { o.props.host = 'mine'; o.name = 'my name'; }), changed(b, 2, (o) => { o.props.host = 'theirs'; o.name = 'their name'; }));
  const name = r.conflicts.find((c) => c.kind === 'field' && c.field === 'name')!, host = r.conflicts.find((c) => c.kind === 'field' && c.field === 'props.host')!;
  assert.deepEqual(resolveConflict(r.merged, host, 'mine'), r.merged, 'mine: the document as it is');
  const theirs = resolveConflict(r.merged, host, 'theirs');
  assert.deepEqual([theirs.objects[id(2)]!.props.host, theirs.objects[id(2)]!.name], ['theirs', 'my name'], 'theirs changes that field only');
  assert.equal(resolveConflict(r.merged, name, 'theirs').objects[id(2)]!.name, 'their name');
  assert.equal(r.merged.objects[id(2)]!.props.host, 'mine', 'and the document that was given is not changed');
  const removedHere = held(b, changed(b, 2, (o) => { delete o.props.port; }), changed(b, 2, (o) => { o.props.port = 1; }));
  assert.equal(Object.hasOwn(resolveConflict(removedHere.merged, removedHere.conflicts[0]!, 'mine').objects[id(2)]!.props, 'port'), false, 'a property that this side removed stays removed');
  const removedThere = held(b, changed(b, 2, (o) => { o.props.port = 1; }), changed(b, 2, (o) => { delete o.props.port; }));
  assert.equal(Object.hasOwn(resolveConflict(removedThere.merged, removedThere.conflicts[0]!, 'theirs').objects[id(2)]!.props, 'port'), false, 'and one that they removed is removed');
  const titled = held(b, { ...b, name: 'mine' }, { ...b, name: 'theirs', revision: 6 });
  assert.equal(resolveConflict(titled.merged, titled.conflicts[0]!, 'theirs').name, 'theirs');
});

test('a delete-edit and an orphan are kept or deleted with everything below them; a cycle is only accepted', () => {
  const b = base();
  const edited = held(b, without(b, 4, 5), changed(b, 5, (o) => { o.name = 'edited'; }));
  const [edit] = edited.conflicts;
  assert.equal(resolveConflict(edited.merged, edit!, 'keep').objects[id(5)]!.name, 'edited', 'keep: the object stays');
  const gone = resolveConflict(edited.merged, edit!, 'delete');
  assert.equal(Object.hasOwn(gone.objects, id(5)), false, 'delete: it goes');
  assert.ok(Object.hasOwn(gone.objects, id(2)), 'and nothing else');
  validateDocument(gone);
  const orphan = held(b, joined(b, folder(10, { parentId: id(1), order: 5 }), node(11, { parentId: id(10), order: 0 })), without(b, 1, 2, 3));
  assert.equal(orphan.merged.objects[id(10)]!.parentId, null);
  const [lost] = orphan.conflicts;
  assert.equal(resolveConflict(orphan.merged, lost!, 'keep').objects[id(10)]!.parentId, null);
  const without10 = resolveConflict(orphan.merged, lost!, 'delete');
  assert.deepEqual([Object.hasOwn(without10.objects, id(10)), Object.hasOwn(without10.objects, id(11))], [false, false], 'an orphan that is a folder takes what is in it');
  const two = doc(folder(1), folder(2));
  const cycle = held(two, changed(two, 1, (o) => { o.parentId = id(2); }), changed(two, 2, (o) => { o.parentId = id(1); }));
  assert.deepEqual(resolveConflict(cycle.merged, cycle.conflicts[0]!, 'accept'), cycle.merged);
  assert.deepEqual(resolveConflict(b, { kind: 'delete-edit', id: id(99), deletedBy: 'mine' }, 'delete'), b, 'an object that is not there is nothing to delete');
});

test('a choice that would make the document invalid is refused and changes nothing: their parent can be a folder that this side deleted', () => {
  const b = doc(folder(1), folder(2), node(3, { parentId: id(1) }), folder(4, { order: 1 }));
  const r = held(b, changed(without(b, 2), 3, (o) => { o.parentId = id(4); }), changed(b, 3, (o) => { o.parentId = id(2); }));
  assert.deepEqual(r.conflicts.map((c) => c.kind), ['field'], 'they moved it into f2, this side moved it into f4 and deleted f2');
  const before = structuredClone(r.merged);
  assert.throws(() => resolveConflict(r.merged, r.conflicts[0]!, 'theirs'), (e: unknown) => e instanceof DocumentError && e.code === 'bad-parent');
  assert.deepEqual(r.merged, before, 'the document is as it was');
  assert.equal(resolveConflict(r.merged, r.conflicts[0]!, 'mine').objects[id(3)]!.parentId, id(4), 'and mine is always possible');
  assert.throws(() => resolveMany(r.merged, r.conflicts, [{ key: keyOf(r.conflicts[0]!), choice: 'theirs' }]), DocumentError, 'a set of choices has the same refusal');
});

test('"mine" and "theirs" for everything: a field is that side\'s, a delete-edit follows who deleted, and an orphan and a cycle stay as the merge made them', () => {
  const field: Conflict = { kind: 'field', id: id(2), field: 'name', base: 'a', mine: 'b', theirs: 'c' };
  assert.deepEqual([sideChoice(field, 'mine'), sideChoice(field, 'theirs')], ['mine', 'theirs']);
  const mineDeleted: Conflict = { kind: 'delete-edit', id: id(2), deletedBy: 'mine' }, theirsDeleted: Conflict = { kind: 'delete-edit', id: id(2), deletedBy: 'theirs' };
  assert.deepEqual([sideChoice(mineDeleted, 'mine'), sideChoice(mineDeleted, 'theirs')], ['delete', 'keep'], 'I deleted it and they edited it: mine is the delete, theirs the edit');
  assert.deepEqual([sideChoice(theirsDeleted, 'mine'), sideChoice(theirsDeleted, 'theirs')], ['keep', 'delete'], 'they deleted it and I edited it');
  const orphan: Conflict = { kind: 'orphan', id: id(2), parentId: id(1) }, cycle: Conflict = { kind: 'cycle', ids: [id(1), id(2)] };
  assert.deepEqual([sideChoice(orphan, 'mine'), sideChoice(orphan, 'theirs'), sideChoice(cycle, 'mine'), sideChoice(cycle, 'theirs')], ['keep', 'keep', 'accept', 'accept']);
});

test('several choices are made together or not at all, an unknown key or two choices for one conflict are refused, and what is not chosen is still to be decided', () => {
  const b = base();
  const r = held(b, without(changed(b, 2, (o) => { o.props.host = 'mine'; o.props.port = 1; }), 6), changed(changed(b, 2, (o) => { o.props.host = 'theirs'; o.props.port = 2; }), 6, (o) => { o.name = 'edited'; }));
  assert.equal(r.conflicts.length, 3, 'two fields of n2 and the delete-edit of n6');
  const keyOfField = (field: string) => keyOf(r.conflicts.find((c) => c.kind === 'field' && c.field === field)!), deleteKey = keyOf(r.conflicts.find((c) => c.kind === 'delete-edit')!);
  const some = resolveMany(r.merged, r.conflicts, [{ key: keyOfField('props.host'), choice: 'theirs' }, { key: deleteKey, choice: 'keep' }]);
  assert.deepEqual([some.doc.objects[id(2)]!.props.host, some.doc.objects[id(2)]!.props.port, some.conflicts.map(keyOf)], ['theirs', 1, [keyOfField('props.port')]], 'the port was not chosen: it is still to be decided, and still mine');
  const all = resolveMany(r.merged, r.conflicts, r.conflicts.map((c) => ({ key: keyOf(c), choice: sideChoice(c, 'theirs') })));
  assert.deepEqual([all.conflicts, all.doc.objects[id(2)]!.props.port, Object.hasOwn(all.doc.objects, id(6)), all.doc.objects[id(6)]?.name], [[], 2, true, 'edited'], 'everything for theirs: they edited n6 and I deleted it, so their edit stays');
  const bulkMine = resolveMany(r.merged, r.conflicts, r.conflicts.map((c) => ({ key: keyOf(c), choice: sideChoice(c, 'mine') })));
  assert.deepEqual([bulkMine.conflicts, bulkMine.doc.objects[id(2)]!.props.port, Object.hasOwn(bulkMine.doc.objects, id(6))], [[], 1, false], 'everything for mine: I deleted n6');
  assert.throws(() => resolveMany(r.merged, r.conflicts, [{ key: deleteKey, choice: 'keep' }, { key: 'c-0000000000000000', choice: 'mine' }]), (e: unknown) => e instanceof ConflictError && e.code === 'unknown-conflict');
  assert.throws(() => resolveMany(r.merged, r.conflicts, [{ key: deleteKey, choice: 'keep' }, { key: deleteKey, choice: 'delete' }]), (e: unknown) => e instanceof ConflictError && e.code === 'bad-choice');
  assert.throws(() => resolveMany(r.merged, r.conflicts, [{ key: keyOfField('props.host'), choice: 'mine' }, { key: deleteKey, choice: 'mine' }]), ConflictError, 'one bad choice among good ones refuses all');
  assert.equal(r.merged.objects[id(2)]!.props.host, 'mine', 'and the document that was given is as it was');
});

test('a choice that deletes an object takes the conflicts about it, and about what was below it, with it; a cycle goes when one of its folders does', () => {
  const b = doc(folder(1), node(2, { parentId: id(1), props: { host: 'a' } }), folder(3, { order: 1 }), node(4, { parentId: id(3) }));
  const field: Conflict = { kind: 'field', id: id(4), field: 'name', base: 'n4', mine: 'x', theirs: 'y' };
  const deleteEdit: Conflict = { kind: 'delete-edit', id: id(3), deletedBy: 'mine' };
  const other: Conflict = { kind: 'field', id: id(2), field: 'props.host', base: 'a', mine: 'b', theirs: 'c' };
  const result = resolveMany(b, [other, field, deleteEdit], [{ key: keyOf(deleteEdit), choice: 'delete' }, { key: keyOf(field), choice: 'theirs' }]);
  assert.deepEqual(result.conflicts.map(keyOf), [keyOf(other)], 'n4 went with f3: choosing for its field afterwards is not an error, and nothing is left about it');
  assert.equal(Object.hasOwn(result.doc.objects, id(4)), false);
  assert.deepEqual(prune(without(b, 4), [field, other]).map(keyOf), [keyOf(other)], 'the conflict of an object that is gone is dropped');
  const cycle: Conflict = { kind: 'cycle', ids: [id(1), id(3)] };
  assert.deepEqual(prune(b, [cycle]).map(keyOf), [keyOf(cycle)], 'a cycle of folders that are all there stays');
  assert.deepEqual(prune(without(b, 3, 4), [cycle]), [], 'and goes when one of them is gone');
  const name: Conflict = { kind: 'field', id: id(900), field: 'document.name', base: 'a', mine: 'b', theirs: 'c' };
  assert.equal(prune(b, [name]).length, 1, 'the name of the document is always there');
  assert.deepEqual(prune(b, [deleteEdit, { kind: 'orphan', id: id(98), parentId: id(1) }]).map((c) => c.kind), ['delete-edit'], 'an orphan that is not there is dropped');
});

// A seeded generator (mulberry32) that gives a whole number below `n`.
function prng(seed: number): (n: number) => number {
  let a = seed;
  return (n) => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
}

test('whatever two people did to a document, every conflict can be decided, whichever way, and the document stays valid with nothing left to decide (random documents)', () => {
  const random = prng(21);
  const seen = { rounds: 0, conflicts: 0, kinds: new Set<string>(), fields: new Set<string>(), refused: 0, hidden: 0, theirs: 0 };
  for (let round = 0; round < 500; round++) {
    const nodes: ObjectNode[] = [folder(1), folder(2, { order: 1 })];
    for (let n = 3; n <= 24; n++) {
      const parents = nodes.filter((o) => o.type === 'folder');
      const type = random(6) === 0 ? 'credential' : random(3) === 0 ? 'folder' : 'connection';
      nodes.push(node(n, { type, name: `n${n}`, parentId: random(4) === 0 ? null : parents[random(parents.length)]!.id, order: random(5), props: type === 'credential' ? { password: `s${n}` } : { host: `h${n}`, port: 3389 } }));
    }
    const b = doc(...nodes);
    const hot = [1, 2, 3 + random(22), 3 + random(22), 3 + random(22)]; // two people meet at a few objects
    const side = (): Doc => {
      let d = b;
      for (let step = 0, steps = 4 + random(9); step < steps; step++) {
        const n = random(5) < 4 ? hot[random(hot.length)]! : 1 + random(24), o = d.objects[id(n)];
        if (!o) continue;
        switch (random(10)) {
          case 0: d = withoutTree(d, n); break;
          case 1: case 2: d = changed(d, n, (x) => { x.name = `${x.name}-${random(3)}`; }); break;
          case 3: d = changed(d, n, (x) => { x.props.host = `host-${random(3)}`; }); break;
          case 4: d = changed(d, n, (x) => { x.props.port = 1000 + random(3); }); break;
          case 5: case 6: { const targets = Object.values(d.objects).filter((p) => p.type === 'folder' && p.id !== o.id); const to = targets[random(targets.length + 1)]; d = changed(d, n, (x) => { x.parentId = to ? to.id : null; }); break; }
          case 7: d = changed(d, n, (x) => { if (x.type === 'credential') x.props.password = `p-${random(3)}`; else x.props.notes = `r-${random(3)}`; }); break;
          default: d = joined(d, node(30 + random(40), { parentId: random(2) ? null : id(1 + random(2)), order: 9 }));
        }
      }
      return d;
    };
    let mine: Doc, theirs: Doc, result: ReturnType<typeof held>;
    try { mine = side(); theirs = side(); result = held(b, mine, theirs); } catch (error) { if (error instanceof DocumentError) continue; throw error; } // two sides whose merge is not a document at all are not what is under test
    const { merged, conflicts } = result;
    seen.rounds++; seen.conflicts += conflicts.length;
    for (const c of conflicts) { seen.kinds.add(c.kind); if (c.kind === 'field') seen.fields.add(c.field.split('.')[0]!); }
    const views = describe(merged, conflicts);
    assert.equal(views.length, conflicts.length, `round ${round}: one view for each`);
    conflicts.forEach((c, i) => {
      const target = c.kind === 'cycle' ? undefined : merged.objects[c.id];
      const hidden = target !== undefined && target.type !== 'folder' && target.type !== 'connection';
      assert.equal(views[i]!.kind === 'hidden', hidden, `round ${round}: only what belongs to a hidden kind is hidden (${c.kind})`);
      assert.deepEqual(views[i]!.choices, choicesOf(c));
      assert.equal(views[i]!.key, keyOf(c));
      seen.hidden += hidden ? 1 : 0;
    });
    assert.doesNotMatch(JSON.stringify(views), /password|"s\d+"|"p-\d"/, `round ${round}: no secret in what the window is told`);
    const pick = random(3);
    const items = conflicts.map((c) => ({ key: keyOf(c), choice: pick === 2 ? choicesOf(c)[random(choicesOf(c).length)]! : sideChoice(c, pick === 0 ? 'mine' : 'theirs') }));
    const before = structuredClone(merged);
    let resolved: { doc: Doc; conflicts: Conflict[] };
    try { resolved = resolveMany(merged, conflicts, items); } catch (error) { // a choice that makes the document invalid is refused whole
      if (!(error instanceof DocumentError)) throw error;
      seen.refused++;
      assert.deepEqual(merged, before, `round ${round}: choices that are refused change nothing`);
      continue;
    }
    assert.deepEqual(resolved.conflicts, [], `round ${round}: nothing is left to decide`);
    validateDocument(resolved.doc);
    if (pick === 0) assert.ok(Object.keys(resolved.doc.objects).length <= Object.keys(merged.objects).length, `round ${round}: "mine" for all only ever deletes what this side deleted`);
    if (pick === 1) {
      for (const c of conflicts) {
        const there = c.kind === 'field' ? resolved.doc.objects[c.id] : undefined;
        if (c.kind !== 'field' || !there || !(c.field === 'name' || c.field.startsWith('props.'))) continue;
        seen.theirs++;
        assert.deepEqual((c.field === 'name' ? there.name : there.props[c.field.slice(6)]) as Json | undefined, c.theirs, `round ${round}: ${c.field} is theirs`);
      }
    }
    assert.deepEqual(merged, before, `round ${round}: nothing above changed the document that was given`);
  }
  assert.ok(seen.rounds >= 300 && seen.conflicts >= 600 && seen.kinds.size === 4 && seen.fields.has('props') && seen.fields.has('name') && seen.fields.has('parentId') && seen.hidden >= 30 && seen.theirs >= 30 && seen.refused >= 1, `the documents have conflicts of every kind: ${JSON.stringify({ ...seen, kinds: [...seen.kinds], fields: [...seen.fields] })}`);
});

test('"theirs for everything" puts an object where they put it before anything is deleted: what they moved out of a folder they deleted is not deleted with it', () => {
  // f1 holds n4. They deleted f2 and moved n4 into f3; here f2 was renamed and n4 was moved into it.
  const b = doc(folder(1), folder(2, { order: 1 }), folder(3, { order: 2 }), node(4, { parentId: id(1), order: 0 }));
  const r = held(b, changed(changed(b, 2, (o) => { o.name = 'f2 mine'; }), 4, (o) => { o.parentId = id(2); }), changed(without(b, 2), 4, (o) => { o.parentId = id(3); }));
  assert.deepEqual(r.conflicts.map((c) => c.kind).sort(), ['delete-edit', 'field']);
  const out = resolveMany(r.merged, r.conflicts, r.conflicts.map((c) => ({ key: keyOf(c), choice: sideChoice(c, 'theirs') })));
  assert.equal(Object.hasOwn(out.doc.objects, id(2)), false, 'the folder they deleted is deleted');
  assert.equal(out.doc.objects[id(4)]?.parentId, id(3), 'and the connection they moved into f3 is in f3');
  assert.deepEqual(out.conflicts, []);
  const mine = resolveMany(r.merged, r.conflicts, r.conflicts.map((c) => ({ key: keyOf(c), choice: sideChoice(c, 'mine') })));
  assert.deepEqual([mine.doc.objects[id(2)]?.name, mine.doc.objects[id(4)]?.parentId], ['f2 mine', id(2)], '"mine for everything" is what the merge made');
  const one = resolveMany(r.merged, r.conflicts, [{ key: keyOf(r.conflicts.find((c) => c.kind === 'delete-edit')!), choice: 'delete' }]);
  assert.equal(Object.hasOwn(one.doc.objects, id(4)), false, 'n4 is in f2 here: deleting f2 alone deletes what is in it');
});

test('an object that was kept on purpose stays when the folder it is in is deleted: it goes to the top level, with what is below it', () => {
  const b = doc(folder(1), node(2, { parentId: id(1), order: 0 }), folder(3, { parentId: id(1), order: 1 }), node(4, { parentId: id(3), order: 0 }), node(5, { order: 1 }));
  const mine = changed(changed(changed(changed(b, 1, (o) => { o.name = 'F mine'; }), 2, (o) => { o.name = 'C mine'; }), 3, (o) => { o.name = 'G mine'; }), 4, (o) => { o.name = 'D mine'; });
  const r = held(b, mine, withoutTree(b, 1));
  assert.deepEqual(r.conflicts.map((c) => [c.kind, (c as { id?: string }).id]).sort(), [['delete-edit', id(1)], ['delete-edit', id(2)], ['delete-edit', id(3)], ['delete-edit', id(4)]], 'they deleted f1 and all that was in it; the four that were edited here are kept for now');
  const pick = (n: number, choice: Choice) => ({ key: keyOf(r.conflicts.find((c) => (c as { id?: string }).id === id(n))!), choice });
  const out = resolveMany(r.merged, r.conflicts, [pick(1, 'delete'), pick(2, 'keep'), pick(3, 'keep')]);
  assert.equal(Object.hasOwn(out.doc.objects, id(1)), false, 'the folder is deleted');
  assert.deepEqual([out.doc.objects[id(2)]?.parentId, out.doc.objects[id(2)]?.name], [null, 'C mine'], 'the connection that was kept is at the top level');
  assert.deepEqual([out.doc.objects[id(3)]?.parentId, out.doc.objects[id(4)]?.parentId], [null, id(3)], 'and so is the folder that was kept, with what is in it');
  validateDocument(out.doc);
  const orders = Object.values(out.doc.objects).filter((o) => o.parentId === null).map((o) => o.order);
  assert.equal(new Set(orders).size, orders.length, 'the places among the siblings at the top level are all different');
  const some = resolveMany(r.merged, r.conflicts, [pick(1, 'delete'), pick(2, 'keep')]);
  assert.equal(Object.hasOwn(some.doc.objects, id(3)), false, 'g was not chosen: it goes with the folder');
  assert.deepEqual(some.conflicts, [], 'and so do the conflicts about it and about what was in it');
  const inside = resolveMany(r.merged, r.conflicts, [pick(1, 'delete'), pick(3, 'keep'), pick(2, 'delete')]);
  assert.deepEqual([Object.hasOwn(inside.doc.objects, id(2)), inside.doc.objects[id(3)]?.parentId], [false, null]);
  const deeper = resolveMany(r.merged, r.conflicts, [pick(1, 'delete'), pick(3, 'keep')]);
  assert.deepEqual([Object.hasOwn(deeper.doc.objects, id(2)), Object.hasOwn(deeper.doc.objects, id(3))], [false, true], 'what was in the folder and was not chosen goes with it');
});

test('an object that is both kept and deleted by the choices is kept, and a move into a folder that the same choices delete is refused', () => {
  const b = doc(folder(1), node(2, { parentId: id(1) }));
  const both: Conflict[] = [{ kind: 'delete-edit', id: id(2), deletedBy: 'theirs' }, { kind: 'orphan', id: id(2), parentId: id(1) }];
  const doc0 = structuredClone(b);
  for (const items of [[{ key: keyOf(both[0]!), choice: 'delete' }, { key: keyOf(both[1]!), choice: 'keep' }], [{ key: keyOf(both[0]!), choice: 'keep' }, { key: keyOf(both[1]!), choice: 'delete' }]] as const) {
    const out = resolveMany(b, both, items);
    assert.deepEqual(out.doc, b, 'one card says keep, the other delete: what was asked to be kept is kept');
    assert.deepEqual(out.conflicts, []);
  }
  assert.deepEqual(b, doc0, 'the document that was given is as it was');
  // They moved y into x; here x was deleted and y was moved to the top level: choosing their parent for y and deleting x at the same time is a contradiction.
  const c = doc(folder(1), folder(2, { order: 1 }), folder(3, { order: 2 }), node(4, { parentId: id(1), order: 0 }));
  const r = held(c, changed(without(c, 3), 4, (o) => { o.parentId = null; }), changed(changed(c, 3, (o) => { o.name = 'x edited'; }), 4, (o) => { o.parentId = id(3); }));
  assert.deepEqual(r.conflicts.map((x) => x.kind).sort(), ['delete-edit', 'field']);
  const items = r.conflicts.map((x) => ({ key: keyOf(x), choice: (x.kind === 'field' ? 'theirs' : 'delete') as Choice }));
  assert.throws(() => resolveMany(r.merged, r.conflicts, items), (e: unknown) => e instanceof DocumentError && e.code === 'bad-parent', 'y cannot be in the folder that is deleted');
});

test('a delete-edit and an orphan say how many objects the window shows inside the object: they go with it when it is deleted; what the window never sees is not counted', () => {
  const b = doc(folder(1));
  const theirs = joined(changed(b, 1, (o) => { o.name = 'F edited'; }), node(2, { parentId: id(1), order: 0 }), folder(3, { parentId: id(1), order: 1 }), node(4, { parentId: id(3), order: 0 }), node(5, { type: 'credential', parentId: id(3), order: 1, name: 'SECRET', props: { password: 'x' } }));
  const r = held(b, without(b, 1), theirs);
  const [view] = describe(r.merged, r.conflicts) as Extract<ConflictView, { kind: 'delete-edit' }>[];
  assert.equal(view!.kind, 'delete-edit');
  assert.equal(view!.below, 3, 'a connection, a folder and a connection in it; the credential is not counted');
  const orphan = held(doc(folder(1)), joined(doc(folder(1)), folder(2, { parentId: id(1) }), node(3, { parentId: id(2), order: 0 })), without(doc(folder(1)), 1));
  const [lost] = describe(orphan.merged, orphan.conflicts) as Extract<ConflictView, { kind: 'orphan' }>[];
  assert.deepEqual([lost!.kind, lost!.below], ['orphan', 1]);
  const flat = held(base(), without(base(), 6), changed(base(), 6, (o) => { o.name = 'x'; }));
  assert.equal((describe(flat.merged, flat.conflicts)[0] as Extract<ConflictView, { kind: 'delete-edit' }>).below, 0, 'nothing in it');
  assert.equal(JSON.stringify(describe(r.merged, r.conflicts)).includes('SECRET'), false);
});

test('valid public text, number and boolean values retain their types; invalid and opaque JSON remain hidden', () => {
  const b = base();
  const { merged, conflicts } = held(b, changed(b, 2, (o) => { o.props.host = '3390'; o.props.port = 3390; o.props.clipboardToRemote = true; }), changed(b, 2, (o) => { o.props.host = '3391'; o.props.port = 3391; o.props.clipboardToRemote = false; }));
  const views = describe(merged, conflicts) as FieldView[];
  const of = (property: string) => views.find((v) => v.property === property)!;
  assert.deepEqual([of('host').mine, of('port').mine], [{ text: '3390' }, { text: '3390', json: 'number' }], 'the same characters are distinguished by their valid public field types');
  assert.deepEqual([of('clipboardToRemote').mine, of('clipboardToRemote').theirs], [{ text: 'true', json: 'boolean' }, { text: 'false', json: 'boolean' }]);
  const objects = held(b, changed(b, 2, (o) => { o.props.tags = { a: 1 }; }), changed(b, 2, (o) => { o.props.tags = [1]; }));
  assert.deepEqual(describe(objects.merged, objects.conflicts), [{ key: keyOf(objects.conflicts[0]!), kind: 'hidden', of: 'field', choices: ['mine', 'theirs'] }], 'opaque JSON keeps its internal conflict but no name, shape or value reaches the window');
  const invalid = held(b, changed(b, 2, (o) => { o.props.port = '3390'; }), changed(b, 2, (o) => { o.props.port = 3391; }));
  assert.deepEqual(describe(invalid.merged, invalid.conflicts), [{ key: keyOf(invalid.conflicts[0]!), kind: 'hidden', of: 'field', choices: ['mine', 'theirs'] }], 'a public property name does not make its invalid value safe to display');
});

test('a value is cut before a character of two units rather than in the middle of it', () => {
  const b = base();
  const edge = 'a'.repeat(399) + '\u{1F600}' + 'b';
  const r = held(b, changed(b, 2, (o) => { o.props.notes = edge; }), changed(b, 2, (o) => { o.props.notes = 'z'; }));
  const [view] = describe(r.merged, r.conflicts) as FieldView[];
  assert.deepEqual([view!.mine.text.length, view!.mine.cut], [399, true], 'the pair would have been cut in two: it is left out');
});

test('a cycle names at most ten folders and says how many there are; a parent that is not a folder, an object that is not there and a conflict about the type are told without leaking a name', () => {
  const folders = Array.from({ length: 12 }, (_, i) => folder(i + 1, { order: i }));
  const many: Conflict = { kind: 'cycle', ids: folders.map((f) => f.id) };
  const [cycle] = describe(doc(...folders), [many]) as Extract<ConflictView, { kind: 'cycle' }>[];
  assert.deepEqual([cycle!.objects.length, cycle!.total], [10, 12]);
  const d = doc(folder(1), node(2, { parentId: id(1) }), node(9, { type: 'credential', name: 'SECRET-NAME', props: { password: 'x' } }));
  const viaSecret: Conflict = { kind: 'field', id: id(2), field: 'parentId', base: id(1), mine: id(1), theirs: id(9) };
  const [parent] = describe(d, [viaSecret]) as FieldView[];
  assert.deepEqual(parent!.theirs, { text: '', gone: true }, 'a parent that is not a folder is a folder that is not there');
  assert.equal(JSON.stringify(parent).includes('SECRET'), false);
  const away: Conflict = { kind: 'field', id: id(99), field: 'name', base: 'a', mine: 'b', theirs: 'c' };
  assert.equal(describe(d, [away])[0]!.kind, 'hidden', 'an object that is not in the document is not described');
  const kind: Conflict = { kind: 'field', id: id(2), field: 'type', base: 'connection', mine: 'folder', theirs: 'connection' };
  assert.equal((describe(d, [kind])[0] as FieldView).what, 'type');
});

test('a cycle says how many folders it has, also when the document does not hold all of them', () => {
  const d = doc(folder(1));
  const [cycle] = describe(d, [{ kind: 'cycle', ids: [id(1), id(99)] }]) as Extract<ConflictView, { kind: 'cycle' }>[];
  assert.deepEqual([cycle!.objects, cycle!.total], [['f1'], 2]);
});

test('"mine for everything" and "theirs for everything" decide an object that has two conflicts by its delete-edit: what a side deleted with its folder stays deleted, what the other deleted is kept at the top level; an orphan alone stays as the merge made it', () => {
  const b = doc(folder(1), node(2, { parentId: id(1), order: 0 }), node(3, { order: 1 }));
  const kinds = (r: ReturnType<typeof held>) => r.conflicts.map((c) => `${c.kind}:${(c as { id: string }).id.slice(-1)}`).sort();
  const decide = (r: ReturnType<typeof held>, side: 'mine' | 'theirs') => resolveMany(r.merged, r.conflicts, sideItems(r.conflicts, side)).doc;
  const here = held(b, withoutTree(b, 1), changed(b, 2, (o) => { o.name = 'edited there'; }));
  assert.deepEqual(kinds(here), ['delete-edit:2', 'orphan:2'], 'n2 was deleted here with its folder and edited there: its folder is gone too');
  assert.equal(Object.hasOwn(decide(here, 'mine').objects, id(2)), false, 'mine for everything: what this side deleted stays deleted');
  assert.deepEqual([decide(here, 'theirs').objects[id(2)]?.name, decide(here, 'theirs').objects[id(2)]?.parentId], ['edited there', null], 'theirs for everything: their edit stays, at the top level');
  const there = held(b, changed(b, 2, (o) => { o.name = 'edited here'; }), withoutTree(b, 1));
  assert.deepEqual(kinds(there), ['delete-edit:2', 'orphan:2']);
  assert.equal(Object.hasOwn(decide(there, 'theirs').objects, id(2)), false, 'theirs for everything: what they deleted stays deleted');
  assert.equal(decide(there, 'mine').objects[id(2)]?.name, 'edited here', 'mine for everything: what was edited here stays');
  const small = doc(folder(1));
  const alone = held(small, joined(small, node(2, { parentId: id(1) })), without(small, 1));
  assert.deepEqual(alone.conflicts.map((c) => c.kind), ['orphan']);
  for (const side of ['mine', 'theirs'] as const) assert.deepEqual(sideItems(alone.conflicts, side), [{ key: keyOf(alone.conflicts[0]!), choice: 'keep' }], `${side}: an orphan alone stays as the merge made it`);
  assert.deepEqual(sideItems(here.conflicts, 'mine').map((item) => item.key), here.conflicts.map(keyOf), 'one item for each conflict, in the order of the conflicts');
  assert.deepEqual(sideItems([], 'mine'), []);
});

test('what was chosen to be kept is remembered for the choices that follow, so that deciding its folder afterwards does not delete it; only what is still there is remembered', () => {
  const b = doc(folder(1), node(2, { parentId: id(1), order: 0 }));
  const r = held(b, changed(changed(b, 1, (o) => { o.name = 'F mine'; }), 2, (o) => { o.name = 'C mine'; }), withoutTree(b, 1));
  const keyFor = (n: number) => keyOf(r.conflicts.find((c) => (c as { id?: string }).id === id(n))!);
  const first = resolveMany(r.merged, r.conflicts, [{ key: keyFor(2), choice: 'keep' }]);
  assert.deepEqual(first.doc, r.merged, 'keeping alone changes nothing');
  assert.deepEqual([[...first.remembered.kept], [...first.remembered.placed]], [[id(2)], []]);
  const second = resolveMany(first.doc, first.conflicts, [{ key: keyFor(1), choice: 'delete' }], first.remembered);
  assert.deepEqual([Object.hasOwn(second.doc.objects, id(1)), second.doc.objects[id(2)]?.parentId, second.doc.objects[id(2)]?.name], [false, null, 'C mine'], 'the folder goes; what was kept goes to the top level');
  assert.deepEqual([...second.remembered.kept], [id(2)], 'and it is remembered as long as it is there');
  const forgetful = resolveMany(first.doc, first.conflicts, [{ key: keyFor(1), choice: 'delete' }]);
  assert.equal(Object.hasOwn(forgetful.doc.objects, id(2)), false, 'without the memory the object goes with the folder: that is why the session passes it on');
  const away = resolveMany({ ...second.doc, objects: {} }, [], [], second.remembered);
  assert.deepEqual([[...away.remembered.kept], [...away.remembered.placed]], [[], []], 'what is no longer in the document is not remembered');
  assert.deepEqual(resolveMany(r.merged, r.conflicts, []).remembered, { kept: new Set(), placed: new Set() }, 'nothing chosen, nothing remembered');
});

test('an object that was put in a folder by choosing their parent is remembered too: the folder deleted by a later choice does not take it, it goes to the top level; the same two choices in one set are refused', () => {
  const b = doc(folder(1), folder(2, { order: 1 }), node(3, { parentId: id(1), order: 0 }), folder(4, { order: 2 }));
  // They edited f2 and moved n3 into it; here f2 is deleted and n3 was moved into f4.
  const r = held(b, changed(without(b, 2), 3, (o) => { o.parentId = id(4); }), changed(changed(b, 2, (o) => { o.name = 'f2 edited'; }), 3, (o) => { o.parentId = id(2); }));
  assert.deepEqual(r.conflicts.map((c) => c.kind).sort(), ['delete-edit', 'field']);
  const field = r.conflicts.find((c) => c.kind === 'field')!, gone = r.conflicts.find((c) => c.kind === 'delete-edit')!;
  const first = resolveMany(r.merged, r.conflicts, [{ key: keyOf(field), choice: 'theirs' }]);
  assert.equal(first.doc.objects[id(3)]?.parentId, id(2), 'n3 is in f2, where they put it');
  assert.deepEqual([[...first.remembered.kept], [...first.remembered.placed]], [[], [id(3)]]);
  const second = resolveMany(first.doc, first.conflicts, [{ key: keyOf(gone), choice: 'delete' }], first.remembered);
  assert.deepEqual([Object.hasOwn(second.doc.objects, id(2)), second.doc.objects[id(3)]?.parentId], [false, null]);
  assert.throws(() => resolveMany(r.merged, r.conflicts, [{ key: keyOf(field), choice: 'theirs' }, { key: keyOf(gone), choice: 'delete' }]), (e: unknown) => e instanceof DocumentError && e.code === 'bad-parent');
  const orphan: Conflict = { kind: 'orphan', id: id(3), parentId: id(2) };
  const deleted = resolveMany(first.doc, [orphan], [{ key: keyOf(orphan), choice: 'delete' }], first.remembered);
  assert.equal(Object.hasOwn(deleted.doc.objects, id(3)), false, 'a placement is not a choice to keep: when the object itself is chosen to be deleted it goes');
  assert.deepEqual([...deleted.remembered.placed], [], 'and what is deleted is not remembered');
});

test('their parent can also be a folder that the same choices delete with the folder above it: it is refused like the folder itself', () => {
  // f1 holds f2. Here f1 was deleted with f2 and n3 moved into f4; there f1 and f2 were edited and n3 was moved into f2.
  const c = doc(folder(1), folder(2, { parentId: id(1), order: 0 }), node(3, { order: 1 }), folder(4, { order: 2 }));
  const r = held(c, changed(withoutTree(c, 1), 3, (o) => { o.parentId = id(4); }), changed(changed(changed(c, 1, (o) => { o.name = 'f1 edited'; }), 2, (o) => { o.name = 'f2 edited'; }), 3, (o) => { o.parentId = id(2); }));
  assert.deepEqual(r.conflicts.map((x) => x.kind).sort(), ['delete-edit', 'delete-edit', 'field']);
  const at = (n: number) => keyOf(r.conflicts.find((x) => (x as { id?: string }).id === id(n) && x.kind === 'delete-edit')!);
  const field = keyOf(r.conflicts.find((x) => x.kind === 'field')!);
  assert.throws(() => resolveMany(r.merged, r.conflicts, [{ key: field, choice: 'theirs' }, { key: at(1), choice: 'delete' }]), (e: unknown) => e instanceof DocumentError && e.code === 'bad-parent', 'f2 goes with f1, and n3 would be in it');
});

test('what is rescued gets places after the top level that is left, in the order of its ids, also when the top level has only the place 0', () => {
  const d = doc(node(4, { order: 0 }), folder(1, { order: 1 }), node(3, { parentId: id(1), order: 1 }), node(2, { parentId: id(1), order: 0 }));
  const cs: Conflict[] = [1, 2, 3].map((n) => ({ kind: 'delete-edit', id: id(n), deletedBy: 'theirs' }));
  const out = resolveMany(d, cs, [{ key: keyOf(cs[0]!), choice: 'delete' }, { key: keyOf(cs[1]!), choice: 'keep' }, { key: keyOf(cs[2]!), choice: 'keep' }]).doc;
  assert.deepEqual([out.objects[id(4)]!.order, out.objects[id(2)]!.order, out.objects[id(3)]!.order], [0, 1, 2], 'n4 stays; n2 and n3 follow in the order of their ids, though the document holds n3 first');
});

test('a choice about an object that is not in the document has nothing to do: their value for a field of an object that is gone changes nothing', () => {
  const d = doc(folder(1));
  const away: Conflict = { kind: 'field', id: id(99), field: 'name', base: 'a', mine: 'b', theirs: 'c' };
  const out = resolveMany(d, [away], [{ key: keyOf(away), choice: 'theirs' }]);
  assert.equal(out.doc, d, 'the very document that was given');
  assert.deepEqual(out.conflicts, [], 'and nothing is left to decide');
});

test('a parent that the base did not have (an object that both sides added, in other folders) is shown as not there, not as the top level', () => {
  const b = base();
  const r = held(b, joined(b, node(7, { parentId: id(1), order: 5 })), joined(b, node(7, { parentId: id(4), order: 5 })));
  const [view] = describe(r.merged, r.conflicts) as FieldView[];
  assert.deepEqual([r.conflicts.length, view!.what, view!.base, view!.mine, view!.theirs], [1, 'parent', { text: '', none: true }, { text: 'f1' }, { text: 'f4' }]);
});

test('every kind of object that the window never sees is told as hidden, with nothing of it but the kind of conflict; so is a field that no merge makes', () => {
  for (const type of ['credential', 'task', 'template', 'gateway', 'dynamicProvider'] as const) {
    const d = doc(node(2, { type, name: 'SECRET-NAME' }));
    const views = describe(d, [{ kind: 'field', id: id(2), field: 'name', base: 'a', mine: 'SECRET-b', theirs: 'SECRET-c' }, { kind: 'delete-edit', id: id(2), deletedBy: 'mine' }, { kind: 'orphan', id: id(2), parentId: id(1) }]);
    assert.deepEqual(views.map((v) => [v.kind, (v as { of?: string }).of]), [['hidden', 'field'], ['hidden', 'delete-edit'], ['hidden', 'orphan']], type);
    assert.equal(JSON.stringify(views).includes('SECRET'), false, type);
  }
  const [odd] = describe(doc(node(2)), [{ kind: 'field', id: id(2), field: 'order', base: 1, mine: 2, theirs: 3 }]);
  assert.deepEqual([odd!.kind, (odd as { of?: string }).of], ['hidden', 'field'], 'a field that no merge makes: nothing is said about it');
});
