import {
  GOOGLE_DRIVE_APPDATA_SCOPE,
  SealedBrowserVaultStore,
  calculateTotpTiming,
  createEmptyVaultPayload,
  deriveGoogleAccountBoundPassphrase,
  evaluateTotpToken,
  makeTombstoneKey,
  normalizeTotpSecretBase32,
  parseOtpAuthUri,
  syncWithGithubGist,
  syncWithGoogleDriveAppData,
  syncWithWebDav,
} from './vault-core.js';
import { JalaGatewayClient, normalizeGatewayEndpoints } from './gateway-client.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_PORTS = Object.freeze({
  rdp: 3389,
  vnc: 5900,
  ssh: 22,
  sftp: 22,
  hypervisor: 8006,
});

const DOCKER_SNIPPETS = Object.freeze({
  run: `docker run --rm -p 127.0.0.1:8443:8443 \\
  -e JALADESK_GATEWAY_CORS_ORIGINS=https://ribato22.github.io \\
  -e JALADESK_GATEWAY_DEMO=1 \\
  ghcr.io/ribato22/jaladesk-gateway:1.17.0`,
  compose: `services:
  jaladesk-gateway:
    image: ghcr.io/ribato22/jaladesk-gateway:1.17.0
    ports:
      - "127.0.0.1:8443:8443"
    environment:
      JALADESK_GATEWAY_CORS_ORIGINS: "https://ribato22.github.io"
      JALADESK_GATEWAY_DEMO: "1"
    read_only: true
    restart: unless-stopped`,
});

const PRIMARY_ADD_LABELS = Object.freeze({
  connections: 'Add Connection',
  totp: 'Add 2FA Token',
  credentials: 'Add Credential',
  sync: 'Export .jvault',
  gateway: 'Connect Bridge',
});

const PROVIDER_LABELS = Object.freeze({
  googleDrive: 'Google Drive',
  githubGist: 'GitHub Gist',
  webdav: 'WebDAV',
});

const store = new SealedBrowserVaultStore();

/** All sensitive credentials, passphrases, and tokens live ONLY in RAM and are zeroed on lock(). */
const ramSecrets = {
  unlockedPassphrase: '',
  gdriveToken: '',
  gdriveScope: '',
  gistToken: '',
  webdavPassword: '',
  customSyncPassphrase: '',
  gatewayToken: '',
  gatewayPairing: '',
};

const appState = {
  activeView: 'connections',
  searchQuery: '',
  folderFilter: 'all',
  credKindFilter: 'all',
  onboardTab: 'create',
  onboardAutolock: '300',
  onboardCloudProvider: 'githubGist',
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
  gatewayScaleMode: 'fit',
  gatewayPane: 'desktop',
  gatewaySetupVisible: true,
  gatewaySessionProtocol: '',
  gatewaySftpPath: '/',
  gatewaySshBuffer: '',
  gatewayFragmentScrubbed: false,
  dockerTab: 'run',
  activeModalId: null,
  totpRafId: 0,
  totpLastTickMs: 0,
  totpCardRefs: new Map(),
  clipboardClearTimer: null,
  lastCopiedSecret: '',
  syncInFlight: false,
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
        const gToken = byId('sync-gdrive-token');
        if (gToken) gToken.value = accessToken;
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

  if (cleaned.includes('token=')) {
    const params = new URLSearchParams(cleaned);
    const token = (params.get('token') || '').trim();
    const gwUrl = (params.get('gateway') || '').trim();
    if (token) {
      ramSecrets.gatewayToken = token;
      appState.gatewayAuthMode = 'token';
      appState.gatewayFragmentScrubbed = true;
      appState.activeView = 'gateway';
      if (
        gwUrl &&
        (gwUrl.startsWith('wss://') ||
          gwUrl.startsWith('ws://') ||
          gwUrl.startsWith('https://') ||
          gwUrl.startsWith('http://'))
      ) {
        const urlInput = byId('gateway-ws-url');
        if (urlInput) urlInput.value = gwUrl;
      }
      try {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch {
        // Ignore restricted history state
      }
      if (isLiveChange && store.isUnlocked()) {
        setGatewayAuthMode('token');
        const tokInput = byId('gateway-session-token');
        if (tokInput) tokInput.value = token;
        setAlert('gateway-fragment-notice', 'URL fragment #token= was captured into RAM and scrubbed from browser history.');
        switchWorkspaceView('gateway', true);
        appendGatewayLog('Captured ephemeral #token= from URL fragment and scrubbed browser history.', 'ok');
      }
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

  ramSecrets.unlockedPassphrase = '';
  ramSecrets.gdriveToken = '';
  ramSecrets.gdriveScope = '';
  ramSecrets.gistToken = '';
  ramSecrets.webdavPassword = '';
  ramSecrets.customSyncPassphrase = '';
  ramSecrets.gatewayToken = pendingToken;
  ramSecrets.gatewayPairing = '';
  appState.revealedCredIds.clear();
  appState.lockImportFileText = '';
  appState.syncImportFileText = '';
  appState.lastCopiedSecret = '';
  appState.searchQuery = '';
  appState.gatewayTargetHostId = '__demo__';
  appState.gatewayFragmentScrubbed = pendingScrubbed;
  if (appState.clipboardClearTimer) {
    clearTimeout(appState.clipboardClearTimer);
    appState.clipboardClearTimer = null;
  }

  disconnectGatewaySession(true);

  const clearedInputIds = [
    'unlock-passphrase',
    'create-passphrase',
    'create-passphrase-confirm',
    'import-lock-passphrase',
    'onboard-gist-token',
    'onboard-webdav-pass',
    'onboard-gdrive-token',
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
    'gateway-ssh-input',
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
  ];
  for (const id of clearedInputIds) {
    const input = byId(id);
    if (input) input.value = '';
  }
  const connPort = byId('conn-port');
  if (connPort) connPort.value = '3389';

  for (const listId of ['connections-list', 'totp-list', 'credentials-list', 'folder-filter-bar', 'jala-toast-region']) {
    const list = byId(listId);
    if (list) list.replaceChildren();
  }
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
  if (badgeText) {
    badgeText.textContent = hasVault
      ? 'AES-256-GCM · Sealed Vault'
      : 'AES-256-GCM · Zero Plaintext';
  }

  const resetConfirm = byId('lock-reset-confirm');
  if (resetConfirm) resetConfirm.hidden = true;
  setAlert('lock-error', '');
  setAlert('lock-info', reasonMessage);

  if (hasVault) {
    const unlockInput = byId('unlock-passphrase');
    if (unlockInput) {
      setTimeout(() => unlockInput.focus(), 40);
    }
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
  if (gClient && prefs.googleClientId) gClient.value = prefs.googleClientId;
  const gEmail = byId('sync-gdrive-email');
  if (gEmail && prefs.googleAccountEmail) gEmail.value = prefs.googleAccountEmail;
  const gToken = byId('sync-gdrive-token');
  if (gToken && ramSecrets.gdriveToken) gToken.value = ramSecrets.gdriveToken;
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
    if (prefs.gatewayUrl) {
      gwUrl.value = prefs.gatewayUrl;
    } else if (
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === 'localhost'
    ) {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      gwUrl.value = `${wsProto}//${window.location.host}`;
    }
  }

  if (appState.gatewayFragmentScrubbed && ramSecrets.gatewayToken) {
    setGatewayAuthMode('token');
    const tokInput = byId('gateway-session-token');
    if (tokInput) tokInput.value = ramSecrets.gatewayToken;
    setAlert('gateway-fragment-notice', 'URL fragment #token= was captured into RAM and scrubbed from browser history.');
  }

  updateSecurityPill();
}

function updateSecurityPill() {
  const prefs = store.getUiPrefs();
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

  if (pillText) {
    if (prefs.lastSyncedAtMs > 0) {
      const label = PROVIDER_LABELS[prefs.syncProvider] || 'Cloud';
      pillText.textContent = `AES-256-GCM · Synced (${label})`;
    } else {
      pillText.textContent = 'AES-256-GCM · Local-Only';
    }
  }
}

/* ==========================================================================
   Navigation & View Switching
   ========================================================================== */

function switchWorkspaceView(viewName, persist = true) {
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
  }
}

function switchOnboardTab(tab) {
  appState.onboardTab = tab;
  setSegmentedValue(byId('onboard-mode-tabs'), 'data-onboard-tab', tab);
  for (const form of document.querySelectorAll('[data-onboard-panel]')) {
    form.hidden = form.getAttribute('data-onboard-panel') !== tab;
  }
  setAlert('lock-error', '');
}

function renderAllViews() {
  const payload = getPayloadSafe();
  if (!payload) return;
  updateNavCounts(payload);
  renderConnectionsView();
  renderTotpView();
  renderCredentialsView();
  renderSyncExportSummary(payload);
  renderGatewayTargets();
  updateSecurityPill();
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

    const copyBtn = el('button', 'btn btn-secondary', copySpec.buttonText);
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => copyText(copySpec.value, copySpec.label, false));
    actions.appendChild(copyBtn);

    const gwBtn = el('button', 'btn btn-ghost', 'Open in Gateway');
    gwBtn.type = 'button';
    gwBtn.addEventListener('click', () => openHostInGateway(host.id));
    actions.appendChild(gwBtn);

    const editBtn = el('button', 'btn btn-ghost', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openConnectionModal(host));
    actions.appendChild(editBtn);

    const delBtn = el('button', 'btn btn-ghost btn-ghost-danger', 'Delete');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => deleteHost(host.id));
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
  await store.savePayload(payload);
  renderAllViews();
}

async function deleteHost(hostId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const now = Date.now();
  payload.hosts = payload.hosts
    .filter((h) => h.id !== hostId)
    .map((h) => (h.jumpHostId === hostId ? { ...h, jumpHostId: null, updatedAtMs: now } : h));
  payload.tombstones[makeTombstoneKey('host', hostId)] = now;
  payload.updatedAtMs = now;
  await store.savePayload(payload);
  renderAllViews();
  showToast('Connection deleted & tombstone recorded.', 'ok');
}

function openHostInGateway(hostId) {
  appState.gatewayTargetHostId = hostId;
  switchWorkspaceView('gateway', true);
  setGatewaySetupVisible(true);
  const select = byId('gateway-host-select');
  if (select) {
    select.value = hostId;
    updateGatewayTargetBadge();
  }
  const payload = getPayloadSafe();
  const host = payload && payload.hosts.find((h) => h.id === hostId);
  if (host) {
    appendGatewayLog(`Selected target ${host.name} (${String(host.protocol || 'rdp').toUpperCase()} ${host.address}:${host.port}).`, 'ok');
  }
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
    delBtn.addEventListener('click', () => deleteTotp(item.id));
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

async function deleteTotp(totpId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const now = Date.now();
  payload.totp = payload.totp.filter((t) => t.id !== totpId);
  payload.tombstones[makeTombstoneKey('totp', totpId)] = now;
  payload.updatedAtMs = now;
  await store.savePayload(payload);
  renderAllViews();
  showToast('2FA token deleted & tombstone recorded.', 'ok');
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
    delBtn.addEventListener('click', () => deleteCredential(cred.id));
    actions.appendChild(delBtn);

    row.appendChild(actions);
    listEl.appendChild(row);
  }
}

async function deleteCredential(credId) {
  const payload = getPayloadSafe();
  if (!payload) return;
  const now = Date.now();
  payload.credentials = payload.credentials.filter((c) => c.id !== credId);
  payload.hosts = payload.hosts.map((h) => (h.credentialId === credId ? { ...h, credentialId: null, updatedAtMs: now } : h));
  payload.tombstones[makeTombstoneKey('cred', credId)] = now;
  payload.updatedAtMs = now;
  appState.revealedCredIds.delete(String(credId));
  await store.savePayload(payload);
  renderAllViews();
  showToast('Credential deleted & tombstone recorded.', 'ok');
}

/* ==========================================================================
   View 4 — Zero-Knowledge Cloud Sync & .jvault Studio
   ========================================================================== */

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
    const email = (byId('sync-gdrive-email')?.value || '').trim();
    if (email) {
      return deriveGoogleAccountBoundPassphrase(email);
    }
  }
  if (ramSecrets.unlockedPassphrase.length >= 4) {
    return ramSecrets.unlockedPassphrase;
  }
  throw new Error('Vault passphrase unavailable. Unlock vault or enable Custom E2EE Passphrase.');
}

async function runCloudSync(mode) {
  if (appState.syncInFlight || !store.isUnlocked()) return;
  const payload = getPayloadSafe();
  if (!payload) return;

  const provider = appState.syncProvider;
  const statusMsg = byId('sync-status-message');
  appState.syncInFlight = true;
  if (statusMsg) statusMsg.textContent = `Running ${mode} with ${PROVIDER_LABELS[provider] || provider}...`;

  try {
    const passphrase = resolveEffectiveSyncPassphrase(provider);
    let result;

    if (provider === 'googleDrive') {
      const token = (byId('sync-gdrive-token')?.value || ramSecrets.gdriveToken || '').trim();
      const email = (byId('sync-gdrive-email')?.value || '').trim();
      const clientId = (byId('sync-gdrive-client-id')?.value || '').trim();
      ramSecrets.gdriveToken = token;
      store.saveUiPrefs({ syncProvider: 'googleDrive', googleAccountEmail: email, googleClientId: clientId, useCustomPassphrase: appState.useCustomPassphrase });
      result = await syncWithGoogleDriveAppData({
        accessToken: token,
        grantedScope: ramSecrets.gdriveScope || undefined,
        localPayload: payload,
        passphrase,
        mode,
      });
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
    renderAllViews();

    const p = result.payload;
    const summary = `Sync (${mode}) complete via ${PROVIDER_LABELS[provider]} at ${new Date(result.syncedAtMs).toLocaleTimeString()} — ${(p.hosts || []).length} hosts, ${(p.totp || []).length} 2FA, ${(p.credentials || []).length} credentials.`;
    if (statusMsg) statusMsg.textContent = summary;
    showToast(`${PROVIDER_LABELS[provider]} sync complete.`, 'ok');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (statusMsg) statusMsg.textContent = `Sync failed: ${msg}`;
    showToast(msg, 'danger');
  } finally {
    appState.syncInFlight = false;
  }
}

function launchGoogleOAuthPopup() {
  const clientId = (byId('sync-gdrive-client-id')?.value || '').trim();
  if (!clientId) {
    showToast('Enter a Google Web Client ID (GCP 749663705305) or paste an OAuth access token.', 'danger');
    return;
  }
  store.saveUiPrefs({ googleClientId: clientId });
  const redirectUri = `${window.location.origin}${window.location.pathname}`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', `${GOOGLE_DRIVE_APPDATA_SCOPE} openid email`);
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('prompt', 'consent');
  window.open(authUrl.toString(), 'jaladesk-google-oauth', 'popup,width=520,height=640');
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
   View 5 — Self-Hosted Web Gateway (Live JSR1 Binary WS Studio)
   ========================================================================== */

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
    toggleBtn.textContent = appState.gatewaySetupVisible ? 'Hide Setup & Docker' : 'Show Setup & Docker';
  }
}

function setGatewayScaleMode(mode) {
  const next = mode === 'fill' || mode === 'native' ? mode : 'fit';
  appState.gatewayScaleMode = next;
  setSegmentedValue(byId('gateway-scale-group'), 'data-gateway-scale', next);
  const stage = byId('gateway-canvas-stage');
  if (stage) {
    stage.setAttribute('data-scale', next);
  }
}

function setGatewayPane(pane) {
  const next = pane === 'ssh' || pane === 'sftp' ? pane : 'desktop';
  appState.gatewayPane = next;
  setSegmentedValue(byId('gateway-pane-tabs'), 'data-gateway-pane', next);
  const desk = byId('gateway-desktop-pane');
  const ssh = byId('gateway-ssh-pane');
  const sftp = byId('gateway-sftp-pane');
  const scaleGroup = byId('gateway-scale-group');
  const cadBtn = byId('btn-gateway-cad');

  if (desk) desk.hidden = next !== 'desktop';
  if (ssh) ssh.hidden = next !== 'ssh';
  if (sftp) sftp.hidden = next !== 'sftp';
  if (scaleGroup) scaleGroup.hidden = next !== 'desktop';
  if (cadBtn) cadBtn.hidden = next !== 'desktop';

  if (next === 'sftp' && appState.gatewayClient && appState.gatewayClient.connected) {
    refreshGatewaySftpList();
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

  const liveStage = byId('gateway-live-stage');
  if (liveStage) {
    liveStage.hidden = true;
    liveStage.dataset.tilesDecoded = '0';
    liveStage.dataset.fps = '0';
    liveStage.dataset.rttMs = '0';
    liveStage.dataset.kbPerSec = '0';
    liveStage.dataset.hasControl = 'false';
    liveStage.dataset.viewOnly = 'false';
  }
  const toggleBtn = byId('btn-gateway-toggle-setup');
  if (toggleBtn) toggleBtn.hidden = true;
  setGatewaySetupVisible(true);

  const canvas = byId('gateway-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
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

function appendGatewaySshOutput(chunk) {
  let buf = appState.gatewaySshBuffer;
  for (let i = 0; i < chunk.length; i += 1) {
    const ch = chunk[i];
    if (ch === '\b') {
      buf = buf.slice(0, -1);
    } else if (ch !== '\r') {
      buf += ch;
    }
  }
  if (buf.length > 65536) {
    buf = buf.slice(-65536);
  }
  appState.gatewaySshBuffer = buf;
  const consoleEl = byId('gateway-ssh-console');
  if (consoleEl) {
    consoleEl.textContent = buf;
    consoleEl.scrollTop = consoleEl.scrollHeight;
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
    const opt = el('option', '', 'No 2FA tokens');
    opt.value = '';
    select.appendChild(opt);
    if (autoBtn) autoBtn.disabled = true;
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

function updateGatewayTargetBadge() {
  const select = byId('gateway-host-select');
  const badge = byId('gateway-target-badge');
  const modeBadge = byId('gateway-mode-badge');
  if (modeBadge) {
    modeBadge.textContent = appState.gatewayViewOnly ? 'VIEW-ONLY OBSERVER' : 'INTERACTIVE';
  }
  if (!select || !badge) return;
  appState.gatewayTargetHostId = select.value || '__demo__';
  if (appState.gatewayTargetHostId === '__demo__') {
    badge.textContent = 'DEMO SESSION · SYNTHETIC';
    return;
  }
  const payload = getPayloadSafe();
  const host = payload && payload.hosts.find((h) => String(h.id) === select.value);
  if (host) {
    badge.textContent = `${String(host.protocol || 'rdp').toUpperCase()} · ${host.address}:${host.port}`;
  } else {
    badge.textContent = 'DEMO SESSION · SYNTHETIC';
  }
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
  const username = host.username || (linkedCred ? linkedCred.username : '') || '';
  const password = host.password || (linkedCred ? linkedCred.password : '') || '';
  const domain = host.domain || (linkedCred ? linkedCred.domain : '') || '';
  const privateKey = host.privateKeyPem || (linkedCred ? linkedCred.privateKeyPem : '') || '';

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
    cols: 100,
    rows: 30,
    viewOnly: appState.gatewayViewOnly,
    displayLabel: `${protocol.toUpperCase()} · ${host.name || host.address}:${port}`,
  };
}

function disconnectGatewaySession(silent = false) {
  if (appState.gatewayClient) {
    try {
      appState.gatewayClient.detachCanvasInput();
      appState.gatewayClient.disconnect(!silent);
    } catch {
      // Ignore disconnect error
    }
    appState.gatewayClient = null;
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
    appendGatewayLog('Gateway JSR1 session closed cleanly.', 'warn');
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

  disconnectGatewaySession(true);

  const connBtn = byId('btn-gateway-connect');
  const discBtn = byId('btn-gateway-disconnect');
  if (connBtn) connBtn.disabled = true;
  if (discBtn) discBtn.disabled = false;

  const selectedTargetId = byId('gateway-host-select')?.value || '__demo__';
  const built = buildGatewayOpenParamsFromVault(selectedTargetId);
  const { displayLabel, ...openParams } = built;
  const canvasEl = byId('gateway-canvas');

  const client = new JalaGatewayClient({
    canvas: canvasEl,
    onStatus: (label, tone) => setGatewayStatus(label, tone),
    onTokenExchanged: (token) => {
      ramSecrets.gatewayToken = token;
      const tokInput = byId('gateway-session-token');
      if (tokInput) tokInput.value = token;
    },
    onLog: (msg, tone) => appendGatewayLog(msg, tone),
    onOpened: (msg) => {
      appState.gatewaySessionProtocol = msg.protocol || openParams.protocol;
      const liveStage = byId('gateway-live-stage');
      const toggleBtn = byId('btn-gateway-toggle-setup');
      const hudTarget = byId('hud-target-badge');
      if (liveStage) liveStage.hidden = false;
      if (toggleBtn) toggleBtn.hidden = false;
      setGatewaySetupVisible(false);

      const dims = msg.width && msg.height ? ` · ${msg.width}×${msg.height}` : '';
      if (hudTarget) {
        hudTarget.textContent =
          openParams.protocol === 'demo' ? `DEMO${dims}` : `${displayLabel}${dims}`;
      }

      updateGatewayControlUi(Boolean(msg.hasControl), Boolean(msg.viewOnly));
      renderGatewayTotpSelect();
      setGatewayScaleMode(appState.gatewayScaleMode);

      const initialPane =
        appState.gatewaySessionProtocol === 'ssh'
          ? 'ssh'
          : appState.gatewaySessionProtocol === 'sftp'
            ? 'sftp'
            : 'desktop';
      setGatewayPane(initialPane);

      if (canvasEl) {
        client.attachCanvasInput(canvasEl, () => appState.gatewayScaleMode);
      }

      appendGatewayLog(
        `Session ${msg.sessionId} open (${String(msg.protocol).toUpperCase()}, ${msg.hasControl ? 'exclusive input control' : 'view-only observer'}).`,
        'ok',
      );
      showToast(`Connected to ${displayLabel}`, 'ok');
    },
    onControlState: (msg) => {
      updateGatewayControlUi(Boolean(msg.hasControl), Boolean(msg.viewOnly));
      appendGatewayLog(
        msg.hasControl
          ? `Acquired exclusive input control (${msg.viewers} viewer${msg.viewers === 1 ? '' : 's'}).`
          : `Switched to View-Only Observer mode (${msg.viewers} viewer${msg.viewers === 1 ? '' : 's'}).`,
        'ok',
      );
    },
    onMetrics: (metrics) => {
      updateGatewayHudMetrics(metrics);
    },
    onSshData: (chunk) => {
      appendGatewaySshOutput(chunk);
    },
    onError: (msg) => {
      const text = msg && msg.message ? msg.message : 'Gateway session error.';
      appendGatewayLog(`Gateway error (${msg.code || 'error'}): ${text}`, 'err');
      showToast(text, 'danger');
    },
    onClose: ({ code, wasConnected }) => {
      if (appState.gatewayClient === client) {
        client.detachCanvasInput();
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
    if (appState.gatewayClient === client) {
      appState.gatewayClient = null;
    }
    if (connBtn) connBtn.disabled = false;
    if (discBtn) discBtn.disabled = true;
    setGatewayStatus('DISCONNECTED', 'idle');
    appendGatewayLog(`Connection failed: ${message}`, 'err');
    showToast(message, 'danger');
  }
}

async function handleGatewayAutoType2fa() {
  const client = appState.gatewayClient;
  if (!client || !client.connected) {
    showToast('Connect to a live Gateway session first.', 'danger');
    return;
  }
  if (!client.canSendInput()) {
    showToast('View-Only mode active. Click Take Control before auto-typing 2FA.', 'danger');
    return;
  }
  const select = byId('gateway-totp-select');
  const tokenId = select ? select.value : '';
  const payload = getPayloadSafe();
  const token = payload && Array.isArray(payload.totp) ? payload.totp.find((t) => String(t.id) === String(tokenId)) : null;
  if (!token) {
    showToast('Add a 2FA token in the Authenticator tab first.', 'danger');
    return;
  }
  try {
    const evaluated = await evaluateTotpToken(token, Date.now());
    const sent =
      appState.gatewayPane === 'ssh'
        ? client.sendSshData(evaluated.code)
        : client.sendText(evaluated.code);
    if (sent) {
      const label = token.issuer || token.accountName || '2FA token';
      appendGatewayLog(`Auto-typed live ${evaluated.digits}-digit 2FA code for ${label} via JSR1 input.`, 'ok');
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

      const delBtn = el('button', 'btn btn-ghost btn-sm', 'Delete');
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => handleGatewaySftpDelete(fullPath, entry.name));
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
  for (const dlg of backdrop.querySelectorAll('.modal-dialog')) {
    dlg.hidden = dlg.id !== modalId;
  }
  backdrop.hidden = false;
  appState.activeModalId = modalId;
  const firstInput = byId(modalId)?.querySelector('input:not([type="hidden"]), select, textarea');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
}

function closeActiveModal() {
  const backdrop = byId('jala-modal-backdrop');
  if (!backdrop) return;
  backdrop.hidden = true;
  for (const dlg of backdrop.querySelectorAll('.modal-dialog')) {
    dlg.hidden = true;
  }
  appState.activeModalId = null;
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

  await store.savePayload(payload);
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

  await store.savePayload(payload);
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

  await store.savePayload(payload);
  closeActiveModal();
  renderAllViews();
  showToast(existingId ? `Updated ${label}.` : `Saved ${label}.`, 'ok');
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
  });

  byId('btn-returning-reset')?.addEventListener('click', () => {
    const strip = byId('lock-reset-confirm');
    if (strip) strip.hidden = false;
  });

  byId('btn-cancel-reset')?.addEventListener('click', () => {
    const strip = byId('lock-reset-confirm');
    if (strip) strip.hidden = true;
  });

  byId('btn-confirm-reset')?.addEventListener('click', () => {
    store.resetVault({ clearPrefs: false });
    showLockScreen('Local sealed browser vault erased. Create a new vault or import a .jvault backup.');
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
    const prov = btn.getAttribute('data-cloud-provider') || 'githubGist';
    appState.onboardCloudProvider = prov;
    setSegmentedValue(byId('onboard-cloud-provider'), 'data-cloud-provider', prov);
    for (const block of document.querySelectorAll('[data-onboard-provider-fields]')) {
      block.hidden = block.getAttribute('data-onboard-provider-fields') !== prov;
    }
  });

  byId('form-onboard-cloud')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAlert('lock-error', '');
    const prov = appState.onboardCloudProvider;
    const manualPass = (byId('onboard-cloud-passphrase')?.value || '').trim();
    const gEmail = (byId('onboard-gdrive-email')?.value || '').trim();
    const effectivePass =
      manualPass.length >= 4
        ? manualPass
        : prov === 'googleDrive' && gEmail
          ? deriveGoogleAccountBoundPassphrase(gEmail)
          : '';
    if (effectivePass.length < 4) {
      setAlert('lock-error', 'Enter a vault E2EE passphrase (min 4 chars) or Google email for account-bound decryption.');
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
        store.saveUiPrefs({ syncProvider: 'githubGist', githubGistId: result.gistId || gistId, lastSyncedAtMs: result.syncedAtMs });
      } else if (prov === 'webdav') {
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
        store.saveUiPrefs({ syncProvider: 'webdav', webdavUrl: url, webdavUsername: username, lastSyncedAtMs: result.syncedAtMs });
      } else {
        const token = (byId('onboard-gdrive-token')?.value || '').trim();
        result = await syncWithGoogleDriveAppData({
          accessToken: token,
          localPayload: createEmptyVaultPayload(),
          passphrase: effectivePass,
          mode: 'pullOnly',
        });
        ramSecrets.gdriveToken = token;
        store.saveUiPrefs({ syncProvider: 'googleDrive', googleAccountEmail: gEmail, lastSyncedAtMs: result.syncedAtMs });
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
    store.saveUiPrefs({ useCustomPassphrase: appState.useCustomPassphrase });
  });

  byId('btn-gdrive-oauth')?.addEventListener('click', launchGoogleOAuthPopup);
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
      byId('new-vault-passphrase').value = '';
      byId('confirm-new-vault-passphrase').value = '';
      showToast('Local vault re-encrypted with new passphrase.', 'ok');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'danger');
    }
  });

  // Web Gateway controls
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
    if (appState.gatewayClient && appState.gatewayClient.connected) {
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
  });

  byId('btn-gateway-control-toggle')?.addEventListener('click', () => {
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
  });

  // SSH Terminal controls
  byId('form-gateway-ssh-input')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const client = appState.gatewayClient;
    const input = byId('gateway-ssh-input');
    if (!client || !client.connected || !input) return;
    if (!client.canSendInput()) {
      showToast('View-Only mode active. Click Take Control to send SSH commands.', 'danger');
      return;
    }
    const cmd = input.value;
    client.sendSshData(`${cmd}\n`);
    input.value = '';
  });

  byId('gateway-ssh-console')?.addEventListener('keydown', (e) => {
    const client = appState.gatewayClient;
    if (!client || !client.connected || !client.canSendInput()) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      client.sendSshData('\n');
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      client.sendSshData('\x7f');
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      client.sendSshData('\x03');
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      client.sendSshData(e.key);
    }
  });

  byId('btn-gateway-ssh-ctrlc')?.addEventListener('click', () => {
    const client = appState.gatewayClient;
    if (client && client.connected && client.canSendInput()) {
      client.sendSshData('\x03');
    }
  });

  byId('btn-gateway-ssh-clear')?.addEventListener('click', () => {
    appState.gatewaySshBuffer = '';
    const consoleEl = byId('gateway-ssh-console');
    if (consoleEl) consoleEl.textContent = '';
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

  byId('docker-quickstart-tabs')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-docker-tab]') : null;
    if (!btn) return;
    appState.dockerTab = btn.getAttribute('data-docker-tab') || 'run';
    setSegmentedValue(byId('docker-quickstart-tabs'), 'data-docker-tab', appState.dockerTab);
    const code = byId('docker-snippet-code');
    if (code) code.textContent = DOCKER_SNIPPETS[appState.dockerTab] || DOCKER_SNIPPETS.run;
  });

  byId('btn-copy-docker')?.addEventListener('click', () => {
    copyText(DOCKER_SNIPPETS[appState.dockerTab] || DOCKER_SNIPPETS.run, 'Docker snippet', false);
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

  // Google OAuth Popup Message Listener
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === 'jaladesk-gdrive-oauth' && typeof event.data.accessToken === 'string') {
      ramSecrets.gdriveToken = event.data.accessToken;
      ramSecrets.gdriveScope = typeof event.data.scope === 'string' ? event.data.scope : '';
      const tokenInput = byId('sync-gdrive-token');
      if (tokenInput) tokenInput.value = ramSecrets.gdriveToken;
      showToast('Google OAuth token captured in memory. Click Smart Merge Sync.', 'ok');
    }
  });

  // Keyboard shortcuts + Activity tracking
  document.addEventListener('keydown', (e) => {
    store.touchActivity();
    if (e.key === 'Escape' && appState.activeModalId) {
      closeActiveModal();
      return;
    }
    if (!store.isUnlocked() || appState.activeModalId) return;
    const activeEl = document.activeElement;
    const tag = activeEl ? activeEl.tagName : '';
    const isEditing =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (activeEl && (activeEl.id === 'gateway-canvas' || activeEl.id === 'gateway-ssh-console'));
    if ((e.key === '/' && !isEditing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !isEditing)) {
      e.preventDefault();
      byId('global-search')?.focus();
    }
  });

  document.addEventListener('pointerdown', () => store.touchActivity(), { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && store.isUnlocked() && appState.lockOnHidden) {
      store.lock();
      showLockScreen('Vault auto-locked immediately when tab lost visibility.');
    }
  });

  store.onLock(() => {
    if (!byId('jala-web-app')?.hidden) {
      showLockScreen('Vault auto-locked after inactivity. Enter passphrase to resume.');
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
  registerServiceWorker();
  showLockScreen('', { preservePendingGatewayToken: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
