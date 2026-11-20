import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DesktopTotpVaultStore } from '../src/credentials/totp.js';
import { AppLockPinManager } from '../src/desktop/app-lock-pin.js';
import {
  DesktopCloudSyncService,
  JDESK_SYNC_SCHEMA_ID,
  VaultCloudSyncCrypto,
} from '../src/desktop/cloud-sync-service.js';
import { buildConnectionActionSections } from '../src/desktop/context-menu.js';
import {
  DIRECT_NO_JUMP_OVERRIDE,
  applyMobileSyncPayloadToLibrary,
  buildDesktopVaultSyncPayload,
  computeProportionalDisplayBox,
  mapProportionalCanvasPoint,
  resolveConnectionJumpRoute,
  resolveDocumentNodeJumpRoute,
} from '../src/desktop/studios-sre-ha.js';
import { JALADESK_GUIDE_TOPICS } from '../src/desktop/user-guide-ui.js';
import { DocumentLibrary } from '../src/documents/library.js';
import { startGatewayServer } from '../src/gateway/server.js';

const readDesktopFile = (name: string) =>
  readFile(fileURLToPath(new URL(`../../src/desktop/${name}`, import.meta.url)), 'utf8');

test('VNC proportional display sizing preserves remote aspect ratio in Fit, Fill, and 1:1 without stretching', () => {
  // 16:9 remote desktop (1920x1080) inside a 4:3 viewport (1200x900)
  const fit16by9In4by3 = computeProportionalDisplayBox(1200, 900, 1920, 1080, 'fit');
  assert.equal(fit16by9In4by3.cssWidth, 1200);
  assert.equal(fit16by9In4by3.cssHeight, 675, 'letterboxed vertically, never stretched to 900px');
  assert.equal(fit16by9In4by3.offsetY, 112);
  assert.equal(fit16by9In4by3.aspectRatioPreserved, true);
  assert.ok(Math.abs(fit16by9In4by3.scaleX - fit16by9In4by3.scaleY) < 0.002);

  // 4:3 remote desktop (1024x768) inside a 16:9 viewport (1600x900)
  const fit4by3In16by9 = computeProportionalDisplayBox(1600, 900, 1024, 768, 'fit');
  assert.equal(fit4by3In16by9.cssWidth, 1200, 'pillarboxed horizontally, never stretched to 1600px');
  assert.equal(fit4by3In16by9.cssHeight, 900);
  assert.equal(fit4by3In16by9.offsetX, 200);
  assert.equal(fit4by3In16by9.aspectRatioPreserved, true);

  // Fill mode (cover + pan): 16:9 remote desktop (1920x1080) inside 4:3 viewport (1200x900)
  const fill16by9In4by3 = computeProportionalDisplayBox(1200, 900, 1920, 1080, 'fill');
  assert.equal(fill16by9In4by3.cssWidth, 1600, 'covers height and overflows width proportionally for pan');
  assert.equal(fill16by9In4by3.cssHeight, 900);
  assert.equal(fill16by9In4by3.overflowX, 400);
  assert.equal(fill16by9In4by3.overflowY, 0);
  assert.equal(fill16by9In4by3.aspectRatioPreserved, true);
  assert.ok(Math.abs(fill16by9In4by3.scaleX - fill16by9In4by3.scaleY) < 0.002);

  // 1:1 mode (actual native pixels)
  const actualRetina = computeProportionalDisplayBox(1200, 800, 2560, 1600, 'actual');
  assert.equal(actualRetina.cssWidth, 2560);
  assert.equal(actualRetina.cssHeight, 1600);
  assert.equal(actualRetina.scaleX, 1);
  assert.equal(actualRetina.scaleY, 1);

  // Proportional pointer coordinate mapping
  const centerPt = mapProportionalCanvasPoint(
    700,
    550,
    { left: 100, top: 100, width: 1200, height: 900 },
    1024,
    768,
  );
  assert.deepEqual(centerPt, { x: 512, y: 384 });
  const clampedPt = mapProportionalCanvasPoint(
    20,
    2000,
    { left: 100, top: 100, width: 1200, height: 900 },
    1024,
    768,
  );
  assert.deepEqual(clampedPt, { x: 0, y: 767 });
});

test('per-connection Jump Host routes cleanly inside unconfigured folders and respects __direct__ overrides', async () => {
  // 1. Direct unit check: connection has Jump Host, parent folder has NO Jump Host configured
  const perConnInUnconfiguredFolder = resolveConnectionJumpRoute(
    { notes: '[Plugin: Remote Desktop | jump=pln-jump]' },
    [{ notes: '' }],
    { jumpHost: '' },
  );
  assert.equal(perConnInUnconfiguredFolder.jumpHost, 'pln-jump');
  assert.equal(perConnInUnconfiguredFolder.source, 'connection');

  // 2. Connection has Jump Host inside a parent folder marked __direct__ -> connection's explicit Jump Host still wins
  const perConnOverridesDirectFolder = resolveConnectionJumpRoute(
    { jumpHost: 'mitra-jump' },
    [{ jumpHost: DIRECT_NO_JUMP_OVERRIDE }],
  );
  assert.equal(perConnOverridesDirectFolder.jumpHost, 'mitra-jump');
  assert.equal(perConnOverridesDirectFolder.source, 'connection');

  // 3. Connection marked __direct__ inside a Jump-configured folder -> explicit Direct wins
  const explicitDirectInJumpFolder = resolveConnectionJumpRoute(
    { notes: `[Plugin: Terminal | jump=${DIRECT_NO_JUMP_OVERRIDE}]` },
    [{ notes: '[Plugin: Folder | jump=distribusi-jump]' }],
    { jumpHost: 'pln-jump' },
  );
  assert.equal(explicitDirectInJumpFolder.jumpHost, '');
  assert.equal(explicitDirectInJumpFolder.source, 'connection-direct');

  // 4. Unconfigured connection inside unconfigured child folder inherits grandparent folder Jump Host
  const inheritedFromGrandparent = resolveConnectionJumpRoute(
    { notes: '' },
    [{ notes: '' }, { notes: '[Plugin: Folder | jump=distribusi-jump | key=~/.ssh/id_ed25519]' }],
  );
  assert.equal(inheritedFromGrandparent.jumpHost, 'distribusi-jump');
  assert.equal(inheritedFromGrandparent.sshKey, '~/.ssh/id_ed25519');
  assert.equal(inheritedFromGrandparent.source, 'folder');

  // 5. Real DocumentLibrary tree resolution (main.ts openStoredWithJump path)
  const dir = await mkdtemp(join(tmpdir(), 'jaladesk-jump-parity-'));
  try {
    const library = new DocumentLibrary();
    const docSummary = await library.create(join(dir, 'ops.rwdoc'), 'Ops Infra', 'CorrectHorseBattery99!', 'workspace');
    const unconfiguredFolder = library.add(docSummary.id, {
      parentId: null,
      type: 'folder',
      name: 'Unconfigured LAN Folder',
      props: { color: 'blue', icon: 'box' },
    });
    const connWithOwnJump = library.add(docSummary.id, {
      parentId: unconfiguredFolder.objectId,
      type: 'connection',
      name: 'Private DB Windows Jump Target',
      props: {
        protocol: 'rdp',
        host: '10.28.37.14',
        port: 3389,
        username: 'bright',
        clipboardToRemote: false,
        clipboardFromRemote: false,
        notes: '[Plugin: Remote Desktop | jump=pln-jump]',
      },
    });
    const resolved = resolveDocumentNodeJumpRoute(
      library.privateDocument(docSummary.id).doc as any,
      connWithOwnJump.objectId,
    );
    assert.equal(resolved.jumpHost, 'pln-jump');
    assert.equal(resolved.source, 'connection');
    library.closeAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Desktop <-> Mobile jdesk-sync-v1 Cloud Sync & .jvault roundtrip syncs connections, unconfigured folders, gateways, credentials, and RFC 6238 TOTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jaladesk-desktop-sync-e2e-'));
  let remoteVaultBlob = '';

  const webdavServer = http.createServer((req, res) => {
    if (req.method === 'GET') {
      if (!remoteVaultBlob) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(remoteVaultBlob);
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        remoteVaultBlob = Buffer.concat(chunks).toString('utf8');
        res.writeHead(201).end('Created');
      });
      return;
    }
    res.writeHead(405).end();
  });

  await new Promise<void>((resolve) => webdavServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (webdavServer.address() as AddressInfo).port;
  const webdavUrl = `http://127.0.0.1:${port}/jaladesk-vault.jvault`;

  try {
    // Simulate JalaDesk Mobile uploading a jdesk-sync-v1 envelope to WebDAV
    const mobilePassphrase = 'MobileDesktopSharedSecret#2026';
    const mobilePayload = {
      syncSchema: 2,
      updatedAtMs: 1_763_000_000_000,
      folders: [
        { name: 'Unconfigured Folder', jumpHostId: null, credentialId: null, accentTint: 'sapphire', updatedAtMs: 1_763_000_000_000 },
        { name: 'DMZ Folder', jumpHostId: 'host_gw_uuid_99', credentialId: null, accentTint: 'gold', updatedAtMs: 1_763_000_000_000 },
      ],
      hosts: [
        {
          id: 'host_gw_uuid_99',
          name: 'SG Prod Bastion',
          address: '203.0.113.10',
          port: 2222,
          protocol: 'ssh',
          folder: 'Gateways',
          osLabel: 'Bastion',
          domain: '',
          username: 'ops',
          password: '',
          privateKeyPem: '',
          jumpHostId: null,
          credentialId: null,
          isJumpHost: true,
          isFavorite: true,
          accentTint: 'emerald',
          updatedAtMs: 1_763_000_000_000,
        },
        {
          id: 'host-rdp-per-conn-jump',
          name: 'Core Billing RDP',
          address: '10.28.37.14',
          port: 3389,
          protocol: 'rdp',
          folder: 'Unconfigured Folder',
          osLabel: 'Windows 11',
          domain: 'CORP',
          username: 'bright',
          password: '',
          privateKeyPem: '',
          jumpHostId: 'host_gw_uuid_99',
          credentialId: null,
          isJumpHost: false,
          isFavorite: true,
          accentTint: 'sapphire',
          updatedAtMs: 1_763_000_000_000,
        },
        {
          id: 'host-vnc-mac',
          name: 'Build Mac Studio',
          address: '10.28.40.25',
          port: 5900,
          protocol: 'vnc',
          folder: 'DMZ Folder',
          osLabel: 'macOS',
          domain: '',
          username: 'builder',
          password: '',
          privateKeyPem: '',
          jumpHostId: DIRECT_NO_JUMP_OVERRIDE,
          credentialId: null,
          isJumpHost: false,
          isFavorite: false,
          accentTint: 'teal',
          updatedAtMs: 1_763_000_000_000,
        },
      ],
      credentials: [
        {
          id: 'cred-ops-root',
          label: 'Ops Domain Admin',
          domain: 'CORP',
          username: 'adminit',
          password: 'SuperSecretPassword!',
          privateKeyPem: '',
          notes: 'Synced from Mobile',
          updatedAtMs: 1_763_000_000_000,
        },
      ],
      totp: [
        {
          id: 'totp-sha256-8',
          label: 'ops@jaladesk.io',
          issuer: 'JalaDesk Prod',
          secretBase32: 'JBSWY3DPEHPK3PXP',
          algorithm: 'SHA256',
          digits: 8,
          periodSeconds: 60,
          updatedAtMs: 1_763_000_000_000,
        },
      ],
      snippets: [],
      tombstones: {},
    };

    remoteVaultBlob = await VaultCloudSyncCrypto.sealAsync({
      payload: mobilePayload,
      passphrase: mobilePassphrase,
    });
    const parsedEnvelope = JSON.parse(remoteVaultBlob) as Record<string, unknown>;
    assert.equal(parsedEnvelope.schema, JDESK_SYNC_SCHEMA_ID);

    // Initialize Desktop stores & library
    const library = new DocumentLibrary();
    const docSummary = await library.create(join(dir, 'cloud.rwdoc'), 'Cloud Workspace', 'DesktopVaultPass99!', 'workspace');
    const totpStore = await DesktopTotpVaultStore.open(dir);
    const upsertedGateways: string[] = [];

    const cloudSync = new DesktopCloudSyncService({
      userDataDir: dir,
      openExternal: () => {},
      vaultBridge: {
        exportLocalPayload: (tombstones) => {
          const docs = library.privateDocuments().map((d) => ({ doc: d.doc as any }));
          return buildDesktopVaultSyncPayload({
            documents: docs,
            totpItems: totpStore.exportCloudSyncItems() as unknown as Record<string, unknown>[],
            tombstones: { ...totpStore.getTombstones(), ...tombstones },
          });
        },
        applySyncedPayload: async (payload) => {
          await totpStore.replaceFromCloudSync(payload.totp as any[], payload.tombstones);
          applyMobileSyncPayloadToLibrary({
            library: library as any,
            docHandle: docSummary.id,
            payload,
            onGatewayUpsert: (gw) => upsertedGateways.push(gw.alias),
          });
        },
      },
    });

    const summary = await cloudSync.executeSync(
      {
        provider: 'webdav',
        webdavUrl,
        webdavUsername: 'ops',
        webdavPassword: 'pw',
        useCustomPassphrase: true,
        syncPassphrase: mobilePassphrase,
      },
      'smartMerge',
    );

    assert.equal(summary.connectionCount, 2);
    assert.equal(summary.gatewayCount, 1);
    assert.equal(summary.credentialCount, 1);
    assert.equal(summary.totpCount, 1);
    assert.deepEqual(upsertedGateways, ['SG Prod Bastion']);

    // Verify per-connection Jump Host inside unconfigured folder mapped Mobile gateway id -> Desktop alias!
    const syncedDoc = library.privateDocument(docSummary.id).doc;
    assert.equal(syncedDoc.schemaVersion, 2);
    const billingNode = Object.values(syncedDoc.objects).find((o) => o.name === 'Core Billing RDP')!;
    assert.ok(billingNode);
    assert.equal(billingNode.props.username, 'CORP\\bright');
    const billingRoute = resolveDocumentNodeJumpRoute(syncedDoc as any, billingNode.id);
    assert.equal(billingRoute.jumpHost, 'SG Prod Bastion');
    assert.equal(billingRoute.source, 'connection');

    // Verify explicit __direct__ override inside Jump-configured DMZ Folder survived!
    const macNode = Object.values(syncedDoc.objects).find((o) => o.name === 'Build Mac Studio')!;
    assert.ok(macNode);
    const macRoute = resolveDocumentNodeJumpRoute(syncedDoc as any, macNode.id);
    assert.equal(macRoute.jumpHost, '');
    assert.equal(macRoute.source, 'connection-direct');

    // Add a Desktop-authored gateway + SSH host referencing its alias, pushForce, and verify Mobile jumpHostId == gateway.id in both directions!
    const desktopGw = library.add(docSummary.id, {
      parentId: null,
      type: 'connection',
      name: 'Jakarta Edge Jump',
      props: { protocol: 'rdp', host: '198.51.100.44', port: 2222, username: 'jumpuser', clipboardToRemote: false, clipboardFromRemote: false, notes: '[Plugin: Secure Gateway]' },
    });
    library.add(docSummary.id, {
      parentId: null,
      type: 'connection',
      name: 'Jakarta App Node',
      props: { protocol: 'rdp', host: '10.99.0.15', port: 22, username: 'ubuntu', clipboardToRemote: false, clipboardFromRemote: false, notes: '[Plugin: Terminal | jump=Jakarta Edge Jump]' },
    });
    await cloudSync.executeSync(undefined, 'pushForce');
    const reopenedForMobile = await VaultCloudSyncCrypto.openAsync({
      rawEnvelopeJson: remoteVaultBlob,
      passphrase: mobilePassphrase,
    });
    const exportedHosts = reopenedForMobile.hosts as Record<string, unknown>[];
    const exportedFolders = reopenedForMobile.folders as Record<string, unknown>[];
    assert.ok(exportedHosts.some((h) => h.id === 'host_gw_uuid_99' && h.name === 'SG Prod Bastion' && h.isJumpHost === true));
    assert.equal(exportedHosts.find((h) => h.name === 'Core Billing RDP')?.jumpHostId, 'host_gw_uuid_99');
    assert.equal(exportedFolders.find((f) => f.name === 'DMZ Folder')?.jumpHostId, 'host_gw_uuid_99');
    assert.equal(exportedHosts.find((h) => h.name === 'Jakarta App Node')?.jumpHostId, desktopGw.objectId);

    // Verify RFC 6238 SHA256 8-digit 60s TOTP token synced into DesktopTotpVaultStore
    const liveTokens = totpStore.listWithCodes(1_763_000_010_000);
    assert.equal(liveTokens.length, 1);
    assert.equal(liveTokens[0]!.issuer, 'JalaDesk Prod');
    assert.equal(liveTokens[0]!.algorithm, 'SHA256');
    assert.equal(liveTokens[0]!.digits, 8);
    assert.equal(liveTokens[0]!.period, 60);
    assert.equal(liveTokens[0]!.code.length, 8);

    // Verify .jvault encrypted backup export & import + AppLockPinManager integration
    const backupJson = await cloudSync.exportJvault('BackupVaultPass!2026');
    assert.ok(backupJson.includes(JDESK_SYNC_SCHEMA_ID));

    const pinManager = await AppLockPinManager.open(dir);
    await pinManager.setPin('246810');
    pinManager.lockNow();
    assert.equal(pinManager.getState().isLocked, true);
    const unlocked = await pinManager.verifyPin('246810');
    assert.equal(unlocked.verified, true);
    assert.equal(pinManager.getState().isLocked, false);

    library.closeAll();
  } finally {
    await new Promise<void>((resolve) => webdavServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Connection Action Sheet, 1-row segmented controls, separated footers, IPC bridges, and English User Guide are wired', async () => {
  const sections = buildConnectionActionSections({
    key: 'o:doc1:conn1',
    name: 'Prod Bastion Target',
    protocol: 'RDP',
    pluginType: 'Remote Desktop',
    host: '10.28.37.14',
    port: 3389,
    username: 'bright',
    jumpHost: 'pln-jump',
    isFavorite: true,
  });
  assert.equal(sections.length, 3);
  assert.deepEqual(
    sections[0]!.items.map((i) => i.id),
    ['connect-primary', 'launch-ssh', 'launch-sftp', 'launch-port-forward'],
  );
  assert.equal(sections[1]!.items[0]!.id, 'toggle-favorite');
  assert.equal(sections[1]!.items[0]!.active, true);
  assert.equal(sections[2]!.separatedDanger, true);
  assert.equal(sections[2]!.items.length, 1);
  assert.equal(sections[2]!.items[0]!.id, 'delete-connection');
  assert.equal(sections[2]!.items[0]!.destructive, true);

  const [html, css, preload, mainTs, rendererTs] = await Promise.all([
    readDesktopFile('index.html'),
    readDesktopFile('style.css'),
    readDesktopFile('preload.cjs'),
    readDesktopFile('main.ts'),
    readDesktopFile('renderer.ts'),
  ]);

  for (const id of [
    'cloud-sync-btn',
    'vault-2fa-btn',
    'user-guide-btn',
    'lock-workspace-btn',
    'conn-actions-btn',
    'conn-action-sheet',
    'rdp-scale-segmented',
    'p-proto-segmented',
    'p-ssh-auth-segmented',
    'p-vnc-mode-segmented',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html contains #${id}`);
  }

  // 1-row flex-wrap:nowrap + flex:1 1 0 segmented bar rules and separated modal footers in style.css
  assert.match(css, /\.segmented-bar,\.jala-segmented-bar\{[^}]*display:flex;flex-wrap:nowrap/);
  assert.match(css, /\.segmented-item,\.jala-segment-pill\{[^}]*flex:1 1 0/);
  assert.match(css, /\.jala-studio-footer\{[^}]*border-top:1px solid var\(--line\)/);
  assert.match(css, /\.dialog-actions\{[^}]*border-top:1px solid var\(--line\)/);

  // Preload & Main IPC channels wired end-to-end
  for (const channel of [
    'cloudSync:getState',
    'cloudSync:saveDraft',
    'cloudSync:signInGoogle',
    'cloudSync:executeSync',
    'cloudSync:exportJvault',
    'cloudSync:importJvault',
    'totpVault:list',
    'totpVault:add',
    'totpVault:remove',
    'appLock:getStatus',
    'appLock:verifyPin',
    'appLock:setPin',
    'appLock:lockNow',
  ]) {
    assert.ok(preload.includes(channel), `preload.cjs exposes ${channel}`);
    assert.ok(mainTs.includes(channel), `main.ts handles ${channel}`);
  }
  assert.ok(rendererTs.includes('createCloudSyncStudio'));
  assert.ok(rendererTs.includes('createVault2faStudio'));
  assert.ok(rendererTs.includes('createAppLockPinUi'));
  assert.ok(rendererTs.includes('createUserGuideModal'));

  // Built-in User Guide is 100% English and covers all 7 core topics
  assert.equal(JALADESK_GUIDE_TOPICS.length, 7);
  const allGuideText = JSON.stringify(JALADESK_GUIDE_TOPICS);
  for (const forbiddenIndo of ['Pengaturan', 'Koneksi', 'Sandinya', 'Simpan Otomatis', 'Bahasa Indonesia']) {
    assert.equal(allGuideText.includes(forbiddenIndo), false, `User Guide has zero Indonesian word: ${forbiddenIndo}`);
  }
});

test('Desktop Web Bridge IPC, UI elements, lifecycle cleanup, and embedded startGatewayServer auto-pairing contract', async () => {
  const [html, css, preload, mainTs, rendererTs] = await Promise.all([
    readDesktopFile('index.html'),
    readDesktopFile('style.css'),
    readDesktopFile('preload.cjs'),
    readDesktopFile('main.ts'),
    readDesktopFile('renderer.ts'),
  ]);

  // 1. Preload & Main IPC channels + sender guard + shutdown lifecycle hooks
  assert.ok(preload.includes("contextBridge.exposeInMainWorld('webBridge'"), 'preload exposes window.webBridge');
  for (const channel of [
    'webBridge:status',
    'webBridge:start',
    'webBridge:stop',
    'webBridge:openWebApp',
    'webBridge:copyCode',
    'webBridge:rotateCode',
  ]) {
    assert.ok(preload.includes(channel), `preload.cjs exposes ${channel}`);
    assert.ok(mainTs.includes(channel), `main.ts handles ${channel}`);
  }
  assert.ok(mainTs.includes('startGatewayServer'), 'main.ts imports and invokes startGatewayServer');
  assert.ok(mainTs.includes("'https://ribato22.github.io'"), 'main.ts allows GitHub Pages origin via CORS');
  assert.ok(
    mainTs.includes('https://ribato22.github.io/jaladesk/app/') && mainTs.includes('#gateway='),
    'main.ts opens auto-paired JalaDesk Web URL fragment',
  );
  assert.ok(mainTs.includes("app.on('before-quit'") && mainTs.includes('stopWebBridge()'), 'main.ts stops Web Bridge on before-quit');
  assert.match(mainTs, /app\.on\('window-all-closed'[^]*stopWebBridge\(\)/, 'main.ts stops Web Bridge on window-all-closed');

  // 2. Desktop UI elements, classes & renderer wiring
  for (const id of [
    'tb-web-bridge',
    'web-bridge-dialog',
    'web-bridge-status-pill',
    'web-bridge-toggle-btn',
    'web-bridge-pairing-code',
    'web-bridge-copy-btn',
    'web-bridge-open-web-btn',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html contains #${id}`);
  }
  assert.ok(css.includes('#tb-web-bridge[data-running=true]'), 'style.css styles active toolbar bridge pill');
  assert.ok(css.includes('.wb-gold-cta'), 'style.css styles gold auto-pair launch CTA');
  assert.ok(rendererTs.includes('createWebBridgeStudio') && rendererTs.includes('webBridgeApi.openWebApp'));

  // 3. Real embedded startGatewayServer lifecycle matching Desktop main.ts options
  const gw = await startGatewayServer({
    host: '127.0.0.1',
    port: 0,
    corsOrigins: ['https://ribato22.github.io', 'http://127.0.0.1:8443', 'http://localhost:8443'],
  });
  try {
    assert.equal(gw.running, true);
    assert.match(gw.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(gw.pairingCode ?? '', /^\d{6}$/);
    assert.match(gw.token, /^[0-9a-f]{64}$/);
    assert.equal(gw.activeSessions, 0);

    // Verify auto-pair fragment roundtrip + CORS/PNA preflight + authenticated ticket issuance
    const launchUrl = `https://ribato22.github.io/jaladesk/app/#gateway=${gw.url}&token=${gw.token}`;
    const parsedFragment = new URLSearchParams(new URL(launchUrl).hash.slice(1));
    assert.equal(parsedFragment.get('gateway'), gw.url);
    assert.equal(parsedFragment.get('token'), gw.token);

    const preflight = await fetch(`${gw.url}/api/tickets`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ribato22.github.io',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://ribato22.github.io');
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

    const ticketRes = await fetch(`${gw.url}/api/tickets`, {
      method: 'POST',
      headers: {
        Origin: 'https://ribato22.github.io',
        Authorization: `Bearer ${gw.token}`,
      },
    });
    assert.equal(ticketRes.status, 200);
    const ticketBody = (await ticketRes.json()) as { ticket?: string; expiresInSec?: number };
    assert.ok(typeof ticketBody.ticket === 'string' && ticketBody.ticket.length >= 16);

    const rotated = gw.rotatePairingCode();
    assert.match(rotated.code, /^\d{6}$/);
    assert.equal(gw.pairingCode, rotated.code);
  } finally {
    await gw.stop();
    await gw.stop(); // idempotent teardown
  }
  assert.equal(gw.running, false);
  await assert.rejects(() => fetch(`${gw.url}/healthz`));
});
