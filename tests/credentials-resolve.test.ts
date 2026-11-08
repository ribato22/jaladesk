import test from 'node:test';
import assert from 'node:assert/strict';
import type { Doc2, ObjectNode } from '../src/documents/model.js';
import type { CredentialBinding } from '../src/documents/effective.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const record = (password: string, username = 'admin', domain = '') => ({ kind: 'credential' as const, username, domain, password });
const node = (n: number, name: string, secretId = id(77)): ObjectNode => ({ id: id(n), name, type: 'credential', parentId: null, order: 0, props: { secretId } });
const document = (n = 900): Doc2 => ({ schemaVersion: 2, id: id(n), kind: 'vault', name: 'synthetic', revision: 0, objects: {}, meta: { createdAt: null, updatedAt: null, sort: [] }, defaults: { groups: {} }, secrets: {} });
const api = async () => {
  const path = '../src/credentials/resolve.js';
  return import(path) as Promise<{ normalizeIdentity: (username: string, domain: string) => { username: string; domain: string }; resolveCredential: (binding: CredentialBinding, context: { documents: readonly { doc: Doc2; generation: number; unlocked: boolean }[]; scope: ReadonlySet<string> }) => { username: string; domain: string; password: string; privateKey?: unknown; passphrase?: string; totp?: unknown } }>;
};
const binding = (selection: CredentialBinding['selection'], owner = 900, generation = 4): CredentialBinding => ({ selection, ownerDocumentId: id(owner), ownerGeneration: generation });
const opened = (doc: Doc2, generation = 4, unlocked = true) => ({ doc, generation, unlocked });
const fails = (fn: () => unknown, code: string) => assert.throws(fn, (error: unknown) => typeof error === 'object' && error !== null && (error as { code: string }).code === code && !JSON.stringify(error).includes('CANARY') && !(error as Error).message.includes('CANARY'));

test('domain_and_username normalization preserves local and UPN identities and refuses contradictory prefixes', async () => {
  const { normalizeIdentity } = await api();
  assert.deepEqual(normalizeIdentity('administrator', ''), { username: 'administrator', domain: '' });
  assert.deepEqual(normalizeIdentity('LAB\\administrator', ''), { username: 'administrator', domain: 'LAB' });
  assert.deepEqual(normalizeIdentity('LAB\\administrator', 'lab'), { username: 'administrator', domain: 'LAB' });
  assert.deepEqual(normalizeIdentity('admin@example.invalid', ''), { username: 'admin@example.invalid', domain: '' });
  assert.deepEqual(normalizeIdentity('', ''), { username: '', domain: '' });
  for (const [username, domain] of [['LAB\\user', 'OTHER'], ['admin@example.invalid', 'LAB'], ['LAB\\user\\extra', ''], ['\\user', ''], ['LAB\\', ''], ['CANARY\0', ''], ['a'.repeat(257), ''], ['user', 'd'.repeat(257)]]) fails(() => normalizeIdentity(username!, domain!), 'invalid');
});

test('none and inline verify owner identity, generation and unlock before resolving without fallback', async () => {
  const { resolveCredential } = await api();
  assert.equal(typeof resolveCredential, 'function', 'resolveCredential must verify the effective binding owner');
  const shared = document(), overlay = document(901);
  shared.secrets[id(77)] = record('CANARY-shared'); overlay.secrets[id(77)] = record('CANARY-overlay');
  const context = { documents: [opened(shared), opened(overlay)], scope: new Set<string>() };
  assert.deepEqual(resolveCredential(binding({ mode: 'none' }), context), { username: '', domain: '', password: '' });
  assert.equal(resolveCredential(binding({ mode: 'inline', secretId: id(77) }, 901), context).password, 'CANARY-overlay');
  fails(() => resolveCredential(binding({ mode: 'parent' }), context), 'invalid');
  fails(() => resolveCredential(binding({ mode: 'inline', secretId: id(77) }, 902), context), 'missing');
  fails(() => resolveCredential(binding({ mode: 'inline', secretId: id(77) }, 901, 3), context), 'stale');
  fails(() => resolveCredential(binding({ mode: 'inline', secretId: id(77) }, 901), { ...context, documents: [opened(shared), opened(overlay, 4, false)] }), 'locked');
  fails(() => resolveCredential(binding({ mode: 'none' }), { ...context, documents: [opened(shared, 4, false)] }), 'locked');
  fails(() => resolveCredential(binding({ mode: 'none' }), { ...context, documents: [opened(shared), opened(structuredClone(shared))] }), 'ambiguous');
  fails(() => resolveCredential({ ...binding({ mode: 'inline', secretId: id(77) }), ownerGeneration: undefined } as never, context), 'invalid');
  fails(() => resolveCredential({ ...binding({ mode: 'inline', secretId: id(77) }), ownerDocumentId: 'constructor' }, context), 'invalid');
  const missing = structuredClone(overlay); delete missing.secrets[id(77)];
  fails(() => resolveCredential(binding({ mode: 'inline', secretId: id(77) }, 901), { ...context, documents: [opened(shared), opened(missing)] }), 'missing');
  const wrong = structuredClone(overlay); wrong.secrets[id(77)] = { kind: 'protected-value', value: 'CANARY' };
  fails(() => resolveCredential(binding({ mode: 'inline', secretId: id(77) }, 901), { ...context, documents: [opened(shared), opened(wrong)] }), 'invalid');
});

test('id mode uses only the scoped source, accepts legacy workspaces and never picks a duplicate document', async () => {
  const { resolveCredential } = await api();
  const owner = document(), left = document(901), right = document(902);
  for (const [doc, value] of [[left, 'CANARY-left'], [right, 'CANARY-right']] as const) { doc.objects[id(1)] = node(1, 'Admin'); doc.secrets[id(77)] = record(value); }
  right.kind = 'workspace';
  const context = { documents: [opened(owner), opened(left), opened(right)], scope: new Set([left.id, right.id]) };
  assert.equal(resolveCredential(binding({ mode: 'id', vaultId: left.id, credentialId: id(1) }), context).password, 'CANARY-left');
  assert.equal(resolveCredential(binding({ mode: 'id', vaultId: right.id, credentialId: id(1) }), context).password, 'CANARY-right');
  fails(() => resolveCredential(binding({ mode: 'id', vaultId: left.id, credentialId: id(1) }), { ...context, scope: new Set() }), 'scope-denied');
  fails(() => resolveCredential(binding({ mode: 'id', vaultId: id(903), credentialId: id(1) }), { ...context, scope: new Set([id(903)]) }), 'missing');
  fails(() => resolveCredential(binding({ mode: 'id', vaultId: left.id, credentialId: id(1) }), { ...context, documents: [opened(owner), opened(left, 4, false)] }), 'locked');
  fails(() => resolveCredential(binding({ mode: 'id', vaultId: left.id, credentialId: id(1) }), { ...context, documents: [...context.documents, opened(structuredClone(left))] }), 'ambiguous');
  const wrongKind = structuredClone(left); wrongKind.kind = 'overrides';
  fails(() => resolveCredential(binding({ mode: 'id', vaultId: left.id, credentialId: id(1) }), { ...context, documents: [opened(owner), opened(wrongKind)] }), 'invalid');
  const wrongNode = structuredClone(left); wrongNode.objects[id(1)]!.type = 'connection';
  fails(() => resolveCredential(binding({ mode: 'id', vaultId: left.id, credentialId: id(1) }), { ...context, documents: [opened(owner), opened(wrongNode)] }), 'missing');
  const noSecret = structuredClone(left); delete noSecret.secrets[id(77)];
  fails(() => resolveCredential(binding({ mode: 'id', vaultId: left.id, credentialId: id(1) }), { ...context, documents: [opened(owner), opened(noSecret)] }), 'missing');
});

test('name mode is exact NFC and case sensitive with zero, one and multiple matches failing closed', async () => {
  const { resolveCredential } = await api();
  const owner = document(), left = document(901), right = document(902);
  left.objects[id(1)] = node(1, 'Café'); left.secrets[id(77)] = record('CANARY-named');
  right.objects[id(1)] = node(1, 'Different'); right.secrets[id(77)] = record('CANARY-other');
  const context = { documents: [opened(owner), opened(left), opened(right)], scope: new Set([left.id, right.id]) };
  const selected = binding({ mode: 'name', name: 'Cafe\u0301', scopeVaultIds: [left.id, right.id] });
  assert.equal(resolveCredential(selected, context).password, 'CANARY-named');
  fails(() => resolveCredential(binding({ mode: 'name', name: 'café', scopeVaultIds: [left.id] }), context), 'missing');
  fails(() => resolveCredential(binding({ mode: 'name', name: 'Absent', scopeVaultIds: [left.id] }), context), 'missing');
  fails(() => resolveCredential(binding({ mode: 'name', name: 'Café', scopeVaultIds: [] }), context), 'invalid');
  fails(() => resolveCredential(selected, { ...context, scope: new Set([left.id]) }), 'scope-denied');
  fails(() => resolveCredential(selected, { ...context, documents: [opened(owner), opened(left), opened(right, 4, false)] }), 'locked');
  fails(() => resolveCredential(selected, { ...context, documents: [opened(owner), opened(left)] }), 'missing');
  const duplicate = structuredClone(right); duplicate.objects[id(1)]!.name = 'Cafe\u0301';
  fails(() => resolveCredential(selected, { ...context, documents: [opened(owner), opened(left), opened(duplicate)] }), 'ambiguous');
  const sameDocument = structuredClone(left); sameDocument.objects[id(2)] = node(2, 'Café');
  fails(() => resolveCredential(selected, { ...context, documents: [opened(owner), opened(sameDocument), opened(right)] }), 'ambiguous');
  fails(() => resolveCredential(selected, { ...context, documents: [opened(owner), opened(left), opened(left), opened(right)] }), 'ambiguous');
});

test('engine-bound identity/password limits and private credential values stay local and fresh', async () => {
  const { normalizeIdentity, resolveCredential } = await api();
  assert.deepEqual(normalizeIdentity(`${'D'.repeat(256)}\\${'u'.repeat(256)}`, ''), { username: 'u'.repeat(256), domain: 'D'.repeat(256) });
  fails(() => normalizeIdentity('u@domain\\user', ''), 'invalid');
  const owner = document();
  owner.secrets[id(77)] = { ...record('p'.repeat(4096), 'LAB\\user', 'lab'), privateKey: { mode: 'path', path: '/synthetic/key' }, passphrase: 'CANARY-passphrase', totp: { secretBase32: 'GEZDGNBVGY3TQOJQ', algorithm: 'sha1', digits: 6, period: 30 } };
  const context = { documents: [opened(owner)], scope: new Set<string>() }, chosen = binding({ mode: 'inline', secretId: id(77) });
  const resolved = resolveCredential(chosen, context);
  assert.equal(resolved.password.length, 4096);
  assert.deepEqual({ username: resolved.username, domain: resolved.domain }, { username: 'user', domain: 'LAB' });
  assert.equal(resolved.passphrase, 'CANARY-passphrase');
  assert.deepEqual(resolved.privateKey, { mode: 'path', path: '/synthetic/key' });
  (resolved.privateKey as { path: string }).path = '/changed';
  (resolved.totp as { secretBase32: string }).secretBase32 = 'CHANGED';
  assert.deepEqual((owner.secrets[id(77)] as { privateKey: unknown }).privateKey, { mode: 'path', path: '/synthetic/key' });
  owner.secrets[id(77)] = record('CANARY-new-value');
  assert.equal(resolveCredential(chosen, context).password, 'CANARY-new-value', 'reconnect re-resolves current data instead of retaining a prior credential');
  owner.secrets[id(77)] = record('p'.repeat(4097));
  fails(() => resolveCredential(chosen, context), 'invalid');
  owner.secrets[id(77)] = record('CANARY\0-password');
  fails(() => resolveCredential(chosen, context), 'invalid');
  owner.secrets[id(77)] = record('CANARY', 'user'.repeat(65));
  fails(() => resolveCredential(chosen, context), 'invalid');
});
