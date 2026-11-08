import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDocument } from '../src/documents/store.js';
import { serializeDocument } from '../src/documents/model.js';
import { DocumentLibrary } from '../src/documents/library.js';
import { registerDocumentIpc, upgradeQuestion, messageFor, type Dialogs } from '../src/desktop/documents-ipc.js';

async function fixture(automatic = false) {
  const path = join(await mkdtemp(join(tmpdir(), 'rw-upgrade-ui-')), 'legacy.rwdoc');
  const handle = await createDocument(path, serializeDocument({ schemaVersion: 1, id: '00000000-0000-4000-8000-000000007700', kind: 'workspace', name: 'Legacy', revision: 0, objects: {} }), 'synthetic', { kdf: { logN: 14, r: 8, p: 1 } }); handle.unlocked.dispose();
  const original = await readFile(path);
  const library = new DocumentLibrary({ kdf: { logN: 14, r: 8, p: 1 } }); const doc = await library.open(path, 'synthetic');
  library.add(doc.id, { parentId: null, type: 'folder', name: 'Edited', props: {} });
  const handlers = new Map<string, (event: unknown, payload?: unknown) => any>();
  const state = { approved: false, asked: [] as string[], duringConfirm: undefined as (() => void) | undefined, close: 'save' as 'save' | 'cancel' };
  const dialogs: Dialogs = { chooseOpenPath: async () => undefined, chooseSavePath: async () => undefined, askPassword: async () => undefined, confirmClose: async () => state.close, confirmRemove: async () => true, confirmUpgrade: async (name) => { state.asked.push(name); state.duringConfirm?.(); return state.approved; } };
  registerDocumentIpc({ library, dialogs, ipc: { handle: (channel, listener) => handlers.set(channel, listener) }, check: (event) => { if (event !== 'owner') throw new Error('Access denied'); }, autosaveOf: () => automatic ? 'close' : undefined });
  return { path, original, library, doc, state, handlers, call: async (channel: string) => handlers.get(channel)!('owner', { id: doc.id }) };
}

test('only explicit save asks for version2 upgrade, with safe cancel and old-reader warning', async () => {
  const h = await fixture();
  const question = upgradeQuestion('Legacy'); assert.equal(question.cancelId, question.defaultId); assert.match(question.detail, /versi lama/i); assert.match(question.detail, /revisi/i);
  assert.match(messageFor('upgrade-required'), /simpan|format/i);
  assert.equal((await h.call('documents:save')).code, 'cancelled');
  assert.deepEqual(h.state.asked, ['Legacy']); assert.deepEqual(await readFile(h.path), h.original); assert.ok(h.library.upgradeRequest(h.doc.id));
  h.state.approved = true;
  assert.equal((await h.call('documents:save')).saved, true); assert.equal(h.library.upgradeRequest(h.doc.id), undefined);
  assert.equal((await h.call('documents:save')).ok, true); assert.deepEqual(h.state.asked, ['Legacy', 'Legacy']);
  h.library.closeAll();
});

test('document edits during the native confirmation invalidate consent before any disk write', async () => {
  const h = await fixture(); h.state.approved = true;
  h.state.duringConfirm = () => h.library.add(h.doc.id, { parentId: null, type: 'folder', name: 'Changed after review', props: {} });
  assert.equal((await h.call('documents:save')).code, 'upgrade-required'); assert.deepEqual(await readFile(h.path), h.original);
  assert.deepEqual(h.state.asked, ['Legacy']); assert.equal(h.library.snapshot(h.doc.id).objects.length, 2);
  assert.ok(h.library.upgradeRequest(h.doc.id)); h.library.closeAll();
});

test('automatic and close-save never approve an upgrade; foreign sender cannot show confirmation', async () => {
  for (const automatic of [false, true]) {
    const h = await fixture(automatic); h.state.approved = true;
    await assert.rejects(h.handlers.get('documents:save')!('foreign', { id: h.doc.id }), /Access denied/);
    assert.equal((await h.call('documents:close')).code, 'upgrade-required');
    assert.deepEqual(h.state.asked, []); assert.deepEqual(await readFile(h.path), h.original); assert.equal(h.library.snapshot(h.doc.id).dirty, true);
    h.library.closeAll();
  }
});
