import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AES_256_GCM_CIPHER,
  DEFAULT_PBKDF2_ITERATIONS,
  EncryptedVaultBackupCodec,
  GOOGLE_DRIVE_PRIMARY_VAULT_FILE,
  GITHUB_PRIMARY_GIST_FILE,
  JALADESK_VAULT_FORMAT_ID,
  JDESK_SYNC_SCHEMA_ID,
  PBKDF2_HMAC_SHA256_KDF,
  VaultCloudSyncCrypto,
  VaultSyncPayloadMerger,
  createDefaultVaultSyncConfig,
  effectiveEncryptionPassphrase,
} from '../src/desktop/cloud-sync-service.js';
import {
  buildOtpAuthUri as desktopBuildOtpAuthUri,
  calculateTotpTiming as desktopCalculateTotpTiming,
  formatTotpCode as desktopFormatTotpCode,
  generateTotpCode as desktopGenerateTotpCode,
  parseOtpAuthUri as desktopParseOtpAuthUri,
} from '../src/credentials/totp.js';

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  dump(): Record<string, string>;
}

interface WebVaultPayload {
  syncSchema: number;
  updatedAtMs: number;
  hosts: Record<string, unknown>[];
  credentials: Record<string, unknown>[];
  folders: Record<string, unknown>[];
  totp: Record<string, unknown>[];
  snippets: Record<string, unknown>[];
  tombstones: Record<string, number>;
  [key: string]: unknown;
}

interface WebSealedStoreInstance {
  hasSealedVault(): boolean;
  getSealedEnvelope(): string | null;
  isUnlocked(): boolean;
  getPayload(): WebVaultPayload;
  getUiPrefs(): Record<string, unknown>;
  saveUiPrefs(partial: Record<string, unknown>): Record<string, unknown>;
  onLock(listener: () => void): () => void;
  touchActivity(): void;
  createVault(passphrase: string, initialPayload?: Record<string, unknown> | null): Promise<WebVaultPayload>;
  unlock(passphrase: string): Promise<WebVaultPayload>;
  savePayload(nextPayload: Record<string, unknown>): Promise<WebVaultPayload>;
  importEnvelope(
    rawEnvelopeJson: string,
    passphrase: string,
    options?: { mode?: 'merge' | 'replace'; localPassphrase?: string },
  ): Promise<WebVaultPayload>;
  exportEnvelope(overridePassphrase?: string): Promise<string>;
  changePassphrase(newPassphrase: string): Promise<WebVaultPayload>;
  lock(): void;
  resetVault(options?: { clearPrefs?: boolean }): void;
}

interface VaultCoreModule {
  JALADESK_VAULT_FORMAT_ID: string;
  JDESK_SYNC_SCHEMA_ID: string;
  SEALED_VAULT_STORAGE_KEY: string;
  UI_PREFS_STORAGE_KEY: string;
  VaultCoreError: new (message: string, code?: string, statusCode?: number | null) => Error & {
    code: string;
    statusCode: number | null;
  };
  sealVaultEnvelope(
    payload: Record<string, unknown>,
    passphrase: string,
    options?: { iterations?: number },
  ): Promise<string>;
  openVaultEnvelope(rawEnvelopeJson: string, passphrase: string): Promise<Record<string, unknown>>;
  deriveGoogleAccountBoundPassphrase(email: string): string;
  createEmptyVaultPayload(nowMs?: number): WebVaultPayload;
  normalizeVaultPayload(source: Record<string, unknown>, options?: { nowMs?: number }): WebVaultPayload;
  mergeVaultPayloads(
    localPayload: Record<string, unknown>,
    remotePayload: Record<string, unknown>,
    options?: { nowMs?: number },
  ): WebVaultPayload;
  makeTombstoneKey(collection: string, key: string): string;
  generateTotpCode(
    params: { secretBase32: string; algorithm?: string; digits?: number; period?: number },
    nowMs?: number | { nowMs?: number; unixSeconds?: number },
  ): Promise<string>;
  formatTotpCode(code: string): string;
  calculateTotpTiming(
    period?: number,
    nowMs?: number,
  ): {
    period: number;
    elapsedMs: number;
    remainingMs: number;
    remainingSeconds: number;
    progressRatio: number;
    elapsedRatio: number;
    counter: bigint;
  };
  parseOtpAuthUri(uri: string): {
    issuer: string;
    accountName: string;
    label: string;
    secretBase32: string;
    algorithm: string;
    digits: number;
    period: number;
  };
  buildOtpAuthUri(item: {
    issuer?: string;
    accountName: string;
    secretBase32: string;
    algorithm?: string;
    digits?: number;
    period?: number;
  }): string;
  hasGoogleDriveAppDataScope(scopeStr: string | undefined | null): boolean;
  requestGoogleWebAccessToken(params: {
    clientId: string;
    loginHint?: string;
    prompt?: string;
    scope?: string;
    gsiLoader?: () => Promise<unknown>;
    windowObj?: unknown;
  }): Promise<{
    accessToken: string;
    grantedScope: string;
    expiresInSec: number;
    hasAppDataScope: boolean;
  }>;
  fetchGoogleUserInfo(
    accessToken: string,
    options?: { userInfoUrl?: string; fetchImpl?: typeof fetch },
  ): Promise<{ email: string; displayName: string }>;
  syncWithGoogleDriveAppData(params: {
    accessToken: string;
    localPayload: Record<string, unknown>;
    passphrase: string;
    mode?: 'smartMerge' | 'pullOnly' | 'pushForce';
    apiBaseUrl?: string;
    fileName?: string;
    grantedScope?: string;
    nowMs?: number;
  }): Promise<{
    payload: WebVaultPayload;
    mode: string;
    provider: string;
    fileId: string | null;
    fileName: string;
    hadRemote: boolean;
    uploaded: boolean;
    syncedAtMs: number;
  }>;
  unlockOrSyncGoogleVault(params: {
    vaultStore?: WebSealedStoreInstance;
    accessToken: string;
    grantedScope?: string;
    passphrase: string;
    apiBaseUrl?: string;
    fileName?: string;
    nowMs?: number;
  }): Promise<{
    payload: WebVaultPayload;
    mode: string;
    provider: string;
    fileId: string | null;
    fileName: string;
    hadRemote: boolean;
    uploaded: boolean;
    syncedAtMs: number;
    mergedLocal: boolean;
    createdFresh: boolean;
  }>;
  syncWithGithubGist(params: {
    token: string;
    gistId?: string;
    localPayload: Record<string, unknown>;
    passphrase: string;
    mode?: 'smartMerge' | 'pullOnly' | 'pushForce';
    apiBaseUrl?: string;
    fileName?: string;
    nowMs?: number;
  }): Promise<{
    payload: WebVaultPayload;
    mode: string;
    provider: string;
    gistId: string | null;
    fileName: string;
    hadRemote: boolean;
    uploaded: boolean;
    syncedAtMs: number;
  }>;
  syncWithWebDav(params: {
    url: string;
    username?: string;
    password?: string;
    localPayload: Record<string, unknown>;
    passphrase: string;
    mode?: 'smartMerge' | 'pullOnly' | 'pushForce';
    nowMs?: number;
    fetchImpl?: typeof fetch;
  }): Promise<{
    payload: WebVaultPayload;
    mode: string;
    provider: string;
    url: string;
    hadRemote: boolean;
    uploaded: boolean;
    syncedAtMs: number;
  }>;
  SealedBrowserVaultStore: new (options?: {
    storage?: Storage | MemoryStorage;
    vaultKey?: string;
    prefsKey?: string;
  }) => WebSealedStoreInstance;
}

interface WebOAuthConfigModule {
  GOOGLE_CLOUD_PROJECT_NUMBER: string;
  BUILTIN_GOOGLE_WEB_CLIENT_ID: string;
  resolveGoogleWebOAuthClientId(
    customClientId?: string | null,
    options?: { builtinClientId?: string; builtinClientIdOverride?: string },
  ): string;
}

const VAULT_CORE_URL = new URL('../../docs/app/vault-core.js', import.meta.url);
const WEB_OAUTH_CONFIG_URL = new URL('../../docs/app/web-oauth-config.js', import.meta.url);
const INDEX_HTML_URL = new URL('../../docs/app/index.html', import.meta.url);
const APP_JS_URL = new URL('../../docs/app/app.js', import.meta.url);
const MANIFEST_URL = new URL('../../docs/app/manifest.webmanifest', import.meta.url);
const SW_URL = new URL('../../docs/app/sw.js', import.meta.url);

let cachedCore: Promise<VaultCoreModule> | null = null;
function loadVaultCore(): Promise<VaultCoreModule> {
  cachedCore ??= import(VAULT_CORE_URL.href) as Promise<VaultCoreModule>;
  return cachedCore;
}

let cachedWebOAuthConfig: Promise<WebOAuthConfigModule> | null = null;
function loadWebOAuthConfig(): Promise<WebOAuthConfigModule> {
  cachedWebOAuthConfig ??= import(WEB_OAUTH_CONFIG_URL.href) as Promise<WebOAuthConfigModule>;
  return cachedWebOAuthConfig;
}

function createMemoryStorage(): MemoryStorage {
  const store = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    dump(): Record<string, string> {
      return Object.fromEntries(store.entries());
    },
  };
}

function buildSampleVaultPayload(): WebVaultPayload {
  return {
    syncSchema: 2,
    updatedAtMs: 1_760_000_500_000,
    hosts: [
      {
        id: 'host-bastion-1',
        name: 'Prod EU Bastion',
        address: '10.24.0.10',
        port: 22,
        protocol: 'ssh',
        folder: 'Production',
        osLabel: 'Ubuntu 24.04',
        domain: '',
        username: 'opsadmin',
        password: 'BastionSecret#99',
        privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----\nTESTKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----',
        jumpHostId: null,
        credentialId: 'cred-ops',
        isJumpHost: true,
        isFavorite: true,
        accentTint: '#38BDF8',
        updatedAtMs: 1_760_000_100_000,
      },
      {
        id: 'host-rdp-core',
        name: 'Finance Windows 11',
        address: '10.24.8.42',
        port: 3389,
        protocol: 'rdp',
        folder: 'Production',
        osLabel: 'Windows 11 Enterprise',
        domain: 'CORP',
        username: 'svc_rdp',
        password: 'RdpPassword!2026',
        privateKeyPem: '',
        jumpHostId: 'host-bastion-1',
        credentialId: null,
        isJumpHost: false,
        isFavorite: false,
        accentTint: '#6366F1',
        updatedAtMs: 1_760_000_200_000,
      },
    ],
    credentials: [
      {
        id: 'cred-ops',
        label: 'Ops Root Key',
        domain: 'CORP',
        username: 'opsadmin',
        password: 'UltraSecretVaultPassword#42',
        privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----\nCREDKEY\n-----END OPENSSH PRIVATE KEY-----',
        notes: 'Primary bastion credential',
        updatedAtMs: 1_760_000_150_000,
      },
    ],
    folders: [
      {
        name: 'Production',
        jumpHostId: 'host-bastion-1',
        credentialId: 'cred-ops',
        updatedAtMs: 1_760_000_120_000,
      },
    ],
    totp: [
      {
        id: 'totp-aws',
        label: 'prod-root@corp.example',
        accountName: 'prod-root@corp.example',
        issuer: 'AWS Production',
        secretBase32: 'JBSWY3DPEHPK3PXP',
        algorithm: 'SHA256',
        digits: 6,
        period: 30,
        periodSeconds: 30,
        updatedAtMs: 1_760_000_300_000,
      },
    ],
    snippets: [
      {
        id: 'snip-health',
        title: 'Systemd Health',
        command: 'systemctl --failed && df -h',
        category: 'Diagnostics',
        updatedAtMs: 1_760_000_400_000,
      },
    ],
    tombstones: {
      'host:legacy-01': 1_760_000_050_000,
    },
  };
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startLoopbackServer(
  handler: http.RequestListener,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

test('a. Desktop <-> WebCrypto .jvault envelope byte-for-byte cross-platform interop', async () => {
  const core = await loadVaultCore();
  const passphrase = 'ZeroTrust#2026-CrossPlatform!';
  const payload = buildSampleVaultPayload();

  // 1. Desktop EncryptedVaultBackupCodec.sealJson -> Web openVaultEnvelope
  const desktopSealed = EncryptedVaultBackupCodec.sealJson({
    payload: payload as unknown as Record<string, unknown>,
    passphrase,
  });
  const openedByWeb = await core.openVaultEnvelope(desktopSealed, passphrase);
  assert.deepStrictEqual(openedByWeb, payload);

  // 2. Web sealVaultEnvelope -> Desktop EncryptedVaultBackupCodec.openJson & VaultCloudSyncCrypto.openAsync
  const webSealed = await core.sealVaultEnvelope(payload as unknown as Record<string, unknown>, passphrase);
  const parsedWebEnvelope = JSON.parse(webSealed) as Record<string, unknown>;
  assert.equal(parsedWebEnvelope.format, JALADESK_VAULT_FORMAT_ID);
  assert.equal(parsedWebEnvelope.schema, JDESK_SYNC_SCHEMA_ID);
  assert.equal(parsedWebEnvelope.kdf, PBKDF2_HMAC_SHA256_KDF);
  assert.equal(parsedWebEnvelope.iterations, DEFAULT_PBKDF2_ITERATIONS);
  assert.equal(parsedWebEnvelope.cipher, AES_256_GCM_CIPHER);
  assert.equal(parsedWebEnvelope.iv, parsedWebEnvelope.nonce);
  assert.equal(Buffer.from(String(parsedWebEnvelope.salt), 'base64').length, 16);
  assert.equal(Buffer.from(String(parsedWebEnvelope.iv), 'base64').length, 12);
  const macBuf = Buffer.from(String(parsedWebEnvelope.mac), 'base64');
  const ctBuf = Buffer.from(String(parsedWebEnvelope.ciphertext), 'base64');
  assert.equal(macBuf.length, 16);
  assert.deepStrictEqual(ctBuf.subarray(ctBuf.length - 16), macBuf);

  const openedByDesktopSync = EncryptedVaultBackupCodec.openJson({
    rawEnvelopeJson: webSealed,
    passphrase,
  });
  assert.deepStrictEqual(openedByDesktopSync, payload);

  const openedByDesktopAsync = await VaultCloudSyncCrypto.openAsync({
    rawEnvelopeJson: webSealed,
    passphrase,
  });
  assert.deepStrictEqual(openedByDesktopAsync, payload);

  // 3. Detached-MAC jdesk-sync-v1 compatibility
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, 10_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const detachedEnvelope = JSON.stringify({
    schema: JDESK_SYNC_SCHEMA_ID,
    kdf: PBKDF2_HMAC_SHA256_KDF,
    iterations: 10_000,
    cipher: AES_256_GCM_CIPHER,
    salt: salt.toString('base64'),
    nonce: iv.toString('base64'),
    ciphertext: enc.toString('base64'),
    mac: tag.toString('base64'),
  });
  assert.deepStrictEqual(await core.openVaultEnvelope(detachedEnvelope, passphrase), payload);

  // 4. Wrong passphrase & tampered ciphertext must fail
  await assert.rejects(
    () => core.openVaultEnvelope(webSealed, 'WrongPassphrase!'),
    (err: unknown) => err instanceof core.VaultCoreError && err.code === 'decrypt-failed',
  );
  const tampered = JSON.parse(webSealed) as Record<string, unknown>;
  const tamperedCt = Buffer.from(String(tampered.ciphertext), 'base64');
  tamperedCt[0] ^= 0xff;
  tampered.ciphertext = tamperedCt.toString('base64');
  await assert.rejects(
    () => core.openVaultEnvelope(JSON.stringify(tampered), passphrase),
    (err: unknown) => err instanceof core.VaultCoreError && err.code === 'decrypt-failed',
  );

  // 5. Google account-bound passphrase parity with Desktop
  const cfg = createDefaultVaultSyncConfig();
  cfg.provider = 'googleDrive';
  cfg.useCustomPassphrase = false;
  cfg.googleAccountEmail = '  Admin.Ops@Example.COM  ';
  assert.equal(
    core.deriveGoogleAccountBoundPassphrase('  Admin.Ops@Example.COM  '),
    effectiveEncryptionPassphrase(cfg),
  );
  assert.equal(core.deriveGoogleAccountBoundPassphrase('Admin@Corp.IO'), 'jaladesk-gdrive-e2ee-v1:admin@corp.io');
});

test('b. mergeVaultPayloads matches Desktop VaultSyncPayloadMerger across additions, updates, tombstones & 500-cap', async () => {
  const core = await loadVaultCore();
  const fixedNow = 1_770_000_000_000;

  const localPayload: Record<string, unknown> = {
    syncSchema: 2,
    updatedAtMs: 1_760_000_500_000,
    hosts: [
      { id: 'h-shared-local-newer', name: 'Local Newer', updatedAtMs: 2000 },
      { id: 'h-shared-remote-newer', name: 'Local Stale', updatedAtMs: 1000 },
      { id: 'h-shared-tie', name: 'Local Tie Winner', updatedAtMs: 1500 },
      { id: 'h-deleted-remotely', name: 'Should Be Deleted', updatedAtMs: 1000 },
      { id: 'h-revived-locally', name: 'Revived After Delete', updatedAtMs: 3000 },
      { id: 'h-local-only', name: 'Local Only', updatedAtMs: 1200 },
    ],
    credentials: [
      { id: 'c1', label: 'Cred Local', updatedAtMs: 1100 },
      { id: 'c-del', label: 'Deleted Cred', updatedAtMs: 500 },
    ],
    folders: [
      { name: 'Prod', jumpHostId: 'h-local-only', updatedAtMs: 1800 },
      { name: 'LegacyFolder', jumpHostId: null, updatedAtMs: 400 },
    ],
    totp: [
      { id: 't1', accountName: 'local-totp', secretBase32: 'JBSWY3DPEHPK3PXP', updatedAtMs: 1900 },
    ],
    snippets: [
      { id: 's1', title: 'Local Snip', command: 'uptime', updatedAtMs: 1300 },
    ],
    tombstones: {
      'host:h-deleted-locally': 2500,
      'folder:LegacyFolder': 900,
    },
  };

  const remotePayload: Record<string, unknown> = {
    syncSchema: 2,
    updatedAtMs: 1_760_000_600_000,
    hosts: [
      { id: 'h-shared-local-newer', name: 'Remote Stale', updatedAtMs: 1500 },
      { id: 'h-shared-remote-newer', name: 'Remote Newer', updatedAtMs: 2200 },
      { id: 'h-shared-tie', name: 'Remote Tie Loser', updatedAtMs: 1500 },
      { id: 'h-deleted-locally', name: 'Remote Should Be Deleted', updatedAtMs: 2000 },
      { id: 'h-remote-only', name: 'Remote Only', updatedAtMs: 1700 },
    ],
    credentials: [
      { id: 'c1', label: 'Cred Remote Newer', updatedAtMs: 2100 },
      { id: 'c2', label: 'Cred Remote Only', updatedAtMs: 1600 },
    ],
    folders: [
      { name: 'Prod', jumpHostId: 'h-remote-only', updatedAtMs: 1700 },
      { name: 'Staging', jumpHostId: null, updatedAtMs: 1950 },
    ],
    totp: [
      { id: 't2', accountName: 'remote-totp', secretBase32: 'GEZDGNBVGY3TQOJQ', updatedAtMs: 2400 },
    ],
    snippets: [
      { id: 's1', title: 'Remote Snip Newer', command: 'uname -a', updatedAtMs: 2300 },
      { id: 's2', title: 'Remote Snip Only', command: 'whoami', updatedAtMs: 1400 },
    ],
    tombstones: {
      'host:h-deleted-remotely': 2000,
      'host:h-revived-locally': 2500,
      'cred:c-del': 1000,
    },
  };

  const desktopMerged = VaultSyncPayloadMerger.merge(localPayload, remotePayload, { nowMs: fixedNow });
  const webMerged = core.mergeVaultPayloads(localPayload, remotePayload, { nowMs: fixedNow });
  assert.deepStrictEqual(webMerged, desktopMerged);

  // Confirm revival cleared tombstone while active tombstones remained
  assert.equal(Object.hasOwn(webMerged.tombstones, 'host:h-revived-locally'), false);
  assert.equal(webMerged.tombstones['host:h-deleted-remotely'], 2000);
  assert.equal(webMerged.tombstones['cred:c-del'], 1000);
  assert.equal(core.makeTombstoneKey('hosts', 'abc'), 'host:abc');
  assert.equal(core.makeTombstoneKey('credentials', 'c1'), 'cred:c1');
  assert.equal(core.makeTombstoneKey('folders', 'Prod'), 'folder:Prod');
  assert.equal(core.makeTombstoneKey('totp', 't1'), 'totp:t1');
  assert.equal(core.makeTombstoneKey('snippets', 's1'), 'snippet:s1');

  // Verify 500-tombstone cap matches Desktop exactly
  const manyLocalTombs: Record<string, number> = {};
  const manyRemoteTombs: Record<string, number> = {};
  for (let i = 1; i <= 320; i += 1) {
    manyLocalTombs[`host:local-${i}`] = 10_000 + i;
    manyRemoteTombs[`host:remote-${i}`] = 20_000 + i;
  }
  const desktopCapped = VaultSyncPayloadMerger.merge(
    { tombstones: manyLocalTombs },
    { tombstones: manyRemoteTombs },
    { nowMs: fixedNow },
  );
  const webCapped = core.mergeVaultPayloads(
    { tombstones: manyLocalTombs },
    { tombstones: manyRemoteTombs },
    { nowMs: fixedNow },
  );
  assert.equal(Object.keys(webCapped.tombstones).length, 500);
  assert.deepStrictEqual(webCapped, desktopCapped);
});

test('c. WebCrypto RFC 6238 TOTP & otpauth:// URI match src/credentials/totp.ts across SHA1/SHA256/SHA512, 6/8 digits, 30/60s', async () => {
  const core = await loadVaultCore();

  // RFC 6238 official test secrets (ASCII "12345678901234567890" etc. in Base32)
  const vectors: Array<{
    secretBase32: string;
    algorithm: 'SHA1' | 'SHA256' | 'SHA512';
    digits: 6 | 8;
    period: 30 | 60;
    unixSeconds: number;
    expected?: string;
  }> = [
    {
      secretBase32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      algorithm: 'SHA1',
      digits: 8,
      period: 30,
      unixSeconds: 59,
      expected: '94287082',
    },
    {
      secretBase32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
      algorithm: 'SHA256',
      digits: 8,
      period: 30,
      unixSeconds: 1_111_111_109,
      expected: '68084774',
    },
    {
      secretBase32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
      algorithm: 'SHA512',
      digits: 8,
      period: 30,
      unixSeconds: 1_234_567_890,
      expected: '93441116',
    },
    {
      secretBase32: 'JBSW Y3DP EHPK 3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      unixSeconds: 1_760_000_123,
    },
    {
      secretBase32: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256',
      digits: 6,
      period: 60,
      unixSeconds: 1_760_000_123,
    },
    {
      secretBase32: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA512',
      digits: 8,
      period: 60,
      unixSeconds: 1_760_000_999,
    },
  ];

  for (const v of vectors) {
    const nowMs = v.unixSeconds * 1000 + 450;
    const desktopCode = desktopGenerateTotpCode(
      { secretBase32: v.secretBase32, algorithm: v.algorithm, digits: v.digits, period: v.period },
      { nowMs },
    );
    const webCode = await core.generateTotpCode(
      { secretBase32: v.secretBase32, algorithm: v.algorithm, digits: v.digits, period: v.period },
      nowMs,
    );
    assert.equal(webCode, desktopCode, `Mismatch for ${v.algorithm}/${v.digits}/${v.period}@${v.unixSeconds}`);
    if (v.expected) {
      assert.equal(webCode, v.expected);
    }
    assert.equal(core.formatTotpCode(webCode), desktopFormatTotpCode(desktopCode));
    assert.deepStrictEqual(
      core.calculateTotpTiming(v.period, nowMs),
      desktopCalculateTotpTiming(v.period, nowMs),
    );
  }

  // parseOtpAuthUri & buildOtpAuthUri parity
  const uri =
    'otpauth://totp/JalaDesk%20Cloud:ops%40corp.example?secret=JBSW-Y3DP-EHPK-3PXP&issuer=JalaDesk%20Cloud&algorithm=SHA256&digits=8&period=60';
  const desktopParsed = desktopParseOtpAuthUri(uri);
  const webParsed = core.parseOtpAuthUri(uri);
  assert.deepStrictEqual(webParsed, desktopParsed);

  const builtWeb = core.buildOtpAuthUri(webParsed);
  const builtDesktop = desktopBuildOtpAuthUri(desktopParsed);
  assert.equal(builtWeb, builtDesktop);
  assert.deepStrictEqual(core.parseOtpAuthUri(builtWeb), desktopParsed);
});

test('d. Loopback HTTP tests for Google Drive AppData, GitHub Secret Gist & WebDAV transports', async () => {
  const core = await loadVaultCore();
  const passphrase = 'CloudSyncPassphrase#2026';

  // --- 1. Google Drive AppData Loopback Server ---
  const driveState: { file: { id: string; name: string; content: string; parents: string[] } | null } = {
    file: null,
  };
  let driveMultipartSeen = false;
  let drivePatchSeen = false;
  let driveFailMode: 'none' | '403-scope' | '401' = 'none';

  const gdriveServer = await startLoopbackServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer valid-gdrive-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid Credentials' } }));
      return;
    }
    if (driveFailMode === '403-scope') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            errors: [{ reason: 'insufficientPermissions' }],
          },
        }),
      );
      return;
    }
    if (driveFailMode === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Token expired' } }));
      return;
    }

    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && reqUrl.pathname === '/drive/v3/files') {
      assert.equal(reqUrl.searchParams.get('spaces'), 'appDataFolder');
      const files = driveState.file ? [{ id: driveState.file.id, name: driveState.file.name }] : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname.startsWith('/drive/v3/files/') && reqUrl.searchParams.get('alt') === 'media') {
      if (!driveState.file) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(driveState.file.content);
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/upload/drive/v3/files') {
      const body = await readRequestBody(req);
      const ct = String(req.headers['content-type'] ?? '');
      const boundaryMatch = /boundary=([^\s;]+)/.exec(ct);
      assert.ok(boundaryMatch, 'Multipart boundary expected');
      const parts = body.split(`--${boundaryMatch[1]}`).filter((p) => p.includes('\r\n\r\n'));
      assert.equal(parts.length, 2);
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].trim()) as { name: string; parents: string[] };
      const fileContent = parts[1].split('\r\n\r\n')[1].replace(/\r\n$/, '');
      assert.equal(meta.name, GOOGLE_DRIVE_PRIMARY_VAULT_FILE);
      assert.deepStrictEqual(meta.parents, ['appDataFolder']);
      driveState.file = { id: 'drive-file-001', name: meta.name, content: fileContent, parents: meta.parents };
      driveMultipartSeen = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: driveState.file.id, name: driveState.file.name }));
      return;
    }
    if (req.method === 'PATCH' && reqUrl.pathname === '/upload/drive/v3/files/drive-file-001') {
      const body = await readRequestBody(req);
      assert.ok(driveState.file);
      driveState.file.content = body;
      drivePatchSeen = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: driveState.file.id }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    // Preflight scope guard when drive.appdata checkbox was left unchecked
    await assert.rejects(
      () =>
        core.syncWithGoogleDriveAppData({
          accessToken: 'valid-gdrive-token',
          grantedScope: 'openid email profile',
          localPayload: buildSampleVaultPayload(),
          passphrase,
          apiBaseUrl: gdriveServer.baseUrl,
        }),
      (err: unknown) => err instanceof core.VaultCoreError && err.code === 'gdrive-missing-scope',
    );

    // 403 insufficientPermissions handling
    driveFailMode = '403-scope';
    await assert.rejects(
      () =>
        core.syncWithGoogleDriveAppData({
          accessToken: 'valid-gdrive-token',
          localPayload: buildSampleVaultPayload(),
          passphrase,
          apiBaseUrl: gdriveServer.baseUrl,
        }),
      (err: unknown) =>
        err instanceof core.VaultCoreError && err.code === 'gdrive-missing-scope' && err.statusCode === 403,
    );

    // 401 session expired handling
    driveFailMode = '401';
    await assert.rejects(
      () =>
        core.syncWithGoogleDriveAppData({
          accessToken: 'valid-gdrive-token',
          localPayload: buildSampleVaultPayload(),
          passphrase,
          apiBaseUrl: gdriveServer.baseUrl,
        }),
      (err: unknown) => err instanceof core.VaultCoreError && err.code === 'gdrive-http-401' && err.statusCode === 401,
    );
    driveFailMode = 'none';

    // First sync uploads multipart into appDataFolder & opens cleanly in Desktop codec
    const firstDriveSync = await core.syncWithGoogleDriveAppData({
      accessToken: 'valid-gdrive-token',
      grantedScope: 'https://www.googleapis.com/auth/drive.appdata openid email',
      localPayload: {
        hosts: [{ id: 'h-web-1', name: 'Web Host', updatedAtMs: 1000 }],
        totp: [],
      },
      passphrase,
      mode: 'smartMerge',
      apiBaseUrl: gdriveServer.baseUrl,
    });
    assert.equal(driveMultipartSeen, true);
    assert.equal(firstDriveSync.fileId, 'drive-file-001');
    assert.equal(firstDriveSync.hadRemote, false);
    assert.ok(driveState.file);
    const decryptedByDesktop = EncryptedVaultBackupCodec.openJson({
      rawEnvelopeJson: driveState.file.content,
      passphrase,
    });
    assert.equal((decryptedByDesktop.hosts as Array<{ id: string }>)[0].id, 'h-web-1');

    // Simulate Desktop updating remote Drive file with an extra host, then Web smartMerge pulls + merges + PATCHes
    driveState.file.content = EncryptedVaultBackupCodec.sealJson({
      payload: {
        syncSchema: 2,
        updatedAtMs: 2500,
        hosts: [
          { id: 'h-web-1', name: 'Web Host', updatedAtMs: 1000 },
          { id: 'h-desktop-2', name: 'Desktop Host', updatedAtMs: 2000 },
        ],
        credentials: [],
        folders: [],
        totp: [],
        snippets: [],
        tombstones: {},
      },
      passphrase,
    });

    const secondDriveSync = await core.syncWithGoogleDriveAppData({
      accessToken: 'valid-gdrive-token',
      localPayload: {
        hosts: [
          { id: 'h-web-1', name: 'Web Host Renamed', updatedAtMs: 3000 },
        ],
      },
      passphrase,
      mode: 'smartMerge',
      apiBaseUrl: gdriveServer.baseUrl,
    });
    assert.equal(drivePatchSeen, true);
    assert.equal(secondDriveSync.hadRemote, true);
    assert.equal(secondDriveSync.payload.hosts.length, 2);
    assert.equal(secondDriveSync.payload.hosts[0].name, 'Web Host Renamed');
    assert.equal(secondDriveSync.payload.hosts[1].id, 'h-desktop-2');
  } finally {
    await gdriveServer.close();
  }

  // --- 2. GitHub Secret Gist Loopback Server ---
  const gists = new Map<string, { id: string; public: boolean; files: Record<string, { content: string }> }>();
  const githubServer = await startLoopbackServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ghp_valid_token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && reqUrl.pathname === '/gists') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.from(gists.values())));
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/gists') {
      const parsed = JSON.parse(await readRequestBody(req)) as {
        public: boolean;
        files: Record<string, { content: string }>;
      };
      assert.equal(parsed.public, false, 'Gist MUST be created as Secret Gist (public: false)');
      assert.ok(Object.hasOwn(parsed.files, GITHUB_PRIMARY_GIST_FILE));
      const id = 'gist_secret_9001';
      gists.set(id, { id, public: false, files: parsed.files });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, public: false, files: parsed.files }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname.startsWith('/gists/')) {
      const id = decodeURIComponent(reqUrl.pathname.slice('/gists/'.length));
      const entry = gists.get(id);
      if (!entry) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entry));
      return;
    }
    if (req.method === 'PATCH' && reqUrl.pathname.startsWith('/gists/')) {
      const id = decodeURIComponent(reqUrl.pathname.slice('/gists/'.length));
      const entry = gists.get(id);
      if (!entry) {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed = JSON.parse(await readRequestBody(req)) as { files: Record<string, { content: string }> };
      entry.files = { ...entry.files, ...parsed.files };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entry));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    // Push initial vault to auto-create Secret Gist
    const created = await core.syncWithGithubGist({
      token: 'ghp_valid_token',
      localPayload: {
        hosts: [{ id: 'h-gist-1', name: 'Gist Host 1', updatedAtMs: 1000 }],
      },
      passphrase,
      mode: 'smartMerge',
      apiBaseUrl: githubServer.baseUrl,
    });
    assert.equal(created.gistId, 'gist_secret_9001');
    assert.equal(created.uploaded, true);
    const savedGistRaw = gists.get('gist_secret_9001')?.files[GITHUB_PRIMARY_GIST_FILE]?.content ?? '';
    const openedFromGist = EncryptedVaultBackupCodec.openJson({ rawEnvelopeJson: savedGistRaw, passphrase });
    assert.equal((openedFromGist.hosts as Array<{ id: string }>)[0].id, 'h-gist-1');

    // Auto-discover existing gistId when omitted, merge new local item, and verify pullOnly
    const merged = await core.syncWithGithubGist({
      token: 'ghp_valid_token',
      localPayload: {
        hosts: [{ id: 'h-gist-2', name: 'Gist Host 2', updatedAtMs: 2000 }],
      },
      passphrase,
      mode: 'smartMerge',
      apiBaseUrl: githubServer.baseUrl,
    });
    assert.equal(merged.gistId, 'gist_secret_9001');
    assert.equal(merged.hadRemote, true);
    assert.equal(merged.payload.hosts.length, 2);

    const pulled = await core.syncWithGithubGist({
      token: 'ghp_valid_token',
      gistId: 'gist_secret_9001',
      localPayload: {},
      passphrase,
      mode: 'pullOnly',
      apiBaseUrl: githubServer.baseUrl,
    });
    assert.equal(pulled.uploaded, false);
    assert.equal(pulled.payload.hosts.length, 2);

    // Bad token rejected cleanly
    await assert.rejects(
      () =>
        core.syncWithGithubGist({
          token: 'ghp_invalid',
          localPayload: {},
          passphrase,
          apiBaseUrl: githubServer.baseUrl,
        }),
      (err: unknown) => err instanceof core.VaultCoreError && err.code === 'github-http-401',
    );
  } finally {
    await githubServer.close();
  }

  // --- 3. WebDAV Loopback Server & CORS Error Guidance ---
  let davBody: string | null = null;
  const expectedAuth = `Basic ${Buffer.from('davuser:davpass#99', 'utf8').toString('base64')}`;
  const davServer = await startLoopbackServer(async (req, res) => {
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === 'GET') {
      if (!davBody) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(davBody);
      return;
    }
    if (req.method === 'PUT') {
      davBody = await readRequestBody(req);
      res.writeHead(201);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });

  try {
    const davRes = await core.syncWithWebDav({
      url: `${davServer.baseUrl}/remote.php/dav/files/davuser/jaladesk.jvault`,
      username: 'davuser',
      password: 'davpass#99',
      localPayload: { hosts: [{ id: 'h-dav-1', name: 'NAS Host', updatedAtMs: 5000 }] },
      passphrase,
      mode: 'smartMerge',
    });
    assert.equal(davRes.uploaded, true);
    assert.ok(davBody);
    const openedDav = EncryptedVaultBackupCodec.openJson({ rawEnvelopeJson: davBody, passphrase });
    assert.equal((openedDav.hosts as Array<{ id: string }>)[0].id, 'h-dav-1');

    // Public HTTP rejected (HTTPS required)
    await assert.rejects(
      () =>
        core.syncWithWebDav({
          url: 'http://cloud.public-example.com/vault.jvault',
          localPayload: {},
          passphrase,
        }),
      (err: unknown) => err instanceof core.VaultCoreError && err.code === 'webdav-insecure-url',
    );

    // Network/CORS failure surfaces actionable Access-Control-Allow-Origin guidance
    await assert.rejects(
      () =>
        core.syncWithWebDav({
          url: 'https://cloud.public-example.com/vault.jvault',
          localPayload: {},
          passphrase,
          fetchImpl: async () => {
            throw new TypeError('Failed to fetch');
          },
        }),
      (err: unknown) =>
        err instanceof core.VaultCoreError &&
        err.code === 'webdav-cors-or-network' &&
        err.message.includes('Access-Control-Allow-Origin'),
    );
  } finally {
    await davServer.close();
  }
});

test('e. SealedBrowserVaultStore writes ZERO plaintext secrets to storage and wipes memory on lock()', async () => {
  const core = await loadVaultCore();
  const storage = createMemoryStorage();
  const store = new core.SealedBrowserVaultStore({ storage });

  const masterPass = 'ZeroTrust#2026';
  const payload = buildSampleVaultPayload();

  assert.equal(store.hasSealedVault(), false);
  assert.equal(store.isUnlocked(), false);

  const createdPayload = await store.createVault(masterPass, payload as unknown as Record<string, unknown>);
  assert.equal(store.hasSealedVault(), true);
  assert.equal(store.isUnlocked(), true);
  assert.deepStrictEqual(createdPayload.hosts, payload.hosts);
  assert.deepStrictEqual(createdPayload.credentials, payload.credentials);
  assert.deepStrictEqual(createdPayload.folders, payload.folders);
  assert.deepStrictEqual(createdPayload.totp, payload.totp);
  assert.deepStrictEqual(createdPayload.snippets, payload.snippets);
  assert.deepStrictEqual(createdPayload.tombstones, payload.tombstones);

  // Attempt to save UI prefs including accidental secret keys — secrets MUST be stripped
  const savedPrefs = store.saveUiPrefs({
    autoLockSeconds: 60,
    syncProvider: 'googleDrive',
    googleAccountEmail: 'admin@corp.example',
    githubToken: 'ghp_SHOULD_NEVER_BE_STORED',
    webdavPassword: 'WEBDAV_SECRET_SHOULD_NEVER_BE_STORED',
    syncPassphrase: masterPass,
    secretBase32: 'JBSWY3DPEHPK3PXP',
  });
  assert.equal(savedPrefs.autoLockSeconds, 60);
  assert.equal(savedPrefs.syncProvider, 'googleDrive');
  assert.equal(Object.hasOwn(savedPrefs, 'githubToken'), false);
  assert.equal(Object.hasOwn(savedPrefs, 'webdavPassword'), false);
  assert.equal(Object.hasOwn(savedPrefs, 'syncPassphrase'), false);

  // Audit EVERY byte persisted in storage
  const rawDump = JSON.stringify(storage.dump());
  const forbiddenPlaintextSecrets = [
    masterPass,
    'BastionSecret#99',
    'RdpPassword!2026',
    'UltraSecretVaultPassword#42',
    'TESTKEYMATERIAL',
    'CREDKEY',
    'JBSWY3DPEHPK3PXP',
    'ghp_SHOULD_NEVER_BE_STORED',
    'WEBDAV_SECRET_SHOULD_NEVER_BE_STORED',
    '10.24.0.10',
    '10.24.8.42',
  ];
  for (const secret of forbiddenPlaintextSecrets) {
    assert.equal(rawDump.includes(secret), false, `Plaintext secret leaked to storage: ${secret}`);
  }

  // Sealed envelope in storage MUST be openable directly by Desktop codec
  const storedEnvelope = storage.getItem(core.SEALED_VAULT_STORAGE_KEY);
  assert.ok(storedEnvelope);
  const parsedEnvelope = JSON.parse(storedEnvelope) as Record<string, unknown>;
  assert.equal(parsedEnvelope.format, JALADESK_VAULT_FORMAT_ID);
  assert.deepStrictEqual(
    EncryptedVaultBackupCodec.openJson({ rawEnvelopeJson: storedEnvelope, passphrase: masterPass }),
    createdPayload,
  );

  // Lock clears unlocked state, blocks payload reads, and notifies listeners
  let lockCount = 0;
  const unsub = store.onLock(() => {
    lockCount += 1;
  });
  store.lock();
  assert.equal(lockCount, 1);
  assert.equal(store.isUnlocked(), false);
  assert.throws(() => store.getPayload(), (err: unknown) => err instanceof core.VaultCoreError && err.code === 'vault-locked');
  unsub();

  // Wrong passphrase cannot unlock; right passphrase restores exact payload
  await assert.rejects(() => store.unlock('WrongPass#9999'));
  const restored = await store.unlock(masterPass);
  assert.deepStrictEqual(restored, createdPayload);

  // Export & merge import roundtrip
  const exported = await store.exportEnvelope();
  const openedExported = EncryptedVaultBackupCodec.openJson({ rawEnvelopeJson: exported, passphrase: masterPass });
  assert.deepStrictEqual(openedExported.hosts, payload.hosts);
  assert.deepStrictEqual(openedExported.totp, payload.totp);

  const externalDesktopEnvelope = EncryptedVaultBackupCodec.sealJson({
    payload: {
      syncSchema: 2,
      updatedAtMs: 1_760_000_999_000,
      hosts: [{ id: 'host-imported-desktop', name: 'Desktop Imported', updatedAtMs: 1_760_000_999_000 }],
      credentials: [],
      folders: [],
      totp: [],
      snippets: [],
      tombstones: {},
    },
    passphrase: 'ExternalBackup#77',
  });
  const mergedAfterImport = await store.importEnvelope(externalDesktopEnvelope, 'ExternalBackup#77', { mode: 'merge' });
  assert.equal(mergedAfterImport.hosts.length, 3);
  assert.equal(mergedAfterImport.hosts.some((h) => h.id === 'host-imported-desktop'), true);

  // Passphrase rotation re-seals cleanly
  await store.changePassphrase('RotatedMaster#2027');
  store.lock();
  await assert.rejects(() => store.unlock(masterPass));
  const reopenedRotated = await store.unlock('RotatedMaster#2027');
  assert.equal(reopenedRotated.hosts.length, 3);
  store.lock();
});

test('f. PWA manifest.webmanifest and sw.js integrity checks', async () => {
  const manifestRaw = await readFile(fileURLToPath(MANIFEST_URL), 'utf8');
  const manifest = JSON.parse(manifestRaw) as {
    name: string;
    short_name: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: Array<{ src: string; sizes: string; type: string }>;
  };

  assert.equal(manifest.name, 'JalaDesk Web');
  assert.equal(manifest.short_name, 'JalaDesk');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#05080F');
  assert.equal(manifest.background_color, '#05080F');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    const resolvedIconPath = fileURLToPath(new URL(icon.src, MANIFEST_URL));
    const st = await stat(resolvedIconPath);
    assert.ok(st.size > 0, `Icon file missing or empty: ${icon.src}`);
  }

  const swRaw = await readFile(fileURLToPath(SW_URL), 'utf8');
  for (const asset of [
    './',
    './index.html',
    './app.css',
    './app.js',
    './vault-core.js',
    './web-oauth-config.js',
    './manifest.webmanifest',
  ]) {
    assert.ok(swRaw.includes(`'${asset}'`), `sw.js must precache ${asset}`);
  }
  assert.ok(swRaw.includes('www.googleapis.com'));
  assert.ok(swRaw.includes('accounts.google.com'));
  assert.ok(swRaw.includes('googleapis.com'));
  assert.ok(swRaw.includes('api.github.com'));
  assert.ok(swRaw.includes('Authorization'));
  assert.ok(
    swRaw.includes('`${CACHE_PREFIX}v6`') || swRaw.includes("'jaladesk-web-pwa-v6'"),
    'sw.js must bump CACHE_NAME to jaladesk-web-pwa-v6',
  );

  const indexRaw = await readFile(fileURLToPath(INDEX_HTML_URL), 'utf8');
  assert.ok(indexRaw.includes('https://accounts.google.com/gsi/client'), 'CSP must allow GIS client script');
  assert.ok(indexRaw.includes('frame-src https://accounts.google.com'), 'CSP must allow GIS popup frame');
  assert.ok(indexRaw.includes('https://accounts.google.com/gsi/style'), 'CSP must allow GIS style');
  assert.equal(/\sstyle\s*=\s*["']/.test(indexRaw), false, 'index.html must contain zero inline style="" attributes');

  for (const requiredId of [
    'id="lock-returning-google-wrap"',
    'id="btn-returning-google-unlock"',
    'id="btn-returning-use-passphrase"',
    'id="modal-confirm-delete"',
    'id="btn-confirm-delete-cancel"',
    'id="btn-confirm-delete-submit"',
    'id="gateway-selected-target-banner"',
    'id="gateway-local-probe-pill"',
    'id="gateway-setup-guidance"',
    'id="btn-check-local-gateway"',
    'id="btn-copy-gw-npm"',
    'id="btn-copy-gw-docker"',
    'id="gateway-cred-prompt"',
    'id="gateway-url-presets"',
    'id="btn-gw-preset-local"',
    'id="btn-gw-preset-https"',
    'id="btn-gateway-preview-demo"',
    'id="gateway-preview-banner"',
  ]) {
    assert.ok(indexRaw.includes(requiredId), `index.html must include ${requiredId}`);
  }

  const appJsRaw = await readFile(fileURLToPath(APP_JS_URL), 'utf8');
  assert.equal(/\binnerHTML\b/.test(appJsRaw), false, 'app.js must contain zero innerHTML usage');
  assert.equal(appJsRaw.includes('Open in Gateway'), false, 'host cards must replace ambiguous Open in Gateway with Connect');
  assert.ok(appJsRaw.includes("el('span', '', 'Connect')"), 'host cards must render Connect button');
  assert.ok(appJsRaw.includes('btn-toast-undo'), 'app.js must render undo toast button #btn-toast-undo');
  assert.ok(appJsRaw.includes('UNDO_DELETE_WINDOW_MS = 6000'), 'app.js must keep 6-second undo snapshot in RAM');
  assert.ok(appJsRaw.includes('clearPendingUndo()'), 'app.js must clear RAM undo snapshot on Lock Vault');
  assert.ok(appJsRaw.includes('http://127.0.0.1:8443'), 'app.js must probe local gateway on 127.0.0.1:8443');
  assert.ok(appJsRaw.includes('/healthz'), 'app.js must probe /healthz endpoint');
  assert.ok(appJsRaw.includes('openConfirmDeleteModal'), 'app.js must route destructive deletes through confirmation modal');
  assert.ok(appJsRaw.includes('scheduleCloudAutoSync'), 'app.js must schedule debounced background cloud auto-sync');
  assert.ok(appJsRaw.includes('unlockOrSyncGoogleVault'), 'app.js must use local-unlock-then-smartMerge helper for Google vaults');
  assert.ok(appJsRaw.includes('startGatewayInteractivePreview'), 'app.js must provide interactive in-browser remote GUI preview');
});

test('g. 1-click Google Web OAuth config, fetchGoogleUserInfo & GIS sign-in flow with zero token persistence', async () => {
  const core = await loadVaultCore();
  const oauthCfg = await loadWebOAuthConfig();

  // 1. resolveGoogleWebOAuthClientId precedence (built-in default, unconfigured fallback & custom override)
  const expectedBuiltinClientId = '749663705305-aatpuo0m1f11se7kii0afaspgion454d.apps.googleusercontent.com';
  assert.equal(oauthCfg.GOOGLE_CLOUD_PROJECT_NUMBER, '749663705305');
  assert.equal(oauthCfg.BUILTIN_GOOGLE_WEB_CLIENT_ID, expectedBuiltinClientId);
  assert.equal(oauthCfg.resolveGoogleWebOAuthClientId(), expectedBuiltinClientId);
  assert.equal(oauthCfg.resolveGoogleWebOAuthClientId('   '), expectedBuiltinClientId);
  assert.equal(oauthCfg.resolveGoogleWebOAuthClientId('', { builtinClientIdOverride: '' }), '');
  assert.equal(oauthCfg.resolveGoogleWebOAuthClientId('   ', { builtinClientIdOverride: '' }), '');
  assert.equal(oauthCfg.resolveGoogleWebOAuthClientId('', { builtinClientId: '' }), '');
  assert.equal(
    oauthCfg.resolveGoogleWebOAuthClientId('  749663705305-custom.apps.googleusercontent.com  '),
    '749663705305-custom.apps.googleusercontent.com',
  );
  assert.equal(
    oauthCfg.resolveGoogleWebOAuthClientId('', { builtinClientId: '749663705305-builtin.apps.googleusercontent.com' }),
    '749663705305-builtin.apps.googleusercontent.com',
  );
  assert.equal(
    oauthCfg.resolveGoogleWebOAuthClientId('749663705305-override.apps.googleusercontent.com', {
      builtinClientId: '749663705305-builtin.apps.googleusercontent.com',
    }),
    '749663705305-override.apps.googleusercontent.com',
  );

  // 2. fetchGoogleUserInfo against loopback OpenID Connect endpoint
  let userInfoMode: 'full' | 'givenOnly' | '401' = 'full';
  const userInfoServer = await startLoopbackServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ya29.live-web-token' || userInfoMode === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (userInfoMode === 'givenOnly') {
      res.end(JSON.stringify({ email: 'ops@jaladesk.io', given_name: 'Ops' }));
      return;
    }
    res.end(JSON.stringify({ email: 'ribato@jaladesk.io', name: 'Ribato Operator' }));
  });

  try {
    const info = await core.fetchGoogleUserInfo('ya29.live-web-token', {
      userInfoUrl: `${userInfoServer.baseUrl}/v1/userinfo`,
    });
    assert.deepStrictEqual(info, { email: 'ribato@jaladesk.io', displayName: 'Ribato Operator' });

    userInfoMode = 'givenOnly';
    const givenInfo = await core.fetchGoogleUserInfo('ya29.live-web-token', {
      userInfoUrl: `${userInfoServer.baseUrl}/v1/userinfo`,
    });
    assert.deepStrictEqual(givenInfo, { email: 'ops@jaladesk.io', displayName: 'Ops' });

    userInfoMode = '401';
    await assert.rejects(
      () => core.fetchGoogleUserInfo('ya29.live-web-token', { userInfoUrl: `${userInfoServer.baseUrl}/v1/userinfo` }),
      (err: unknown) => err instanceof core.VaultCoreError && err.code === 'gdrive-http-401' && err.statusCode === 401,
    );

    await assert.rejects(
      () => core.fetchGoogleUserInfo('   ', { userInfoUrl: `${userInfoServer.baseUrl}/v1/userinfo` }),
      (err: unknown) => err instanceof core.VaultCoreError && err.code === 'gdrive-missing-token',
    );
  } finally {
    await userInfoServer.close();
  }

  // 3. requestGoogleWebAccessToken (1-click GIS Token Client flow)
  await assert.rejects(
    () => core.requestGoogleWebAccessToken({ clientId: '   ' }),
    (err: unknown) => err instanceof core.VaultCoreError && err.code === 'gdrive-missing-client-id',
  );

  const capturedInitCalls: Array<Record<string, unknown>> = [];
  const capturedRequestCalls: Array<Record<string, unknown>> = [];

  const fullGrant = await core.requestGoogleWebAccessToken({
    clientId: '749663705305-web.apps.googleusercontent.com',
    loginHint: 'ribato@jaladesk.io',
    prompt: '',
    gsiLoader: async () => ({
      accounts: {
        oauth2: {
          initTokenClient(cfg: Record<string, unknown>) {
            capturedInitCalls.push(cfg);
            return {
              requestAccessToken(reqOpts: Record<string, unknown>) {
                capturedRequestCalls.push(reqOpts);
                const cb = cfg.callback as (resp: Record<string, unknown>) => void;
                cb({
                  access_token: 'ya29.gis-full-token',
                  scope: 'openid email profile https://www.googleapis.com/auth/drive.appdata',
                  expires_in: 3599,
                });
              },
            };
          },
        },
      },
    }),
  });

  assert.equal(capturedInitCalls.length, 1);
  assert.equal(capturedInitCalls[0].client_id, '749663705305-web.apps.googleusercontent.com');
  assert.equal(capturedInitCalls[0].scope, 'https://www.googleapis.com/auth/drive.appdata openid email profile');
  assert.equal(capturedInitCalls[0].include_granted_scopes, true);
  assert.equal(capturedInitCalls[0].hint, 'ribato@jaladesk.io');
  assert.deepStrictEqual(capturedRequestCalls[0], { prompt: '' });
  assert.deepStrictEqual(fullGrant, {
    accessToken: 'ya29.gis-full-token',
    grantedScope: 'openid email profile https://www.googleapis.com/auth/drive.appdata',
    expiresInSec: 3599,
    hasAppDataScope: true,
  });

  // Unchecked drive.appdata checkbox in consent popup -> hasAppDataScope: false (triggers 1-click re-consent)
  const partialGrant = await core.requestGoogleWebAccessToken({
    clientId: '749663705305-web.apps.googleusercontent.com',
    gsiLoader: async () => ({
      accounts: {
        oauth2: {
          initTokenClient(cfg: Record<string, unknown>) {
            return {
              requestAccessToken() {
                const cb = cfg.callback as (resp: Record<string, unknown>) => void;
                cb({
                  access_token: 'ya29.gis-no-drive-scope',
                  scope: 'openid email profile',
                  expires_in: 3600,
                });
              },
            };
          },
        },
      },
    }),
  });
  assert.equal(partialGrant.hasAppDataScope, false);
  assert.equal(partialGrant.accessToken, 'ya29.gis-no-drive-scope');

  // Popup closed & access denied error mapping
  await assert.rejects(
    () =>
      core.requestGoogleWebAccessToken({
        clientId: '749663705305-web.apps.googleusercontent.com',
        gsiLoader: async () => ({
          accounts: {
            oauth2: {
              initTokenClient(cfg: Record<string, unknown>) {
                return {
                  requestAccessToken() {
                    const errCb = cfg.error_callback as (err: Record<string, unknown>) => void;
                    errCb({ type: 'popup_closed' });
                  },
                };
              },
            },
          },
        }),
      }),
    (err: unknown) => err instanceof core.VaultCoreError && err.code === 'gdrive-popup-closed',
  );

  await assert.rejects(
    () =>
      core.requestGoogleWebAccessToken({
        clientId: '749663705305-web.apps.googleusercontent.com',
        gsiLoader: async () => ({
          accounts: {
            oauth2: {
              initTokenClient(cfg: Record<string, unknown>) {
                return {
                  requestAccessToken() {
                    const cb = cfg.callback as (resp: Record<string, unknown>) => void;
                    cb({ error: 'access_denied' });
                  },
                };
              },
            },
          },
        }),
      }),
    (err: unknown) => err instanceof core.VaultCoreError && err.code === 'gdrive-oauth-denied',
  );

  // 4. End-to-end 1-click Google Sign-In -> Pull Desktop-encrypted vault -> Local Sealed Store (ZERO token in storage!)
  const accountEmail = 'ribato@jaladesk.io';
  const accountBoundPass = core.deriveGoogleAccountBoundPassphrase(accountEmail);
  const desktopSealedForAccount = EncryptedVaultBackupCodec.sealJson({
    payload: buildSampleVaultPayload() as unknown as Record<string, unknown>,
    passphrase: accountBoundPass,
  });

  const e2eServer = await startLoopbackServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ya29.ephemeral-ram-only-secret') {
      res.writeHead(401);
      res.end();
      return;
    }
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/v1/userinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: accountEmail, name: 'Ribato' }));
      return;
    }
    if (reqUrl.pathname === '/drive/v3/files') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files: [{ id: 'file-1click-01', name: GOOGLE_DRIVE_PRIMARY_VAULT_FILE }] }));
      return;
    }
    if (reqUrl.pathname === '/drive/v3/files/file-1click-01' && reqUrl.searchParams.get('alt') === 'media') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(desktopSealedForAccount);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const tokenResult = await core.requestGoogleWebAccessToken({
      clientId: '749663705305-web.apps.googleusercontent.com',
      gsiLoader: async () => ({
        accounts: {
          oauth2: {
            initTokenClient(cfg: Record<string, unknown>) {
              return {
                requestAccessToken() {
                  (cfg.callback as (r: Record<string, unknown>) => void)({
                    access_token: 'ya29.ephemeral-ram-only-secret',
                    scope: 'https://www.googleapis.com/auth/drive.appdata openid email profile',
                    expires_in: 3600,
                  });
                },
              };
            },
          },
        },
      }),
    });
    assert.equal(tokenResult.hasAppDataScope, true);

    const profile = await core.fetchGoogleUserInfo(tokenResult.accessToken, {
      userInfoUrl: `${e2eServer.baseUrl}/v1/userinfo`,
    });
    const derivedKey = core.deriveGoogleAccountBoundPassphrase(profile.email);
    const pulled = await core.syncWithGoogleDriveAppData({
      accessToken: tokenResult.accessToken,
      grantedScope: tokenResult.grantedScope,
      localPayload: core.createEmptyVaultPayload(),
      passphrase: derivedKey,
      mode: 'pullOnly',
      apiBaseUrl: e2eServer.baseUrl,
    });
    assert.equal(pulled.payload.hosts.length, 2);
    assert.equal(pulled.payload.totp.length, 1);

    const storage = createMemoryStorage();
    const store = new core.SealedBrowserVaultStore({ storage });
    await store.createVault(derivedKey, pulled.payload as unknown as Record<string, unknown>);
    store.saveUiPrefs({
      syncProvider: 'googleDrive',
      googleAccountEmail: profile.email,
      googleAccountName: profile.displayName,
      lastSyncedAtMs: pulled.syncedAtMs,
    });

    const storageDump = JSON.stringify(storage.dump());
    assert.equal(storageDump.includes('ya29.ephemeral-ram-only-secret'), false, 'OAuth token MUST NEVER touch storage');
    assert.equal(storageDump.includes(derivedKey), false, 'Derived passphrase MUST NEVER touch storage');
    assert.equal(storageDump.includes('BastionSecret#99'), false, 'Plaintext vault secret MUST NEVER touch storage');
    assert.equal(store.getUiPrefs().syncProvider, 'googleDrive');
  } finally {
    await e2eServer.close();
  }
});

test('h. vaultAuthMode allow-list & returning Google local-unlock-then-smartMerge preserves tombstones and new hosts', async () => {
  const core = await loadVaultCore();
  const storage = createMemoryStorage();
  const initialStore = new core.SealedBrowserVaultStore({ storage });

  // 1. Default vaultAuthMode is 'passphrase' and allow-list enforces strictly 'googleAccount' | 'passphrase'
  assert.equal(initialStore.getUiPrefs().vaultAuthMode, 'passphrase');
  const savedGooglePrefs = initialStore.saveUiPrefs({
    vaultAuthMode: 'googleAccount',
    googleAccountEmail: 'ribato@jaladesk.io',
    accessToken: 'ya29.must-never-persist',
    passphrase: 'must-never-persist',
  });
  assert.equal(savedGooglePrefs.vaultAuthMode, 'googleAccount');
  assert.equal(savedGooglePrefs.googleAccountEmail, 'ribato@jaladesk.io');
  assert.equal(Object.hasOwn(savedGooglePrefs, 'accessToken'), false);
  assert.equal(Object.hasOwn(savedGooglePrefs, 'passphrase'), false);

  // Invalid vaultAuthMode falls back to safe default 'passphrase'
  const invalidPrefs = initialStore.saveUiPrefs({ vaultAuthMode: 'invalidMode' });
  assert.equal(invalidPrefs.vaultAuthMode, 'passphrase');

  initialStore.saveUiPrefs({ vaultAuthMode: 'googleAccount', googleAccountEmail: 'ribato@jaladesk.io' });
  assert.equal(initialStore.getUiPrefs().vaultAuthMode, 'googleAccount');

  // 2. Seed local sealed vault (Account A) with a pending deletion tombstone (host-stale-deleted) AND a newly added local host (host-web-new)
  const emailA = 'ribato@jaladesk.io';
  const accountKeyA = core.deriveGoogleAccountBoundPassphrase(emailA);
  const localPayload = {
    syncSchema: 2,
    updatedAtMs: 1_760_000_500_000,
    hosts: [
      { id: 'host-keep', name: 'bastion-keep', protocol: 'ssh', address: '10.0.0.10', port: 22, updatedAtMs: 1_760_000_100_000 },
      { id: 'host-web-new', name: 'web-added-host', protocol: 'rdp', address: '10.0.0.99', port: 3389, updatedAtMs: 1_760_000_400_000 },
    ],
    credentials: [],
    folders: [],
    totp: [],
    snippets: [],
    tombstones: {
      [core.makeTombstoneKey('host', 'host-stale-deleted')]: 1_760_000_450_000,
    },
  };
  await initialStore.createVault(accountKeyA, localPayload);
  initialStore.lock();

  // Remote Google Drive still holds stale host-stale-deleted PLUS host-mobile-added from another device
  let remoteEnvelopeA = await core.sealVaultEnvelope(
    {
      syncSchema: 2,
      updatedAtMs: 1_760_000_300_000,
      hosts: [
        { id: 'host-keep', name: 'bastion-keep', protocol: 'ssh', address: '10.0.0.10', port: 22, updatedAtMs: 1_760_000_100_000 },
        { id: 'host-stale-deleted', name: 'old-deleted-host', protocol: 'ssh', address: '10.0.0.55', port: 22, updatedAtMs: 1_760_000_100_000 },
        { id: 'host-mobile-added', name: 'mobile-host', protocol: 'vnc', address: '10.0.0.77', port: 5900, updatedAtMs: 1_760_000_300_000 },
      ],
      credentials: [],
      folders: [],
      totp: [],
      snippets: [],
      tombstones: {},
    },
    accountKeyA,
  );

  const emailB = 'other-operator@jaladesk.io';
  const accountKeyB = core.deriveGoogleAccountBoundPassphrase(emailB);
  const remoteEnvelopeB = await core.sealVaultEnvelope(
    {
      syncSchema: 2,
      updatedAtMs: 1_760_000_600_000,
      hosts: [
        { id: 'host-account-b', name: 'bob-server', protocol: 'ssh', address: '192.168.10.5', port: 22, updatedAtMs: 1_760_000_600_000 },
      ],
      credentials: [],
      folders: [],
      totp: [],
      snippets: [],
      tombstones: {},
    },
    accountKeyB,
  );

  let patchCountA = 0;
  const driveServer = await startLoopbackServer((req, res) => {
    const auth = req.headers.authorization || '';
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const isAccountB = auth === 'Bearer ya29.account-b-token';
    const isAccountA = auth === 'Bearer ya29.account-a-token';
    if (!isAccountA && !isAccountB) {
      res.writeHead(401);
      res.end();
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/drive/v3/files') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          files: [{ id: isAccountB ? 'file-b' : 'file-a', name: GOOGLE_DRIVE_PRIMARY_VAULT_FILE }],
        }),
      );
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/drive/v3/files/file-a' && reqUrl.searchParams.get('alt') === 'media') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(remoteEnvelopeA);
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/drive/v3/files/file-b' && reqUrl.searchParams.get('alt') === 'media') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(remoteEnvelopeB);
      return;
    }
    if (req.method === 'PATCH' && reqUrl.pathname === '/upload/drive/v3/files/file-a') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        remoteEnvelopeA = Buffer.concat(chunks).toString('utf8');
        patchCountA += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'file-a' }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    // 3. Simulate Hard Refresh: brand-new SealedBrowserVaultStore on same storage, locked!
    const refreshedStore = new core.SealedBrowserVaultStore({ storage });
    assert.equal(refreshedStore.hasSealedVault(), true);
    assert.equal(refreshedStore.isUnlocked(), false);
    assert.equal(refreshedStore.getUiPrefs().vaultAuthMode, 'googleAccount');

    const resA = await core.unlockOrSyncGoogleVault({
      vaultStore: refreshedStore,
      accessToken: 'ya29.account-a-token',
      grantedScope: 'https://www.googleapis.com/auth/drive.appdata openid email',
      passphrase: accountKeyA,
      apiBaseUrl: driveServer.baseUrl,
    });

    assert.equal(resA.mergedLocal, true, 'Returning Google user MUST unlock local vault first and run smartMerge');
    assert.equal(resA.mode, 'smartMerge');
    assert.equal(resA.uploaded, true);
    assert.equal(patchCountA, 1, 'Merged payload with local deletion tombstone & new host must upload to Google Drive');
    assert.equal(refreshedStore.isUnlocked(), true);

    const hostIds = resA.payload.hosts.map((h) => h.id).sort();
    assert.deepStrictEqual(hostIds, ['host-keep', 'host-mobile-added', 'host-web-new']);
    assert.equal(hostIds.includes('host-stale-deleted'), false, 'Deleted host MUST stay deleted via local tombstone');
    assert.equal(resA.payload.tombstones[core.makeTombstoneKey('host', 'host-stale-deleted')], 1_760_000_450_000);

    // Verify remote Google Drive now also has the deletion tombstone & newly added host
    const decryptedRemote = await core.openVaultEnvelope(remoteEnvelopeA, accountKeyA);
    const remoteHostIds = (decryptedRemote.hosts as Array<{ id: string }>).map((h) => h.id).sort();
    assert.deepStrictEqual(remoteHostIds, ['host-keep', 'host-mobile-added', 'host-web-new']);

    // 4. Verify switching to a different Google account falls back cleanly to pullOnly without crashing
    refreshedStore.lock();
    const resB = await core.unlockOrSyncGoogleVault({
      vaultStore: refreshedStore,
      accessToken: 'ya29.account-b-token',
      grantedScope: 'https://www.googleapis.com/auth/drive.appdata openid email',
      passphrase: accountKeyB,
      apiBaseUrl: driveServer.baseUrl,
    });
    assert.equal(resB.mergedLocal, false, 'Switching Google accounts must fall back to pullOnly when local unlock fails');
    assert.equal(resB.mode, 'pullOnly');
    assert.deepStrictEqual(
      resB.payload.hosts.map((h) => h.id),
      ['host-account-b'],
    );

    const dump = JSON.stringify(storage.dump());
    assert.equal(dump.includes('ya29.account-a-token'), false);
    assert.equal(dump.includes('ya29.account-b-token'), false);
    assert.equal(dump.includes(accountKeyA), false);
    assert.equal(dump.includes(accountKeyB), false);
  } finally {
    await driveServer.close();
  }
});
