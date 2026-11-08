import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePassword, analyzeCredentials } from '../src/credentials/hygiene.js';

test('generator boundaries, selected classes and ambiguous exclusion', () => {
  for (const length of [12, 20, 128]) {
    const password = generatePassword({ length, symbols: true });
    assert.equal(password.length, length);
    assert.match(password, /[a-z]/); assert.match(password, /[A-Z]/); assert.match(password, /[2-9]/); assert.match(password, /[!@#$%&*+\-=?_]/);
    assert.doesNotMatch(password, /[0O1Il|`'"\\]/);
  }
  assert.equal(generatePassword().length, 20);
  assert.match(generatePassword({ lowercase: false, uppercase: false, digits: true, excludeAmbiguous: false }), /^\d{20}$/);
  for (const value of [0, 11, 129, 12.5, NaN]) assert.throws(() => generatePassword({ length: value }), /Konfigurasi/);
  assert.throws(() => generatePassword({ lowercase: false, uppercase: false, digits: false, symbols: false }), /Konfigurasi/);
  assert.throws(() => generatePassword({ uppercase: 'yes' as any }), /Konfigurasi/);
});

test('rejection sampling discards out-of-range bytes and failed random providers', () => {
  let calls = 0;
  const password = generatePassword({ length: 12, lowercase: false, uppercase: false, digits: true, excludeAmbiguous: false }, (bytes) => {
    bytes.fill(calls++ === 0 ? 255 : 9);
    return bytes;
  });
  assert.equal(password, '999999999999'); assert.equal(calls, 2);
  assert.throws(() => generatePassword({}, () => { throw new Error('password-canary'); }), /Sumber acak/);
  assert.throws(() => generatePassword({}, () => new Uint8Array(1)), /Sumber acak/);
  assert.throws(() => generatePassword({}, (bytes) => { bytes.fill(255); return bytes; }), /Sumber acak/);
});

test('analyzer requires opt-in scope and emits only safe IDs, counts and heuristic summaries', async () => {
  const entries = [{ id: 'a', status: 'available' as const, password: 'reused-password-canary' }, { id: 'b', status: 'available' as const, password: 'reused-password-canary' }, { id: 'c', status: 'locked' as const }, { id: 'd', status: 'missing' as const }, { id: 'e', status: 'available' as const, password: '' }];
  await assert.rejects(analyzeCredentials(entries, { optIn: false, ids: ['a'] }), /Persetujuan/);
  await assert.rejects(analyzeCredentials(entries, { optIn: true, ids: ['unknown'] }), /Cakupan/);
  const answer = await analyzeCredentials(entries, { optIn: true, ids: ['a', 'b', 'c', 'd', 'e'] });
  assert.deepEqual(answer.reuse, [{ ids: ['a', 'b'], count: 2 }]);
  assert.deepEqual(answer.entries.map((e) => [e.id, e.status, e.reuseCount]), [['a', 'available', 2], ['b', 'available', 2], ['c', 'locked', 0], ['d', 'missing', 0], ['e', 'empty', 0]]);
  assert.match(answer.notice, /perkiraan/i);
  assert.doesNotMatch(JSON.stringify(answer), /canary|password|digest|hash|hmac/i);
  const single = await analyzeCredentials(entries, { optIn: true, ids: ['a'] });
  assert.deepEqual(single.reuse, []); assert.equal(single.entries[0]!.reuseCount, 1);
});


test('analysis does not read excluded, empty or locked secret values', async () => {
  const ignored = { id: 'private', status: 'available' as const, get password(): string { throw new Error('must not inspect'); } };
  const locked = { id: 'locked', status: 'locked' as const, get password(): string { throw new Error('must not inspect'); } };
  await assert.rejects(analyzeCredentials([ignored], { optIn: false, ids: ['private'] }), /Persetujuan/);
  assert.deepEqual((await analyzeCredentials([ignored, locked], { optIn: true, ids: ['locked'] })).entries, [{ id: 'locked', status: 'locked', reuseCount: 0 }]);
});
