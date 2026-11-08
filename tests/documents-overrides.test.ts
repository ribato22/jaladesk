import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OverrideError, OverrideSession } from '../src/documents/overrides.js';
import { DocumentSession } from '../src/documents/session.js';
import { realFs, type StoreFs } from '../src/documents/store.js';
import { parseDocument, type Doc2 } from '../src/documents/model.js';
import { resolveEffective } from '../src/documents/effective.js';
import { resolveCredential } from '../src/credentials/resolve.js';
import { seal } from '../src/documents/envelope.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const kdf = { logN: 14, r: 8, p: 1 };
const target = { documentId: id(1), objectId: id(2) };
const workspace = (): Doc2 => ({ schemaVersion: 2, id: id(1), kind: 'workspace', name: 'shared', revision: 0, meta: { createdAt: null, updatedAt: null, sort: [] }, defaults: { groups: {} }, secrets: {}, objects: { [id(2)]: { id: id(2), type: 'connection', name: 'host', parentId: null, order: 0, props: { host: '127.0.0.1' } } } });
const pathFor = async (name = 'private') => join(await mkdtemp(join(tmpdir(), 'rw-overrides-')), `${name}.rwdoc`);
const refuses = (code: string) => (e: unknown) => e instanceof OverrideError && e.code === code;

test('private overlays leave shared bytes/history untouched and are isolated per file/user', async () => {
  const shared = await pathFor('shared');
  const ws = await DocumentSession.create(shared, workspace(), 'shared-pass', { kdf }); ws.dispose();
  const before = await readFile(shared);
  const aPath = await pathFor('a'), bPath = await pathFor('b');
  const a = await OverrideSession.create(aPath, 'a-pass', { kdf, id: id(10) });
  const b = await OverrideSession.create(bPath, 'b-pass', { kdf, id: id(11) });
  a.set(target, { notes: 'PRIVATE A', color: false }, a.state.seq);
  b.set(target, { notes: 'PRIVATE B' }, b.state.seq);
  assert.equal((await a.save(a.state.seq)).saved, true);
  assert.equal((await b.save(b.state.seq)).saved, true);
  assert.deepEqual(await readFile(shared), before);
  assert.equal((await readFile(aPath)).includes(Buffer.from('PRIVATE A')), false);
  assert.equal((await stat(aPath)).mode & 0o777, 0o600);
  assert.equal(a.layer(target)?.groups.notes, 'PRIVATE A');
  assert.equal(b.layer(target)?.groups.notes, 'PRIVATE B');
  assert.equal(JSON.stringify(a.state).includes('PRIVATE'), false);
  a.close(); b.close();
});

test('clear, explicit false and absent group differ; pair identity survives rename but not cloned document', async () => {
  const p = await pathFor(); const a = await OverrideSession.create(p, 'pw', { kdf });
  a.set(target, { notes: '', color: false, customField1: false }, a.state.seq);
  a.set(target, { notes: 'second' }, a.state.seq);
  assert.deepEqual(a.layer(target)?.groups, { notes: 'second', color: false, customField1: false });
  assert.equal(Object.keys(a.privateDocument().doc.objects).length, 1, 'one namespace per pair');
  const ws = workspace(); ws.objects[id(2)]!.name = 'renamed';
  assert.deepEqual(a.validateTargets([ws]), []);
  assert.equal(a.layer({ ...target, documentId: id(999) }), undefined);
  a.clear(target, ['notes'], a.state.seq);
  assert.deepEqual(a.layer(target)?.groups, { color: false, customField1: false });
  const seq = a.state.seq; a.clear(target, ['notes'], seq); assert.equal(a.state.seq, seq);
  await a.save(a.state.seq); a.close();
  const reopened = await OverrideSession.load(p); assert.equal(reopened.state.status, 'locked');
  assert.throws(() => reopened.layer(target), refuses('locked'));
  await reopened.unlock('pw'); assert.equal(reopened.layer(target)?.groups.color, false);
  reopened.clear(target, undefined, reopened.state.seq); assert.equal(reopened.layer(target), undefined); reopened.close();
});

test('overlay private secrets bind to their owner/generation and do not enter public state', async () => {
  const a = await OverrideSession.create(await pathFor(), 'pw', { kdf, id: id(20) });
  a.set(target, { credentials: { mode: 'inline', secretId: id(30) }, customField11: { secretId: id(31) } }, a.state.seq, {
    [id(30)]: { kind: 'credential', username: 'u', domain: '', password: 'CANARY-PRIVATE' },
    [id(31)]: { kind: 'protected-value', value: 'PROTECTED-CANARY' },
  });
  const result = resolveEffective(workspace(), id(2), { documentGeneration: 0, override: a.layer(target) });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  const binding = result.value.private.credentialBinding!;
  assert.equal(binding.ownerDocumentId, id(20)); assert.equal(binding.ownerGeneration, a.state.generation);
  assert.equal(resolveCredential(binding, { documents: [a.privateDocument()], scope: new Set() }).password, 'CANARY-PRIVATE');
  assert.equal(JSON.stringify(a.state).includes('CANARY'), false);
  const seq = a.state.seq; a.set(target, { notes: 'different' }, seq);
  assert.throws(() => resolveCredential(binding, { documents: [a.privateDocument()], scope: new Set() }), /resolution refused/);
  a.clear(target, ['credentials'], a.state.seq);
  assert.deepEqual(Object.keys(a.privateDocument().doc.secrets), [id(31)], 'unused own secret removed'); a.close();
});

test('invalid targets, duplicate pairs, stale seq and dangling or unused secret input fail atomically', async () => {
  const a = await OverrideSession.create(await pathFor(), 'pw', { kdf }); const start = a.state.seq;
  for (const bad of [{ documentId: 'name', objectId: id(2) }, { ...target, extra: 'no' }]) assert.throws(() => a.set(bad, { notes: 'x' }, start), refuses('invalid'));
  assert.throws(() => a.set(target, { credentials: { mode: 'inline', secretId: id(99) } }, start), refuses('invalid'));
  assert.throws(() => a.set(target, { notes: 'x' }, start, { [id(31)]: { kind: 'protected-value', value: 'orphan' } }), refuses('invalid'));
  assert.equal(a.state.seq, start); assert.equal(a.state.dirty, false);
  a.set(target, { notes: 'x' }, start);
  assert.throws(() => a.clear(target, undefined, start), refuses('stale'));
  const ws = workspace(); assert.deepEqual(a.validateTargets([ws]), []);
  assert.equal(a.validateTargets([{ ...ws, id: id(99) }])[0]?.code, 'missing-document');
  assert.equal(a.validateTargets([ws, structuredClone(ws)])[0]?.code, 'duplicate-document');
  delete ws.objects[id(2)]; assert.equal(a.validateTargets([ws])[0]?.code, 'missing-object'); a.close();
});

test('missing expected overlay, wrong password, corruption and closed sessions cannot silently fall back', async () => {
  const p = await pathFor(); const missing = await OverrideSession.load(p);
  assert.equal(missing.state.status, 'missing'); assert.throws(() => missing.layer(target), refuses('missing'));
  const absent = await OverrideSession.load(p, { expected: false }); assert.equal(absent.layer(target), undefined); absent.close(); missing.close();
  const a = await OverrideSession.create(p, 'pw', { kdf }); a.close();
  const locked = await OverrideSession.load(p); await assert.rejects(locked.unlock('bad'), refuses('auth'));
  assert.equal(locked.state.status, 'error'); assert.throws(() => locked.layer(target), refuses('auth'));
  await locked.unlock('pw'); locked.close(); assert.throws(() => locked.layer(target), refuses('closed'));
  await writeFile(p, 'corrupt'); const corrupt = await OverrideSession.load(p);
  await assert.rejects(corrupt.unlock('pw'), refuses('invalid')); assert.throws(() => corrupt.layer(target), refuses('invalid')); corrupt.close();
});

test('permission/disk save failure keeps previous file and dirty changes; explicit retry clears blocked use', async () => {
  const p = await pathFor(); let fail = false;
  const fs: StoreFs = { ...realFs, open: async (name, flags, mode) => { if (fail && name.endsWith('.tmp')) throw Object.assign(new Error('private io detail'), { code: 'ENOSPC' }); return realFs.open(name, flags, mode); } };
  const a = await OverrideSession.create(p, 'pw', { kdf, fs }); const old = await readFile(p);
  a.set(target, { notes: 'kept' }, a.state.seq); fail = true;
  await assert.rejects(a.save(a.state.seq), refuses('io')); assert.deepEqual(await readFile(p), old); assert.equal(a.state.dirty, true);
  assert.throws(() => a.layer(target), refuses('io')); assert.equal(JSON.stringify(a.state).includes('private io detail'), false);
  fail = false; await a.save(a.state.seq); assert.equal(a.layer(target)?.groups.notes, 'kept'); a.close();
});

test('concurrent disjoint overlay writers merge while same-group conflict is explicit and secret safe', async () => {
  const p = await pathFor(); const a = await OverrideSession.create(p, 'pw', { kdf });
  a.set(target, { notes: 'base' }, a.state.seq); await a.save(a.state.seq);
  const b = await OverrideSession.load(p, { kdf }); await b.unlock('pw');
  a.set(target, { color: 'red' }, a.state.seq); b.set(target, { customField1: 4 }, b.state.seq);
  await a.save(a.state.seq); assert.deepEqual(await b.save(b.state.seq), { saved: true, merged: true });
  assert.deepEqual(b.layer(target)?.groups, { notes: 'base', color: 'red', customField1: 4 });
  await a.reload(a.state.seq);
  a.set(target, { notes: 'SECRET A' }, a.state.seq); b.set(target, { notes: 'SECRET B' }, b.state.seq);
  await a.save(a.state.seq); const before = await readFile(p); const conflict = await b.save(b.state.seq);
  assert.equal(conflict.saved, false); assert.deepEqual(await readFile(p), before);
  assert.equal(JSON.stringify(b.state).includes('SECRET'), false); assert.throws(() => b.layer(target), refuses('conflict'));
  b.resolve(b.state.conflicts[0]!.key, 'mine', b.state.seq); await b.save(b.state.seq);
  assert.equal(b.layer(target)?.groups.notes, 'SECRET B'); a.close(); b.close();
});

test('save/edit race preserves the later edit unsaved until another save', async () => {
  const p = await pathFor(); let armed = false, release!: () => void, reached!: () => void;
  const gate = new Promise<void>(r => { release = r; }), paused = new Promise<void>(r => { reached = r; });
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (armed) { armed = false; reached(); await gate; } await realFs.rename(from, to); } };
  const a = await OverrideSession.create(p, 'pw', { kdf, fs });
  a.set(target, { notes: 'first' }, a.state.seq); armed = true; const saving = a.save(a.state.seq); await paused;
  a.set(target, { color: 'red' }, a.state.seq); release(); await saving;
  assert.equal(a.state.dirty, true); assert.equal(a.layer(target)?.groups.color, 'red');
  await a.save(a.state.seq); assert.equal(a.state.dirty, false); a.close();
});

test('a file with duplicate target pairs or foreign nodes is rejected before use', async () => {
  const p = await pathFor(); const doc = workspace(); doc.kind = 'overrides';
  for (const n of [3, 4]) doc.objects[id(n)] = { id: id(n), type: 'override', name: '', parentId: null, order: n, props: { target, groups: { notes: 'x' } } };
  const sealed = await seal(Buffer.from(JSON.stringify(doc)), 'pw', { kdf }); sealed.unlocked.dispose(); await writeFile(p, sealed.file);
  const a = await OverrideSession.load(p); await assert.rejects(a.unlock('pw'), refuses('invalid')); a.close();
  delete doc.objects[id(2)];
  const again = await seal(Buffer.from(JSON.stringify(doc)), 'pw', { kdf }); again.unlocked.dispose(); await writeFile(p, again.file);
  const b = await OverrideSession.load(p); await assert.rejects(b.unlock('pw'), refuses('invalid')); b.close();
});

test('a foreign password change blocks stale overlay save without replacing ciphertext', async () => {
  const p = await pathFor(); const a = await OverrideSession.create(p, 'pw', { kdf });
  a.set(target, { notes: 'mine' }, a.state.seq);
  const replacement = await seal(Buffer.from(JSON.stringify(a.privateDocument().doc)), 'new-pw', { kdf }); replacement.unlocked.dispose(); await writeFile(p, replacement.file);
  const before = await readFile(p); await assert.rejects(a.save(a.state.seq), refuses('rekeyed'));
  assert.deepEqual(await readFile(p), before); assert.throws(() => a.layer(target), refuses('rekeyed')); a.close();
});

test('an external encrypted document with invalid private shape is never merged or overwritten', async () => {
  const p = await pathFor(); const a = await OverrideSession.create(p, 'pw', { kdf });
  a.set(target, { notes: 'mine' }, a.state.seq);
  const writer = await DocumentSession.open(p, { password: 'pw' }, { kdf });
  writer.update(doc => { doc.objects[id(60)] = { id: id(60), type: 'connection', name: 'foreign', parentId: null, order: 0, props: { host: 'unrelated' } }; });
  await writer.save(); writer.dispose(); const before = await readFile(p);
  await assert.rejects(a.save(a.state.seq), refuses('invalid')); assert.deepEqual(await readFile(p), before); a.close();
});

test('close during unlock cannot resurrect a private key or ready overlay', async () => {
  const p = await pathFor(); const a = await OverrideSession.create(p, 'pw', { kdf }); a.close();
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(r => { release = r; }), paused = new Promise<void>(r => { reached = r; });
  const fs: StoreFs = { ...realFs, readFile: async name => { if (name === p) { reached(); await gate; } return realFs.readFile(name); } };
  const locked = await OverrideSession.load(p, { fs }); const opening = locked.unlock('pw'); await paused; locked.close(); release();
  await assert.rejects(opening, refuses('closed')); assert.equal(locked.state.status, 'closed'); assert.throws(() => locked.privateDocument(), refuses('closed'));
});

test('external namespace id cannot create a second pair during merge', async () => {
  const p = await pathFor(); const a = await OverrideSession.create(p, 'pw', { kdf });
  a.set(target, { notes: 'mine' }, a.state.seq);
  const writer = await DocumentSession.open(p, { password: 'pw' }, { kdf });
  writer.update(doc => { doc.objects[id(70)] = { id: id(70), type: 'override', name: '', parentId: null, order: 0, props: { target, groups: { color: false } } }; });
  await writer.save(); writer.dispose(); const before = await readFile(p);
  await assert.rejects(a.save(a.state.seq), refuses('invalid')); assert.deepEqual(await readFile(p), before); a.close();
});
