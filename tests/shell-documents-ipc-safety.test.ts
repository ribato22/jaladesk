import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentLibrary } from '../src/documents/library.js';
import { messageFor, registerDocumentIpc, type Dialogs } from '../src/desktop/documents-ipc.js';
import type { AutosaveMode } from '../src/desktop/preferences.js';

const kdf = { logN: 14, r: 8, p: 1 };

/** The IPC layer on a real library; `modes` is how each document (by its id) is chosen to save by itself, and `asked` what the dialogs were asked. */
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'rwipcs-'));
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<any>>();
  const library = new DocumentLibrary({ kdf });
  const state = { path: join(dir, 'lab.rwdoc'), modes: new Map<string, AutosaveMode>(), asked: [] as string[], reported: [] as unknown[], answer: 'discard' as 'save' | 'discard' | 'cancel' };
  const dialogs: Dialogs = {
    chooseOpenPath: async () => undefined,
    chooseSavePath: async () => state.path,
    askPassword: async () => 'pw-12345678',
    confirmClose: async (name, why) => { state.asked.push(why === undefined ? `close ${name}` : `close ${name}: ${why}`); return state.answer; },
    confirmRemove: async () => true,
  };
  registerDocumentIpc({ ipc: { handle: (channel, listener) => { handlers.set(channel, async (event, payload) => listener(event, payload)); } }, check: () => undefined, library, dialogs, autosaveOf: (docId) => state.modes.get(docId), report: (error) => { state.reported.push(error); } });
  const call = (channel: string, payload?: unknown) => handlers.get(channel)!('window', payload);
  const start = async () => { const made = await call('documents:create', { name: 'Lab' }); assert.equal(made.ok, true); return made.snapshot as { id: string; docId: string }; };
  return { dir, library, state, call, start };
}

test('a document that saves by itself on edit, or when it is closed, is saved when it is closed, without a question; one that does not is asked about as before', async () => {
  for (const mode of ['close', 'edit'] as const) {
    const { library, state, call, start } = await harness();
    const view = await start();
    state.modes.set(view.docId, mode);
    await call('documents:add', { id: view.id, parentId: null, type: 'folder', name: 'A', props: {} });
    const reply = await call('documents:close', { id: view.id });
    assert.deepEqual([reply.ok, state.asked, library.views().length], [true, [], 0], mode);
    const again = new DocumentLibrary({ kdf });
    const opened = await again.open(state.path, 'pw-12345678');
    assert.deepEqual(again.snapshot(opened.id).objects.map((o) => o.name), ['A'], `${mode}: what was edited is in the file`);
  }
  const plain = await harness();
  const view = await plain.start();
  await plain.call('documents:add', { id: view.id, parentId: null, type: 'folder', name: 'A', props: {} });
  assert.equal((await plain.call('documents:close', { id: view.id })).ok, true);
  assert.deepEqual(plain.state.asked, ['close Lab'], 'no choice: the question is asked, as it always was');
});

test('a document that saves by itself and is held back by a conflict stays open and says so, and nothing is asked', async () => {
  const { library, state, call, start } = await harness();
  const view = await start();
  state.modes.set(view.docId, 'close');
  const folder = (await call('documents:add', { id: view.id, parentId: null, type: 'folder', name: 'web', props: {} })).objectId;
  await call('documents:save', { id: view.id });
  const other = new DocumentLibrary({ kdf });
  const second = await other.open(state.path, 'pw-12345678');
  other.update(second.id, folder, { name: 'by other' });
  await other.save(second.id);
  await call('documents:update', { id: view.id, objectId: folder, name: 'by me' });
  const reply = await call('documents:close', { id: view.id });
  assert.deepEqual([reply.ok, reply.code, reply.conflicts, state.asked, library.views().length], [false, 'conflict', 1, [], 1]);
  assert.equal(reply.message, messageFor('conflict'));
  assert.deepEqual([reply.delta.reset, reply.delta.conflicts, reply.delta.dirty], [true, 1, true], 'the window is told what the merge left, so that it shows the document as it is now');
});

test('the text for a held-back save points to the way out, and the texts for what conflicts, revisions and saving by itself can say are each their own', () => {
  assert.match(messageFor('conflict'), /Berkas diubah di tempat lain/);
  assert.match(messageFor('conflict'), /Pilih Konflik/);
  const texts = ['unknown-conflict', 'revision-key', 'autosave-failed', 'autosave-held', 'autosave-unavailable', 'too-many-autosave'].map(messageFor);
  assert.equal(new Set(texts).size, texts.length, 'no two say the same');
  assert.equal(texts.includes(messageFor('io')), false, 'and none is the text of an unknown failure');
});

test('a document that saves by itself and cannot be saved is asked about like any other, so that it can be thrown away', async () => {
  for (const [answer, outcome] of [['discard', true], ['cancel', false], ['save', false]] as const) {
    const { library, state, call, start } = await harness();
    const view = await start();
    state.modes.set(view.docId, 'edit');
    await call('documents:add', { id: view.id, parentId: null, type: 'folder', name: 'A', props: {} });
    await rm(state.path);                         // the file is gone (a share that went away, say): the save cannot be made
    state.answer = answer;
    const reply = await call('documents:close', { id: view.id });
    assert.deepEqual([reply.ok, state.asked, library.views().length], [outcome, [`close Lab: ${messageFor('not-found')}`], outcome ? 0 : 1], `${answer}: the question says why the document could not be saved by itself`);
    assert.equal(state.reported.length >= 1, true, `${answer}: and what went wrong is reported`);
    if (!outcome) assert.equal(reply.code, answer === 'cancel' ? 'cancelled' : 'not-found', answer);
  }
});

test('a document that saves by itself keeps the file it replaces when it is closed, as a save that was asked for does', async () => {
  const { library, state, call, start } = await harness();
  const view = await start();
  state.modes.set(view.docId, 'close');
  await call('documents:add', { id: view.id, parentId: null, type: 'folder', name: 'A', props: {} });
  await call('documents:save', { id: view.id });
  await call('documents:add', { id: view.id, parentId: null, type: 'folder', name: 'B', props: {} });
  assert.equal((await library.revisions(view.id)).length, 1);
  assert.equal((await call('documents:close', { id: view.id })).ok, true);
  const again = new DocumentLibrary({ kdf });
  const opened = await again.open(state.path, 'pw-12345678');
  assert.equal((await again.revisions(opened.id)).length, 2, 'the newest revision is a moment old, and the file that the close replaced is kept all the same');
});

test('the notices about the preferences say that the choices of saving by itself are lost with the favourites, and keep the words that they began with', () => {
  for (const code of ['preferences-reset', 'preferences-unavailable', 'preferences-too-new']) assert.match(messageFor(code), /simpan otomatis/i, code);
  assert.match(messageFor('preferences-unavailable'), /^Favorit tidak tersedia/);
  assert.match(messageFor('preferences-too-new'), /^Favorit tidak tersedia/);
  assert.match(messageFor('preferences-reset'), /^Berkas favorit tidak dapat dipahami/);
});
