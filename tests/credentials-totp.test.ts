import assert from 'node:assert/strict';
import test from 'node:test';
import { composeMfa, totp, type TotpConfig } from '../src/credentials/totp.js';

const seeds = {
  sha1: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  sha256: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
  sha512: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
};
const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
const codes = { sha1: ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'], sha256: ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706'], sha512: ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826'] };
for (const algorithm of ['sha1', 'sha256', 'sha512'] as const) for (let i = 0; i < times.length; i++) {
  test(`RFC6238 ${algorithm} at ${times[i]}`, () => {
    const config: TotpConfig = { secretBase32: seeds[algorithm], algorithm, digits: 8, period: 30 };
    assert.equal(totp(config, times[i]!), codes[algorithm][i]);
    assert.equal(totp({ ...config, digits: 6 }, times[i]!), codes[algorithm][i]!.slice(-6));
  });
}
const config: TotpConfig = { secretBase32: seeds.sha1, algorithm: 'sha1', digits: 8, period: 30 };

test('64-bit counter, backward clock and period boundaries have no cached code', () => {
  assert.equal(totp(config, 30 * (2 ** 32 + 1)), '39108930'); // independent Python hmac + RFC4226 truncation
  assert.equal(totp(config, 59), '94287082');
  assert.equal(totp(config, 1111111109), '07081804');
  assert.equal(totp(config, 59), '94287082');
  assert.equal(totp({ ...config, period: 15 }, 29), '94287082');
  assert.equal(totp({ ...config, period: 120 }, 239), '94287082');
});

test('invalid Base32/config/time is refused without seed in diagnostics', () => {
  for (const secretBase32 of ['', 'canary invalid', 'gezdgnbv', 'AB', 'A', 'MZ', 'MZXW6===A', 'MZXW6====', '0O11', 'MZXW6===\n', 'A'.repeat(210)]) {
    assert.throws(() => totp({ ...config, secretBase32 }, 59), (error: Error) => error.message === 'Configuration TOTP tidak valid');
  }
  assert.equal(totp({ ...config, secretBase32: 'MZXW6===' }, 59).length, 8);
  for (const period of [0, 14, 121, 30.5, NaN]) assert.throws(() => totp({ ...config, period }, 59), /tidak valid/);
  for (const unix of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => totp(config, unix), /tidak valid/);
  assert.throws(() => totp({ ...config, algorithm: 'md5' as any }, 59), /tidak valid/);
  assert.throws(() => totp({ ...config, digits: 7 as any }, 59), /tidak valid/);
});

test('MFA requires an explicit mode, field and fixed composition; compute at engine use', () => {
  const identity = { username: 'local-user', domain: '', password: 'new-canary' };
  assert.deepEqual(composeMfa(identity, { mode: 'none' }, { unixSeconds: 59 }), identity);
  assert.deepEqual(composeMfa(identity, { mode: 'generate', field: 'password', pattern: 'ValueMfaCode', totp: config }, { unixSeconds: 59 }), { ...identity, password: 'new-canary94287082' });
  assert.deepEqual(composeMfa(identity, { mode: 'generate', field: 'username', pattern: 'MfaCodeValue', totp: config }, { unixSeconds: 1111111109 }), { ...identity, username: '07081804local-user' });
  const prompt = { mode: 'prompt', field: 'password', pattern: 'ValueMfaCode' } as const;
  assert.throws(() => composeMfa(identity, prompt, { unixSeconds: 59 }), /MFA/);
  assert.deepEqual(composeMfa(identity, prompt, { unixSeconds: 59, promptCode: { value: '000123', expiresAt: 60 } }), { ...identity, password: 'new-canary000123' });
  assert.throws(() => composeMfa(identity, prompt, { unixSeconds: 60, promptCode: { value: '000123', expiresAt: 60 } }), /MFA/);
  assert.throws(() => composeMfa(identity, { ...prompt, pattern: 'arbitrary' as any }, { unixSeconds: 59, promptCode: { value: '000123', expiresAt: 60 } }), /MFA/);
  assert.equal(identity.password, 'new-canary');
});
