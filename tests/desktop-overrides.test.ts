import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OverrideService, type OverrideDependencies } from '../src/desktop/override-service.js';
import { OverrideError } from '../src/documents/overrides.js';
import { DocumentLibrary } from '../src/documents/library.js';
import { realFs } from '../src/documents/store.js';
import { resolveCredential } from '../src/credentials/resolve.js';
import { resolveEffective } from '../src/documents/effective.js';
import type { SecretRecord } from '../src/documents/model.js';

const kdf = { logN: 14, r: 8, p: 1 };
const refuses = (code: string) => (error: unknown) => error instanceof OverrideError && error.code === code;
async function setup(over: Partial<OverrideDependencies> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rw-override-service-'));
  const library = new DocumentLibrary({ kdf }); const doc = await library.create(join(dir, 'shared.rwdoc'), 'shared', 'pw');
  const objectId = library.add(doc.id, { type: 'connection', name: 'target', parentId: null, props: { host: '127.0.0.1' } }).objectId;
  const deps: OverrideDependencies = { path: join(dir, 'private-overrides.rwdoc'), options: { kdf }, askPassword: async () => 'private-pw', prompt: async () => ({ kind: 'credential', username: 'u', domain: '', password: 'CANARY-PRIVATE' }), confirmDirty: async () => 'cancel', confirmDisable: async () => true, ...over };
  const service = await OverrideService.load(library, deps);
  const ref = () => ({ id: doc.id, objectId, expectedSeq: library.view(doc.id).seq });
  const input = () => ({ ...ref(), overlaySeq: service.state().seq });
  return { dir, library, service, deps, ref, input };
}

test('unconfigured overlay does not touch keystore or shared bytes, creates private0600 and persists expected marker', async () => {
  const { library, service, deps, ref, input } = await setup();
  const sharedBefore = library.privateDocument(ref().id).doc;
  assert.equal(service.state().status, 'absent'); assert.deepEqual(service.layers(ref()), { overrideGeneration: 0 }); assert.deepEqual(service.privateSources(), []);
  await service.create(); assert.equal(service.state().status, 'ready');
  await service.set({ ...input(), group: 'notes', inherit: false, value: 'private-note' }); await service.save({ expectedSeq: service.state().seq });
  assert.deepEqual(library.privateDocument(ref().id).doc, sharedBefore);
  assert.equal((await stat(deps.path)).mode & 0o777, 0o600); assert.equal((await stat(`${deps.path}.enabled`)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(service.state()).includes('private-note'), false);
  await service.lock(); const again = await OverrideService.load(library, deps);
  assert.equal(again.state().status, 'locked'); assert.throws(() => again.layers(ref()), refuses('locked'));
  await again.unlock(); assert.equal(again.layers(ref()).override?.groups.notes, 'private-note'); await again.closeForWindow();
});

test('missing enabled private file stays blocked across process/service restart; disabling is explicit', async () => {
  const { library, service, deps, ref } = await setup(); await service.create(); await service.lock(); await unlink(deps.path);
  const missing = await OverrideService.load(library, deps); assert.equal(missing.state().status, 'missing');
  assert.throws(() => missing.layers(ref()), refuses('missing')); assert.equal(await missing.disable(), true);
  assert.equal(missing.state().status, 'absent'); assert.equal(missing.layers(ref()).override, undefined);
  const again = await OverrideService.load(library, deps); assert.equal(again.state().status, 'absent');
});

test('dirty lock/window close and disable honor cancel/save/discard without losing working copy', async () => {
  let decision: 'cancel' | 'save' | 'discard' = 'cancel'; let disable = false;
  const { service, input } = await setup({ confirmDirty: async () => decision, confirmDisable: async () => disable });
  await service.create(); await service.set({ ...input(), group: 'color', inherit: false, value: false });
  assert.equal(await service.lock(), false); assert.equal(await service.closeForWindow(), false); assert.equal(await service.disable(), false); assert.equal(service.state().dirty, true);
  decision = 'save'; assert.equal(await service.lock(), true); assert.equal(service.state().status, 'locked'); await service.unlock(); assert.equal(service.state().dirty, false);
  await service.set({ ...input(), group: 'notes', inherit: false, value: 'discarded' }); decision = 'discard'; disable = true;
  assert.equal(await service.disable(), true); assert.equal(service.state().status, 'absent');
});

test('private inline record is input-only; credential binding is owned by overlay, no secret id/value in state', async () => {
  const { service, library, ref, input } = await setup(); await service.create();
  await service.set({ ...input(), group: 'credentials', inherit: false, value: { mode: 'inline' } });
  const source = library.privateDocument(ref().id);
  if (source.doc.schemaVersion !== 2) throw new Error('fixture');
  const result = resolveEffective(source.doc, ref().objectId, { documentGeneration: source.generation, ...service.layers(ref()) }); assert.equal(result.ok, true);
  if (!result.ok) throw new Error('fixture');
  const binding = result.value.private.credentialBinding!; const privateSource = service.privateSources()[0]!;
  assert.equal(binding.ownerDocumentId, privateSource.doc.id); assert.equal(binding.ownerGeneration, privateSource.generation);
  assert.equal(resolveCredential(binding, { documents: [...service.privateSources()], scope: new Set() }).password, 'CANARY-PRIVATE');
  assert.equal(JSON.stringify(service.state()).includes('CANARY'), false);
  await service.save({ expectedSeq: service.state().seq }); await service.lock(); await service.unlock();
  assert.throws(() => resolveCredential(binding, { documents: service.privateSources(), scope: new Set() }), /resolution refused/, 'unlock creates a fresh owner generation');
  await service.closeForWindow();
});

test('group, target and both seq guards reject forged secret refs and stale requests atomically', async () => {
  const { service, library, ref, input } = await setup(); await service.create(); const before = service.state().seq;
  for (const bad of [
    { group: 'password', value: 'no' },
    { group: 'credentials', value: { mode: 'inline', secretId: '00000000-0000-4000-8000-000000000099' } },
    { group: 'customField11', value: { secretId: '00000000-0000-4000-8000-000000000099' } },
    { group: 'credentials', value: { mode: 'id', vaultId: '00000000-0000-4000-8000-000000000099', credentialId: '00000000-0000-4000-8000-000000000098' } },
  ]) await assert.rejects(service.set({ ...input(), inherit: false, ...bad }), refuses('invalid'));
  await assert.rejects(service.set({ ...input(), group: 'notes', inherit: false, value: 'x', extra: 'forged' }), refuses('invalid'));
  await assert.rejects(service.set({ ...input(), group: 'notes', inherit: false, value: 'x', expectedSeq: ref().expectedSeq - 1 }), refuses('stale'));
  assert.equal(service.state().seq, before);
  const stale = input(); await service.set({ ...input(), group: 'notes', inherit: false, value: 'x' });
  await assert.rejects(service.clear({ ...stale, group: 'notes' }), refuses('stale'));
  library.remove(ref().id, ref().objectId); assert.throws(() => service.layers({ ...ref() }), refuses('missing'));
});

test('changes while isolated secret prompt is open reject its result and preserve shared/private state', async () => {
  let release!: (value: SecretRecord) => void, reached!: () => void;
  const gate = new Promise<SecretRecord>(r => { release = r; }), opened = new Promise<void>(r => { reached = r; });
  const { service, library, input, ref } = await setup({ prompt: async () => { reached(); return gate; } }); await service.create();
  const pending = service.set({ ...input(), group: 'credentials', inherit: false, value: { mode: 'inline' } }); await opened;
  library.update(ref().id, ref().objectId, { name: 'changed' }); release({ kind: 'credential', username: 'u', domain: '', password: 'NOT-WRITTEN' });
  await assert.rejects(pending, refuses('stale')); assert.equal(service.state().dirty, false); assert.equal(service.layers(ref()).override, undefined);
  await service.closeForWindow();
});

test('protected empty, false and clear are distinct; canceled input creates no private value', async () => {
  let answer: SecretRecord | false | undefined = undefined;
  const { service, input, ref } = await setup({ prompt: async () => answer }); await service.create();
  assert.equal(await service.set({ ...input(), group: 'customField11', inherit: false }), false); assert.equal(service.state().dirty, false);
  answer = { kind: 'protected-value', value: '' }; await service.set({ ...input(), group: 'customField11', inherit: false });
  assert.equal(service.privateSources()[0]!.doc.schemaVersion, 2); assert.notEqual(service.layers(ref()).override?.groups.customField11, false);
  answer = false; await service.set({ ...input(), group: 'customField11', inherit: false }); assert.equal(service.layers(ref()).override?.groups.customField11, false);
  await service.clear({ ...input(), group: 'customField11' }); assert.equal(service.layers(ref()).override, undefined);
  await service.closeForWindow();
});

test('metadata failure is visible and blocks fallback; corrupt enabled marker does not disable protection', async () => {
  const { service, library, deps, ref } = await setup(); await writeFile(`${deps.path}.enabled`, 'broken');
  const bad = await OverrideService.load(library, deps); assert.equal(bad.state().status, 'error'); assert.throws(() => bad.layers(ref()), refuses('io'));
  let deny = true;
  const broken = await setup({ options: { kdf, fs: { ...realFs, open: async (path, flags, mode) => { if (deny && path.includes('.enabled')) throw new Error('private path/secret'); return realFs.open(path, flags, mode); } } } });
  await assert.rejects(broken.service.create(), refuses('io')); assert.throws(() => broken.service.layers(broken.ref()), refuses('io')); assert.equal(JSON.stringify(broken.service.state()).includes('private path'), false);
  deny = false; await service.closeForWindow();
});

test('unchanged set/clear preserves overlay seq and dirty', async () => {
  const { service, input } = await setup();
  await service.create(); await service.clear({ ...input(), group: 'notes' }); const afterClear = service.state().seq;
  await service.clear({ ...input(), group: 'notes' }); assert.equal(service.state().seq, afterClear, 'clear absent is a no-op');
  await service.set({ ...input(), group: 'notes', inherit: false, value: 'private' }); const afterSet = service.state().seq;
  await service.set({ ...input(), group: 'notes', inherit: false, value: 'private' }); assert.equal(service.state().seq, afterSet, 'set same is a no-op');
});

test('failed save cannot be discarded by unlock without an explicit dirty decision', async () => {
  let deny = false, decision: 'cancel' | 'discard' = 'cancel';
  const { service, input, ref } = await setup({ confirmDirty: async () => decision, options: { kdf, fs: { ...realFs, open: async (path, flags, mode) => { if (deny && !path.includes('.enabled') && path.endsWith('.tmp')) throw new Error('disk full'); return realFs.open(path, flags, mode); } } } });
  await service.create(); await service.set({ ...input(), group: 'notes', inherit: false, value: 'private' });
  deny = true; await assert.rejects(service.save({ expectedSeq: service.state().seq }), refuses('io'));
  deny = false; assert.equal(await service.unlock(), false, 'cancel preserves dirty working copy after failure'); assert.equal(service.state().dirty, true);
  decision = 'discard'; assert.equal(await service.unlock(), true); assert.equal(service.state().dirty, false); assert.equal(service.layers(ref()).override, undefined); await service.closeForWindow();
});
