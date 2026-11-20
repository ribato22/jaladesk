import {
  SealedBrowserVaultStore,
  VaultCoreError,
  calculateTotpTiming,
  computeVaultSecurityHealth,
  createEmptyVaultPayload,
  deriveGoogleAccountBoundPassphrase,
  evaluateTotpToken,
  fetchGoogleUserInfo,
  hasGoogleDriveAppDataScope,
  makeTombstoneKey,
  normalizeTotpSecretBase32,
  parseOpenSshConfig,
  parseOtpAuthUri,
  requestGoogleWebAccessToken,
  syncWithGithubGist,
  syncWithGoogleDriveAppData,
  syncWithWebDav,
  unlockOrSyncGoogleVault,
} from './vault-core.js';
import {
  GOOGLE_CLOUD_PROJECT_NUMBER,
  resolveGoogleWebOAuthClientId,
} from './web-oauth-config.js';
import {
  JalaGatewayClient,
  normalizeGatewayEndpoints,
  parseGatewayFragment,
} from './gateway-client.js';
import { WebVtTerminal } from './vt-terminal-web.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_PORTS = Object.freeze({
  rdp: 3389,
  vnc: 5900,
  ssh: 22,
  sftp: 22,
  hypervisor: 8006,
});

const GATEWAY_DEPLOY_TABS = Object.freeze({
  desktop: {
    label: 'Desktop Bridge',
    hint: '1-click inside JalaDesk.app -> Web Bridge, or start a local loopback bridge on http://127.0.0.1:8443.',
    snippet: `# 1-Click in JalaDesk Desktop:
# Open JalaDesk.app -> Toggle "Web Bridge" ON -> Click "Open Web App"
# Endpoint: http://127.0.0.1:8443 (auto-pairs via RAM-only #token)

# Or run from CLI:
npm run gateway -- --host 127.0.0.1 --port 8443`,
  },
  caddy: {
    label: 'Docker + Caddy',
    hint: 'Automatic Let\'s Encrypt TLS 1.3 HTTPS/WSS reverse proxy with isolated private gateway network.',
    snippet: `# Copy env template & set JALADESK_GATEWAY_DOMAIN=gw.example.com
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/caddy/docker-compose.caddy.yml up -d`,
  },
  cloudflare: {
    label: 'Cloudflare Tunnel',
    hint: 'Zero open inbound firewall ports — outbound cloudflared tunnel bridges straight to jaladesk-gateway:8443.',
    snippet: `# Set CLOUDFLARE_TUNNEL_TOKEN in deploy/.env (Zero Trust -> Tunnels)
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/cloudflare/docker-compose.cloudflared.yml up -d`,
  },
  cloud: {
    label: 'Fly.io / Railway',
    hint: '1-click managed HTTPS/WSS cloud deployment with /healthz checks and automatic TLS.',
    snippet: `# Deploy to Fly.io (fly.gateway.toml):
fly launch --copy-config --config fly.gateway.toml
fly deploy -c fly.gateway.toml

# Or deploy on Railway using railway.gateway.json:
railway up`,
  },
});

const PRIMARY_ADD_LABELS = Object.freeze({
  connections: 'Add Connection',
  totp: 'Add 2FA Token',
  credentials: 'Add Credential',
  sync: 'Export .jvault',
  gateway: 'Connect Live Session',
});

const PROVIDER_LABELS = Object.freeze({
  googleDrive: 'Google Drive',
  githubGist: 'GitHub Gist',
  webdav: 'WebDAV',
});

const LOCAL_GATEWAY_DEFAULT_URL = 'http://127.0.0.1:8443';
const REMOTE_GATEWAY_DEFAULT_URL = 'wss://gateway.local:8443';
const LOCAL_GATEWAY_PROBE_TIMEOUT_MS = 1200;
const UNDO_DELETE_WINDOW_MS = 6000;
const CLOUD_AUTO_SYNC_DEBOUNCE_MS = 1500;
const CLOUD_DELETE_SYNC_DELAY_MS = 6500;

const GATEWAY_QUICK_COMMANDS = Object.freeze({
  npm: 'npm run gateway -- --host 127.0.0.1 --port 8443',
  docker: 'docker compose -f docker-compose.gateway.yml up -d',
});

const store = new SealedBrowserVaultStore();

/** All sensitive credentials, passphrases, and tokens live ONLY in RAM and are zeroed on lock(). */
const ramSecrets = {
  unlockedPassphrase: '',
  gdriveToken: '',
  gdriveScope: '',
  gdriveEmail: '',
  gdriveDisplayName: '',
  gistToken: '',
  webdavPassword: '',
  customSyncPassphrase: '',
  gatewayToken: '',
  gatewayPairing: '',
  gatewayRuntimePassword: '',
  gatewayRuntimeKey: '',
};

const appState = {
  activeView: 'connections',
  searchQuery: '',
  folderFilter: 'all',
  credKindFilter: 'all',
  onboardTab: 'create',
  onboardAutolock: '300',
  onboardCloudProvider: 'googleDrive',
  onboardGdriveCustomPass: false,
  onboardGdrivePendingEmail: '',
  returningPassphraseOverride: false,
  returningGdrivePendingEmail: '',
  gdriveAuthInFlight: false,
  lockOnHidden: false,
  importMode: 'merge',
  lockImportFileText: '',
  lockImportFileName: '',
  syncImportFileText: '',
  syncImportFileName: '',
  syncProvider: 'googleDrive',
  useCustomPassphrase: false,
  revealedCredIds: new Set(),
  gatewayAuthMode: 'pairing',
  gatewayViewOnly: false,
  gatewayTargetHostId: '__demo__',
  gatewayClient: null,
  gatewayPreviewActive: false,
  gatewayPreviewState: null,
  gatewayScaleMode: 'fit',
  gatewayPane: 'desktop',
  gatewaySetupVisible: true,
  gatewaySessionProtocol: '',
  gatewayTargetLabel: '',
  gatewaySftpPath: '/',
  gatewaySshBuffer: '',
  gatewaySshCols: 100,
  gatewaySshRows: 30,
  sshTerminal: null,
  gatewayFragmentScrubbed: false,
  gatewayFragmentUrl: '',
  gatewaySessions: [],
  activeGatewaySessionId: null,
  deployTab: 'desktop',
  vaultHealthDetailsOpen: false,
  cmdkQuery: '',
  cmdkItems: [],
  cmdkActiveIndex: 0,
  sshImportParsed: null,
  activeModalId: null,
  lastModalTriggerEl: null,
  pendingConfirmAction: null,
  pendingUndo: null,
  gatewayProbeSeq: 0,
  gatewayLocalReachable: null,
  gatewayCredPromptHostId: '',
  totpRafId: 0,
  totpLastTickMs: 0,
  totpCardRefs: new Map(),
  clipboardClearTimer: null,
  lastCopiedSecret: '',
  syncInFlight: false,
  cloudAutoSyncTimer: null,
  cloudAutoSyncPending: false,
  cloudAutoSyncState: 'idle',
  cloudAutoSyncQueuedAgain: false,
  cloudDirtyBeforePendingDelete: false,
};

function byId(id) {
  return document.getElementById(id);
}

function generateId(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function createSvgIcon(paths, className = 'icon-sm') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const spec of paths) {
    const child = document.createElementNS(SVG_NS, spec.tag);
    for (const [attr, val] of Object.entries(spec.attrs)) {
      child.setAttribute(attr, String(val));
    }
    svg.appendChild(child);
  }
  return svg;
}

function showToast(message, tone = 'default') {
  const region = byId('jala-toast-region');
  if (!region) return;
  const item = el('div', `toast-item${tone === 'ok' ? ' toast-item-ok' : tone === 'danger' ? ' toast-item-danger' : ''}`, message);
  region.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 3400);
}

function scrubSnapshotSecrets(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of ['password', 'privateKeyPem', 'secretBase32', 'secret', 'passphrase', 'token']) {
    if (Object.hasOwn(obj, key)) {
      obj[key] = '';
    }
  }
}

function clearPendingUndo() {
  const pending = appState.pendingUndo;
  if (!pending) return;
  if (pending.timerId) {
    clearTimeout(pending.timerId);
  }
  if (pending.toastEl && pending.toastEl.isConnected) {
    pending.toastEl.remove();
  }
  scrubSnapshotSecrets(pending.item);
  pending.item = null;
  pending.detachedChildren = null;
  pending.unlinkedHosts = null;
  appState.pendingUndo = null;
}

function showUndoToast(message, onUndo) {
  const region = byId('jala-toast-region');
  if (!region) return null;

  const toast = el('div', 'toast-item toast-item-undo');
  toast.setAttribute('role', 'status');

  const row = el('div', 'toast-undo-row');
  row.appendChild(el('span', 'toast-undo-message', message));

  const undoBtn = el('button', 'btn-toast-undo', 'Undo');
  undoBtn.id = 'btn-toast-undo';
  undoBtn.type = 'button';
  undoBtn.addEventListener('click', () => {
    onUndo();
  });
  row.appendChild(undoBtn);
  toast.appendChild(row);

  const track = el('div', 'toast-undo-track');
  track.setAttribute('aria-hidden', 'true');
  track.appendChild(el('div', 'toast-undo-bar'));
  toast.appendChild(track);

  region.appendChild(toast);
  return toast;
}

function registerPendingUndo(snapshot) {
  clearPendingUndo();
  const toastEl = showUndoToast(snapshot.toastMessage, () => {
    undoPendingDelete();
  });
  const timerId = setTimeout(() => {
    clearPendingUndo();
  }, UNDO_DELETE_WINDOW_MS);

  appState.pendingUndo = {
    ...snapshot,
    timerId,
    toastEl,
  };
}

async function undoPendingDelete() {
  const pending = appState.pendingUndo;
  if (!pending || !store.isUnlocked()) {
    clearPendingUndo();
    return;
  }

  // Take ownership of snapshot before clearing timers/DOM
  const snapshot = {
    kind: pending.kind,
    item: pending.item ? { ...pending.item } : null,
    tombstoneKey: pending.tombstoneKey,
    previousTombstoneValue: pending.previousTombstoneValue,
    detachedChildren: Array.isArray(pending.detachedChildren) ? [...pending.detachedChildren] : [],
    unlinkedHosts: Array.isArray(pending.unlinkedHosts) ? [...pending.unlinkedHosts] : [],
    restoreLabel: pending.restoreLabel,
  };
  clearPendingUndo();

  const payload = getPayloadSafe();
  if (!payload || !snapshot.item) return;

  const now = Date.now();
  const restoredItem = { ...snapshot.item, updatedAtMs: now };

  if (snapshot.kind === 'host') {
    if (!payload.hosts.some((h) => h.id === restoredItem.id)) {
      payload.hosts.push(restoredItem);
    }
    if (snapshot.detachedChildren.length > 0) {
      const childMap = new Map(snapshot.detachedChildren.map((c) => [c.id, c.prevJumpHostId]));
      payload.hosts = payload.hosts.map((h) =>
        childMap.has(h.id) ? { ...h, jumpHostId: childMap.get(h.id), updatedAtMs: now } : h,
      );
    }
  } else if (snapshot.kind === 'totp') {
    if (!payload.totp.some((t) => t.id === restoredItem.id)) {
      payload.totp.push(restoredItem);
    }
  } else if (snapshot.kind === 'credential') {
    if (!payload.credentials.some((c) => c.id === restoredItem.id)) {
      payload.credentials.push(restoredItem);
    }
    if (snapshot.unlinkedHosts.length > 0) {
      const hostMap = new Map(snapshot.unlinkedHosts.map((h) => [h.id, h.prevCredentialId]));
      payload.hosts = payload.hosts.map((h) =>
        hostMap.has(h.id) ? { ...h, credentialId: hostMap.get(h.id), updatedAtMs: now } : h,
      );
    }
  }

  if (payload.tombstones && snapshot.tombstoneKey) {
    if (snapshot.previousTombstoneValue !== undefined) {
      payload.tombstones[snapshot.tombstoneKey] = snapshot.previousTombstoneValue;
    } else {
      delete payload.tombstones[snapshot.tombstoneKey];
    }
  }
  payload.updatedAtMs = now;

  const hadPriorDirty = appState.cloudDirtyBeforePendingDelete;
  appState.cloudDirtyBeforePendingDelete = false;
  cancelCloudAutoSync();
  await saveVaultPayload(payload, { skipAutoSync: !hadPriorDirty, autoSyncDelayMs: CLOUD_AUTO_SYNC_DEBOUNCE_MS });
  renderAllViews();
  showToast(`${snapshot.restoreLabel} restored.`, 'ok');
}

function hasActiveCloudSessionInRam() {
  if (!store.isUnlocked()) return false;
  const provider = appState.syncProvider;
  if (appState.useCustomPassphrase) {
    const customPass = (byId('sync-custom-passphrase')?.value || ramSecrets.customSyncPassphrase || '').trim();
    if (customPass.length < 4) return false;
  }
  if (provider === 'googleDrive') {
    const token = (ramSecrets.gdriveToken || byId('sync-gdrive-token')?.value || '').trim();
    if (!token) return false;
    if (!appState.useCustomPassphrase) {
      const email = (
        ramSecrets.gdriveEmail ||
        store.getUiPrefs().googleAccountEmail ||
        (byId('sync-gdrive-email')?.value || '')
      ).trim();
      if (!email && ramSecrets.unlockedPassphrase.length < 4) return false;
    }
    return true;
  }
  if (provider === 'githubGist') {
    const token = (ramSecrets.gistToken || byId('sync-gist-token')?.value || '').trim();
    return token.length > 0 && ramSecrets.unlockedPassphrase.length >= 4;
  }
  if (provider === 'webdav') {
    const url = (byId('sync-webdav-url')?.value || store.getUiPrefs().webdavUrl || '').trim();
    const pass = byId('sync-webdav-pass')?.value || ramSecrets.webdavPassword || '';
    return url.length > 0 && pass.length > 0 && ramSecrets.unlockedPassphrase.length >= 4;
  }
  return false;
}

function cancelCloudAutoSync() {
  if (appState.cloudAutoSyncTimer !== null) {
    clearTimeout(appState.cloudAutoSyncTimer);
    appState.cloudAutoSyncTimer = null;
  }
  appState.cloudAutoSyncPending = false;
  appState.cloudAutoSyncQueuedAgain = false;
  if (appState.cloudAutoSyncState === 'pending') {
    appState.cloudAutoSyncState = 'idle';
  }
  updateSecurityPill();
}

function scheduleCloudAutoSync(delayMs = CLOUD_AUTO_SYNC_DEBOUNCE_MS) {
  if (!hasActiveCloudSessionInRam()) return false;
  if (appState.cloudAutoSyncTimer !== null) {
    clearTimeout(appState.cloudAutoSyncTimer);
    appState.cloudAutoSyncTimer = null;
  }
  appState.cloudAutoSyncPending = true;
  if (appState.syncInFlight) {
    appState.cloudAutoSyncQueuedAgain = true;
  } else {
    appState.cloudAutoSyncState = 'pending';
    updateSecurityPill();
  }
  const safeDelay = Math.max(0, Number.isFinite(delayMs) ? Math.trunc(delayMs) : CLOUD_AUTO_SYNC_DEBOUNCE_MS);
  appState.cloudAutoSyncTimer = setTimeout(() => {
    appState.cloudAutoSyncTimer = null;
    flushCloudAutoSync({ background: true });
  }, safeDelay);
  return true;
}

async function flushCloudAutoSync(options = {}) {
  if (appState.cloudAutoSyncTimer !== null) {
    clearTimeout(appState.cloudAutoSyncTimer);
    appState.cloudAutoSyncTimer = null;
  }
  if (!hasActiveCloudSessionInRam()) {
    appState.cloudAutoSyncPending = false;
    if (appState.cloudAutoSyncState === 'pending') {
      appState.cloudAutoSyncState = 'idle';
    }
    updateSecurityPill();
    return;
  }
  if (appState.syncInFlight) {
    appState.cloudAutoSyncQueuedAgain = true;
    return;
  }
  appState.cloudAutoSyncPending = false;
  appState.cloudDirtyBeforePendingDelete = false;
  await runCloudSync('smartMerge', { background: options.background !== false });
}

async function saveVaultPayload(payload, options = {}) {
  const saved = await store.savePayload(payload);
  if (!options.skipAutoSync) {
    if (options.isDelete) {
      appState.cloudDirtyBeforePendingDelete = Boolean(appState.cloudAutoSyncPending || appState.syncInFlight);
    } else {
      appState.cloudDirtyBeforePendingDelete = false;
    }
    const delayMs =
      typeof options.autoSyncDelayMs === 'number' && Number.isFinite(options.autoSyncDelayMs)
        ? options.autoSyncDelayMs
        : CLOUD_AUTO_SYNC_DEBOUNCE_MS;
    scheduleCloudAutoSync(delayMs);
  }
  return saved;
}

function setAlert(id, message) {
  const node = byId(id);
  if (!node) return;
  if (!message) {
    node.textContent = '';
    node.hidden = true;
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

function setSegmentedValue(container, attrName, value) {
  if (!container) return;
  const buttons = container.querySelectorAll('.seg-btn');
  for (const btn of buttons) {
    const match = btn.getAttribute(attrName) === String(value);
    btn.classList.toggle('is-active', match);
    if (btn.getAttribute('role') === 'tab') {
      btn.setAttribute('aria-selected', match ? 'true' : 'false');
    } else if (btn.getAttribute('role') === 'radio') {
      btn.setAttribute('aria-checked', match ? 'true' : 'false');
    }
  }
}

function getSegmentedValue(container, attrName, fallback) {
  if (!container) return fallback;
  const active = container.querySelector('.seg-btn.is-active');
  return active ? active.getAttribute(attrName) || fallback : fallback;
}

function setSwitchState(button, checked) {
  if (!button) return;
  button.setAttribute('aria-checked', checked ? 'true' : 'false');
}

function getSwitchState(button) {
  return Boolean(button && button.getAttribute('aria-checked') === 'true');
}

async function copyText(text, label, clearAfter30s = false) {
  if (!text) return;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.className = 'sr-only';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (clearAfter30s) {
      appState.lastCopiedSecret = text;
      if (appState.clipboardClearTimer) {
        clearTimeout(appState.clipboardClearTimer);
      }
      appState.clipboardClearTimer = setTimeout(() => {
        if (document.hasFocus() && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText('').catch(() => {});
        }
        appState.lastCopiedSecret = '';
        appState.clipboardClearTimer = null;
      }, 30_000);
      showToast(`${label} copied (clears clipboard in 30s)`, 'ok');
    } else {
      showToast(`${label} copied`, 'ok');
    }
  } catch {
    showToast('Clipboard write blocked by browser permissions.', 'danger');
  }
}

function getPayloadSafe() {
  if (!store.isUnlocked()) return null;
  try {
    return store.getPayload();
  } catch {
    return null;
  }
}

function resolveCredentialKind(cred) {
  if (cred && typeof cred.kind === 'string' && cred.kind.trim()) {
    return cred.kind.trim();
  }
  if (cred && typeof cred.privateKeyPem === 'string' && cred.privateKeyPem.trim().length > 0) {
    return 'sshKey';
  }
  if (cred && typeof cred.domain === 'string' && cred.domain.trim().length > 0) {
    return 'domain';
  }
  return 'password';
}

function buildSshOrEndpointCommand(host, allHosts, allCreds) {
  const proto = String(host.protocol || 'rdp').toLowerCase();
  const address = String(host.address || '').trim();
  const port = Number(host.port) || DEFAULT_PORTS[proto] || 22;
  const linkedCred = host.credentialId
    ? allCreds.find((c) => c.id === host.credentialId)
    : null;
  const user = String(host.username || (linkedCred && linkedCred.username) || '').trim();

  if (proto === 'ssh' || proto === 'sftp') {
    const bin = proto === 'sftp' ? 'sftp' : 'ssh';
    const parts = [bin];
    if (host.jumpHostId) {
      const bastion = allHosts.find((h) => h.id === host.jumpHostId);
      if (bastion && bastion.address) {
        const bUser = String(bastion.username || '').trim();
        const bPort = Number(bastion.port) || 22;
        const bSpec = `${bUser ? `${bUser}@` : ''}${bastion.address}${bPort !== 22 ? `:${bPort}` : ''}`;
        parts.push('-J', bSpec);
      }
    }
    if (proto === 'sftp') {
      if (port !== 22) parts.push('-P', String(port));
    } else if (port !== 22) {
      parts.push('-p', String(port));
    }
    parts.push(`${user ? `${user}@` : ''}${address}`);
    return { label: proto === 'sftp' ? 'SFTP command' : 'SSH command', value: parts.join(' '), buttonText: proto === 'sftp' ? 'Copy SFTP' : 'Copy SSH' };
  }

  const endpoint = `${user ? `${user}@` : ''}${address}:${port}`;
  return { label: 'Endpoint', value: endpoint, buttonText: 'Copy Endpoint' };
}

/* ==========================================================================
   URL Fragment Token Scrubbing (#token= / Google OAuth popup callback)
   ========================================================================== */

function inspectUrlHash(isLiveChange = false) {
  const rawHash = window.location.hash || '';
  if (!rawHash || rawHash === '#') return;
  const cleaned = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;

  if (cleaned.includes('access_token=')) {
    const params = new URLSearchParams(cleaned);
    const accessToken = params.get('access_token') || '';
    const scope = params.get('scope') || '';
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // Ignore restricted history state
    }
    if (accessToken && window.opener && window.opener !== window) {
      try {
        window.opener.postMessage({ type: 'jaladesk-gdrive-oauth', accessToken, scope }, window.location.origin);
        window.close();
        return;
      } catch {
        // Fallback to in-tab memory capture
      }
    }
    if (accessToken) {
      ramSecrets.gdriveToken = accessToken;
      ramSecrets.gdriveScope = scope;
      appState.syncProvider = 'googleDrive';
      appState.activeView = 'sync';
      if (isLiveChange && store.isUnlocked()) {
        renderGoogleDriveStudioState();
        switchWorkspaceView('sync', true);
      }
    }
    return;
  }

  if (cleaned === 'gateway') {
    appState.activeView = 'gateway';
    if (isLiveChange && store.isUnlocked()) {
      switchWorkspaceView('gateway', true);
    }
    return;
  }

  const parsedGw = parseGatewayFragment(rawHash);
  if (parsedGw) {
    if (parsedGw.gatewayUrl) {
      appState.gatewayFragmentUrl = parsedGw.gatewayUrl;
      const urlInput = byId('gateway-ws-url');
      if (urlInput) {
        urlInput.value = parsedGw.gatewayUrl;
        syncGatewayUrlPresetsUi();
      }
    }
    if (parsedGw.token) {
      ramSecrets.gatewayToken = parsedGw.token;
      appState.gatewayAuthMode = 'token';
      appState.gatewayFragmentScrubbed = true;
    }
    appState.activeView = 'gateway';
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // Ignore restricted history state
    }
    if (isLiveChange && store.isUnlocked()) {
      if (parsedGw.gatewayUrl) {
        store.saveUiPrefs({ gatewayUrl: parsedGw.gatewayUrl });
      }
      if (parsedGw.token) {
        applyAutoPairedGatewayUi({ silentToast: false });
      }
      switchWorkspaceView('gateway', true, { skipGatewayProbe: Boolean(parsedGw.token) });
      appendGatewayLog(
        parsedGw.gatewayUrl
          ? `Auto-paired with Web Gateway (${parsedGw.gatewayUrl}); token stored in RAM only and scrubbed from URL.`
          : 'Captured ephemeral #token= from URL fragment into RAM and scrubbed browser history.',
        'ok',
      );
    }
  }
}

/* ==========================================================================
   Zero-Plaintext Lock Cleanup & Auto-Lock Management
   ========================================================================== */

function zeroSensitiveInputsAndDom(options = {}) {
  const preserveToken = Boolean(options.preservePendingGatewayToken);
  const pendingToken = preserveToken ? ramSecrets.gatewayToken : '';
  const pendingScrubbed = preserveToken ? appState.gatewayFragmentScrubbed : false;
  const pendingGatewayUrl = preserveToken ? appState.gatewayFragmentUrl : '';

  ramSecrets.unlockedPassphrase = '';
  ramSecrets.gdriveToken = '';
  ramSecrets.gdriveScope = '';
  ramSecrets.gdriveEmail = '';
  ramSecrets.gdriveDisplayName = '';
  ramSecrets.gistToken = '';
  ramSecrets.webdavPassword = '';
  ramSecrets.customSyncPassphrase = '';
  ramSecrets.gatewayToken = pendingToken;
  ramSecrets.gatewayPairing = '';
  ramSecrets.gatewayRuntimePassword = '';
  ramSecrets.gatewayRuntimeKey = '';
  clearPendingUndo();
  cancelCloudAutoSync();
  appState.cloudAutoSyncState = 'idle';
  appState.cloudDirtyBeforePendingDelete = false;
  appState.pendingConfirmAction = null;
  appState.gatewayProbeSeq += 1;
  appState.gatewayLocalReachable = null;
  appState.gatewayCredPromptHostId = '';
  appState.onboardGdrivePendingEmail = '';
  appState.onboardGdriveCustomPass = false;
  appState.returningPassphraseOverride = false;
  appState.returningGdrivePendingEmail = '';
  appState.gdriveAuthInFlight = false;
  appState.revealedCredIds.clear();
  appState.lockImportFileText = '';
  appState.syncImportFileText = '';
  appState.lastCopiedSecret = '';
  appState.searchQuery = '';
  appState.gatewayTargetHostId = '__demo__';
  appState.gatewayFragmentScrubbed = pendingScrubbed;
  appState.gatewayFragmentUrl = pendingGatewayUrl;
  appState.vaultHealthDetailsOpen = false;
  appState.cmdkQuery = '';
  appState.cmdkItems = [];
  appState.cmdkActiveIndex = 0;
  appState.sshImportParsed = null;
  if (appState.clipboardClearTimer) {
    clearTimeout(appState.clipboardClearTimer);
    appState.clipboardClearTimer = null;
  }

  closeAllGatewaySessionTabs();

  const clearedInputIds = [
    'unlock-passphrase',
    'create-passphrase',
    'create-passphrase-confirm',
    'import-lock-passphrase',
    'onboard-gist-token',
    'onboard-webdav-pass',
    'onboard-gdrive-token',
    'onboard-gdrive-custom-passphrase',
    'onboard-cloud-passphrase',
    'sync-gdrive-token',
    'sync-gist-token',
    'sync-webdav-pass',
    'sync-custom-passphrase',
    'sync-import-passphrase',
    'new-vault-passphrase',
    'confirm-new-vault-passphrase',
    'gateway-pairing-code',
    'gateway-session-token',
    'gateway-runtime-password',
    'gateway-runtime-key',
    'global-search',
    'conn-id',
    'conn-name',
    'conn-address',
    'conn-username',
    'conn-folder',
    'conn-domain',
    'conn-password',
    'totp-id',
    'totp-uri-input',
    'totp-issuer',
    'totp-account',
    'totp-secret',
    'cred-id',
    'cred-label',
    'cred-username',
    'cred-domain',
    'cred-password',
    'cred-pem',
    'cred-notes',
    'cmdk-input',
    'ssh-import-textarea',
    'ssh-import-folder',
  ];
  for (const id of clearedInputIds) {
    const input = byId(id);
    if (input) input.value = '';
  }
  const connPort = byId('conn-port');
  if (connPort) connPort.value = '3389';

  for (const listId of [
    'connections-list',
    'totp-list',
    'credentials-list',
    'folder-filter-bar',
    'jala-toast-region',
    'cmdk-listbox',
    'ssh-import-preview-list',
    'vault-health-pills',
    'vault-health-findings',
    'sync-health-pills',
    'gateway-session-tabs',
  ]) {
    const list = byId(listId);
    if (list) list.replaceChildren();
  }
  const sshPreviewBox = byId('ssh-import-preview-box');
  if (sshPreviewBox) sshPreviewBox.hidden = true;
  const healthFindings = byId('vault-health-findings');
  if (healthFindings) healthFindings.hidden = true;
  const sessionTabsEl = byId('gateway-session-tabs');
  if (sessionTabsEl) sessionTabsEl.hidden = true;
  appState.totpCardRefs.clear();

  const selectDefaults = [
    ['gateway-host-select', 'Demo Session (Live Synthetic Desktop, SSH & SFTP)', '__demo__'],
    ['gateway-totp-select', 'No 2FA tokens', ''],
    ['conn-jump-host', 'Direct (No Jump Host)', ''],
    ['conn-credential', 'Inline / None', ''],
  ];
  for (const [selectId, defaultLabel, defaultValue] of selectDefaults) {
    const sel = byId(selectId);
    if (sel) {
      sel.replaceChildren();
      const opt = el('option', '', defaultLabel);
      opt.value = defaultValue;
      sel.appendChild(opt);
    }
  }

  for (const countId of ['nav-count-connections', 'nav-count-totp', 'nav-count-credentials']) {
    const node = byId(countId);
    if (node) node.textContent = '0';
  }
  const connSummary = byId('connections-summary');
  if (connSummary) connSummary.textContent = '0 hosts · 0 jump gateways';
  const totpSummary = byId('totp-summary');
  if (totpSummary) totpSummary.textContent = '0 active tokens · RFC 6238 WebCrypto';
  const credSummary = byId('credentials-summary');
  if (credSummary) credSummary.textContent = '0 credentials stored in encrypted enclave';
  const exportMeta = byId('export-summary-meta');
  if (exportMeta) exportMeta.textContent = 'Ready to seal';
  const syncMsg = byId('sync-status-message');
  if (syncMsg) syncMsg.textContent = 'No cloud sync run in this session. Local vault remains sealed in browser storage.';
  const previewBar = byId('totp-preview-bar');
  if (previewBar) previewBar.hidden = true;
  const previewCode = byId('totp-preview-code');
  if (previewCode) previewCode.textContent = '--- ---';
  setAlert('gateway-fragment-notice', '');
  for (const hiddenId of [
    'gateway-selected-target-banner',
    'gateway-local-probe-pill',
    'gateway-setup-guidance',
    'gateway-cred-prompt',
  ]) {
    const hNode = byId(hiddenId);
    if (hNode) hNode.hidden = true;
  }
  for (const calloutId of [
    'returning-gdrive-scope-callout',
    'onboard-gdrive-scope-callout',
    'onboard-gdrive-setup-note',
    'sync-gdrive-callout',
  ]) {
    const cNode = byId(calloutId);
    if (cNode) cNode.hidden = true;
  }
  setSwitchState(byId('onboard-gdrive-custom-pass-switch'), false);
  const onboardCustomWrap = byId('onboard-gdrive-custom-pass-wrap');
  if (onboardCustomWrap) onboardCustomWrap.hidden = true;

  const gwBadge = byId('gateway-target-badge');
  if (gwBadge) gwBadge.textContent = 'DEMO SESSION · SYNTHETIC';
  const gwModeBadge = byId('gateway-mode-badge');
  if (gwModeBadge) gwModeBadge.textContent = 'INTERACTIVE';
  const gwLog = byId('gateway-log');
  if (gwLog) {
    gwLog.replaceChildren();
    gwLog.appendChild(el('p', 'console-line', 'Ready. Select Demo Session or a Vault host and enter a 6-digit pairing code or session token.'));
  }
  resetGatewayLiveDom();

  stopTotpLoop();
  closeActiveModal();
}

function applyAutoLockSelection(rawValue) {
  if (rawValue === 'immediate') {
    appState.lockOnHidden = true;
    store.saveUiPrefs({ autoLockSeconds: 0 });
  } else {
    appState.lockOnHidden = false;
    const seconds = Number.parseInt(String(rawValue), 10);
    store.saveUiPrefs({ autoLockSeconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : 300 });
  }
  const railSelect = byId('rail-autolock-select');
  if (railSelect) {
    railSelect.value = appState.lockOnHidden ? 'immediate' : String(store.getUiPrefs().autoLockSeconds);
  }
  if (store.isUnlocked()) {
    renderVaultHealthStrips();
  }
}

function renderReturningLockMode(options = {}) {
  const prefs = store.getUiPrefs();
  const email = String(prefs.googleAccountEmail || '').trim();
  const isGoogleMode = prefs.vaultAuthMode === 'googleAccount' && email.length > 0;
  const showGooglePrimary = isGoogleMode && !appState.returningPassphraseOverride;

  const googleWrap = byId('lock-returning-google-wrap');
  const unlockForm = byId('form-unlock');
  const backGoogleRow = byId('lock-returning-back-google-row');
  const usePassBtn = byId('btn-returning-use-passphrase');
  const cloudBtn = byId('btn-returning-cloud');
  const googleLabel = byId('btn-returning-google-unlock-label');
  const badgeText = byId('lock-storage-badge-text');

  if (googleWrap) googleWrap.hidden = !showGooglePrimary;
  if (unlockForm) unlockForm.hidden = showGooglePrimary;
  if (backGoogleRow) backGoogleRow.hidden = !(isGoogleMode && appState.returningPassphraseOverride);
  if (usePassBtn) usePassBtn.hidden = !showGooglePrimary;
  if (cloudBtn) {
    cloudBtn.textContent = isGoogleMode ? 'Switch Account / Cloud' : 'Connect Cloud';
  }
  if (googleLabel && email) {
    googleLabel.textContent = `Unlock & Sync with Google (${email})`;
  }
  if (badgeText && store.hasSealedVault()) {
    badgeText.textContent = showGooglePrimary
      ? 'AES-256-GCM · Google Account Key'
      : 'AES-256-GCM · Sealed Vault';
  }
  if (!options.keepScopeCallout) {
    const scopeCallout = byId('returning-gdrive-scope-callout');
    if (scopeCallout) scopeCallout.hidden = true;
  }

  if (options.focus) {
    if (showGooglePrimary) {
      const googleBtn = byId('btn-returning-google-unlock');
      if (googleBtn) setTimeout(() => googleBtn.focus(), 40);
    } else {
      const unlockInput = byId('unlock-passphrase');
      if (unlockInput) setTimeout(() => unlockInput.focus(), 40);
    }
  }
}

function showLockScreen(reasonMessage = '', options = {}) {
  zeroSensitiveInputsAndDom(options);
  const lockEl = byId('jala-web-lock');
  const appEl = byId('jala-web-app');
  if (appEl) appEl.hidden = true;
  if (lockEl) lockEl.hidden = false;

  const hasVault = store.hasSealedVault();
  const returningPanel = byId('lock-returning-panel');
  const onboardPanel = byId('lock-onboarding-panel');
  const backRow = byId('lock-back-to-unlock-row');
  const badgeText = byId('lock-storage-badge-text');

  if (returningPanel) returningPanel.hidden = !hasVault;
  if (onboardPanel) onboardPanel.hidden = hasVault;
  if (backRow) backRow.hidden = !hasVault;
  if (badgeText && !hasVault) {
    badgeText.textContent = 'AES-256-GCM · Zero Plaintext';
  }

  setAlert('lock-error', '');
  setAlert('lock-info', reasonMessage);
  updateOnboardCloudProviderUi('googleDrive');
  hydrateOnboardGooglePrefs();

  if (hasVault) {
    appState.returningPassphraseOverride = false;
    renderReturningLockMode({ focus: true });
  } else {
    switchOnboardTab('create');
    const createInput = byId('create-passphrase');
    if (createInput) {
      setTimeout(() => createInput.focus(), 40);
    }
  }
}

function enterUnlockedShell(passphrase) {
  ramSecrets.unlockedPassphrase = passphrase;
  setAlert('lock-error', '');
  setAlert('lock-info', '');

  const lockEl = byId('jala-web-lock');
  const appEl = byId('jala-web-app');
  if (lockEl) lockEl.hidden = true;
  if (appEl) appEl.hidden = false;

  hydratePrefsIntoUi();
  const prefs = store.getUiPrefs();
  const targetView =
    appState.gatewayFragmentScrubbed || appState.activeView === 'gateway'
      ? 'gateway'
      : ['connections', 'totp', 'credentials', 'sync', 'gateway'].includes(prefs.activeView)
        ? prefs.activeView
        : 'connections';
  switchWorkspaceView(targetView, false);
  renderAllViews();
  startTotpLoop();
}

function hydratePrefsIntoUi() {
  const prefs = store.getUiPrefs();
  appState.syncProvider = prefs.syncProvider || 'googleDrive';
  appState.useCustomPassphrase = Boolean(prefs.useCustomPassphrase);

  const railSelect = byId('rail-autolock-select');
  if (railSelect) {
    railSelect.value = appState.lockOnHidden ? 'immediate' : String(prefs.autoLockSeconds ?? 300);
  }

  setSegmentedValue(byId('sync-provider-tabs'), 'data-sync-provider', appState.syncProvider);
  updateSyncProviderVisibility(appState.syncProvider);
  setSwitchState(byId('sync-custom-passphrase-switch'), appState.useCustomPassphrase);
  const customWrap = byId('sync-custom-passphrase-wrap');
  if (customWrap) customWrap.hidden = !appState.useCustomPassphrase;

  const gClient = byId('sync-gdrive-client-id');
  if (gClient) gClient.value = prefs.googleClientId || '';
  const gEmail = byId('sync-gdrive-email');
  if (gEmail) gEmail.value = prefs.googleAccountEmail || '';
  const gistId = byId('sync-gist-id');
  if (gistId && prefs.githubGistId) gistId.value = prefs.githubGistId;
  const gistToken = byId('sync-gist-token');
  if (gistToken && ramSecrets.gistToken) gistToken.value = ramSecrets.gistToken;
  const wdUrl = byId('sync-webdav-url');
  if (wdUrl && prefs.webdavUrl) wdUrl.value = prefs.webdavUrl;
  const wdUser = byId('sync-webdav-user');
  if (wdUser && prefs.webdavUsername) wdUser.value = prefs.webdavUsername;
  const gwUrl = byId('gateway-ws-url');
  if (gwUrl) {
    if (appState.gatewayFragmentUrl) {
      gwUrl.value = appState.gatewayFragmentUrl;
      store.saveUiPrefs({ gatewayUrl: appState.gatewayFragmentUrl });
    } else if (prefs.gatewayUrl) {
      gwUrl.value = prefs.gatewayUrl;
    } else if (
      (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') &&
      window.location.port
    ) {
      gwUrl.value = `${window.location.protocol}//${window.location.host}`;
    } else {
      gwUrl.value = LOCAL_GATEWAY_DEFAULT_URL;
    }
    syncGatewayUrlPresetsUi();
  }

  if (appState.gatewayFragmentScrubbed && ramSecrets.gatewayToken) {
    applyAutoPairedGatewayUi({ silentToast: true });
  }

  renderGoogleDriveStudioState();
  updateSecurityPill();
}

function updateSecurityPill() {
  const prefs = store.getUiPrefs();
  const pill = byId('vault-security-pill');
  const pillDot = byId('vault-security-pill-dot');
  const pillText = byId('vault-security-pill-text');
  const quickSyncBtn = byId('btn-quick-sync');
  const hasBoundCloud = Boolean(
    ramSecrets.gdriveToken ||
      ramSecrets.gistToken ||
      ramSecrets.webdavPassword ||
      prefs.githubGistId ||
      prefs.webdavUrl ||
      prefs.googleAccountEmail,
  );

  if (quickSyncBtn) {
    quickSyncBtn.hidden = !hasBoundCloud;
  }

  const label = PROVIDER_LABELS[prefs.syncProvider] || 'Cloud';
  let text = 'AES-256-GCM · Local-Only';
  let pillClass = 'security-pill';
  let dotClass = 'status-dot status-dot-ok';

  if (appState.syncInFlight || appState.cloudAutoSyncState === 'syncing') {
    text = 'AES-256-GCM · Syncing...';
    pillClass = 'security-pill is-syncing';
    dotClass = 'status-dot status-dot-warn';
  } else if (appState.cloudAutoSyncPending) {
    text = `AES-256-GCM · Sync Pending (${label})`;
    pillClass = 'security-pill is-pending';
    dotClass = 'status-dot status-dot-warn';
  } else if (appState.cloudAutoSyncState === 'error') {
    text = `AES-256-GCM · Sync Needed (${label})`;
    pillClass = 'security-pill is-error';
    dotClass = 'status-dot status-dot-danger';
  } else if (prefs.lastSyncedAtMs > 0) {
    text = `AES-256-GCM · Synced (${label})`;
  }

  if (pill) pill.className = pillClass;
  if (pillDot) pillDot.className = dotClass;
  if (pillText) pillText.textContent = text;
}

/* ==========================================================================
   Navigation & View Switching
   ========================================================================== */

function switchWorkspaceView(viewName, persist = true, options = {}) {
  const valid = ['connections', 'totp', 'credentials', 'sync', 'gateway'];
  const next = valid.includes(viewName) ? viewName : 'connections';
  appState.activeView = next;
  appState.revealedCredIds.clear();

  for (const name of valid) {
    const section = byId(`view-${name}`);
    if (section) section.hidden = name !== next;
  }

  for (const btn of document.querySelectorAll('[data-nav-view]')) {
    const active = btn.getAttribute('data-nav-view') === next;
    btn.classList.toggle('is-active', active);
    if (active) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.removeAttribute('aria-current');
    }
  }

  const addLabel = byId('btn-primary-add-label');
  if (addLabel) {
    addLabel.textContent = PRIMARY_ADD_LABELS[next] || 'Add';
  }

  if (persist && store.isUnlocked()) {
    store.saveUiPrefs({ activeView: next });
  }

  if (next === 'totp') {
    refreshAllTotpCodesNow();
  } else if (next === 'credentials') {
    renderCredentialsView();
  } else if (next === 'gateway') {
    renderGatewayTargets();
    if (
      !options.skipGatewayProbe &&
      !hasPairedGatewayToken() &&
      !(appState.gatewayClient && appState.gatewayClient.connected)
    ) {
      probeLocalGatewayHealth({ autoFocusPairing: false });
    }
  }
}

function switchOnboardTab(tab) {
  appState.onboardTab = tab;
  setSegmentedValue(byId('onboard-mode-tabs'), 'data-onboard-tab', tab);
  for (const form of document.querySelectorAll('[data-onboard-panel]')) {
    form.hidden = form.getAttribute('data-onboard-panel') !== tab;
  }
  setAlert('lock-error', '');
  if (tab === 'cloud') {
    hydrateOnboardGooglePrefs();
  }
}

function renderAllViews() {
  const payload = getPayloadSafe();
  if (!payload) return;
  updateNavCounts(payload);
  renderVaultHealthStrips(payload);
  renderConnectionsView();
  renderTotpView();
  renderCredentialsView();
  renderSyncExportSummary(payload);
  renderGoogleDriveStudioState();
  renderGatewayTargets();
  renderGatewaySessionTabs();
  updateSecurityPill();
}

function handleHealthPostureAction(action) {
  if (action === 'sync') {
    switchWorkspaceView('sync', true);
  } else if (action === 'totp') {
    switchWorkspaceView('totp', true);
  } else if (action === 'credentials') {
    switchWorkspaceView('credentials', true);
  } else if (action === 'autolock') {
    const sel = byId('rail-autolock-select');
    if (sel && window.innerWidth > 767) {
      sel.focus();
      showToast('Select an idle Auto-Lock timeout in the sidebar footer.', 'default');
    } else {
      switchWorkspaceView('sync', true);
    }
  }
}

function populateHealthStripDom({
  stripId,
  shieldId,
  scoreId,
  gradeId,
  pillsId,
  findingsId,
  toggleBtnId,
  toggleLabelId,
  health,
}) {
  const strip = byId(stripId);
  const shield = byId(shieldId);
  const scoreEl = byId(scoreId);
  const gradeEl = byId(gradeId);
  const pillsEl = byId(pillsId);
  if (!strip || !pillsEl) return;

  strip.classList.toggle('is-warn', health.tone === 'warn');
  strip.classList.toggle('is-danger', health.tone === 'danger');

  if (shield) {
    shield.className = `vault-health-shield${health.tone === 'warn' ? ' is-warn' : health.tone === 'danger' ? ' is-danger' : ''}`;
  }
  if (scoreEl) {
    scoreEl.textContent = `${health.score}/100`;
  }
  if (gradeEl) {
    gradeEl.textContent = health.gradeLabel;
    gradeEl.className = `status-pill ${health.tone === 'ok' ? 'status-pill-ok' : health.tone === 'warn' ? 'status-pill-warn' : 'status-pill-danger'}`;
  }

  pillsEl.replaceChildren();
  for (const pill of health.pills) {
    const btn = el('button', `health-pill-btn is-${pill.tone}`);
    btn.type = 'button';
    btn.setAttribute('role', 'listitem');
    btn.title = pill.detail;
    const dotTone = pill.tone === 'ok' ? 'ok' : pill.tone === 'danger' ? 'danger' : pill.tone === 'warn' ? 'warn' : 'idle';
    const dot = el('span', `status-dot status-dot-${dotTone}`);
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);
    btn.appendChild(el('span', '', pill.label));
    btn.addEventListener('click', () => handleHealthPostureAction(pill.action));
    pillsEl.appendChild(btn);
  }

  if (findingsId) {
    const findingsEl = byId(findingsId);
    const toggleBtn = toggleBtnId ? byId(toggleBtnId) : null;
    const toggleLabel = toggleLabelId ? byId(toggleLabelId) : null;
    if (toggleLabel) {
      toggleLabel.textContent =
        health.findings.length > 0
          ? `Audit (${health.findings.length})`
          : 'Audit Clean';
    }
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', appState.vaultHealthDetailsOpen ? 'true' : 'false');
    }
    if (findingsEl) {
      findingsEl.replaceChildren();
      if (health.findings.length === 0) {
        findingsEl.appendChild(
          el(
            'p',
            'health-finding-clean',
            'All checks clean: AES-256-GCM enclave active, auto-lock armed, and zero credential hygiene warnings.',
          ),
        );
      } else {
        for (const item of health.findings) {
          const row = el('div', 'health-finding-row');
          const copy = el('div', 'health-finding-copy');
          copy.appendChild(el('span', 'health-finding-title', item.title));
          copy.appendChild(el('span', 'health-finding-detail', item.detail));
          row.appendChild(copy);
          const fixBtn = el('button', 'btn btn-secondary btn-sm', item.action === 'sync' ? 'Open Sync' : item.action === 'totp' ? 'Open 2FA' : item.action === 'credentials' ? 'Review' : 'Configure');
          fixBtn.type = 'button';
          fixBtn.addEventListener('click', () => handleHealthPostureAction(item.action));
          row.appendChild(fixBtn);
          findingsEl.appendChild(row);
        }
      }
      findingsEl.hidden = !appState.vaultHealthDetailsOpen;
    }
  }
}

function renderVaultHealthStrips(payloadOverride = null) {
  const payload = payloadOverride || getPayloadSafe();
  if (!payload) return;
  const prefs = store.getUiPrefs();
  const hasCloudBinding = Boolean(
    ramSecrets.gdriveToken ||
      ramSecrets.gistToken ||
      ramSecrets.webdavPassword ||
      prefs.githubGistId ||
      prefs.webdavUrl ||
      prefs.googleAccountEmail ||
      prefs.lastSyncedAtMs > 0,
  );
  const health = computeVaultSecurityHealth(payload, {
    autoLockSeconds: prefs.autoLockSeconds,
    lockOnHidden: appState.lockOnHidden,
    syncProvider: prefs.syncProvider,
    hasCloudBinding,
    lastSyncedAtMs: prefs.lastSyncedAtMs,
    vaultAuthMode: prefs.vaultAuthMode,
    useCustomPassphrase: prefs.useCustomPassphrase,
  });

  populateHealthStripDom({
    stripId: 'vault-health-strip',
    shieldId: 'vault-health-shield',
    scoreId: 'vault-health-score',
    gradeId: 'vault-health-grade',
    pillsId: 'vault-health-pills',
    findingsId: 'vault-health-findings',
    toggleBtnId: 'btn-vault-health-details',
    toggleLabelId: 'btn-vault-health-details-label',
    health,
  });

  populateHealthStripDom({
    stripId: 'sync-vault-health-strip',
    shieldId: 'sync-health-shield',
    scoreId: 'sync-health-score',
    gradeId: 'sync-health-grade',
    pillsId: 'sync-health-pills',
    health,
  });
}

function updateNavCounts(payload) {
  const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
  const totp = Array.isArray(payload.totp) ? payload.totp : [];
  const creds = Array.isArray(payload.credentials) ? payload.credentials : [];

  const c1 = byId('nav-count-connections');
  const c2 = byId('nav-count-totp');
  const c3 = byId('nav-count-credentials');
  if (c1) c1.textContent = String(hosts.length);
  if (c2) c2.textContent = String(totp.length);
  if (c3) c3.textContent = String(creds.length);
}

/* ==========================================================================
   View 1 — Connections & Jump Host Gateways
   ========================================================================== */

function renderConnectionsView() {
  const payload = getPayloadSafe();
  if (!payload) return;

  const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
  const creds = Array.isArray(payload.credentials) ? payload.credentials : [];
  const jumpCount = hosts.filter((h) => Boolean(h.isJumpHost)).length;

  const summary = byId('connections-summary');
  if (summary) {
    summary.textContent = `${hosts.length} ${hosts.length === 1 ? 'host' : 'hosts'} · ${jumpCount} ${jumpCount === 1 ? 'jump gateway' : 'jump gateways'}`;
  }

  // Folder filter pills
  const filterBar = byId('folder-filter-bar');
  if (filterBar) {
    filterBar.replaceChildren();
    const folders = Array.from(
      new Set(
        hosts
          .map((h) => String(h.folder || '').trim())
          .filter((f) => f.length > 0),
      ),
    ).sort((a, b) => a.localeCompare(b));

    const pills = [
      { key: 'all', label: `All (${hosts.length})` },
      { key: '__favorites__', label: `Favorites (${hosts.filter((h) => h.isFavorite).length})` },
      { key: '__jump__', label: `Jump Hosts (${jumpCount})` },
      ...folders.map((name) => ({
        key: `folder:${name}`,
        label: name,
      })),
    ];

    if (!pills.some((p) => p.key === appState.folderFilter)) {
      appState.folderFilter = 'all';
    }

    for (const pill of pills) {
      const btn = el('button', `filter-pill${appState.folderFilter === pill.key ? ' is-active' : ''}`, pill.label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', appState.folderFilter === pill.key ? 'true' : 'false');
      btn.addEventListener('click', () => {
        appState.folderFilter = pill.key;
        renderConnectionsView();
      });
      filterBar.appendChild(btn);
    }
  }

  const query = appState.searchQuery.trim().toLowerCase();
  const filtered = hosts.filter((host) => {
    if (appState.folderFilter === '__favorites__' && !host.isFavorite) return false;
    if (appState.folderFilter === '__jump__' && !host.isJumpHost) return false;
    if (appState.folderFilter.startsWith('folder:')) {
      const targetFolder = appState.folderFilter.slice('folder:'.length);
      if (String(host.folder || '').trim() !== targetFolder) return false;
    }
    if (!query) return true;
    const haystack = [
      host.name,
      host.address,
      host.protocol,
      host.username,
      host.folder,
      host.domain,
      host.osLabel,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });

  const listEl = byId('connections-list');
  const emptyEl = byId('connections-empty');
  if (!listEl || !emptyEl) return;
  listEl.replaceChildren();

  if (filtered.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const host of filtered) {
    const proto = String(host.protocol || 'rdp').toLowerCase();
    const safeProtoClass = ['rdp', 'vnc', 'ssh', 'sftp', 'hypervisor'].includes(proto) ? proto : 'rdp';
    const card = el('article', 'host-card');

    const top = el('div', 'host-card-top');
    const ident = el('div', 'host-ident');

    const nameRow = el('div', 'host-name-row');
    nameRow.appendChild(el('span', `proto-badge proto-${safeProtoClass} mono`, proto.toUpperCase()));
    nameRow.appendChild(el('h2', 'host-name', host.name || host.address || 'Unnamed Host'));
    ident.appendChild(nameRow);

    const linkedCred = host.credentialId ? creds.find((c) => c.id === host.credentialId) : null;
    const effectiveUser = String(host.username || (linkedCred && linkedCred.username) || '').trim();
    const endpointText = `${effectiveUser ? `${effectiveUser}@` : ''}${host.address || 'unknown'}:${host.port || DEFAULT_PORTS[safeProtoClass] || 22}`;
    ident.appendChild(el('span', 'host-endpoint mono', endpointText));
    top.appendChild(ident);

    const favBtn = el('button', `icon-btn${host.isFavorite ? ' is-fav' : ''}`);
    favBtn.type = 'button';
    favBtn.setAttribute('aria-label', host.isFavorite ? `Remove ${host.name} from favorites` : `Favorite ${host.name}`);
    favBtn.setAttribute('aria-pressed', host.isFavorite ? 'true' : 'false');
    favBtn.appendChild(
      createSvgIcon([
        {
          tag: 'polygon',
          attrs: {
            points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2',
            fill: host.isFavorite ? 'currentColor' : 'none',
          },
        },
      ]),
    );
    favBtn.addEventListener('click', () => toggleHostFavorite(host.id));
    top.appendChild(favBtn);
    card.appendChild(top);

    const metaRow = el('div', 'host-meta-row');
    if (host.isJumpHost) {
      metaRow.appendChild(el('span', 'meta-pill meta-pill-jump-role', 'Jump Host'));
    }
    if (host.jumpHostId) {
      const bastion = hosts.find((h) => h.id === host.jumpHostId);
      if (bastion) {
        metaRow.appendChild(el('span', 'meta-pill meta-pill-bastion mono', `via ${bastion.name || bastion.address}`));
      }
    }
    if (host.folder && String(host.folder).trim()) {
      metaRow.appendChild(el('span', 'meta-pill', String(host.folder).trim()));
    }
    if (host.domain && String(host.domain).trim()) {
      metaRow.appendChild(el('span', 'meta-pill', String(host.domain).trim()));
    } else if (host.osLabel && String(host.osLabel).trim()) {
      metaRow.appendChild(el('span', 'meta-pill', String(host.osLabel).trim()));
    }
    if (metaRow.childElementCount > 0) {
      card.appendChild(metaRow);
    }

    const actions = el('div', 'host-card-actions');
    const copySpec = buildSshOrEndpointCommand(host, hosts, creds);

    const connectBtn = el('button', 'btn btn-connect');
    connectBtn.type = 'button';
    connectBtn.appendChild(
      createSvgIcon([
        { tag: 'polygon', attrs: { points: '6 4 20 12 6 20 6 4' } },
      ]),
    );
    connectBtn.appendChild(el('span', '', 'Connect'));
    connectBtn.addEventListener('click', () => openHostInGateway(host.id));
    actions.appendChild(connectBtn);

    const copyBtn = el('button', 'btn btn-secondary', copySpec.buttonText);
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => copyText(copySpec.value, copySpec.label, false));
    actions.appendChild(copyBtn);

    const editBtn = el('button', 'btn btn-ghost', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openConnectionModal(host));
    actions.appendChild(editBtn);

    const delBtn = el('button', 'btn btn-ghost btn-ghost-danger', 'Delete');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => requestDeleteHost(host.id));
    actions.appendChild(delBtn);

    card.appendChild(actions);
    listEl.appendChild(card);
  }
}

async function toggleHostFavorite(hostId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const now = Date.now();
  payload.hosts = payload.hosts.map((h) => (h.id === hostId ? { ...h, isFavorite: !h.isFavorite, updatedAtMs: now } : h));
  payload.updatedAtMs = now;
  await saveVaultPayload(payload);
  renderAllViews();
}

function requestDeleteHost(hostId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
  const creds = Array.isArray(payload.credentials) ? payload.credentials : [];
  const host = hosts.find((h) => h.id === hostId);
  if (!host) return;

  const proto = String(host.protocol || 'rdp').toLowerCase();
  const port = Number(host.port) || DEFAULT_PORTS[proto] || 22;
  const linkedCred = host.credentialId ? creds.find((c) => c.id === host.credentialId) : null;
  const user = String(host.username || (linkedCred && linkedCred.username) || '').trim();
  const displayName = String(host.name || host.address || 'Unnamed Host');
  const endpointMeta = `${proto.toUpperCase()} · ${user ? `${user}@` : ''}${host.address || 'unknown'}:${port}`;

  const childHosts = hosts.filter((h) => h.jumpHostId === hostId);
  let warning = '';
  if (childHosts.length > 0) {
    const listedNames = childHosts
      .slice(0, 3)
      .map((c) => c.name || c.address || 'Unnamed')
      .join(', ');
    const overflow = childHosts.length > 3 ? ` +${childHosts.length - 3} more` : '';
    warning = `Jump Host in use: ${childHosts.length} child ${childHosts.length === 1 ? 'connection' : 'connections'} (${listedNames}${overflow}) route through this gateway. Deleting it resets their route to Direct.`;
  } else if (host.isJumpHost) {
    warning = 'This entry is configured as a Jump Host gateway. Removing it removes it from bastion route selectors.';
  }

  openConfirmDeleteModal({
    title: host.isJumpHost ? 'Delete Jump Host?' : 'Delete Connection?',
    itemName: displayName,
    itemMeta: endpointMeta,
    description: 'Remove this host from your encrypted vault?',
    warning,
    syncNote: 'A deletion tombstone will propagate to your other devices on the next Cloud Sync. You can undo for 6 seconds.',
    confirmLabel: host.isJumpHost ? 'Delete Jump Host' : 'Delete Connection',
    onConfirm: () => executeDeleteHost(hostId),
  });
}

async function executeDeleteHost(hostId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const target = (payload.hosts || []).find((h) => h.id === hostId);
  if (!target) return;

  const now = Date.now();
  const tombstoneKey = makeTombstoneKey('host', hostId);
  const previousTombstoneValue =
    payload.tombstones && Object.hasOwn(payload.tombstones, tombstoneKey)
      ? payload.tombstones[tombstoneKey]
      : undefined;

  const detachedChildren = (payload.hosts || [])
    .filter((h) => h.jumpHostId === hostId)
    .map((h) => ({ id: h.id, prevJumpHostId: h.jumpHostId }));

  const itemCopy = { ...target };
  const label = String(target.name || target.address || 'Connection');

  payload.hosts = payload.hosts
    .filter((h) => h.id !== hostId)
    .map((h) => (h.jumpHostId === hostId ? { ...h, jumpHostId: null, updatedAtMs: now } : h));
  payload.tombstones[tombstoneKey] = now;
  payload.updatedAtMs = now;

  if (appState.gatewayTargetHostId === hostId) {
    appState.gatewayTargetHostId = '__demo__';
  }
  closeGatewaySessionTab(makeGatewaySessionId(hostId), { silent: true });

  await saveVaultPayload(payload, { autoSyncDelayMs: CLOUD_DELETE_SYNC_DELAY_MS, isDelete: true });
  renderAllViews();

  registerPendingUndo({
    kind: 'host',
    item: itemCopy,
    tombstoneKey,
    previousTombstoneValue,
    detachedChildren,
    unlinkedHosts: [],
    restoreLabel: label,
    toastMessage: `Deleted "${label}".`,
  });
}

function hasPairedGatewayToken() {
  const tok = String(ramSecrets.gatewayToken || byId('gateway-session-token')?.value || '').trim();
  return tok.length >= 4;
}

function hostHasStoredSecret(host, creds) {
  if (!host) return false;
  if (String(host.password || '').trim().length > 0) return true;
  if (String(host.privateKeyPem || '').trim().length > 0) return true;
  const linkedCred = host.credentialId ? (creds || []).find((c) => c.id === host.credentialId) : null;
  if (linkedCred) {
    if (String(linkedCred.password || '').trim().length > 0) return true;
    if (String(linkedCred.privateKeyPem || '').trim().length > 0) return true;
  }
  return false;
}

function clearGatewayRuntimeCredentials() {
  ramSecrets.gatewayRuntimePassword = '';
  ramSecrets.gatewayRuntimeKey = '';
  appState.gatewayCredPromptHostId = '';
  const pwInput = byId('gateway-runtime-password');
  const keyInput = byId('gateway-runtime-key');
  const promptEl = byId('gateway-cred-prompt');
  if (pwInput) pwInput.value = '';
  if (keyInput) keyInput.value = '';
  if (promptEl) promptEl.hidden = true;
}

function openHostInGateway(hostId) {
  if (appState.gatewayCredPromptHostId !== String(hostId)) {
    clearGatewayRuntimeCredentials();
  }
  const session = openOrFocusGatewaySessionTab(String(hostId));
  appState.gatewayTargetHostId = String(hostId);
  switchWorkspaceView('gateway', true, { skipGatewayProbe: true });

  // If this session tab is already live or in interactive preview, jump straight to its preserved stage!
  if (session && (session.status === 'live' || session.status === 'preview')) {
    activateGatewaySessionTab(session.id);
    return;
  }

  setGatewaySetupVisible(true);
  const select = byId('gateway-host-select');
  if (select) {
    select.value = String(hostId);
    updateGatewayTargetBadge();
  }

  const payload = getPayloadSafe();
  const hosts = payload && Array.isArray(payload.hosts) ? payload.hosts : [];
  const creds = payload && Array.isArray(payload.credentials) ? payload.credentials : [];
  const host = hosts.find((h) => String(h.id) === String(hostId));
  if (!host) return;

  const proto = String(host.protocol || 'rdp').toLowerCase();
  const port = Number(host.port) || DEFAULT_PORTS[proto] || 22;
  const linkedCred = host.credentialId ? creds.find((c) => c.id === host.credentialId) : null;
  const user = String(host.username || (linkedCred && linkedCred.username) || '').trim();
  const endpointStr = `${user ? `${user}@` : ''}${host.address}:${port}`;

  appendGatewayLog(`Selected target ${host.name || host.address} (${proto.toUpperCase()} ${endpointStr}).`, 'ok');

  if (hasPairedGatewayToken()) {
    const token = String(ramSecrets.gatewayToken || byId('gateway-session-token')?.value || '').trim();
    ramSecrets.gatewayToken = token;
    const tokInput = byId('gateway-session-token');
    if (tokInput && !tokInput.value) tokInput.value = token;
    setGatewayAuthMode('token');

    const guidanceEl = byId('gateway-setup-guidance');
    if (guidanceEl) guidanceEl.hidden = true;

    if (proto === 'ssh' || hostHasStoredSecret(host, creds)) {
      clearGatewayRuntimeCredentials();
      appendGatewayLog(`Gateway already paired — launching live ${proto.toUpperCase()} session to ${host.name || host.address}...`, 'ok');
      connectGatewayBridge();
    } else {
      appState.gatewayCredPromptHostId = String(host.id);
      const promptEl = byId('gateway-cred-prompt');
      const descEl = byId('gateway-cred-prompt-desc');
      const keyWrap = byId('gateway-runtime-key-wrap');
      if (descEl) {
        descEl.textContent = `Gateway is paired. Enter a RAM-only password${proto === 'ssh' || proto === 'sftp' ? ' or SSH private key' : ''} for ${endpointStr}, or connect without one.`;
      }
      if (keyWrap) {
        keyWrap.hidden = proto !== 'ssh' && proto !== 'sftp';
      }
      if (promptEl) promptEl.hidden = false;
      setTimeout(() => byId('gateway-runtime-password')?.focus(), 40);
    }
    return;
  }

  clearGatewayRuntimeCredentials();
  setGatewayAuthMode('pairing');
  probeLocalGatewayHealth({ autoFocusPairing: true });
}

/* ==========================================================================
   View 2 — Live RFC 6238 2FA Authenticator
   ========================================================================== */

function renderTotpView() {
  const payload = getPayloadSafe();
  if (!payload) return;

  const allItems = Array.isArray(payload.totp) ? payload.totp : [];
  const summary = byId('totp-summary');
  if (summary) {
    summary.textContent = `${allItems.length} active ${allItems.length === 1 ? 'token' : 'tokens'} · RFC 6238 WebCrypto`;
  }

  const query = appState.searchQuery.trim().toLowerCase();
  const filtered = allItems.filter((item) => {
    if (!query) return true;
    const text = `${item.issuer || ''} ${item.accountName || ''} ${item.label || ''} ${item.algorithm || ''}`.toLowerCase();
    return text.includes(query);
  });

  const listEl = byId('totp-list');
  const emptyEl = byId('totp-empty');
  if (!listEl || !emptyEl) return;
  listEl.replaceChildren();
  appState.totpCardRefs.clear();

  if (filtered.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const item of filtered) {
    const period = Number(item.period || item.periodSeconds || 30);
    const algo = String(item.algorithm || 'SHA1').toUpperCase();
    const digits = Number(item.digits || 6);

    const card = el('article', 'totp-card');
    card.dataset.totpId = String(item.id);

    const head = el('div', 'totp-card-head');
    const ident = el('div', 'totp-ident');
    ident.appendChild(el('span', 'totp-issuer', item.issuer || 'Authenticator'));
    ident.appendChild(el('span', 'totp-account', item.accountName || item.label || 'Account'));
    head.appendChild(ident);
    head.appendChild(el('span', 'totp-algo-tag mono', `${algo} · ${period}s`));
    card.appendChild(head);

    const codeBtn = el('button', 'totp-code-btn');
    codeBtn.type = 'button';
    codeBtn.setAttribute('aria-label', `Copy 2FA code for ${item.issuer || item.accountName || 'token'}`);
    const codeSpan = el('span', 'totp-code-value mono', digits === 8 ? '---- ----' : '--- ---');
    const remSpan = el('span', 'totp-remaining mono', `${period}s`);
    codeBtn.appendChild(codeSpan);
    codeBtn.appendChild(remSpan);
    card.appendChild(codeBtn);

    const track = el('div', 'totp-progress-track');
    const fill = el('div', 'totp-progress-fill');
    track.appendChild(fill);
    card.appendChild(track);

    const footer = el('div', 'totp-card-actions');
    const copyBtn = el('button', 'btn btn-secondary btn-sm', 'Copy Code');
    copyBtn.type = 'button';
    footer.appendChild(copyBtn);

    const rightGroup = el('div', 'totp-action-group');
    const editBtn = el('button', 'btn btn-ghost btn-sm', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openTotpModal(item));
    rightGroup.appendChild(editBtn);

    const delBtn = el('button', 'btn btn-ghost btn-ghost-danger btn-sm', 'Delete');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => requestDeleteTotp(item.id));
    rightGroup.appendChild(delBtn);
    footer.appendChild(rightGroup);
    card.appendChild(footer);

    const ref = {
      item,
      period,
      lastCounter: null,
      rawCode: '',
      codeSpan,
      remSpan,
      fill,
    };

    const handleCopy = () => {
      if (ref.rawCode) {
        copyText(ref.rawCode, `${item.issuer || '2FA'} code`, true);
      }
    };
    codeBtn.addEventListener('click', handleCopy);
    copyBtn.addEventListener('click', handleCopy);

    appState.totpCardRefs.set(String(item.id), ref);
    listEl.appendChild(card);
  }

  refreshAllTotpCodesNow();
}

async function refreshAllTotpCodesNow() {
  const nowMs = Date.now();
  const tasks = [];
  for (const ref of appState.totpCardRefs.values()) {
    const timing = calculateTotpTiming(ref.period, nowMs);
    const ratio = Math.max(0, Math.min(1, timing.progressRatio));
    ref.fill.style.setProperty('--totp-progress', ratio.toFixed(4));
    const expiring = timing.remainingSeconds <= 5;
    ref.fill.classList.toggle('is-expiring', expiring);
    ref.remSpan.classList.toggle('is-expiring', expiring);
    ref.remSpan.textContent = `${timing.remainingSeconds}s`;

    if (ref.lastCounter !== timing.counter) {
      ref.lastCounter = timing.counter;
      tasks.push(
        evaluateTotpToken(ref.item, nowMs)
          .then((evalRes) => {
            ref.rawCode = evalRes.code;
            ref.codeSpan.textContent = evalRes.formattedCode;
          })
          .catch(() => {
            ref.rawCode = '';
            ref.codeSpan.textContent = 'INVALID';
          }),
      );
    }
  }
  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

function startTotpLoop() {
  stopTotpLoop();
  const step = (ts) => {
    if (!store.isUnlocked()) {
      appState.totpRafId = 0;
      return;
    }
    if (ts - appState.totpLastTickMs >= 100) {
      appState.totpLastTickMs = ts;
      if (appState.totpCardRefs.size > 0) {
        refreshAllTotpCodesNow();
      }
    }
    appState.totpRafId = window.requestAnimationFrame(step);
  };
  appState.totpRafId = window.requestAnimationFrame(step);
}

function stopTotpLoop() {
  if (appState.totpRafId) {
    window.cancelAnimationFrame(appState.totpRafId);
    appState.totpRafId = 0;
  }
}

function requestDeleteTotp(totpId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const item = (payload.totp || []).find((t) => t.id === totpId);
  if (!item) return;

  const issuer = String(item.issuer || '').trim();
  const account = String(item.accountName || item.label || '').trim();
  const algo = String(item.algorithm || 'SHA1').toUpperCase();
  const digits = Number(item.digits || 6);
  const period = Number(item.period || item.periodSeconds || 30);

  const itemName = issuer ? `${issuer}${account ? ` — ${account}` : ''}` : account || '2FA Token';
  const itemMeta = `${algo} · ${digits} digits · ${period}s`;

  openConfirmDeleteModal({
    title: 'Delete 2FA Token?',
    itemName,
    itemMeta,
    description: 'Remove this TOTP authenticator token from your encrypted vault?',
    warning: 'Losing a TOTP secret cannot be undone unless you have a .jvault backup or account recovery codes.',
    syncNote: 'A deletion tombstone will propagate to your other devices on the next Cloud Sync. You can undo for 6 seconds.',
    confirmLabel: 'Delete 2FA Token',
    onConfirm: () => executeDeleteTotp(totpId),
  });
}

async function executeDeleteTotp(totpId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const target = (payload.totp || []).find((t) => t.id === totpId);
  if (!target) return;

  const now = Date.now();
  const tombstoneKey = makeTombstoneKey('totp', totpId);
  const previousTombstoneValue =
    payload.tombstones && Object.hasOwn(payload.tombstones, tombstoneKey)
      ? payload.tombstones[tombstoneKey]
      : undefined;

  const itemCopy = { ...target };
  const label = [target.issuer, target.accountName || target.label].filter(Boolean).join(' · ') || '2FA token';

  payload.totp = payload.totp.filter((t) => t.id !== totpId);
  payload.tombstones[tombstoneKey] = now;
  payload.updatedAtMs = now;
  await saveVaultPayload(payload, { autoSyncDelayMs: CLOUD_DELETE_SYNC_DELAY_MS, isDelete: true });
  renderAllViews();

  registerPendingUndo({
    kind: 'totp',
    item: itemCopy,
    tombstoneKey,
    previousTombstoneValue,
    detachedChildren: [],
    unlinkedHosts: [],
    restoreLabel: label,
    toastMessage: `Deleted 2FA "${label}".`,
  });
}

/* ==========================================================================
   View 3 — Saved Credentials Vault
   ========================================================================== */

function renderCredentialsView() {
  const payload = getPayloadSafe();
  if (!payload) return;

  const creds = Array.isArray(payload.credentials) ? payload.credentials : [];
  const summary = byId('credentials-summary');
  if (summary) {
    summary.textContent = `${creds.length} ${creds.length === 1 ? 'credential' : 'credentials'} stored in encrypted enclave`;
  }

  const query = appState.searchQuery.trim().toLowerCase();
  const filtered = creds.filter((cred) => {
    const kind = resolveCredentialKind(cred);
    if (appState.credKindFilter !== 'all' && kind !== appState.credKindFilter) return false;
    if (!query) return true;
    const text = `${cred.label || ''} ${cred.username || ''} ${cred.domain || ''} ${cred.notes || ''} ${kind}`.toLowerCase();
    return text.includes(query);
  });

  const panel = byId('credentials-panel');
  const listEl = byId('credentials-list');
  const emptyEl = byId('credentials-empty');
  if (!panel || !listEl || !emptyEl) return;
  listEl.replaceChildren();

  if (filtered.length === 0) {
    panel.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  panel.hidden = false;
  emptyEl.hidden = true;

  for (const cred of filtered) {
    const kind = resolveCredentialKind(cred);
    const kindLabel = kind === 'sshKey' ? 'SSH Key' : kind === 'domain' ? 'Domain' : 'Password';
    const isRevealed = appState.revealedCredIds.has(String(cred.id));
    const secretValue = kind === 'sshKey' ? String(cred.privateKeyPem || cred.password || '') : String(cred.password || '');

    const row = el('div', 'cred-row');

    const ident = el('div', 'cred-row-ident');
    const labelLine = el('div', 'cred-label-line');
    labelLine.appendChild(el('span', 'cred-label', cred.label || 'Unnamed Credential'));
    labelLine.appendChild(el('span', 'meta-pill', kindLabel));
    ident.appendChild(labelLine);
    const accountStr = cred.domain ? `${cred.domain}\\${cred.username || ''}` : String(cred.username || 'No username');
    ident.appendChild(el('span', 'cred-user mono', accountStr));
    row.appendChild(ident);

    const secretBox = el('div', 'cred-secret-box');
    const secretDisplay = isRevealed
      ? secretValue || '(empty)'
      : kind === 'sshKey'
        ? 'SSH Private Key · Hidden'
        : secretValue
          ? '••••••••••••'
          : '(no secret)';
    secretBox.appendChild(el('span', 'cred-secret-value mono', secretDisplay));

    const revealBtn = el('button', 'btn btn-ghost btn-sm', isRevealed ? 'Hide' : 'Reveal');
    revealBtn.type = 'button';
    revealBtn.setAttribute('aria-pressed', isRevealed ? 'true' : 'false');
    revealBtn.addEventListener('click', () => {
      const key = String(cred.id);
      if (appState.revealedCredIds.has(key)) {
        appState.revealedCredIds.delete(key);
      } else {
        appState.revealedCredIds.add(key);
      }
      renderCredentialsView();
    });
    secretBox.appendChild(revealBtn);
    row.appendChild(secretBox);

    const actions = el('div', 'cred-row-actions');
    const copySecretBtn = el('button', 'btn btn-secondary btn-sm', 'Copy Secret');
    copySecretBtn.type = 'button';
    copySecretBtn.disabled = !secretValue;
    copySecretBtn.addEventListener('click', () => copyText(secretValue, `${cred.label || 'Credential'} secret`, true));
    actions.appendChild(copySecretBtn);

    if (cred.username) {
      const copyUserBtn = el('button', 'btn btn-ghost btn-sm', 'Copy User');
      copyUserBtn.type = 'button';
      copyUserBtn.addEventListener('click', () => copyText(String(cred.username), 'Username', false));
      actions.appendChild(copyUserBtn);
    }

    const editBtn = el('button', 'btn btn-ghost btn-sm', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openCredentialModal(cred));
    actions.appendChild(editBtn);

    const delBtn = el('button', 'btn btn-ghost btn-ghost-danger btn-sm', 'Delete');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => requestDeleteCredential(cred.id));
    actions.appendChild(delBtn);

    row.appendChild(actions);
    listEl.appendChild(row);
  }
}

function requestDeleteCredential(credId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const cred = (payload.credentials || []).find((c) => c.id === credId);
  if (!cred) return;

  const kind = resolveCredentialKind(cred);
  const kindLabel = kind === 'sshKey' ? 'SSH Key' : kind === 'domain' ? 'Domain' : 'Password';
  const accountStr = cred.domain ? `${cred.domain}\\${cred.username || ''}` : String(cred.username || 'No username');
  const linkedHosts = (payload.hosts || []).filter((h) => h.credentialId === credId);

  let warning = '';
  if (linkedHosts.length > 0) {
    const names = linkedHosts
      .slice(0, 3)
      .map((h) => h.name || h.address || 'Unnamed')
      .join(', ');
    const overflow = linkedHosts.length > 3 ? ` +${linkedHosts.length - 3} more` : '';
    warning = `This credential is linked to ${linkedHosts.length} ${linkedHosts.length === 1 ? 'connection' : 'connections'} (${names}${overflow}). Deleting it will unlink those hosts.`;
  }

  openConfirmDeleteModal({
    title: 'Delete Credential?',
    itemName: String(cred.label || 'Unnamed Credential'),
    itemMeta: `${kindLabel} · ${accountStr}`,
    description: 'Remove this saved credential from your encrypted enclave?',
    warning,
    syncNote: 'A deletion tombstone will propagate to your other devices on the next Cloud Sync. You can undo for 6 seconds.',
    confirmLabel: 'Delete Credential',
    onConfirm: () => executeDeleteCredential(credId),
  });
}

async function executeDeleteCredential(credId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const target = (payload.credentials || []).find((c) => c.id === credId);
  if (!target) return;

  const now = Date.now();
  const tombstoneKey = makeTombstoneKey('cred', credId);
  const previousTombstoneValue =
    payload.tombstones && Object.hasOwn(payload.tombstones, tombstoneKey)
      ? payload.tombstones[tombstoneKey]
      : undefined;

  const unlinkedHosts = (payload.hosts || [])
    .filter((h) => h.credentialId === credId)
    .map((h) => ({ id: h.id, prevCredentialId: h.credentialId }));

  const itemCopy = { ...target };
  const label = String(target.label || target.username || 'Credential');

  payload.credentials = payload.credentials.filter((c) => c.id !== credId);
  payload.hosts = payload.hosts.map((h) => (h.credentialId === credId ? { ...h, credentialId: null, updatedAtMs: now } : h));
  payload.tombstones[tombstoneKey] = now;
  payload.updatedAtMs = now;
  appState.revealedCredIds.delete(String(credId));
  await saveVaultPayload(payload, { autoSyncDelayMs: CLOUD_DELETE_SYNC_DELAY_MS, isDelete: true });
  renderAllViews();

  registerPendingUndo({
    kind: 'credential',
    item: itemCopy,
    tombstoneKey,
    previousTombstoneValue,
    detachedChildren: [],
    unlinkedHosts,
    restoreLabel: label,
    toastMessage: `Deleted "${label}".`,
  });
}

/* ==========================================================================
   View 4 — Zero-Knowledge Cloud Sync & .jvault Studio
   ========================================================================== */

function getCurrentWebOrigin() {
  const origin = window.location && typeof window.location.origin === 'string' ? window.location.origin : '';
  return origin && origin !== 'null' ? origin : 'https://ribato22.github.io';
}

function updateOnboardCloudProviderUi(provider) {
  const prov = provider === 'githubGist' || provider === 'webdav' ? provider : 'googleDrive';
  appState.onboardCloudProvider = prov;
  setSegmentedValue(byId('onboard-cloud-provider'), 'data-cloud-provider', prov);
  for (const block of document.querySelectorAll('[data-onboard-provider-fields]')) {
    block.hidden = block.getAttribute('data-onboard-provider-fields') !== prov;
  }
  const nonGoogleFooter = byId('onboard-non-google-footer');
  if (nonGoogleFooter) {
    nonGoogleFooter.hidden = prov === 'googleDrive';
  }
}

function hydrateOnboardGooglePrefs() {
  const prefs = store.getUiPrefs();
  const originEl = byId('onboard-gdrive-origin');
  if (originEl) originEl.textContent = getCurrentWebOrigin();
  const clientInput = byId('onboard-gdrive-client-id');
  if (clientInput && prefs.googleClientId && !clientInput.value) {
    clientInput.value = prefs.googleClientId;
  }
  const emailInput = byId('onboard-gdrive-email');
  if (emailInput && prefs.googleAccountEmail && !emailInput.value) {
    emailInput.value = prefs.googleAccountEmail;
  }
  setSwitchState(byId('onboard-gdrive-custom-pass-switch'), appState.onboardGdriveCustomPass);
  const customWrap = byId('onboard-gdrive-custom-pass-wrap');
  if (customWrap) customWrap.hidden = !appState.onboardGdriveCustomPass;
  updateOnboardCloudProviderUi(appState.onboardCloudProvider || 'googleDrive');
}

function setSyncGoogleCallout(opts = null) {
  const box = byId('sync-gdrive-callout');
  const titleEl = byId('sync-gdrive-callout-title');
  const textEl = byId('sync-gdrive-callout-text');
  const grantBtn = byId('btn-sync-gdrive-grant');
  if (!box || !titleEl || !textEl) return;
  if (!opts || !opts.text) {
    box.hidden = true;
    titleEl.textContent = '';
    textEl.textContent = '';
    if (grantBtn) grantBtn.hidden = true;
    return;
  }
  const tone = ['warn', 'info', 'ok', 'danger'].includes(opts.tone) ? opts.tone : 'info';
  box.className = `gdrive-callout gdrive-callout-${tone}`;
  titleEl.textContent = opts.title || '';
  textEl.textContent = opts.text;
  if (grantBtn) grantBtn.hidden = !opts.showGrant;
  box.hidden = false;
}

function renderGoogleDriveStudioState() {
  const prefs = store.getUiPrefs();
  const originEl = byId('sync-gdrive-origin');
  if (originEl) originEl.textContent = getCurrentWebOrigin();

  const email = (
    ramSecrets.gdriveEmail ||
    prefs.googleAccountEmail ||
    (byId('sync-gdrive-email')?.value || '')
  ).trim();
  const displayName = (ramSecrets.gdriveDisplayName || prefs.googleAccountName || '').trim();
  const hasToken = Boolean(ramSecrets.gdriveToken || (byId('sync-gdrive-token')?.value || '').trim());
  const isBound = Boolean(email || hasToken);

  const signedOutHero = byId('sync-gdrive-signed-out');
  const accountBar = byId('sync-gdrive-account-bar');
  if (signedOutHero) signedOutHero.hidden = isBound;
  if (accountBar) accountBar.hidden = !isBound;
  if (!isBound) return;

  const avatar = byId('sync-gdrive-avatar');
  if (avatar) {
    const leadChar = ((displayName || email || 'G').trim().charAt(0) || 'G').toUpperCase();
    avatar.textContent = leadChar;
  }
  const emailNode = byId('sync-gdrive-account-email');
  if (emailNode) {
    emailNode.textContent = email || 'Google Drive OAuth Session';
  }
  const pill = byId('sync-gdrive-account-pill');
  const missingScope = Boolean(ramSecrets.gdriveToken && ramSecrets.gdriveScope && !hasGoogleDriveAppDataScope(ramSecrets.gdriveScope));
  if (pill) {
    pill.className = missingScope ? 'status-pill status-pill-warn' : 'status-pill status-pill-ok';
    pill.textContent = missingScope ? 'Permission Needed' : 'Bound';
  }
  const sub = byId('sync-gdrive-account-sub');
  if (sub) {
    if (prefs.lastSyncedAtMs > 0) {
      sub.textContent = `Google Drive AppData · Synced ${new Date(prefs.lastSyncedAtMs).toLocaleTimeString()}`;
    } else if (hasToken) {
      sub.textContent = 'Google Drive AppData · AES-256-GCM ready';
    } else {
      sub.textContent = 'Google Drive AppData · Click Sync or Reconnect';
    }
  }
}

function updateSyncProviderVisibility(provider) {
  for (const panel of document.querySelectorAll('[data-sync-provider-panel]')) {
    panel.hidden = panel.getAttribute('data-sync-provider-panel') !== provider;
  }
}

function renderSyncExportSummary(payload) {
  const meta = byId('export-summary-meta');
  if (!meta) return;
  const h = (payload.hosts || []).length;
  const t = (payload.totp || []).length;
  const c = (payload.credentials || []).length;
  meta.textContent = `${h} hosts · ${t} 2FA · ${c} creds`;
}

function resolveEffectiveSyncPassphrase(provider) {
  if (appState.useCustomPassphrase) {
    const custom = (byId('sync-custom-passphrase')?.value || ramSecrets.customSyncPassphrase || '').trim();
    if (custom.length < 4) {
      throw new Error('Custom E2EE passphrase must be at least 4 characters.');
    }
    ramSecrets.customSyncPassphrase = custom;
    return custom;
  }
  if (provider === 'googleDrive') {
    const email = (
      ramSecrets.gdriveEmail ||
      store.getUiPrefs().googleAccountEmail ||
      (byId('sync-gdrive-email')?.value || '')
    ).trim();
    if (email) {
      return deriveGoogleAccountBoundPassphrase(email);
    }
  }
  if (ramSecrets.unlockedPassphrase.length >= 4) {
    return ramSecrets.unlockedPassphrase;
  }
  throw new Error('Vault passphrase unavailable. Unlock vault or enable Custom E2EE Passphrase.');
}

async function runCloudSync(mode, options = {}) {
  const isBackground = Boolean(options.background);
  if (!store.isUnlocked()) return;
  if (appState.syncInFlight) {
    if (isBackground) {
      appState.cloudAutoSyncQueuedAgain = true;
    }
    return;
  }
  const payload = getPayloadSafe();
  if (!payload) return;

  cancelCloudAutoSync();

  const provider = appState.syncProvider;
  const statusMsg = byId('sync-status-message');

  if (provider === 'googleDrive') {
    const existingToken = (byId('sync-gdrive-token')?.value || ramSecrets.gdriveToken || '').trim();
    if (!existingToken) {
      if (isBackground) return;
      const prefs = store.getUiPrefs();
      const loginHint = (ramSecrets.gdriveEmail || prefs.googleAccountEmail || '').trim();
      await handleStudioGoogleSignIn({ loginHint, prompt: '', autoSyncMode: mode });
      return;
    }
  }

  appState.syncInFlight = true;
  appState.cloudAutoSyncState = 'syncing';
  updateSecurityPill();
  if (statusMsg) statusMsg.textContent = `Running ${mode} with ${PROVIDER_LABELS[provider] || provider}...`;

  try {
    const passphrase = resolveEffectiveSyncPassphrase(provider);
    let result;

    if (provider === 'googleDrive') {
      const token = (byId('sync-gdrive-token')?.value || ramSecrets.gdriveToken || '').trim();
      let email = (
        ramSecrets.gdriveEmail ||
        (byId('sync-gdrive-email')?.value || '') ||
        store.getUiPrefs().googleAccountEmail ||
        ''
      ).trim();
      const clientId = (byId('sync-gdrive-client-id')?.value || '').trim();
      ramSecrets.gdriveToken = token;
      if (!email && token) {
        try {
          const info = await fetchGoogleUserInfo(token);
          if (info.email) {
            email = info.email;
            ramSecrets.gdriveEmail = info.email;
            ramSecrets.gdriveDisplayName = info.displayName;
          }
        } catch {
          // Manual tokens without openid profile scope can still sync with passphrase
        }
      }
      store.saveUiPrefs({
        syncProvider: 'googleDrive',
        vaultAuthMode: appState.useCustomPassphrase
          ? 'passphrase'
          : email
            ? 'googleAccount'
            : store.getUiPrefs().vaultAuthMode,
        googleAccountEmail: email,
        googleClientId: clientId,
        useCustomPassphrase: appState.useCustomPassphrase,
      });
      result = await syncWithGoogleDriveAppData({
        accessToken: token,
        grantedScope: ramSecrets.gdriveScope || undefined,
        localPayload: payload,
        passphrase,
        mode,
      });
      setSyncGoogleCallout(null);
    } else if (provider === 'githubGist') {
      const token = (byId('sync-gist-token')?.value || ramSecrets.gistToken || '').trim();
      const gistId = (byId('sync-gist-id')?.value || '').trim();
      ramSecrets.gistToken = token;
      store.saveUiPrefs({ syncProvider: 'githubGist', githubGistId: gistId, useCustomPassphrase: appState.useCustomPassphrase });
      result = await syncWithGithubGist({
        token,
        gistId: gistId || undefined,
        localPayload: payload,
        passphrase,
        mode,
      });
      if (result.gistId) {
        const gistInput = byId('sync-gist-id');
        if (gistInput) gistInput.value = result.gistId;
        store.saveUiPrefs({ githubGistId: result.gistId });
      }
    } else {
      const url = (byId('sync-webdav-url')?.value || '').trim();
      const username = (byId('sync-webdav-user')?.value || '').trim();
      const password = byId('sync-webdav-pass')?.value || ramSecrets.webdavPassword || '';
      ramSecrets.webdavPassword = password;
      store.saveUiPrefs({ syncProvider: 'webdav', webdavUrl: url, webdavUsername: username, useCustomPassphrase: appState.useCustomPassphrase });
      result = await syncWithWebDav({
        url,
        username,
        password,
        localPayload: payload,
        passphrase,
        mode,
      });
    }

    await store.savePayload(result.payload);
    store.saveUiPrefs({ lastSyncedAtMs: result.syncedAtMs || Date.now() });
    appState.syncInFlight = false;
    appState.cloudAutoSyncState = 'idle';
    renderAllViews();

    const p = result.payload;
    const summary = `Sync (${mode}) complete via ${PROVIDER_LABELS[provider]} at ${new Date(result.syncedAtMs).toLocaleTimeString()} — ${(p.hosts || []).length} hosts, ${(p.totp || []).length} 2FA, ${(p.credentials || []).length} credentials.`;
    if (statusMsg) statusMsg.textContent = summary;
    if (provider === 'googleDrive') {
      setSyncGoogleCallout({
        tone: 'ok',
        title: 'Encrypted Sync Complete',
        text: `${(p.hosts || []).length} hosts, ${(p.totp || []).length} 2FA tokens, and ${(p.credentials || []).length} credentials synced with Google Drive AppData.`,
      });
    }
    if (!isBackground) {
      showToast(`${PROVIDER_LABELS[provider]} sync complete.`, 'ok');
    }
  } catch (err) {
    appState.cloudAutoSyncState = 'error';
    const msg = err instanceof Error ? err.message : String(err);
    if (statusMsg) statusMsg.textContent = `Sync failed: ${msg}`;
    if (provider === 'googleDrive') {
      if (err instanceof VaultCoreError && err.code === 'gdrive-missing-scope') {
        setSyncGoogleCallout({
          tone: 'warn',
          title: 'Google Drive Permission Needed',
          text: 'Tick "See, create, and delete its own configuration data in your Google Drive" to complete sync.',
          showGrant: true,
        });
      } else if (err instanceof VaultCoreError && err.code === 'gdrive-http-401') {
        ramSecrets.gdriveToken = '';
        ramSecrets.gdriveScope = '';
        renderGoogleDriveStudioState();
        setSyncGoogleCallout({
          tone: 'warn',
          title: 'Google Session Expired',
          text: 'Your temporary browser OAuth token expired. Click Reconnect or Sync to refresh authorization.',
        });
      } else {
        setSyncGoogleCallout({ tone: 'danger', title: 'Google Drive Sync Failed', text: msg });
      }
    }
    if (
      !isBackground ||
      (err instanceof VaultCoreError && (err.code === 'gdrive-http-401' || err.code === 'gdrive-missing-scope'))
    ) {
      showToast(msg, 'danger');
    }
  } finally {
    appState.syncInFlight = false;
    updateSecurityPill();
    if (appState.cloudAutoSyncQueuedAgain) {
      appState.cloudAutoSyncQueuedAgain = false;
      scheduleCloudAutoSync(400);
    }
  }
}

async function handleReturningGoogleUnlock(options = {}) {
  if (appState.gdriveAuthInFlight) return;
  setAlert('lock-error', '');
  setAlert('lock-info', '');
  const scopeCallout = byId('returning-gdrive-scope-callout');
  if (scopeCallout) scopeCallout.hidden = true;

  const prefs = store.getUiPrefs();
  const clientId = resolveGoogleWebOAuthClientId(prefs.googleClientId);
  if (!clientId) {
    byId('lock-returning-panel').hidden = true;
    byId('lock-onboarding-panel').hidden = false;
    switchOnboardTab('cloud');
    const originEl = byId('onboard-gdrive-origin');
    if (originEl) originEl.textContent = getCurrentWebOrigin();
    const setupNote = byId('onboard-gdrive-setup-note');
    if (setupNote) setupNote.hidden = false;
    const adv = byId('onboard-gdrive-advanced');
    if (adv) adv.open = true;
    byId('onboard-gdrive-client-id')?.focus();
    return;
  }

  const unlockBtn = byId('btn-returning-google-unlock');
  const unlockLabel = byId('btn-returning-google-unlock-label');
  const grantBtn = byId('btn-returning-gdrive-grant');
  const expectedEmail = String(options.loginHint || prefs.googleAccountEmail || '').trim();

  appState.gdriveAuthInFlight = true;
  if (unlockBtn) unlockBtn.disabled = true;
  if (grantBtn) grantBtn.disabled = true;
  if (unlockLabel) unlockLabel.textContent = 'Unlocking & Syncing with Google...';

  try {
    const tokenRes = await requestGoogleWebAccessToken({
      clientId,
      loginHint: expectedEmail,
      prompt: options.prompt || '',
    });
    ramSecrets.gdriveToken = tokenRes.accessToken;
    ramSecrets.gdriveScope = tokenRes.grantedScope;

    const userInfo = await fetchGoogleUserInfo(tokenRes.accessToken);
    const email = userInfo.email || expectedEmail;
    const displayName = userInfo.displayName || prefs.googleAccountName || '';
    ramSecrets.gdriveEmail = email;
    ramSecrets.gdriveDisplayName = displayName;

    if (!tokenRes.hasAppDataScope) {
      appState.returningGdrivePendingEmail = email;
      const scopeText = byId('returning-gdrive-scope-text');
      if (scopeText) {
        scopeText.textContent =
          `Signed in as ${email || 'your Google account'}, but Google Drive AppData permission was left unchecked. Click below to grant access and unlock your vault.`;
      }
      if (scopeCallout) scopeCallout.hidden = false;
      return;
    }

    const accountKey = deriveGoogleAccountBoundPassphrase(email);
    let syncRes;
    try {
      syncRes = await unlockOrSyncGoogleVault({
        vaultStore: store,
        accessToken: tokenRes.accessToken,
        grantedScope: tokenRes.grantedScope,
        passphrase: accountKey,
      });
    } catch (syncErr) {
      if (syncErr instanceof VaultCoreError && syncErr.code === 'gdrive-missing-scope') {
        appState.returningGdrivePendingEmail = email;
        if (scopeCallout) scopeCallout.hidden = false;
        return;
      }
      if (syncErr instanceof VaultCoreError && syncErr.code === 'decrypt-failed') {
        setAlert(
          'lock-error',
          'This Google Drive vault uses a Custom E2EE Passphrase. Click "Switch Account / Cloud" and toggle Custom E2EE Passphrase ON.',
        );
        return;
      }
      throw syncErr;
    }

    store.saveUiPrefs({
      syncProvider: 'googleDrive',
      vaultAuthMode: 'googleAccount',
      googleAccountEmail: email,
      googleAccountName: displayName,
      useCustomPassphrase: false,
      lastSyncedAtMs: syncRes.syncedAtMs,
    });
    enterUnlockedShell(accountKey);
    const h = (syncRes.payload.hosts || []).length;
    const t = (syncRes.payload.totp || []).length;
    showToast(
      syncRes.mergedLocal
        ? `Unlocked & merged as ${email} — ${h} hosts & ${t} 2FA tokens synced.`
        : `Unlocked & synced as ${email} — ${h} hosts & ${t} 2FA tokens.`,
      'ok',
    );
  } catch (err) {
    setAlert('lock-error', err instanceof Error ? err.message : String(err));
  } finally {
    appState.gdriveAuthInFlight = false;
    if (unlockBtn) unlockBtn.disabled = false;
    if (grantBtn) grantBtn.disabled = false;
    if (unlockLabel) {
      const latestEmail = store.getUiPrefs().googleAccountEmail || expectedEmail;
      unlockLabel.textContent = latestEmail
        ? `Unlock & Sync with Google (${latestEmail})`
        : 'Unlock & Sync with Google';
    }
  }
}

async function handleOnboardGoogleSignIn(options = {}) {
  if (appState.gdriveAuthInFlight) return;
  setAlert('lock-error', '');
  setAlert('lock-info', '');
  const scopeCallout = byId('onboard-gdrive-scope-callout');
  const setupNote = byId('onboard-gdrive-setup-note');
  if (scopeCallout) scopeCallout.hidden = true;
  if (setupNote) setupNote.hidden = true;

  const prefs = store.getUiPrefs();
  const customClientId = (byId('onboard-gdrive-client-id')?.value || '').trim();
  if (customClientId && customClientId !== prefs.googleClientId) {
    store.saveUiPrefs({ googleClientId: customClientId });
  }
  const clientId = resolveGoogleWebOAuthClientId(customClientId || prefs.googleClientId);
  if (!clientId) {
    const originEl = byId('onboard-gdrive-origin');
    if (originEl) originEl.textContent = getCurrentWebOrigin();
    if (setupNote) setupNote.hidden = false;
    const adv = byId('onboard-gdrive-advanced');
    if (adv) adv.open = true;
    byId('onboard-gdrive-client-id')?.focus();
    return;
  }

  let customPass = '';
  if (appState.onboardGdriveCustomPass) {
    customPass = (byId('onboard-gdrive-custom-passphrase')?.value || '').trim();
    if (customPass.length < 4) {
      setAlert('lock-error', 'Custom E2EE passphrase must be at least 4 characters.');
      byId('onboard-gdrive-custom-passphrase')?.focus();
      return;
    }
  }

  const signInBtn = byId('btn-onboard-gdrive-signin');
  const signInLabel = byId('btn-onboard-gdrive-signin-label');
  const grantBtn = byId('btn-onboard-gdrive-grant');
  appState.gdriveAuthInFlight = true;
  if (signInBtn) signInBtn.disabled = true;
  if (grantBtn) grantBtn.disabled = true;
  if (signInLabel) signInLabel.textContent = 'Signing in with Google...';

  try {
    const tokenRes = await requestGoogleWebAccessToken({
      clientId,
      loginHint: options.loginHint || '',
      prompt: options.prompt || '',
    });
    ramSecrets.gdriveToken = tokenRes.accessToken;
    ramSecrets.gdriveScope = tokenRes.grantedScope;

    const userInfo = await fetchGoogleUserInfo(tokenRes.accessToken);
    const email = userInfo.email;
    const displayName = userInfo.displayName;
    ramSecrets.gdriveEmail = email;
    ramSecrets.gdriveDisplayName = displayName;
    if (customClientId && customClientId !== prefs.googleClientId) {
      store.saveUiPrefs({ googleClientId: customClientId });
    }

    if (!tokenRes.hasAppDataScope) {
      appState.onboardGdrivePendingEmail = email;
      const scopeText = byId('onboard-gdrive-scope-text');
      if (scopeText) {
        scopeText.textContent =
          `Signed in as ${email || 'your Google account'}, but Google Drive AppData permission was left unchecked. Click below to grant access and unlock your vault.`;
      }
      if (scopeCallout) scopeCallout.hidden = false;
      return;
    }

    const effectivePass = appState.onboardGdriveCustomPass
      ? customPass
      : deriveGoogleAccountBoundPassphrase(email);

    let syncRes;
    try {
      syncRes = await unlockOrSyncGoogleVault({
        vaultStore: store,
        accessToken: tokenRes.accessToken,
        grantedScope: tokenRes.grantedScope,
        passphrase: effectivePass,
      });
    } catch (syncErr) {
      if (syncErr instanceof VaultCoreError && syncErr.code === 'gdrive-missing-scope') {
        appState.onboardGdrivePendingEmail = email;
        if (scopeCallout) scopeCallout.hidden = false;
        return;
      }
      if (syncErr instanceof VaultCoreError && syncErr.code === 'decrypt-failed' && !appState.onboardGdriveCustomPass) {
        setAlert(
          'lock-error',
          'This Google Drive vault uses a Custom E2EE Passphrase. Toggle "Custom E2EE Passphrase" ON, enter it, and sign in again.',
        );
        return;
      }
      throw syncErr;
    }

    if (appState.onboardGdriveCustomPass) {
      ramSecrets.customSyncPassphrase = customPass;
    }
    store.saveUiPrefs({
      syncProvider: 'googleDrive',
      vaultAuthMode: appState.onboardGdriveCustomPass ? 'passphrase' : 'googleAccount',
      googleAccountEmail: email,
      googleAccountName: displayName,
      useCustomPassphrase: appState.onboardGdriveCustomPass,
      lastSyncedAtMs: syncRes.syncedAtMs,
      activeView: 'connections',
    });
    enterUnlockedShell(effectivePass);
    const h = (syncRes.payload.hosts || []).length;
    const t = (syncRes.payload.totp || []).length;
    showToast(
      syncRes.createdFresh
        ? `Signed in as ${email} — created encrypted Google Drive vault.`
        : syncRes.mergedLocal
          ? `Signed in as ${email} — merged local & cloud vault (${h} hosts, ${t} 2FA).`
          : `Signed in as ${email} — unlocked ${h} hosts & ${t} 2FA tokens.`,
      'ok',
    );
  } catch (err) {
    setAlert('lock-error', err instanceof Error ? err.message : String(err));
  } finally {
    appState.gdriveAuthInFlight = false;
    if (signInBtn) signInBtn.disabled = false;
    if (grantBtn) grantBtn.disabled = false;
    if (signInLabel) signInLabel.textContent = 'Sign in with Google';
  }
}

async function handleOnboardGoogleManualPull() {
  setAlert('lock-error', '');
  const token = (byId('onboard-gdrive-token')?.value || '').trim();
  if (!token) {
    setAlert('lock-error', 'Paste a Google OAuth Access Token (ya29...) or use 1-Click Sign in with Google above.');
    return;
  }
  let email = (byId('onboard-gdrive-email')?.value || '').trim();
  let displayName = '';
  if (!email) {
    try {
      const info = await fetchGoogleUserInfo(token);
      email = info.email;
      displayName = info.displayName;
    } catch {
      // Allow manual custom passphrase without userinfo scope
    }
  }
  const customPass = appState.onboardGdriveCustomPass
    ? (byId('onboard-gdrive-custom-passphrase')?.value || '').trim()
    : '';
  const effectivePass =
    customPass.length >= 4
      ? customPass
      : email
        ? deriveGoogleAccountBoundPassphrase(email)
        : '';
  if (effectivePass.length < 4) {
    setAlert('lock-error', 'Enter your Google Account Email or toggle Custom E2EE Passphrase ON (min 4 chars).');
    return;
  }
  const btn = byId('btn-onboard-gdrive-manual-submit');
  if (btn) btn.disabled = true;
  try {
    const syncRes = await unlockOrSyncGoogleVault({
      vaultStore: store,
      accessToken: token,
      grantedScope: '',
      passphrase: effectivePass,
    });
    ramSecrets.gdriveToken = token;
    ramSecrets.gdriveEmail = email;
    ramSecrets.gdriveDisplayName = displayName;
    store.saveUiPrefs({
      syncProvider: 'googleDrive',
      vaultAuthMode: appState.onboardGdriveCustomPass || !email ? 'passphrase' : 'googleAccount',
      googleAccountEmail: email,
      googleAccountName: displayName,
      useCustomPassphrase: appState.onboardGdriveCustomPass,
      lastSyncedAtMs: syncRes.syncedAtMs,
      activeView: 'connections',
    });
    enterUnlockedShell(effectivePass);
    showToast('Unlocked encrypted vault from Google Drive.', 'ok');
  } catch (err) {
    setAlert('lock-error', err instanceof Error ? err.message : String(err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleStudioGoogleSignIn(options = {}) {
  if (appState.gdriveAuthInFlight) return false;
  setSyncGoogleCallout(null);

  const prefs = store.getUiPrefs();
  const customClientId = (byId('sync-gdrive-client-id')?.value || '').trim();
  if (customClientId && customClientId !== prefs.googleClientId) {
    store.saveUiPrefs({ googleClientId: customClientId });
  }
  const clientId = resolveGoogleWebOAuthClientId(customClientId || prefs.googleClientId);
  if (!clientId) {
    setSyncGoogleCallout({
      tone: 'info',
      title: 'Web OAuth Client ID Setup',
      text:
        `Add ${getCurrentWebOrigin()} as an Authorized JavaScript origin in GCP project ${GOOGLE_CLOUD_PROJECT_NUMBER} (Web application — no Client Secret needed), then paste the Client ID under Advanced below or set BUILTIN_GOOGLE_WEB_CLIENT_ID in web-oauth-config.js.`,
    });
    const adv = byId('sync-gdrive-advanced');
    if (adv) adv.open = true;
    byId('sync-gdrive-client-id')?.focus();
    return false;
  }

  const signInBtn = byId('btn-sync-gdrive-signin');
  const signInLabel = byId('btn-sync-gdrive-signin-label');
  const reconnectBtn = byId('btn-sync-gdrive-reconnect');
  const grantBtn = byId('btn-sync-gdrive-grant');
  appState.gdriveAuthInFlight = true;
  if (signInBtn) signInBtn.disabled = true;
  if (reconnectBtn) reconnectBtn.disabled = true;
  if (grantBtn) grantBtn.disabled = true;
  if (signInLabel) signInLabel.textContent = 'Signing in with Google...';

  try {
    const tokenRes = await requestGoogleWebAccessToken({
      clientId,
      loginHint: options.loginHint || '',
      prompt: options.prompt || '',
    });
    ramSecrets.gdriveToken = tokenRes.accessToken;
    ramSecrets.gdriveScope = tokenRes.grantedScope;

    const userInfo = await fetchGoogleUserInfo(tokenRes.accessToken);
    const email = userInfo.email;
    const displayName = userInfo.displayName;
    ramSecrets.gdriveEmail = email;
    ramSecrets.gdriveDisplayName = displayName;
    const gEmailInput = byId('sync-gdrive-email');
    if (gEmailInput && email) gEmailInput.value = email;

    store.saveUiPrefs({
      syncProvider: 'googleDrive',
      vaultAuthMode: appState.useCustomPassphrase
        ? 'passphrase'
        : email
          ? 'googleAccount'
          : store.getUiPrefs().vaultAuthMode,
      googleAccountEmail: email,
      googleAccountName: displayName,
      googleClientId: customClientId || prefs.googleClientId,
    });
    renderGoogleDriveStudioState();
    updateSecurityPill();

    if (!tokenRes.hasAppDataScope) {
      setSyncGoogleCallout({
        tone: 'warn',
        title: 'Google Drive Permission Needed',
        text: 'Google Drive AppData permission was not ticked. Click Grant Drive Access & Sync to authorize and sync your encrypted vault.',
        showGrant: true,
      });
      return false;
    }

    if (options.autoSyncMode) {
      appState.gdriveAuthInFlight = false;
      await runCloudSync(options.autoSyncMode);
    } else {
      setSyncGoogleCallout({
        tone: 'ok',
        title: 'Google Account Connected',
        text: `Signed in as ${email || 'Google account'}. Click Smart Merge Sync to synchronize your encrypted vault.`,
      });
      showToast(`Signed in as ${email || 'Google account'}.`, 'ok');
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setSyncGoogleCallout({ tone: 'danger', title: 'Google Sign-In Failed', text: msg });
    showToast(msg, 'danger');
    return false;
  } finally {
    appState.gdriveAuthInFlight = false;
    if (signInBtn) signInBtn.disabled = false;
    if (reconnectBtn) reconnectBtn.disabled = false;
    if (grantBtn) grantBtn.disabled = false;
    if (signInLabel) signInLabel.textContent = 'Sign in with Google';
  }
}

function handleStudioGoogleDisconnect() {
  ramSecrets.gdriveToken = '';
  ramSecrets.gdriveScope = '';
  ramSecrets.gdriveEmail = '';
  ramSecrets.gdriveDisplayName = '';
  const gToken = byId('sync-gdrive-token');
  if (gToken) gToken.value = '';
  const gEmail = byId('sync-gdrive-email');
  if (gEmail) gEmail.value = '';
  store.saveUiPrefs({ googleAccountEmail: '', googleAccountName: '' });
  setSyncGoogleCallout(null);
  renderGoogleDriveStudioState();
  updateSecurityPill();
  const statusMsg = byId('sync-status-message');
  if (statusMsg) statusMsg.textContent = 'Disconnected Google account. Local encrypted vault remains sealed in browser storage.';
  showToast('Disconnected Google Drive account.', 'ok');
}

async function handleExportJvault() {
  if (!store.isUnlocked()) return;
  try {
    const sealed = await store.exportEnvelope();
    const blob = new Blob([sealed], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `jaladesk-vault-${dateStamp}.jvault`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Exported jaladesk-vault-${dateStamp}.jvault`, 'ok');
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'danger');
  }
}

/* ==========================================================================
   View 5 — Self-Hosted Web Gateway (Live JSR1 Binary WS Studio + Multi-Tabs)
   ========================================================================== */

const MAX_SESSION_SSH_CHARS = 240_000;

function makeGatewaySessionId(hostId) {
  return `sess_${String(hostId || '__demo__')}`;
}

function getActiveGatewaySession() {
  if (!appState.activeGatewaySessionId) return null;
  return appState.gatewaySessions.find((s) => s.id === appState.activeGatewaySessionId) || null;
}

function appendSessionSshChunk(session, chunk) {
  if (!session || !chunk) return;
  const str = String(chunk);
  session.sshChunks.push(str);
  session.sshChars = (session.sshChars || 0) + str.length;
  while (session.sshChunks.length > 1 && session.sshChars > MAX_SESSION_SSH_CHARS) {
    const removed = session.sshChunks.shift();
    session.sshChars -= removed ? removed.length : 0;
  }
}

function resolveSessionDescriptor(hostId) {
  const cleanId = String(hostId || '__demo__');
  if (cleanId === '__demo__') {
    return {
      hostId: '__demo__',
      name: 'Demo Session',
      protocol: 'demo',
      targetLabel: 'DEMO',
    };
  }
  const payload = getPayloadSafe();
  const hosts = payload && Array.isArray(payload.hosts) ? payload.hosts : [];
  const host = hosts.find((h) => String(h.id) === cleanId);
  if (!host) {
    return {
      hostId: cleanId,
      name: cleanId,
      protocol: 'ssh',
      targetLabel: cleanId,
    };
  }
  const proto = String(host.protocol || 'rdp').toLowerCase();
  const safeProto = ['rdp', 'vnc', 'ssh', 'sftp', 'hypervisor'].includes(proto) ? proto : 'ssh';
  const port = Number(host.port) || DEFAULT_PORTS[safeProto] || 22;
  return {
    hostId: cleanId,
    name: String(host.name || host.address || 'Host'),
    protocol: safeProto,
    targetLabel: `${safeProto.toUpperCase()} · ${host.name || host.address}:${port}`,
  };
}

function renderGatewaySessionTabs() {
  const bar = byId('gateway-session-tabs');
  if (!bar) return;
  bar.replaceChildren();

  if (appState.gatewaySessions.length === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  for (const sess of appState.gatewaySessions) {
    const isActive = sess.id === appState.activeGatewaySessionId;
    const safeProto = ['rdp', 'vnc', 'ssh', 'sftp', 'hypervisor', 'demo'].includes(sess.protocol) ? sess.protocol : 'ssh';
    const dotTone =
      sess.status === 'live'
        ? 'ok'
        : sess.status === 'preview' || sess.status === 'connecting'
          ? 'warn'
          : 'idle';

    const tab = el('div', `session-tab${isActive ? ' is-active' : ''}`);
    tab.dataset.sessionId = sess.id;

    const selectBtn = el('button', 'session-tab-select');
    selectBtn.type = 'button';
    selectBtn.setAttribute('role', 'tab');
    selectBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    selectBtn.title = `${sess.protocol.toUpperCase()} · ${sess.name} (${sess.status})`;

    const dot = el('span', `status-dot status-dot-${dotTone}`);
    dot.setAttribute('aria-hidden', 'true');
    selectBtn.appendChild(dot);
    selectBtn.appendChild(el('span', `session-tab-proto proto-${safeProto} mono`, sess.protocol.toUpperCase()));
    selectBtn.appendChild(el('span', 'session-tab-name', sess.name));
    selectBtn.addEventListener('click', () => {
      activateGatewaySessionTab(sess.id);
    });
    tab.appendChild(selectBtn);

    const closeBtn = el('button', 'session-tab-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', `Close ${sess.name} session tab`);
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeGatewaySessionTab(sess.id);
    });
    tab.appendChild(closeBtn);

    bar.appendChild(tab);
  }
}

function detachPreviewRuntime(previewState) {
  if (!previewState) return;
  if (previewState.timerId) {
    clearInterval(previewState.timerId);
    previewState.timerId = null;
  }
  const canvas = byId('gateway-canvas');
  if (canvas && Array.isArray(previewState.listeners)) {
    for (const [evt, fn] of previewState.listeners) {
      canvas.removeEventListener(evt, fn);
    }
  }
}

function reattachPreviewRuntime(previewState) {
  if (!previewState) return;
  const canvas = byId('gateway-canvas');
  if (canvas && Array.isArray(previewState.listeners)) {
    for (const [evt, fn] of previewState.listeners) {
      canvas.removeEventListener(evt, fn);
      canvas.addEventListener(evt, fn);
    }
  }
  renderGatewayPreviewCanvas();
  if (!previewState.timerId) {
    previewState.timerId = setInterval(() => {
      if (!appState.gatewayPreviewActive || appState.gatewayPreviewState !== previewState) return;
      renderGatewayPreviewCanvas();
    }, 1000);
  }
}

function snapshotActiveGatewaySession() {
  const prev = getActiveGatewaySession();
  if (!prev) return;

  prev.activePane = appState.gatewayPane || prev.activePane;
  prev.scaleMode = appState.gatewayScaleMode || prev.scaleMode;
  prev.sftpPath = appState.gatewaySftpPath || prev.sftpPath;
  prev.viewOnly = appState.gatewayViewOnly;
  prev.sshCols = appState.gatewaySshCols || prev.sshCols;
  prev.sshRows = appState.gatewaySshRows || prev.sshRows;

  const canvasEl = byId('gateway-canvas');
  if (prev.client) {
    try {
      prev.client.detachCanvasInput();
      if (canvasEl && canvasEl.width > 0 && canvasEl.height > 0) {
        if (!prev.backingCanvas) {
          prev.backingCanvas = document.createElement('canvas');
        }
        prev.backingCanvas.width = canvasEl.width;
        prev.backingCanvas.height = canvasEl.height;
        const bCtx = prev.backingCanvas.getContext('2d', { alpha: false });
        if (bCtx) bCtx.drawImage(canvasEl, 0, 0);
        if (typeof prev.client.setCanvas === 'function') {
          prev.client.setCanvas(prev.backingCanvas);
        }
      }
    } catch {
      // Ignore snapshot error on detached canvas
    }
  }

  if (prev.previewState) {
    detachPreviewRuntime(prev.previewState);
  }
}

function openOrFocusGatewaySessionTab(hostId) {
  const cleanHostId = String(hostId || '__demo__');
  const sessionId = makeGatewaySessionId(cleanHostId);
  const existing = appState.gatewaySessions.find((s) => s.id === sessionId);
  const desc = resolveSessionDescriptor(cleanHostId);

  if (existing) {
    existing.name = desc.name;
    existing.protocol = desc.protocol;
    if (!existing.targetLabel) existing.targetLabel = desc.targetLabel;
    if (appState.activeGatewaySessionId !== existing.id) {
      snapshotActiveGatewaySession();
      appState.activeGatewaySessionId = existing.id;
    }
    renderGatewaySessionTabs();
    return existing;
  }

  snapshotActiveGatewaySession();
  const created = {
    id: sessionId,
    hostId: desc.hostId,
    name: desc.name,
    protocol: desc.protocol,
    status: 'ready',
    activePane: resolveInitialGatewayPane(desc.protocol),
    scaleMode: appState.gatewayScaleMode || 'fit',
    viewOnly: appState.gatewayViewOnly,
    hasControl: !appState.gatewayViewOnly,
    targetLabel: desc.targetLabel,
    sftpPath: '/',
    sshChunks: [],
    sshChars: 0,
    sshCols: appState.gatewaySshCols || 100,
    sshRows: appState.gatewaySshRows || 30,
    metrics: { fps: 0, rttMs: 0, kbPerSec: 0, tilesDecoded: 0 },
    client: null,
    previewState: null,
    backingCanvas: null,
  };
  appState.gatewaySessions.push(created);
  appState.activeGatewaySessionId = created.id;
  renderGatewaySessionTabs();
  return created;
}

function activateGatewaySessionTab(sessionId) {
  const target = appState.gatewaySessions.find((s) => s.id === sessionId);
  if (!target) return;

  if (appState.activeGatewaySessionId && appState.activeGatewaySessionId !== target.id) {
    snapshotActiveGatewaySession();
  }
  appState.activeGatewaySessionId = target.id;
  appState.gatewayTargetHostId = target.hostId;
  appState.gatewayClient = target.client || null;
  appState.gatewayPreviewState = target.previewState || null;
  appState.gatewayPreviewActive = Boolean(target.previewState);
  appState.gatewaySessionProtocol = target.protocol;
  appState.gatewayTargetLabel = target.targetLabel;
  appState.gatewaySftpPath = target.sftpPath || '/';
  appState.gatewayScaleMode = target.scaleMode || 'fit';

  const select = byId('gateway-host-select');
  if (select && Array.from(select.options).some((o) => o.value === target.hostId)) {
    select.value = target.hostId;
  }
  updateGatewayTargetBadge();

  // Restore SSH terminal buffer cleanly for this session tab
  const term = ensureSshTerminal();
  term.reset();
  for (const chunk of target.sshChunks) {
    term.write(chunk);
  }
  appState.gatewaySshBuffer = term.renderText(false);
  const sftpPathInput = byId('gateway-sftp-path');
  if (sftpPathInput) sftpPathInput.value = target.sftpPath || '/';

  const liveStage = byId('gateway-live-stage');
  const previewBanner = byId('gateway-preview-banner');
  const toggleBtn = byId('btn-gateway-toggle-setup');
  const connBtn = byId('btn-gateway-connect');
  const discBtn = byId('btn-gateway-disconnect');
  const hudTarget = byId('hud-target-badge');
  const canvasEl = byId('gateway-canvas');

  if (target.client && target.client.connected) {
    if (liveStage) liveStage.hidden = false;
    if (previewBanner) previewBanner.hidden = true;
    if (toggleBtn) toggleBtn.hidden = false;
    if (connBtn) connBtn.disabled = true;
    if (discBtn) discBtn.disabled = false;
    setGatewaySetupVisible(false);
    setGatewayStatus('CONNECTED', 'ok');
    syncGatewayPaneTabsForProtocol(target.protocol);
    if (canvasEl && target.backingCanvas) {
      canvasEl.width = target.backingCanvas.width;
      canvasEl.height = target.backingCanvas.height;
      const ctx = canvasEl.getContext('2d', { alpha: false });
      if (ctx) ctx.drawImage(target.backingCanvas, 0, 0);
    }
    if (canvasEl && typeof target.client.setCanvas === 'function') {
      target.client.setCanvas(canvasEl);
    }
    if (canvasEl && (target.activePane === 'desktop' || target.protocol === 'demo')) {
      target.client.attachCanvasInput(canvasEl, () => appState.gatewayScaleMode);
    }
    if (hudTarget) {
      hudTarget.textContent =
        target.activePane === 'ssh'
          ? `${target.targetLabel} · ${target.sshCols}×${target.sshRows}`
          : target.targetLabel;
    }
    updateGatewayControlUi(Boolean(target.hasControl), Boolean(target.viewOnly));
    updateGatewayHudMetrics(target.metrics || { fps: 0, rttMs: 0, kbPerSec: 0, tilesDecoded: 0 });
    setGatewayScaleMode(target.scaleMode || 'fit');
    setGatewayPane(target.activePane || resolveInitialGatewayPane(target.protocol));
  } else if (target.previewState) {
    if (liveStage) liveStage.hidden = false;
    if (previewBanner) previewBanner.hidden = false;
    if (toggleBtn) toggleBtn.hidden = false;
    if (connBtn) connBtn.disabled = false;
    if (discBtn) discBtn.disabled = false;
    setGatewaySetupVisible(false);
    setGatewayStatus('OFFLINE PREVIEW', 'warn');
    syncGatewayPaneTabsForProtocol(target.protocol);
    if (hudTarget) {
      hudTarget.textContent =
        target.activePane === 'ssh'
          ? `PREVIEW · ${target.targetLabel} · ${target.sshCols}×${target.sshRows}`
          : `PREVIEW · ${target.targetLabel} · 1280×720`;
    }
    updateGatewayControlUi(!target.viewOnly, Boolean(target.viewOnly));
    updateGatewayHudMetrics(target.metrics || { fps: 30, rttMs: 1, kbPerSec: 162, tilesDecoded: target.previewState.tilesDecoded || 14 });
    setGatewayScaleMode(target.scaleMode || 'fit');
    reattachPreviewRuntime(target.previewState);
    renderGatewayPreviewSftpList();
    setGatewayPane(target.activePane || resolveInitialGatewayPane(target.protocol));
  } else {
    if (liveStage) liveStage.hidden = true;
    if (previewBanner) previewBanner.hidden = true;
    if (toggleBtn) toggleBtn.hidden = true;
    if (connBtn) connBtn.disabled = target.status === 'connecting';
    if (discBtn) discBtn.disabled = target.status !== 'connecting';
    setGatewaySetupVisible(true);
    setGatewayStatus(target.status === 'connecting' ? 'CONNECTING' : 'DISCONNECTED', target.status === 'connecting' ? 'warn' : 'idle');
  }

  renderGatewaySessionTabs();
}

function disposeGatewaySessionResources(sess, sendClose = true) {
  if (!sess) return;
  if (sess.previewState) {
    detachPreviewRuntime(sess.previewState);
    sess.previewState = null;
  }
  if (sess.client) {
    try {
      sess.client.detachCanvasInput();
      sess.client.disconnect(sendClose);
    } catch {
      // Ignore cleanup error
    }
    sess.client = null;
  }
  sess.sshChunks.length = 0;
  sess.sshChars = 0;
  sess.backingCanvas = null;
  sess.status = 'disconnected';
}

function closeGatewaySessionTab(sessionId, options = {}) {
  const idx = appState.gatewaySessions.findIndex((s) => s.id === sessionId);
  if (idx < 0) return;
  const [removed] = appState.gatewaySessions.splice(idx, 1);
  const wasActive = appState.activeGatewaySessionId === removed.id;

  disposeGatewaySessionResources(removed, !options.silent);

  if (wasActive) {
    appState.gatewayClient = null;
    appState.gatewayPreviewActive = false;
    appState.gatewayPreviewState = null;
    appState.activeGatewaySessionId = null;

    if (appState.gatewaySessions.length > 0) {
      const nextTab = appState.gatewaySessions[Math.min(idx, appState.gatewaySessions.length - 1)];
      activateGatewaySessionTab(nextTab.id);
    } else {
      const connBtn = byId('btn-gateway-connect');
      const discBtn = byId('btn-gateway-disconnect');
      if (connBtn) connBtn.disabled = false;
      if (discBtn) discBtn.disabled = true;
      setGatewayStatus('DISCONNECTED', 'idle');
      resetGatewayLiveDom();
      renderGatewaySessionTabs();
    }
  } else {
    renderGatewaySessionTabs();
  }
}

function closeAllGatewaySessionTabs() {
  for (const sess of appState.gatewaySessions) {
    disposeGatewaySessionResources(sess, false);
  }
  appState.gatewaySessions = [];
  appState.activeGatewaySessionId = null;
  disconnectGatewaySession(true);
  renderGatewaySessionTabs();
}

function setGatewayDeployTab(tabKey) {
  const key = Object.hasOwn(GATEWAY_DEPLOY_TABS, tabKey) ? tabKey : 'desktop';
  const spec = GATEWAY_DEPLOY_TABS[key];
  appState.deployTab = key;
  setSegmentedValue(byId('gateway-deploy-tabs'), 'data-deploy-tab', key);
  const hint = byId('gateway-deploy-hint');
  const code = byId('gateway-deploy-code');
  if (hint) hint.textContent = spec.hint;
  if (code) code.textContent = spec.snippet;
}

function setGatewayAuthMode(mode) {
  appState.gatewayAuthMode = mode === 'token' ? 'token' : 'pairing';
  setSegmentedValue(byId('gateway-auth-mode'), 'data-gateway-auth', appState.gatewayAuthMode);
  const pairWrap = byId('gateway-pairing-wrap');
  const tokWrap = byId('gateway-token-wrap');
  if (pairWrap) pairWrap.hidden = appState.gatewayAuthMode !== 'pairing';
  if (tokWrap) tokWrap.hidden = appState.gatewayAuthMode !== 'token';
}

function setGatewayStatus(label, tone = 'idle') {
  const txt = byId('gateway-state-text');
  const dot = byId('gateway-state-dot');
  const hudDot = byId('hud-live-dot');
  if (txt) txt.textContent = label;
  if (dot) dot.className = `status-dot status-dot-${tone}`;
  if (hudDot) hudDot.className = `status-dot status-dot-${tone}`;
}

function setGatewaySetupVisible(visible) {
  appState.gatewaySetupVisible = Boolean(visible);
  const setupGrid = byId('gateway-setup-grid');
  const toggleBtn = byId('btn-gateway-toggle-setup');
  if (setupGrid) setupGrid.hidden = !appState.gatewaySetupVisible;
  if (toggleBtn) {
    toggleBtn.textContent = appState.gatewaySetupVisible ? 'Hide Setup & Deploy' : 'Show Setup & Deploy';
  }
}

function setGatewayScaleMode(mode) {
  const next = mode === 'fill' || mode === 'native' ? mode : 'fit';
  appState.gatewayScaleMode = next;
  const activeSess = getActiveGatewaySession();
  if (activeSess) activeSess.scaleMode = next;
  setSegmentedValue(byId('gateway-scale-group'), 'data-gateway-scale', next);
  const stage = byId('gateway-canvas-stage');
  if (stage) {
    stage.setAttribute('data-scale', next);
  }
}

function syncGatewayUrlPresetsUi() {
  const urlVal = (byId('gateway-ws-url')?.value || '').trim().toLowerCase();
  const isLocal = urlVal.includes('127.0.0.1') || urlVal.includes('localhost');
  const isHttps = urlVal.startsWith('wss://') || (urlVal.startsWith('https://') && !isLocal);
  const localBtn = byId('btn-gw-preset-local');
  const httpsBtn = byId('btn-gw-preset-https');
  if (localBtn) {
    localBtn.classList.toggle('is-active', isLocal);
    localBtn.setAttribute('aria-pressed', isLocal ? 'true' : 'false');
  }
  if (httpsBtn) {
    httpsBtn.classList.toggle('is-active', !isLocal && isHttps);
    httpsBtn.setAttribute('aria-pressed', !isLocal && isHttps ? 'true' : 'false');
  }
}

function applyGatewayUrlPreset(presetUrl) {
  const urlInput = byId('gateway-ws-url');
  if (!urlInput) return;
  const target = String(presetUrl || '').trim();
  if (!target) return;
  urlInput.value = target;
  syncGatewayUrlPresetsUi();
  if (store.isUnlocked()) {
    store.saveUiPrefs({ gatewayUrl: target });
  }
  if (target === LOCAL_GATEWAY_DEFAULT_URL) {
    probeLocalGatewayHealth({ autoFocusPairing: false });
  } else {
    urlInput.focus();
  }
}

function applyAutoPairedGatewayUi(options = {}) {
  const token = String(ramSecrets.gatewayToken || '').trim();
  if (!token) return;
  setGatewayAuthMode('token');
  const tokInput = byId('gateway-session-token');
  if (tokInput) tokInput.value = token;
  const guidance = byId('gateway-setup-guidance');
  if (guidance) guidance.hidden = true;

  const activeUrl = (byId('gateway-ws-url')?.value || appState.gatewayFragmentUrl || LOCAL_GATEWAY_DEFAULT_URL).trim();
  const pill = byId('gateway-local-probe-pill');
  const dot = byId('gateway-local-probe-dot');
  const textEl = byId('gateway-local-probe-text');
  if (pill) {
    pill.hidden = false;
    pill.className = 'gateway-probe-pill is-ready';
  }
  if (dot) dot.className = 'status-dot status-dot-ok';
  if (textEl) {
    textEl.textContent = `Auto-Paired with Web Gateway (${activeUrl}) — Ready to Connect Live`;
  }
  setAlert(
    'gateway-fragment-notice',
    `Auto-paired with ${activeUrl}. Session token is held in RAM only and scrubbed from browser history.`,
  );
  if (!options.silentToast) {
    showToast('Web Gateway auto-paired (RAM-only token scrubbed from URL).', 'ok');
  }
}

function resolveInitialGatewayPane(protocol) {
  const proto = String(protocol || '').toLowerCase();
  if (proto === 'ssh') return 'ssh';
  if (proto === 'sftp') return 'sftp';
  return 'desktop';
}

function syncGatewayPaneTabsForProtocol(protocol) {
  const tabs = byId('gateway-pane-tabs');
  if (!tabs) return;
  const proto = String(protocol || 'demo').toLowerCase();
  const isTerminalOnly = proto === 'ssh' || proto === 'sftp';
  const isDesktopOnly = proto === 'rdp' || proto === 'vnc' || proto === 'hypervisor';

  for (const btn of tabs.querySelectorAll('[data-gateway-pane]')) {
    const pane = btn.getAttribute('data-gateway-pane');
    if (pane === 'desktop') {
      btn.hidden = isTerminalOnly;
    } else if (pane === 'ssh' || pane === 'sftp') {
      btn.hidden = isDesktopOnly;
    }
  }
}

function updateGatewaySshHud(cols, rows, inAltScreen = false, ptyLabel = '') {
  const dimsEl = byId('hud-ssh-dims');
  const modeEl = byId('hud-ssh-mode');
  if (dimsEl) dimsEl.textContent = `${cols}×${rows}`;
  if (modeEl) {
    modeEl.textContent = inAltScreen ? 'VT100 · ALT SCREEN' : ptyLabel || 'VT100 TUI';
  }
  if (appState.gatewayPane === 'ssh' && appState.gatewayTargetLabel) {
    const hudTarget = byId('hud-target-badge');
    if (hudTarget) {
      const prefix = appState.gatewayPreviewActive ? 'PREVIEW · ' : '';
      hudTarget.textContent = `${prefix}${appState.gatewayTargetLabel} · ${cols}×${rows}`;
    }
  }
}

function ensureSshTerminal() {
  if (!appState.sshTerminal) {
    appState.sshTerminal = new WebVtTerminal({
      cols: appState.gatewaySshCols || 100,
      rows: appState.gatewaySshRows || 30,
      onData: (seq) => {
        dispatchSshTerminalInput(seq);
      },
      onResize: (cols, rows) => {
        appState.gatewaySshCols = cols;
        appState.gatewaySshRows = rows;
        updateGatewaySshHud(cols, rows, Boolean(appState.sshTerminal?.inAltScreen));
        const client = appState.gatewayClient;
        if (client && client.connected && client.canSendInput()) {
          client.sendSshResize(cols, rows);
        }
      },
      onCtrlLatchChange: (active) => {
        const btn = byId('btn-ssh-ctrl-latch');
        if (btn) {
          btn.classList.toggle('is-active', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
      },
      onRender: (term) => {
        const mirror = byId('gateway-ssh-console');
        if (mirror) {
          mirror.textContent = term.renderText(false);
        }
        updateGatewaySshHud(term.cols, term.rows, term.inAltScreen);
      },
    });
  }

  const canvasEl = byId('gateway-ssh-terminal');
  const stageEl = byId('gateway-ssh-stage');
  if (canvasEl && !appState.sshTerminal._canvas) {
    appState.sshTerminal.attach(canvasEl, stageEl || canvasEl.parentElement);
  }
  return appState.sshTerminal;
}

function dispatchSshTerminalInput(seq) {
  if (typeof seq !== 'string' || seq.length === 0) return false;
  if (appState.gatewayPreviewActive) {
    if (appState.gatewayViewOnly) {
      showToast('View-Only mode active. Switch to Interactive to type.', 'danger');
      return false;
    }
    handleGatewayPreviewSshData(seq);
    return true;
  }
  const client = appState.gatewayClient;
  if (!client || !client.connected) return false;
  if (!client.canSendInput()) {
    showToast('View-Only mode active. Take Control to send SSH input.', 'danger');
    return false;
  }
  return client.sendSshData(seq);
}

async function handleSshPasteFromClipboard() {
  const term = ensureSshTerminal();
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
    showToast('Press Cmd+V / Ctrl+V directly inside the terminal to paste.', 'warn');
    term.focus();
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      showToast('Clipboard is empty.', 'warn');
      term.focus();
      return;
    }
    term.pasteText(text);
    term.focus();
  } catch {
    showToast('Clipboard read blocked — press Cmd+V / Ctrl+V inside the terminal.', 'warn');
    term.focus();
  }
}

function setGatewayPane(pane) {
  const next = pane === 'ssh' || pane === 'sftp' ? pane : 'desktop';
  const isDesktop = next === 'desktop';
  const isSsh = next === 'ssh';
  const isSftp = next === 'sftp';

  appState.gatewayPane = next;
  const activeSess = getActiveGatewaySession();
  if (activeSess) activeSess.activePane = next;
  setSegmentedValue(byId('gateway-pane-tabs'), 'data-gateway-pane', next);

  const stage = byId('gateway-live-stage');
  if (stage) stage.dataset.activePane = next;

  const desk = byId('gateway-desktop-pane');
  const ssh = byId('gateway-ssh-pane');
  const sftp = byId('gateway-sftp-pane');
  const scaleGroup = byId('gateway-scale-group');
  const cadBtn = byId('btn-gateway-cad');
  const ctrlToggle = byId('btn-gateway-control-toggle');
  const pasteBtn = byId('btn-gateway-ssh-paste');
  const totpGroup = byId('gateway-totp-autotype-group');
  const deskTelemetry = byId('gateway-telemetry-strip');
  const sshTelemetry = byId('gateway-ssh-telemetry-strip');

  if (desk) desk.hidden = !isDesktop;
  if (ssh) ssh.hidden = !isSsh;
  if (sftp) sftp.hidden = !isSftp;

  // Hide RDP/VNC-only controls on SSH & SFTP; show SSH-relevant controls on SSH
  if (scaleGroup) scaleGroup.hidden = !isDesktop;
  if (cadBtn) cadBtn.hidden = !isDesktop;
  if (ctrlToggle) ctrlToggle.hidden = !isDesktop;
  if (deskTelemetry) deskTelemetry.hidden = !isDesktop;
  if (sshTelemetry) sshTelemetry.hidden = !isSsh;
  if (pasteBtn) pasteBtn.hidden = !isSsh;
  if (totpGroup) totpGroup.hidden = isSftp;

  if (isSsh) {
    const term = ensureSshTerminal();
    requestAnimationFrame(() => {
      term.fit();
      term.focus();
      updateGatewaySshHud(term.cols, term.rows, term.inAltScreen);
    });
  } else if (isDesktop) {
    requestAnimationFrame(() => {
      byId('gateway-canvas')?.focus({ preventScroll: true });
    });
  } else if (isSftp) {
    if (appState.gatewayClient && appState.gatewayClient.connected) {
      refreshGatewaySftpList();
    } else if (appState.gatewayPreviewActive) {
      renderGatewayPreviewSftpList();
    }
  }
}

function updateGatewayControlUi(hasControl, viewOnly) {
  const stage = byId('gateway-live-stage');
  const canvasStage = byId('gateway-canvas-stage');
  const toggleBtn = byId('btn-gateway-control-toggle');
  const banner = byId('gateway-viewonly-banner');
  const modeBadge = byId('gateway-mode-badge');

  appState.gatewayViewOnly = Boolean(viewOnly || !hasControl);
  setSwitchState(byId('gateway-view-only-switch'), appState.gatewayViewOnly);

  if (stage) {
    stage.dataset.hasControl = hasControl ? 'true' : 'false';
    stage.dataset.viewOnly = appState.gatewayViewOnly ? 'true' : 'false';
  }
  if (canvasStage) {
    canvasStage.classList.toggle('is-view-only', appState.gatewayViewOnly);
  }
  if (banner) {
    banner.hidden = !appState.gatewayViewOnly;
  }
  if (modeBadge) {
    modeBadge.textContent = appState.gatewayViewOnly ? 'VIEW-ONLY OBSERVER' : 'INTERACTIVE';
  }
  if (toggleBtn) {
    const interactive = Boolean(hasControl && !viewOnly);
    toggleBtn.textContent = interactive ? 'Interactive · Release' : 'View-Only · Take Control';
    toggleBtn.setAttribute('aria-pressed', interactive ? 'true' : 'false');
    toggleBtn.classList.toggle('btn-control-active', interactive);
    toggleBtn.classList.toggle('btn-control-viewonly', !interactive);
  }
}

function updateGatewayHudMetrics(metrics) {
  const stage = byId('gateway-live-stage');
  const fpsEl = byId('hud-metric-fps');
  const rttEl = byId('hud-metric-rtt');
  const kbpsEl = byId('hud-metric-kbps');
  const tilesEl = byId('hud-metric-tiles');

  if (fpsEl) fpsEl.textContent = `${metrics.fps} FPS`;
  if (rttEl) rttEl.textContent = `${metrics.rttMs} ms`;
  if (kbpsEl) kbpsEl.textContent = `${metrics.kbPerSec} KB/s`;
  if (tilesEl) tilesEl.textContent = `${metrics.tilesDecoded} ${metrics.tilesDecoded === 1 ? 'tile' : 'tiles'}`;

  if (stage) {
    stage.dataset.tilesDecoded = String(metrics.tilesDecoded);
    stage.dataset.fps = String(metrics.fps);
    stage.dataset.rttMs = String(metrics.rttMs);
    stage.dataset.kbPerSec = String(metrics.kbPerSec);
  }
}

function resetGatewayLiveDom() {
  appState.gatewaySshBuffer = '';
  appState.gatewaySftpPath = '/';
  appState.gatewaySessionProtocol = '';
  appState.gatewayTargetLabel = '';

  const liveStage = byId('gateway-live-stage');
  if (liveStage) {
    liveStage.hidden = true;
    liveStage.dataset.tilesDecoded = '0';
    liveStage.dataset.fps = '0';
    liveStage.dataset.rttMs = '0';
    liveStage.dataset.kbPerSec = '0';
    liveStage.dataset.hasControl = 'false';
    liveStage.dataset.viewOnly = 'false';
    liveStage.dataset.activePane = 'desktop';
  }
  const toggleBtn = byId('btn-gateway-toggle-setup');
  if (toggleBtn) toggleBtn.hidden = true;
  const previewBanner = byId('gateway-preview-banner');
  if (previewBanner) previewBanner.hidden = true;
  syncGatewayPaneTabsForProtocol('demo');
  setGatewaySetupVisible(true);

  const canvas = byId('gateway-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (appState.sshTerminal) {
    appState.sshTerminal.reset();
  }
  const sshConsole = byId('gateway-ssh-console');
  if (sshConsole) sshConsole.textContent = '';
  const sftpList = byId('gateway-sftp-list');
  if (sftpList) sftpList.replaceChildren();
  const sftpPath = byId('gateway-sftp-path');
  if (sftpPath) sftpPath.value = '/';
  const sftpStatus = byId('gateway-sftp-status');
  if (sftpStatus) sftpStatus.textContent = 'Ready. Click Refresh to list files over SFTP.';

  updateGatewayHudMetrics({ fps: 0, rttMs: 0, kbPerSec: 0, tilesDecoded: 0 });
}

function appendGatewayLog(message, tone = 'default') {
  const log = byId('gateway-log');
  if (!log) return;
  const line = el(
    'p',
    `console-line${tone === 'ok' ? ' console-line-ok' : tone === 'warn' ? ' console-line-warn' : tone === 'err' ? ' console-line-err' : ''}`,
    `[${new Date().toLocaleTimeString()}] ${message}`,
  );
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function appendGatewaySshOutput(chunk, sessionOverride = null) {
  if (!chunk) return;
  const targetSession = sessionOverride || getActiveGatewaySession();
  if (targetSession) {
    appendSessionSshChunk(targetSession, chunk);
  }
  if (!sessionOverride || sessionOverride.id === appState.activeGatewaySessionId) {
    const term = ensureSshTerminal();
    term.write(String(chunk));
    appState.gatewaySshBuffer = term.renderText(false);
  }
}

function renderGatewayTotpSelect() {
  const select = byId('gateway-totp-select');
  const autoBtn = byId('btn-gateway-autotype-2fa');
  const payload = getPayloadSafe();
  if (!select) return;

  const prev = select.value;
  const tokens = payload && Array.isArray(payload.totp) ? payload.totp : [];
  select.replaceChildren();

  if (tokens.length === 0) {
    const opt = el(
      'option',
      '',
      appState.gatewayPreviewActive ? 'Demo Preview 2FA (RFC 6238)' : 'No 2FA tokens',
    );
    opt.value = appState.gatewayPreviewActive ? '__preview_demo_2fa__' : '';
    select.appendChild(opt);
    if (autoBtn) autoBtn.disabled = !appState.gatewayPreviewActive;
    return;
  }

  for (const item of tokens) {
    const opt = document.createElement('option');
    opt.value = String(item.id);
    const label = [item.issuer, item.accountName || item.label].filter(Boolean).join(' · ') || '2FA Token';
    opt.textContent = label;
    select.appendChild(opt);
  }

  if (prev && tokens.some((t) => String(t.id) === String(prev))) {
    select.value = String(prev);
  }
  if (autoBtn) autoBtn.disabled = false;
}

function renderGatewayTargets() {
  const select = byId('gateway-host-select');
  const payload = getPayloadSafe();
  if (!select || !payload) return;
  const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
  const prev = appState.gatewayTargetHostId || select.value || '__demo__';

  select.replaceChildren();
  const demoOpt = el('option', '', 'Demo Session (Live Synthetic Desktop, SSH & SFTP)');
  demoOpt.value = '__demo__';
  select.appendChild(demoOpt);

  for (const h of hosts) {
    const opt = document.createElement('option');
    opt.value = String(h.id);
    const proto = String(h.protocol || 'rdp').toUpperCase();
    const bastion = h.jumpHostId ? hosts.find((b) => b.id === h.jumpHostId) : null;
    opt.textContent = `[${proto}] ${h.name || h.address} (${h.address}:${h.port || DEFAULT_PORTS[proto.toLowerCase()] || 22})${bastion ? ` via ${bastion.name}` : ''}`;
    select.appendChild(opt);
  }

  if (prev === '__demo__' || hosts.some((h) => String(h.id) === String(prev))) {
    select.value = String(prev);
  } else {
    select.value = '__demo__';
  }
  updateGatewayTargetBadge();
  renderGatewayTotpSelect();
}

function updateSelectedTargetBanner() {
  const banner = byId('gateway-selected-target-banner');
  const protoEl = byId('gateway-selected-target-proto');
  const titleEl = byId('gateway-selected-target-title');
  const subEl = byId('gateway-selected-target-sub');
  const routeEl = byId('gateway-selected-target-route');
  const connectBtn = byId('btn-gateway-connect');

  const selectedId = appState.gatewayTargetHostId || '__demo__';
  if (!banner || selectedId === '__demo__') {
    if (banner) banner.hidden = true;
    if (connectBtn) connectBtn.textContent = 'Connect Live Session';
    clearGatewayRuntimeCredentials();
    return;
  }

  const payload = getPayloadSafe();
  const hosts = payload && Array.isArray(payload.hosts) ? payload.hosts : [];
  const creds = payload && Array.isArray(payload.credentials) ? payload.credentials : [];
  const host = hosts.find((h) => String(h.id) === String(selectedId));
  if (!host) {
    banner.hidden = true;
    if (connectBtn) connectBtn.textContent = 'Connect Live Session';
    clearGatewayRuntimeCredentials();
    return;
  }

  const proto = String(host.protocol || 'rdp').toLowerCase();
  const safeProto = ['rdp', 'vnc', 'ssh', 'sftp', 'hypervisor'].includes(proto) ? proto : 'ssh';
  const port = Number(host.port) || DEFAULT_PORTS[safeProto] || 22;
  const linkedCred = host.credentialId ? creds.find((c) => c.id === host.credentialId) : null;
  const user = String(host.username || (linkedCred && linkedCred.username) || '').trim();
  const endpointStr = `${user ? `${user}@` : ''}${host.address}:${port}`;

  if (protoEl) {
    protoEl.className = `proto-badge proto-${safeProto} mono`;
    protoEl.textContent = proto.toUpperCase();
  }
  if (titleEl) {
    titleEl.textContent = `Ready to connect: ${proto.toUpperCase()} · ${endpointStr}`;
  }
  if (subEl) {
    const label = String(host.name || '').trim();
    subEl.textContent = label && label !== host.address ? label : '';
    subEl.hidden = !subEl.textContent;
  }
  if (routeEl) {
    const bastion = host.jumpHostId ? hosts.find((b) => b.id === host.jumpHostId) : null;
    if (bastion) {
      routeEl.textContent = `via ${bastion.name || bastion.address}`;
      routeEl.hidden = false;
    } else {
      routeEl.textContent = '';
      routeEl.hidden = true;
    }
  }
  if (connectBtn) {
    connectBtn.textContent = `Connect Live · ${host.name || host.address}`;
  }
  banner.hidden = false;
}

async function probeLocalGatewayHealth(options = {}) {
  const autoFocusPairing = Boolean(options.autoFocusPairing);
  const userTriggered = Boolean(options.userTriggered);
  const probeSeq = ++appState.gatewayProbeSeq;

  const pill = byId('gateway-local-probe-pill');
  const dot = byId('gateway-local-probe-dot');
  const textEl = byId('gateway-local-probe-text');
  const guidance = byId('gateway-setup-guidance');
  const checkBtn = byId('btn-check-local-gateway');

  if (userTriggered) {
    if (pill) {
      pill.hidden = false;
      pill.className = 'gateway-probe-pill is-checking';
    }
    if (dot) dot.className = 'status-dot status-dot-idle';
    if (textEl) textEl.textContent = 'Checking Local Gateway (127.0.0.1:8443)...';
    if (checkBtn) {
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking...';
    }
  }

  let reachable = false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = setTimeout(() => {
    if (controller) controller.abort();
  }, LOCAL_GATEWAY_PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(`${LOCAL_GATEWAY_DEFAULT_URL}/healthz`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller ? controller.signal : undefined,
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      reachable = Boolean(body && body.ok === true);
    }
  } catch {
    reachable = false;
  } finally {
    clearTimeout(timeoutId);
  }

  if (probeSeq !== appState.gatewayProbeSeq || !store.isUnlocked()) {
    return reachable;
  }

  appState.gatewayLocalReachable = reachable;
  if (checkBtn) {
    checkBtn.disabled = false;
    checkBtn.textContent = 'Check Local Gateway';
  }

  if (reachable) {
    if (pill) {
      pill.hidden = false;
      pill.className = 'gateway-probe-pill is-ready';
    }
    if (dot) dot.className = 'status-dot status-dot-ok';
    if (textEl) {
      textEl.textContent = 'Local Gateway Ready (127.0.0.1:8443) — Enter 6-Digit Pairing Code to Connect';
    }
    if (guidance) guidance.hidden = true;

    const urlInput = byId('gateway-ws-url');
    if (urlInput) {
      const currentUrl = urlInput.value.trim();
      if (!currentUrl || currentUrl === REMOTE_GATEWAY_DEFAULT_URL) {
        urlInput.value = LOCAL_GATEWAY_DEFAULT_URL;
      }
      syncGatewayUrlPresetsUi();
    }

    if (!hasPairedGatewayToken()) {
      setGatewayAuthMode('pairing');
      if (autoFocusPairing) {
        setTimeout(() => byId('gateway-pairing-code')?.focus(), 40);
      }
    }
    if (userTriggered) {
      showToast('Local Gateway ready on 127.0.0.1:8443.', 'ok');
    }
  } else {
    if (pill) {
      pill.hidden = false;
      pill.className = 'gateway-probe-pill is-offline';
    }
    if (dot) dot.className = 'status-dot status-dot-warn';
    if (textEl) {
      textEl.textContent = 'Local Gateway not detected on 127.0.0.1:8443';
    }
    if (guidance) {
      guidance.hidden = hasPairedGatewayToken();
    }
    if (userTriggered) {
      showToast('No local gateway responded on 127.0.0.1:8443.', 'danger');
    }
  }

  return reachable;
}

function updateGatewayTargetBadge() {
  const select = byId('gateway-host-select');
  const badge = byId('gateway-target-badge');
  const modeBadge = byId('gateway-mode-badge');
  if (modeBadge) {
    modeBadge.textContent = appState.gatewayViewOnly ? 'VIEW-ONLY OBSERVER' : 'INTERACTIVE';
  }
  if (!select || !badge) return;
  const nextId = select.value || '__demo__';
  if (appState.gatewayTargetHostId !== nextId && appState.gatewayCredPromptHostId !== nextId) {
    clearGatewayRuntimeCredentials();
  }
  appState.gatewayTargetHostId = nextId;
  if (appState.gatewayTargetHostId === '__demo__') {
    badge.textContent = 'DEMO SESSION · SYNTHETIC';
    updateSelectedTargetBanner();
    return;
  }
  const payload = getPayloadSafe();
  const host = payload && payload.hosts.find((h) => String(h.id) === select.value);
  if (host) {
    badge.textContent = `${String(host.protocol || 'rdp').toUpperCase()} · ${host.address}:${host.port}`;
  } else {
    badge.textContent = 'DEMO SESSION · SYNTHETIC';
  }
  updateSelectedTargetBanner();
}

function buildGatewayOpenParamsFromVault(selectedTargetId) {
  if (!selectedTargetId || selectedTargetId === '__demo__') {
    return {
      protocol: 'demo',
      width: 1280,
      height: 720,
      cols: 100,
      rows: 30,
      viewOnly: appState.gatewayViewOnly,
      displayLabel: 'DEMO · 1280×720',
    };
  }

  const payload = getPayloadSafe();
  const hosts = payload && Array.isArray(payload.hosts) ? payload.hosts : [];
  const creds = payload && Array.isArray(payload.credentials) ? payload.credentials : [];
  const host = hosts.find((h) => String(h.id) === String(selectedTargetId));
  if (!host) {
    return {
      protocol: 'demo',
      width: 1280,
      height: 720,
      cols: 100,
      rows: 30,
      viewOnly: appState.gatewayViewOnly,
      displayLabel: 'DEMO · 1280×720',
    };
  }

  const linkedCred = host.credentialId ? creds.find((c) => c.id === host.credentialId) : null;
  const bastion = host.jumpHostId ? hosts.find((b) => b.id === host.jumpHostId) : null;
  const bastionCred = bastion && bastion.credentialId ? creds.find((c) => c.id === bastion.credentialId) : null;

  const rawProto = String(host.protocol || 'rdp').toLowerCase();
  const protocol = ['rdp', 'vnc', 'ssh', 'sftp'].includes(rawProto) ? rawProto : 'ssh';
  const port = Number(host.port) || DEFAULT_PORTS[protocol] || 22;
  const useRuntimeCreds = appState.gatewayCredPromptHostId === String(host.id);
  const username = host.username || (linkedCred ? linkedCred.username : '') || '';
  const password =
    host.password ||
    (linkedCred ? linkedCred.password : '') ||
    (useRuntimeCreds ? ramSecrets.gatewayRuntimePassword : '') ||
    '';
  const domain = host.domain || (linkedCred ? linkedCred.domain : '') || '';
  const privateKey =
    host.privateKeyPem ||
    (linkedCred ? linkedCred.privateKeyPem : '') ||
    (useRuntimeCreds ? ramSecrets.gatewayRuntimeKey : '') ||
    '';

  let jumpHost = '';
  let jumpPassword = '';
  if (bastion && bastion.address) {
    const bUser = bastion.username || (bastionCred ? bastionCred.username : '') || '';
    const bPort = Number(bastion.port) || 22;
    jumpHost = `${bUser ? `${bUser}@` : ''}${bastion.address}${bPort !== 22 ? `:${bPort}` : ''}`;
    jumpPassword = bastion.password || (bastionCred ? bastionCred.password : '') || '';
  }

  return {
    protocol,
    host: host.address,
    port,
    username: username || undefined,
    password: password || undefined,
    domain: domain || undefined,
    privateKey: privateKey || undefined,
    jumpHost: jumpHost || undefined,
    jumpPassword: jumpPassword || undefined,
    width: 1280,
    height: 720,
    cols: appState.gatewaySshCols || 100,
    rows: appState.gatewaySshRows || 30,
    viewOnly: appState.gatewayViewOnly,
    displayLabel: `${protocol.toUpperCase()} · ${host.name || host.address}:${port}`,
  };
}

function disconnectGatewaySession(silent = false) {
  const activeSess = getActiveGatewaySession();
  const wasPreview = appState.gatewayPreviewActive;
  stopGatewayPreview();

  if (appState.gatewayClient) {
    try {
      appState.gatewayClient.detachCanvasInput();
      appState.gatewayClient.disconnect(!silent);
    } catch {
      // Ignore disconnect error
    }
    appState.gatewayClient = null;
  }

  if (activeSess) {
    activeSess.client = null;
    activeSess.previewState = null;
    activeSess.backingCanvas = null;
    activeSess.status = 'disconnected';
    renderGatewaySessionTabs();
  }

  if (document.fullscreenElement === byId('gateway-live-stage')) {
    document.exitFullscreen().catch(() => {});
  }

  const connBtn = byId('btn-gateway-connect');
  const discBtn = byId('btn-gateway-disconnect');
  if (connBtn) connBtn.disabled = false;
  if (discBtn) discBtn.disabled = true;

  setGatewayStatus('DISCONNECTED', 'idle');
  resetGatewayLiveDom();

  if (!silent) {
    appendGatewayLog(
      wasPreview
        ? 'Interactive browser preview closed. Start JalaDesk Gateway to connect to live servers.'
        : 'Gateway JSR1 session closed cleanly.',
      'warn',
    );
  }
}

async function connectGatewayBridge() {
  const urlStr = (byId('gateway-ws-url')?.value || '').trim();
  let endpoints;
  try {
    endpoints = normalizeGatewayEndpoints(urlStr);
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Enter a valid gateway URL.', 'danger');
    return;
  }

  const pairingCode = (byId('gateway-pairing-code')?.value || '').replace(/\s+/g, '').trim();
  const sessionToken = (byId('gateway-session-token')?.value || ramSecrets.gatewayToken || '').trim();

  if (appState.gatewayAuthMode === 'pairing' && !/^\d{6}$/.test(pairingCode)) {
    showToast('Enter a 6-digit numeric Pairing Code or switch to Session Token mode.', 'danger');
    return;
  }
  if (appState.gatewayAuthMode === 'token' && sessionToken.length < 4) {
    showToast('Enter an ephemeral session token or open with #token=...', 'danger');
    return;
  }

  store.saveUiPrefs({ gatewayUrl: urlStr });
  ramSecrets.gatewayPairing = appState.gatewayAuthMode === 'pairing' ? pairingCode : '';
  if (appState.gatewayAuthMode === 'token') {
    ramSecrets.gatewayToken = sessionToken;
  }

  const selectedTargetId = byId('gateway-host-select')?.value || '__demo__';
  const session = openOrFocusGatewaySessionTab(selectedTargetId);
  disposeGatewaySessionResources(session, false);
  appState.gatewayClient = null;
  appState.gatewayPreviewActive = false;
  appState.gatewayPreviewState = null;
  session.status = 'connecting';
  renderGatewaySessionTabs();

  const connBtn = byId('btn-gateway-connect');
  const discBtn = byId('btn-gateway-disconnect');
  if (connBtn) connBtn.disabled = true;
  if (discBtn) discBtn.disabled = false;

  if (appState.gatewayCredPromptHostId === String(selectedTargetId)) {
    ramSecrets.gatewayRuntimePassword = byId('gateway-runtime-password')?.value || ramSecrets.gatewayRuntimePassword || '';
    ramSecrets.gatewayRuntimeKey = byId('gateway-runtime-key')?.value || ramSecrets.gatewayRuntimeKey || '';
  }
  const built = buildGatewayOpenParamsFromVault(selectedTargetId);
  const { displayLabel, ...openParams } = built;
  const canvasEl = byId('gateway-canvas');

  const client = new JalaGatewayClient({
    canvas: canvasEl,
    onStatus: (label, tone) => {
      if (appState.activeGatewaySessionId === session.id) {
        setGatewayStatus(label, tone);
      }
    },
    onTokenExchanged: (token) => {
      ramSecrets.gatewayToken = token;
      ramSecrets.gatewayPairing = '';
      const tokInput = byId('gateway-session-token');
      if (tokInput) tokInput.value = token;
      setGatewayAuthMode('token');
      const guidance = byId('gateway-setup-guidance');
      if (guidance) guidance.hidden = true;
      const probePill = byId('gateway-local-probe-pill');
      if (probePill) probePill.hidden = true;
    },
    onLog: (msg, tone) => appendGatewayLog(msg, tone),
    onOpened: (msg) => {
      clearGatewayRuntimeCredentials();
      const activeProto = String(msg.protocol || openParams.protocol || 'demo').toLowerCase();
      const targetLabel = openParams.protocol === 'demo' ? 'DEMO' : displayLabel;
      const initialPane = resolveInitialGatewayPane(activeProto);

      session.status = 'live';
      session.protocol = activeProto;
      session.targetLabel = targetLabel;
      session.activePane = initialPane;
      session.hasControl = Boolean(msg.hasControl);
      session.viewOnly = Boolean(msg.viewOnly);
      session.sshCols = Number(msg.cols) || appState.gatewaySshCols || 100;
      session.sshRows = Number(msg.rows) || appState.gatewaySshRows || 30;
      renderGatewaySessionTabs();

      if (appState.activeGatewaySessionId === session.id) {
        appState.gatewaySessionProtocol = activeProto;
        appState.gatewayTargetLabel = targetLabel;

        const liveStage = byId('gateway-live-stage');
        const previewBanner = byId('gateway-preview-banner');
        const toggleBtn = byId('btn-gateway-toggle-setup');
        const hudTarget = byId('hud-target-badge');
        if (liveStage) liveStage.hidden = false;
        if (previewBanner) previewBanner.hidden = true;
        if (toggleBtn) toggleBtn.hidden = false;
        setGatewaySetupVisible(false);
        syncGatewayPaneTabsForProtocol(activeProto);

        if (initialPane === 'ssh') {
          if (hudTarget) {
            hudTarget.textContent = `${targetLabel} · ${session.sshCols}×${session.sshRows}`;
          }
          updateGatewaySshHud(session.sshCols, session.sshRows, false, msg.pty ? 'PTY · xterm-256color' : 'VT100 TUI');
        } else {
          const dims = msg.width && msg.height ? ` · ${msg.width}×${msg.height}` : '';
          if (hudTarget) {
            hudTarget.textContent = `${targetLabel}${dims}`;
          }
        }

        updateGatewayControlUi(Boolean(msg.hasControl), Boolean(msg.viewOnly));
        renderGatewayTotpSelect();
        setGatewayScaleMode(session.scaleMode || appState.gatewayScaleMode);
        setGatewayPane(initialPane);

        if (canvasEl && (initialPane === 'desktop' || activeProto === 'demo')) {
          client.attachCanvasInput(canvasEl, () => appState.gatewayScaleMode);
        }
      }

      appendGatewayLog(
        `Session ${msg.sessionId} open (${activeProto.toUpperCase()}, ${msg.hasControl ? 'exclusive input control' : 'view-only observer'}).`,
        'ok',
      );
      showToast(`Connected to ${displayLabel}`, 'ok');
    },
    onControlState: (msg) => {
      session.hasControl = Boolean(msg.hasControl);
      session.viewOnly = Boolean(msg.viewOnly);
      if (appState.activeGatewaySessionId === session.id) {
        updateGatewayControlUi(Boolean(msg.hasControl), Boolean(msg.viewOnly));
      }
      appendGatewayLog(
        msg.hasControl
          ? `Acquired exclusive input control (${msg.viewers} viewer${msg.viewers === 1 ? '' : 's'}).`
          : `Switched to View-Only Observer mode (${msg.viewers} viewer${msg.viewers === 1 ? '' : 's'}).`,
        'ok',
      );
    },
    onMetrics: (metrics) => {
      session.metrics = metrics;
      if (appState.activeGatewaySessionId === session.id) {
        updateGatewayHudMetrics(metrics);
      }
    },
    onSshData: (chunk) => {
      appendGatewaySshOutput(chunk, session);
    },
    onError: (msg) => {
      const text = msg && msg.message ? msg.message : 'Gateway session error.';
      if (session.activePane === 'ssh') {
        appendGatewaySshOutput(`\r\n\x1b[31m[gateway] ${text}\x1b[0m\r\n`, session);
      }
      appendGatewayLog(`Gateway error (${msg.code || 'error'}): ${text}`, 'err');
      showToast(text, 'danger');
    },
    onClose: ({ code, wasConnected }) => {
      if (session.client === client) {
        client.detachCanvasInput();
        session.client = null;
        session.status = 'disconnected';
        renderGatewaySessionTabs();
      }
      if (appState.gatewayClient === client) {
        appState.gatewayClient = null;
        if (connBtn) connBtn.disabled = false;
        if (discBtn) discBtn.disabled = true;
        setGatewayStatus('DISCONNECTED', 'idle');
        setGatewaySetupVisible(true);
        const toggleBtn = byId('btn-gateway-toggle-setup');
        if (toggleBtn) toggleBtn.hidden = true;
        if (wasConnected) {
          appendGatewayLog(`Gateway WebSocket disconnected (code ${code}).`, 'warn');
        }
      }
    },
  });

  session.client = client;
  appState.gatewayClient = client;
  appendGatewayLog(
    `Connecting via ${endpoints.httpBaseUrl} (${appState.gatewayAuthMode === 'pairing' ? '6-digit pairing -> 60s WS ticket' : 'token -> 60s WS ticket'}, ${appState.gatewayViewOnly ? 'view-only' : 'interactive'})...`,
  );

  try {
    await client.connect({
      gatewayUrl: urlStr,
      bearerToken: appState.gatewayAuthMode === 'token' ? sessionToken : '',
      pairingCode: appState.gatewayAuthMode === 'pairing' ? pairingCode : '',
      openParams,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (session.client === client) {
      session.client = null;
      session.status = 'disconnected';
      renderGatewaySessionTabs();
    }
    if (appState.gatewayClient === client) {
      appState.gatewayClient = null;
    }
    if (connBtn) connBtn.disabled = false;
    if (discBtn) discBtn.disabled = true;
    setGatewayStatus('DISCONNECTED', 'idle');
    appendGatewayLog(`Connection failed: ${message}`, 'err');
    showToast(message, 'danger');
    if (appState.gatewayAuthMode === 'token' && /401|unauthorized|expired|invalid token/i.test(message)) {
      ramSecrets.gatewayToken = '';
      const tokInput = byId('gateway-session-token');
      if (tokInput) tokInput.value = '';
      setGatewayAuthMode('pairing');
      probeLocalGatewayHealth({ autoFocusPairing: true });
    }
  }
}

function mapPreviewCanvasCoords(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 640, y: 360 };
  const x = Math.max(0, Math.min(canvas.width, Math.round(((clientX - rect.left) / rect.width) * canvas.width)));
  const y = Math.max(0, Math.min(canvas.height, Math.round(((clientY - rect.top) / rect.height) * canvas.height)));
  return { x, y };
}

function drawPreviewRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function renderGatewayPreviewCanvas() {
  const state = appState.gatewayPreviewState;
  const canvas = byId('gateway-canvas');
  if (!state || !canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Wallpaper gradient & precision grid
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#071122');
  bg.addColorStop(0.55, '#0D1B33');
  bg.addColorStop(1, '#081326');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(148, 182, 224, 0.06)';
  ctx.lineWidth = 1;
  for (let gx = 40; gx < W; gx += 40) {
    ctx.beginPath();
    ctx.moveTo(gx, 36);
    ctx.lineTo(gx, H - 44);
    ctx.stroke();
  }
  for (let gy = 76; gy < H - 44; gy += 40) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.stroke();
  }

  // Top remote OS bar
  ctx.fillStyle = 'rgba(7, 12, 22, 0.92)';
  ctx.fillRect(0, 0, W, 36);
  ctx.strokeStyle = 'rgba(150, 178, 214, 0.2)';
  ctx.beginPath();
  ctx.moveTo(0, 36);
  ctx.lineTo(W, 36);
  ctx.stroke();

  ctx.font = '600 14px "DM Sans", system-ui, sans-serif';
  ctx.fillStyle = '#38BDF8';
  ctx.fillText('JalaDesk Remote Desktop', 18, 23);
  ctx.fillStyle = '#C4D3E7';
  ctx.font = '500 13px "JetBrains Mono", monospace';
  ctx.fillText(`Target: ${state.targetLabel}  ·  Cursor (${state.cursorX}, ${state.cursorY})`, 235, 23);
  ctx.fillStyle = '#F3C66F';
  ctx.fillText(nowStr, W - 98, 23);

  const drawAuthWindow = () => {
    const win = state.authWin;
    const focused = state.focusedWindow === 'auth';
    drawPreviewRoundedRect(ctx, win.x, win.y, win.w, win.h, 12);
    ctx.fillStyle = '#0D1627';
    ctx.fill();
    ctx.lineWidth = focused ? 2 : 1;
    ctx.strokeStyle = focused ? '#38BDF8' : 'rgba(150, 178, 214, 0.25)';
    ctx.stroke();

    // Window header
    drawPreviewRoundedRect(ctx, win.x, win.y, win.w, 40, 12);
    ctx.fillStyle = focused ? '#162844' : '#101C31';
    ctx.fill();
    ctx.fillStyle = '#F4F8FD';
    ctx.font = '600 15px "DM Sans", system-ui, sans-serif';
    ctx.fillText('Remote Session Auth & 2FA Receiver', win.x + 18, win.y + 25);
    ctx.fillStyle = '#34D399';
    ctx.font = '600 12px "JetBrains Mono", monospace';
    ctx.fillText(focused ? 'FOCUSED' : 'CLICK TO FOCUS', win.x + win.w - 118, win.y + 24);

    // Info cards
    ctx.fillStyle = '#C4D3E7';
    ctx.font = '500 14px "DM Sans", system-ui, sans-serif';
    ctx.fillText('Live RDP / VNC frames stream over JSR1 binary WebSocket.', win.x + 20, win.y + 70);
    ctx.fillStyle = '#97ADC9';
    ctx.font = '500 13px "JetBrains Mono", monospace';
    ctx.fillText(`Host: ${state.targetLabel}`, win.x + 20, win.y + 98);
    ctx.fillText(`Mode: ${appState.gatewayViewOnly ? 'VIEW-ONLY OBSERVER' : 'INTERACTIVE CONTROL'}`, win.x + 20, win.y + 122);

    // 2FA / Keyboard Input Box
    ctx.fillStyle = '#F4F8FD';
    ctx.font = '600 14px "DM Sans", system-ui, sans-serif';
    ctx.fillText('2FA Auto-Type / Keyboard Input Target:', win.x + 20, win.y + 166);

    const boxX = win.x + 20;
    const boxY = win.y + 178;
    const boxW = win.w - 40;
    const boxH = 52;
    drawPreviewRoundedRect(ctx, boxX, boxY, boxW, boxH, 8);
    ctx.fillStyle = '#060B14';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = state.totpFlashUntil > Date.now() ? '#34D399' : '#38BDF8';
    ctx.stroke();

    ctx.font = '700 22px "JetBrains Mono", monospace';
    ctx.fillStyle = state.authInputText ? '#34D399' : '#64748B';
    const displayText = state.authInputText || 'Click "2FA Auto-Type" or type here...';
    if (!state.authInputText) {
      ctx.font = '500 15px "JetBrains Mono", monospace';
    }
    ctx.fillText(displayText.slice(-28), boxX + 16, boxY + 33);

    // Interactive verify & clear buttons inside Auth window
    for (const btn of state.authButtons) {
      drawPreviewRoundedRect(ctx, btn.x, btn.y, btn.w, btn.h, 7);
      ctx.fillStyle = btn.primary ? '#F3C66F' : '#162844';
      ctx.fill();
      ctx.strokeStyle = btn.primary ? '#F3C66F' : 'rgba(150, 178, 214, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = btn.primary ? '#05080F' : '#F4F8FD';
      ctx.font = '600 14px "DM Sans", system-ui, sans-serif';
      ctx.fillText(btn.label, btn.x + 14, btn.y + 24);
    }

    ctx.fillStyle = state.authStatusTone === 'ok' ? '#34D399' : '#F3C66F';
    ctx.font = '500 13px "JetBrains Mono", monospace';
    ctx.fillText(state.authStatus, win.x + 20, win.y + 324);

    ctx.fillStyle = '#97ADC9';
    ctx.font = '400 13px "DM Sans", system-ui, sans-serif';
    ctx.fillText('Tip: Switch Fit / Fill / 1:1 above, test Ctrl+Alt+Del, or open the SSH tab.', win.x + 20, win.y + 372);
  };

  const drawTermWindow = () => {
    const win = state.termWin;
    const focused = state.focusedWindow === 'term';
    drawPreviewRoundedRect(ctx, win.x, win.y, win.w, win.h, 12);
    ctx.fillStyle = '#09111E';
    ctx.fill();
    ctx.lineWidth = focused ? 2 : 1;
    ctx.strokeStyle = focused ? '#34D399' : 'rgba(150, 178, 214, 0.25)';
    ctx.stroke();

    drawPreviewRoundedRect(ctx, win.x, win.y, win.w, 40, 12);
    ctx.fillStyle = focused ? '#112B29' : '#0F1A2C';
    ctx.fill();
    ctx.fillStyle = '#F4F8FD';
    ctx.font = '600 15px "DM Sans", system-ui, sans-serif';
    ctx.fillText('Remote Desktop Console (Interactive Window)', win.x + 18, win.y + 25);
    ctx.fillStyle = '#34D399';
    ctx.font = '600 12px "JetBrains Mono", monospace';
    ctx.fillText(focused ? 'ACTIVE' : 'CLICK TO FOCUS', win.x + win.w - 118, win.y + 24);

    // Quick action buttons
    for (const btn of state.termButtons) {
      drawPreviewRoundedRect(ctx, btn.x, btn.y, btn.w, btn.h, 6);
      ctx.fillStyle = '#15253E';
      ctx.fill();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#DCE9F9';
      ctx.font = '600 13px "DM Sans", system-ui, sans-serif';
      ctx.fillText(btn.label, btn.x + 12, btn.y + 22);
    }

    // Console lines
    ctx.font = '500 13px "JetBrains Mono", monospace';
    const visibleLines = state.termLines.slice(-13);
    let ly = win.y + 112;
    for (const line of visibleLines) {
      ctx.fillStyle = line.startsWith('$') ? '#38BDF8' : line.includes('[OK]') ? '#34D399' : '#D5E3F5';
      ctx.fillText(line.slice(0, 64), win.x + 18, ly);
      ly += 24;
    }
  };

  if (state.focusedWindow === 'auth') {
    drawTermWindow();
    drawAuthWindow();
  } else {
    drawAuthWindow();
    drawTermWindow();
  }

  // Click ripple feedback
  if (state.lastClick && Date.now() - state.lastClick.at < 450) {
    const progress = (Date.now() - state.lastClick.at) / 450;
    ctx.beginPath();
    ctx.arc(state.lastClick.x, state.lastClick.y, 6 + progress * 22, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(56, 189, 248, ${(1 - progress).toFixed(2)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Ctrl+Alt+Del Secure Attention overlay
  if (state.cadOverlay) {
    ctx.fillStyle = 'rgba(5, 8, 15, 0.84)';
    ctx.fillRect(0, 36, W, H - 80);
    const mw = 500;
    const mh = 220;
    const mx = Math.round((W - mw) / 2);
    const my = Math.round((H - mh) / 2);
    drawPreviewRoundedRect(ctx, mx, my, mw, mh, 14);
    ctx.fillStyle = '#0D1627';
    ctx.fill();
    ctx.strokeStyle = '#F3C66F';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#F3C66F';
    ctx.font = '700 20px "Sora", "DM Sans", sans-serif';
    ctx.fillText('Ctrl+Alt+Del Received (SAS)', mx + 28, my + 48);
    ctx.fillStyle = '#C4D3E7';
    ctx.font = '400 15px "DM Sans", system-ui, sans-serif';
    ctx.fillText('Simulated Secure Attention Sequence delivered over JSR1.', mx + 28, my + 86);
    ctx.fillText('Lock Workstation · Switch User · Task Manager · Sign Out', mx + 28, my + 114);
    drawPreviewRoundedRect(ctx, mx + 28, my + 148, 176, 40, 8);
    ctx.fillStyle = '#F3C66F';
    ctx.fill();
    ctx.fillStyle = '#05080F';
    ctx.font = '700 14px "DM Sans", system-ui, sans-serif';
    ctx.fillText('Click Anywhere to Dismiss', mx + 42, my + 173);
  }

  // Bottom Taskbar
  ctx.fillStyle = 'rgba(7, 12, 22, 0.94)';
  ctx.fillRect(0, H - 44, W, 44);
  ctx.strokeStyle = 'rgba(150, 178, 214, 0.2)';
  ctx.beginPath();
  ctx.moveTo(0, H - 44);
  ctx.lineTo(W, H - 44);
  ctx.stroke();

  for (const tab of state.taskbarTabs) {
    const active = state.focusedWindow === tab.win;
    drawPreviewRoundedRect(ctx, tab.x, tab.y, tab.w, tab.h, 6);
    ctx.fillStyle = active ? '#1D3354' : '#0E1729';
    ctx.fill();
    ctx.strokeStyle = active ? '#38BDF8' : 'rgba(150, 178, 214, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = active ? '#F4F8FD' : '#97ADC9';
    ctx.font = '600 13px "DM Sans", system-ui, sans-serif';
    ctx.fillText(tab.label, tab.x + 12, tab.y + 19);
  }

  ctx.fillStyle = '#97ADC9';
  ctx.font = '500 13px "JetBrains Mono", monospace';
  ctx.fillText(`Clicks: ${state.clickCount} · Tiles: ${state.tilesDecoded} · Scale: ${appState.gatewayScaleMode.toUpperCase()}`, W - 360, H - 17);

  // Crisp vector remote cursor
  if (!appState.gatewayViewOnly) {
    const cx = state.cursorX;
    const cy = state.cursorY;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 20);
    ctx.lineTo(cx + 6, cy + 15);
    ctx.lineTo(cx + 12, cy + 22);
    ctx.lineTo(cx + 15, cy + 19);
    ctx.lineTo(cx + 9, cy + 13);
    ctx.lineTo(cx + 16, cy + 12);
    ctx.closePath();
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = '#05080F';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function stopGatewayPreview() {
  const state = appState.gatewayPreviewState;
  if (state) {
    if (state.timerId) {
      clearInterval(state.timerId);
    }
    const canvas = byId('gateway-canvas');
    if (canvas && state.listeners) {
      for (const [evt, fn] of state.listeners) {
        canvas.removeEventListener(evt, fn);
      }
    }
  }
  appState.gatewayPreviewActive = false;
  appState.gatewayPreviewState = null;
  const previewBanner = byId('gateway-preview-banner');
  if (previewBanner) previewBanner.hidden = true;
}

function formatPreviewSshPrompt(state) {
  const user = (state && state.sshUser) || 'operator';
  const hostName = (state && state.sshHostSlug) || 'jaladesk-preview';
  return `\x1b[1;32m${user}@${hostName}\x1b[0m:\x1b[1;34m~\x1b[0m$ `;
}

function renderPreviewHtopAltScreen(state) {
  const hostName = (state && state.sshHostSlug) || 'jaladesk-preview';
  appendGatewaySshOutput(
    '\x1b[?1049h\x1b[2J\x1b[H' +
      `\x1b[1;30;46m  JalaDesk Preview htop — ${hostName} (Alt-Screen ?1049h)   Press q or Esc to exit  \x1b[0m\r\n\r\n` +
      '  \x1b[1;36mCPU\x1b[0m [\x1b[32m||||||||\x1b[33m||\x1b[90m....................\x1b[0m 28.4%]   \x1b[1;36mTasks:\x1b[0m 42, 1 running\r\n' +
      '  \x1b[1;36mMem\x1b[0m [\x1b[32m||||||||||||||\x1b[90m..............\x1b[0m 2.4G/8.0G] \x1b[1;36mLoad:\x1b[0m 0.14 0.11 0.08\r\n\r\n' +
      '\x1b[30;42m  PID USER       PRI  NI  VIRT   RES S CPU% MEM%   TIME+  Command                        \x1b[0m\r\n' +
      ' 1042 jaladesk    20   0  184M   38M S  1.2  0.5  0:12.44 sshd: bright@pts/0\r\n' +
      ' 1089 jaladesk    20   0   92M   19M R  0.8  0.2  0:01.08 htop --offline-preview\r\n' +
      '  412 root        20   0  310M   44M S  0.3  0.6  4:22.10 systemd-journald\r\n\r\n' +
      '\x1b[33mOffline UI Preview — press q, Esc, or Ctrl+C to return to shell.\x1b[0m',
  );
}

function executePreviewSshCommand(rawCmd, state) {
  const cmd = String(rawCmd || '').trim();
  if (!cmd) return;
  if (state) {
    state.sshHistory.push(cmd);
    if (state.sshHistory.length > 50) state.sshHistory.shift();
    state.sshHistoryIdx = state.sshHistory.length;
  }

  if (cmd === 'clear') {
    appendGatewaySshOutput('\x1b[2J\x1b[H');
    return;
  }
  if (cmd === 'htop' || cmd === 'top') {
    if (state) state.sshAltApp = 'htop';
    renderPreviewHtopAltScreen(state);
    return;
  }
  if (cmd === 'help') {
    appendGatewaySshOutput(
      '\x1b[1;36mOffline SSH Preview commands:\x1b[0m help, whoami, uname -a, ls, uptime, date, echo <text>, htop, clear\r\n' +
        '\x1b[90mToggle Web Bridge ON in JalaDesk Desktop (or run npm run gateway) to open live PTY sessions.\x1b[0m\r\n',
    );
  } else if (cmd === 'whoami') {
    appendGatewaySshOutput('jaladesk-demo\r\n');
  } else if (cmd.startsWith('uname')) {
    appendGatewaySshOutput('Linux jaladesk-bastion 6.8.0-generic #1 SMP x86_64 GNU/Linux\r\n');
  } else if (cmd === 'ls' || cmd.startsWith('ls ')) {
    appendGatewaySshOutput(
      '\x1b[1;32mdeploy.sh\x1b[0m  docker-compose.gateway.yml  \x1b[1;34mlogs/\x1b[0m  nginx.conf  README.md\r\n',
    );
  } else if (cmd === 'uptime') {
    appendGatewaySshOutput(' 12:04:19 up 42 days,  6:18,  1 user,  load average: 0.14, 0.11, 0.08\r\n');
  } else if (cmd === 'date') {
    appendGatewaySshOutput(`${new Date().toUTCString()}\r\n`);
  } else if (cmd.startsWith('echo ')) {
    appendGatewaySshOutput(`${cmd.slice(5)}\r\n`);
  } else {
    appendGatewaySshOutput(`\x1b[33m[preview]\x1b[0m executed: ${cmd}\r\n`);
  }
}

function handleGatewayPreviewSshData(seq) {
  const state = appState.gatewayPreviewState;
  if (!state) return;

  // Handle alternate screen preview app (htop)
  if (state.sshAltApp) {
    if (seq === 'q' || seq === 'Q' || seq === '\x1b' || seq === '\x03') {
      state.sshAltApp = '';
      appendGatewaySshOutput(`\x1b[?1049l${formatPreviewSshPrompt(state)}`);
    }
    return;
  }

  // Strip bracketed paste wrappers in offline preview
  const cleanSeq = seq.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');

  // History navigation on Up / Down arrows
  if (cleanSeq === '\x1b[A' || cleanSeq === '\x1bOA') {
    if (state.sshHistory.length > 0 && state.sshHistoryIdx > 0) {
      state.sshHistoryIdx -= 1;
      const entry = state.sshHistory[state.sshHistoryIdx] || '';
      state.sshLine = entry;
      appendGatewaySshOutput(`\r\x1b[2K${formatPreviewSshPrompt(state)}${entry}`);
    }
    return;
  }
  if (cleanSeq === '\x1b[B' || cleanSeq === '\x1bOB') {
    if (state.sshHistoryIdx < state.sshHistory.length - 1) {
      state.sshHistoryIdx += 1;
      const entry = state.sshHistory[state.sshHistoryIdx] || '';
      state.sshLine = entry;
      appendGatewaySshOutput(`\r\x1b[2K${formatPreviewSshPrompt(state)}${entry}`);
    } else {
      state.sshHistoryIdx = state.sshHistory.length;
      state.sshLine = '';
      appendGatewaySshOutput(`\r\x1b[2K${formatPreviewSshPrompt(state)}`);
    }
    return;
  }
  if (cleanSeq.startsWith('\x1b')) {
    return;
  }

  for (let i = 0; i < cleanSeq.length; i += 1) {
    const ch = cleanSeq[i];
    if (ch === '\x03') {
      state.sshLine = '';
      appendGatewaySshOutput(`^C\r\n${formatPreviewSshPrompt(state)}`);
    } else if (ch === '\x04') {
      state.sshLine = '';
      appendGatewaySshOutput(`\r\n\x1b[90m[preview] EOF (^D) — offline UI preview shell stays open.\x1b[0m\r\n${formatPreviewSshPrompt(state)}`);
    } else if (ch === '\x0c') {
      appendGatewaySshOutput(`\x1b[2J\x1b[H${formatPreviewSshPrompt(state)}${state.sshLine}`);
    } else if (ch === '\r' || ch === '\n') {
      const cmd = state.sshLine;
      state.sshLine = '';
      appendGatewaySshOutput('\r\n');
      executePreviewSshCommand(cmd, state);
      if (!state.sshAltApp) {
        appendGatewaySshOutput(formatPreviewSshPrompt(state));
      }
    } else if (ch === '\x7f' || ch === '\b') {
      if (state.sshLine.length > 0) {
        state.sshLine = state.sshLine.slice(0, -1);
        appendGatewaySshOutput('\b \b');
      }
    } else if (ch === '\t') {
      const matches = ['help', 'whoami', 'uname -a', 'ls', 'uptime', 'date', 'htop', 'clear'].filter((c) =>
        c.startsWith(state.sshLine),
      );
      if (state.sshLine && matches.length === 1) {
        const rest = matches[0].slice(state.sshLine.length);
        state.sshLine += rest;
        appendGatewaySshOutput(rest);
      }
    } else if (ch.charCodeAt(0) >= 32) {
      state.sshLine += ch;
      appendGatewaySshOutput(ch);
    }
  }
}

function renderGatewayPreviewSftpList() {
  const statusEl = byId('gateway-sftp-status');
  const listEl = byId('gateway-sftp-list');
  const pathInput = byId('gateway-sftp-path');
  const path = (pathInput?.value || '/').trim() || '/';
  if (statusEl) {
    statusEl.textContent = `${path} · 4 sample items (Interactive Browser Preview — start Gateway for live SFTP)`;
  }
  if (!listEl) return;
  listEl.replaceChildren();
  const sampleEntries = [
    { name: 'logs', type: 'dir', size: 0, meta: 'Directory' },
    { name: 'docker-compose.gateway.yml', type: 'file', size: 1248, meta: '1.2 KB' },
    { name: 'deploy.sh', type: 'file', size: 4096, meta: '4.0 KB' },
    { name: 'nginx.conf', type: 'file', size: 2816, meta: '2.8 KB' },
  ];
  for (const item of sampleEntries) {
    const row = el('div', 'sftp-row');
    const nameWrap = el('div', 'sftp-name-wrap');
    nameWrap.appendChild(el('span', `proto-badge mono ${item.type === 'dir' ? 'proto-hypervisor' : 'proto-sftp'}`, item.type === 'dir' ? 'DIR' : 'FILE'));
    nameWrap.appendChild(el('span', 'sftp-name mono', item.name));
    row.appendChild(nameWrap);
    row.appendChild(el('span', 'sftp-meta mono', item.meta));
    row.appendChild(el('span', 'sftp-meta mono', 'Preview'));
    listEl.appendChild(row);
  }
}

function startGatewayInteractivePreview() {
  const selectedTargetId = byId('gateway-host-select')?.value || '__demo__';
  const session = openOrFocusGatewaySessionTab(selectedTargetId);
  disposeGatewaySessionResources(session, false);
  appState.gatewayClient = null;

  const built = buildGatewayOpenParamsFromVault(selectedTargetId);
  const targetProto = selectedTargetId === '__demo__' ? 'demo' : built.protocol;
  const targetLabel =
    selectedTargetId === '__demo__' ? 'bastion-prod-01.internal (RDP 3389)' : built.displayLabel;
  const sshHostSlug = String(built.host || 'jaladesk-preview').replace(/[^a-zA-Z0-9._-]/g, '');
  const sshUser = String(built.username || 'operator').replace(/[^a-zA-Z0-9._-]/g, '') || 'operator';

  const authWin = { x: 48, y: 66, w: 568, h: 430 };
  const termWin = { x: 644, y: 98, w: 588, h: 460 };

  const previewState = {
    targetLabel,
    sshHostSlug,
    sshUser,
    sshLine: '',
    sshHistory: [],
    sshHistoryIdx: 0,
    sshAltApp: '',
    focusedWindow: 'auth',
    cursorX: 340,
    cursorY: 268,
    clickCount: 0,
    tilesDecoded: 14,
    authInputText: '',
    authStatus: 'Ready — click "2FA Auto-Type" above or type on your keyboard.',
    authStatusTone: 'warn',
    totpFlashUntil: 0,
    cadOverlay: false,
    lastClick: null,
    authWin,
    termWin,
    authButtons: [
      { id: 'verify', label: 'Verify 2FA Code', x: authWin.x + 20, y: authWin.y + 248, w: 158, h: 38, primary: true },
      { id: 'clear-auth', label: 'Clear Field', x: authWin.x + 190, y: authWin.y + 248, w: 118, h: 38, primary: false },
    ],
    termButtons: [
      { id: 'ping', label: 'Ping Bastion', x: termWin.x + 18, y: termWin.y + 54, w: 124, h: 34 },
      { id: 'services', label: 'Check Services', x: termWin.x + 152, y: termWin.y + 54, w: 138, h: 34 },
      { id: 'clear-term', label: 'Clear', x: termWin.x + 300, y: termWin.y + 54, w: 82, h: 34 },
    ],
    taskbarTabs: [
      { win: 'auth', label: 'Auth & 2FA Receiver', x: 18, y: 682, w: 174, h: 28 },
      { win: 'term', label: 'Remote Console', x: 202, y: 682, w: 144, h: 28 },
    ],
    termLines: [
      `$ ssh ${sshUser}@${sshHostSlug}`,
      `[OK] JSR1 interactive preview canvas ready (${targetLabel})`,
      '[OK] FreeRDP / VNC / SSH browser compositor active',
      'Click buttons above, click windows to focus, or try 2FA Auto-Type.',
    ],
    timerId: null,
    listeners: [],
  };

  appState.gatewayPreviewActive = true;
  appState.gatewayPreviewState = previewState;
  appState.gatewaySessionProtocol = targetProto;
  appState.gatewayTargetLabel = targetLabel;
  session.previewState = previewState;
  session.status = 'preview';
  session.protocol = targetProto;
  session.targetLabel = targetLabel;
  session.activePane = resolveInitialGatewayPane(targetProto);
  session.viewOnly = false;
  session.hasControl = true;
  renderGatewaySessionTabs();

  const liveStage = byId('gateway-live-stage');
  const previewBanner = byId('gateway-preview-banner');
  const toggleBtn = byId('btn-gateway-toggle-setup');
  const hudTarget = byId('hud-target-badge');
  const discBtn = byId('btn-gateway-disconnect');

  if (liveStage) liveStage.hidden = false;
  if (previewBanner) previewBanner.hidden = false;
  if (toggleBtn) toggleBtn.hidden = false;
  if (discBtn) discBtn.disabled = false;

  const initialPane = resolveInitialGatewayPane(targetProto);
  syncGatewayPaneTabsForProtocol(targetProto);

  if (hudTarget) {
    hudTarget.textContent =
      initialPane === 'ssh'
        ? `PREVIEW · ${targetLabel} · ${appState.gatewaySshCols}×${appState.gatewaySshRows}`
        : `PREVIEW · ${targetLabel} · 1280×720`;
  }

  setGatewaySetupVisible(false);
  setGatewayStatus('OFFLINE PREVIEW', 'warn');
  updateGatewayControlUi(true, false);
  renderGatewayTotpSelect();
  setGatewayScaleMode(appState.gatewayScaleMode);

  const term = ensureSshTerminal();
  term.reset();
  appendGatewaySshOutput(
    `\x1b[1;36mJalaDesk Web Terminal\x1b[0m \x1b[90m(Offline UI Preview — VT100/ANSI xterm-256color)\x1b[0m\r\n` +
      `\x1b[33mTarget:\x1b[0m ${targetLabel}\r\n` +
      `Type directly here (\x1b[32mhelp\x1b[0m, \x1b[32mwhoami\x1b[0m, \x1b[32mhtop\x1b[0m, \x1b[32mls\x1b[0m, \x1b[32muname -a\x1b[0m) or use the shortcut ribbon below.\r\n\r\n` +
      formatPreviewSshPrompt(previewState),
  );
  renderGatewayPreviewSftpList();
  setGatewayPane(initialPane);

  const canvas = byId('gateway-canvas');
  if (canvas) {
    const bumpTile = () => {
      previewState.tilesDecoded += 1;
      updateGatewayHudMetrics({ fps: 30, rttMs: 1, kbPerSec: 184, tilesDecoded: previewState.tilesDecoded });
      renderGatewayPreviewCanvas();
    };

    const onPointerMove = (e) => {
      const pt = mapPreviewCanvasCoords(canvas, e.clientX, e.clientY);
      previewState.cursorX = pt.x;
      previewState.cursorY = pt.y;
      renderGatewayPreviewCanvas();
    };

    const onPointerDown = (e) => {
      if (appState.gatewayViewOnly) {
        showToast('View-Only Observer active — click Take Control to interact.', 'danger');
        return;
      }
      canvas.focus();
      const pt = mapPreviewCanvasCoords(canvas, e.clientX, e.clientY);
      previewState.cursorX = pt.x;
      previewState.cursorY = pt.y;
      previewState.clickCount += 1;
      previewState.lastClick = { x: pt.x, y: pt.y, at: Date.now() };

      if (previewState.cadOverlay) {
        previewState.cadOverlay = false;
        bumpTile();
        return;
      }

      for (const tab of previewState.taskbarTabs) {
        if (pt.x >= tab.x && pt.x <= tab.x + tab.w && pt.y >= tab.y && pt.y <= tab.y + tab.h) {
          previewState.focusedWindow = tab.win;
          bumpTile();
          return;
        }
      }

      const inRect = (r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
      const checkAuthClick = () => {
        if (!inRect(previewState.authWin)) return false;
        previewState.focusedWindow = 'auth';
        for (const btn of previewState.authButtons) {
          if (inRect(btn)) {
            if (btn.id === 'verify') {
              const code = previewState.authInputText.trim();
              if (code.length >= 6) {
                previewState.authStatus = `[OK] Verified code "${code}" inside remote desktop!`;
                previewState.authStatusTone = 'ok';
                previewState.totpFlashUntil = Date.now() + 1800;
              } else {
                previewState.authStatus = 'Enter a 6-digit code or click "2FA Auto-Type" in the HUD above.';
                previewState.authStatusTone = 'warn';
              }
            } else if (btn.id === 'clear-auth') {
              previewState.authInputText = '';
              previewState.authStatus = 'Input cleared. Click "2FA Auto-Type" or type on your keyboard.';
              previewState.authStatusTone = 'warn';
            }
          }
        }
        return true;
      };
      const checkTermClick = () => {
        if (!inRect(previewState.termWin)) return false;
        previewState.focusedWindow = 'term';
        for (const btn of previewState.termButtons) {
          if (inRect(btn)) {
            if (btn.id === 'ping') {
              previewState.termLines.push(`$ ping -c 1 ${previewState.sshHostSlug}`);
              previewState.termLines.push(`[OK] 64 bytes from ${previewState.sshHostSlug}: time=0.84 ms`);
            } else if (btn.id === 'services') {
              previewState.termLines.push('$ systemctl status jaladesk-gateway');
              previewState.termLines.push('[OK] rdp-freerdp3: ready · vnc-rfb: ready · ssh-pty: ready');
            } else if (btn.id === 'clear-term') {
              previewState.termLines = ['[OK] Console cleared (Interactive Browser Preview).'];
            }
          }
        }
        return true;
      };

      if (previewState.focusedWindow === 'auth') {
        if (!checkAuthClick()) checkTermClick();
      } else if (!checkTermClick()) {
        checkAuthClick();
      }
      bumpTile();
    };

    const onKeyDown = (e) => {
      if (appState.gatewayViewOnly) return;
      if (e.key === 'Escape' && previewState.cadOverlay) {
        e.preventDefault();
        previewState.cadOverlay = false;
        bumpTile();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (previewState.focusedWindow === 'auth') {
          previewState.authInputText = previewState.authInputText.slice(0, -1);
        }
        bumpTile();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (previewState.focusedWindow === 'auth') {
          previewState.authStatus = previewState.authInputText
            ? `[OK] Submitted "${previewState.authInputText}" to remote session.`
            : 'Type characters or click "2FA Auto-Type" above.';
          previewState.authStatusTone = previewState.authInputText ? 'ok' : 'warn';
        } else {
          previewState.termLines.push('[OK] Remote desktop Enter key dispatched.');
        }
        bumpTile();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (previewState.focusedWindow === 'auth') {
          previewState.authInputText = `${previewState.authInputText}${e.key}`.slice(-28);
          previewState.authStatus = 'Live keyboard input received on remote desktop canvas.';
          previewState.authStatusTone = 'ok';
        } else {
          const lastIdx = previewState.termLines.length - 1;
          if (lastIdx >= 0 && previewState.termLines[lastIdx].startsWith('$ ')) {
            previewState.termLines[lastIdx] += e.key;
          } else {
            previewState.termLines.push(`$ ${e.key}`);
          }
        }
        bumpTile();
      }
    };

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('keydown', onKeyDown);
    previewState.listeners.push(
      ['pointermove', onPointerMove],
      ['pointerdown', onPointerDown],
      ['keydown', onKeyDown],
    );
  }

  updateGatewayHudMetrics({ fps: 30, rttMs: 1, kbPerSec: 162, tilesDecoded: previewState.tilesDecoded });
  renderGatewayPreviewCanvas();
  previewState.timerId = setInterval(() => {
    if (!appState.gatewayPreviewActive || !appState.gatewayPreviewState) return;
    renderGatewayPreviewCanvas();
  }, 1000);

  appendGatewayLog('Opened Interactive Browser Preview — start JalaDesk Gateway to connect to live servers.', 'ok');
  liveStage?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function handleGatewayAutoType2fa() {
  const isPreview = appState.gatewayPreviewActive && Boolean(appState.gatewayPreviewState);
  const client = appState.gatewayClient;

  if (!isPreview && (!client || !client.connected)) {
    showToast('Connect to a live Gateway session or open Interactive Preview first.', 'danger');
    return;
  }
  if (isPreview && appState.gatewayViewOnly) {
    showToast('View-Only mode active. Click Take Control before auto-typing 2FA.', 'danger');
    return;
  }
  if (!isPreview && !client.canSendInput()) {
    showToast('View-Only mode active. Click Take Control before auto-typing 2FA.', 'danger');
    return;
  }

  const select = byId('gateway-totp-select');
  const tokenId = select ? select.value : '';
  const payload = getPayloadSafe();
  const token = payload && Array.isArray(payload.totp) ? payload.totp.find((t) => String(t.id) === String(tokenId)) : null;

  if (!token && !isPreview) {
    showToast('Add a 2FA token in the Authenticator tab first.', 'danger');
    return;
  }

  try {
    let code = '';
    let digits = 6;
    let label = 'Demo Preview 2FA';
    if (token) {
      const evaluated = await evaluateTotpToken(token, Date.now());
      code = evaluated.code;
      digits = evaluated.digits;
      label = token.issuer || token.accountName || '2FA token';
    } else {
      const demoEval = await evaluateTotpToken(
        { secretBase32: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
        Date.now(),
      );
      code = demoEval.code;
      digits = demoEval.digits;
    }

    if (isPreview && appState.gatewayPreviewState) {
      const pState = appState.gatewayPreviewState;
      if (appState.gatewayPane === 'ssh') {
        dispatchSshTerminalInput(code);
        appState.sshTerminal?.focus();
      } else {
        pState.focusedWindow = 'auth';
        pState.authInputText = code;
        pState.authStatus = `[OK] Auto-typed ${digits}-digit 2FA (${label}): ${code}`;
        pState.authStatusTone = 'ok';
        pState.totpFlashUntil = Date.now() + 2400;
        pState.tilesDecoded += 1;
        updateGatewayHudMetrics({ fps: 30, rttMs: 1, kbPerSec: 196, tilesDecoded: pState.tilesDecoded });
        renderGatewayPreviewCanvas();
      }
      appendGatewayLog(`Auto-typed ${digits}-digit 2FA code (${label}) into Offline UI Preview.`, 'ok');
      showToast(`2FA code auto-typed into Preview (${label}).`, 'ok');
      return;
    }

    const sent =
      appState.gatewayPane === 'ssh'
        ? client.sendSshData(code)
        : client.sendText(code);
    if (sent) {
      if (appState.gatewayPane === 'ssh') {
        appState.sshTerminal?.focus();
      }
      appendGatewayLog(`Auto-typed live ${digits}-digit 2FA code for ${label} via JSR1 input.`, 'ok');
      showToast(`2FA code auto-typed for ${label}.`, 'ok');
    } else {
      showToast('Unable to send 2FA code: session is not holding input control.', 'danger');
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to compute 2FA code.', 'danger');
  }
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function joinSftpPath(basePath, name) {
  const cleanBase = String(basePath || '/').replace(/\/+$/, '');
  const cleanName = String(name || '').replace(/^\/+/, '');
  return cleanBase ? `${cleanBase}/${cleanName}` : `/${cleanName}`;
}

function formatByteSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function refreshGatewaySftpList(overridePath) {
  const client = appState.gatewayClient;
  const statusEl = byId('gateway-sftp-status');
  const listEl = byId('gateway-sftp-list');
  const pathInput = byId('gateway-sftp-path');
  if (appState.gatewayPreviewActive && (!client || !client.connected)) {
    if (overridePath !== undefined && pathInput) pathInput.value = overridePath;
    renderGatewayPreviewSftpList();
    return;
  }
  if (!client || !client.connected) return;

  const targetPath = (overridePath !== undefined ? overridePath : pathInput?.value || '/').trim() || '/';
  appState.gatewaySftpPath = targetPath;
  if (pathInput) pathInput.value = targetPath;
  if (statusEl) statusEl.textContent = `Listing ${targetPath}...`;

  try {
    const res = await client.sftpRequest('list', targetPath);
    if (!res.ok) {
      if (statusEl) statusEl.textContent = res.error || 'SFTP list failed.';
      return;
    }
    const entries = Array.isArray(res.entries) ? res.entries : [];
    if (statusEl) {
      statusEl.textContent = `${targetPath} · ${entries.length} ${entries.length === 1 ? 'item' : 'items'}`;
    }
    if (!listEl) return;
    listEl.replaceChildren();

    if (entries.length === 0) {
      listEl.appendChild(el('p', 'sftp-empty', 'Directory is empty.'));
      return;
    }

    for (const entry of entries) {
      const row = el('div', 'sftp-row');
      const nameWrap = el('div', 'sftp-name-wrap');
      const badge = el(
        'span',
        `proto-badge ${entry.type === 'dir' ? 'proto-hypervisor' : 'proto-sftp'} mono`,
        entry.type === 'dir' ? 'DIR' : 'FILE',
      );
      const nameEl = el('span', 'sftp-entry-name mono', entry.name);
      nameWrap.appendChild(badge);
      nameWrap.appendChild(nameEl);

      const metaEl = el('span', 'sftp-entry-meta mono', entry.type === 'dir' ? 'Folder' : formatByteSize(entry.size));
      const actions = el('div', 'sftp-row-actions');
      const fullPath = joinSftpPath(targetPath, entry.name);

      if (entry.type === 'dir') {
        const openBtn = el('button', 'btn btn-secondary btn-sm', 'Open');
        openBtn.type = 'button';
        openBtn.addEventListener('click', () => refreshGatewaySftpList(fullPath));
        actions.appendChild(openBtn);
      } else {
        const dlBtn = el('button', 'btn btn-secondary btn-sm', 'Download');
        dlBtn.type = 'button';
        dlBtn.addEventListener('click', () => handleGatewaySftpDownload(fullPath, entry.name));
        actions.appendChild(dlBtn);
      }

      const delBtn = el('button', 'btn btn-ghost btn-ghost-danger btn-sm', 'Delete');
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => requestDeleteSftpFile(fullPath, entry.name));
      actions.appendChild(delBtn);

      row.appendChild(nameWrap);
      row.appendChild(metaEl);
      row.appendChild(actions);
      listEl.appendChild(row);
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = err instanceof Error ? err.message : 'SFTP list failed.';
  }
}

async function handleGatewaySftpDownload(remotePath, fileName) {
  const client = appState.gatewayClient;
  if (!client || !client.connected) return;
  try {
    const res = await client.sftpRequest('read', remotePath);
    if (!res.ok || typeof res.dataBase64 !== 'string') {
      showToast(res.error || `Failed to read ${fileName}`, 'danger');
      return;
    }
    const bytes = base64ToUint8(res.dataBase64);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'download.bin';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Downloaded ${fileName} (${formatByteSize(bytes.byteLength)})`, 'ok');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'SFTP download failed.', 'danger');
  }
}

function requestDeleteSftpFile(remotePath, fileName) {
  openConfirmDeleteModal({
    title: 'Delete Remote File?',
    itemName: String(fileName || remotePath || 'Remote file'),
    itemMeta: String(remotePath || '/'),
    description: 'Delete this file directly on the remote SFTP host?',
    warning: 'Remote SFTP deletion is immediate on the server and cannot be undone.',
    syncNote: '',
    confirmLabel: 'Delete File',
    onConfirm: () => handleGatewaySftpDelete(remotePath, fileName),
  });
}

async function handleGatewaySftpDelete(remotePath, fileName) {
  const client = appState.gatewayClient;
  if (!client || !client.connected) return;
  try {
    const res = await client.sftpRequest('delete', remotePath);
    if (!res.ok) {
      showToast(res.error || `Failed to delete ${fileName}`, 'danger');
      return;
    }
    showToast(`Deleted ${fileName}`, 'ok');
    refreshGatewaySftpList();
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'SFTP delete failed.', 'danger');
  }
}

async function handleGatewaySftpUpload(file) {
  const client = appState.gatewayClient;
  if (!client || !client.connected || !file) return;
  if (file.size > 4 * 1024 * 1024) {
    showToast('Single SFTP upload chunk limit is 4 MB in browser studio.', 'danger');
    return;
  }
  try {
    const ab = await file.arrayBuffer();
    const dataBase64 = uint8ToBase64(new Uint8Array(ab));
    const destPath = joinSftpPath(appState.gatewaySftpPath, file.name);
    const res = await client.sftpRequest('write', destPath, { dataBase64 });
    if (!res.ok) {
      showToast(res.error || `Failed to upload ${file.name}`, 'danger');
      return;
    }
    showToast(`Uploaded ${file.name} (${formatByteSize(file.size)})`, 'ok');
    refreshGatewaySftpList();
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'SFTP upload failed.', 'danger');
  }
}

/* ==========================================================================
   Modals: Connection, 2FA Token, Credential
   ========================================================================== */

function openModal(modalId) {
  const backdrop = byId('jala-modal-backdrop');
  if (!backdrop) return;
  appState.lastModalTriggerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  for (const dlg of backdrop.querySelectorAll('.modal-dialog')) {
    dlg.hidden = dlg.id !== modalId;
  }
  backdrop.hidden = false;
  appState.activeModalId = modalId;
  if (modalId === 'modal-confirm-delete') {
    const cancelBtn = byId('btn-confirm-delete-cancel');
    if (cancelBtn) setTimeout(() => cancelBtn.focus(), 20);
    return;
  }
  const firstFocusable = byId(modalId)?.querySelector(
    'input:not([type="hidden"]):not([type="file"]), select, textarea, button:not([disabled])',
  );
  if (firstFocusable) setTimeout(() => firstFocusable.focus(), 30);
}

function closeActiveModal() {
  const backdrop = byId('jala-modal-backdrop');
  if (!backdrop) return;
  const trigger = appState.lastModalTriggerEl;
  backdrop.hidden = true;
  for (const dlg of backdrop.querySelectorAll('.modal-dialog')) {
    dlg.hidden = true;
  }
  appState.activeModalId = null;
  appState.pendingConfirmAction = null;
  appState.lastModalTriggerEl = null;
  if (trigger && trigger.isConnected) {
    setTimeout(() => {
      if (trigger.isConnected) trigger.focus();
    }, 0);
  }
}

function openConfirmDeleteModal({
  title = 'Delete Item?',
  itemName = '',
  itemMeta = '',
  description = 'Are you sure you want to delete this item?',
  warning = '',
  syncNote = '',
  confirmLabel = 'Delete',
  onConfirm = null,
}) {
  const titleEl = byId('confirm-delete-title');
  const nameEl = byId('confirm-delete-item-name');
  const metaEl = byId('confirm-delete-item-meta');
  const descEl = byId('confirm-delete-desc');
  const warnEl = byId('confirm-delete-warning');
  const syncEl = byId('confirm-delete-sync-note');
  const submitBtn = byId('btn-confirm-delete-submit');

  if (titleEl) titleEl.textContent = title;
  if (nameEl) nameEl.textContent = itemName;
  if (metaEl) {
    metaEl.textContent = itemMeta;
    metaEl.hidden = !itemMeta;
  }
  if (descEl) descEl.textContent = description;
  if (warnEl) {
    warnEl.textContent = warning;
    warnEl.hidden = !warning;
  }
  if (syncEl) {
    syncEl.textContent = syncNote;
    syncEl.hidden = !syncNote;
  }
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = confirmLabel;
  }

  appState.pendingConfirmAction = typeof onConfirm === 'function' ? onConfirm : null;
  openModal('modal-confirm-delete');
}

function openConnectionModal(existingHost = null, defaultJumpHost = false) {
  const payload = getPayloadSafe();
  if (!payload) return;

  setAlert('modal-conn-error', '');
  const title = byId('modal-conn-title');
  if (title) title.textContent = existingHost ? 'Edit Connection' : defaultJumpHost ? 'Add Jump Host Gateway' : 'Add Connection';

  const proto = existingHost ? String(existingHost.protocol || 'rdp').toLowerCase() : defaultJumpHost ? 'ssh' : 'rdp';
  setSegmentedValue(byId('conn-protocol-group'), 'data-proto', proto);

  byId('conn-id').value = existingHost ? String(existingHost.id) : '';
  byId('conn-name').value = existingHost ? String(existingHost.name || '') : '';
  byId('conn-address').value = existingHost ? String(existingHost.address || '') : '';
  byId('conn-port').value = existingHost ? String(existingHost.port || DEFAULT_PORTS[proto] || 22) : String(DEFAULT_PORTS[proto] || 3389);
  byId('conn-username').value = existingHost ? String(existingHost.username || '') : '';
  byId('conn-folder').value = existingHost ? String(existingHost.folder || '') : '';
  byId('conn-domain').value = existingHost ? String(existingHost.domain || existingHost.osLabel || '') : '';
  byId('conn-password').value = existingHost ? String(existingHost.password || '') : '';

  setSwitchState(byId('conn-is-jump-switch'), existingHost ? Boolean(existingHost.isJumpHost) : Boolean(defaultJumpHost));
  setSwitchState(byId('conn-is-fav-switch'), existingHost ? Boolean(existingHost.isFavorite) : false);

  // Populate Bastion dropdown
  const jumpSelect = byId('conn-jump-host');
  if (jumpSelect) {
    jumpSelect.replaceChildren();
    jumpSelect.appendChild(el('option', '', 'Direct (No Jump Host)'));
    const jumpHosts = (payload.hosts || []).filter((h) => h.isJumpHost && (!existingHost || h.id !== existingHost.id));
    for (const jh of jumpHosts) {
      const opt = document.createElement('option');
      opt.value = String(jh.id);
      opt.textContent = `${jh.name || jh.address} (${jh.address}:${jh.port || 22})`;
      jumpSelect.appendChild(opt);
    }
    jumpSelect.value = existingHost && existingHost.jumpHostId ? String(existingHost.jumpHostId) : '';
  }

  // Populate Credentials dropdown
  const credSelect = byId('conn-credential');
  if (credSelect) {
    credSelect.replaceChildren();
    credSelect.appendChild(el('option', '', 'Inline / None'));
    for (const c of payload.credentials || []) {
      const opt = document.createElement('option');
      opt.value = String(c.id);
      opt.textContent = `${c.label || 'Credential'}${c.username ? ` (${c.username})` : ''}`;
      credSelect.appendChild(opt);
    }
    credSelect.value = existingHost && existingHost.credentialId ? String(existingHost.credentialId) : '';
  }

  openModal('modal-connection');
}

async function handleSaveConnection(event) {
  event.preventDefault();
  const payload = getPayloadSafe();
  if (!payload) return;

  const proto = getSegmentedValue(byId('conn-protocol-group'), 'data-proto', 'rdp');
  const existingId = byId('conn-id').value.trim();
  const name = byId('conn-name').value.trim();
  const address = byId('conn-address').value.trim();
  const port = Number.parseInt(byId('conn-port').value, 10) || DEFAULT_PORTS[proto] || 22;
  const username = byId('conn-username').value.trim();
  const folder = byId('conn-folder').value.trim();
  const domainOrOs = byId('conn-domain').value.trim();
  const password = byId('conn-password').value;
  const jumpHostId = byId('conn-jump-host').value.trim() || null;
  const credentialId = byId('conn-credential').value.trim() || null;
  const isJumpHost = getSwitchState(byId('conn-is-jump-switch'));
  const isFavorite = getSwitchState(byId('conn-is-fav-switch'));

  if (!name || !address) {
    setAlert('modal-conn-error', 'Display Name and Host / IP Address are required.');
    return;
  }
  if (port < 1 || port > 65535) {
    setAlert('modal-conn-error', 'Port must be between 1 and 65535.');
    return;
  }

  const now = Date.now();
  const id = existingId || generateId('host');
  const prev = existingId ? payload.hosts.find((h) => h.id === existingId) : null;
  const record = {
    ...(prev || {}),
    id,
    name,
    address,
    port,
    protocol: proto,
    folder,
    osLabel: proto === 'rdp' ? '' : domainOrOs,
    domain: proto === 'rdp' ? domainOrOs : '',
    username,
    password,
    privateKeyPem: prev && typeof prev.privateKeyPem === 'string' ? prev.privateKeyPem : '',
    jumpHostId: isJumpHost ? null : jumpHostId,
    credentialId,
    isJumpHost,
    isFavorite,
    accentTint: prev && typeof prev.accentTint === 'string' ? prev.accentTint : 'sapphire',
    updatedAtMs: now,
  };

  if (existingId) {
    payload.hosts = payload.hosts.map((h) => (h.id === existingId ? record : h));
  } else {
    payload.hosts.push(record);
  }
  delete payload.tombstones[makeTombstoneKey('host', id)];
  payload.updatedAtMs = now;

  await saveVaultPayload(payload);
  closeActiveModal();
  renderAllViews();
  showToast(existingId ? `Updated ${name}.` : `Added ${name}.`, 'ok');
}

function openTotpModal(existingItem = null) {
  setAlert('modal-totp-error', '');
  const title = byId('modal-totp-title');
  if (title) title.textContent = existingItem ? 'Edit 2FA Token' : 'Add 2FA Token';

  byId('totp-id').value = existingItem ? String(existingItem.id) : '';
  byId('totp-uri-input').value = '';
  byId('totp-issuer').value = existingItem ? String(existingItem.issuer || '') : '';
  byId('totp-account').value = existingItem ? String(existingItem.accountName || existingItem.label || '') : '';
  byId('totp-secret').value = existingItem ? String(existingItem.secretBase32 || '') : '';

  setSegmentedValue(byId('totp-algo-group'), 'data-totp-algo', existingItem ? String(existingItem.algorithm || 'SHA1').toUpperCase() : 'SHA1');
  setSegmentedValue(byId('totp-digits-group'), 'data-totp-digits', existingItem ? String(existingItem.digits || 6) : '6');
  setSegmentedValue(byId('totp-period-group'), 'data-totp-period', existingItem ? String(existingItem.period || existingItem.periodSeconds || 30) : '30');

  updateTotpModalPreview();
  openModal('modal-totp');
}

async function updateTotpModalPreview() {
  const previewBar = byId('totp-preview-bar');
  const previewCode = byId('totp-preview-code');
  const secretRaw = (byId('totp-secret')?.value || '').trim();
  if (!previewBar || !previewCode) return;
  if (!secretRaw) {
    previewBar.hidden = true;
    return;
  }
  try {
    const normalized = normalizeTotpSecretBase32(secretRaw);
    const algorithm = getSegmentedValue(byId('totp-algo-group'), 'data-totp-algo', 'SHA1');
    const digits = Number.parseInt(getSegmentedValue(byId('totp-digits-group'), 'data-totp-digits', '6'), 10);
    const period = Number.parseInt(getSegmentedValue(byId('totp-period-group'), 'data-totp-period', '30'), 10);
    const evaluated = await evaluateTotpToken({ secretBase32: normalized, algorithm, digits, period });
    previewCode.textContent = evaluated.formattedCode;
    previewBar.hidden = false;
  } catch {
    previewBar.hidden = true;
  }
}

function handleParseOtpAuthUri() {
  const uri = (byId('totp-uri-input')?.value || '').trim();
  if (!uri) {
    setAlert('modal-totp-error', 'Paste an otpauth://totp/... URI first.');
    return;
  }
  try {
    const parsed = parseOtpAuthUri(uri);
    byId('totp-issuer').value = parsed.issuer || '';
    byId('totp-account').value = parsed.accountName || parsed.label || '';
    byId('totp-secret').value = parsed.secretBase32;
    setSegmentedValue(byId('totp-algo-group'), 'data-totp-algo', parsed.algorithm);
    setSegmentedValue(byId('totp-digits-group'), 'data-totp-digits', String(parsed.digits));
    setSegmentedValue(byId('totp-period-group'), 'data-totp-period', String(parsed.period));
    setAlert('modal-totp-error', '');
    updateTotpModalPreview();
    showToast('Parsed otpauth:// URI.', 'ok');
  } catch (err) {
    setAlert('modal-totp-error', err instanceof Error ? err.message : String(err));
  }
}

async function handleSaveTotp(event) {
  event.preventDefault();
  const payload = getPayloadSafe();
  if (!payload) return;

  const existingId = byId('totp-id').value.trim();
  const issuer = byId('totp-issuer').value.trim();
  const account = byId('totp-account').value.trim();
  const secretRaw = byId('totp-secret').value.trim();
  const algorithm = getSegmentedValue(byId('totp-algo-group'), 'data-totp-algo', 'SHA1');
  const digits = Number.parseInt(getSegmentedValue(byId('totp-digits-group'), 'data-totp-digits', '6'), 10) === 8 ? 8 : 6;
  const period = Number.parseInt(getSegmentedValue(byId('totp-period-group'), 'data-totp-period', '30'), 10) === 60 ? 60 : 30;

  if (!account && !issuer) {
    setAlert('modal-totp-error', 'Enter an Account or Issuer label.');
    return;
  }
  let secretBase32;
  try {
    secretBase32 = normalizeTotpSecretBase32(secretRaw);
  } catch (err) {
    setAlert('modal-totp-error', err instanceof Error ? err.message : 'Invalid Base32 secret.');
    return;
  }

  const now = Date.now();
  const id = existingId || generateId('totp');
  const label = account || issuer;
  const record = {
    id,
    label,
    accountName: label,
    issuer: issuer || 'Authenticator',
    secretBase32,
    algorithm,
    digits,
    period,
    periodSeconds: period,
    updatedAtMs: now,
  };

  if (existingId) {
    payload.totp = payload.totp.map((t) => (t.id === existingId ? record : t));
  } else {
    payload.totp.push(record);
  }
  delete payload.tombstones[makeTombstoneKey('totp', id)];
  payload.updatedAtMs = now;

  await saveVaultPayload(payload);
  closeActiveModal();
  renderAllViews();
  showToast(existingId ? 'Updated 2FA token.' : 'Added 2FA token.', 'ok');
}

function updateCredModalKindFields(kind) {
  const pemWrap = byId('cred-pem-wrap');
  const domainWrap = byId('cred-domain-wrap');
  if (pemWrap) pemWrap.hidden = kind !== 'sshKey';
  if (domainWrap) domainWrap.hidden = kind === 'sshKey';
}

function openCredentialModal(existingCred = null) {
  setAlert('modal-cred-error', '');
  const title = byId('modal-cred-title');
  if (title) title.textContent = existingCred ? 'Edit Credential' : 'Add Credential';

  const kind = existingCred ? resolveCredentialKind(existingCred) : 'password';
  setSegmentedValue(byId('cred-kind-group'), 'data-cred-kind', kind);
  updateCredModalKindFields(kind);

  byId('cred-id').value = existingCred ? String(existingCred.id) : '';
  byId('cred-label').value = existingCred ? String(existingCred.label || '') : '';
  byId('cred-username').value = existingCred ? String(existingCred.username || '') : '';
  byId('cred-domain').value = existingCred ? String(existingCred.domain || '') : '';
  byId('cred-password').value = existingCred ? String(existingCred.password || '') : '';
  byId('cred-pem').value = existingCred ? String(existingCred.privateKeyPem || '') : '';
  byId('cred-notes').value = existingCred ? String(existingCred.notes || '') : '';

  openModal('modal-credential');
}

async function handleSaveCredential(event) {
  event.preventDefault();
  const payload = getPayloadSafe();
  if (!payload) return;

  const existingId = byId('cred-id').value.trim();
  const kind = getSegmentedValue(byId('cred-kind-group'), 'data-cred-kind', 'password');
  const label = byId('cred-label').value.trim();
  const username = byId('cred-username').value.trim();
  const domain = byId('cred-domain').value.trim();
  const password = byId('cred-password').value;
  const privateKeyPem = byId('cred-pem').value.trim();
  const notes = byId('cred-notes').value.trim();

  if (!label) {
    setAlert('modal-cred-error', 'Credential Label is required.');
    return;
  }

  const now = Date.now();
  const id = existingId || generateId('cred');
  const record = {
    id,
    kind,
    label,
    domain: kind === 'sshKey' ? '' : domain,
    username,
    password,
    privateKeyPem: kind === 'sshKey' ? privateKeyPem : '',
    notes,
    updatedAtMs: now,
  };

  if (existingId) {
    payload.credentials = payload.credentials.map((c) => (c.id === existingId ? record : c));
  } else {
    payload.credentials.push(record);
  }
  delete payload.tombstones[makeTombstoneKey('cred', id)];
  payload.updatedAtMs = now;

  await saveVaultPayload(payload);
  closeActiveModal();
  renderAllViews();
  showToast(existingId ? `Updated ${label}.` : `Saved ${label}.`, 'ok');
}

/* ==========================================================================
   Global Command Palette (⌘K / Ctrl+K)
   ========================================================================== */

function fuzzyScore(query, text) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 1;
  const target = String(text || '').toLowerCase();
  if (!target) return 0;
  if (target === q) return 1000;
  if (target.startsWith(q)) return 820 - target.length * 0.1;

  const subIdx = target.indexOf(q);
  if (subIdx >= 0) {
    const atBoundary = subIdx === 0 || /[\s\-_.:/@]/.test(target[subIdx - 1]);
    return (atBoundary ? 680 : 540) - subIdx;
  }

  // Fuzzy subsequence matching with consecutive-character & boundary bonuses
  let qi = 0;
  let score = 120;
  let prevMatchIdx = -2;
  for (let ti = 0; ti < target.length && qi < q.length; ti += 1) {
    if (target[ti] === q[qi]) {
      if (ti === prevMatchIdx + 1) {
        score += 24;
      } else if (ti === 0 || /[\s\-_.:/@]/.test(target[ti - 1])) {
        score += 18;
      } else {
        score += 6;
      }
      prevMatchIdx = ti;
      qi += 1;
    }
  }
  return qi === q.length ? score : 0;
}

function buildCommandPaletteItems(rawQuery) {
  const payload = getPayloadSafe();
  const hosts = payload && Array.isArray(payload.hosts) ? payload.hosts : [];
  const totp = payload && Array.isArray(payload.totp) ? payload.totp : [];
  const creds = payload && Array.isArray(payload.credentials) ? payload.credentials : [];
  const query = String(rawQuery || '').trim();

  const candidates = [];

  // 1. Connections & Jump Hosts
  for (const host of hosts) {
    const proto = String(host.protocol || 'rdp').toLowerCase();
    const safeProto = ['rdp', 'vnc', 'ssh', 'sftp', 'hypervisor'].includes(proto) ? proto : 'rdp';
    const port = Number(host.port) || DEFAULT_PORTS[safeProto] || 22;
    const linkedCred = host.credentialId ? creds.find((c) => c.id === host.credentialId) : null;
    const user = String(host.username || (linkedCred && linkedCred.username) || '').trim();
    const endpoint = `${user ? `${user}@` : ''}${host.address || 'unknown'}:${port}`;
    const group = host.isJumpHost ? 'Jump Hosts' : 'Connections';
    const title = String(host.name || host.address || 'Unnamed Host');
    const subParts = [endpoint];
    if (host.folder && String(host.folder).trim()) subParts.push(String(host.folder).trim());
    candidates.push({
      id: `cmdk-host-${host.id}`,
      group,
      badge: host.isJumpHost ? 'JUMP' : safeProto.toUpperCase(),
      badgeClass: host.isJumpHost ? 'proto-hypervisor' : `proto-${safeProto}`,
      title,
      subtitle: subParts.join(' · '),
      actionLabel: 'Connect',
      searchText: `${title} ${host.address || ''} ${proto} ${user} ${host.folder || ''} ${host.domain || ''} ${host.isJumpHost ? 'jump bastion' : ''}`,
      run: () => openHostInGateway(host.id),
    });
  }

  // 2. 2FA Authenticator Accounts (Enter -> 1-click copy live TOTP!)
  for (const item of totp) {
    const issuer = String(item.issuer || 'Authenticator');
    const account = String(item.accountName || item.label || 'Account');
    const algo = String(item.algorithm || 'SHA1').toUpperCase();
    const digits = Number(item.digits || 6);
    candidates.push({
      id: `cmdk-totp-${item.id}`,
      group: '2FA Authenticator',
      badge: '2FA',
      badgeClass: 'proto-sftp',
      title: issuer,
      subtitle: `${account} · ${algo} ${digits}-digit`,
      actionLabel: 'Copy 2FA',
      searchText: `2fa totp otp code ${issuer} ${account} ${algo}`,
      run: async () => {
        try {
          const evaluated = await evaluateTotpToken({
            secretBase32: item.secretBase32,
            algorithm: item.algorithm || 'SHA1',
            digits: Number(item.digits || 6),
            period: Number(item.period || item.periodSeconds || 30),
          });
          await copyText(evaluated.code, `${issuer} 2FA code`, true);
        } catch {
          showToast('Unable to generate 2FA code for this entry.', 'danger');
        }
      },
    });
  }

  // 3. Credentials (ZERO secrets exposed in palette metadata)
  for (const cred of creds) {
    const kind = resolveCredentialKind(cred);
    const kindLabel = kind === 'sshKey' ? 'SSH Key' : kind === 'domain' ? 'Domain' : 'Password';
    const label = String(cred.label || 'Credential');
    const user = String(cred.username || '').trim();
    const domain = String(cred.domain || '').trim();
    const subParts = [user || 'No username'];
    if (domain) subParts.push(domain);
    subParts.push(kindLabel);
    candidates.push({
      id: `cmdk-cred-${cred.id}`,
      group: 'Credentials',
      badge: 'CRED',
      badgeClass: 'proto-vnc',
      title: label,
      subtitle: subParts.join(' · '),
      actionLabel: 'Edit',
      searchText: `credential password key ${label} ${user} ${domain} ${kindLabel}`,
      run: () => {
        switchWorkspaceView('credentials', true);
        openCredentialModal(cred);
      },
    });
  }

  // 4. Workspace Actions
  const workspaceActions = [
    {
      id: 'cmdk-act-new-conn',
      title: 'New Connection',
      subtitle: 'Add an RDP, VNC, SSH, SFTP, or Hypervisor host',
      badge: 'NEW',
      actionLabel: 'Open',
      searchText: 'new connection add host rdp ssh vnc sftp server',
      run: () => openConnectionModal(null, false),
    },
    {
      id: 'cmdk-act-add-jump',
      title: 'Add Jump Host',
      subtitle: 'Register an SSH bastion for multi-hop tunneling',
      badge: 'JUMP',
      actionLabel: 'Open',
      searchText: 'add jump host bastion proxyjump tunnel',
      run: () => openConnectionModal(null, true),
    },
    {
      id: 'cmdk-act-add-2fa',
      title: 'Add 2FA Account',
      subtitle: 'Create an RFC 6238 authenticator entry or parse otpauth:// URI',
      badge: '2FA',
      actionLabel: 'Open',
      searchText: 'add 2fa account totp authenticator otpauth',
      run: () => openTotpModal(null),
    },
    {
      id: 'cmdk-act-import-ssh',
      title: 'Import ~/.ssh/config',
      subtitle: 'Parse OpenSSH hosts and ProxyJump bastions locally in browser',
      badge: 'SSH',
      actionLabel: 'Import',
      searchText: 'import ssh config openssh ~/.ssh/config hosts proxyjump',
      run: () => openSshImportModal(),
    },
    {
      id: 'cmdk-act-sync',
      title: 'Sync Cloud Now',
      subtitle: 'Run zero-knowledge AES-256-GCM Smart Merge cloud sync',
      badge: 'SYNC',
      actionLabel: 'Run',
      searchText: 'sync cloud now google drive github gist webdav merge',
      run: () => {
        if (hasActiveCloudSessionInRam()) {
          runCloudSync('smartMerge');
        } else {
          switchWorkspaceView('sync', true);
          showToast('Sign in or configure a cloud provider to run Smart Merge Sync.', 'default');
        }
      },
    },
    {
      id: 'cmdk-act-gateway',
      title: 'Open Web Gateway',
      subtitle: 'Launch live JSR1 Desktop, VT100 SSH TUI, or SFTP browser',
      badge: 'GW',
      actionLabel: 'Switch',
      searchText: 'open web gateway terminal ssh sftp rdp vnc docker',
      run: () => switchWorkspaceView('gateway', true),
    },
    {
      id: 'cmdk-act-audit',
      title: 'Vault Security Audit',
      subtitle: 'Inspect encryption posture, auto-lock policy, 2FA, and credential hygiene',
      badge: 'AUDIT',
      actionLabel: 'Inspect',
      searchText: 'vault security audit health score hygiene encryption autolock',
      run: () => {
        appState.vaultHealthDetailsOpen = true;
        switchWorkspaceView('connections', true);
        renderVaultHealthStrips();
        byId('vault-health-strip')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
    },
    {
      id: 'cmdk-act-shortcuts',
      title: 'Keyboard Shortcuts',
      subtitle: 'View workspace hotkeys and command reference',
      badge: 'KEYS',
      actionLabel: 'Show',
      searchText: 'keyboard shortcuts hotkeys cheat sheet help ?',
      run: () => openModal('modal-shortcuts'),
    },
    {
      id: 'cmdk-act-export',
      title: 'Export .jvault',
      subtitle: 'Download portable AES-256-GCM encrypted vault backup',
      badge: 'SAVE',
      actionLabel: 'Export',
      searchText: 'export jvault backup archive download encrypted',
      run: () => handleExportJvault(),
    },
    {
      id: 'cmdk-act-lock',
      title: 'Lock Vault',
      subtitle: 'Lock immediately and scrub all decrypted secrets from RAM',
      badge: 'LOCK',
      actionLabel: 'Lock',
      searchText: 'lock vault sign out wipe ram security',
      run: () => {
        store.lock();
        showLockScreen('Vault locked. All decrypted secrets were wiped from RAM.');
      },
    },
  ];

  for (const act of workspaceActions) {
    candidates.push({
      ...act,
      group: 'Workspace Actions',
      badgeClass: 'proto-rdp',
    });
  }

  if (!query) {
    return candidates;
  }

  const scored = [];
  for (const item of candidates) {
    const titleScore = fuzzyScore(query, item.title);
    const metaScore = fuzzyScore(query, item.searchText) * 0.78;
    const best = Math.max(titleScore, metaScore);
    if (best > 0) {
      scored.push({ item, score: best });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}

function renderCommandPaletteList() {
  const listbox = byId('cmdk-listbox');
  const countEl = byId('cmdk-result-count');
  const inputEl = byId('cmdk-input');
  if (!listbox) return;

  const items = buildCommandPaletteItems(appState.cmdkQuery);
  appState.cmdkItems = items;
  if (items.length === 0) {
    appState.cmdkActiveIndex = -1;
  } else if (appState.cmdkActiveIndex < 0 || appState.cmdkActiveIndex >= items.length) {
    appState.cmdkActiveIndex = 0;
  }

  listbox.replaceChildren();
  if (countEl) {
    countEl.textContent = `${items.length} ${items.length === 1 ? 'result' : 'results'}`;
  }

  if (items.length === 0) {
    listbox.appendChild(el('p', 'cmdk-empty', `No matches for "${appState.cmdkQuery.trim()}".`));
    if (inputEl) inputEl.removeAttribute('aria-activedescendant');
    return;
  }

  const groupOrder = ['Connections', 'Jump Hosts', '2FA Authenticator', 'Credentials', 'Workspace Actions'];
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.group)) grouped.set(item.group, []);
    grouped.get(item.group).push(item);
  }

  const orderedItems = [];
  const groupsToRender = appState.cmdkQuery.trim()
    ? Array.from(grouped.keys())
    : groupOrder.filter((g) => grouped.has(g));

  for (const groupName of groupsToRender) {
    const list = grouped.get(groupName);
    if (!list || list.length === 0) continue;
    const header = el('div', 'cmdk-group-label', groupName);
    header.setAttribute('role', 'presentation');
    listbox.appendChild(header);

    for (const item of list) {
      const idx = orderedItems.length;
      orderedItems.push(item);
      const isActive = idx === appState.cmdkActiveIndex;

      const opt = el('button', `cmdk-option${isActive ? ' is-active' : ''}`);
      opt.type = 'button';
      opt.id = `cmdk-opt-${idx}`;
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', isActive ? 'true' : 'false');

      const main = el('div', 'cmdk-option-main');
      main.appendChild(el('span', `proto-badge ${item.badgeClass} mono`, item.badge));
      const copy = el('div', 'cmdk-option-copy');
      copy.appendChild(el('span', 'cmdk-option-title', item.title));
      if (item.subtitle) {
        copy.appendChild(el('span', 'cmdk-option-sub mono', item.subtitle));
      }
      main.appendChild(copy);
      opt.appendChild(main);

      opt.appendChild(el('span', 'cmdk-option-action', item.actionLabel));
      opt.addEventListener('mouseenter', () => {
        setCommandPaletteActiveIndex(idx, false);
      });
      opt.addEventListener('click', () => {
        executeCommandPaletteItem(idx);
      });
      listbox.appendChild(opt);
    }
  }

  appState.cmdkItems = orderedItems;
  if (inputEl && appState.cmdkActiveIndex >= 0 && appState.cmdkActiveIndex < orderedItems.length) {
    inputEl.setAttribute('aria-activedescendant', `cmdk-opt-${appState.cmdkActiveIndex}`);
  }
}

function setCommandPaletteActiveIndex(nextIndex, shouldScroll = true) {
  const len = appState.cmdkItems.length;
  if (len === 0) return;
  const wrapped = ((nextIndex % len) + len) % len;
  appState.cmdkActiveIndex = wrapped;

  const listbox = byId('cmdk-listbox');
  const inputEl = byId('cmdk-input');
  if (!listbox) return;
  const opts = listbox.querySelectorAll('.cmdk-option');
  for (let i = 0; i < opts.length; i += 1) {
    const active = i === wrapped;
    opts[i].classList.toggle('is-active', active);
    opts[i].setAttribute('aria-selected', active ? 'true' : 'false');
    if (active && shouldScroll) {
      opts[i].scrollIntoView({ block: 'nearest' });
    }
  }
  if (inputEl) {
    inputEl.setAttribute('aria-activedescendant', `cmdk-opt-${wrapped}`);
  }
}

function executeCommandPaletteItem(index = appState.cmdkActiveIndex) {
  const item = appState.cmdkItems[index];
  if (!item || typeof item.run !== 'function') return;
  closeActiveModal();
  item.run();
}

function openCommandPalette() {
  if (!store.isUnlocked()) return;
  appState.cmdkQuery = '';
  appState.cmdkActiveIndex = 0;
  const input = byId('cmdk-input');
  if (input) input.value = '';
  renderCommandPaletteList();
  openModal('modal-command-palette');
}

/* ==========================================================================
   Pure Client-Side OpenSSH (~/.ssh/config) Importer Modal
   ========================================================================== */

function openSshImportModal() {
  if (!store.isUnlocked()) return;
  setAlert('modal-ssh-import-error', '');
  setAlert('ssh-import-warnings', '');
  appState.sshImportParsed = null;

  const ta = byId('ssh-import-textarea');
  const folderInput = byId('ssh-import-folder');
  const fileInput = byId('ssh-import-file');
  const dropLabel = byId('ssh-import-dropzone-label');
  const dropMeta = byId('ssh-import-dropzone-meta');
  const previewBox = byId('ssh-import-preview-box');
  const previewList = byId('ssh-import-preview-list');
  const confirmBtn = byId('btn-ssh-import-confirm');

  if (ta) ta.value = '';
  if (folderInput) folderInput.value = '';
  if (fileInput) fileInput.value = '';
  if (dropLabel) dropLabel.textContent = 'Drop ~/.ssh/config here or click to select file';
  if (dropMeta) dropMeta.textContent = 'Client-side only · zero plaintext upload';
  if (previewBox) previewBox.hidden = true;
  if (previewList) previewList.replaceChildren();
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Import Hosts';
  }
  openModal('modal-ssh-import');
}

function updateSshImportPreview() {
  const ta = byId('ssh-import-textarea');
  const folderInput = byId('ssh-import-folder');
  const previewBox = byId('ssh-import-preview-box');
  const previewSummary = byId('ssh-import-preview-summary');
  const previewList = byId('ssh-import-preview-list');
  const confirmBtn = byId('btn-ssh-import-confirm');
  if (!ta || !previewBox || !previewList || !confirmBtn) return;

  setAlert('modal-ssh-import-error', '');
  const rawText = ta.value || '';
  if (!rawText.trim()) {
    appState.sshImportParsed = null;
    previewBox.hidden = true;
    previewList.replaceChildren();
    setAlert('ssh-import-warnings', '');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Import Hosts';
    return;
  }

  const payload = getPayloadSafe();
  const existingHosts = payload && Array.isArray(payload.hosts) ? payload.hosts : [];
  const defaultFolder = (folderInput?.value || '').trim();
  const parsed = parseOpenSshConfig(rawText, { existingHosts, defaultFolder });
  appState.sshImportParsed = parsed;

  const summaryBits = [`${parsed.hosts.length} new ${parsed.hosts.length === 1 ? 'host' : 'hosts'}`];
  if (parsed.jumpHosts.length > 0) {
    summaryBits.push(`${parsed.jumpHosts.length} jump`);
  }
  if (parsed.skippedWildcards > 0) {
    summaryBits.push(`${parsed.skippedWildcards} wildcard skipped`);
  }
  if (parsed.duplicatesSkipped > 0) {
    summaryBits.push(`${parsed.duplicatesSkipped} duplicate skipped`);
  }
  if (previewSummary) {
    previewSummary.textContent = summaryBits.join(' · ');
  }

  const nameById = new Map();
  for (const h of existingHosts) nameById.set(h.id, h.name || h.address);
  for (const h of parsed.hosts) nameById.set(h.id, h.name || h.address);

  previewList.replaceChildren();
  if (parsed.hosts.length === 0) {
    previewList.appendChild(
      el('p', 'cmdk-empty', 'No new concrete SSH hosts detected (all entries were wildcards or already in your vault).'),
    );
  } else {
    for (const host of parsed.hosts) {
      const row = el('div', 'ssh-preview-row');
      const main = el('div', 'ssh-preview-main');
      main.appendChild(el('span', 'proto-badge proto-ssh mono', 'SSH'));
      main.appendChild(el('span', 'ssh-preview-name', host.name));
      const endpoint = `${host.username ? `${host.username}@` : ''}${host.address}:${host.port}`;
      main.appendChild(el('span', 'ssh-preview-endpoint mono', endpoint));
      row.appendChild(main);

      const badges = el('div', 'ssh-preview-badges');
      if (host.isJumpHost) {
        badges.appendChild(
          el('span', 'meta-pill meta-pill-jump-role', host.autoCreatedJumpHost ? 'Auto Jump Host' : 'Jump Host'),
        );
      }
      if (host.jumpHostId) {
        const jumpLabel = nameById.get(host.jumpHostId) || 'Bastion';
        badges.appendChild(el('span', 'meta-pill meta-pill-bastion mono', `via ${jumpLabel}`));
      }
      if (badges.childElementCount > 0) {
        row.appendChild(badges);
      }
      previewList.appendChild(row);
    }
  }

  previewBox.hidden = false;
  if (parsed.warnings.length > 0) {
    setAlert('ssh-import-warnings', parsed.warnings.slice(0, 3).join(' '));
  } else {
    setAlert('ssh-import-warnings', '');
  }

  confirmBtn.disabled = parsed.hosts.length === 0;
  confirmBtn.textContent =
    parsed.hosts.length > 0
      ? `Import ${parsed.hosts.length} ${parsed.hosts.length === 1 ? 'Host' : 'Hosts'}`
      : 'Import Hosts';
}

async function handleConfirmSshImport(event) {
  event.preventDefault();
  const payload = getPayloadSafe();
  if (!payload) return;

  if (!appState.sshImportParsed) {
    updateSshImportPreview();
  }
  const parsed = appState.sshImportParsed;
  if (!parsed || parsed.hosts.length === 0) {
    setAlert('modal-ssh-import-error', 'Paste or select an OpenSSH config containing at least one new host.');
    return;
  }

  const now = Date.now();
  const refJumpSet = new Set(parsed.referencedExistingJumpHostIds || []);
  if (refJumpSet.size > 0) {
    payload.hosts = payload.hosts.map((h) =>
      refJumpSet.has(h.id) ? { ...h, isJumpHost: true, updatedAtMs: now } : h,
    );
  }

  for (const h of parsed.hosts) {
    const cleanHost = {
      id: h.id,
      name: h.name,
      address: h.address,
      port: h.port,
      protocol: 'ssh',
      folder: h.folder || '',
      osLabel: '',
      domain: '',
      username: h.username || '',
      password: '',
      privateKeyPem: '',
      jumpHostId: h.jumpHostId || null,
      credentialId: null,
      isJumpHost: Boolean(h.isJumpHost),
      isFavorite: false,
      accentTint: h.isJumpHost ? 'gold' : 'sapphire',
      updatedAtMs: now,
    };
    payload.hosts.push(cleanHost);
    delete payload.tombstones[makeTombstoneKey('host', cleanHost.id)];
  }
  payload.updatedAtMs = now;

  await saveVaultPayload(payload);
  appState.sshImportParsed = null;
  closeActiveModal();
  switchWorkspaceView('connections', true);
  renderAllViews();
  showToast(
    `Imported ${parsed.hosts.length} SSH ${parsed.hosts.length === 1 ? 'host' : 'hosts'} into encrypted vault.`,
    'ok',
  );
}

/* ==========================================================================
   Dropzone Helper (.jvault File Selection & Drag-and-Drop)
   ========================================================================== */

function bindJvaultDropzone(zoneId, fileInputId, labelId, metaId, onLoaded) {
  const zone = byId(zoneId);
  const fileInput = byId(fileInputId);
  const label = byId(labelId);
  const meta = byId(metaId);
  if (!zone || !fileInput) return;

  const readFileObject = async (file) => {
    if (!file) return;
    const text = await file.text();
    onLoaded(text, file.name);
    if (label) label.textContent = file.name;
    if (meta) meta.textContent = `${file.size.toLocaleString()} bytes loaded · ready to decrypt`;
  };

  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) {
      readFileObject(fileInput.files[0]);
    }
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      readFileObject(e.dataTransfer.files[0]);
    }
  });
}

/* ==========================================================================
   Event Wiring & Initialization
   ========================================================================== */

function wireEventListeners() {
  // Password visibility toggles
  document.addEventListener('click', (e) => {
    const toggleBtn = e.target instanceof Element ? e.target.closest('[data-toggle-visibility]') : null;
    if (!toggleBtn) return;
    const targetId = toggleBtn.getAttribute('data-toggle-visibility');
    const input = targetId ? byId(targetId) : null;
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    toggleBtn.setAttribute('aria-pressed', showing ? 'false' : 'true');
    toggleBtn.setAttribute('aria-label', showing ? 'Show passphrase' : 'Hide passphrase');
  });

  // Lock screen — Unlock returning vault
  byId('form-unlock')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAlert('lock-error', '');
    const passphrase = byId('unlock-passphrase')?.value || '';
    if (!passphrase) {
      setAlert('lock-error', 'Enter your master passphrase to unlock.');
      return;
    }
    const btn = byId('btn-unlock-vault');
    if (btn) btn.disabled = true;
    try {
      await store.unlock(passphrase);
      enterUnlockedShell(passphrase);
    } catch (err) {
      setAlert('lock-error', err instanceof Error ? err.message : 'Invalid passphrase or corrupted vault.');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  byId('btn-returning-google-unlock')?.addEventListener('click', () => {
    handleReturningGoogleUnlock();
  });

  byId('btn-returning-gdrive-grant')?.addEventListener('click', () => {
    const hint = appState.returningGdrivePendingEmail || ramSecrets.gdriveEmail || store.getUiPrefs().googleAccountEmail || '';
    handleReturningGoogleUnlock({ loginHint: hint, prompt: 'consent' });
  });

  byId('btn-returning-use-passphrase')?.addEventListener('click', () => {
    appState.returningPassphraseOverride = true;
    setAlert('lock-error', '');
    renderReturningLockMode({ focus: true });
  });

  byId('btn-returning-back-google')?.addEventListener('click', () => {
    appState.returningPassphraseOverride = false;
    setAlert('lock-error', '');
    renderReturningLockMode({ focus: true });
  });

  byId('btn-returning-import')?.addEventListener('click', () => {
    byId('lock-returning-panel').hidden = true;
    byId('lock-onboarding-panel').hidden = false;
    switchOnboardTab('import');
  });

  byId('btn-returning-cloud')?.addEventListener('click', () => {
    byId('lock-returning-panel').hidden = true;
    byId('lock-onboarding-panel').hidden = false;
    switchOnboardTab('cloud');
  });

  byId('btn-back-to-unlock')?.addEventListener('click', () => {
    byId('lock-onboarding-panel').hidden = true;
    byId('lock-returning-panel').hidden = false;
    setAlert('lock-error', '');
    renderReturningLockMode({ focus: true });
  });

  byId('btn-returning-reset')?.addEventListener('click', () => {
    openConfirmDeleteModal({
      title: 'Reset Local Browser Vault?',
      itemName: 'Sealed Local Vault',
      itemMeta: 'AES-256-GCM browser storage envelope',
      description: 'Permanently erase the sealed vault stored in this browser?',
      warning: 'This cannot be undone. Export a .jvault backup or confirm your Cloud Sync copy exists before erasing.',
      syncNote: 'Cloud Sync copies on Google Drive, GitHub Gist, or WebDAV are not deleted by resetting this browser.',
      confirmLabel: 'Erase Local Vault',
      onConfirm: () => {
        store.resetVault({ clearPrefs: false });
        showLockScreen('Local sealed browser vault erased. Create a new vault or import a .jvault backup.');
      },
    });
  });

  // Lock screen — Onboarding tabs
  byId('onboard-mode-tabs')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-onboard-tab]') : null;
    if (!btn) return;
    switchOnboardTab(btn.getAttribute('data-onboard-tab') || 'create');
  });

  byId('create-autolock-group')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-autolock]') : null;
    if (!btn) return;
    appState.onboardAutolock = btn.getAttribute('data-autolock') || '300';
    setSegmentedValue(byId('create-autolock-group'), 'data-autolock', appState.onboardAutolock);
  });

  // Create new encrypted vault
  byId('form-onboard-create')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAlert('lock-error', '');
    const pass = byId('create-passphrase')?.value || '';
    const confirm = byId('create-passphrase-confirm')?.value || '';
    if (pass.trim().length < 4) {
      setAlert('lock-error', 'Master passphrase must be at least 4 characters.');
      return;
    }
    if (confirm.length > 0 && pass !== confirm) {
      setAlert('lock-error', 'Passphrases do not match.');
      return;
    }
    const btn = byId('btn-create-vault');
    if (btn) btn.disabled = true;
    try {
      applyAutoLockSelection(appState.onboardAutolock);
      await store.createVault(pass, createEmptyVaultPayload());
      store.saveUiPrefs({ vaultAuthMode: 'passphrase', useCustomPassphrase: false });
      enterUnlockedShell(pass);
      showToast('Zero-knowledge AES-256-GCM vault created.', 'ok');
    } catch (err) {
      setAlert('lock-error', err instanceof Error ? err.message : String(err));
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Import .jvault from lock screen
  bindJvaultDropzone('lock-dropzone', 'lock-jvault-file', 'lock-dropzone-label', 'lock-dropzone-meta', (text, name) => {
    appState.lockImportFileText = text;
    appState.lockImportFileName = name;
  });

  byId('form-onboard-import')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAlert('lock-error', '');
    const pass = byId('import-lock-passphrase')?.value || '';
    if (!appState.lockImportFileText) {
      setAlert('lock-error', 'Select or drop a .jvault archive first.');
      return;
    }
    if (!pass) {
      setAlert('lock-error', 'Enter the passphrase for this .jvault backup.');
      return;
    }
    try {
      await store.importEnvelope(appState.lockImportFileText, pass, { mode: 'replace' });
      store.saveUiPrefs({ vaultAuthMode: 'passphrase' });
      enterUnlockedShell(pass);
      showToast(`Imported ${appState.lockImportFileName || '.jvault backup'}.`, 'ok');
    } catch (err) {
      setAlert('lock-error', err instanceof Error ? err.message : 'Unable to decrypt .jvault file.');
    }
  });

  // Cloud Sync from lock screen
  byId('onboard-cloud-provider')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-cloud-provider]') : null;
    if (!btn) return;
    const prov = btn.getAttribute('data-cloud-provider') || 'googleDrive';
    updateOnboardCloudProviderUi(prov);
    setAlert('lock-error', '');
  });

  byId('onboard-gdrive-custom-pass-switch')?.addEventListener('click', () => {
    appState.onboardGdriveCustomPass = !appState.onboardGdriveCustomPass;
    setSwitchState(byId('onboard-gdrive-custom-pass-switch'), appState.onboardGdriveCustomPass);
    const wrap = byId('onboard-gdrive-custom-pass-wrap');
    if (wrap) wrap.hidden = !appState.onboardGdriveCustomPass;
    if (appState.onboardGdriveCustomPass) {
      byId('onboard-gdrive-custom-passphrase')?.focus();
    }
  });

  byId('onboard-gdrive-client-id')?.addEventListener('change', (e) => {
    const val = (e.target.value || '').trim();
    store.saveUiPrefs({ googleClientId: val });
  });

  byId('btn-onboard-gdrive-signin')?.addEventListener('click', () => {
    handleOnboardGoogleSignIn();
  });

  byId('btn-onboard-gdrive-grant')?.addEventListener('click', () => {
    const hint = appState.onboardGdrivePendingEmail || ramSecrets.gdriveEmail || store.getUiPrefs().googleAccountEmail || '';
    handleOnboardGoogleSignIn({ loginHint: hint, prompt: 'consent' });
  });

  byId('btn-onboard-gdrive-manual-submit')?.addEventListener('click', () => {
    handleOnboardGoogleManualPull();
  });

  byId('form-onboard-cloud')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAlert('lock-error', '');
    const prov = appState.onboardCloudProvider;
    if (prov === 'googleDrive') {
      await handleOnboardGoogleSignIn();
      return;
    }

    const effectivePass = (byId('onboard-cloud-passphrase')?.value || '').trim();
    if (effectivePass.length < 4) {
      setAlert('lock-error', 'Enter a vault E2EE passphrase (min 4 characters).');
      return;
    }

    try {
      let result;
      if (prov === 'githubGist') {
        const token = (byId('onboard-gist-token')?.value || '').trim();
        const gistId = (byId('onboard-gist-id')?.value || '').trim();
        result = await syncWithGithubGist({
          token,
          gistId: gistId || undefined,
          localPayload: createEmptyVaultPayload(),
          passphrase: effectivePass,
          mode: 'pullOnly',
        });
        ramSecrets.gistToken = token;
        store.saveUiPrefs({
          syncProvider: 'githubGist',
          vaultAuthMode: 'passphrase',
          githubGistId: result.gistId || gistId,
          lastSyncedAtMs: result.syncedAtMs,
        });
      } else {
        const url = (byId('onboard-webdav-url')?.value || '').trim();
        const username = (byId('onboard-webdav-user')?.value || '').trim();
        const password = byId('onboard-webdav-pass')?.value || '';
        result = await syncWithWebDav({
          url,
          username,
          password,
          localPayload: createEmptyVaultPayload(),
          passphrase: effectivePass,
          mode: 'pullOnly',
        });
        ramSecrets.webdavPassword = password;
        store.saveUiPrefs({
          syncProvider: 'webdav',
          vaultAuthMode: 'passphrase',
          webdavUrl: url,
          webdavUsername: username,
          lastSyncedAtMs: result.syncedAtMs,
        });
      }
      await store.createVault(effectivePass, result.payload);
      enterUnlockedShell(effectivePass);
      showToast(`Pulled encrypted vault from ${PROVIDER_LABELS[prov]}.`, 'ok');
    } catch (err) {
      setAlert('lock-error', err instanceof Error ? err.message : String(err));
    }
  });

  // Navigation Rail & Mobile Bottom Bar
  document.addEventListener('click', (e) => {
    const navBtn = e.target instanceof Element ? e.target.closest('[data-nav-view]') : null;
    if (!navBtn) return;
    switchWorkspaceView(navBtn.getAttribute('data-nav-view') || 'connections', true);
  });

  // Auto-lock selector in rail
  byId('rail-autolock-select')?.addEventListener('change', (e) => {
    applyAutoLockSelection(e.target.value);
    showToast('Auto-lock policy updated.', 'ok');
  });

  // Lock vault triggers
  const triggerLock = () => {
    store.lock();
    showLockScreen('Vault locked. All decrypted secrets were wiped from RAM.');
  };
  byId('btn-lock-vault')?.addEventListener('click', triggerLock);
  byId('btn-mobile-lock')?.addEventListener('click', triggerLock);
  byId('btn-sync-lock-now')?.addEventListener('click', triggerLock);

  // Global search filter
  byId('global-search')?.addEventListener('input', (e) => {
    appState.searchQuery = e.target.value || '';
    renderConnectionsView();
    renderTotpView();
    renderCredentialsView();
  });

  // Contextual topbar primary + Add button
  byId('btn-primary-add')?.addEventListener('click', () => {
    if (appState.activeView === 'connections') openConnectionModal(null, false);
    else if (appState.activeView === 'totp') openTotpModal(null);
    else if (appState.activeView === 'credentials') openCredentialModal(null);
    else if (appState.activeView === 'sync') handleExportJvault();
    else if (appState.activeView === 'gateway') connectGatewayBridge();
  });

  byId('btn-quick-sync')?.addEventListener('click', () => runCloudSync('smartMerge'));
  byId('topbar-cmdk-btn')?.addEventListener('click', () => openCommandPalette());
  byId('sidebar-shortcuts-btn')?.addEventListener('click', () => openModal('modal-shortcuts'));
  byId('btn-import-ssh-config')?.addEventListener('click', () => openSshImportModal());
  byId('btn-empty-import-ssh')?.addEventListener('click', () => openSshImportModal());
  byId('btn-vault-health-details')?.addEventListener('click', () => {
    appState.vaultHealthDetailsOpen = !appState.vaultHealthDetailsOpen;
    renderVaultHealthStrips();
  });
  byId('btn-add-bastion-quick')?.addEventListener('click', () => openConnectionModal(null, true));
  byId('btn-empty-add-host')?.addEventListener('click', () => openConnectionModal(null, false));
  byId('btn-empty-go-sync')?.addEventListener('click', () => switchWorkspaceView('sync', true));
  byId('btn-view-add-totp')?.addEventListener('click', () => openTotpModal(null));
  byId('btn-empty-add-totp')?.addEventListener('click', () => openTotpModal(null));
  byId('btn-view-add-cred')?.addEventListener('click', () => openCredentialModal(null));
  byId('btn-empty-add-cred')?.addEventListener('click', () => openCredentialModal(null));

  // Credential filter pills
  byId('cred-kind-filter-bar')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-cred-filter]') : null;
    if (!btn) return;
    appState.credKindFilter = btn.getAttribute('data-cred-filter') || 'all';
    for (const pill of document.querySelectorAll('[data-cred-filter]')) {
      const match = pill === btn;
      pill.classList.toggle('is-active', match);
      pill.setAttribute('aria-selected', match ? 'true' : 'false');
    }
    renderCredentialsView();
  });

  // Cloud Sync controls
  byId('sync-provider-tabs')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-sync-provider]') : null;
    if (!btn) return;
    appState.syncProvider = btn.getAttribute('data-sync-provider') || 'googleDrive';
    setSegmentedValue(byId('sync-provider-tabs'), 'data-sync-provider', appState.syncProvider);
    updateSyncProviderVisibility(appState.syncProvider);
    store.saveUiPrefs({ syncProvider: appState.syncProvider });
  });

  byId('sync-custom-passphrase-switch')?.addEventListener('click', () => {
    appState.useCustomPassphrase = !appState.useCustomPassphrase;
    setSwitchState(byId('sync-custom-passphrase-switch'), appState.useCustomPassphrase);
    const wrap = byId('sync-custom-passphrase-wrap');
    if (wrap) wrap.hidden = !appState.useCustomPassphrase;
    const prefUpdate = { useCustomPassphrase: appState.useCustomPassphrase };
    if (appState.useCustomPassphrase) {
      prefUpdate.vaultAuthMode = 'passphrase';
    }
    store.saveUiPrefs(prefUpdate);
  });

  byId('btn-sync-gdrive-signin')?.addEventListener('click', () => {
    handleStudioGoogleSignIn({ autoSyncMode: 'smartMerge' });
  });
  byId('btn-sync-gdrive-reconnect')?.addEventListener('click', () => {
    const hint = ramSecrets.gdriveEmail || store.getUiPrefs().googleAccountEmail || '';
    handleStudioGoogleSignIn({ loginHint: hint, prompt: 'consent', autoSyncMode: 'smartMerge' });
  });
  byId('btn-sync-gdrive-grant')?.addEventListener('click', () => {
    const hint = ramSecrets.gdriveEmail || store.getUiPrefs().googleAccountEmail || '';
    handleStudioGoogleSignIn({ loginHint: hint, prompt: 'consent', autoSyncMode: 'smartMerge' });
  });
  byId('btn-sync-gdrive-disconnect')?.addEventListener('click', handleStudioGoogleDisconnect);
  byId('sync-gdrive-client-id')?.addEventListener('change', (e) => {
    store.saveUiPrefs({ googleClientId: (e.target.value || '').trim() });
  });
  byId('sync-gdrive-email')?.addEventListener('change', (e) => {
    const email = (e.target.value || '').trim();
    ramSecrets.gdriveEmail = email;
    store.saveUiPrefs({ googleAccountEmail: email });
    renderGoogleDriveStudioState();
  });
  byId('btn-sync-merge')?.addEventListener('click', () => runCloudSync('smartMerge'));
  byId('btn-sync-pull')?.addEventListener('click', () => runCloudSync('pullOnly'));
  byId('btn-sync-push')?.addEventListener('click', () => runCloudSync('pushForce'));

  // .jvault Export / Import / Passphrase Change
  byId('btn-export-jvault')?.addEventListener('click', handleExportJvault);
  bindJvaultDropzone('sync-dropzone', 'sync-jvault-file', 'sync-dropzone-label', 'sync-dropzone-meta', (text, name) => {
    appState.syncImportFileText = text;
    appState.syncImportFileName = name;
  });

  byId('sync-import-mode')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-import-mode]') : null;
    if (!btn) return;
    appState.importMode = btn.getAttribute('data-import-mode') || 'merge';
    setSegmentedValue(byId('sync-import-mode'), 'data-import-mode', appState.importMode);
  });

  byId('form-sync-import-jvault')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!appState.syncImportFileText) {
      showToast('Select or drop a .jvault archive first.', 'danger');
      return;
    }
    const archivePass = (byId('sync-import-passphrase')?.value || '').trim() || ramSecrets.unlockedPassphrase;
    try {
      await store.importEnvelope(appState.syncImportFileText, archivePass, {
        mode: appState.importMode,
        localPassphrase: ramSecrets.unlockedPassphrase,
      });
      appState.syncImportFileText = '';
      if (byId('sync-import-passphrase')) byId('sync-import-passphrase').value = '';
      scheduleCloudAutoSync(CLOUD_AUTO_SYNC_DEBOUNCE_MS);
      renderAllViews();
      showToast(`Imported ${appState.syncImportFileName || '.jvault'} (${appState.importMode}).`, 'ok');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to decrypt .jvault archive.', 'danger');
    }
  });

  byId('form-change-passphrase')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nextPass = byId('new-vault-passphrase')?.value || '';
    const confirm = byId('confirm-new-vault-passphrase')?.value || '';
    if (nextPass.trim().length < 4) {
      showToast('New passphrase must be at least 4 characters.', 'danger');
      return;
    }
    if (nextPass !== confirm) {
      showToast('New passphrases do not match.', 'danger');
      return;
    }
    try {
      await store.changePassphrase(nextPass);
      ramSecrets.unlockedPassphrase = nextPass;
      store.saveUiPrefs({ vaultAuthMode: 'passphrase' });
      byId('new-vault-passphrase').value = '';
      byId('confirm-new-vault-passphrase').value = '';
      showToast('Local vault re-encrypted with new passphrase.', 'ok');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'danger');
    }
  });

  // Web Gateway controls
  byId('gateway-url-presets')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-gw-preset]') : null;
    if (!btn) return;
    applyGatewayUrlPreset(btn.getAttribute('data-gw-preset') || LOCAL_GATEWAY_DEFAULT_URL);
  });

  byId('gateway-ws-url')?.addEventListener('input', () => {
    syncGatewayUrlPresetsUi();
  });

  byId('btn-gateway-preview-demo')?.addEventListener('click', () => {
    startGatewayInteractivePreview();
  });

  byId('btn-gateway-preview-setup')?.addEventListener('click', () => {
    setGatewaySetupVisible(true);
    byId('gateway-setup-grid')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  byId('gateway-auth-mode')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-gateway-auth]') : null;
    if (!btn) return;
    setGatewayAuthMode(btn.getAttribute('data-gateway-auth') || 'pairing');
  });

  byId('gateway-pairing-code')?.addEventListener('input', (e) => {
    const raw = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
    e.target.value = raw.length > 3 ? `${raw.slice(0, 3)} ${raw.slice(3)}` : raw;
  });

  byId('gateway-host-select')?.addEventListener('change', updateGatewayTargetBadge);

  byId('gateway-view-only-switch')?.addEventListener('click', () => {
    appState.gatewayViewOnly = !appState.gatewayViewOnly;
    setSwitchState(byId('gateway-view-only-switch'), appState.gatewayViewOnly);
    updateGatewayTargetBadge();
    if (appState.gatewayPreviewActive) {
      updateGatewayControlUi(!appState.gatewayViewOnly, appState.gatewayViewOnly);
      renderGatewayPreviewCanvas();
    } else if (appState.gatewayClient && appState.gatewayClient.connected) {
      if (appState.gatewayViewOnly) {
        appState.gatewayClient.releaseControl();
      } else {
        appState.gatewayClient.takeControl();
      }
    }
  });

  byId('form-gateway-connect')?.addEventListener('submit', (e) => {
    e.preventDefault();
    connectGatewayBridge();
  });

  byId('btn-copy-gw-npm')?.addEventListener('click', () => {
    copyText(GATEWAY_QUICK_COMMANDS.npm, 'Gateway npm command', false);
  });

  byId('btn-copy-gw-docker')?.addEventListener('click', () => {
    copyText(GATEWAY_QUICK_COMMANDS.docker, 'Gateway Docker command', false);
  });

  byId('btn-check-local-gateway')?.addEventListener('click', () => {
    probeLocalGatewayHealth({ userTriggered: true, autoFocusPairing: true });
  });

  byId('btn-gateway-launch-with-creds')?.addEventListener('click', () => {
    ramSecrets.gatewayRuntimePassword = byId('gateway-runtime-password')?.value || '';
    ramSecrets.gatewayRuntimeKey = byId('gateway-runtime-key')?.value || '';
    connectGatewayBridge();
  });

  byId('btn-gateway-launch-no-creds')?.addEventListener('click', () => {
    ramSecrets.gatewayRuntimePassword = '';
    ramSecrets.gatewayRuntimeKey = '';
    connectGatewayBridge();
  });

  byId('gateway-runtime-password')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      ramSecrets.gatewayRuntimePassword = byId('gateway-runtime-password')?.value || '';
      ramSecrets.gatewayRuntimeKey = byId('gateway-runtime-key')?.value || '';
      connectGatewayBridge();
    }
  });

  byId('btn-gateway-disconnect')?.addEventListener('click', () => disconnectGatewaySession(false));
  byId('btn-gateway-hud-disconnect')?.addEventListener('click', () => disconnectGatewaySession(false));

  byId('btn-gateway-toggle-setup')?.addEventListener('click', () => {
    setGatewaySetupVisible(!appState.gatewaySetupVisible);
  });

  byId('gateway-pane-tabs')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-gateway-pane]') : null;
    if (!btn) return;
    setGatewayPane(btn.getAttribute('data-gateway-pane') || 'desktop');
  });

  byId('gateway-scale-group')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-gateway-scale]') : null;
    if (!btn) return;
    setGatewayScaleMode(btn.getAttribute('data-gateway-scale') || 'fit');
    if (appState.gatewayPreviewActive) {
      renderGatewayPreviewCanvas();
    }
  });

  byId('btn-gateway-control-toggle')?.addEventListener('click', () => {
    if (appState.gatewayPreviewActive) {
      const nextViewOnly = !appState.gatewayViewOnly;
      updateGatewayControlUi(!nextViewOnly, nextViewOnly);
      renderGatewayPreviewCanvas();
      appendGatewayLog(
        nextViewOnly
          ? 'Preview switched to View-Only Observer mode.'
          : 'Preview acquired exclusive interactive control.',
        'ok',
      );
      return;
    }
    const client = appState.gatewayClient;
    if (!client || !client.connected) return;
    if (client.hasControl && !client.viewOnly) {
      client.releaseControl();
    } else {
      client.takeControl();
    }
  });

  byId('btn-gateway-autotype-2fa')?.addEventListener('click', () => {
    handleGatewayAutoType2fa();
  });

  byId('btn-gateway-cad')?.addEventListener('click', () => {
    if (appState.gatewayPreviewActive && appState.gatewayPreviewState) {
      if (appState.gatewayViewOnly) {
        showToast('Click Take Control before sending Ctrl+Alt+Del.', 'danger');
        return;
      }
      appState.gatewayPreviewState.cadOverlay = !appState.gatewayPreviewState.cadOverlay;
      appState.gatewayPreviewState.tilesDecoded += 1;
      renderGatewayPreviewCanvas();
      appendGatewayLog('Simulated Ctrl+Alt+Del sequence inside Interactive Browser Preview.', 'ok');
      return;
    }
    const client = appState.gatewayClient;
    if (!client || !client.connected) return;
    if (client.sendCtrlAltDel()) {
      appendGatewayLog('Sent Ctrl+Alt+Del sequence via JSR1 binary input.', 'ok');
    } else {
      showToast('Click Take Control before sending Ctrl+Alt+Del.', 'danger');
    }
  });

  byId('btn-gateway-fullscreen')?.addEventListener('click', () => {
    const stage = byId('gateway-live-stage');
    if (!stage) return;
    if (document.fullscreenElement === stage) {
      document.exitFullscreen().catch(() => {});
    } else if (typeof stage.requestFullscreen === 'function') {
      stage.requestFullscreen().catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const fsBtn = byId('btn-gateway-fullscreen');
    if (fsBtn) {
      fsBtn.textContent =
        document.fullscreenElement === byId('gateway-live-stage') ? 'Exit Fullscreen' : 'Fullscreen';
    }
    if (appState.gatewayPane === 'ssh' && appState.sshTerminal) {
      requestAnimationFrame(() => {
        appState.sshTerminal?.fit();
        appState.sshTerminal?.focus();
      });
    }
  });

  // SSH Terminal HUD Paste & Compact Tactile Shortcut Ribbon
  byId('btn-gateway-ssh-paste')?.addEventListener('click', () => {
    handleSshPasteFromClipboard();
  });

  const sshRibbon = byId('gateway-ssh-ribbon');
  sshRibbon?.addEventListener('pointerdown', (e) => {
    if (e.target instanceof Element && e.target.closest('button')) {
      e.preventDefault();
    }
  });
  sshRibbon?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn) return;
    const term = ensureSshTerminal();
    const seqKey = btn.getAttribute('data-ssh-seq');
    const action = btn.getAttribute('data-ssh-action');

    if (seqKey) {
      const ss3 = term.appCursorKeys ? '\x1bO' : '\x1b[';
      const seqMap = {
        esc: '\x1b',
        tab: '\t',
        'ctrl-c': '\x03',
        'ctrl-d': '\x04',
        'ctrl-l': '\x0c',
        up: `${ss3}A`,
        down: `${ss3}B`,
        left: `${ss3}D`,
        right: `${ss3}C`,
      };
      const seq = seqMap[seqKey];
      if (seq) {
        term.setCtrlLatch(false);
        term.sendSequence(seq);
      }
      term.focus();
      return;
    }

    if (action === 'ctrl-latch') {
      term.toggleCtrlLatch();
      term.focus();
    } else if (action === 'paste') {
      handleSshPasteFromClipboard();
    } else if (action === '2fa') {
      handleGatewayAutoType2fa();
    } else if (action === 'clear') {
      term.clearScrollbackAndScreen();
      appState.gatewaySshBuffer = '';
      if (appState.gatewayPreviewActive && appState.gatewayPreviewState && !appState.gatewayPreviewState.sshAltApp) {
        appendGatewaySshOutput(formatPreviewSshPrompt(appState.gatewayPreviewState));
      }
      term.focus();
    }
  });

  // SFTP File Browser controls
  byId('form-gateway-sftp-path')?.addEventListener('submit', (e) => {
    e.preventDefault();
    refreshGatewaySftpList();
  });

  byId('btn-gateway-sftp-up')?.addEventListener('click', () => {
    const cur = String(appState.gatewaySftpPath || '/').replace(/\/+$/, '');
    const idx = cur.lastIndexOf('/');
    const parent = idx <= 0 ? '/' : cur.slice(0, idx);
    refreshGatewaySftpList(parent);
  });

  byId('btn-gateway-sftp-upload')?.addEventListener('click', () => {
    byId('gateway-sftp-file-input')?.click();
  });

  byId('gateway-sftp-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      handleGatewaySftpUpload(file);
    }
    e.target.value = '';
  });

  byId('gateway-deploy-tabs')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-deploy-tab]') : null;
    if (!btn) return;
    setGatewayDeployTab(btn.getAttribute('data-deploy-tab') || 'desktop');
  });

  byId('btn-copy-deploy-snippet')?.addEventListener('click', async () => {
    const spec = GATEWAY_DEPLOY_TABS[appState.deployTab] || GATEWAY_DEPLOY_TABS.desktop;
    const btn = byId('btn-copy-deploy-snippet');
    await copyText(spec.snippet, `${spec.label} snippet`, false);
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(() => {
        if (btn.textContent === 'Copied!') btn.textContent = 'Copy Snippet';
      }, 1800);
    }
  });

  // Modal closing & backdrop click
  document.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-modal-close]')) {
      closeActiveModal();
    } else if (e.target === byId('jala-modal-backdrop')) {
      closeActiveModal();
    }
  });

  // Modal 1: Connection
  byId('conn-protocol-group')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-proto]') : null;
    if (!btn) return;
    const prevProto = getSegmentedValue(byId('conn-protocol-group'), 'data-proto', 'rdp');
    const nextProto = btn.getAttribute('data-proto') || 'rdp';
    setSegmentedValue(byId('conn-protocol-group'), 'data-proto', nextProto);
    const portInput = byId('conn-port');
    if (portInput && (!portInput.value || Number(portInput.value) === DEFAULT_PORTS[prevProto])) {
      portInput.value = String(DEFAULT_PORTS[nextProto] || 22);
    }
  });

  byId('conn-is-jump-switch')?.addEventListener('click', () => {
    const next = !getSwitchState(byId('conn-is-jump-switch'));
    setSwitchState(byId('conn-is-jump-switch'), next);
  });

  byId('conn-is-fav-switch')?.addEventListener('click', () => {
    const next = !getSwitchState(byId('conn-is-fav-switch'));
    setSwitchState(byId('conn-is-fav-switch'), next);
  });

  byId('form-connection')?.addEventListener('submit', handleSaveConnection);

  // Modal 2: 2FA
  byId('btn-parse-otpauth')?.addEventListener('click', handleParseOtpAuthUri);
  byId('totp-secret')?.addEventListener('input', updateTotpModalPreview);

  byId('totp-algo-group')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-totp-algo]') : null;
    if (!btn) return;
    setSegmentedValue(byId('totp-algo-group'), 'data-totp-algo', btn.getAttribute('data-totp-algo') || 'SHA1');
    updateTotpModalPreview();
  });

  byId('totp-digits-group')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-totp-digits]') : null;
    if (!btn) return;
    setSegmentedValue(byId('totp-digits-group'), 'data-totp-digits', btn.getAttribute('data-totp-digits') || '6');
    updateTotpModalPreview();
  });

  byId('totp-period-group')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-totp-period]') : null;
    if (!btn) return;
    setSegmentedValue(byId('totp-period-group'), 'data-totp-period', btn.getAttribute('data-totp-period') || '30');
    updateTotpModalPreview();
  });

  byId('form-totp')?.addEventListener('submit', handleSaveTotp);

  // Modal 3: Credential
  byId('cred-kind-group')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-cred-kind]') : null;
    if (!btn) return;
    const kind = btn.getAttribute('data-cred-kind') || 'password';
    setSegmentedValue(byId('cred-kind-group'), 'data-cred-kind', kind);
    updateCredModalKindFields(kind);
  });

  byId('form-credential')?.addEventListener('submit', handleSaveCredential);

  // Modal 4: Confirm Delete
  byId('btn-confirm-delete-submit')?.addEventListener('click', async () => {
    const action = appState.pendingConfirmAction;
    const submitBtn = byId('btn-confirm-delete-submit');
    if (typeof action !== 'function') {
      closeActiveModal();
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    appState.pendingConfirmAction = null;
    try {
      await action();
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      closeActiveModal();
    }
  });

  // Modal 5: Command Palette (⌘K)
  byId('cmdk-input')?.addEventListener('input', (e) => {
    appState.cmdkQuery = e.target.value || '';
    appState.cmdkActiveIndex = 0;
    renderCommandPaletteList();
  });

  byId('cmdk-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCommandPaletteActiveIndex(appState.cmdkActiveIndex + 1, true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCommandPaletteActiveIndex(appState.cmdkActiveIndex - 1, true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      executeCommandPaletteItem(appState.cmdkActiveIndex);
    }
  });

  // Modal 6: OpenSSH ~/.ssh/config Importer
  bindJvaultDropzone(
    'ssh-import-dropzone',
    'ssh-import-file',
    'ssh-import-dropzone-label',
    'ssh-import-dropzone-meta',
    (text, name) => {
      const ta = byId('ssh-import-textarea');
      if (ta) ta.value = text;
      const meta = byId('ssh-import-dropzone-meta');
      if (meta) meta.textContent = `${name} loaded locally · zero upload`;
      updateSshImportPreview();
    },
  );
  byId('ssh-import-textarea')?.addEventListener('input', updateSshImportPreview);
  byId('ssh-import-folder')?.addEventListener('input', updateSshImportPreview);
  byId('form-ssh-import')?.addEventListener('submit', handleConfirmSshImport);

  // Google OAuth Popup Message Listener
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === 'jaladesk-gdrive-oauth' && typeof event.data.accessToken === 'string') {
      ramSecrets.gdriveToken = event.data.accessToken;
      ramSecrets.gdriveScope = typeof event.data.scope === 'string' ? event.data.scope : '';
      renderGoogleDriveStudioState();
      updateSecurityPill();
      showToast('Google OAuth token captured in memory. Click Smart Merge Sync.', 'ok');
    }
  });

  // Keyboard shortcuts + Activity tracking
  document.addEventListener('keydown', (e) => {
    store.touchActivity();
    const activeEl = document.activeElement;
    const isTerminalCanvas = Boolean(
      activeEl &&
        (activeEl.id === 'gateway-canvas' ||
          activeEl.id === 'gateway-ssh-terminal' ||
          activeEl.id === 'gateway-ssh-console'),
    );

    if (e.key === 'Escape' && appState.activeModalId) {
      e.preventDefault();
      closeActiveModal();
      return;
    }

    if (!store.isUnlocked()) return;

    // ⌘K / Ctrl+K toggles Global Command Palette (guarded when focused inside remote terminal/canvas)
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      if (isTerminalCanvas) return;
      e.preventDefault();
      if (appState.activeModalId === 'modal-command-palette') {
        closeActiveModal();
      } else {
        openCommandPalette();
      }
      return;
    }

    if (appState.activeModalId) return;

    const tag = activeEl ? activeEl.tagName : '';
    const isEditable =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      Boolean(activeEl instanceof HTMLElement && activeEl.isContentEditable) ||
      isTerminalCanvas;

    if (isEditable || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === '/') {
      e.preventDefault();
      byId('global-search')?.focus();
    } else if (e.key === '?') {
      e.preventDefault();
      openModal('modal-shortcuts');
    } else if (!e.shiftKey) {
      const lower = e.key.toLowerCase();
      if (lower === 'n') {
        e.preventDefault();
        openConnectionModal(null, false);
      } else if (lower === 'g') {
        e.preventDefault();
        switchWorkspaceView('gateway', true);
      } else if (lower === 's') {
        e.preventDefault();
        if (hasActiveCloudSessionInRam()) {
          runCloudSync('smartMerge');
        } else {
          switchWorkspaceView('sync', true);
        }
      } else if (lower === 'l') {
        e.preventDefault();
        triggerLock();
      }
    }
  });

  document.addEventListener('pointerdown', () => store.touchActivity(), { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !store.isUnlocked()) return;
    if (appState.lockOnHidden) {
      store.lock();
      showLockScreen('Vault auto-locked immediately when tab lost visibility.');
      return;
    }
    if (appState.cloudAutoSyncPending && hasActiveCloudSessionInRam()) {
      flushCloudAutoSync({ background: true });
    }
  });

  window.addEventListener('beforeunload', () => {
    if (appState.cloudAutoSyncPending && store.isUnlocked() && hasActiveCloudSessionInRam()) {
      flushCloudAutoSync({ background: true });
    }
  });

  store.onLock(() => {
    if (!byId('jala-web-app')?.hidden) {
      const prefs = store.getUiPrefs();
      const msg =
        prefs.vaultAuthMode === 'googleAccount' && prefs.googleAccountEmail
          ? 'Vault auto-locked after inactivity. Click Unlock & Sync with Google to resume.'
          : 'Vault auto-locked after inactivity. Enter passphrase to resume.';
      showLockScreen(msg);
    }
  });

  window.addEventListener('hashchange', () => {
    inspectUrlHash(true);
  });
}

function registerServiceWorker() {
  if (
    'serviceWorker' in navigator &&
    (window.location.protocol === 'https:' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1')
  ) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Service worker registration is optional in non-SW environments
    });
  }
}

function bootstrap() {
  inspectUrlHash(false);
  wireEventListeners();
  setGatewayDeployTab('desktop');
  registerServiceWorker();
  showLockScreen('', { preservePendingGatewayToken: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
