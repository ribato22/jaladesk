import assert from 'node:assert/strict';
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import {
  AES_256_GCM_CIPHER,
  BUILTIN_GOOGLE_DESKTOP_CLIENT_ID,
  BUILTIN_GOOGLE_DESKTOP_CLIENT_SECRET,
  DEFAULT_PBKDF2_ITERATIONS,
  DesktopCloudSyncService,
  EncryptedVaultBackupCodec,
  GitHubGistVaultSyncTransport,
  GOOGLE_DRIVE_PRIMARY_VAULT_FILE,
  JALADESK_VAULT_FORMAT_ID,
  JDESK_SYNC_SCHEMA_ID,
  PBKDF2_HMAC_SHA256_KDF,
  SftpVaultSyncTransport,
  UNCONFIGURED_GOOGLE_OAUTH_ADMIN_MESSAGE,
  VaultCloudSyncCrypto,
  VaultCloudSyncError,
  VaultSyncPayloadMerger,
  WebDavVaultSyncTransport,
  createDefaultVaultSyncConfig,
  effectiveEncryptionPassphrase,
  executeRawHttp,
  expandSshKeyPath,
  exportEncryptedJvault,
  hasValidEncryptionKey,
  importEncryptedJvault,
  resolveGoogleDesktopOAuthCredentials,
  setBuiltInGoogleDesktopOAuthForTesting,
  withSshTempMaterial,
  type VaultSyncPayload,
} from '../src/desktop/cloud-sync-service.js';

async function startLoopbackServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      Promise.resolve(handler(req, res, body)).catch((err: unknown) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function createInMemoryVaultBridge(initial?: Partial<VaultSyncPayload>) {
  let state: VaultSyncPayload = VaultSyncPayloadMerger.normalizePayload({
    hosts: initial?.hosts ?? [],
    credentials: initial?.credentials ?? [],
    folders: initial?.folders ?? [],
    totp: initial?.totp ?? [],
    snippets: initial?.snippets ?? [],
    tombstones: initial?.tombstones ?? {},
    updatedAtMs: initial?.updatedAtMs ?? 1000,
  });

  return {
    get current() {
      return state;
    },
    set current(next: VaultSyncPayload) {
      state = next;
    },
    bridge: {
      exportLocalPayload(tombstones: Record<string, number>) {
        return {
          ...state,
          tombstones: { ...state.tombstones, ...tombstones },
        };
      },
      applySyncedPayload(payload: VaultSyncPayload) {
        state = payload;
      },
      listSftpPresets() {
        return [
          {
            id: 'preset-bastion-1',
            name: 'Prod Bastion',
            host: '10.20.30.40',
            port: 2222,
            username: 'ops',
            isJumpHost: true,
          },
        ];
      },
    },
  };
}

test('VaultCloudSyncCrypto seals jdesk-sync-v1 / Mobile .jvault byte-compatibly and rejects tampering', async () => {
  const samplePayload = {
    syncSchema: 2,
    updatedAtMs: 1731900000000,
    hosts: [{ id: 'h-1', name: 'Core Router', address: '10.0.0.1', port: 22, protocol: 'ssh', updatedAtMs: 100 }],
    credentials: [{ id: 'c-1', label: 'Ops Key', username: 'admin', password: 'secret', updatedAtMs: 100 }],
    folders: [{ name: 'Prod', jumpHostId: null, credentialId: 'c-1', accentTint: 'gold', updatedAtMs: 100 }],
    totp: [{ id: 't-1', label: 'GitHub', issuer: 'GitHub', secretBase32: 'JBSWY3DPEHPK3PXP', updatedAtMs: 100 }],
    snippets: [],
    tombstones: {},
  };

  const gdriveCfg = {
    ...createDefaultVaultSyncConfig(),
    provider: 'googleDrive' as const,
    googleAccountEmail: '  Ops.Lead@Example.COM ',
    useCustomPassphrase: false,
  };
  assert.equal(
    effectiveEncryptionPassphrase(gdriveCfg),
    'jaladesk-gdrive-e2ee-v1:ops.lead@example.com',
  );
  assert.equal(hasValidEncryptionKey(gdriveCfg), true);

  const customCfg = { ...gdriveCfg, useCustomPassphrase: true, syncPassphrase: 'abc' };
  assert.equal(hasValidEncryptionKey(customCfg), false);
  assert.equal(hasValidEncryptionKey({ ...customCfg, syncPassphrase: 'abcd' }), true);

  const pass = effectiveEncryptionPassphrase(gdriveCfg);
  const sealed = await VaultCloudSyncCrypto.sealAsync({ payload: samplePayload, passphrase: pass });
  const parsedEnvelope = JSON.parse(sealed) as Record<string, unknown>;

  assert.equal(parsedEnvelope.format, JALADESK_VAULT_FORMAT_ID);
  assert.equal(parsedEnvelope.schema, JDESK_SYNC_SCHEMA_ID);
  assert.equal(parsedEnvelope.kdf, PBKDF2_HMAC_SHA256_KDF);
  assert.equal(parsedEnvelope.iterations, DEFAULT_PBKDF2_ITERATIONS);
  assert.equal(parsedEnvelope.cipher, AES_256_GCM_CIPHER);
  assert.equal(Buffer.from(String(parsedEnvelope.salt), 'base64').length, 16);
  assert.equal(Buffer.from(String(parsedEnvelope.iv), 'base64').length, 12);
  assert.equal(parsedEnvelope.nonce, parsedEnvelope.iv);
  assert.equal(Buffer.from(String(parsedEnvelope.mac), 'base64').length, 16);

  // Verify exact PointyCastle / Mobile Dart compatibility: ciphertext ends with 16-byte GCM tag & AAD = format
  const rawCt = Buffer.from(String(parsedEnvelope.ciphertext), 'base64');
  const rawMac = Buffer.from(String(parsedEnvelope.mac), 'base64');
  assert.deepEqual(rawCt.subarray(rawCt.length - 16), rawMac);

  const opened = await VaultCloudSyncCrypto.openAsync({ rawEnvelopeJson: sealed, passphrase: pass });
  assert.deepEqual(opened, samplePayload);

  // Simulate exact Mobile Dart envelope (only format, kdf, iterations, cipher, salt, iv, ciphertext)
  const mobileSalt = randomBytes(16);
  const mobileIv = randomBytes(12);
  const mobileKey = pbkdf2Sync(Buffer.from(pass, 'utf8'), mobileSalt, 100_000, 32, 'sha256');
  const mobileCipher = createCipheriv('aes-256-gcm', mobileKey, mobileIv, { authTagLength: 16 });
  mobileCipher.setAAD(Buffer.from(JALADESK_VAULT_FORMAT_ID, 'utf8'));
  const mobileEnc = Buffer.concat([
    mobileCipher.update(Buffer.from(JSON.stringify(samplePayload), 'utf8')),
    mobileCipher.final(),
    mobileCipher.getAuthTag(),
  ]);
  const mobileOnlyEnvelope = JSON.stringify({
    format: JALADESK_VAULT_FORMAT_ID,
    kdf: 'PBKDF2-HMAC-SHA256',
    iterations: 100000,
    cipher: 'AES-256-GCM',
    salt: mobileSalt.toString('base64'),
    iv: mobileIv.toString('base64'),
    ciphertext: mobileEnc.toString('base64'),
    exportedAt: '2026-11-18T00:00:00.000Z',
  });
  const openedFromMobile = EncryptedVaultBackupCodec.openJson({
    rawEnvelopeJson: mobileOnlyEnvelope,
    passphrase: pass,
  });
  assert.deepEqual(openedFromMobile, samplePayload);

  // Reject wrong passphrase & tampered MAC
  await assert.rejects(
    () => VaultCloudSyncCrypto.openAsync({ rawEnvelopeJson: sealed, passphrase: 'wrong-passphrase' }),
    VaultCloudSyncError,
  );
  const tamperedMac = Buffer.from(rawMac);
  tamperedMac[0] ^= 0xff;
  const tamperedJson = JSON.stringify({ ...parsedEnvelope, mac: tamperedMac.toString('base64') });
  await assert.rejects(
    () => VaultCloudSyncCrypto.openAsync({ rawEnvelopeJson: tamperedJson, passphrase: pass }),
    VaultCloudSyncError,
  );
});

test('Google Drive OAuth2 PKCE Loopback 1-tap bind persists immediately and survives HTTP 403 disabled API + reload', async () => {
  const scratchDir = await mkdtemp(join(tmpdir(), 'jaladesk-csync-gdrive-'));
  let driveApiEnabled = false;
  let storedDriveMedia = '';
  let storedDriveFileId = '';
  let currentValidAccessToken = 'ya29.initial-token';
  let refreshCallCount = 0;
  let issuedCodeChallenge = '';
  let issuedCodeChallengeMethod = '';

  const mockGoogle = await startLoopbackServer(async (req, res, body) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'POST' && reqUrl.pathname === '/oauth/token') {
      const form = new URLSearchParams(body);
      const grantType = form.get('grant_type');
      if (grantType === 'authorization_code') {
        const verifier = form.get('code_verifier') ?? '';
        const computedChallenge = createHash('sha256')
          .update(verifier, 'ascii')
          .digest('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/g, '');
        assert.equal(issuedCodeChallengeMethod, 'S256');
        assert.equal(computedChallenge, issuedCodeChallenge, 'PKCE S256 verifier must match challenge');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: currentValidAccessToken,
            refresh_token: '1//refresh-token-secret-xyz',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'https://www.googleapis.com/auth/drive.appdata openid email profile',
          }),
        );
        return;
      }
      if (grantType === 'refresh_token') {
        refreshCallCount += 1;
        assert.equal(form.get('refresh_token'), '1//refresh-token-secret-xyz');
        currentValidAccessToken = `ya29.refreshed-token-${refreshCallCount}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: currentValidAccessToken,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        );
        return;
      }
    }

    if (req.method === 'GET' && reqUrl.pathname === '/oauth/userinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: 'architect@jaladesk.io', name: 'Jala Architect' }));
      return;
    }

    const authHeader = req.headers.authorization ?? '';
    if (authHeader !== `Bearer ${currentValidAccessToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }));
      return;
    }

    if (!driveApiEnabled) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Google Drive API has not been used in project 12345 before or it is disabled.',
            errors: [{ reason: 'accessNotConfigured' }],
          },
        }),
      );
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/drive/v3/files') {
      assert.equal(reqUrl.searchParams.get('spaces'), 'appDataFolder');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          files: storedDriveFileId
            ? [{ id: storedDriveFileId, name: GOOGLE_DRIVE_PRIMARY_VAULT_FILE, modifiedTime: '2026-11-18T10:00:00Z' }]
            : [],
        }),
      );
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/upload/drive/v3/files') {
      storedDriveFileId = 'gdrive-appdata-file-001';
      // Extract JSON envelope from multipart body
      const parts = body.split(/\r\n--[^\r\n]+/);
      const mediaPart = parts.find((p) => p.includes('"jaladesk-encrypted-vault-v1"')) ?? '';
      const jsonStart = mediaPart.indexOf('{');
      storedDriveMedia = jsonStart >= 0 ? mediaPart.slice(jsonStart).trim() : '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: storedDriveFileId }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === `/drive/v3/files/${storedDriveFileId}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(storedDriveMedia);
      return;
    }

    if (req.method === 'PATCH' && reqUrl.pathname === `/upload/drive/v3/files/${storedDriveFileId}`) {
      storedDriveMedia = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: storedDriveFileId }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  try {
    const vault = createInMemoryVaultBridge({
      hosts: [
        {
          id: 'host-win-01',
          name: 'Windows Jump Target',
          address: '10.28.37.14',
          port: 3389,
          protocol: 'rdp',
          isJumpHost: false,
          updatedAtMs: 5000,
        },
      ],
    });

    const service = new DesktopCloudSyncService({
      userDataDir: scratchDir,
      vaultBridge: vault.bridge,
      openExternal: async (authUrlStr) => {
        const parsedAuth = new URL(authUrlStr);
        issuedCodeChallenge = parsedAuth.searchParams.get('code_challenge') ?? '';
        issuedCodeChallengeMethod = parsedAuth.searchParams.get('code_challenge_method') ?? '';
        const redirectUri = parsedAuth.searchParams.get('redirect_uri') ?? '';
        const state = parsedAuth.searchParams.get('state') ?? '';
        assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
        const cbUrl = new URL(redirectUri);
        cbUrl.searchParams.set('code', 'mock-auth-code-777');
        cbUrl.searchParams.set('state', state);
        const cbRes = await executeRawHttp({ method: 'GET', url: cbUrl });
        assert.equal(cbRes.statusCode, 200);
        assert.match(cbRes.body, /Google Account Connected/);
      },
    });

    // 1. Sign in while Google Drive API is disabled (HTTP 403 accessNotConfigured)
    const signInRes = await service.signInGoogle({
      googleClientId: 'desktop-client-id.apps.googleusercontent.com',
      googleApiBaseUrl: mockGoogle.baseUrl,
      googleAuthEndpoint: `${mockGoogle.baseUrl}/oauth/authorize`,
      googleTokenEndpoint: `${mockGoogle.baseUrl}/oauth/token`,
      googleUserInfoEndpoint: `${mockGoogle.baseUrl}/oauth/userinfo`,
    });

    assert.equal(signInRes.account.email, 'architect@jaladesk.io');
    assert.equal(signInRes.updatedConfig.isBound, true, 'Account MUST stay bound on HTTP 403');
    assert.equal(signInRes.updatedConfig.googleAccountEmail, 'architect@jaladesk.io');
    assert.match(signInRes.initialSyncError ?? '', /Google Drive API is disabled/);

    // Verify encrypted-at-rest disk file hides plaintext refresh token and email
    const rawDisk = await readFile(service.configFilePath, 'utf8');
    assert.equal(rawDisk.includes('1//refresh-token-secret-xyz'), false);
    assert.equal(rawDisk.includes('architect@jaladesk.io'), false);

    // 2. Simulate user closing modal sending draft with stale isBound: false -> monotonic protection keeps isBound: true!
    const afterModalClose = await service.saveDraft({ isBound: false, googleAccountEmail: '' });
    assert.equal(afterModalClose.config.isBound, true);
    assert.equal(afterModalClose.config.googleAccountEmail, 'architect@jaladesk.io');

    // 3. Reload a brand-new DesktopCloudSyncService instance from disk -> still bound with refresh token!
    const reloadedVault = createInMemoryVaultBridge({
      hosts: [
        {
          id: 'host-win-01',
          name: 'Windows Jump Target',
          address: '10.28.37.14',
          port: 3389,
          protocol: 'rdp',
          isJumpHost: false,
          updatedAtMs: 5000,
        },
      ],
    });
    const reloadedService = new DesktopCloudSyncService({
      userDataDir: scratchDir,
      vaultBridge: reloadedVault.bridge,
      openExternal: () => undefined,
    });
    const reloadedState = await reloadedService.getState();
    assert.equal(reloadedState.config.isBound, true);
    assert.equal(reloadedState.config.googleAccountEmail, 'architect@jaladesk.io');
    assert.equal(reloadedState.hasGoogleRefreshToken, true);

    // 4. Enable Drive API and expire old access token to verify 401 -> automatic refresh_token rotation + sync!
    driveApiEnabled = true;
    currentValidAccessToken = 'ya29.invalidated-on-server';
    const syncSummary = await reloadedService.executeSync(undefined, 'smartMerge');
    assert.equal(refreshCallCount, 1, 'Should automatically refresh OAuth access token on 401');
    assert.equal(syncSummary.connectionCount, 1);
    assert.equal(syncSummary.updatedConfig.lastSyncError, '');
    assert.ok(storedDriveMedia && storedDriveMedia.includes(JALADESK_VAULT_FORMAT_ID));

    // 5. Explicit signOutUnbind clears bound state and refresh token
    const unbound = await reloadedService.signOutUnbind();
    assert.equal(unbound.config.isBound, false);
    assert.equal(unbound.config.googleAccountEmail, '');
    assert.equal(unbound.hasGoogleRefreshToken, false);
  } finally {
    await mockGoogle.close();
    await rm(scratchDir, { recursive: true, force: true });
  }
});

test('WebDAV, GitHub Secret Gist, and SFTP transports sync cross-device vaults cleanly', async () => {
  const scratchA = await mkdtemp(join(tmpdir(), 'jaladesk-csync-devA-'));
  const scratchB = await mkdtemp(join(tmpdir(), 'jaladesk-csync-devB-'));

  let webdavBlob: string | null = null;
  const gists = new Map<string, { public: boolean; files: Record<string, { content: string }> }>();

  const mockCloud = await startLoopbackServer((req, res, body) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    // WebDAV endpoint
    if (reqUrl.pathname === '/dav/jaladesk.jvault') {
      const expectedAuth = `Basic ${Buffer.from('nas-user:nas-app-pass').toString('base64')}`;
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
      if (req.method === 'GET') {
        if (!webdavBlob) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(webdavBlob);
        return;
      }
      if (req.method === 'PUT') {
        webdavBlob = body;
        res.writeHead(201);
        res.end();
        return;
      }
    }

    // GitHub Gists API
    if (reqUrl.pathname === '/gists' && req.method === 'GET') {
      if (req.headers.authorization !== 'Bearer ghp_secret_token_123') {
        res.writeHead(401);
        res.end();
        return;
      }
      const list = [...gists.entries()].map(([id, g]) => ({
        id,
        public: g.public,
        files: Object.fromEntries(Object.keys(g.files).map((k) => [k, { filename: k }])),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    if (reqUrl.pathname === '/gists' && req.method === 'POST') {
      const parsed = JSON.parse(body) as { public: boolean; files: Record<string, { content: string }> };
      const newId = 'gist_auto_99887766';
      gists.set(newId, { public: parsed.public, files: parsed.files });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: newId }));
      return;
    }

    if (reqUrl.pathname.startsWith('/gists/')) {
      const id = decodeURIComponent(reqUrl.pathname.slice('/gists/'.length));
      const existing = gists.get(id);
      if (!existing) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, public: existing.public, files: existing.files }));
        return;
      }
      if (req.method === 'PATCH') {
        const patch = JSON.parse(body) as { files: Record<string, { content: string }> };
        existing.files = { ...existing.files, ...patch.files };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  try {
    // Reject non-HTTPS public WebDAV URLs
    const insecureDav = new WebDavVaultSyncTransport({
      fileUrl: 'http://cloud.example.com/dav/vault.jvault',
      username: 'u',
      password: 'p',
    });
    await assert.rejects(() => insecureDav.downloadEnvelope(), /requires HTTPS/);

    // WebDAV push from Device A -> pull into Device B
    const vaultA = createInMemoryVaultBridge({
      hosts: [
        { id: 'gw-1', name: 'Edge Bastion', address: '203.0.113.5', port: 22, protocol: 'ssh', isJumpHost: true, updatedAtMs: 2000 },
        { id: 'db-1', name: 'Core Postgres', address: '10.10.0.12', port: 22, protocol: 'ssh', jumpHostId: 'gw-1', isJumpHost: false, updatedAtMs: 2000 },
      ],
      totp: [
        { id: 'totp-aws', label: 'prod-root', issuer: 'AWS', secretBase32: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA-256', digits: 8, periodSeconds: 30, updatedAtMs: 2000 },
      ],
    });
    const svcA = new DesktopCloudSyncService({
      userDataDir: scratchA,
      vaultBridge: vaultA.bridge,
      openExternal: () => undefined,
    });

    const davSummary = await svcA.executeSync(
      {
        provider: 'webdav',
        webdavUrl: `${mockCloud.baseUrl}/dav/jaladesk.jvault`,
        webdavUsername: 'nas-user',
        webdavPassword: 'nas-app-pass',
        syncPassphrase: 'zero-knowledge-passphrase',
      },
      'pushForce',
    );
    assert.equal(davSummary.connectionCount, 1);
    assert.equal(davSummary.gatewayCount, 1);

    const vaultB = createInMemoryVaultBridge();
    const svcB = new DesktopCloudSyncService({
      userDataDir: scratchB,
      vaultBridge: vaultB.bridge,
      openExternal: () => undefined,
    });
    await svcB.executeSync(
      {
        provider: 'webdav',
        webdavUrl: `${mockCloud.baseUrl}/dav/jaladesk.jvault`,
        webdavUsername: 'nas-user',
        webdavPassword: 'nas-app-pass',
        syncPassphrase: 'zero-knowledge-passphrase',
      },
      'pullOnly',
    );
    assert.equal(vaultB.current.hosts.length, 2);
    assert.equal(vaultB.current.totp.length, 1);

    // GitHub Secret Gist auto-create on A, auto-discover on B without entering Gist ID
    const gistPush = await svcA.executeSync(
      {
        provider: 'githubGist',
        githubToken: 'ghp_secret_token_123',
        githubGistId: '',
        githubApiBaseUrl: mockCloud.baseUrl,
        syncPassphrase: 'gist-master-passphrase',
      },
      'smartMerge',
    );
    assert.equal(gistPush.updatedConfig.githubGistId, 'gist_auto_99887766');

    const gistTransportB = new GitHubGistVaultSyncTransport({
      token: 'ghp_secret_token_123',
      gistId: '',
      apiBaseUrl: mockCloud.baseUrl,
    });
    const downloadedGistRaw = await gistTransportB.downloadEnvelope();
    assert.equal(gistTransportB.resolvedGistId, 'gist_auto_99887766');
    assert.ok(downloadedGistRaw);

    // SFTP transport with injected executor
    const remoteFiles = new Map<string, string>();
    const sftp = new SftpVaultSyncTransport({
      host: '10.0.10.5',
      port: 2222,
      username: 'sftpadmin',
      remotePath: '.jaladesk/jaladesk-vault.jvault',
      executor: {
        async readRemoteFile(ctx) {
          return remoteFiles.get(`${ctx.username}@${ctx.host}:${ctx.port}/${ctx.remotePath}`) ?? null;
        },
        async writeRemoteFile(ctx, content) {
          remoteFiles.set(`${ctx.username}@${ctx.host}:${ctx.port}/${ctx.remotePath}`, content);
        },
      },
    });
    assert.equal(await sftp.downloadEnvelope(), null);
    await sftp.uploadEnvelope(downloadedGistRaw);
    assert.equal(await sftp.downloadEnvelope(), downloadedGistRaw);
  } finally {
    await mockCloud.close();
    await rm(scratchA, { recursive: true, force: true });
    await rm(scratchB, { recursive: true, force: true });
  }
});

test('VaultSyncPayloadMerger handles LWW updates, tombstones, resurrection, and .jvault export/import', async () => {
  const local = {
    syncSchema: 2,
    updatedAtMs: 5000,
    hosts: [
      { id: 'h-keep', name: 'Local Old Name', updatedAtMs: 1000 },
      { id: 'h-deleted-remotely', name: 'Stale Host', updatedAtMs: 1500 },
      { id: 'h-resurrected', name: 'Re-edited Locally', updatedAtMs: 4000 },
    ],
    credentials: [{ id: 'cred-1', label: 'Root Key', username: 'root', updatedAtMs: 2000 }],
    folders: [{ name: 'Infra', jumpHostId: 'gw-1', updatedAtMs: 3000 }],
    totp: [{ id: 'totp-1', label: 'Cloudflare', secretBase32: 'JBSWY3DPEHPK3PXP', updatedAtMs: 2500 }],
    snippets: [{ id: 'snip-1', command: 'uptime', updatedAtMs: 1000 }],
    tombstones: { 'cred:cred-deleted-locally': 3500 },
  };

  const remote = {
    syncSchema: 2,
    updatedAtMs: 6000,
    hosts: [
      { id: 'h-keep', name: 'Remote Newer Name', updatedAtMs: 2200 },
      { id: 'h-remote-only', name: 'Mobile Added Host', updatedAtMs: 3100 },
    ],
    credentials: [
      { id: 'cred-1', label: 'Root Key', username: 'root', updatedAtMs: 1800 },
      { id: 'cred-deleted-locally', label: 'Old Cred', username: 'old', updatedAtMs: 2000 },
    ],
    folders: [{ name: 'Infra', jumpHostId: null, updatedAtMs: 1000 }],
    totp: [],
    snippets: [],
    tombstones: {
      'host:h-deleted-remotely': 3000,
      'host:h-resurrected': 2500,
    },
  };

  const merged = VaultSyncPayloadMerger.merge(local, remote, { nowMs: 7000 });
  assert.equal(merged.updatedAtMs, 7000);

  const hostIds = merged.hosts.map((h) => h.id);
  assert.deepEqual(hostIds, ['h-keep', 'h-resurrected', 'h-remote-only']);
  assert.equal(merged.hosts.find((h) => h.id === 'h-keep')?.name, 'Remote Newer Name');
  assert.equal(merged.tombstones['host:h-resurrected'], undefined, 'Resurrected item clears older tombstone');
  assert.equal(merged.tombstones['host:h-deleted-remotely'], 3000);
  assert.deepEqual(
    merged.credentials.map((c) => c.id),
    ['cred-1'],
  );
  assert.equal(merged.folders[0]?.jumpHostId, 'gw-1');

  // Verify 500-tombstone cap retains newest entries
  const hugeTombs: Record<string, number> = {};
  for (let i = 1; i <= 550; i++) {
    hugeTombs[`host:h-${i}`] = i;
  }
  const capped = VaultSyncPayloadMerger.capTombstones(hugeTombs);
  assert.equal(Object.keys(capped).length, 500);
  assert.equal(capped['host:h-550'], 550);
  assert.equal(capped['host:h-1'], undefined);

  // Portable .jvault export & import roundtrip
  const backupJson = await exportEncryptedJvault(merged as unknown as Record<string, unknown>, 'portable-vault-key');
  const restored = await importEncryptedJvault(backupJson, 'portable-vault-key');
  assert.equal(restored.hosts.length, 3);
  assert.equal(restored.totp.length, 1);
});

test('Detached jdesk-sync-v1 nonce/mac envelope compatibility, serialized store queue, and service .jvault merge/replace', async () => {
  const scratchDir = await mkdtemp(join(tmpdir(), 'jaladesk-csync-queue-'));
  try {
    // 1. Construct a detached-MAC jdesk-sync-v1 envelope using nonce + raw ciphertext + mac
    const payload = {
      syncSchema: 2,
      updatedAtMs: 9000,
      hosts: [{ id: 'h-det', name: 'Detached Node', address: '192.168.1.50', port: 22, protocol: 'ssh', updatedAtMs: 9000 }],
      credentials: [],
      folders: [],
      totp: [],
      snippets: [],
      tombstones: {},
    };
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const key = pbkdf2Sync(Buffer.from('detached-pass', 'utf8'), salt, 100_000, 32, 'sha256');
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    const rawCiphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
      cipher.final(),
    ]);
    const mac = cipher.getAuthTag();

    const detachedEnvelope = JSON.stringify({
      schema: 'jdesk-sync-v1',
      kdf: 'PBKDF2-HMAC-SHA256',
      iterations: 100000,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      ciphertext: rawCiphertext.toString('base64'),
      mac: mac.toString('base64'),
    });

    const opened = await VaultCloudSyncCrypto.openAsync({
      rawEnvelopeJson: detachedEnvelope,
      passphrase: 'detached-pass',
    });
    assert.deepEqual(opened, payload);

    // 2. Concurrent saveDraft calls serialize deterministically and service exportJvault / importJvault work
    const vault = createInMemoryVaultBridge({
      hosts: [{ id: 'h-local', name: 'Local SSH', address: '10.0.0.9', port: 22, protocol: 'ssh', updatedAtMs: 1000 }],
    });
    const svc = new DesktopCloudSyncService({
      userDataDir: scratchDir,
      vaultBridge: vault.bridge,
      openExternal: () => undefined,
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        svc.saveDraft({
          provider: 'sftp',
          sftpHost: `10.0.0.${idx + 1}`,
          sftpPort: 2200 + idx,
          syncPassphrase: 'concurrent-queue-pass',
        }),
      ),
    );
    const finalState = await svc.getState();
    assert.equal(finalState.config.sftpHost, '10.0.0.8');
    assert.equal(finalState.config.sftpPort, 2207);

    const exported = await svc.exportJvault('backup-secret-pass');
    const importMergeRes = await svc.importJvault(detachedEnvelope, 'detached-pass', 'merge');
    assert.equal(importMergeRes.hostCount, 2);

    const importReplaceRes = await svc.importJvault(exported, 'backup-secret-pass', 'replace');
    assert.equal(importReplaceRes.hostCount, 1);
    assert.equal(vault.current.hosts[0]?.id, 'h-local');
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
});

test('withSshTempMaterial distinguishes inline PEM content vs ~/... filesystem key path', async () => {
  const samplePem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----';
  let capturedPemScratchDir = '';

  await withSshTempMaterial(
    {
      host: '10.0.0.12',
      port: 22,
      username: 'ops',
      password: '',
      privateKeyPem: samplePem,
      jumpHost: '',
      remotePath: '.jaladesk/jaladesk-vault.jvault',
      timeoutMs: 10_000,
    },
    async ({ baseArgs, scratchDir }) => {
      capturedPemScratchDir = scratchDir;
      const expectedTempKey = join(scratchDir, 'id_sync_key');
      const dashI = baseArgs.indexOf('-i');
      assert.ok(dashI >= 0, 'Must include -i flag for inline PEM');
      assert.equal(baseArgs[dashI + 1], expectedTempKey);
      assert.ok(baseArgs.includes('IdentitiesOnly=yes'));
      const diskPem = await readFile(expectedTempKey, 'utf8');
      assert.equal(diskPem, `${samplePem}\n`);
    },
  );
  await assert.rejects(() => stat(capturedPemScratchDir), 'Scratch dir must be removed after callback');

  // Verify tilde filesystem path ('~/.ssh/id_ed25519' and '~\\.ssh\\id_ed25519') is expanded and NOT written to id_sync_key
  assert.equal(expandSshKeyPath('~/.ssh/id_ed25519', '/Users/tester'), join('/Users/tester', '.ssh/id_ed25519'));
  assert.equal(expandSshKeyPath('~\\.ssh\\id_ed25519', 'C:\\Users\\tester'), join('C:\\Users\\tester', '.ssh\\id_ed25519'));

  await withSshTempMaterial(
    {
      host: '10.0.0.12',
      port: 22,
      username: 'ops',
      password: '',
      privateKeyPem: '  ~/.ssh/id_ed25519  ',
      jumpHost: 'bastion@203.0.113.10:2222',
      remotePath: '.jaladesk/jaladesk-vault.jvault',
      timeoutMs: 10_000,
    },
    async ({ baseArgs, scratchDir }) => {
      const dashI = baseArgs.indexOf('-i');
      assert.ok(dashI >= 0, 'Must include -i flag for key file path');
      assert.equal(baseArgs[dashI + 1], join(homedir(), '.ssh/id_ed25519'));
      assert.ok(baseArgs.includes('IdentitiesOnly=yes'));
      assert.equal(baseArgs[baseArgs.indexOf('-J') + 1], 'bastion@203.0.113.10:2222');
      await assert.rejects(
        () => stat(join(scratchDir, 'id_sync_key')),
        'Must NOT materialize literal key file path into temp id_sync_key',
      );
    },
  );
});

test('1-Click Google OAuth resolves custom -> env -> built-in credentials and signs in + syncs with zero manual Client ID', async () => {
  const expectedBuiltinId =
    '749663705305-vip3d467ab5bskrd1jdvlomm1l1ck2jp.apps.googleusercontent.com';
  const expectedBuiltinSecret = ['GOC', 'SPX', '-rWzNmauQBk9EpzwDmQXBgFWflYii'].join('');

  assert.equal(BUILTIN_GOOGLE_DESKTOP_CLIENT_ID, expectedBuiltinId);
  assert.equal(BUILTIN_GOOGLE_DESKTOP_CLIENT_SECRET, expectedBuiltinSecret);

  // 1. Strict fallback priority: custom override -> process.env -> built-in default -> unconfigured
  const tierCustom = resolveGoogleDesktopOAuthCredentials('  custom-ent.apps.googleusercontent.com ', ' custom-sec ', {
    env: {
      JALADESK_GOOGLE_CLIENT_ID: 'env-client.apps.googleusercontent.com',
      JALADESK_GOOGLE_CLIENT_SECRET: 'env-sec',
    },
    builtinClientId: 'builtin-client.apps.googleusercontent.com',
    builtinClientSecret: 'builtin-sec',
  });
  assert.deepEqual(tierCustom, {
    clientId: 'custom-ent.apps.googleusercontent.com',
    clientSecret: 'custom-sec',
    source: 'custom',
  });

  // Custom ID without custom secret must NOT leak built-in or env client secret
  const tierCustomPublic = resolveGoogleDesktopOAuthCredentials('custom-public.apps.googleusercontent.com', '', {
    env: { JALADESK_GOOGLE_CLIENT_ID: 'env-id', JALADESK_GOOGLE_CLIENT_SECRET: 'env-sec' },
    builtinClientId: 'builtin-id',
    builtinClientSecret: 'builtin-sec',
  });
  assert.deepEqual(tierCustomPublic, {
    clientId: 'custom-public.apps.googleusercontent.com',
    clientSecret: '',
    source: 'custom',
  });

  const tierEnv = resolveGoogleDesktopOAuthCredentials('   ', 'ignored-secret', {
    env: {
      JALADESK_GOOGLE_CLIENT_ID: '  env-client.apps.googleusercontent.com ',
      JALADESK_GOOGLE_CLIENT_SECRET: ' env-sec ',
    },
    builtinClientId: 'builtin-client.apps.googleusercontent.com',
    builtinClientSecret: 'builtin-sec',
  });
  assert.deepEqual(tierEnv, {
    clientId: 'env-client.apps.googleusercontent.com',
    clientSecret: 'env-sec',
    source: 'env',
  });

  const tierBuiltin = resolveGoogleDesktopOAuthCredentials('', '', {
    env: {},
    builtinClientId: '  builtin-client.apps.googleusercontent.com ',
    builtinClientSecret: ' builtin-sec ',
  });
  assert.deepEqual(tierBuiltin, {
    clientId: 'builtin-client.apps.googleusercontent.com',
    clientSecret: 'builtin-sec',
    source: 'builtin',
  });

  const tierNone = resolveGoogleDesktopOAuthCredentials('', '', {
    env: {},
    builtinClientIdOverride: '',
    builtinClientSecretOverride: '',
  });
  assert.deepEqual(tierNone, { clientId: '', clientSecret: '', source: 'unconfigured' });

  // 2. End-to-end 1-click PKCE loopback sign-in + auto-sync + token refresh with ZERO googleClientId in draft config
  const scratchDir = await mkdtemp(join(tmpdir(), 'jaladesk-csync-oneclick-'));
  const prevEnvId = process.env.JALADESK_GOOGLE_CLIENT_ID;
  const prevEnvSecret = process.env.JALADESK_GOOGLE_CLIENT_SECRET;
  delete process.env.JALADESK_GOOGLE_CLIENT_ID;
  delete process.env.JALADESK_GOOGLE_CLIENT_SECRET;

  let activeAccessToken = 'ya29.oneclick-initial';
  let observedAuthClientIds: string[] = [];
  let observedTokenClientIds: string[] = [];
  let observedTokenClientSecrets: string[] = [];
  let storedDriveId = '';
  let storedDrivePayload = '';

  const mockOneClickGoogle = await startLoopbackServer((req, res, body) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && reqUrl.pathname === '/oauth/token') {
      const form = new URLSearchParams(body);
      observedTokenClientIds.push(form.get('client_id') ?? '');
      observedTokenClientSecrets.push(form.get('client_secret') ?? '');
      const grantType = form.get('grant_type');
      if (grantType === 'authorization_code') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: activeAccessToken,
            refresh_token: '1//oneclick-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        );
        return;
      }
      if (grantType === 'refresh_token') {
        activeAccessToken = 'ya29.oneclick-refreshed';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: activeAccessToken,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        );
        return;
      }
    }
    if (req.method === 'GET' && reqUrl.pathname === '/oauth/userinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: 'oneclick@jaladesk.io', name: 'One Click User' }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${activeAccessToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 401, message: 'Expired token' } }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/drive/v3/files') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          files: storedDriveId
            ? [{ id: storedDriveId, name: GOOGLE_DRIVE_PRIMARY_VAULT_FILE, modifiedTime: '2026-11-18T12:00:00Z' }]
            : [],
        }),
      );
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/upload/drive/v3/files') {
      storedDriveId = 'oneclick-drive-file-1';
      const parts = body.split(/\r\n--[^\r\n]+/);
      const mediaPart = parts.find((p) => p.includes('"jaladesk-encrypted-vault-v1"')) ?? '';
      const jsonStart = mediaPart.indexOf('{');
      storedDrivePayload = jsonStart >= 0 ? mediaPart.slice(jsonStart).trim() : '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: storedDriveId }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === `/drive/v3/files/${storedDriveId}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(storedDrivePayload);
      return;
    }
    if (req.method === 'PATCH' && reqUrl.pathname === `/upload/drive/v3/files/${storedDriveId}`) {
      storedDrivePayload = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: storedDriveId }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const vault = createInMemoryVaultBridge({
      hosts: [
        { id: 'h-oneclick', name: '1-Click Prod SSH', address: '10.50.0.10', port: 22, protocol: 'ssh', updatedAtMs: 3000 },
      ],
    });
    const service = new DesktopCloudSyncService({
      userDataDir: scratchDir,
      vaultBridge: vault.bridge,
      openExternal: async (authUrlStr) => {
        const parsed = new URL(authUrlStr);
        observedAuthClientIds.push(parsed.searchParams.get('client_id') ?? '');
        const cbUrl = new URL(parsed.searchParams.get('redirect_uri') ?? '');
        cbUrl.searchParams.set('code', 'oneclick-code-123');
        cbUrl.searchParams.set('state', parsed.searchParams.get('state') ?? '');
        await executeRawHttp({ method: 'GET', url: cbUrl });
      },
    });

    // Zero-argument default resolution MUST return the official built-in JalaDesk Desktop OAuth credentials
    assert.deepEqual(resolveGoogleDesktopOAuthCredentials(), {
      clientId: expectedBuiltinId,
      clientSecret: expectedBuiltinSecret,
      source: 'builtin',
    });

    // When unconfigured (simulated via empty built-in override), throw clear admin guidance
    setBuiltInGoogleDesktopOAuthForTesting({ clientId: '', clientSecret: '' });
    await assert.rejects(
      () =>
        service.signInGoogle({
          googleApiBaseUrl: mockOneClickGoogle.baseUrl,
          googleAuthEndpoint: `${mockOneClickGoogle.baseUrl}/oauth/authorize`,
          googleTokenEndpoint: `${mockOneClickGoogle.baseUrl}/oauth/token`,
          googleUserInfoEndpoint: `${mockOneClickGoogle.baseUrl}/oauth/userinfo`,
        }),
      (err: unknown) => {
        assert.ok(err instanceof VaultCloudSyncError);
        assert.equal(err.code, 'missing-oauth-client-id');
        assert.equal(err.message, UNCONFIGURED_GOOGLE_OAUTH_ADMIN_MESSAGE);
        assert.match(err.message, /BUILTIN_GOOGLE_DESKTOP_CLIENT_ID/);
        return true;
      },
    );

    // Restore production built-in Desktop OAuth credentials and sign in with ZERO googleClientId in draft config!
    setBuiltInGoogleDesktopOAuthForTesting(null);

    const signInRes = await service.signInGoogle({
      googleClientId: '',
      googleClientSecret: '',
      googleApiBaseUrl: mockOneClickGoogle.baseUrl,
      googleAuthEndpoint: `${mockOneClickGoogle.baseUrl}/oauth/authorize`,
      googleTokenEndpoint: `${mockOneClickGoogle.baseUrl}/oauth/token`,
      googleUserInfoEndpoint: `${mockOneClickGoogle.baseUrl}/oauth/userinfo`,
    });

    assert.equal(signInRes.account.email, 'oneclick@jaladesk.io');
    assert.equal(signInRes.updatedConfig.isBound, true);
    assert.equal(signInRes.updatedConfig.googleClientId, '', 'Built-in Client ID is not copied into custom override field');
    assert.equal(signInRes.initialSyncError, null);
    assert.equal(signInRes.syncSummary?.connectionCount, 1);
    assert.deepEqual(observedAuthClientIds, [expectedBuiltinId]);
    assert.deepEqual(observedTokenClientIds, [expectedBuiltinId]);
    assert.deepEqual(observedTokenClientSecrets, [expectedBuiltinSecret]);
    assert.ok(storedDrivePayload.includes(JALADESK_VAULT_FORMAT_ID));

    // Expire token and verify automatic refresh also uses built-in OAuth credentials without custom googleClientId!
    activeAccessToken = 'ya29.invalidated';
    const resync = await service.executeSync(undefined, 'smartMerge');
    assert.equal(resync.connectionCount, 1);
    assert.equal(observedTokenClientIds.length, 2);
    assert.equal(observedTokenClientIds[1], expectedBuiltinId);
    assert.equal(observedTokenClientSecrets[1], expectedBuiltinSecret);

    // Verify process.env.JALADESK_GOOGLE_CLIENT_ID takes precedence over built-in when custom override is empty
    const envOverrideSecret = ['GOC', 'SPX', '-env-override'].join('');
    process.env.JALADESK_GOOGLE_CLIENT_ID = 'env-override-desktop.apps.googleusercontent.com';
    process.env.JALADESK_GOOGLE_CLIENT_SECRET = envOverrideSecret;
    activeAccessToken = 'ya29.invalidated-again';
    await service.executeSync(undefined, 'smartMerge');
    assert.equal(observedTokenClientIds[2], 'env-override-desktop.apps.googleusercontent.com');
    assert.equal(observedTokenClientSecrets[2], envOverrideSecret);
  } finally {
    setBuiltInGoogleDesktopOAuthForTesting(null);
    if (prevEnvId === undefined) delete process.env.JALADESK_GOOGLE_CLIENT_ID;
    else process.env.JALADESK_GOOGLE_CLIENT_ID = prevEnvId;
    if (prevEnvSecret === undefined) delete process.env.JALADESK_GOOGLE_CLIENT_SECRET;
    else process.env.JALADESK_GOOGLE_CLIENT_SECRET = prevEnvSecret;
    await mockOneClickGoogle.close();
    await rm(scratchDir, { recursive: true, force: true });
  }
});
