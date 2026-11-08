import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/documents/model.js';
import type { Doc, ObjectNode } from '../src/documents/model.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const v1 = (...nodes: ObjectNode[]): Doc => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'old', revision: 8, objects: Object.fromEntries(nodes.map(n => [n.id, n])) });
const api = () => {
  const load = (model as unknown as Record<string, unknown>).loadDocument;
  assert.equal(typeof load, 'function', 'loadDocument must identify the source schema before any save');
  return load as (bytes: Uint8Array) => { doc: Record<string, any>; sourceSchema: number };
};

test('migrate_v1_without_write_or_invented_dates', () => {
  const old = v1(node(1, { props: { opaqueFuture: { keep: ['é', 4] } } }));
  const bytes = model.serializeDocument(old), saved = Buffer.from(bytes);
  const loaded = api()(bytes);
  assert.equal(loaded.sourceSchema, 1);
  assert.equal(loaded.doc.schemaVersion, 2);
  assert.deepEqual(loaded.doc.meta, { createdAt: null, updatedAt: null, sort: [] });
  assert.deepEqual(loaded.doc.defaults, { groups: {} });
  assert.deepEqual(loaded.doc.secrets, {});
  assert.deepEqual(loaded.doc.objects, old.objects);
  assert.equal(loaded.doc.revision, old.revision);
  assert.equal(loaded.doc.id, old.id);
  assert.deepEqual(bytes, saved);
  assert.deepEqual(model.parseDocument(bytes), loaded.doc);
});

const v2 = (...nodes: ObjectNode[]) => api()(model.serializeDocument(v1(...nodes))).doc;
const rejected = (value: unknown) => assert.throws(() => model.validateDocument(value), (e: unknown) => e instanceof model.DocumentError && !e.message.includes('CANARY'));

test('v2 metadata and secret discriminants are validated before returning a document', () => {
  const good = v2(node(1));
  for (const malformed of [
    { ...good, meta: undefined }, { ...good, defaults: undefined }, { ...good, secrets: undefined },
    { ...good, meta: { ...good.meta, createdAt: 'tomorrow' } },
    { ...good, meta: { ...good.meta, updatedAt: '2026-02-30T12:00:00.000Z' } },
    { ...good, meta: { ...good.meta, updatedAt: '2026-10-24T12:00:00+07:00' } },
    { ...good, meta: { ...good.meta, sort: [{ by: 'name', dir: 'asc' }, { by: 'name', dir: 'desc' }] } },
    { ...good, meta: { ...good.meta, sort: [{ by: 'date', dir: 'asc' }] } },
    { ...good, secrets: { invalid: { kind: 'protected-value', value: 'CANARY' } } },
    { ...good, secrets: { [id(77)]: { kind: 'credential', username: '', domain: '', password: 2 } } },
    { ...good, secrets: { [id(77)]: { kind: 'credential', username: '', domain: '', extra: 'CANARY' } } },
    { ...good, secrets: { [id(77)]: { kind: 'credential', username: '', domain: '', privateKey: { mode: 'embedded', base64: '!' } } } },
    { ...good, secrets: { [id(77)]: { kind: 'credential', username: '', domain: '', totp: { secretBase32: 'bad!!!', algorithm: 'sha1', digits: 6, period: 30 } } } },
    { ...good, secrets: { [id(77)]: { kind: 'protected-value', value: 'CANARY', password: 'CANARY' } } },
  ]) rejected(malformed);
  const credential = { kind: 'credential', username: 'user', domain: '', password: 'CANARY', privateKey: { mode: 'path', path: '/synthetic/key' }, passphrase: 'CANARY', totp: { secretBase32: 'GEZDGNBVGY3TQOJQ', algorithm: 'sha256', digits: 8, period: 15 } };
  const ready = { ...good, meta: { ...good.meta, createdAt: '2026-10-24T00:00:00.000Z', sort: [{ by: 'name', dir: 'asc' }, { by: 'type', dir: 'desc' }] }, secrets: { [id(77)]: credential, [id(78)]: { kind: 'protected-value', value: { opaque: ['CANARY'] } } } };
  assert.deepEqual(model.validateDocument(ready), ready);
  assert.equal(api()(model.serializeDocument(ready as Doc)).sourceSchema, 2);
});

test('v1 is validated before upgrade and direct inputs must be plain JSON records', () => {
  for (const old of [
    { ...v1(), kind: 'overrides' },
    v1(node(1, { type: 'folder', parentId: id(2) }), node(2, { type: 'folder', parentId: id(1) })),
    v1(node(1, { type: 'override' as never })),
  ]) assert.throws(() => api()(model.serializeDocument(old as Doc)), model.DocumentError);
  rejected({ ...v2(), objects: Object.create({ [id(1)]: node(1) }) });
  rejected(Object.assign(Object.create({}), v2()));
  assert.throws(() => model.parseDocument(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), model.DocumentError);
  assert.throws(() => model.parseDocument(Buffer.from('{"schemaVersion":3}')), (e: unknown) => e instanceof model.DocumentError && e.code === 'unsupported-schema');
});

test('legacy_sensitive_props_quarantined with stable owner-local identities and opaque preservation', () => {
  const old = v1(node(1, { type: 'credential', props: { username: 'admin', domain: '', password: 'CANARY-password', privateKeyPath: '/synthetic/key', passphrase: 'CANARY-pass', totpSecret: 'GEZDGNBVGY3TQOJQ', futureOpaque: { password: 'CANARY-opaque' } } }), node(2, { props: { username: 'local', password: 'CANARY-inline', customField11: 'CANARY-custom', customProperties: { token: 'CANARY-map' }, host: 'example.invalid' } }));
  const before = structuredClone(old), first = api()(model.serializeDocument(old)).doc, again = api()(model.serializeDocument(old)).doc;
  assert.deepEqual(first, again, 'upgrade IDs must be stable, without depending on random values or wall clock');
  assert.deepEqual(old, before, 'upgrade never edits the legacy source');
  const credential = first.objects[id(1)], connection = first.objects[id(2)];
  const secret = first.secrets[credential.props.secretId];
  assert.ok(secret, 'legacy credential must be quarantined in the secret map');
  assert.equal(secret.kind, 'credential');
  assert.equal(secret.password, 'CANARY-password');
  assert.deepEqual(secret.privateKey, { mode: 'path', path: '/synthetic/key' });
  assert.equal(secret.totp.secretBase32, 'GEZDGNBVGY3TQOJQ');
  assert.deepEqual(credential.props.futureOpaque, { password: 'CANARY-opaque' });
  for (const key of ['username', 'domain', 'password', 'privateKeyPath', 'passphrase', 'totpSecret']) assert.equal(Object.hasOwn(credential.props, key), false);
  assert.equal(connection.props.groups.credentials.mode, 'inline');
  assert.equal(first.secrets[connection.props.groups.credentials.secretId].password, 'CANARY-inline');
  assert.equal(first.secrets[connection.props.groups.customField11.secretId].value, 'CANARY-custom');
  assert.deepEqual(first.secrets[connection.props.groups.customProperties.secretId].value, { token: 'CANARY-map' });
  for (const key of ['password', 'customField11', 'customProperties']) assert.equal(Object.hasOwn(connection.props, key), false);
  assert.equal(connection.props.host, 'example.invalid');
  assert.doesNotThrow(() => model.validateDocument(first));
  assert.throws(() => api()(model.serializeDocument(v1(node(1, { props: { password: 123 } })))), model.DocumentError, 'an unconvertible known secret is rejected, never silently discarded');
});

test('typed groups and secret references are closed and correct for their record kind', () => {
  const d = v2(node(1));
  const inline = { ...d, objects: { [id(1)]: node(1, { props: { groups: { credentials: { mode: 'inline', secretId: id(77) } } } }) }, secrets: { [id(77)]: { kind: 'credential', username: '', domain: '', password: 'CANARY' } } };
  assert.doesNotThrow(() => model.validateDocument(inline));
  for (const malformed of [
    { ...inline, secrets: {} },
    { ...inline, secrets: { [id(77)]: { kind: 'protected-value', value: 'CANARY' } } },
    { ...d, defaults: { groups: { nonGroup: 'CANARY' } } },
    { ...d, objects: { [id(1)]: node(1, { props: { groups: { credentials: { mode: 'parent' } } } }) } },
    { ...d, objects: { [id(1)]: node(1, { props: { groups: { credentials: { mode: 'none' } }, inherit: { credentials: true } } }) } },
    { ...d, objects: { [id(1)]: node(1, { props: { groups: { customField11: { secretId: id(77) } } } }) } },
    { ...inline, objects: { [id(1)]: node(1, { props: { groups: { customField11: { secretId: id(77) } } } }) } },
    { ...d, objects: { [id(1)]: node(1, { props: { groups: { preConnectTask: { documentId: d.id, objectId: id(999) } } } }) } },
    { ...d, objects: { [id(1)]: node(1, { props: { password: 'CANARY' } }) } },
    { ...d, objects: { [id(1)]: node(1, { type: 'override' }) } },
  ]) rejected(malformed);
  assert.doesNotThrow(() => model.validateDocument({ ...d, kind: 'overrides', objects: { [id(1)]: node(1, { type: 'override' }) } }));
  assert.doesNotThrow(() => model.validateDocument({ ...d, kind: 'vault', objects: { [id(1)]: node(1, { type: 'task' }) } }), 'old valid vault object kinds remain accepted');
});

test('legacy UTF16 string bounds stay compatible while file bounds count UTF8 bytes', () => {
  const old = v1(node(1, { props: { description: '界'.repeat(model.LIMITS.maxString) } }));
  assert.doesNotThrow(() => model.validateDocument(old));
  const bytes = model.serializeDocument(old);
  assert.ok(bytes.length > model.LIMITS.maxString * 2);
  assert.doesNotThrow(() => api()(bytes));
  assert.throws(() => model.loadDocument(bytes, { maxBytes: bytes.length - 1 }), (e: unknown) => e instanceof model.DocumentError && e.code === 'too-large');
  assert.throws(() => model.validateDocument(v1(node(1, { props: { text: '界'.repeat(model.LIMITS.maxString + 1) } }))), model.DocumentError);
  assert.throws(() => model.validateV1(v2()), (e: unknown) => e instanceof model.DocumentError && e.code === 'bad-document' || e instanceof model.DocumentError && e.code === 'unsupported-schema');
});

test('typed references remap internal object and secret IDs without editing opaque or external references', async () => {
  const path = '../src/documents/references.js';
  const references = await import(path) as { referencedSecretIds: (node: ObjectNode) => string[]; remapNodeReferences: (node: ObjectNode, maps: { objectIds: Record<string, string>; secretIds: Record<string, string>; sourceDocumentId: string; targetDocumentId: string }) => ObjectNode };
  const original = node(1, { props: { groups: { credentials: { mode: 'inline', secretId: id(77) }, customField11: { secretId: id(78) }, customProperties: { secretId: id(78) }, preConnectTask: { documentId: id(900), objectId: id(2) }, secureGateway: { documentId: id(901), objectId: id(2) } }, opaque: { secretId: id(77), documentId: id(900), objectId: id(2) } } });
  assert.deepEqual(references.referencedSecretIds(original).sort(), [id(77), id(78)]);
  const mapped = references.remapNodeReferences(original, { objectIds: { [id(2)]: id(3) }, secretIds: { [id(77)]: id(79), [id(78)]: id(80) }, sourceDocumentId: id(900), targetDocumentId: id(902) });
  const props = mapped.props as Record<string, any>;
  assert.deepEqual(props.groups.credentials, { mode: 'inline', secretId: id(79) });
  assert.deepEqual(props.groups.customField11, { secretId: id(80) });
  assert.deepEqual(props.groups.preConnectTask, { documentId: id(902), objectId: id(3) });
  assert.deepEqual(props.groups.secureGateway, { documentId: id(901), objectId: id(2) });
  assert.deepEqual(props.opaque, original.props.opaque);
  assert.deepEqual((original.props as Record<string, any>).groups.credentials, { mode: 'inline', secretId: id(77) });
  const credential = node(4, { type: 'credential', props: { secretId: id(77) } });
  assert.deepEqual(references.referencedSecretIds(credential), [id(77)]);
  assert.equal(references.remapNodeReferences(credential, { objectIds: {}, secretIds: { [id(77)]: id(79) }, sourceDocumentId: id(900), targetDocumentId: id(900) }).props.secretId, id(79));
});

test('golden-v2 payload opens inside unchanged RWDX format1 with default KDF and secret closure', async () => {
  const { readFile } = await import('node:fs/promises');
  const { open, DEFAULT_KDF, FORMAT_VERSION } = await import('../src/documents/envelope.js');
  const bytes = await readFile('tests/fixtures/documents/golden-v2.rwdoc');
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RWDX');
  assert.equal(bytes.readUInt16LE(4), FORMAT_VERSION);
  assert.equal(bytes[9], DEFAULT_KDF.logN);
  assert.equal(bytes[10], DEFAULT_KDF.r);
  assert.equal(bytes[11], DEFAULT_KDF.p);
  assert.equal(bytes.includes(Buffer.from('GOLDEN-V2-SYNTHETIC-SECRET')), false);
  const opened = await open(bytes, 'golden-fixture-v2-pw');
  try {
    const { doc, sourceSchema } = api()(opened.plaintext);
    assert.equal(sourceSchema, 2);
    assert.equal(doc.name, 'Golden workspace v2');
    assert.equal(doc.revision, 4);
    assert.equal(doc.meta.createdAt, '2026-10-24T00:00:00.000Z');
    assert.equal(doc.defaults.groups.notes, 'Synthetic inherited note');
    assert.equal(doc.secrets[id(77)].password, 'GOLDEN-V2-SYNTHETIC-SECRET');
    assert.equal(doc.objects[id(2)].props.groups.credentials.secretId, id(77));
    assert.doesNotThrow(() => model.validateDocument(doc));
  } finally { opened.unlocked.dispose(); opened.plaintext.fill(0); }
});

test('internal id credential refs require an existing credential; external refs remain explicit and unresolved', () => {
  const good = v2(node(1));
  rejected({ ...good, objects: { [id(1)]: node(1, { props: { groups: { credentials: { mode: 'id', vaultId: good.id, credentialId: id(999) } } } }) } });
  rejected({ ...good, objects: { [id(1)]: node(1, { props: { groups: { credentials: { mode: 'id', vaultId: good.id, credentialId: id(1) } } } }) } });
  assert.doesNotThrow(() => model.validateDocument({ ...good, objects: { [id(1)]: node(1, { props: { groups: { credentials: { mode: 'id', vaultId: id(901), credentialId: id(999) } } } }) } }));
});

test('persisted TOTP seeds use the same canonical and byte bounds as the trusted TOTP adapter', () => {
  const good = v2();
  for (const secretBase32 of ['gezdgnbvgy3tqojq', 'GEZDGNBVGY3TQOJQ ', 'AB', 'A'.repeat(216)]) rejected({ ...good, secrets: { [id(77)]: { kind: 'credential', username: '', domain: '', totp: { secretBase32, algorithm: 'sha1', digits: 6, period: 30 } } } });
});
