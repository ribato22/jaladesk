import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { DocumentLibrary } from '../src/documents/library.js';
import type { SecretBox } from '../src/documents/keywrap.js';
import { messageFor, registerDocumentIpc, type Dialogs, type PasswordRequest } from '../src/desktop/documents-ipc.js';
import { Keystore } from '../src/desktop/keystore.js';
import { CHOICE_MS, Recent } from '../src/desktop/recent.js';
import { realFs, type StoreFs } from '../src/documents/store.js';

// What package 02-B3b adds to the documents: the key that the system remembers (asked first when a document is opened, offered in the prompt for the password, forgotten on request) and the list of recent
// documents (opened by their place in the list). The keystore of the system is never used here: a seal that only prefixes stands in for it.
const kdf = { logN: 14, r: 8, p: 1 };
type Answer = string | { password: string; remember: boolean } | undefined;

async function harness(options: { keys?: boolean; recent?: boolean; allowed?: boolean; now?: () => number; fs?: StoreFs; recentFile?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rwipckeys-'));
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<any>>();
  const library = new DocumentLibrary({ kdf, ...(options.fs ? { fs: options.fs } : {}) });
  const box = { available: true, seals: 0, fail: false };
  const seal: SecretBox = {
    available: () => box.available,
    seal: (plain) => { if (box.fail) throw new Error('the keystore refused'); box.seals++; return Buffer.concat([Buffer.from('sealed:'), plain]); },
    open: (blob) => blob.subarray(7),
  };
  const settings = { allowed: options.allowed ?? true };
  const keystore = new Keystore({ box: seal, dir: join(dir, 'keys'), allowed: () => settings.allowed });
  const recent = options.recentFile ? await Recent.open(join(dir, 'recent.json'), options.now ? { now: options.now } : {}) : Recent.memory(options.now ? { now: options.now } : {});
  const state = {
    savePath: join(dir, 'lab.rwdoc') as string | undefined, openPath: undefined as string | undefined,
    answers: [] as Answer[], asked: [] as PasswordRequest[], reported: [] as unknown[], dialogCalls: 0, onAsk: undefined as (() => void) | undefined,
  };
  const dialogs: Dialogs = {
    chooseOpenPath: async () => { state.dialogCalls++; return state.openPath; },
    chooseSavePath: async () => { state.dialogCalls++; return state.savePath; },
    askPassword: async (request) => { state.dialogCalls++; state.asked.push(request); state.onAsk?.(); return state.answers.shift(); },
    confirmClose: async () => 'save',
    confirmRemove: async () => true,
  };
  const check = (event: unknown) => { if (event === 'stranger') throw new Error('Access denied'); };
  registerDocumentIpc({
    ipc: { handle: (channel, listener) => { handlers.set(channel, async (event, payload) => listener(event, payload)); } }, check, library, dialogs, report: (error) => { state.reported.push(error); },
    ...(options.keys === false ? {} : { keys: keystore }), ...(options.recent === false ? {} : { recent }),
  });
  const leaks = (value: unknown, found: string[] = []): string[] => {
    if (typeof value === 'string') { if (value.includes(dir)) found.push(value); }
    else if (Array.isArray(value)) value.forEach((item) => leaks(item, found));
    else if (typeof value === 'object' && value !== null) for (const [key, item] of Object.entries(value)) { if (['path', 'password', 'key', 'secret'].includes(key)) found.push(`key ${key}`); leaks(item, found); }
    return found;
  };
  const call = async (channel: string, payload?: unknown) => {
    const reply = await handlers.get(channel)!('window', payload);
    assert.deepEqual(leaks(reply), [], `${channel} gave the renderer something it must not have`);
    return reply;
  };
  return { dir, handlers, library, state, call, keystore, recent, box, settings };
}
const keyFiles = async (dir: string) => (await readdir(join(dir, 'keys')).catch(() => [])).filter((n) => n.endsWith('.key'));

test('the two new channels exist only when what they need is there, and refuse a stranger before anything else', async () => {
  const bare = await harness({ keys: false, recent: false });
  assert.equal(bare.handlers.has('documents:open-recent'), false);
  assert.equal(bare.handlers.has('documents:forget-key'), false);
  const full = await harness();
  assert.equal(full.handlers.has('documents:open-recent'), true);
  assert.equal(full.handlers.has('documents:forget-key'), true);
  for (const channel of ['documents:open-recent', 'documents:forget-key']) await assert.rejects(full.handlers.get(channel)!('stranger', {}), /Access denied/, channel);
  assert.equal(full.state.dialogCalls, 0);
});

test('while the keys are not allowed nothing about them shows: the prompt does not offer to remember, the keystore is not asked, and nothing is kept', async () => {
  const h = await harness({ allowed: false });
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  const created = await h.call('documents:create', { name: 'Lab' });
  assert.equal(created.ok, true);
  assert.deepEqual(h.state.asked, [{ purpose: 'create', name: 'Lab' }], 'no mention of remembering');
  assert.deepEqual(Object.keys(created).sort(), ['ok', 'snapshot']);
  assert.equal(h.box.seals, 0);
  assert.deepEqual(await keyFiles(h.dir), [], 'a prompt that says "remember" when the feature is off is not believed');
});

test('create: when keys are used the prompt offers to remember, and a yes keeps the key so that the next opening asks for nothing', async () => {
  const h = await harness();
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  const created = await h.call('documents:create', { name: 'Lab' });
  assert.equal(created.ok, true);
  assert.deepEqual(h.state.asked, [{ purpose: 'create', name: 'Lab', rememberable: true }]);
  assert.equal((await keyFiles(h.dir)).length, 1);
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  const reopened = await h.call('documents:open');
  assert.equal(reopened.ok, true);
  assert.equal(reopened.snapshot.name, 'Lab');
  assert.equal(h.state.asked.length, 1, 'no password was asked for the second time');
  assert.deepEqual(Object.keys(reopened).sort(), ['ok', 'snapshot']);
});

test('a no, or a plain answer without a choice, keeps nothing and the password is asked for next time', async () => {
  const h = await harness();
  h.state.answers.push({ password: 'sandi-uji-1', remember: false });
  const created = await h.call('documents:create', { name: 'Lab' });
  assert.deepEqual(await keyFiles(h.dir), []);
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push('sandi-uji-1');       // an answer that is a string is a password and no choice
  const reopened = await h.call('documents:open');
  assert.equal(reopened.ok, true);
  assert.equal(h.state.asked.length, 2, 'asked again');
  assert.deepEqual(h.state.asked[1], { purpose: 'open', name: 'lab.rwdoc', rememberable: true });
  assert.deepEqual(await keyFiles(h.dir), []);
});

test('open: a password that is wrong is asked for again with the reason, and the key is kept only for the one that was right', async () => {
  const h = await harness();
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push({ password: 'salah-sekali', remember: true }, { password: 'sandi-uji-1', remember: true });
  const opened = await h.call('documents:open');
  assert.equal(opened.ok, true);
  assert.equal(h.state.asked.length, 3);
  assert.equal(h.state.asked[1]!.error, undefined);
  assert.match(h.state.asked[2]!.error!, /salah/i);
  assert.equal((await keyFiles(h.dir)).length, 1);
});

test('a key that went stale because the file was made again with another password is no key: the password is asked for and a new key can be kept', async () => {
  const h = await harness();
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  await rm(join(h.dir, 'lab.rwdoc'));
  h.state.answers.push({ password: 'sandi-baru-2', remember: false });
  h.state.savePath = join(h.dir, 'lab.rwdoc');
  const second = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: second.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push({ password: 'sandi-baru-2', remember: true });
  const asked = h.state.asked.length;
  const opened = await h.call('documents:open');
  assert.equal(opened.ok, true);
  assert.equal(h.state.asked.length, asked + 1, 'the old key did not open it: the password was asked for');
  assert.equal((await keyFiles(h.dir)).length, 1, 'and the key of the new file replaced the old one');
});

test('a keystore that will not seal does not fail the opening: the document is open, and the person is told the key was not kept', async () => {
  const h = await harness();
  h.box.fail = true;
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  const created = await h.call('documents:create', { name: 'Lab' });
  assert.equal(created.ok, true);
  assert.equal(h.library.views().length, 1);
  assert.match(created.note, /tidak dapat diingat/);
  assert.equal(h.state.reported.length, 1, 'and the main process was told why');
  assert.deepEqual(await keyFiles(h.dir), []);
  h.box.fail = false;
  h.box.available = false;
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push('sandi-uji-1');
  const opened = await h.call('documents:open');
  assert.deepEqual(h.state.asked.at(-1), { purpose: 'open', name: 'lab.rwdoc' }, 'a keystore that is not there: no offer');
  assert.equal(opened.note, undefined);
});

test('a prompt that says remember when the keys are not used is not believed when the document is opened either', async () => {
  const h = await harness({ allowed: false });
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  const opened = await h.call('documents:open');
  assert.equal(opened.ok, true);
  assert.deepEqual(await keyFiles(h.dir), []);
  assert.equal(h.box.seals, 0);
  assert.equal(opened.note, undefined);
});

test('a keystore that is there when the prompt is asked and gone when the key is to be kept does not fail the opening, and the person is told', async () => {
  const h = await harness();
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  h.state.onAsk = () => { h.box.available = false; };      // the keystore goes while the prompt is open
  const opened = await h.call('documents:open');
  assert.equal(opened.ok, true);
  assert.match(opened.note, /tidak dapat diingat/);
  assert.deepEqual(await keyFiles(h.dir), []);
});

test('a key is forgotten for one document: the answer says whether there was one, and the next opening asks for the password', async () => {
  const h = await harness();
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  const created = await h.call('documents:create', { name: 'Lab' });
  assert.deepEqual(await h.call('documents:forget-key', { id: created.snapshot.id }), { ok: true, forgot: true });
  assert.deepEqual(await keyFiles(h.dir), []);
  assert.deepEqual(await h.call('documents:forget-key', { id: created.snapshot.id }), { ok: true, forgot: false });
  assert.equal((await h.call('documents:forget-key', { id: '00000000-0000-4000-8000-000000000000' })).code, 'unknown-document');
  assert.equal((await h.call('documents:forget-key', { id: 'not-an-id' })).code, 'invalid');
  assert.equal((await h.call('documents:forget-key', {})).code, 'invalid');
  assert.equal(h.library.views().length, 1, 'the document stays open');
  h.settings.allowed = false;
  assert.deepEqual(await h.call('documents:forget-key', { id: created.snapshot.id }), { ok: true, forgot: false }, 'forgetting is asked for and answered whatever the setting says');
});

test('the recent documents: a document that is opened or created goes to the top of the list as a path, with no name of the document in it', async () => {
  const h = await harness();
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  assert.deepEqual(h.recent.list(), [{ path: join(h.dir, 'lab.rwdoc') }]);
  assert.ok(!JSON.stringify(h.recent.list()).includes('"name"'), 'the name of the document is inside the encrypted file and stays there');
  h.state.savePath = join(h.dir, 'kantor.rwdoc');
  h.state.answers.push('sandi-uji-2');
  await h.call('documents:create', { name: 'Kantor' });
  assert.deepEqual(h.recent.list().map((i) => basename(i.path)), ['kantor.rwdoc', 'lab.rwdoc']);
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push('sandi-uji-1');
  await h.call('documents:open');
  assert.deepEqual(h.recent.list().map((i) => basename(i.path)), ['lab.rwdoc', 'kantor.rwdoc'], 'opened again: back to the top');
  assert.equal((await h.call('documents:open')).code, 'already-open');
  h.state.openPath = join(h.dir, 'tidak-ada.rwdoc');
  assert.equal((await h.call('documents:open')).code, 'not-found');
  assert.deepEqual(h.recent.list().map((i) => basename(i.path)), ['lab.rwdoc', 'kantor.rwdoc'], 'what failed to open is not added');
});

test('a recent document is opened by its place in the list: the file dialog is not shown, and the renderer never names a path', async () => {
  const h = await harness();
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  const before = h.state.dialogCalls;
  h.state.answers.push('sandi-uji-1');
  h.recent.choose(0);      // the person chose the place in the menu
  const opened = await h.call('documents:open-recent', { index: 0, path: '/etc/passwd' });
  assert.equal(opened.ok, true);
  assert.equal(opened.snapshot.name, 'Lab');
  assert.equal(h.state.dialogCalls, before + 1, 'only the password was asked for');
  assert.equal(h.library.views().length, 1);
  h.recent.choose(0);
  assert.deepEqual(await h.call('documents:open-recent', { index: 0 }).then((r) => r.code), 'already-open');
});

test('a recent document that is opened with a remembered key asks for nothing at all', async () => {
  const h = await harness();
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  const before = h.state.dialogCalls;
  h.recent.choose(0);
  const opened = await h.call('documents:open-recent', { index: 0 });
  assert.equal(opened.ok, true);
  assert.equal(h.state.dialogCalls, before, 'no dialog');
});

test('a recent document whose file is gone is told so before any password is asked for, also when no key is remembered, and it leaves the list', async () => {
  const h = await harness({ allowed: false });
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  await rm(join(h.dir, 'lab.rwdoc'));
  const asked = h.state.asked.length;
  h.recent.choose(0);
  const reply = await h.call('documents:open-recent', { index: 0 });
  assert.deepEqual([reply.ok, reply.code], [false, 'not-found']);
  assert.equal(h.state.asked.length, asked, 'no password was asked for a file that is not there');
  assert.deepEqual(h.recent.list(), []);
});

test('a place that is not in the list is not the first one, and the words about it are the fixed ones', async () => {
  const h = await harness();
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  const reply = await h.call('documents:open-recent', { index: 5 });
  assert.deepEqual([reply.ok, reply.code, reply.message], [false, 'unknown-recent', 'Dokumen itu sudah tidak ada di daftar terbaru.']);
  assert.equal(h.library.views().length, 0, 'nothing was opened');
  assert.equal(messageFor('unknown-recent'), 'Dokumen itu sudah tidak ada di daftar terbaru.');
  assert.equal(messageFor('key-not-kept'), 'Dokumen terbuka, tetapi kuncinya tidak dapat diingat di komputer ini.');
});

test('a place that is not in the list is refused, a place that is not a place is invalid, and a file that is gone is taken off the list', async () => {
  const h = await harness();
  assert.equal((await h.call('documents:open-recent', { index: 0 })).code, 'unknown-recent');
  for (const bad of [undefined, null, 'x', {}, { index: -1 }, { index: 10 }, { index: 1.5 }, { index: '0' }, { index: null }, { index: Number.NaN }, [], { index: [0] }]) assert.equal((await h.call('documents:open-recent', bad)).code, 'invalid', JSON.stringify(bad));
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  await rm(join(h.dir, 'lab.rwdoc'));
  assert.equal(h.recent.list().length, 1);
  h.recent.choose(0);
  assert.equal((await h.call('documents:open-recent', { index: 0 })).code, 'not-found');
  assert.deepEqual(h.recent.list(), [], 'the file is not there: it does not stay in the list');
  assert.equal((await h.call('documents:open-recent', { index: 0 })).code, 'unknown-recent');
  await writeFile(join(h.dir, 'rusak.rwdoc'), 'bukan dokumen');
  await h.recent.add(join(h.dir, 'rusak.rwdoc'));
  h.recent.choose(0);
  assert.notEqual((await h.call('documents:open-recent', { index: 0 })).ok, true);
  assert.equal(h.recent.list().length, 1, 'a file that is there but is not a document stays: it may be mended');
});

// The independent review of the spike (slice 2): the window cannot open a recent document without a click of the person, the keys are asked about at the moment they are used, and a file that cannot be looked at is not a file that is gone.
test('a recent document is opened only when the person chose it in the menu: the window cannot choose for itself, a choice is used once, it is for one document, and it runs out', async () => {
  let now = 5_000_000;
  const h = await harness({ now: () => now });
  h.state.answers.push('sandi-uji-1');
  const first = await h.call('documents:create', { name: 'Lab' });
  h.state.savePath = join(h.dir, 'kantor.rwdoc');
  h.state.answers.push('sandi-uji-2');
  const second = await h.call('documents:create', { name: 'Kantor' });
  await h.call('documents:close', { id: first.snapshot.id });
  await h.call('documents:close', { id: second.snapshot.id });
  const before = h.state.dialogCalls;
  const denied = await h.call('documents:open-recent', { index: 0 });
  assert.deepEqual([denied.ok, denied.code], [false, 'invalid'], 'nobody chose it');
  assert.equal(h.state.dialogCalls, before, 'no password was asked for a document nobody chose');
  assert.equal(h.library.views().length, 0);
  h.recent.choose(1);
  assert.equal((await h.call('documents:open-recent', { index: 0 })).code, 'invalid', 'the person chose the other place');
  h.recent.choose(0);
  now += CHOICE_MS + 1;
  assert.equal((await h.call('documents:open-recent', { index: 0 })).code, 'invalid', 'a choice runs out');
  h.recent.choose(0);
  h.state.answers.push('sandi-uji-2');
  assert.equal((await h.call('documents:open-recent', { index: 0 })).ok, true);
  await h.call('documents:close', { id: h.library.views()[0]!.id });
  assert.equal((await h.call('documents:open-recent', { index: 0 })).code, 'invalid', 'used up by the first');
  assert.equal(h.library.views().length, 0);
});

test('a document that is remembered is not opened for the window either unless the person chose it: the key is not used for a request nobody made', async () => {
  const h = await harness();
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  assert.equal((await keyFiles(h.dir)).length, 1);
  const reply = await h.call('documents:open-recent', { index: 0 });
  assert.equal(reply.code, 'invalid');
  assert.equal(h.library.views().length, 0, 'a key that is remembered opens nothing for a window that only asks');
});

test('keys turned off while the password is asked for are honoured: the box the person ticked was offered, but the key is not kept, and they are told', async () => {
  const h = await harness();
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  h.state.onAsk = () => { h.settings.allowed = false; };      // the person turns the keys off in the settings while the prompt is open
  const opened = await h.call('documents:open');
  assert.equal(opened.ok, true);
  assert.match(opened.note, /tidak dapat diingat/);
  assert.deepEqual(await keyFiles(h.dir), []);
  assert.equal(h.box.seals, 0, 'the keystore of the system was not asked to seal anything');
});

test('a file that cannot be looked at is an I/O failure and stays in the list: only a file that is not there leaves it', async () => {
  const state = { fail: false };
  const fs: StoreFs = { ...realFs, stat: async (path) => { if (state.fail) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return realFs.stat(path); } };
  const h = await harness({ fs });
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  state.fail = true;
  const asked = h.state.asked.length;
  h.recent.choose(0);
  const reply = await h.call('documents:open-recent', { index: 0 });
  assert.deepEqual([reply.ok, reply.code], [false, 'io']);
  assert.equal(h.state.asked.length, asked, 'no password was asked for');
  assert.equal(h.recent.list().length, 1, 'the document is still in the list');
  assert.equal(h.state.reported.length, 1, 'and the main process was told why');
});

// What the review after the execution (23 October 2026) found.

test('open: a prompt that comes again after a wrong password keeps the box as the person left it, ticked or not', async () => {
  const h = await harness();
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push({ password: 'salah-satu', remember: true }, { password: 'salah-dua', remember: false }, { password: 'sandi-uji-1', remember: false });
  const opened = await h.call('documents:open');
  assert.equal(opened.ok, true);
  const prompts = h.state.asked.slice(1);      // the first prompt was the one of the new document
  assert.equal(prompts.length, 3);
  assert.deepEqual(prompts.map((request) => request.remember), [undefined, true, undefined], 'nothing is ticked at first; the box stays ticked while the person ticked it, and is not ticked again for them once they cleared it');
  assert.deepEqual(prompts.map((request) => request.rememberable), [true, true, true]);
  assert.deepEqual(await keyFiles(h.dir), [], 'the answer that was right did not ask to remember: nothing is kept');
});

test('open: nothing is ticked on a prompt that does not offer the box, whatever an earlier answer was', async () => {
  const h = await harness({ allowed: false });
  h.state.answers.push('sandi-uji-1');
  const created = await h.call('documents:create', { name: 'Lab' });
  await h.call('documents:close', { id: created.snapshot.id });
  h.state.openPath = join(h.dir, 'lab.rwdoc');
  h.state.answers.push({ password: 'salah-satu', remember: true }, 'sandi-uji-1');
  assert.equal((await h.call('documents:open')).ok, true);
  assert.deepEqual(h.state.asked.slice(1).map((request) => [request.rememberable, request.remember]), [[undefined, undefined], [undefined, undefined]]);
});

test('forgetting a key that cannot be forgotten says so in the words of a key, tells the main process what happened, and shows nothing of the files', async () => {
  const h = await harness();
  h.state.answers.push({ password: 'sandi-uji-1', remember: true });
  const created = await h.call('documents:create', { name: 'Lab' });
  assert.equal((await keyFiles(h.dir)).length, 1);
  h.keystore.forget = async () => { throw new Error(`EACCES: permission denied, unlink '${h.dir}/keys/x.key'`); };
  const reply = await h.call('documents:forget-key', { id: created.snapshot.id });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'key-not-forgotten');
  assert.equal(reply.message, messageFor('key-not-forgotten'));
  assert.match(reply.message, /kunci/i);
  assert.doesNotMatch(reply.message, /berkas tidak dapat dibaca/i, 'not the words about the file of the document');
  assert.equal(h.state.reported.length, 1, 'what went wrong stays in the main process');
  assert.equal((await keyFiles(h.dir)).length, 1, 'and the key is still there');
});

test('the list of recent documents is on the disk when the reply of an open arrives, and so is the taking off of a document that is gone', async () => {
  const h = await harness({ recentFile: true });
  const listed = async () => (JSON.parse(await readFile(join(h.dir, 'recent.json'), 'utf8')) as { items: { path: string }[] }).items.map((item) => basename(item.path));
  const make = async (file: string) => { h.state.savePath = join(h.dir, file); h.state.answers.push('sandi-uji-1'); const created = await h.call('documents:create', { name: file }); await h.call('documents:close', { id: created.snapshot.id }); };
  await make('a.rwdoc');
  await make('b.rwdoc');
  assert.deepEqual(await listed(), ['b.rwdoc', 'a.rwdoc'], 'a new document is in the file when the reply of its creation arrives');
  h.state.openPath = join(h.dir, 'a.rwdoc');
  h.state.answers.push('sandi-uji-1');
  const opened = await h.call('documents:open');
  assert.equal(opened.ok, true);
  assert.deepEqual(await listed(), ['a.rwdoc', 'b.rwdoc'], 'an open that was answered has the list in the file already');
  await h.call('documents:close', { id: opened.snapshot.id });
  await rm(join(h.dir, 'a.rwdoc'));
  h.recent.choose(0);
  assert.equal((await h.call('documents:open-recent', { index: 0 })).code, 'not-found');
  assert.deepEqual(await listed(), ['b.rwdoc'], 'and a document that is gone is off the list in the file when the reply says so');
});
