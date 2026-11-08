import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentSession } from '../src/documents/session.js';
import { merge3 } from '../src/documents/merge.js';
import { DocumentError, type Doc2 } from '../src/documents/model.js';
import { realFs, type StoreFs } from '../src/documents/store.js';
const kdf = { logN: 14, r: 8, p: 1 };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const start = (): Doc2 => ({ schemaVersion: 2, id: id(900), kind: 'workspace', name: 'fixture', revision: 0, objects: {
  [id(1)]: { id: id(1), type: 'connection', name: 'conn', parentId: null, order: 0, props: { protocol: 'rdp', host: 'example.invalid', groups: { credentials: { mode: 'inline', secretId: id(11) } } } },
  [id(2)]: { id: id(2), type: 'credential', name: 'credential', parentId: null, order: 1, props: { secretId: id(11) } },
}, meta: { createdAt: null, updatedAt: null, sort: [] }, defaults: { groups: {} }, secrets: { [id(11)]: { kind: 'credential', username: 'lab', domain: '', password: 'SYNTHETIC-BASE-CANARY' } } });
async function fixture(t: { after: (fn: () => Promise<void>) => void }, fs?: StoreFs) {
  const dir = await mkdtemp(join(tmpdir(), 'rw-c1-session-')), path = join(dir, 'fixture.rwdoc');
  const sessions: DocumentSession[] = [];
  t.after(async () => { for (const session of sessions) session.dispose(); await rm(dir, { recursive: true, force: true }); });
  const a = await DocumentSession.create(path, start(), 'synthetic-password', { kdf, now:()=>Date.parse('2026-10-24T00:00:00.000Z'), ...(fs ? { fs } : {}) }); sessions.push(a);
  const open = async () => { const s = await DocumentSession.open(path, { password: 'synthetic-password' }, { kdf }); sessions.push(s); return s; };
  return { a, open };
}

test('v2 session apply rejects raw secret properties and leaves working copy unchanged', async t => {
  const { a } = await fixture(t), before = structuredClone(a.doc);
  assert.throws(() => a.apply({ op: 'update', id: id(1), patch: { set: { password: 'RAW-SECRET-CANARY' } } }, { newId: () => id(99) }), DocumentError);
  assert.deepEqual(a.doc, before); assert.equal(a.dirty, false);
});
test('v2 session apply rejects dangling secret references and leaves working copy unchanged', async t => {
  const { a } = await fixture(t), before = structuredClone(a.doc);
  assert.throws(() => a.apply({ op: 'update', id: id(1), patch: { set: { groups: { credentials: { mode: 'inline', secretId: id(99) } } } } }, { newId: () => id(98) }), DocumentError);
  assert.deepEqual(a.doc, before); assert.equal(a.dirty, false);
});
test('replaceWith legacy revision normalizes into schema2 and preserves legacy credential secret', async t => {
  const { a } = await fixture(t);
  const legacy = { schemaVersion: 1 as const, id: id(900), kind: 'workspace' as const, name: 'legacy', revision: 2, objects: { [id(2)]: { id: id(2), type: 'credential' as const, name: 'legacy', parentId: null, order: 0, props: { username: 'lab', domain: '', password: 'LEGACY-SECRET-CANARY' } } } };
  a.replaceWith(legacy); assert.equal(a.doc.schemaVersion, 2);
  assert.equal(Object.values((a.doc as Doc2).secrets).some(s => s.kind === 'credential' && s.password === 'LEGACY-SECRET-CANARY'), true);
  assert.equal(a.sourceSchema, 2);
});

test('root secret conflicts survive unrelated edits, refresh mine after secret edit, and remain resolvable', async t => {
  const { a, open } = await fixture(t), b = await open();
  a.update(d => { ((d as Doc2).secrets[id(11)] as any).username = 'a'; });
  b.update(d => { ((d as Doc2).secrets[id(11)] as any).password = 'B-SECRET-CANARY'; });
  assert.equal((await a.save()).saved, true); assert.equal((await b.save()).saved, false);
  assert.equal(b.conflicts.length, 1); assert.equal((b.conflicts[0] as any).field, `document.secrets.${id(11)}`);
  b.update(d => { (d as Doc2).meta.updatedAt = '2026-10-24T04:00:00.000Z'; (d as Doc2).defaults.groups.notes = 'unrelated'; });
  assert.equal(b.conflicts.length, 1);
  b.update(d => { ((d as Doc2).secrets[id(11)] as any).password = 'B-LATER-CANARY'; });
  assert.equal((b.conflicts[0] as any).mine.password, 'B-LATER-CANARY');
  b.resolve(b.conflicts[0]!, 'theirs'); assert.equal(b.conflicts.length, 0);
  assert.equal((await b.save()).saved, true); assert.equal(((await open()).doc as Doc2).secrets[id(11)]!.kind, 'credential');
});

test('merge treats referenced secret edit as an object edit when other side deletes the object', () => {
  const base = start(); delete base.objects[id(1)];
  const mine = structuredClone(base), theirs = structuredClone(base); delete mine.objects[id(2)];
  (theirs.secrets[id(11)] as any).password = 'THEIRS-CREDENTIAL-EDIT-CANARY';
  const result = merge3(base, mine, theirs);
  assert.ok(result.merged.objects[id(2)], 'credential secret edit must not be silently deleted');
  assert.ok(result.conflicts.some(c => c.kind === 'delete-edit' && c.id === id(2)));
  assert.equal(((result.merged as Doc2).secrets[id(11)] as any).password, 'THEIRS-CREDENTIAL-EDIT-CANARY');
});
test('merge preserves reference closure when deletion removes secret and concurrent edit keeps referenced object', () => {
  const base = start(); delete base.objects[id(1)];
  const mine = structuredClone(base), theirs = structuredClone(base); delete mine.objects[id(2)]; delete mine.secrets[id(11)];
  theirs.objects[id(2)]!.name = 'concurrent edit';
  const result = merge3(base, mine, theirs);
  assert.ok(result.merged.objects[id(2)]); assert.ok((result.merged as Doc2).secrets[id(11)]);
  assert.ok(result.conflicts.some(c => c.kind === 'delete-edit' && c.id === id(2)));
});

test('metadata/default/secret edits while save is latched remain unsaved until the next save', { timeout: 20_000 }, async t => {
  let arm = false, release!: () => void, reached!: () => void;
  const gate = new Promise<void>(r => { release = r; }), paused = new Promise<void>(r => { reached = r; });
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (arm) { arm = false; reached(); await gate; } await realFs.rename(from, to); } };
  const { a, open } = await fixture(t, fs);
  a.update(d => { d.name = 'first'; }); arm = true; const saving = a.save();
  await paused;
  try { a.update(d => { const v = d as Doc2; v.meta.updatedAt = '2026-10-24T05:00:00.000Z'; v.defaults.groups.color = 'blue'; (v.secrets[id(11)] as any).password = 'DURING-SAVE-CANARY'; }); } finally { release(); }
  assert.equal((await saving).saved, true); assert.equal(a.dirty, true);
  assert.equal(((a.doc as Doc2).secrets[id(11)] as any).password, 'DURING-SAVE-CANARY');
  const first = (await open()).doc as Doc2; assert.equal(first.meta.updatedAt, '2026-10-24T00:00:00.000Z'); assert.equal(first.defaults.groups.color, undefined); assert.equal((first.secrets[id(11)] as any).password, 'SYNTHETIC-BASE-CANARY');
  assert.equal((await a.save()).saved, true); assert.equal(a.dirty, false);
  const last = (await open()).doc as Doc2; assert.equal(last.meta.updatedAt, '2026-10-24T05:00:00.000Z'); assert.equal(last.defaults.groups.color, 'blue'); assert.equal((last.secrets[id(11)] as any).password, 'DURING-SAVE-CANARY');
});
