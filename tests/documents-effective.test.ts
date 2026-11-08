import assert from 'node:assert/strict';
import test from 'node:test';

// Dynamic loading lets the first run prove the runtime API is absent before implementation.
const G = await import(new URL('../src/documents/groups.js', import.meta.url).href);
const E = await import(new URL('../src/documents/effective.js', import.meta.url).href);
const GROUPS = ['credentials', 'preConnectTask', 'postDisconnectTask', 'keySequence', 'rdGateway', 'managementEndpoint', 'secureGateway', 'color', 'notes', 'customProperties', ...Array.from({ length: 20 }, (_, i) => `customField${i + 1}`)];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = (value: unknown, n = 1) => ({ ownerDocumentId: id(n), ownerGeneration: n, groups: value });
const node = (n: number, parentId: string | null = null, props: Record<string, any> = {}, type = 'connection') => ({ id: id(n), type, name: `n${n}`, parentId, order: 0, props });
const doc = (nodes = [node(3, id(2)), node(2, null, {}, 'folder')], groups: Record<string, any> = {}) => ({ id: id(1), revision: 0, objects: Object.fromEntries(nodes.map(n => [n.id, n])), defaults: { groups } });
const valueFor = (group: string, n: number): any => group === 'credentials' ? { mode: 'inline', secretId: id(100 + n) } : group === 'notes' ? `note${n}` : group === 'color' ? ['red', 'blue', 'green', 'yellow', 'purple', 'orange'][n - 1] : group === 'customProperties' || /^customField(1[1-9]|20)$/.test(group) ? { secretId: id(100 + n) } : group.startsWith('customField') ? `field${n}` : { documentId: id(1), objectId: id(100 + n) };
const run = (d: any, layers: any = {}, target = id(3)) => { const result = E.resolveEffective(d, target, { documentGeneration: 7, ...layers }); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const groups = (key: string, value: any) => ({ groups: { [key]: value } });

test('registry is exactly the 30 approved groups with fixed privacy/capability metadata', () => {
  assert.deepEqual(G.GROUPS, GROUPS);
  assert.equal(new Set(G.GROUPS).size, 30);
  for (const name of GROUPS) assert.ok(G.GROUP_REGISTRY[name]);
  assert.equal(G.isGroup('constructor'), false);
  assert.equal(G.isGroup('host'), false);
});

for (const group of GROUPS) test(`precedence/default/inherit/provenance: ${group}`, () => {
  const folder = node(2, null, groups(group, valueFor(group, 3)), 'folder');
  const conn = node(3, id(2), groups(group, valueFor(group, 4)));
  const d = doc([folder, conn], { [group]: valueFor(group, 2) });
  const layers = { applicationDefaults: { [group]: valueFor(group, 1) }, applicationOwner: own({}, 8) };
  assert.deepEqual(run(d, layers).private.groups[group], valueFor(group, 4));
  conn.props = { inherit: { [group]: true }, ...(group === 'credentials' ? groups(group, { mode: 'parent' }) : {}) };
  let r = run(d, layers); assert.deepEqual(r.private.groups[group], valueFor(group, 3)); assert.equal(r.provenance[group].objectId, folder.id);
  folder.props = { inherit: { [group]: true }, ...(group === 'credentials' ? groups(group, { mode: 'parent' }) : {}) };
  r = run(d, layers); assert.deepEqual(r.private.groups[group], valueFor(group, 2)); assert.equal(r.provenance[group].layer, 'document');
  delete (d.defaults.groups as any)[group];
  r = run(d, layers); assert.deepEqual(r.private.groups[group], valueFor(group, 1)); assert.equal(r.provenance[group].layer, 'application');
  const overlay = own({ [group]: valueFor(group, 5) }, 9);
  r = run(d, { ...layers, override: overlay }); assert.deepEqual(r.private.groups[group], valueFor(group, 5)); assert.equal(r.provenance[group].layer, 'override');
  r = run(d, { ...layers, override: overlay, temporary: own({ [group]: valueFor(group, 6) }, 10) }); assert.deepEqual(r.private.groups[group], valueFor(group, 6)); assert.equal(r.provenance[group].layer, 'temporary');
});

test('false, zero and empty values are explicit; unset does not silently inherit a parent', () => {
  for (const value of [false, 0, '', null]) {
    const d = doc([node(2, null, groups('customField1', 'parent'), 'folder'), node(3, id(2), groups('customField1', value))], { customField1: 'default' });
    assert.equal(run(d).private.groups.customField1, value);
    d.objects[id(3)]!.props = {};
    assert.equal(run(d).private.groups.customField1, 'default');
  }
});

test('true→false, move, parent edit/delete and defaults/overlay changes have no stale cache', () => {
  const a = node(2, null, groups('notes', 'a'), 'folder'), b = node(4, null, groups('notes', 'b'), 'folder');
  const c = node(3, a.id, { inherit: { notes: true }, groups: { notes: 'local' } });
  const d = doc([a, b, c], { notes: 'default' });
  assert.equal(run(d).private.groups.notes, 'a');
  a.props.groups.notes = 'a-edit'; assert.equal(run(d).private.groups.notes, 'a-edit');
  c.parentId = b.id; assert.equal(run(d).private.groups.notes, 'b');
  c.props.inherit.notes = false; assert.equal(run(d).private.groups.notes, 'local');
  c.props = {}; assert.equal(run(d).private.groups.notes, 'default');
  d.defaults.groups.notes = 'default-edit'; assert.equal(run(d).private.groups.notes, 'default-edit');
  assert.equal(run(d, { override: own({ notes: 'overlay' }) }).private.groups.notes, 'overlay');
  assert.equal(run(d).private.groups.notes, 'default-edit');
  delete d.objects[b.id]; assert.equal(E.resolveEffective(d, c.id, { documentGeneration: 1 }).error.code, 'missing-parent');
});

test('protocol settings and object flags are never inherited or leaked as unknown groups', () => {
  const d = doc([node(2, null, { host: 'parent.invalid', protocol: 'ssh', port: 1, certificateSha256: 'bad', clipboardToRemote: true, groups: { notes: 'parent' }, flags: { favorite: true } }, 'folder'), node(3, id(2), { host: 'target.invalid', port: 4321, protocol: 'rdp', groups: { notes: 'local' }, flags: { favorite: false }, unknownCanary: 'PRIVATE-CANARY' })]);
  const result = run(d);
  assert.equal(JSON.stringify(result.public).includes('parent.invalid'), false);
  assert.equal(JSON.stringify(result.public).includes('PRIVATE-CANARY'), false);
  assert.equal(Object.hasOwn(result.private.groups, 'host'), false);
  assert.equal(Object.hasOwn(result.private.groups, 'flags'), false);
  assert.deepEqual(d.objects[id(3)]!.props.flags, { favorite: false });
});

test('legacy direct notes/color remain supported, explicit grouped values win', () => {
  const d = doc([node(3, null, { notes: 'legacy', color: 'red', groups: { notes: '' } })]);
  const r = run(d); assert.equal(r.public.groups.notes, ''); assert.equal(r.public.groups.color, 'red');
  delete d.objects[id(3)]!.props.groups; assert.equal(run(d).public.groups.notes, 'legacy');
});

test('graph checks reject missing/invalid parent, cycle and 65 levels; 64 levels succeeds', () => {
  for (const [d, error] of [
    [doc([node(3, id(99))]), 'missing-parent'],
    [doc([node(3, id(2)), node(2)]), 'invalid-parent'],
    [doc([node(3, id(2)), node(2, id(4), {}, 'folder'), node(4, id(2), {}, 'folder')]), 'cycle'],
  ] as const) assert.equal(E.resolveEffective(d, id(3), { documentGeneration: 1 }).error.code, error);
  const levels = (n: number) => Array.from({ length: n }, (_, i) => node(i + 10, i === n - 1 ? null : id(i + 11), {}, i === 0 ? 'connection' : 'folder'));
  assert.equal(E.resolveEffective(doc(levels(64)), id(10), { documentGeneration: 1 }).ok, true);
  assert.equal(E.resolveEffective(doc(levels(65)), id(10), { documentGeneration: 1 }).error.code, 'too-deep');
  assert.equal(E.resolveEffective(doc(), id(99), { documentGeneration: 1 }).error.code, 'missing-object');
});

test('credential and protected refs carry actual owner, generation and secret kind privately', () => {
  const selection = { mode: 'inline', secretId: id(20) };
  const d = doc([node(3, null, { groups: { credentials: selection, customField11: { secretId: id(21) }, customProperties: { secretId: id(22) } } })]);
  const normal = run(d); assert.deepEqual(normal.private.credentialBinding, { selection, ownerDocumentId: d.id, ownerGeneration: 7 });
  assert.deepEqual(normal.private.protectedBindings.customField11, { secretId: id(21), ownerDocumentId: d.id, ownerGeneration: 7, kind: 'protected-value' });
  const r = run(d, { override: own({ credentials: selection, customField11: { secretId: id(21) } }, 9) });
  assert.equal(r.private.credentialBinding.ownerDocumentId, id(9)); assert.equal(r.private.credentialBinding.ownerGeneration, 9);
  assert.equal(r.private.protectedBindings.customField11.ownerDocumentId, id(9));
  assert.equal(JSON.stringify(r.public).includes(id(20)), false); assert.equal(JSON.stringify(r.public).includes(id(21)), false);
  assert.deepEqual(r.public.groups.customField11, { hasValue: true }); assert.deepEqual(r.public.groups.credentials, { mode: 'inline', hasSecret: true });
  assert.equal(E.resolveEffective(d, id(3), { documentGeneration: 7, override: { groups: { credentials: selection } } }).error.code, 'owner-missing');
  assert.equal(E.resolveEffective(d, id(3), { documentGeneration: 7, applicationDefaults: { credentials: selection } }).ok, true, 'object selection overrides missing application owner');
  assert.equal(E.resolveEffective(doc([node(3)]), id(3), { documentGeneration: 7, applicationDefaults: { credentials: selection } }).error.code, 'owner-missing');
});

test('group validation rejects unknown keys, raw protected values and contradictory credential inherit', () => {
  for (const value of [{ host: 'x' }, { notes: 1 }, { customField11: 'SECRET-CANARY' }, { customProperties: { password: 'SECRET-CANARY' } }, { credentials: { mode: 'inline', secretId: 'bad' } }, { credentials: { mode: 'none', password: 'SECRET-CANARY' } }, { rdGateway: { documentId: id(1), objectId: 'bad' } }]) {
    assert.throws(() => G.validateGroups(value), (error: any) => !error.message.includes('SECRET-CANARY') && error.code === 'bad-groups');
  }
  assert.throws(() => G.validateInheritance({ host: true }));
  assert.throws(() => G.validateInheritance({ notes: 'true' }));
  assert.throws(() => G.validateInheritance({}, { credentials: { mode: 'parent' } }));
  assert.throws(() => G.validateInheritance({ credentials: true }, { credentials: { mode: 'none' } }));
  assert.deepEqual(G.validateInheritance({ credentials: true }, { credentials: { mode: 'parent' } }), { credentials: true });
  assert.equal(E.resolveEffective(doc([node(3, null, { groups: { notes: 1 } })]), id(3), { documentGeneration: 1 }).error.code, 'invalid-groups');
});

test('unsupported refs are data until consumed; unsupported capability never executes', () => {
  const r = run(doc([node(3, null, groups('preConnectTask', { documentId: id(1), objectId: id(9) }))]));
  assert.equal(E.useEffectiveGroup(r, 'preConnectTask').error.code, 'not-supported');
  const capable = run(doc([node(3, null, groups('preConnectTask', { documentId: id(1), objectId: id(9) }))]), { capabilities: ['preConnectTask'] });
  assert.equal(E.useEffectiveGroup(capable, 'preConnectTask').ok, true);
  assert.equal(E.useEffectiveGroup(r, 'notes').ok, true);
});

test('public batch has a bounded count, safe projection and explicit invalidation versions', () => {
  const d = doc([node(3, null, groups('credentials', { mode: 'inline', secretId: id(20) }))]);
  const r = E.batchPublicEffective(d, [id(3)], { documentGeneration: 7, documentSeq: 12, vaultGeneration: 13, overrideGeneration: 14 });
  assert.equal(r.ok, true); assert.equal(r.value.seq, 12); assert.equal(r.value.vaultGeneration, 13); assert.equal(r.value.overrideGeneration, 14);
  assert.equal(r.value.items[0].objectId, id(3)); assert.equal(JSON.stringify(r).includes(id(20)), false);
  assert.equal(E.batchPublicEffective(d, Array(257).fill(id(3)), { documentGeneration: 1 }).error.code, 'too-many-targets');
  assert.equal(E.batchPublicEffective(d, [id(99)], { documentGeneration: 1 }).error.code, 'missing-object');
  assert.equal(E.batchPublicEffective(d, [id(3), id(3)], { documentGeneration: 1 }).error.code, 'duplicate-target');
});

test('returned effective values are detached from document and caller layers', () => {
  const selection = { mode: 'id', vaultId: id(90), credentialId: id(91) };
  const d = doc([node(3, null, groups('credentials', selection))]);
  const r = run(d); r.private.groups.credentials.credentialId = id(92);
  assert.equal(d.objects[id(3)]!.props.groups.credentials.credentialId, id(91));
});

test('invalid opaque legacy metadata reads as absent; explicit invalid groups still fail closed', () => {
  const d = doc([node(3, null, { notes: 99, color: 'plaid' })]);
  assert.deepEqual(run(d).public.groups, {});
  d.objects[id(3)]!.props = { groups: null };
  assert.equal(E.resolveEffective(d, id(3), { documentGeneration: 7 }).error.code, 'invalid-groups');
  d.objects[id(3)]!.props = { inherit: null };
  assert.equal(E.resolveEffective(d, id(3), { documentGeneration: 7 }).error.code, 'invalid-groups');
});

test('owner identity is a document UUID and generation, never an arbitrary path', () => {
  const d = doc([node(3)]);
  const r = E.resolveEffective(d, id(3), { documentGeneration: 7, temporary: { ownerDocumentId: '/private/secret-path', ownerGeneration: 1, groups: { customField11: { secretId: id(20) } } } });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'owner-missing');
  assert.equal(JSON.stringify(r).includes('secret-path'), false);
});

test('source provenance contains safe UUIDs only, never a path injected as an overlay owner', () => {
  const d = doc([node(3)]);
  const r = E.resolveEffective(d, id(3), { documentGeneration: 7, temporary: { ownerDocumentId: '/private/owner-path', ownerGeneration: 1, groups: { notes: 'public note' } } });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'owner-missing');
  assert.equal(JSON.stringify(r).includes('owner-path'), false);
});
