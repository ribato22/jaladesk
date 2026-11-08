import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentSession } from '../src/documents/session.js';
import { createDocument, saveDocument } from '../src/documents/store.js';
import { serializeDocument, type Doc } from '../src/documents/model.js';

const kdf = { logN: 14, r: 8, p: 1 };
const id = '00000000-0000-4000-8000-000000000900';
const legacy = (): Doc => ({ schemaVersion: 1, id, kind: 'workspace', name: 'Legacy', revision: 0, objects: {} });
async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), 'c1-consent-')), 'legacy.rwdoc');
  const handle = await createDocument(path, serializeDocument(legacy()), 'synthetic', { kdf });
  return { path, handle, bytes: await readFile(path) };
}
test('v1 opens as v2 in memory without rewriting or inventing dates; autosave and close-save require upgrade consent', async () => {
  const f = await fixture();
  const session = await DocumentSession.open(f.path, { password: 'synthetic' }, { kdf });
  try {
    assert.equal(session.doc.schemaVersion, 2);
    assert.equal((session as any).sourceSchema, 1);
    assert.deepEqual((session.doc as any).meta, { createdAt: null, updatedAt: null, sort: [] });
    session.update(d => { d.name = 'Changed'; });
    for (const auto of [true, false]) await assert.rejects(session.save({ auto }), { code: 'upgrade-required' });
    assert.deepEqual(await readFile(f.path), f.bytes);
    (session as any).approveUpgrade(session.handle.digest);
    assert.deepEqual(await session.save(), { saved: true });
    assert.equal((session as any).sourceSchema, 2);
    const reopened = await DocumentSession.open(f.path, { password: 'synthetic' }, { kdf });
    assert.equal(reopened.doc.schemaVersion, 2); assert.equal(reopened.doc.name, 'Changed'); reopened.dispose();
  } finally { session.dispose(); f.handle.unlocked.dispose(); }
});
test('a foreign writer invalidates digest-bound upgrade consent and cannot be silently overwritten', async () => {
  const f = await fixture(); const session = await DocumentSession.open(f.path, { password: 'synthetic' }, { kdf });
  try {
    assert.equal(typeof (session as any).approveUpgrade, 'function');
    session.update(d => { d.name = 'Mine'; });
    (session as any).approveUpgrade(session.handle.digest);
    await saveDocument(f.handle, serializeDocument({ ...legacy(), revision: 1 }), { kdf });
    const foreign = await readFile(f.path);
    await assert.rejects(session.save(), { code: 'upgrade-required' });
    assert.deepEqual(await readFile(f.path), foreign);
    (session as any).approveUpgrade(session.handle.digest);
    assert.equal((await session.save()).saved, true);
  } finally { session.dispose(); f.handle.unlocked.dispose(); }
});
test('a failed save consumes upgrade consent; source schema changes only after successful write', async () => {
  const f = await fixture(); const session = await DocumentSession.open(f.path, { password: 'synthetic' }, { kdf });
  try {
    assert.equal(typeof (session as any).approveUpgrade, 'function');
    assert.throws(() => (session as any).approveUpgrade('wrong-digest'), { code: 'upgrade-required' });
    (session as any).approveUpgrade(session.handle.digest);
    session.handle.unlocked.dispose();
    await assert.rejects(session.save());
    assert.equal((session as any).sourceSchema, 1);
    await assert.rejects(session.save(), { code: 'upgrade-required' });
    assert.deepEqual(await readFile(f.path), f.bytes);
  } finally { session.dispose(); f.handle.unlocked.dispose(); }
});
