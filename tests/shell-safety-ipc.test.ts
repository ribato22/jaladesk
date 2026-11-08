import { credentialRecord } from '../src/credentials/model.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentLibrary } from '../src/documents/library.js';
import { messageFor, registerDocumentIpc, type Dialogs } from '../src/desktop/documents-ipc.js';
import { Preferences } from '../src/desktop/preferences.js';
import { registerSafetyIpc, reloadQuestion, restoreAllQuestion, type SafetyDialogs } from '../src/desktop/safety-ipc.js';

const kdf = { logN: 14, r: 8, p: 1 };
// Assertions still inspect the private credential value; schema 2 keeps it outside the node's public props.
function credentialProps(library: DocumentLibrary, documentId: string, objectId: string): { password: string | undefined } {
  const record = credentialRecord(library.privateDocument(documentId).doc, library.node(documentId, objectId)!);
  assert.ok(record, 'the credential reference must remain closed');
  return { password: record.password };
}

type Call = (channel: string, payload?: unknown) => Promise<any>;

/** The IPC of the documents and of the safety of the data on a real library, and real preferences unless it is said that there are none; the dialogs answer from `state`. */
async function harness(options: { preferences?: boolean; maxDocuments?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rwsafeipc-'));
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<any>>();
  const library = new DocumentLibrary({ kdf });
  const preferences = options.preferences === false ? undefined : await Preferences.open(join(dir, 'preferences.json'), { maxDocuments: options.maxDocuments ?? 500 });
  const state = { reload: true, restoreAll: true, asked: [] as string[], unsaved: [] as boolean[], reported: [] as unknown[], chose: [] as string[] };
  const dialogs: Dialogs = { chooseOpenPath: async () => undefined, chooseSavePath: async () => join(dir, 'lab.rwdoc'), askPassword: async () => 'pw-12345678', confirmClose: async () => 'discard', confirmRemove: async () => true };
  const safety: SafetyDialogs = {
    confirmReload: async (name) => { state.asked.push(`reload ${name}`); return state.reload; },
    confirmRestoreAll: async (name, at, unsaved) => { state.asked.push(`restore ${name} ${at}`); state.unsaved.push(unsaved); return state.restoreAll; },
  };
  const ipc = { handle: (channel: string, listener: (event: any, payload?: unknown) => unknown) => { handlers.set(channel, async (event, payload) => listener(event, payload)); } };
  const check = (event: unknown) => { if (event === 'stranger') throw new Error('Access denied'); };
  registerDocumentIpc({ ipc, check, library, dialogs });
  registerSafetyIpc({ ipc, check, library, dialogs: safety, report: (error) => { state.reported.push(error); }, ...(preferences ? { preferences } : {}), autosaver: { chose: (id) => { state.chose.push(id); } } });
  const call: Call = (channel, payload) => handlers.get(channel)!('window', payload);
  return { dir, handlers, library, state, call, preferences };
}

/** Two programs on one file: `other` saved another name for web, deleted `old` and changed the password of a credential; this program edited the same (see library tests), so its save was held back. */
async function held() {
  const h = await harness();
  const path = join(h.dir, 'lab.rwdoc');
  const a = (await h.library.create(path, 'Lab', 'pw')).id;
  const web = h.library.add(a, { parentId: null, type: 'folder', name: 'web' }).objectId;
  const old = h.library.add(a, { parentId: null, type: 'folder', name: 'old' }).objectId;
  const cred = h.library.writeCredential(a, { parentId: null, name: 'Secret', record: { kind: 'credential', username: '', domain: '', password: 'pw-secret' } }).objectId;
  await h.library.save(a);
  const other = new DocumentLibrary({ kdf });
  const b = (await other.open(path, 'pw')).id;
  other.update(b, web, { name: 'web by other' });
  other.remove(b, old);
  other.writeCredential(b, { objectId: cred, name: other.node(b, cred)!.name, record: { kind: 'credential', username: '', domain: '', password: 'from-other' } });
  await other.save(b);
  h.library.update(a, web, { name: 'web by me' });
  h.library.update(a, old, { name: 'old by me' });
  h.library.writeCredential(a, { objectId: cred, name: h.library.node(a, cred)!.name, record: { kind: 'credential', username: '', domain: '', password: 'from-me' } });
  assert.equal((await h.library.save(a)).conflicts, 3);
  return { ...h, path, id: a, web, old, cred };
}
const refused = (reply: any, code = 'invalid') => { assert.equal(reply.ok, false, JSON.stringify(reply)); assert.equal(reply.code, code, JSON.stringify(reply)); assert.equal(reply.message, messageFor(code)); };

test('every channel of the safety of the data refuses a sender that is not the app window, and says which channels there are', async () => {
  const { handlers } = await harness();
  const mine = [...handlers.keys()].filter((c) => !['documents:add', 'documents:close', 'documents:create', 'documents:duplicate', 'documents:move', 'documents:open', 'documents:remove', 'documents:save', 'documents:snapshot', 'documents:update', 'documents:views'].includes(c)).sort();
  assert.deepEqual(mine, ['documents:autosave', 'documents:conflicts', 'documents:reload', 'documents:resolve', 'documents:restore', 'documents:revision', 'documents:revisions']);
  for (const channel of mine) await assert.rejects(handlers.get(channel)!('stranger', {}), /Access denied/, channel);
});

test('the conflicts are told without a path or an id and without anything of what the window never sees; what is not a document is refused', async () => {
  const { call, id, dir, cred } = await held();
  const reply = await call('documents:conflicts', { id });
  assert.deepEqual([reply.ok, reply.total, reply.views.length], [true, 3, 3]);
  assert.deepEqual(reply.views.map((v: { kind: string }) => v.kind).sort(), ['delete-edit', 'field', 'hidden']);
  const text = JSON.stringify(reply);
  for (const leak of ['Secret', 'pw-secret', 'from-other', 'from-me', cred, dir, id]) assert.equal(text.includes(leak), false, leak);
  for (const payload of [undefined, null, 'x', {}, { id: 'x' }, { id: 7 }]) refused(await call('documents:conflicts', payload));
  refused(await call('documents:conflicts', { id: '00000000-0000-4000-8000-000000000f00' }), 'unknown-document');
});

test('conflicts are decided with their keys, or for one side, and what is wrong in a request is refused before anything is decided', async () => {
  const { call, id, library, web, old, cred } = await held();
  const { views } = await call('documents:conflicts', { id });
  const field = views.find((v: { kind: string }) => v.kind === 'field');
  const bad: unknown[] = [
    {}, { id }, { id, items: 'x' }, { id, items: [] }, { id, items: [{}] }, { id, items: [{ key: 'nope', choice: 'mine' }] }, { id, items: [{ key: views[0].key, choice: 'bogus' }] },
    { id, items: [{ key: views[0].key }] }, { id, all: 'both' }, { id, all: 'mine', items: [{ key: views[0].key, choice: 'mine' }] }, { id, items: Array.from({ length: 201 }, () => ({ key: views[0].key, choice: 'mine' })) },
  ];
  for (const payload of bad) refused(await call('documents:resolve', payload));
  refused(await call('documents:resolve', { id, items: [{ key: 'c-0123456789abcdef', choice: 'mine' }] }), 'unknown-conflict');
  refused(await call('documents:resolve', { id, items: [{ key: field.key, choice: 'keep' }] }));
  assert.equal(library.view(id).conflicts, 3, 'nothing was decided');
  const some = await call('documents:resolve', { id, items: [{ key: field.key, choice: 'theirs' }] });
  assert.deepEqual([some.ok, some.delta.reset, some.delta.conflicts], [true, true, 2]);
  const all = await call('documents:resolve', { id, all: 'theirs' });
  assert.deepEqual([all.ok, all.delta.conflicts, library.node(id, old), library.node(id, web)!.name, credentialProps(library, id, cred)], [true, 0, undefined, 'web by other', { password: 'from-other' }]);
});

test('a reload asks first, in a dialog of the main process, and only then throws away what was changed here; saying no changes nothing', async () => {
  const { call, id, state, library } = await held();
  state.reload = false;
  const no = await call('documents:reload', { id });
  assert.deepEqual([no.ok, no.code], [false, 'cancelled']);
  assert.deepEqual([library.view(id).dirty, library.view(id).conflicts], [true, 3]);
  state.reload = true;
  const yes = await call('documents:reload', { id });
  assert.deepEqual([yes.ok, yes.delta.reset, yes.delta.dirty, yes.delta.conflicts], [true, true, false, 0]);
  assert.deepEqual(state.asked, ['reload Lab', 'reload Lab']);
  refused(await call('documents:reload', { id: 'x' }));
  assert.equal(state.asked.length, 2, 'a request that cannot work shows no dialog');
});

test('the revisions are listed, one is opened for the window, and a name that is not the name of one is refused', async () => {
  const { call, id, library } = await held();
  await library.reload(id);
  library.add(id, { parentId: null, type: 'folder', name: 'new' });
  await library.save(id);
  const list = await call('documents:revisions', { id });
  assert.equal(list.ok, true);
  assert.ok(list.revisions.length >= 2);
  const first = list.revisions[0];
  const one = await call('documents:revision', { id, name: first.name });
  assert.deepEqual([one.ok, one.revision.name, one.revision.at], [true, first.name, first.at]);
  assert.equal(JSON.stringify(one).includes('Secret'), false);
  for (const name of ['', 'x', '../../etc/passwd', `${first.name}/..`, 7, undefined, null, first.name.replace(/-[0-9a-f]{12}\.rwdoc$/, '-0123456789abc.rwdoc'), first.name.replace(/-[0-9a-f]{12}\.rwdoc$/, '-0123456789a.rwdoc')]) refused(await call('documents:revision', { id, name }));
  refused(await call('documents:revision', { id, name: '20200101T000000000Z-000000000000.rwdoc' }), 'not-found');
  refused(await call('documents:revisions', { id: 'x' }));
});

test('objects of a revision are restored without a question; the whole document only after one; and what is wrong in a request is refused', async () => {
  const { call, id, library, state } = await held();
  await library.reload(id);
  const name = (await call('documents:revisions', { id })).revisions[0].name as string;
  const view = (await call('documents:revision', { id, name })).revision;
  const some = view.objects[0].id as string;
  const result = await call('documents:restore', { id, name, ids: [some], folderName: 'Dipulihkan' });
  assert.deepEqual([result.ok, state.asked, typeof result.created], [true, [], 'string']);
  assert.equal(library.node(id, result.created)!.name, 'Dipulihkan');
  const size = library.size(id);
  const bad: unknown[] = [{}, { id, name }, { id, name, ids: [], folderName: 'x' }, { id, name, ids: 'x', folderName: 'x' }, { id, name, ids: ['nope'], folderName: 'x' }, { id, name, ids: [some] }, { id, name, ids: [some], folderName: 7 },
    { id, name, ids: Array.from({ length: 51 }, () => some), folderName: 'x' }, { id, name, all: false }, { id, name, all: true, ids: [some] }, { id, name, all: true, folderName: 'x' }];
  for (const payload of bad) refused(await call('documents:restore', payload));
  refused(await call('documents:restore', { id, name, ids: ['00000000-0000-4000-8000-0000000000aa'], folderName: 'x' }), 'unknown-object');
  assert.equal(library.size(id), size);
  for (const wrong of [name.replace(/-[0-9a-f]{12}\.rwdoc$/, '-0123456789abc.rwdoc'), name.replace(/-[0-9a-f]{12}\.rwdoc$/, '-0123456789a.rwdoc')]) refused(await call('documents:restore', { id, name: wrong, all: true })); // a hash of the wrong length is not the name of a revision: refused, not looked for
  state.restoreAll = false;
  const no = await call('documents:restore', { id, name, all: true });
  const at = (await call('documents:revisions', { id })).revisions[0].at as number;
  assert.deepEqual([no.ok, no.code, state.asked], [false, 'cancelled', [`restore Lab ${at}`]], 'the question says when the earlier version was taken');
  state.restoreAll = true;
  const all = await call('documents:restore', { id, name, all: true });
  assert.deepEqual([all.ok, all.delta.reset, all.delta.dirty], [true, true, true]);
});

test('how a document saves by itself is asked and chosen per document; the main process that saves is told at once, and what is not a mode is refused', async () => {
  const { call, library, state, preferences, dir } = await harness();
  const a = (await library.create(join(dir, 'a.rwdoc'), 'A', 'pw')).id;
  const b = (await library.create(join(dir, 'b.rwdoc'), 'B', 'pw')).id;
  assert.deepEqual(await call('documents:autosave', { id: a }), { ok: true, mode: 'off' });
  assert.deepEqual(await call('documents:autosave', { id: a, mode: 'edit' }), { ok: true, mode: 'edit' });
  assert.deepEqual(state.chose, [a]);
  assert.deepEqual([(await call('documents:autosave', { id: a })).mode, (await call('documents:autosave', { id: b })).mode], ['edit', 'off'], 'per document');
  assert.equal(preferences!.autosaveOf(library.view(a).docId), 'edit');
  assert.deepEqual(await call('documents:autosave', { id: a, mode: 'off' }), { ok: true, mode: 'off' });
  assert.equal(JSON.parse(await readFile(join(dir, 'preferences.json'), 'utf8')).version, 1, 'nothing is chosen any more: the file is as it was');
  for (const mode of ['always', 7, null, {}, '__proto__']) refused(await call('documents:autosave', { id: a, mode }));
  refused(await call('documents:autosave', { id: 'x', mode: 'edit' }));
  assert.deepEqual(state.chose, [a, a]);
});

test('with no room for another choice it is said so, in its own words; without preferences there is nothing to choose in', async () => {
  const { call, library, dir } = await harness({ maxDocuments: 1 });
  const a = (await library.create(join(dir, 'a.rwdoc'), 'A', 'pw')).id;
  const b = (await library.create(join(dir, 'b.rwdoc'), 'B', 'pw')).id;
  assert.equal((await call('documents:autosave', { id: a, mode: 'edit' })).ok, true);
  refused(await call('documents:autosave', { id: b, mode: 'edit' }), 'too-many-autosave');
  const none = await harness({ preferences: false });
  const c = (await none.library.create(join(none.dir, 'c.rwdoc'), 'C', 'pw')).id;
  refused(await none.call('documents:autosave', { id: c }), 'autosave-unavailable');
  refused(await none.call('documents:autosave', { id: c, mode: 'edit' }), 'autosave-unavailable');
});

test('what goes wrong in the main process is reported there and told to the window only as the fixed text of its code', async () => {
  const { call, id, state, library } = await held();
  await library.reload(id);
  const reply = await call('documents:revision', { id, name: '20200101T000000000Z-000000000000.rwdoc' });
  assert.equal(reply.message, messageFor('not-found'));
  assert.deepEqual(state.reported, [], 'a missing revision is not an incident');
  assert.equal(JSON.stringify(reply).includes(id), false);
});

test('the edges of what is accepted are the edges that were meant: 200 choices and 50 objects, and a key of sixteen digits of the right kind', async () => {
  const { call, id, library } = await held();
  const forged = (n: number) => `c-${n.toString(16).padStart(16, '0')}`;
  refused(await call('documents:resolve', { id, items: Array.from({ length: 200 }, (_, n) => ({ key: forged(n + 1), choice: 'mine' })) }), 'unknown-conflict');   // 200 are not too many: it is the keys that are not there
  refused(await call('documents:resolve', { id, items: Array.from({ length: 201 }, (_, n) => ({ key: forged(n + 1), choice: 'mine' })) }));
  for (const key of ['c-0123456789abcdef0', 'c-0123456789abcde', 'c-0123456789ABCDEF', 'c-0123456789abcdeg', 'x-0123456789abcdef', 'c-0123456789abcdef\n']) refused(await call('documents:resolve', { id, items: [{ key, choice: 'mine' }] }), 'invalid');
  await library.reload(id);
  const name = (await call('documents:revisions', { id })).revisions[0].name as string;
  const some = (await call('documents:revision', { id, name })).revision.objects[0].id as string;
  const fifty = await call('documents:restore', { id, name, ids: Array.from({ length: 50 }, () => some), folderName: 'x' });
  assert.equal(fifty.ok, true, 'fifty names are not too many (this one named fifty times is one object)');
});

test('a conflict between folders that moved into each other is accepted, through the channel', async () => {
  const { call, library, dir } = await harness();
  const path = join(dir, 'lab.rwdoc');
  const a = (await library.create(path, 'Lab', 'pw')).id;
  const f1 = library.add(a, { parentId: null, type: 'folder', name: 'f1' }).objectId;
  const f2 = library.add(a, { parentId: null, type: 'folder', name: 'f2' }).objectId;
  await library.save(a);
  const other = new DocumentLibrary({ kdf });
  const b = (await other.open(path, 'pw')).id;
  other.move(b, f1, f2);
  await other.save(b);
  library.move(a, f2, f1);
  assert.equal((await library.save(a)).saved, false);
  const { views } = await call('documents:conflicts', { id: a });
  const cycle = views.find((v: { kind: string }) => v.kind === 'cycle');
  assert.deepEqual(cycle.choices, ['accept']);
  const done = await call('documents:resolve', { id: a, items: [{ key: cycle.key, choice: 'accept' }] });
  assert.deepEqual([done.ok, done.delta.conflicts], [true, 0]);
});

test('the whole document is not put back, and nothing is asked, for an earlier version that is not there', async () => {
  const { call, id, state } = await held();
  refused(await call('documents:restore', { id, name: '20200101T000000000Z-000000000000.rwdoc', all: true }), 'not-found');
  assert.deepEqual(state.asked, [], 'a question about an earlier version that does not exist is not asked');
});

test('keeping and deleting an object that was deleted on one side and edited on the other are accepted through the channel, and do what they say', async () => {
  for (const [choice, remains] of [['keep', true], ['delete', false]] as const) {
    const { call, id, library, old } = await held();
    const { views } = await call('documents:conflicts', { id });
    const edited = views.find((v: { kind: string }) => v.kind === 'delete-edit');
    const done = await call('documents:resolve', { id, items: [{ key: edited.key, choice }] });
    assert.deepEqual([done.ok, library.node(id, old) !== undefined], [true, remains], choice);
  }
});

test('the question before the whole document is put in is asked with what is at stake: whether there is unsaved work, or a conflict that holds a save back, that it throws away', async () => {
  const h = await harness();
  const id = (await h.library.create(join(h.dir, 'lab.rwdoc'), 'Lab', 'pw')).id;
  h.library.add(id, { parentId: null, type: 'folder', name: 'one' });
  await h.library.save(id);
  h.library.add(id, { parentId: null, type: 'folder', name: 'two' });
  await h.library.save(id);
  const name = (await h.call('documents:revisions', { id })).revisions[0].name as string;
  h.state.restoreAll = false;
  await h.call('documents:restore', { id, name, all: true });
  h.library.add(id, { parentId: null, type: 'folder', name: 'three' });
  await h.call('documents:restore', { id, name, all: true });
  assert.deepEqual(h.state.unsaved, [false, true], 'nothing unsaved at first; an edit that is not saved after it');
  const conflicted = await held();                       // an edit here, and a save that the other program's change holds back
  conflicted.state.restoreAll = false;
  const revision = (await conflicted.call('documents:revisions', { id: conflicted.id })).revisions[0].name as string;
  await conflicted.call('documents:restore', { id: conflicted.id, name: revision, all: true });
  assert.deepEqual(conflicted.state.unsaved, [true]);
});

test('what the dialogs of the main process ask: Enter and Escape choose the answer that throws nothing away, and what a question says is true of what it does', () => {
  const reload = reloadQuestion('Lab');
  assert.deepEqual([reload.buttons.length, reload.buttons[reload.defaultId], reload.buttons[reload.cancelId], reload.type], [2, 'Batal', 'Batal', 'warning']);
  assert.match(reload.message, /Muat ulang “Lab” dari berkas\?/);
  assert.match(reload.detail, /belum disimpan.*konflik.*dibuang/);
  const when = '14 Nov 2023, 22.13.20';
  const clean = restoreAllQuestion('Lab', when, false), unsaved = restoreAllQuestion('Lab', when, true);
  for (const question of [clean, unsaved]) {
    assert.deepEqual([question.buttons.length, question.buttons[question.defaultId], question.buttons[question.cancelId], question.type], [2, 'Batal', 'Batal', 'warning']);
    assert.match(question.message, /Ganti seluruh isi “Lab” dengan revisi /);
    assert.equal(question.message.includes(when), true, 'it says which version');
  }
  assert.match(clean.detail, /tetap ada di revisi saat dokumen disimpan/);
  assert.doesNotMatch(clean.detail, /dibuang/, 'nothing is thrown away: it is not said that something is');
  assert.match(unsaved.detail, /belum disimpan.*konflik.*dibuang/);
  assert.match(unsaved.detail, /tidak tersimpan di revisi mana pun/, 'work that was never saved is in no revision: the question says so');
  assert.match(unsaved.detail, /tetap ada di revisi saat dokumen disimpan/, 'and the file as it is now is kept');
  assert.notEqual(clean.detail, unsaved.detail);
});
