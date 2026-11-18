import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildOtpAuthUri,
  calculateTotpTiming,
  composeMfa,
  decodeBase32,
  DesktopTotpVaultStore,
  evaluateTotpToken,
  formatTotpCode,
  fromCloudSyncTotpItem,
  generateTotpCode,
  parseOtpAuthUri,
  toCloudSyncTotpItem,
  totp,
  type TotpAlgorithm,
} from '../src/credentials/totp.js';
import {
  APP_LOCK_PBKDF2_ITERATIONS,
  APP_LOCK_TIMEOUT_PRESETS,
  AppLockPinError,
  AppLockPinManager,
  computeExponentialCooldownMs,
  hashAppLockPin,
  verifyAppLockPin,
} from '../src/desktop/app-lock-pin.js';

const RFC6238_SEEDS: Record<TotpAlgorithm, string> = {
  SHA1: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  SHA256: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
  SHA512:
    'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
};

const RFC6238_TIMES = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000] as const;

const RFC6238_EXPECTED_8: Record<TotpAlgorithm, readonly string[]> = {
  SHA1: ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'],
  SHA256: ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706'],
  SHA512: ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826'],
};

test('RFC 6238 vectors match for SHA1/SHA256/SHA512 across 6 & 8 digits and 30s & 60s periods', () => {
  for (const algorithm of ['SHA1', 'SHA256', 'SHA512'] as const) {
    const seed = RFC6238_SEEDS[algorithm];
    RFC6238_TIMES.forEach((unixSeconds, idx) => {
      const expected8 = RFC6238_EXPECTED_8[algorithm][idx]!;
      const expected6 = expected8.slice(-6);

      assert.equal(
        generateTotpCode({ secretBase32: seed, algorithm, digits: 8, period: 30 }, unixSeconds),
        expected8,
      );
      assert.equal(
        generateTotpCode({ secretBase32: seed, algorithm, digits: 6, period: 30 }, unixSeconds),
        expected6,
      );
      // Uppercase algorithm support in legacy totp() while preserving backward compatibility
      assert.equal(
        totp({ secretBase32: seed, algorithm, digits: 8, period: 30 }, unixSeconds),
        expected8,
      );
      // Same RFC counter step with 60s period occurs at 2 * unixSeconds (since floor((2*t)/60) === floor(t/30) for even/exact multiples)
      const counterStep = Math.floor(unixSeconds / 30);
      const equivalent60sTime = counterStep * 60 + 59;
      assert.equal(
        generateTotpCode({ secretBase32: seed, algorithm, digits: 8, period: 60 }, equivalent60sTime),
        expected8,
      );
      assert.equal(
        generateTotpCode({ secretBase32: seed, algorithm, digits: 6, period: 60 }, equivalent60sTime),
        expected6,
      );
    });
  }

  assert.equal(formatTotpCode('942870'), '942 870');
  assert.equal(formatTotpCode('94287082'), '9428 7082');
});

test('backward compatibility of decodeBase32, totp, and composeMfa is strictly preserved', () => {
  const buf = decodeBase32('JBSWY3DPEHPK3PXP');
  assert.equal(buf.toString('hex'), '48656c6c6f21deadbeef');
  assert.throws(() => decodeBase32('jbswy3dpehpk3pxp'), /Configuration TOTP tidak valid/);

  const identity = { username: 'ops', domain: 'CORP', password: 'secret-' };
  const out = composeMfa(
    identity,
    {
      mode: 'generate',
      field: 'password',
      pattern: 'ValueMfaCode',
      totp: { secretBase32: RFC6238_SEEDS.SHA1, algorithm: 'sha1', digits: 6, period: 30 },
    },
    { unixSeconds: 59 },
  );
  assert.equal(out.password, 'secret-287082');
});

test('remaining seconds and progress ratio calculation for 30s and 60s periods', () => {
  const start30 = calculateTotpTiming(30, 60_000);
  assert.equal(start30.remainingSeconds, 30);
  assert.equal(start30.remainingMs, 30_000);
  assert.equal(start30.progressRatio, 1);
  assert.equal(start30.elapsedRatio, 0);

  const mid30 = calculateTotpTiming(30, 75_000);
  assert.equal(mid30.remainingSeconds, 15);
  assert.equal(mid30.remainingMs, 15_000);
  assert.equal(mid30.progressRatio, 0.5);
  assert.equal(mid30.elapsedRatio, 0.5);

  const end30 = calculateTotpTiming(30, 89_500);
  assert.equal(end30.remainingSeconds, 1);
  assert.equal(end30.remainingMs, 500);
  assert.ok(Math.abs(end30.progressRatio - 500 / 30_000) < 1e-9);

  const mid60 = calculateTotpTiming(60, 45_000);
  assert.equal(mid60.remainingSeconds, 15);
  assert.equal(mid60.remainingMs, 15_000);
  assert.equal(mid60.progressRatio, 0.25);

  const live = evaluateTotpToken(
    { secretBase32: 'jbsw y3dp-ehpk 3pxp', algorithm: 'SHA-256', digits: 8, period: 60 },
    120_000,
  );
  assert.equal(live.algorithm, 'SHA256');
  assert.equal(live.digits, 8);
  assert.equal(live.period, 60);
  assert.equal(live.remainingSeconds, 60);
  assert.equal(live.progressRatio, 1);
  assert.match(live.formattedCode, /^\d{4} \d{4}$/);
});

test('parseOtpAuthUri and buildOtpAuthUri support full RFC KeyUriFormat and reject malformed URIs', () => {
  const uri =
    'otpauth://totp/GitHub%20Enterprise:sre%40jaladesk.io?secret=jbsw-y3dp%20ehpk-3pxp&issuer=GitHub%20Enterprise&algorithm=SHA-512&digits=8&period=60';
  const parsed = parseOtpAuthUri(uri);
  assert.deepEqual(parsed, {
    issuer: 'GitHub Enterprise',
    accountName: 'sre@jaladesk.io',
    label: 'GitHub Enterprise:sre@jaladesk.io',
    secretBase32: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA512',
    digits: 8,
    period: 60,
  });

  const built = buildOtpAuthUri({
    issuer: parsed.issuer,
    accountName: parsed.accountName,
    secretBase32: parsed.secretBase32,
    algorithm: parsed.algorithm,
    digits: parsed.digits,
    period: parsed.period,
  });
  assert.deepEqual(parseOtpAuthUri(built), parsed);

  const minimal = parseOtpAuthUri('otpauth://totp/prod-bastion?secret=JBSWY3DPEHPK3PXP');
  assert.equal(minimal.issuer, '');
  assert.equal(minimal.accountName, 'prod-bastion');
  assert.equal(minimal.algorithm, 'SHA1');
  assert.equal(minimal.digits, 6);
  assert.equal(minimal.period, 30);

  for (const bad of [
    'https://example.com/totp?secret=JBSWY3DPEHPK3PXP',
    'otpauth://hotp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&counter=1',
    'otpauth://totp/GitHub:alice',
    'otpauth://totp/GitHub:alice?secret=INVALID0189!',
    'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&digits=7',
    'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&period=45',
    'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&algorithm=MD5',
  ]) {
    assert.throws(() => parseOtpAuthUri(bad));
  }
});

test('DesktopTotpVaultStore encrypts at rest and interoperates with Mobile Cloud Sync totpItems', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jaladesk-totp-vault-'));
  try {
    let clock = 1_700_000_000_000;
    const store = await DesktopTotpVaultStore.open(dir, { now: () => clock });

    const item1 = await store.addFromOtpAuthUri(
      'otpauth://totp/Cloudflare:ops%40corp.example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Cloudflare&algorithm=SHA256&digits=8&period=60',
      { id: 'totp-cf-1' },
    );
    assert.equal(item1.id, 'totp-cf-1');
    assert.equal(item1.issuer, 'Cloudflare');
    assert.equal(item1.accountName, 'ops@corp.example');
    assert.equal(item1.algorithm, 'SHA256');
    assert.equal(item1.digits, 8);
    assert.equal(item1.period, 60);

    clock += 5_000;
    const item2 = await store.upsert({
      id: 'totp-aws-2',
      issuer: 'AWS',
      accountName: 'root@prod',
      secretBase32: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    assert.equal(item2.updatedAtMs, clock);

    // Verify encrypted-at-rest envelope contains no plaintext secret or account name
    const rawVaultFile = await readFile(join(dir, 'jaladesk-totp-vault.v1.json'), 'utf8');
    assert.equal(rawVaultFile.includes('JBSWY3DPEHPK3PXP'), false);
    assert.equal(rawVaultFile.includes('GEZDGNBVGY3TQOJQ'), false);
    assert.equal(rawVaultFile.includes('ops@corp.example'), false);

    // Reload from disk and verify persistence + live code evaluation
    const reopened = await DesktopTotpVaultStore.open(dir, { now: () => clock });
    assert.equal(reopened.list().length, 2);
    const liveItems = reopened.listWithCodes(59_000);
    assert.equal(liveItems.length, 2);
    assert.equal(liveItems[0]!.code.length, 8);
    assert.equal(liveItems[1]!.code.length, 6);

    // Wrong master key must fail AES-GCM authentication tag check
    await assert.rejects(() =>
      DesktopTotpVaultStore.open(dir, { masterKey: Buffer.alloc(32, 0xaa) }),
    );

    // Export for Cloud Sync includes Mobile-compatible `label` and `periodSeconds`
    const exported = reopened.exportCloudSyncItems();
    assert.equal(exported[0]!.label, 'ops@corp.example');
    assert.equal(exported[0]!.periodSeconds, 60);
    assert.deepEqual(fromCloudSyncTotpItem(toCloudSyncTotpItem(item1)), item1);

    // Remove item2 locally (creates `totp:totp-aws-2` tombstone) and merge with Mobile remote payload
    clock += 10_000;
    assert.equal(await reopened.remove('totp-aws-2'), true);
    assert.equal(reopened.getTombstones()['totp:totp-aws-2'], clock);

    const mobileRemoteItems = [
      // Older version of deleted item2 -> must stay deleted because tombstone is newer
      {
        id: 'totp-aws-2',
        label: 'root@prod',
        issuer: 'AWS',
        secretBase32: 'JBSWY3DPEHPK3PXP',
        algorithm: 'SHA-1',
        digits: 6,
        periodSeconds: 30,
        updatedAtMs: clock - 5_000,
      },
      // Newer update to item1 from Mobile + brand new item3 from Mobile
      {
        id: 'totp-cf-1',
        label: 'secops@corp.example',
        issuer: 'Cloudflare Zero Trust',
        secretBase32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        algorithm: 'SHA-256',
        digits: 8,
        periodSeconds: 60,
        updatedAtMs: clock + 20_000,
      },
      {
        id: 'totp-okta-3',
        label: 'admin@okta',
        issuer: 'Okta',
        secretBase32: 'JBSWY3DPEHPK3PXP',
        algorithm: 'SHA-512',
        digits: 6,
        periodSeconds: 30,
        updatedAtMs: clock + 25_000,
      },
    ];

    const merged = await reopened.mergeCloudSyncItems(mobileRemoteItems, {});
    assert.deepEqual(
      merged.items.map((i) => ({ id: i.id, accountName: i.accountName, algorithm: i.algorithm })),
      [
        { id: 'totp-cf-1', accountName: 'secops@corp.example', algorithm: 'SHA256' },
        { id: 'totp-okta-3', accountName: 'admin@okta', algorithm: 'SHA512' },
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AppLockPin hash/verify enforces 4-8 digits, 120000 PBKDF2-SHA256 iterations, and constant-time check', async () => {
  const hash1 = await hashAppLockPin('042918');
  const hash2 = await hashAppLockPin('042918');
  assert.notEqual(hash1, hash2); // unique 16-byte CSPRNG salt per call
  const parts = hash1.split(':');
  assert.equal(parts[0], 'pbkdf2-sha256');
  assert.equal(Number(parts[1]), APP_LOCK_PBKDF2_ITERATIONS);
  assert.equal(Buffer.from(parts[2]!, 'base64').length, 16);
  assert.equal(Buffer.from(parts[3]!, 'base64').length, 32);

  assert.equal(await verifyAppLockPin('042918', hash1), true);
  assert.equal(await verifyAppLockPin('042919', hash1), false);

  // Mobile `pbkdf2:<iters>:<salt>:<hash>` record format also verifies cleanly
  const mobileStyleRecord = hash1.replace(/^pbkdf2-sha256:/, 'pbkdf2:');
  assert.equal(await verifyAppLockPin('042918', mobileStyleRecord), true);

  for (const invalidPin of ['', '123', '123456789', '12ab', '1234 ', 'abcd']) {
    await assert.rejects(
      () => hashAppLockPin(invalidPin),
      (err: unknown) => err instanceof AppLockPinError && err.code === 'invalid-pin',
    );
  }
});

test('AppLockPinManager lifecycle: set, cold-start lock, verify, change, remove, cooldown, and auto-lock presets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jaladesk-app-lock-pin-'));
  try {
    let clock = 1_700_000_000_000;
    const manager = await AppLockPinManager.open(dir, { now: () => clock });
    assert.deepEqual(APP_LOCK_TIMEOUT_PRESETS, [0, 60, 300, 900, -1]);
    assert.equal(manager.getState().isPinConfigured, false);
    assert.equal(manager.getState().isLocked, false);

    // Set 6-digit PIN
    const afterSet = await manager.setPin('246810');
    assert.equal(afterSet.isPinConfigured, true);
    assert.equal(afterSet.pinLength, 6);
    assert.equal(afterSet.isLocked, false);
    assert.equal(afterSet.autoLockTimeoutSeconds, 300);

    // Verify no plaintext PIN exists on disk
    const rawJson = await readFile(join(dir, 'jaladesk-app-lock-pin.v1.json'), 'utf8');
    assert.equal(rawJson.includes('246810'), false);

    // Overwriting without currentPin must be refused
    await assert.rejects(
      () => manager.setPin('1111'),
      (err: unknown) => err instanceof AppLockPinError && err.code === 'pin-already-configured',
    );

    // Cold-start reopen starts in locked state
    const coldStart = await AppLockPinManager.open(dir, { now: () => clock });
    assert.equal(coldStart.getState().isPinConfigured, true);
    assert.equal(coldStart.getState().pinLength, 6);
    assert.equal(coldStart.getState().isLocked, true);

    // Brute-force exponential cooldown after 5 failed attempts
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await coldStart.verifyPin('000000');
      assert.equal(res.verified, false);
      assert.equal(res.lockedOut, false);
      assert.equal(res.failedAttempts, attempt);
      assert.equal(res.cooldownRemainingMs, 0);
    }

    // 5th failed attempt triggers 15s cooldown
    const fifth = await coldStart.verifyPin('000000');
    assert.equal(fifth.verified, false);
    assert.equal(fifth.lockedOut, true);
    assert.equal(fifth.failedAttempts, 5);
    assert.equal(fifth.cooldownRemainingMs, 15_000);
    assert.equal(fifth.cooldownRemainingSeconds, 15);

    // Even the RIGHT PIN is rejected while cooldown is active
    clock += 5_000;
    const blockedDuringCooldown = await coldStart.verifyPin('246810');
    assert.equal(blockedDuringCooldown.verified, false);
    assert.equal(blockedDuringCooldown.lockedOut, true);
    assert.equal(blockedDuringCooldown.cooldownRemainingSeconds, 10);

    // Cooldown persists across app restart
    const restartedDuringCooldown = await AppLockPinManager.open(dir, { now: () => clock });
    assert.equal(restartedDuringCooldown.getState().cooldownRemainingSeconds, 10);

    // After 15s cooldown expires, 6th failure doubles cooldown to 30s
    clock += 10_000;
    const sixth = await restartedDuringCooldown.verifyPin('999999');
    assert.equal(sixth.verified, false);
    assert.equal(sixth.lockedOut, true);
    assert.equal(sixth.failedAttempts, 6);
    assert.equal(sixth.cooldownRemainingMs, 30_000);
    assert.equal(computeExponentialCooldownMs(7), 60_000);
    assert.equal(computeExponentialCooldownMs(8), 120_000);
    assert.equal(computeExponentialCooldownMs(9), 240_000);
    assert.equal(computeExponentialCooldownMs(10), 300_000);
    assert.equal(computeExponentialCooldownMs(12), 300_000);

    // Wait out 30s cooldown, then unlock with correct PIN -> resets failedAttempts & unlocks
    clock += 30_000;
    const unlocked = await restartedDuringCooldown.verifyPin('246810');
    assert.equal(unlocked.verified, true);
    assert.equal(unlocked.lockedOut, false);
    assert.equal(unlocked.failedAttempts, 0);
    assert.equal(unlocked.state.isLocked, false);

    // Auto-Lock preset evaluation: 60s (1m)
    await restartedDuringCooldown.setAutoLockTimeout(60);
    clock += 30_000;
    assert.equal(restartedDuringCooldown.evaluateInactivity(clock).isLocked, false);
    restartedDuringCooldown.recordActivity(clock); // reset activity timer at +30s
    clock += 45_000;
    assert.equal(restartedDuringCooldown.evaluateInactivity(clock).isLocked, false);
    clock += 15_000; // 60s since last activity -> locks!
    assert.equal(restartedDuringCooldown.evaluateInactivity(clock).isLocked, true);

    // Unlock and test `-1` (Off) -> never auto-locks even after hours or backgrounding
    await restartedDuringCooldown.unlock('246810');
    await restartedDuringCooldown.setAutoLockTimeout(-1);
    clock += 3_600_000;
    assert.equal(restartedDuringCooldown.evaluateInactivity(clock, { backgrounded: true }).isLocked, false);

    // Test `0` (Immediate) -> locks immediately on background/idle check
    await restartedDuringCooldown.setAutoLockTimeout(0);
    assert.equal(restartedDuringCooldown.evaluateInactivity(clock, { backgrounded: true }).isLocked, true);
    await restartedDuringCooldown.unlock('246810');

    // Change PIN to 8-digit PIN (requires current PIN)
    await assert.rejects(
      () => restartedDuringCooldown.changePin('000000', '13572468'),
      (err: unknown) => err instanceof AppLockPinError && err.code === 'verification-failed',
    );
    const changed = await restartedDuringCooldown.changePin('246810', '13572468');
    assert.equal(changed.pinLength, 8);
    restartedDuringCooldown.lockNow();
    assert.equal(restartedDuringCooldown.getState().isLocked, true);
    assert.equal((await restartedDuringCooldown.verifyPin('246810')).verified, false);
    assert.equal((await restartedDuringCooldown.verifyPin('13572468')).verified, true);

    // Remove PIN (requires current PIN)
    const removed = await restartedDuringCooldown.removePin('13572468');
    assert.equal(removed.isPinConfigured, false);
    assert.equal(removed.pinLength, null);
    assert.equal(removed.isLocked, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
