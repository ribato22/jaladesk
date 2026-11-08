import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentLibrary, LibraryError } from '../src/documents/library.js';
import { realFs, type StoreFs } from '../src/documents/store.js';
import { toProps, DEFAULT_RDP } from '../src/desktop/connection-settings.js';
import { messageFor, registerDocumentIpc, suggestedFileName, type Dialogs, type PasswordRequest } from '../src/desktop/documents-ipc.js';

const kdf = { logN: 14, r: 8, p: 1 };
const rdp = toProps({ ...DEFAULT_RDP, host: 'win-lab.example', username: 'ops' });

async function harness(options: { fs?: StoreFs } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rwipc-'));
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<any>>();
  const library = new DocumentLibrary({ kdf, ...(options.fs ? { fs: options.fs } : {}) });
  const state = {
    savePath: join(dir, 'lab.rwdoc') as string | undefined, openPath: undefined as string | undefined,
    passwords: [] as (string | undefined)[], asked: [] as PasswordRequest[], suggested: [] as string[],
    close: 'save' as 'save' | 'discard' | 'cancel', remove: true, removed: [] as [string, number][], dialogCalls: 0, reported: [] as unknown[], given: [] as string[],
  };
  const dialogs: Dialogs = {
    chooseOpenPath: async () => { state.dialogCalls++; return state.openPath; },
    chooseSavePath: async (name) => { state.dialogCalls++; state.suggested.push(name); return state.savePath; },
    askPassword: async (request) => { state.dialogCalls++; state.asked.push(request); const password = state.passwords.shift(); if (password) state.given.push(password); return password; },
    confirmClose: async () => { state.dialogCalls++; return state.close; },
    confirmRemove: async (name, count) => { state.dialogCalls++; state.removed.push([name, count]); return state.remove; },
  };
  const check = (event: unknown) => { if (event === 'stranger') throw new Error('Access denied'); };
  registerDocumentIpc({ ipc: { handle: (channel, listener) => { handlers.set(channel, async (event, payload) => listener(event, payload)); } }, check, library, dialogs, report: (error) => { state.reported.push(error); } });
  // The renderer is trusted with neither a file name nor a password: no reply may carry the folder the test works in, a password given, or a key named like one.
  const leaks = (value: unknown, found: string[] = []): string[] => {
    if (typeof value === 'string') { if (value.includes(dir) || state.given.includes(value)) found.push(value); }
    else if (Array.isArray(value)) value.forEach((item) => leaks(item, found));
    else if (typeof value === 'object' && value !== null) for (const [key, item] of Object.entries(value)) { if (['path', 'password', 'key', 'secret'].includes(key)) found.push(`key ${key}`); leaks(item, found); }
    return found;
  };
  const call = async (channel: string, payload?: unknown) => {
    const reply = await handlers.get(channel)!('window', payload);
    assert.deepEqual(leaks(reply), [], `${channel} gave the renderer something it must not have`);
    return reply;
  };
  const pathOf = (view: { id: string }) => library.view(view.id).path; // the library knows where a document lives; the renderer is not told
  return { dir, handlers, library, state, call, pathOf };
}

test('every channel refuses a sender that is not the app window, before it shows any dialog or touches any document', async () => {
  const { handlers, state, library } = await harness();
  assert.deepEqual([...handlers.keys()].sort(), ['documents:add', 'documents:close', 'documents:create', 'documents:duplicate', 'documents:move', 'documents:open', 'documents:remove', 'documents:save', 'documents:snapshot', 'documents:update', 'documents:views']);
  for (const [channel, handler] of handlers) await assert.rejects(handler('stranger', {}), /Access denied/, channel);
  assert.equal(state.dialogCalls, 0);
  assert.deepEqual(library.views(), []);
});

test('create: the app picks the file and asks for the password; the renderer cannot name a path', async () => {
  const { call, state, library, dir, pathOf } = await harness();
  state.passwords.push('s3cret-pw');
  state.savePath = join(dir, 'chosen'); // no extension typed in the dialog
  const elsewhere = join(dir, 'renderer-chose-this.rwdoc');
  const reply = await call('documents:create', { name: 'Lab', path: elsewhere, password: 'ignored' });
  assert.equal(reply.ok, true);
  assert.equal(reply.snapshot.name, 'Lab');
  assert.equal(pathOf(reply.snapshot), join(dir, 'chosen.rwdoc'), 'the extension is added');
  assert.equal(await stat(join(dir, 'chosen.rwdoc')).then(() => true, () => false), true);
  assert.equal(await stat(elsewhere).then(() => true, () => false), false, 'the path the renderer sent was not used');
  assert.deepEqual(state.suggested, ['Lab.rwdoc'], 'the dialog is offered a file name made from the name');
  assert.deepEqual(state.asked, [{ purpose: 'create', name: 'Lab' }]);
  assert.equal(library.views().length, 1);
  assert.deepEqual(Object.keys(reply).sort(), ['ok', 'snapshot'], 'no password or key in the answer');
  assert.deepEqual(Object.keys(reply.snapshot).sort(), ['conflicts', 'dirty', 'docId', 'id', 'meta', 'name', 'objects', 'revision', 'seq'], 'and no path in the snapshot');
  const listed = (await call('documents:views')).snapshots;
  assert.deepEqual(listed.map((v: object) => Object.keys(v).sort()), [['conflicts', 'dirty', 'docId', 'id', 'meta', 'name', 'objects', 'revision', 'seq']], 'the list is given without paths too');
});

test('create: cancelling the file dialog or the password prompt opens nothing; a blank name or an empty password is refused', async () => {
  const a = await harness();
  a.state.savePath = undefined;
  assert.equal((await a.call('documents:create', { name: 'Lab' })).code, 'cancelled');
  assert.deepEqual(a.state.asked, [], 'no password is asked when no file was chosen');

  const b = await harness();
  b.state.passwords.push(undefined);
  assert.equal((await b.call('documents:create', { name: 'Lab' })).code, 'cancelled');
  assert.equal(await stat(b.state.savePath!).then(() => true, () => false), false, 'nothing was written');
  const before = b.state.dialogCalls;
  assert.equal((await b.call('documents:create', { name: '   ' })).code, 'invalid');
  assert.equal((await b.call('documents:create', 'not an object')).code, 'invalid');
  assert.equal(b.state.dialogCalls, before, 'a request that cannot work shows no dialog');
  b.state.passwords.push('');
  assert.equal((await b.call('documents:create', { name: 'Lab' })).code, 'invalid');
  assert.deepEqual(b.library.views(), []);
});

test('open: a wrong password asks again with a message; the right one opens; cancelling stops', async () => {
  const first = await harness();
  first.state.passwords.push('right-pw');
  const made = await first.call('documents:create', { name: 'Lab' });
  const filePath = first.pathOf(made.snapshot);
  first.library.closeAll();
  first.state.openPath = filePath;
  first.state.asked.length = 0;
  first.state.passwords.push('wrong-1', 'wrong-2', 'right-pw');
  const reply = await first.call('documents:open');
  assert.equal(reply.ok, true);
  assert.equal(reply.snapshot.name, 'Lab');
  assert.deepEqual(first.state.asked.map((a) => [a.purpose, a.error !== undefined]), [['open', false], ['open', true], ['open', true]]);
  assert.equal(first.state.asked[0]!.name, 'lab.rwdoc');
  first.library.closeAll();
  first.state.passwords.push('nope', undefined);
  assert.equal((await first.call('documents:open')).code, 'cancelled');
  assert.deepEqual(first.library.views(), []);
});

test('open: no file chosen is a cancel; a file that is not a document, or is already open, is named', async () => {
  const { call, state, dir, library, pathOf } = await harness();
  assert.equal((await call('documents:open')).code, 'cancelled');
  state.openPath = join(dir, 'junk.rwdoc');
  await writeFile(state.openPath, Buffer.from('this is not a document at all, only text'));
  state.passwords.push('pw');
  const junk = await call('documents:open');
  assert.deepEqual([junk.ok, junk.code], [false, 'unreadable']);
  assert.match(junk.message, /bukan dokumen/);
  state.passwords.push('pw-for-new');
  const made = await call('documents:create', { name: 'Lab' });
  state.openPath = pathOf(made.snapshot);
  state.passwords.push('pw-for-new');
  assert.equal((await call('documents:open')).code, 'already-open');
  assert.equal(library.views().length, 1);
});

test('add, update and remove check what the renderer sends; a refused edit changes nothing', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot: view } = await call('documents:create', { name: 'Lab' });
  const id = view.id;
  const folder = await call('documents:add', { id, parentId: null, type: 'folder', name: 'Servers', props: {} });
  assert.equal(folder.ok, true);
  const conn = await call('documents:add', { id, parentId: folder.objectId, type: 'connection', name: 'web', props: rdp });
  assert.equal(conn.ok, true);
  const refused: unknown[] = [
    'nope', { id: 'x', parentId: null, type: 'folder', name: 'a', props: {} }, { id, parentId: 'x', type: 'folder', name: 'a', props: {} },
    { id, parentId: null, type: 'credential', name: 'a', props: {} }, { id, parentId: null, type: 'folder', name: 5, props: {} },
    { id, parentId: null, type: 'folder', name: 'a', props: [] }, { id, parentId: null, type: 'folder', name: 'a', props: 'x' },
    { id, parentId: null, type: 'connection', name: 'a', props: { ...rdp, host: 'has space' } },
    { id, parentId: null, type: 'connection', name: 'a', props: { ...rdp, protocol: 'ssh' } },
    { id, parentId: null, type: 'connection', name: 'a', props: { ...rdp, port: 0 } },
  ];
  for (const payload of refused) assert.equal((await call('documents:add', payload)).code, 'invalid', JSON.stringify(payload));
  assert.equal(library.size(id), 2, 'nothing was added by the refused calls');
  const renamed = await call('documents:update', { id, objectId: conn.objectId, name: 'web1' });
  assert.deepEqual([renamed.ok, renamed.delta.upsert.map((o: any) => o.name)], [true, ['web1']], 'the answer is the one object that changed');
  assert.equal((await call('documents:update', { id, objectId: conn.objectId, props: { ...rdp, port: 'x' } })).code, 'invalid');
  assert.equal((await call('documents:update', { id, objectId: conn.objectId })).code, 'invalid', 'an update that changes nothing is not an update');
  assert.equal((await call('documents:update', { id, objectId: '00000000-0000-4000-8000-0000000000ee', name: 'x' })).code, 'unknown-object');
});

test('remove asks first and says how many objects go; declining keeps them', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot: view } = await call('documents:create', { name: 'Lab' });
  const folder = (await call('documents:add', { id: view.id, parentId: null, type: 'folder', name: 'Servers', props: {} })).objectId;
  await call('documents:add', { id: view.id, parentId: folder, type: 'connection', name: 'web', props: rdp });
  state.remove = false;
  assert.equal((await call('documents:remove', { id: view.id, objectId: folder })).code, 'cancelled');
  assert.equal(library.size(view.id), 2);
  state.remove = true;
  const done = await call('documents:remove', { id: view.id, objectId: folder });
  assert.deepEqual([done.ok, done.delta.remove.length, library.size(view.id)], [true, 2, 0], 'the answer lists the ids that are gone');
  assert.deepEqual(state.removed, [['Servers', 2], ['Servers', 2]]);
});

test('save and close: unsaved work is saved, thrown away or kept only on the user\'s word', async () => {
  const { call, state, library, pathOf } = await harness();
  state.passwords.push('pw');
  const { snapshot: view } = await call('documents:create', { name: 'Lab' });
  const id = view.id;
  const filePath = pathOf(view);
  await call('documents:add', { id, parentId: null, type: 'folder', name: 'A', props: {} });
  state.close = 'cancel';
  assert.equal((await call('documents:close', { id })).code, 'cancelled');
  assert.equal(library.view(id).dirty, true);
  const saved = await call('documents:save', { id });
  assert.deepEqual([saved.ok, saved.saved, saved.delta.dirty], [true, true, false]);
  await call('documents:add', { id, parentId: null, type: 'folder', name: 'B', props: {} });
  state.close = 'discard';
  assert.equal((await call('documents:close', { id })).ok, true);
  assert.deepEqual(library.views(), []);
  state.passwords.push('pw');
  state.openPath = filePath;
  const again = await call('documents:open');
  assert.deepEqual(again.snapshot.objects.map((o: any) => o.name), ['A'], 'the discarded change is gone, the saved one is there');
  await call('documents:add', { id: again.snapshot.id, parentId: null, type: 'folder', name: 'C', props: {} });
  state.close = 'save';
  assert.equal((await call('documents:close', { id: again.snapshot.id })).ok, true);
  state.passwords.push('pw');
  assert.deepEqual((await call('documents:open')).snapshot.objects.map((o: any) => o.name).sort(), ['A', 'C']);
  const before = state.dialogCalls;
  const clean = (await call('documents:views')).snapshots[0];
  assert.equal((await call('documents:close', { id: clean.id })).ok, true);
  assert.equal(state.dialogCalls, before, 'a clean document closes without asking');
});

test('an unexpected failure is reported without its details', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot: view } = await call('documents:create', { name: 'Lab' });
  (library as any).add = () => { throw new Error('boom at /Users/someone/secret-path'); };
  const reply = await call('documents:add', { id: view.id, parentId: null, type: 'folder', name: 'A', props: {} });
  assert.deepEqual([reply.ok, reply.code], [false, 'io']);
  assert.equal(JSON.stringify(reply).includes('secret-path'), false);
  assert.equal(state.reported.length, 1, 'the failure was reported to the main process');
  assert.deepEqual(state.reported, [{ code: 'credential-error' }], 'only a fixed code is reported; raw diagnostics may contain credentials');
  assert.doesNotMatch(JSON.stringify(state.reported), /boom|secret-path|cause|stack/);
});

test('a file that is already open, or a name that is taken, is refused before any password is asked for', async () => {
  const { call, state, pathOf } = await harness();
  state.passwords.push('pw');
  const made = await call('documents:create', { name: 'Lab' });
  state.asked.length = 0;
  state.openPath = pathOf(made.snapshot);
  assert.equal((await call('documents:open')).code, 'already-open');
  state.savePath = pathOf(made.snapshot); // the same name again: the file is there and open
  assert.equal((await call('documents:create', { name: 'Again' })).code, 'already-open');
  assert.deepEqual(state.asked, [], 'no password prompt was shown');
  await call('documents:close', { id: made.snapshot.id });
  assert.equal((await call('documents:create', { name: 'Again' })).code, 'exists', 'closed, but the file is still there');
  assert.deepEqual(state.asked, []);
});

test('the save dialog is offered a safe file name, never one that carries a folder or a character a file system refuses', () => {
  for (const [typed, offered] of [['Lab', 'Lab.rwdoc'], ['Prod/EU', 'Prod_EU.rwdoc'], ['Lab: 2', 'Lab_ 2.rwdoc'], ['  padded  ', 'padded.rwdoc'], ['.hidden', 'hidden.rwdoc'],
    ['../../outside', '_.._outside.rwdoc'], ['a\\b', 'a_b.rwdoc'], ['bell\u0007', 'bell_.rwdoc'], ['...', 'Dokumen.rwdoc'], ['x'.repeat(300), `${'x'.repeat(100)}.rwdoc`]]) {
    assert.equal(suggestedFileName(typed), offered, JSON.stringify(typed));
  }
});

test('an I/O failure reports only a fixed code and a wrong password is not an incident', async () => {
  let unreadable = false;
  const fs: StoreFs = { ...realFs, readFile: async (path) => { if (unreadable) throw Object.assign(new Error('EACCES: permission denied, open /Users/someone/secret-path'), { code: 'EACCES' }); return realFs.readFile(path); } };
  const { call, state, library } = await harness({ fs });
  state.passwords.push('pw');
  const made = await call('documents:create', { name: 'Lab' });
  library.closeAll();
  state.openPath = join(state.savePath!);
  state.passwords.push('wrong', undefined);
  assert.equal((await call('documents:open')).code, 'cancelled');
  assert.deepEqual(state.reported, [], 'a wrong password is part of normal use');
  unreadable = true;
  state.passwords.push('pw');
  const reply = await call('documents:open');
  assert.deepEqual([reply.ok, reply.code], [false, 'io']);
  assert.equal(JSON.stringify(reply).includes('secret-path'), false, 'nothing of it reaches the renderer');
  assert.equal(state.reported.length, 1);
  assert.deepEqual(state.reported, [{ code: 'credential-error' }], 'the filesystem cause is not logged');
  assert.doesNotMatch(JSON.stringify(state.reported), /EACCES|secret-path|cause|stack/);
  assert.ok(made.ok);
});

test('every id the renderer sends must be an id: other spellings, "__proto__" included, are refused before anything is asked, read or changed', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot: view } = await call('documents:create', { name: 'Lab' });
  const id = view.id;
  const folder = (await call('documents:add', { id, parentId: null, type: 'folder', name: 'F', props: {} })).objectId;
  const before = JSON.stringify(library.snapshot(id).objects);
  const dialogs = state.dialogCalls;
  for (const bogus of ['__proto__', 'constructor', 'not-an-id', '', 5, {}, undefined]) {
    const requests: [string, unknown][] = [
      ['documents:add', { id: bogus, parentId: null, type: 'folder', name: 'x', props: {} }], ['documents:add', { id, parentId: bogus, type: 'folder', name: 'x', props: {} }],
      ['documents:update', { id: bogus, objectId: folder, name: 'x' }], ['documents:update', { id, objectId: bogus, name: 'x' }],
      ['documents:remove', { id: bogus, objectId: folder }], ['documents:remove', { id, objectId: bogus }],
      ['documents:save', { id: bogus }], ['documents:close', { id: bogus }],
    ];
    for (const [channel, payload] of requests) {
      const reply = await call(channel, payload);
      assert.deepEqual([reply.ok, reply.code], [false, 'invalid'], `${channel} ${JSON.stringify(payload)}`);
    }
  }
  assert.equal(JSON.stringify(library.snapshot(id).objects), before, 'nothing changed');
  assert.equal(state.dialogCalls, dialogs, 'and nothing was asked');
});

test('closing after "Simpan": an edit that slipped in while the file was being written keeps the document open and unsaved', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot: view } = await call('documents:create', { name: 'Lab' });
  const id = view.id;
  await call('documents:add', { id, parentId: null, type: 'folder', name: 'A', props: {} });
  const realSave = library.save.bind(library);
  library.save = async (which) => { const outcome = await realSave(which); library.add(which, { parentId: null, type: 'folder', name: 'Slipped in' }); return outcome; };
  state.close = 'save';
  const reply = await call('documents:close', { id });
  assert.deepEqual([reply.ok, reply.code], [false, 'unsaved']);
  assert.equal(library.view(id).dirty, true);
  assert.equal(library.views().length, 1, 'the document is still open');
  assert.equal(reply.seq, library.view(id).seq, 'and the reply says which change the document is at, so the window can tell it is behind');
});

test('closing after "Simpan" while another program changed the same field: held back as a conflict, with a count, and the document stays open', async () => {
  const { call, state, library, pathOf } = await harness();
  state.passwords.push('pw');
  const { snapshot: view } = await call('documents:create', { name: 'Lab' });
  const id = view.id;
  const conn = await call('documents:add', { id, parentId: null, type: 'connection', name: 'web', props: rdp });
  await call('documents:save', { id });
  const other = new DocumentLibrary({ kdf });
  const theirs = await other.open(pathOf(view), 'pw');
  other.update(theirs.id, conn.objectId, { props: { ...rdp, host: 'from-other.example' } });
  await other.save(theirs.id);
  other.closeAll();
  await call('documents:update', { id, objectId: conn.objectId, props: { ...rdp, host: 'from-app.example' } });
  state.close = 'save';
  const reply = await call('documents:close', { id });
  assert.deepEqual([reply.ok, reply.code, reply.conflicts, reply.delta.dirty, reply.delta.reset], [false, 'conflict', 1, true, true]);
  assert.equal(reply.message, messageFor('conflict'));
  assert.match(reply.message, /diubah di tempat lain/);
  assert.equal(library.views().length, 1);
});

test('a failure reply says which change the document is at, so a window that is behind can tell; a request that names no open document says nothing of the kind', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot: view } = await call('documents:create', { name: 'Lab' });
  const id = view.id;
  library.add(id, { parentId: null, type: 'folder', name: 'Changed behind the window' });
  const realSave = library.save.bind(library);
  library.save = async () => { throw new LibraryError('io', 'the disk is gone'); };
  const failed = await call('documents:save', { id });
  library.save = realSave;
  assert.deepEqual([failed.ok, failed.code, failed.seq], [false, 'io', 1], 'the window had seq 0 when it was opened');
  assert.equal('view' in failed || 'delta' in failed, false, 'and the failure does not send the document again');
  const unknown = await call('documents:save', { id: '00000000-0000-4000-8000-0000000000aa' });
  assert.deepEqual([unknown.code, 'seq' in unknown], ['unknown-document', false]);
  assert.equal('seq' in (await call('documents:save', { id: 'not-an-id' })), false);
  assert.equal('seq' in (await call('documents:open')), false, 'nor does a request that has no document');
});

test('what the window says about a failure is fixed text for every code the library has, and an unknown code is said as an I/O failure', () => {
  for (const code of ['wrong-password', 'unreadable', 'too-new', 'not-found', 'exists', 'busy', 'rekeyed', 'already-open', 'unknown-document', 'unknown-object', 'unsaved', 'invalid', 'cycle', 'too-deep', 'too-many', 'too-large', 'io', 'conflict']) {
    assert.match(messageFor(code), /^[A-Z].*[.]$/, code);
    if (code !== 'io') assert.notEqual(messageFor(code), messageFor('no-such-code'), `${code} has a text of its own`);
  }
  assert.equal(messageFor('no-such-code'), messageFor('io'));
});

// ---- the channels of 02-B2a: a reply is as big as the edit, and the window can start again from a snapshot ----------------------------------

const folderOf = async (call: (channel: string, payload?: unknown) => Promise<any>, id: string, name: string, parentId: string | null = null) =>
  (await call('documents:add', { id, parentId, type: 'folder', name, props: {} })).objectId as string;
const connOf = async (call: (channel: string, payload?: unknown) => Promise<any>, id: string, name: string, parentId: string | null = null) =>
  (await call('documents:add', { id, parentId, type: 'connection', name, props: rdp })).objectId as string;

test('move and duplicate answer with the objects that changed; snapshot gives the whole document again at the seq it is at', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot } = await call('documents:create', { name: 'Lab' });
  const id = snapshot.id;
  const f = await folderOf(call, id, 'F');
  const a = await connOf(call, id, 'a', f);
  const b = await connOf(call, id, 'b', f);
  const top = await connOf(call, id, 'top');
  const moved = await call('documents:move', { id, objectId: top, parentId: f, index: 0 });
  assert.deepEqual([moved.ok, moved.delta.upsert.map((o: any) => o.name).sort(), moved.delta.remove], [true, ['a', 'b', 'top'], []]);
  assert.deepEqual(library.snapshot(id).objects.filter((o) => o.parentId === f).sort((x, y) => x.order - y.order).map((o) => o.name), ['top', 'a', 'b']);
  const copy = await call('documents:duplicate', { id, objectId: a });
  assert.equal(copy.ok, true);
  assert.deepEqual(copy.delta.upsert.map((o: any) => o.name).sort(), ['a salinan', 'b']);
  assert.equal(library.node(id, copy.objectId)!.name, 'a salinan');
  const again = await call('documents:snapshot', { id });
  assert.deepEqual([again.ok, again.snapshot.seq, again.snapshot.objects.length], [true, copy.delta.seq, 5]);
  void b;
});

test('a reply to an edit is as big as the edit, not as big as the document; a snapshot is as big as the document', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot } = await call('documents:create', { name: 'Big' });
  const id = snapshot.id;
  const f = await folderOf(call, id, 'Servers');
  for (let i = 0; i < 1500; i++) library.add(id, { parentId: f, type: 'connection', name: `server-${i}`, props: rdp });
  const size = (reply: unknown) => JSON.stringify(reply).length;
  const added = await call('documents:add', { id, parentId: f, type: 'connection', name: 'new', props: rdp });
  const renamed = await call('documents:update', { id, objectId: added.objectId, name: 'renamed' });
  const moved = await call('documents:move', { id, objectId: added.objectId, parentId: null });
  const removed = await call('documents:remove', { id, objectId: added.objectId });
  for (const [what, reply] of [['add', added], ['update', renamed], ['move', moved], ['remove', removed]] as const) assert.ok(size(reply) < 2_000, `${what} answered with ${size(reply)} characters`);
  const whole = size(await call('documents:snapshot', { id }));
  assert.ok(whole > 150_000, `the whole document is ${whole} characters: it is only asked for when the window opens it or has lost its place`);
});

test('the window has no business with objects of other kinds: it cannot change, remove, move or copy them, and cannot put an object into one', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot } = await call('documents:create', { name: 'Lab' });
  const id = snapshot.id;
  const f = await folderOf(call, id, 'F');
  const kinds = ['credential', 'task', 'template', 'gateway', 'dynamicProvider'] as const;     // every kind the window does not show
  for (const kind of kinds) {
    const secret = library.add(id, { parentId: null, type: kind, name: `Secret ${kind}`, props: { value: 'x' } }).objectId;
    for (const [channel, payload] of [
      ['documents:update', { id, objectId: secret, name: 'renamed' }], ['documents:remove', { id, objectId: secret }],
      ['documents:move', { id, objectId: secret, parentId: f }], ['documents:duplicate', { id, objectId: secret }],
    ] as const) assert.equal((await call(channel, payload)).code, 'unknown-object', `${kind}: ${channel}`);
    assert.equal((await call('documents:move', { id, objectId: f, parentId: secret })).code, 'invalid', `${kind}: it is not a folder the window knows`);
    assert.equal(library.node(id, secret)!.name, `Secret ${kind}`);
  }
  assert.equal(library.size(id), 1 + kinds.length);
});

test('move checks what it is given: ids, a position that is a whole number in range; and says why a folder cannot go into itself', async () => {
  const { call, state } = await harness();
  state.passwords.push('pw');
  const { snapshot } = await call('documents:create', { name: 'Lab' });
  const id = snapshot.id;
  const f = await folderOf(call, id, 'F');
  const inner = await folderOf(call, id, 'Inner', f);
  const leaf = await connOf(call, id, 'leaf');
  for (const payload of [{ id, objectId: leaf, parentId: undefined }, { id, objectId: leaf, parentId: 'nope' }, { id, objectId: leaf, parentId: '__proto__' }, { id, objectId: leaf, parentId: f, index: -1 },
    { id, objectId: leaf, parentId: f, index: 1.5 }, { id, objectId: leaf, parentId: f, index: '0' }, { id, objectId: leaf, parentId: f, index: 1e9 }, { id, objectId: leaf, parentId: f, index: Number.NaN }, { id, objectId: 5, parentId: f }]) {
    assert.deepEqual([(await call('documents:move', payload)).code], ['invalid'], JSON.stringify(payload));
  }
  const cycle = await call('documents:move', { id, objectId: f, parentId: inner });
  assert.deepEqual([cycle.ok, cycle.code, cycle.message], [false, 'cycle', messageFor('cycle')]);
  assert.match(cycle.message, /dirinya sendiri/);
  assert.equal((await call('documents:move', { id, objectId: leaf, parentId: f, index: 1 })).ok, true, 'a position at the end is allowed');
  assert.equal((await call('documents:move', { id, objectId: leaf, parentId: f, index: 9 })).code, 'invalid', 'one past the end is not');
});

test('a move that is not well formed never reaches the library: the refusal is made before the document is read', async () => {
  const { call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot } = await call('documents:create', { name: 'Lab' });
  const id = snapshot.id;
  const f = await folderOf(call, id, 'F');
  const leaf = await connOf(call, id, 'leaf');
  const reached: unknown[][] = [];
  const move = library.move.bind(library);
  library.move = (...args: Parameters<typeof library.move>) => { reached.push(args); return move(...args); };
  for (const payload of [{ id, objectId: leaf, parentId: 'not-an-id' }, { id, objectId: leaf, parentId: 7 }, { id, objectId: leaf, parentId: f, index: -1 }, { id, objectId: leaf, parentId: f, index: 1.5 },
    { id, objectId: leaf, parentId: f, index: '0' }, { id, objectId: leaf, parentId: f, index: 1_000_001 }, { id, objectId: leaf, parentId: f, index: Number.NaN }]) {
    assert.equal((await call('documents:move', payload)).code, 'invalid', JSON.stringify(payload));
  }
  assert.deepEqual(reached, [], 'none of them was passed on');
  assert.equal((await call('documents:move', { id, objectId: leaf, parentId: f, index: 0 })).ok, true);
  assert.equal(reached.length, 1, 'while a good one is');
});

test('a sender that is not the app window changes nothing on any channel, even with a well-formed request for a document that is open', async () => {
  const { handlers, call, state, library } = await harness();
  state.passwords.push('pw');
  const { snapshot } = await call('documents:create', { name: 'Lab' });
  const id = snapshot.id;
  const f = await folderOf(call, id, 'F');
  const leaf = await connOf(call, id, 'leaf');
  const before = JSON.stringify(library.snapshot(id));
  const dialogs = state.dialogCalls;
  const requests: [string, unknown][] = [
    ['documents:views', undefined], ['documents:snapshot', { id }], ['documents:create', { name: 'x' }], ['documents:open', undefined],
    ['documents:add', { id, parentId: null, type: 'folder', name: 'x', props: {} }], ['documents:update', { id, objectId: leaf, name: 'x' }],
    ['documents:remove', { id, objectId: leaf }], ['documents:move', { id, objectId: leaf, parentId: f }], ['documents:duplicate', { id, objectId: leaf }],
    ['documents:save', { id }], ['documents:close', { id }],
  ];
  assert.equal(requests.length, handlers.size, 'every channel is tried');
  for (const [channel, payload] of requests) await assert.rejects(handlers.get(channel)!('stranger', payload), /Access denied/, channel);
  assert.equal(JSON.stringify(library.snapshot(id)), before, 'the document is as it was');
  assert.equal(state.dialogCalls, dialogs, 'and nothing was asked');
});

test('the delta of every edit says which change it follows (from) as well as which one it makes (seq)', async () => {
  const { call, state } = await harness();
  state.passwords.push('pw');
  const { snapshot } = await call('documents:create', { name: 'Lab' });
  const id = snapshot.id;
  const added = await call('documents:add', { id, parentId: null, type: 'folder', name: 'F', props: {} });
  assert.deepEqual([added.delta.from, added.delta.seq], [snapshot.seq, snapshot.seq + 1]);
  const moved = await call('documents:move', { id, objectId: added.objectId, parentId: null, index: 0 });   // where it already is: nothing changes
  assert.deepEqual([moved.delta.from, moved.delta.seq], [added.delta.seq, added.delta.seq]);
  const copy = await call('documents:duplicate', { id, objectId: added.objectId });
  assert.equal(copy.delta.from, added.delta.seq);
  const removed = await call('documents:remove', { id, objectId: copy.objectId });
  assert.equal(removed.delta.from, copy.delta.seq);
  const saved = await call('documents:save', { id });
  assert.equal(saved.delta.from, removed.delta.seq);
});

test('the words a window is given for a refused edit say what is wrong, each its own', () => {
  assert.match(messageFor('cycle'), /dirinya sendiri/);
  assert.match(messageFor('too-deep'), /bersarang terlalu dalam/);
  assert.match(messageFor('too-many'), /jumlah objek maksimum/);
  assert.match(messageFor('unknown-object'), /tidak ada lagi/);
  assert.notEqual(messageFor('too-deep'), messageFor('too-many'));
});

test('committed create and Save cleanup warnings remain successful and visible without exposing private IO data',async()=>{
 const fs:StoreFs={...realFs,unlink:async path=>{if(path.endsWith('.lock'))throw Object.assign(Error('synthetic private path diagnostic'),{code:'EACCES'});return realFs.unlink(path);}};const{dir,library,state,call,pathOf}=await harness({fs});
 try{state.passwords.push('pw');const created=await call('documents:create',{name:'Warning'});assert.equal(created.ok,true);assert.match(created.note,/telah|sudah/i);assert.match(created.note,/lock/i);const file=pathOf(created.snapshot);await rm(file+'.lock',{force:true});library.add(created.snapshot.id,{type:'folder',parentId:null,name:'pending'});const saved=await call('documents:save',{id:created.snapshot.id});assert.equal(saved.ok,true);assert.equal(saved.saved,true);assert.match(saved.note,/lock/i);assert.equal(JSON.stringify(saved).includes('synthetic private path diagnostic'),false);}finally{library.closeAll();await rm(dir,{recursive:true,force:true});}
});
