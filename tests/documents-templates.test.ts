import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTemplate, instantiateTemplate, adHocTemplate, TemplateError } from '../src/documents/templates.js';
import { validateV2, type Doc2, type ObjectNode } from '../src/documents/model.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const conn = (n: number, parentId: string | null = null, props: ObjectNode['props'] = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `Connection ${n}`, parentId, order: 0, props: { protocol: 'rdp', host: 'host.example', port: 4321, username: 'user', ...props } });
const doc = (nodes: ObjectNode[] = []): Doc2 => ({ schemaVersion: 2, id: id(1), kind: 'workspace', name: 'test', revision: 3, objects: Object.fromEntries(nodes.map(n => [n.id, n])), meta: { createdAt: null, updatedAt: null, sort: [] }, defaults: { groups: {} }, secrets: {} });
const code = (expected: string) => (e: unknown) => e instanceof TemplateError && e.code === expected && !e.message.includes('PRIVATE-CANARY');

test('capture freezes effective values and application creates detached identities', () => {
  const folder = { ...conn(2), type: 'folder' as const, props: { groups: { notes: 'inherited', color: 'green', customField1: '' } } };
  const source = doc([folder, conn(3, folder.id, { inherit: { notes: true, color: true, customField1: true } })]);
  const snapshot = captureTemplate(source, [id(3)], { documentGeneration: 1 });
  assert.notEqual(snapshot.objects[0]!.id, id(3));
  assert.deepEqual(snapshot.objects[0]!.props.groups, { notes: 'inherited', color: 'green', customField1: '' });
  const destination = doc(), result = instantiateTemplate(snapshot, destination);
  const created = result.doc.objects[result.objectIds[0]!]!;
  assert.equal(created.parentId, null); assert.notEqual(created.id, snapshot.roots[0]); assert.equal(destination.objects[created.id], undefined);
  folder.props.groups.notes = 'changed'; snapshot.objects[0]!.props.groups = { notes: 'later' };
  assert.equal((created.props.groups as any).notes, 'inherited'); assert.equal(result.doc.revision, destination.revision);
});

test('ad-hoc returns a new detached connection without changing document or snapshot', () => {
  const source = doc([conn(3)]), before = JSON.stringify(source), snapshot = captureTemplate(source, [id(3)], { documentGeneration: 1 });
  const first = adHocTemplate(snapshot, { name: 'Temporary' }), second = adHocTemplate(snapshot);
  assert.equal(first.name, 'Temporary'); assert.notEqual(first.id, second.id); assert.equal(first.parentId, null);
  first.props.host = 'changed'; assert.equal(snapshot.objects[0]!.props.host, 'host.example'); assert.equal(JSON.stringify(source), before);
});

test('default template strips all secrets, credential bindings, inheritance and opaque fields', () => {
  const source = doc([conn(3, null, { opaque: 'PRIVATE-CANARY', groups: { credentials: { mode: 'inline', secretId: id(10) }, customField11: { secretId: id(11) }, customField1: false } })]);
  source.secrets[id(10)] = { kind: 'credential', username: 'u', domain: '', password: 'PRIVATE-CANARY' };
  source.secrets[id(11)] = { kind: 'protected-value', value: 'PRIVATE-CANARY' };
  const snapshot = captureTemplate(source, [id(3)], { documentGeneration: 1 });
  const serialized = JSON.stringify(snapshot);
  for (const hidden of ['PRIVATE-CANARY', id(10), id(11), 'credentials', 'inherit']) assert.equal(serialized.includes(hidden), false);
  assert.deepEqual(snapshot.objects[0]!.props.groups, { customField1: false });
});

test('credential reference copy is explicit and scope checked, inline is never copied', () => {
  const source = doc([conn(3, null, { groups: { credentials: { mode: 'id', vaultId: id(90), credentialId: id(91) } } })]);
  assert.equal(JSON.stringify(captureTemplate(source, [id(3)], { documentGeneration: 1 })).includes(id(90)), false);
  assert.throws(() => captureTemplate(source, [id(3)], { documentGeneration: 1 }, { copyCredentialReferences: true, allowedCredentialDocumentIds: [] }), code('credential-scope'));
  const snapshot = captureTemplate(source, [id(3)], { documentGeneration: 1 }, { copyCredentialReferences: true, allowedCredentialDocumentIds: [id(90)] });
  assert.deepEqual((snapshot.objects[0]!.props.groups as any).credentials, { mode: 'id', vaultId: id(90), credentialId: id(91) });
  source.objects[id(3)]!.props.groups = { credentials: { mode: 'name', name: 'Exact', scopeVaultIds: [id(90), id(92)] } };
  assert.throws(() => captureTemplate(source, [id(3)], { documentGeneration: 1 }, { copyCredentialReferences: true, allowedCredentialDocumentIds: [id(90)] }), code('credential-scope'));
});

test('subtrees remap only typed internal references and retain external references', () => {
  const folder = { ...conn(2), type: 'folder' as const, props: {} };
  const source = doc([folder, conn(3, id(2), { groups: { preConnectTask: { documentId: id(1), objectId: id(4) }, rdGateway: { documentId: id(90), objectId: id(91) } } }), conn(4, id(2))]);
  const snapshot = captureTemplate(source, [id(2)], { documentGeneration: 1 });
  const destination = doc(); destination.id = id(100);
  const result = instantiateTemplate(snapshot, destination);
  const root = result.doc.objects[result.objectIds[0]!]!, a = Object.values(result.doc.objects).find(n => n.name === 'Connection 3')!, b = Object.values(result.doc.objects).find(n => n.name === 'Connection 4')!;
  assert.equal(a.parentId, root.id); assert.deepEqual((a.props.groups as any).preConnectTask, { documentId: id(100), objectId: b.id });
  assert.deepEqual((a.props.groups as any).rdGateway, { documentId: id(90), objectId: id(91) });
  assert.doesNotThrow(() => validateV2(result.doc));
});

test('invalid prototypes, duplicate ids, cyclic references and corrupt snapshots fail closed', () => {
  const source = doc([conn(3)]);
  assert.throws(() => captureTemplate(source, [id(3), id(3)], { documentGeneration: 1 }), code('invalid-template'));
  source.objects[id(3)]!.props.groups = { preConnectTask: { documentId: source.id, objectId: id(3) } };
  assert.throws(() => captureTemplate(source, [id(3)], { documentGeneration: 1 }), code('reference-cycle'));
  const snapshot = captureTemplate(doc([conn(3)]), [id(3)], { documentGeneration: 1 });
  assert.throws(() => instantiateTemplate(Object.assign(Object.create({ injected: true }), snapshot), doc()), code('invalid-template'));
  assert.throws(() => instantiateTemplate({ ...snapshot, objects: [...snapshot.objects, snapshot.objects[0]!] }, doc()), code('invalid-template'));
  assert.throws(() => instantiateTemplate({ ...snapshot, objects: [{ ...snapshot.objects[0]!, props: { password: 'PRIVATE-CANARY' } }] }, doc()), code('invalid-template'));
});

test('explicit parent, names, root ordering and private destination guards are validated', () => {
  const snapshot = captureTemplate(doc([conn(3)]), [id(3)], { documentGeneration: 1 });
  const parent = { ...conn(8), type: 'folder' as const }, destination = doc([parent, { ...conn(9, id(8)), order: 5 }]);
  const result = instantiateTemplate(snapshot, destination, { parentId: id(8), name: 'New' });
  const created = result.doc.objects[result.objectIds[0]!]!;
  assert.equal(created.name, 'New'); assert.equal(created.parentId, id(8)); assert.equal(created.order, 6);
  assert.throws(() => instantiateTemplate(snapshot, destination, { parentId: id(9) }), code('invalid-template'));
  assert.throws(() => instantiateTemplate(snapshot, destination, { name: 'x'.repeat(257) }), code('invalid-template'));
  assert.throws(() => instantiateTemplate(snapshot, { ...destination, kind: 'overrides' }), code('invalid-template'));
});
