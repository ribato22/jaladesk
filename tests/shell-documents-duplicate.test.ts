import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DocumentLibrary } from '../src/documents/library.js';
import type { SecretBox } from '../src/documents/keywrap.js';
import * as ipcModule from '../src/desktop/documents-ipc.js';
import { registerDocumentIpc, type Dialogs, type PasswordAnswer, type PasswordRequest } from '../src/desktop/documents-ipc.js';
import { Keystore } from '../src/desktop/keystore.js';
import { Recent } from '../src/desktop/recent.js';

// Real encrypted files, native-dialog seam and a fake seal. No OS keystore or renderer paths.
const kdf = { logN: 14, r: 8, p: 1 };
const oldPassword = 'fixture-old-password';
const newPassword = 'fixture-new-password';
async function harness(t: TestContext, useKeys = false) {
  const dir = await mkdtemp(join(tmpdir(), 'rwduplicate-ipc-'));
  const library = new DocumentLibrary({ kdf });
  t.after(async () => { library.closeAll(); await rm(dir, { recursive: true, force: true }); });
  const originalPath = join(dir, 'original.rwdoc'), sourcePath = join(dir, 'duplicate.rwdoc');
  const original = await library.create(originalPath, 'Lab', oldPassword);
  await copyFile(originalPath, sourcePath);
  const originalBytes = await readFile(originalPath), sourceBytes = await readFile(sourcePath);
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<any>>();
  const state = {
    choice: 'skip' as 'skip' | 'cancel' | 'copy', choices: [] as string[],
    answers: [oldPassword] as (PasswordAnswer | undefined)[], asked: [] as PasswordRequest[],
    savePath: join(dir, 'independent') as string | undefined, suggested: [] as string[],
    onSave: undefined as (() => Promise<void>) | undefined, nativeCalls: 0,
  };
  const dialogs: Dialogs & { confirmDuplicate(name: string): Promise<'skip' | 'cancel' | 'copy'> } = {
    chooseOpenPath: async () => { state.nativeCalls++; return sourcePath; },
    chooseSavePath: async name => { state.nativeCalls++; state.suggested.push(name); await state.onSave?.(); return state.savePath; },
    askPassword: async request => { state.nativeCalls++; state.asked.push(request); return state.answers.shift(); },
    confirmDuplicate: async name => { state.nativeCalls++; state.choices.push(name); return state.choice; },
    confirmClose: async () => 'cancel', confirmRemove: async () => false,
  };
  const box = { seals: 0 };
  const seal: SecretBox = { available: () => true, seal: plain => { box.seals++; return Buffer.concat([Buffer.from('sealed:'), plain]); }, open: blob => blob.subarray(7) };
  const keys = new Keystore({ box: seal, dir: join(dir, 'keys'), allowed: () => true });
  const recent = Recent.memory();
  registerDocumentIpc({
    ipc: { handle: (channel, listener) => { handlers.set(channel, async (event, payload) => listener(event, payload)); } },
    check: event => { if (event !== 'window') throw new Error('Access denied'); },
    library, dialogs, recent, ...(useKeys ? { keys } : {}),
  });
  const leaks = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const forbidden of [dir, oldPassword, newPassword]) assert.ok(!value.includes(forbidden), 'renderer reply contains private input');
    } else if (Array.isArray(value)) value.forEach(leaks);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      assert.ok(!['path', 'password', 'key', 'secret', 'digest', 'duplicateStamp'].includes(key), `renderer key ${key}`); leaks(item);
    }
  };
  const call = async (channel = 'documents:open', payload?: unknown) => { const reply = await handlers.get(channel)!('window', payload); leaks(reply); return reply; };
  const unchanged = async () => { assert.deepEqual(await readFile(originalPath), originalBytes); assert.deepEqual(await readFile(sourcePath), sourceBytes); };
  return { dir, library, original, originalPath, sourcePath, sourceBytes, handlers, state, keys, box, recent, call, unchanged };
}

test('duplicate ID offers explicit skip or cancel without opening the first document or writing a copy', async t => {
  for (const choice of ['skip', 'cancel'] as const) {
    const h = await harness(t); h.state.choice = choice;
    const reply = await h.call();
    if (choice === 'skip') assert.deepEqual(reply, { ok: true, skipped: true, note: 'Dokumen dengan ID sama dilewati.' });
    else assert.equal(reply.code, 'cancelled');
    assert.deepEqual(h.state.choices, [basename(h.sourcePath)]);
    assert.deepEqual(h.state.suggested, []);
    assert.equal(h.library.views().length, 1);
    assert.equal(h.library.views()[0]!.id, h.original.id);
    await h.unchanged();
  }
});

test('duplicate native question makes Enter skip and Escape cancel, with copy an explicit third choice', () => {
  const question = (ipcModule as unknown as { duplicateQuestion?: (name: string) => ipcModule.Question }).duplicateQuestion;
  assert.equal(typeof question, 'function');
  const view = question!('Lab');
  assert.deepEqual(view.buttons, ['Lewati', 'Batal', 'Buka sebagai salinan']);
  assert.equal(view.defaultId, 0); assert.equal(view.cancelId, 1);
  assert.match(view.message, /Lab/); assert.match(view.detail, /ID baru/);
});

test('explicit copy creates a separately encrypted document with a new ID, no remembered key and unchanged source', async t => {
  const h = await harness(t, true); h.state.choice = 'copy';
  h.state.answers.push({ password: newPassword, remember: true });
  const reply = await h.call('documents:open', { path: '/ignored/path', password: 'ignored' });
  assert.equal(reply.ok, true); assert.ok(reply.snapshot);
  assert.notEqual(reply.snapshot.docId, h.library.snapshot(h.original.id).docId);
  assert.equal(h.library.views().length, 2);
  assert.deepEqual(h.state.suggested, ['duplicate salinan.rwdoc']);
  assert.deepEqual(h.state.asked, [
    { purpose: 'open', name: 'duplicate.rwdoc', rememberable: true },
    { purpose: 'create', name: 'independent.rwdoc' },
  ]);
  assert.equal(h.box.seals, 0, 'copy never offers or honors OS remember');
  const reader = new DocumentLibrary({ kdf });
  try {
    const copy = await reader.open(`${h.state.savePath}.rwdoc`, newPassword);
    assert.equal(reader.snapshot(copy.id).docId, reply.snapshot.docId);
  } finally { reader.closeAll(); }
  await h.unchanged();
});

test('remembered duplicate still asks the old password for copying and retries it without remembering the new key', async t => {
  const h = await harness(t, true), primer = new DocumentLibrary({ kdf });
  try { const source = await primer.open(h.sourcePath, oldPassword); await primer.rememberKey(source.id, h.keys.cache); }
  finally { primer.closeAll(); }
  const seals = h.box.seals; h.state.choice = 'copy';
  h.state.answers = ['fixture-wrong-password', { password: newPassword, remember: true }, oldPassword];
  const reply = await h.call();
  assert.equal(reply.ok, true); assert.ok(reply.snapshot);
  assert.deepEqual(h.state.asked, [
    { purpose: 'open', name: 'duplicate.rwdoc' },
    { purpose: 'create', name: 'independent.rwdoc' },
    { purpose: 'open', name: 'duplicate.rwdoc', error: 'Password salah, atau berkas telah diubah.' },
  ]);
  assert.equal(h.box.seals, seals, 'only the earlier fixture key was kept');
  assert.equal(h.library.views().length, 2);
  await h.unchanged();
});

test('cancelling Save As, the new password or the remembered-source password leaves no copy', async t => {
  for (const at of ['save', 'new', 'old'] as const) {
    const h = await harness(t, at === 'old'); h.state.choice = 'copy';
    if (at === 'save') h.state.savePath = undefined;
    if (at === 'new') h.state.answers.push(undefined);
    if (at === 'old') {
      const primer = new DocumentLibrary({ kdf });
      try { const source = await primer.open(h.sourcePath, oldPassword); await primer.rememberKey(source.id, h.keys.cache); }
      finally { primer.closeAll(); }
      h.state.answers = [undefined];
    }
    assert.equal((await h.call()).code, 'cancelled', at);
    assert.ok(!(await readdir(h.dir)).includes('independent.rwdoc'));
    assert.equal(h.library.views().length, 1);
    await h.unchanged();
  }
});

test('a taken destination is refused before the new password and never overwrites the source file', async t => {
  const h = await harness(t); h.state.choice = 'copy'; h.state.savePath = h.sourcePath;
  assert.equal((await h.call()).code, 'exists');
  assert.equal(h.state.asked.length, 1);
  assert.equal(h.library.views().length, 1);
  await h.unchanged();
});

test('copy is bound to the exact duplicate reviewed before native dialogs, even if its path is replaced', async t => {
  const h = await harness(t); h.state.choice = 'copy'; h.state.answers.push(newPassword);
  const otherPath = join(h.dir, 'other.rwdoc');
  await h.library.create(otherPath, 'Other lab', oldPassword);
  h.state.onSave = async () => copyFile(otherPath, h.sourcePath);
  const reply = await h.call();
  assert.equal(reply.ok, false); assert.equal(reply.code, 'invalid');
  assert.ok(!(await readdir(h.dir)).includes('independent.rwdoc'));
  assert.equal(h.library.views().length, 2, 'neither the first document nor the replacement is silently duplicated');
  assert.deepEqual(await readFile(h.originalPath), h.sourceBytes);
  assert.deepEqual(await readFile(h.sourcePath), await readFile(otherPath), 'IPC never rewrites the replaced source');
});

test('the same duplicate chooser handles a recent file after its native menu choice; stranger and renderer paths have no authority', async t => {
  const h = await harness(t); h.state.choice = 'copy'; h.state.answers.push(newPassword);
  for (const channel of ['documents:open', 'documents:open-recent']) await assert.rejects(h.handlers.get(channel)!('stranger', {}), /Access denied/);
  assert.equal(h.state.nativeCalls, 0);
  await h.recent.add(h.sourcePath);
  assert.equal((await h.call('documents:open-recent', { index: 0 })).code, 'invalid');
  assert.equal(h.state.nativeCalls, 0, 'a renderer request without the native recent-menu click does nothing');
  h.recent.choose(0);
  const reply = await h.call('documents:open-recent', { index: 0, path: '/ignored/path', oldPassword: 'ignored', newPassword: 'ignored' });
  assert.equal(reply.ok, true); assert.ok(reply.snapshot);
  assert.equal(h.library.views().length, 2);
  assert.deepEqual(h.state.choices, ['duplicate.rwdoc']);
  assert.equal(h.recent.list()[0]!.path, `${h.state.savePath}.rwdoc`);
  await h.unchanged();
});
