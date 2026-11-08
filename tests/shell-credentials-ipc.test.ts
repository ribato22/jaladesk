import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentLibrary, LibraryError } from '../src/documents/library.js';
import { registerDocumentIpc, handlerFor, type Dialogs } from '../src/desktop/documents-ipc.js';
import { DEFAULT_RDP, toProps } from '../src/desktop/connection-settings.js';

async function harness() {
  const library = new DocumentLibrary({ kdf: { logN: 14, r: 8, p: 1 } });
  const dir = await mkdtemp(join(tmpdir(), 'rw-private-ipc-'));
  const doc = await library.create(join(dir, 'synthetic.rwdoc'), 'Synthetic', 'synthetic');
  const folder = library.add(doc.id, { parentId: null, type: 'folder', name: 'Folder', props: { opaque: { nested: 'opaque-canary' }, notes: 'old' } }).objectId;
  const handlers = new Map<string, (event: unknown, payload?: unknown) => any>(); const reports: unknown[] = [];
  const dialogs: Dialogs = { chooseOpenPath: async () => undefined, chooseSavePath: async () => undefined, askPassword: async () => undefined, confirmClose: async () => 'cancel', confirmRemove: async () => true };
  registerDocumentIpc({ library, dialogs, ipc: { handle: (channel, listener) => handlers.set(channel, listener) }, check: (event) => { if (event !== 'owner') throw new Error('Access denied'); }, report: (error) => reports.push(error) });
  return { library, folder, doc, reports, handlers, call: async (channel: string, payload: unknown) => handlers.get(channel)!('owner', payload) };
}

test('generic IPC refuses private/unknown props and preserves encrypted opaque fields on public edits', async () => {
  const h = await harness();
  for (const key of ['password', 'secretId', 'groups', 'inherit', 'opaque', 'unrecognized']) {
    const properties = { [key]: 'injected-canary' };
    assert.equal((await h.call('documents:add', { id: h.doc.id, parentId: null, type: 'folder', name: 'New', props: properties })).code, 'invalid', `add ${key}`);
    assert.equal((await h.call('documents:update', { id: h.doc.id, objectId: h.folder, props: properties })).code, 'invalid', `replace ${key}`);
    assert.equal((await h.call('documents:update', { id: h.doc.id, objectId: h.folder, patch: { set: properties } })).code, 'invalid', `set ${key}`);
    assert.equal((await h.call('documents:update', { id: h.doc.id, objectId: h.folder, patch: { unset: [key] } })).code, 'invalid', `unset ${key}`);
  }
  assert.equal((await h.call('documents:update', { id: h.doc.id, objectId: h.folder, patch: { set: { notes: 'new' } } })).ok, true);
  assert.deepEqual(h.library.node(h.doc.id, h.folder)!.props.opaque, { nested: 'opaque-canary' });
  assert.equal((await h.call('documents:update', { id: h.doc.id, objectId: h.folder, props: { color: 'red' } })).ok, true);
  assert.deepEqual(h.library.node(h.doc.id, h.folder)!.props, { opaque: { nested: 'opaque-canary' }, color: 'red' });
  assert.doesNotMatch(JSON.stringify(await h.call('documents:snapshot', { id: h.doc.id, revealAll: true, path: '/private/input-canary' })), /canary|opaque|secretId|password/);
  h.library.closeAll();
});

test('foreign senders cannot mutate or request raw credentials and rejected changes do not publish', async () => {
  const h = await harness(); const before = h.library.snapshot(h.doc.id).seq;
  for (const channel of ['documents:add', 'documents:update', 'documents:snapshot']) await assert.rejects(h.handlers.get(channel)!('foreign', { id: h.doc.id, password: 'canary' }), /Access denied/);
  assert.equal(h.handlers.has('documents:reveal-all'), false); assert.equal(h.handlers.has('credentials:password'), false);
  assert.equal((await h.call('documents:add', { id: h.doc.id, parentId: null, type: 'credential', name: 'No', props: {} })).code, 'invalid');
  assert.equal(h.library.snapshot(h.doc.id).seq, before);
  const connection = await h.call('documents:add', { id: h.doc.id, parentId: null, type: 'connection', name: 'RDP', props: toProps({ ...DEFAULT_RDP, host: 'example.invalid', username: 'ops' }) });
  assert.equal(connection.ok, true);
  h.library.closeAll();
});

test('handler reports fixed codes only, including nested third-party causes', async () => {
  const h = await harness();
  const on = handlerFor({ library: h.library, ipc: { handle: (channel, listener) => h.handlers.set(channel, listener) }, check: () => undefined, report: (error) => h.reports.push(error) });
  on('fixture:failure', async () => { throw new LibraryError('io', 'password-canary', new Error('seed-canary')); });
  const answer = await h.handlers.get('fixture:failure')!('owner', { id: h.doc.id });
  assert.equal(answer.code, 'io'); assert.doesNotMatch(JSON.stringify([answer, h.reports]), /canary|cause|stack|password|seed/);
  assert.deepEqual(Object.keys(h.reports[0] as object), ['code']);
  h.library.closeAll();
});
