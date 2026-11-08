import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentError, validateDocument, type Doc2, type ObjectNode } from '../src/documents/model.js';
import { applyOp, OpError } from '../src/documents/ops.js';
import { compare, restoreAll, restoreObjects } from '../src/documents/restore.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, type: ObjectNode['type'] = 'connection', props: ObjectNode['props'] = {}, parentId: string | null = id(1)): ObjectNode => ({ id: id(n), type, name: `n${n}`, parentId, order: n, props });
const doc = (): Doc2 => ({ schemaVersion: 2, id: id(900), kind: 'workspace', name: 'fixture', revision: 4,
  meta: { createdAt: '2026-10-23T01:00:00.000Z', updatedAt: '2026-10-24T01:00:00.000Z', sort: [{ by: 'name', dir: 'asc' }] }, defaults: { groups: { notes: 'default' } },
  objects: { [id(1)]: node(1, 'folder', {}, null), [id(2)]: node(2, 'credential', { secretId: id(11) }),
    [id(3)]: node(3, 'connection', { groups: { credentials: { mode: 'id', vaultId: id(900), credentialId: id(2) }, customField11: { secretId: id(12) }, preConnectTask: { documentId: id(900), objectId: id(4) } }, opaque: { secretId: id(13) } }),
    [id(4)]: node(4, 'task'), [id(5)]: node(5, 'connection', { groups: { credentials: { mode: 'id', vaultId: id(901), credentialId: id(2) } } }) },
  secrets: { [id(11)]: { kind: 'credential', username: 'lab', domain: '', password: 'SYNTHETIC-CREDENTIAL-CANARY' }, [id(12)]: { kind: 'protected-value', value: { payload: 'SYNTHETIC-PROTECTED-CANARY' } }, [id(13)]: { kind: 'protected-value', value: 'unreferenced' } } });
const env = (start = 100) => { let n = start; return { newId: () => id(n++) }; };
const error = (type: typeof DocumentError | typeof OpError, code: string) => (e: unknown) => e instanceof type && e.code === code;

test('duplicate v2 clones only typed own secrets, maps internal typed refs and leaves explicit external refs/opaque IDs', () => {
  const old = doc(), before = structuredClone(old), result = applyOp(old, { op: 'duplicate', id: id(1), name: 'copy' }, env());
  assert.equal(result.doc.schemaVersion, 2); const next = result.doc as Doc2;
  const copied = Object.values(next.objects).filter(n => n.parentId === result.created), cred = copied.find(n => n.type === 'credential')!, connection = copied.find(n => n.name === 'n3')!, task = copied.find(n => n.type === 'task')!, external = copied.find(n => n.name === 'n5')!;
  const groups: any = connection.props.groups;
  assert.equal(groups.credentials.credentialId, cred.id); assert.equal(groups.credentials.vaultId, next.id);
  assert.equal(groups.preConnectTask.objectId, task.id); assert.equal(groups.preConnectTask.documentId, next.id);
  assert.notEqual(cred.props.secretId, id(11)); assert.deepEqual(next.secrets[cred.props.secretId as string], old.secrets[id(11)]);
  assert.notEqual(groups.customField11.secretId, id(12)); assert.deepEqual(next.secrets[groups.customField11.secretId], old.secrets[id(12)]);
  assert.equal(Object.keys(next.secrets).length, 5, 'two referenced records copied, opaque third not copied');
  assert.deepEqual(external.props.groups, old.objects[id(5)]!.props.groups); assert.deepEqual(connection.props.opaque, old.objects[id(3)]!.props.opaque);
  assert.deepEqual(old, before); assert.doesNotThrow(() => validateDocument(next));
  (next.secrets[groups.customField11.secretId] as any).value.payload = 'new'; assert.notDeepEqual(next.secrets[groups.customField11.secretId], old.secrets[id(12)], 'new record must not share mutable data');
});

test('duplicate v2 refuses reused generated object or secret IDs without overwriting source', () => {
  const old = doc(), before = structuredClone(old);
  assert.throws(() => applyOp(old, { op: 'duplicate', id: id(1), name: 'copy' }, { newId: () => id(1) }), error(OpError, 'exists'));
  let count = 0; assert.throws(() => applyOp(old, { op: 'duplicate', id: id(2), name: 'copy' }, { newId: () => ++count === 1 ? id(100) : id(11) }), error(OpError, 'exists'));
  assert.deepEqual(old, before);
});

test('restoreObjects v2 imports exact referenced records, remaps collisions, leaves unreferenced and current records intact', () => {
  const revision = doc(), current = doc(); current.objects = {}; current.secrets = { [id(11)]: { kind: 'credential', username: 'current', domain: '', password: 'CURRENT-CANARY' } };
  const before = structuredClone(current), result = restoreObjects(current, revision, [id(1)], env(), 'Recovered'), next = result.doc as Doc2;
  assert.equal(next.objects[id(2)]!.props.secretId === id(11), false, 'collision gets new secret identity');
  const secretId = next.objects[id(2)]!.props.secretId as string;
  assert.deepEqual(next.secrets[secretId], revision.secrets[id(11)]); assert.deepEqual(next.secrets[id(11)], before.secrets[id(11)]);
  assert.deepEqual(next.secrets[id(12)], revision.secrets[id(12)], 'noncolliding referenced secret keeps identity');
  assert.equal(Object.hasOwn(next.secrets, id(13)), false, 'opaque/unreferenced record not imported');
  assert.deepEqual(next.meta, current.meta); assert.deepEqual(next.defaults, current.defaults); assert.equal(next.revision, current.revision);
  assert.deepEqual(current, before); assert.doesNotThrow(() => validateDocument(next));
});

test('restoreObjects v2 refuses dangling typed internal target and secret refs; no source mutations on refusal', () => {
  const revision = doc(), current = doc(); current.objects = {}; current.secrets = {};
  const before = structuredClone(current);
  assert.throws(() => restoreObjects(current, revision, [id(3)], env(), 'Recovered'), e => e instanceof DocumentError);
  assert.deepEqual(current, before);
  delete revision.secrets[id(12)]; assert.throws(() => restoreObjects(current, revision, [id(1)], env(), 'Recovered'), e => e instanceof DocumentError);
  assert.deepEqual(current, before);
});

test('restoreAll v2 uses revision defaults/meta/secrets, retains current identity/revision and detached data', () => {
  const revision = doc(), current = doc(); current.revision = 9; current.defaults.groups.notes = 'current'; current.meta.sort = [];
  const next = restoreAll(current, revision) as Doc2;
  assert.equal(next.schemaVersion, 2); assert.equal(next.id, current.id); assert.equal(next.revision, 9);
  assert.deepEqual(next.defaults, revision.defaults); assert.deepEqual(next.meta, revision.meta); assert.deepEqual(next.secrets, revision.secrets);
  next.objects[id(3)]!.name = 'changed'; (next.secrets[id(12)] as any).value.payload = 'changed';
  assert.equal(revision.objects[id(3)]!.name, 'n3'); assert.equal((revision.secrets[id(12)] as any).value.payload, 'SYNTHETIC-PROTECTED-CANARY');
});

test('v1 stays schema1; restoring legacy revision into v2 upgrades in memory and never discards secrets', () => {
  const revision: any = { schemaVersion: 1, id: id(900), kind: 'workspace', name: 'legacy', revision: 1, objects: { [id(2)]: node(2, 'credential', { username: 'lab', domain: '', password: 'LEGACY-CANARY' }, null) } };
  const current: any = structuredClone(revision); current.objects = {}; current.revision = 5;
  assert.equal(restoreAll(current, revision).schemaVersion, 1); assert.equal(restoreObjects(current, revision, [id(2)], env(), 'Recovered').doc.schemaVersion, 1);
  const next = restoreAll(doc(), revision) as Doc2; assert.equal(next.schemaVersion, 2); assert.equal(next.revision, 4);
  assert.equal(Object.values(next.secrets).some((s: any) => s.password === 'LEGACY-CANARY'), true);
  assert.throws(() => restoreAll(current, doc()), e => e instanceof DocumentError, 'never downgrade a v2 revision into schema1');
});

test('restoring a lone internal credential reference cannot accidentally bind a different or missing current object', () => {
  const revision = doc(); revision.objects[id(3)]!.props = { groups: { credentials: { mode: 'id', vaultId: revision.id, credentialId: id(2) } } };
  const current = doc(); current.objects = {}; current.secrets = {};
  assert.throws(() => restoreObjects(current, revision, [id(3)], env(), 'Recovered'), e => e instanceof DocumentError);
  current.objects[id(2)] = node(2, 'task', {}, null);
  assert.throws(() => restoreObjects(current, revision, [id(3)], env(), 'Recovered'), e => e instanceof DocumentError);
});


test('comparison marks secret-only edits by referencing object IDs without revealing secret values', () => {
  const current = doc(), revision = doc();
  (current.secrets[id(11)] as any).password = 'CURRENT-PASSWORD-CANARY';
  (current.secrets[id(12)] as any).value.payload = 'CURRENT-PROTECTED-CANARY';
  current.secrets[id(13)] = { kind: 'protected-value', value: 'unused changed' };
  const diff = compare(current, revision); assert.deepEqual(diff.changed, [id(2), id(3)]);
  assert.deepEqual(diff.gone, []); assert.equal(diff.added, 0);
  assert.equal(JSON.stringify(diff).includes('CANARY'), false);
  assert.equal(diff.changed.includes(id(5)), false, 'an external credential ref is never read for comparison');
});
