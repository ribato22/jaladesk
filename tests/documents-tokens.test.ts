import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveToken, expandTokenFields, TokenError, type TokenContext } from '../src/documents/tokens.js';

const context: TokenContext = { Host: 'server.example', Name: 'Server Ω', Description: 'description', UserName: 'operator', Userdomain: 'LAB', Port: 4321,
  EffectiveNotes: 'inherited', EffectiveColor: 'green', customField1: 'custom', EffectiveCustomField10: 0 };
const code = (expected: string) => (e: unknown) => e instanceof TokenError && e.code === expected && !e.message.includes('PRIVATE-CANARY');

test('public names, effective values, adjacent tokens and Unicode expand once', () => {
  assert.equal(resolveToken('$Name$:$Host$:$Description$:$UserName$@$Userdomain$:$EffectiveNotes$:$EffectiveColor$:$customField1$:$EffectiveCustomField10$', context, { sink: 'label' }), 'Server Ω:server.example:description:operator@LAB:inherited:green:custom:0');
  assert.equal(resolveToken('$Name$$Host$', context, { sink: 'label' }), 'Server Ωserver.example');
  assert.equal(resolveToken('$Name$', { Name: '$Host$' }, { sink: 'label' }), '$Host$');
});

test('double dollar and quoted literals do not become recursive tokens', () => {
  assert.equal(resolveToken('cost $$10 $"$Host$"$ $Name$', context, { sink: 'label' }), 'cost $10 $Host$ Server Ω');
  assert.equal(resolveToken('$"quoted \\"text\\""$', context, { sink: 'label' }), 'quoted "text"');
  assert.throws(() => resolveToken('$"unterminated', context, { sink: 'label' }), code('invalid-token'));
  assert.throws(() => resolveToken('$Name', context, { sink: 'label' }), code('invalid-token'));
});

test('missing, unknown and unavailable dynamic tokens have fixed named failures', () => {
  assert.throws(() => resolveToken('$Name$', {}, { sink: 'label' }), code('missing-token'));
  assert.throws(() => resolveToken('$Bogus$', { Bogus: 'PRIVATE-CANARY' } as TokenContext, { sink: 'label' }), code('unknown-token'));
  for (const token of ['Env.HOME', 'Clipboard', 'DateTime', 'Shell.command', 'Provider.Value']) assert.throws(() => resolveToken(`$${token}$`, {}, { sink: 'label' }), code('not-supported'));
});

test('secret names and tainted public values cannot enter any public sink', () => {
  for (const sink of ['host', 'label', 'preview', 'log', 'filename'] as const) {
    for (const name of ['Password', 'MfaCode', 'ProtectedField', 'customField11', 'EffectiveCustomField20', 'EffectivePassword']) assert.throws(() => resolveToken(`$${name}$`, { [name]: 'PRIVATE-CANARY' } as TokenContext, { sink }), code('secret-token'));
    assert.throws(() => resolveToken('$Host$', { Host: { kind: 'secret-ref', secretId: 'PRIVATE-CANARY' } } as unknown as TokenContext, { sink }), code('secret-token'));
  }
});

test('port substitution is typed and a final expanded host is revalidated', () => {
  assert.equal(resolveToken('$Port$', context, { sink: 'port', type: 'number' }), 4321);
  assert.equal(resolveToken(3389, context, { sink: 'port', type: 'number' }), 3389);
  for (const input of ['$Name$', '4321', 'x$Port$', 0, 65536, 1.5]) assert.throws(() => resolveToken(input, context, { sink: 'port', type: 'number' }), code('invalid-value'));
  assert.equal(resolveToken('$Host$', context, { sink: 'host' }), 'server.example');
  for (const host of ['', 'a b', 'a\n', 'a'.repeat(254)]) assert.throws(() => resolveToken('$Host$', { Host: host }, { sink: 'host' }), code('invalid-value'));
});

test('64-token and UTF8 64KiB result limits include quoted and adjacent substitutions', () => {
  assert.equal(resolveToken('$Name$'.repeat(64), { Name: 'x' }, { sink: 'label' }), 'x'.repeat(64));
  assert.throws(() => resolveToken('$Name$'.repeat(65), { Name: '' }, { sink: 'label' }), code('token-limit'));
  assert.equal(resolveToken('x'.repeat(65536), {}, { sink: 'preview' }), 'x'.repeat(65536));
  assert.throws(() => resolveToken('$Name$', { Name: 'Ω'.repeat(32769) }, { sink: 'preview' }), code('token-limit'));
});

test('field expansion is allowlisted, detached and never walks opaque properties', () => {
  const props = { host: '$Host$', port: '$Port$', notes: '$Description$', opaque: { password: '$Password$' } };
  assert.deepEqual(expandTokenFields(props, context), { host: 'server.example', port: 4321, notes: 'description', opaque: { password: '$Password$' } });
  assert.equal(props.host, '$Host$');
  assert.throws(() => expandTokenFields({ port: '4321' }, context), code('invalid-value'));
});
