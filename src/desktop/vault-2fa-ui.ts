// Self-contained Enterprise Studio UI for:
// Part A: RFC 6238 2FA Authenticator Studio Modal/Panel (SHA1 | SHA256 | SHA512, 6 | 8 digits, 30s | 60s, otpauth://, Auto-Type)
// Part B: Full-Screen Obsidian App Lock PIN Overlay (4-8 digits, instant unlock on final digit, keypad + physical keyboard, cooldown) & PIN Settings Modal.
// Strict CSP compliance: DOM createElement / createElementNS only; zero innerHTML or inline style attributes.

import {
  createJalaSegmentedBar,
  jalaSvgIcon,
} from './cloud-sync-ui.js';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';
export type TotpDigits = 6 | 8;
export type TotpPeriod = 30 | 60;

export interface TotpVaultItemView {
  id: string;
  issuer: string;
  accountName: string;
  secretBase32: string;
  algorithm: TotpAlgorithm;
  digits: TotpDigits;
  period: TotpPeriod;
  updatedAtMs?: number;
}

export interface NewTotpTokenInput {
  issuer: string;
  accountName: string;
  secretBase32: string;
  algorithm: TotpAlgorithm;
  digits: TotpDigits;
  period: TotpPeriod;
}

export interface TotpLiveSnapshot {
  code: string;
  formattedCode: string;
  remainingSeconds: number;
  period: TotpPeriod;
  progressRatio: number;
}

export interface Vault2faUiBridge {
  listTokens: () => Promise<TotpVaultItemView[]> | TotpVaultItemView[];
  addToken: (input: NewTotpTokenInput) => Promise<TotpVaultItemView> | TotpVaultItemView;
  deleteToken: (id: string) => Promise<void> | void;
  computeCode?: (
    item: TotpVaultItemView,
    nowMs?: number,
  ) => Promise<TotpLiveSnapshot | string> | TotpLiveSnapshot | string;
  parseOtpAuthUri?: (uri: string) => Promise<NewTotpTokenInput> | NewTotpTokenInput;
  copyCode?: (code: string, item: TotpVaultItemView) => Promise<void> | void;
  autoTypeToActiveSession?: (
    code: string,
    item: TotpVaultItemView,
  ) => Promise<{ ok: boolean; targetLabel?: string; message?: string }> | { ok: boolean; targetLabel?: string; message?: string };
  onOpenPinSettings?: () => void;
}

export interface Vault2faStudioController {
  readonly dialog: HTMLDialogElement;
  open: (triggerEl?: HTMLElement | null) => Promise<void>;
  close: () => void;
  refresh: () => Promise<void>;
  tickNow: (nowMs?: number) => Promise<void>;
}

export type AutoLockPresetSeconds = 0 | 60 | 300 | 900 | -1;

export interface AppLockPinStatus {
  hasPin?: boolean;
  isPinConfigured?: boolean;
  locked?: boolean;
  isLocked?: boolean;
  pinLength?: number | null;
  autoLockSeconds?: AutoLockPresetSeconds;
  autoLockTimeoutSeconds?: AutoLockPresetSeconds;
  failedAttempts: number;
  cooldownRemainingMs: number;
}

export interface PinVerifyResult {
  ok?: boolean;
  verified?: boolean;
  lockedOut?: boolean;
  failedAttempts?: number;
  cooldownRemainingMs?: number;
  message?: string;
}

export interface PinMutationResult {
  ok?: boolean;
  message?: string;
  status?: Partial<AppLockPinStatus>;
  state?: Partial<AppLockPinStatus>;
}

export interface AppLockPinBridge {
  getStatus: () => Promise<AppLockPinStatus> | AppLockPinStatus;
  verifyPin: (pin: string) => Promise<PinVerifyResult> | PinVerifyResult;
  setPin: (newPin: string, currentPin?: string) => Promise<PinMutationResult> | PinMutationResult;
  removePin: (currentPin: string) => Promise<PinMutationResult> | PinMutationResult;
  setAutoLockSeconds: (seconds: AutoLockPresetSeconds) => Promise<void> | void;
  lockNow?: () => Promise<void> | void;
  onUnlocked?: () => void;
  onLocked?: () => void;
}

export interface AppLockPinUiController {
  readonly overlay: HTMLElement;
  readonly settingsDialog: HTMLDialogElement;
  syncLockState: () => Promise<void>;
  lockScreen: () => Promise<void>;
  openSettings: (triggerEl?: HTMLElement | null) => Promise<void>;
  closeSettings: () => void;
  feedDigit: (digit: string) => Promise<void>;
  backspace: () => void;
  clearDigits: () => void;
  dispose: () => void;
}

export function formatTotpCodeDisplay(code: string): string {
  const digits = code.replace(/\s+/g, '');
  if (digits.length === 8) {
    return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  }
  if (digits.length === 6) {
    return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  }
  return digits;
}

export function normalizeBase32Input(raw: string): string {
  return raw.replace(/[\s\-=]+/g, '').toUpperCase();
}

export function isValidBase32Secret(raw: string): boolean {
  const cleaned = normalizeBase32Input(raw);
  return cleaned.length >= 8 && /^[A-Z2-7]+$/.test(cleaned);
}

function decodeBase32Bytes(secretBase32: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = normalizeBase32Input(secretBase32);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = alphabet.indexOf(cleaned[i]!);
    if (idx < 0) throw new Error('Invalid Base32 character in TOTP secret.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

async function computeWebCryptoTotpFallback(
  item: TotpVaultItemView,
  nowMs: number,
): Promise<TotpLiveSnapshot> {
  const period: TotpPeriod = item.period === 60 ? 60 : 30;
  const digits: TotpDigits = item.digits === 8 ? 8 : 6;
  const nowSec = Math.floor(nowMs / 1000);
  const counter = Math.floor(nowSec / period);
  const elapsedInWindow = (nowMs / 1000) % period;
  const remainingSeconds = Math.max(1, Math.ceil(period - elapsedInWindow));
  const progressRatio = Math.max(0, Math.min(1, (period - elapsedInWindow) / period));

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    const placeholder = digits === 8 ? '00000000' : '000000';
    return {
      code: placeholder,
      formattedCode: formatTotpCodeDisplay(placeholder),
      remainingSeconds,
      period,
      progressRatio,
    };
  }

  const keyBytes = decodeBase32Bytes(item.secretBase32);
  const hashName =
    item.algorithm === 'SHA256'
      ? 'SHA-256'
      : item.algorithm === 'SHA512'
        ? 'SHA-512'
        : 'SHA-1';

  const msg = new Uint8Array(8);
  let rem = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = rem & 0xff;
    rem = Math.floor(rem / 256);
  }

  const keyBuf = keyBytes.buffer.slice(
    keyBytes.byteOffset,
    keyBytes.byteOffset + keyBytes.byteLength,
  ) as ArrayBuffer;
  const cryptoKey = await subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: { name: hashName } },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await subtle.sign('HMAC', cryptoKey, msg));
  const offset = (sig[sig.length - 1] ?? 0) & 0x0f;
  const binary =
    (((sig[offset] ?? 0) & 0x7f) << 24) |
    (((sig[offset + 1] ?? 0) & 0xff) << 16) |
    (((sig[offset + 2] ?? 0) & 0xff) << 8) |
    ((sig[offset + 3] ?? 0) & 0xff);
  const mod = digits === 8 ? 100_000_000 : 1_000_000;
  const rawCode = String(binary % mod).padStart(digits, '0');
  return {
    code: rawCode,
    formattedCode: formatTotpCodeDisplay(rawCode),
    remainingSeconds,
    period,
    progressRatio,
  };
}

export function parseOtpAuthUriFallback(rawUri: string): NewTotpTokenInput {
  const trimmed = rawUri.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid otpauth:// URI format.');
  }
  if (parsed.protocol !== 'otpauth:') {
    throw new Error('URI must start with otpauth://totp/.');
  }
  const hostKind = (parsed.hostname || '').toLowerCase();
  if (hostKind && hostKind !== 'totp') {
    throw new Error(`Unsupported OTP type "${hostKind}" (only TOTP is supported).`);
  }
  const rawLabel = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  let labelIssuer = '';
  let accountName = rawLabel;
  const colonIdx = rawLabel.indexOf(':');
  if (colonIdx >= 0) {
    labelIssuer = rawLabel.slice(0, colonIdx).trim();
    accountName = rawLabel.slice(colonIdx + 1).trim();
  }
  const secret = normalizeBase32Input(parsed.searchParams.get('secret') ?? '');
  if (!isValidBase32Secret(secret)) {
    throw new Error('otpauth:// URI is missing a valid Base32 secret parameter.');
  }
  const issuer = (parsed.searchParams.get('issuer') ?? labelIssuer ?? '').trim() || 'Service';
  const rawAlgo = (parsed.searchParams.get('algorithm') ?? 'SHA1').toUpperCase().replace('-', '');
  const algorithm: TotpAlgorithm =
    rawAlgo === 'SHA256' ? 'SHA256' : rawAlgo === 'SHA512' ? 'SHA512' : 'SHA1';
  const rawDigits = Number.parseInt(parsed.searchParams.get('digits') ?? '6', 10);
  const digits: TotpDigits = rawDigits === 8 ? 8 : 6;
  const rawPeriod = Number.parseInt(parsed.searchParams.get('period') ?? '30', 10);
  const period: TotpPeriod = rawPeriod === 60 ? 60 : 30;

  return {
    issuer,
    accountName: accountName || 'account',
    secretBase32: secret,
    algorithm,
    digits,
    period,
  };
}

function makeField(
  labelTitle: string,
  control: HTMLElement,
  doc: Document,
): HTMLLabelElement {
  const label = doc.createElement('label');
  label.className = 'jala-field-label';
  const span = doc.createElement('span');
  span.className = 'jala-field-title';
  span.textContent = labelTitle;
  label.append(span, control);
  return label;
}

// ============================================================================
// PART A: 2FA Authenticator Studio Modal / Panel
// ============================================================================

interface RenderedTokenRow {
  readonly item: TotpVaultItemView;
  readonly codeEl: HTMLElement;
  readonly remainingEl: HTMLElement;
  readonly progressEl: HTMLProgressElement;
  latestCode: string;
}

export function createVault2faStudio(
  bridge: Vault2faUiBridge,
  doc: Document = document,
): Vault2faStudioController {
  let items: TotpVaultItemView[] = [];
  let renderedRows: RenderedTokenRow[] = [];
  let searchQuery = '';
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let lastTrigger: HTMLElement | null = null;
  let pendingDeleteId: string | null = null;

  const dialog = doc.createElement('dialog');
  dialog.id = 'jala-vault-2fa-dialog';
  dialog.className = 'jala-studio-dialog jala-vault-2fa-dialog';
  dialog.setAttribute('aria-labelledby', 'jala-vault-2fa-title');

  // ---- Header (#0D141F) ----
  const header = doc.createElement('div');
  header.className = 'jala-studio-header';

  const headerLead = doc.createElement('div');
  headerLead.className = 'jala-studio-header-lead';

  const iconBadge = doc.createElement('div');
  iconBadge.className = 'jala-studio-icon-badge';
  iconBadge.dataset.tone = 'gold';
  iconBadge.append(jalaSvgIcon('shield', doc, 18));

  const titleGroup = doc.createElement('div');
  titleGroup.className = 'jala-studio-title-group';

  const titleEl = doc.createElement('h2');
  titleEl.id = 'jala-vault-2fa-title';
  titleEl.className = 'jala-studio-title';
  titleEl.textContent = 'Authenticator (2FA)';

  const subEl = doc.createElement('p');
  subEl.className = 'jala-studio-subtitle';
  subEl.textContent = 'RFC 6238 TOTP generator with 1-click Auto-Type to active sessions';

  titleGroup.append(titleEl, subEl);
  headerLead.append(iconBadge, titleGroup);

  const headerActions = doc.createElement('div');
  headerActions.className = 'jala-studio-header-actions';

  const pinShortcutBtn = doc.createElement('button');
  pinShortcutBtn.id = 'jala-2fa-open-pin-btn';
  pinShortcutBtn.type = 'button';
  pinShortcutBtn.className = 'jala-btn quiet';
  pinShortcutBtn.append(jalaSvgIcon('lock', doc, 14));
  const pinShortcutLbl = doc.createElement('span');
  pinShortcutLbl.textContent = 'App Lock PIN';
  pinShortcutBtn.append(pinShortcutLbl);
  pinShortcutBtn.hidden = !bridge.onOpenPinSettings;
  pinShortcutBtn.onclick = () => {
    bridge.onOpenPinSettings?.();
  };

  const headerCloseBtn = doc.createElement('button');
  headerCloseBtn.type = 'button';
  headerCloseBtn.className = 'jala-icon-close-btn quiet';
  headerCloseBtn.setAttribute('aria-label', 'Close Authenticator Studio');
  headerCloseBtn.append(jalaSvgIcon('close', doc, 15));

  headerActions.append(pinShortcutBtn, headerCloseBtn);
  header.append(headerLead, headerActions);

  // ---- Body (#141D29) ----
  const body = doc.createElement('div');
  body.className = 'jala-studio-body';

  const feedbackBanner = doc.createElement('div');
  feedbackBanner.className = 'jala-alert-banner';
  feedbackBanner.setAttribute('role', 'status');
  feedbackBanner.hidden = true;

  // Search & Toolbar Strip
  const searchBarRow = doc.createElement('div');
  searchBarRow.className = 'jala-totp-toolbar';

  const searchInput = doc.createElement('input');
  searchInput.id = 'jala-totp-search';
  searchInput.type = 'search';
  searchInput.className = 'jala-input';
  searchInput.placeholder = 'Filter 2FA tokens by service or account...';

  searchBarRow.append(searchInput);

  // Import otpauth:// URI Collapsible Drawer
  const uriImportSection = doc.createElement('section');
  uriImportSection.id = 'jala-totp-uri-drawer';
  uriImportSection.className = 'jala-studio-section jala-totp-drawer';
  uriImportSection.hidden = true;

  const uriHeading = doc.createElement('h3');
  uriHeading.className = 'jala-section-heading';
  uriHeading.textContent = 'Import otpauth:// Provisioning URI';

  const uriInput = doc.createElement('input');
  uriInput.id = 'jala-totp-uri-input';
  uriInput.type = 'text';
  uriInput.className = 'jala-input jala-mono';
  uriInput.placeholder = 'otpauth://totp/GitHub:ops@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=6&period=30';

  const uriActions = doc.createElement('div');
  uriActions.className = 'jala-inline-actions';

  const uriFillFormBtn = doc.createElement('button');
  uriFillFormBtn.id = 'jala-totp-uri-fill-btn';
  uriFillFormBtn.type = 'button';
  uriFillFormBtn.className = 'jala-btn quiet';
  uriFillFormBtn.textContent = 'Inspect in Form';

  const uriImportNowBtn = doc.createElement('button');
  uriImportNowBtn.id = 'jala-totp-uri-save-btn';
  uriImportNowBtn.type = 'button';
  uriImportNowBtn.className = 'jala-btn jala-btn-primary';
  uriImportNowBtn.textContent = 'Import Token Now';

  uriActions.append(uriFillFormBtn, uriImportNowBtn);
  uriImportSection.append(
    uriHeading,
    makeField('Provisioning URI', uriInput, doc),
    uriActions,
  );

  // Add 2FA Token Studio Form (with 3 guaranteed 1-row segmented bars!)
  const addFormSection = doc.createElement('section');
  addFormSection.id = 'jala-totp-add-drawer';
  addFormSection.className = 'jala-studio-section jala-totp-drawer';
  addFormSection.hidden = true;

  const addHeading = doc.createElement('h3');
  addHeading.className = 'jala-section-heading';
  addHeading.textContent = 'Add 2FA Authenticator Token';

  const issuerInput = doc.createElement('input');
  issuerInput.id = 'jala-totp-issuer';
  issuerInput.type = 'text';
  issuerInput.className = 'jala-input';
  issuerInput.placeholder = 'GitHub / AWS / Proxmox / Cloudflare';

  const accountInput = doc.createElement('input');
  accountInput.id = 'jala-totp-account';
  accountInput.type = 'text';
  accountInput.className = 'jala-input';
  accountInput.placeholder = 'ops@company.com';

  const issuerAccountGrid = doc.createElement('div');
  issuerAccountGrid.className = 'jala-form-grid-2';
  issuerAccountGrid.append(
    makeField('Issuer / Service', issuerInput, doc),
    makeField('Account / Username', accountInput, doc),
  );

  const secretInput = doc.createElement('input');
  secretInput.id = 'jala-totp-secret';
  secretInput.type = 'text';
  secretInput.className = 'jala-input jala-mono';
  secretInput.placeholder = 'JBSWY3DPEHPK3PXP (Base32 A-Z, 2-7)';
  secretInput.autocomplete = 'off';

  const algorithmBar = createJalaSegmentedBar<TotpAlgorithm>({
    ariaLabel: 'TOTP HMAC Algorithm',
    testId: 'totp-algorithm-bar',
    doc,
    initialValue: 'SHA1',
    items: [
      { value: 'SHA1', label: 'SHA1' },
      { value: 'SHA256', label: 'SHA256' },
      { value: 'SHA512', label: 'SHA512' },
    ],
  });

  const digitsBar = createJalaSegmentedBar<TotpDigits>({
    ariaLabel: 'TOTP Code Digits',
    testId: 'totp-digits-bar',
    doc,
    initialValue: 6,
    items: [
      { value: 6, label: '6 Digits' },
      { value: 8, label: '8 Digits' },
    ],
  });

  const periodBar = createJalaSegmentedBar<TotpPeriod>({
    ariaLabel: 'TOTP Rotation Period',
    testId: 'totp-period-bar',
    doc,
    initialValue: 30,
    items: [
      { value: 30, label: '30s' },
      { value: 60, label: '60s' },
    ],
  });

  const digitsPeriodGrid = doc.createElement('div');
  digitsPeriodGrid.className = 'jala-form-grid-2';
  digitsPeriodGrid.append(
    makeField('Code Length', digitsBar.root, doc),
    makeField('Rotation Period', periodBar.root, doc),
  );

  const addFormActions = doc.createElement('div');
  addFormActions.className = 'jala-inline-actions';

  const cancelAddBtn = doc.createElement('button');
  cancelAddBtn.type = 'button';
  cancelAddBtn.className = 'jala-btn quiet';
  cancelAddBtn.textContent = 'Cancel';

  const saveTokenBtn = doc.createElement('button');
  saveTokenBtn.id = 'jala-totp-save-btn';
  saveTokenBtn.type = 'button';
  saveTokenBtn.className = 'jala-btn jala-btn-primary';
  saveTokenBtn.append(jalaSvgIcon('check', doc, 14));
  const saveTokenLbl = doc.createElement('span');
  saveTokenLbl.textContent = 'Save 2FA Token';
  saveTokenBtn.append(saveTokenLbl);

  addFormActions.append(cancelAddBtn, saveTokenBtn);

  addFormSection.append(
    addHeading,
    issuerAccountGrid,
    makeField('Base32 Secret Key', secretInput, doc),
    makeField('HMAC Digest Algorithm', algorithmBar.root, doc),
    digitsPeriodGrid,
    addFormActions,
  );

  // Live Token List Container
  const tokenListWrap = doc.createElement('div');
  tokenListWrap.id = 'jala-totp-list';
  tokenListWrap.className = 'jala-totp-list';

  body.append(
    feedbackBanner,
    searchBarRow,
    uriImportSection,
    addFormSection,
    tokenListWrap,
  );

  // ---- Separated #0A1018 Studio Footer ----
  const footer = doc.createElement('div');
  footer.className = 'jala-studio-footer';

  const footerLeft = doc.createElement('div');
  footerLeft.className = 'jala-studio-footer-left';

  const toggleUriBtn = doc.createElement('button');
  toggleUriBtn.id = 'jala-totp-toggle-uri-btn';
  toggleUriBtn.type = 'button';
  toggleUriBtn.className = 'jala-btn quiet';
  toggleUriBtn.append(jalaSvgIcon('qr', doc, 14));
  const toggleUriLbl = doc.createElement('span');
  toggleUriLbl.textContent = 'Import otpauth:// URI';
  toggleUriBtn.append(toggleUriLbl);

  const toggleAddBtn = doc.createElement('button');
  toggleAddBtn.id = 'jala-totp-toggle-add-btn';
  toggleAddBtn.type = 'button';
  toggleAddBtn.className = 'jala-btn jala-btn-primary';
  toggleAddBtn.append(jalaSvgIcon('plus', doc, 14));
  const toggleAddLbl = doc.createElement('span');
  toggleAddLbl.textContent = 'Add 2FA Token';
  toggleAddBtn.append(toggleAddLbl);

  footerLeft.append(toggleUriBtn, toggleAddBtn);

  const footerRight = doc.createElement('div');
  footerRight.className = 'jala-studio-footer-right';

  const tokenCountBadge = doc.createElement('span');
  tokenCountBadge.className = 'jala-status-pill';
  tokenCountBadge.dataset.tone = 'neutral';
  tokenCountBadge.textContent = '0 tokens';

  const closeFooterBtn = doc.createElement('button');
  closeFooterBtn.id = 'jala-totp-close-btn';
  closeFooterBtn.type = 'button';
  closeFooterBtn.className = 'jala-btn quiet';
  closeFooterBtn.textContent = 'Close';

  footerRight.append(tokenCountBadge, closeFooterBtn);
  footer.append(footerLeft, footerRight);

  dialog.append(header, body, footer);

  function showNotice(tone: 'ok' | 'warn' | 'danger' | 'none', text = ''): void {
    if (tone === 'none' || !text.trim()) {
      feedbackBanner.hidden = true;
      feedbackBanner.textContent = '';
      delete feedbackBanner.dataset.tone;
      return;
    }
    feedbackBanner.hidden = false;
    feedbackBanner.dataset.tone = tone;
    feedbackBanner.textContent = text;
  }

  function resetAddForm(): void {
    issuerInput.value = '';
    accountInput.value = '';
    secretInput.value = '';
    algorithmBar.setValue('SHA1', true);
    digitsBar.setValue(6, true);
    periodBar.setValue(30, true);
  }

  async function resolveSnapshot(
    item: TotpVaultItemView,
    nowMs: number,
  ): Promise<TotpLiveSnapshot> {
    if (bridge.computeCode) {
      const out = await bridge.computeCode(item, nowMs);
      if (typeof out === 'string') {
        const period: TotpPeriod = item.period === 60 ? 60 : 30;
        const elapsed = (nowMs / 1000) % period;
        const remainingSeconds = Math.max(1, Math.ceil(period - elapsed));
        return {
          code: out.replace(/\s+/g, ''),
          formattedCode: formatTotpCodeDisplay(out),
          remainingSeconds,
          period,
          progressRatio: Math.max(0, Math.min(1, (period - elapsed) / period)),
        };
      }
      return {
        ...out,
        formattedCode: out.formattedCode || formatTotpCodeDisplay(out.code),
      };
    }
    return computeWebCryptoTotpFallback(item, nowMs);
  }

  async function tickNow(nowMs = Date.now()): Promise<void> {
    for (const row of renderedRows) {
      try {
        const snap = await resolveSnapshot(row.item, nowMs);
        row.latestCode = snap.code;
        row.codeEl.textContent = snap.formattedCode;
        row.remainingEl.textContent = `${snap.remainingSeconds}s`;
        row.remainingEl.dataset.urgent = snap.remainingSeconds <= 5 ? 'true' : 'false';
        row.progressEl.value = Math.round(snap.progressRatio * 1000);
        row.progressEl.dataset.urgent = snap.remainingSeconds <= 5 ? 'true' : 'false';
      } catch {
        row.codeEl.textContent = 'Invalid Key';
      }
    }
  }

  function renderTokenList(): void {
    renderedRows = [];
    const q = searchQuery.trim().toLowerCase();
    const filtered = items.filter((it) => {
      if (!q) return true;
      return (
        it.issuer.toLowerCase().includes(q) ||
        it.accountName.toLowerCase().includes(q)
      );
    });

    tokenCountBadge.textContent = `${items.length} ${items.length === 1 ? 'token' : 'tokens'}`;

    if (filtered.length === 0) {
      const emptyBox = doc.createElement('div');
      emptyBox.className = 'jala-empty-state';
      const emptyTitle = doc.createElement('strong');
      emptyTitle.textContent =
        items.length === 0
          ? 'No 2FA Authenticator tokens stored yet'
          : `No tokens matched "${searchQuery}"`;
      const emptySub = doc.createElement('p');
      emptySub.textContent =
        items.length === 0
          ? 'Click Add 2FA Token or Import otpauth:// URI below to generate RFC 6238 codes locally.'
          : 'Clear your search filter to view all configured tokens.';
      emptyBox.append(emptyTitle, emptySub);
      tokenListWrap.replaceChildren(emptyBox);
      return;
    }

    const fragmentNodes: HTMLElement[] = [];

    for (const item of filtered) {
      const card = doc.createElement('article');
      card.className = 'jala-totp-card';
      card.dataset.tokenId = item.id;

      const topRow = doc.createElement('div');
      topRow.className = 'jala-totp-card-top';

      const identityWrap = doc.createElement('div');
      identityWrap.className = 'jala-totp-identity';

      const issuerEl = doc.createElement('strong');
      issuerEl.className = 'jala-totp-issuer';
      issuerEl.textContent = item.issuer || 'Service';

      const accountEl = doc.createElement('span');
      accountEl.className = 'jala-totp-account';
      accountEl.textContent = item.accountName || '';

      identityWrap.append(issuerEl);
      if (item.accountName) identityWrap.append(accountEl);

      const specPill = doc.createElement('span');
      specPill.className = 'jala-status-pill jala-mono';
      specPill.dataset.tone = 'neutral';
      specPill.textContent = `${item.algorithm} \u2022 ${item.digits}d \u2022 ${item.period}s`;

      topRow.append(identityWrap, specPill);

      const middleRow = doc.createElement('div');
      middleRow.className = 'jala-totp-code-row';

      const codeEl = doc.createElement('div');
      codeEl.className = 'jala-totp-code jala-mono';
      codeEl.textContent = item.digits === 8 ? '\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022' : '\u2022\u2022\u2022 \u2022\u2022\u2022';

      const actionsCluster = doc.createElement('div');
      actionsCluster.className = 'jala-totp-card-actions';

      const remainingEl = doc.createElement('span');
      remainingEl.className = 'jala-totp-remaining jala-mono';
      remainingEl.textContent = `${item.period}s`;

      const copyBtn = doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'jala-btn quiet jala-totp-copy-btn';
      copyBtn.append(jalaSvgIcon('copy', doc, 13));
      const copyLbl = doc.createElement('span');
      copyLbl.textContent = 'Copy';
      copyBtn.append(copyLbl);

      const autoTypeBtn = doc.createElement('button');
      autoTypeBtn.type = 'button';
      autoTypeBtn.className = 'jala-btn jala-btn-primary jala-totp-autotype-btn';
      autoTypeBtn.append(jalaSvgIcon('bolt', doc, 13));
      const autoTypeLbl = doc.createElement('span');
      autoTypeLbl.textContent = 'Auto-Type to Active Session';
      autoTypeBtn.append(autoTypeLbl);

      const removeBtn = doc.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'jala-btn jala-btn-danger-outline quiet';
      removeBtn.textContent = pendingDeleteId === item.id ? 'Confirm Remove' : 'Remove';

      actionsCluster.append(remainingEl, copyBtn, autoTypeBtn, removeBtn);
      middleRow.append(codeEl, actionsCluster);

      const progressEl = doc.createElement('progress');
      progressEl.className = 'jala-totp-progress';
      progressEl.max = 1000;
      progressEl.value = 1000;

      card.append(topRow, middleRow, progressEl);

      const rowRef: RenderedTokenRow = {
        item,
        codeEl,
        remainingEl,
        progressEl,
        latestCode: '',
      };
      renderedRows.push(rowRef);

      copyBtn.onclick = async () => {
        if (!rowRef.latestCode) await tickNow();
        const code = rowRef.latestCode;
        if (!code) return;
        try {
          if (bridge.copyCode) {
            await bridge.copyCode(code, item);
          } else {
            await globalThis.navigator?.clipboard?.writeText(code);
          }
          copyLbl.textContent = 'Copied';
          showNotice('ok', `Copied ${item.issuer} 2FA code to clipboard.`);
          setTimeout(() => {
            copyLbl.textContent = 'Copy';
          }, 1400);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showNotice('danger', `Clipboard copy failed: ${msg}`);
        }
      };

      autoTypeBtn.onclick = async () => {
        if (!rowRef.latestCode) await tickNow();
        const code = rowRef.latestCode;
        if (!code) return;
        if (!bridge.autoTypeToActiveSession) {
          showNotice('warn', 'Open an active RDP, VNC, or SSH tab first to stream Auto-Type.');
          return;
        }
        try {
          const res = await bridge.autoTypeToActiveSession(code, item);
          if (res.ok) {
            showNotice(
              'ok',
              res.message ||
                `Streamed ${item.issuer} code into ${res.targetLabel || 'active session'}.`,
            );
          } else {
            showNotice(
              'warn',
              res.message || 'No active interactive session is focused for Auto-Type.',
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showNotice('danger', `Auto-Type failed: ${msg}`);
        }
      };

      removeBtn.onclick = async () => {
        if (pendingDeleteId !== item.id) {
          pendingDeleteId = item.id;
          removeBtn.textContent = 'Confirm Remove';
          return;
        }
        pendingDeleteId = null;
        try {
          await bridge.deleteToken(item.id);
          await refresh();
          showNotice('ok', `Removed ${item.issuer} 2FA token.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showNotice('danger', `Could not delete token: ${msg}`);
        }
      };

      fragmentNodes.push(card);
    }

    tokenListWrap.replaceChildren(...fragmentNodes);
    void tickNow();
  }

  searchInput.oninput = () => {
    searchQuery = searchInput.value;
    renderTokenList();
  };

  toggleUriBtn.onclick = () => {
    uriImportSection.hidden = !uriImportSection.hidden;
    if (!uriImportSection.hidden) {
      addFormSection.hidden = true;
      uriInput.focus();
    }
  };

  toggleAddBtn.onclick = () => {
    addFormSection.hidden = !addFormSection.hidden;
    if (!addFormSection.hidden) {
      uriImportSection.hidden = true;
      issuerInput.focus();
    }
  };

  cancelAddBtn.onclick = () => {
    addFormSection.hidden = true;
    resetAddForm();
  };

  async function parseUriFromField(): Promise<NewTotpTokenInput | null> {
    const raw = uriInput.value.trim();
    if (!raw) {
      showNotice('danger', 'Paste an otpauth://totp/... URI first.');
      uriInput.focus();
      return null;
    }
    try {
      return bridge.parseOtpAuthUri
        ? await bridge.parseOtpAuthUri(raw)
        : parseOtpAuthUriFallback(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showNotice('danger', msg);
      return null;
    }
  }

  uriFillFormBtn.onclick = async () => {
    const parsed = await parseUriFromField();
    if (!parsed) return;
    issuerInput.value = parsed.issuer;
    accountInput.value = parsed.accountName;
    secretInput.value = parsed.secretBase32;
    algorithmBar.setValue(parsed.algorithm, true);
    digitsBar.setValue(parsed.digits, true);
    periodBar.setValue(parsed.period, true);
    uriImportSection.hidden = true;
    addFormSection.hidden = false;
    showNotice('ok', 'Parsed otpauth:// URI into form. Review and click Save 2FA Token.');
  };

  uriImportNowBtn.onclick = async () => {
    const parsed = await parseUriFromField();
    if (!parsed) return;
    try {
      await bridge.addToken(parsed);
      uriInput.value = '';
      uriImportSection.hidden = true;
      await refresh();
      showNotice('ok', `Imported ${parsed.issuer} (${parsed.accountName}) 2FA token.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showNotice('danger', `Could not import token: ${msg}`);
    }
  };

  saveTokenBtn.onclick = async () => {
    const issuer = issuerInput.value.trim();
    const accountName = accountInput.value.trim();
    const secretBase32 = normalizeBase32Input(secretInput.value);
    if (!issuer) {
      showNotice('danger', 'Enter an Issuer / Service name (for example GitHub or AWS).');
      issuerInput.focus();
      return;
    }
    if (!isValidBase32Secret(secretBase32)) {
      showNotice('danger', 'Enter a valid Base32 secret key (at least 8 characters using A-Z and 2-7).');
      secretInput.focus();
      return;
    }
    try {
      await bridge.addToken({
        issuer,
        accountName,
        secretBase32,
        algorithm: algorithmBar.getValue(),
        digits: digitsBar.getValue(),
        period: periodBar.getValue(),
      });
      resetAddForm();
      addFormSection.hidden = true;
      await refresh();
      showNotice('ok', `Added ${issuer} (${algorithmBar.getValue()}) 2FA token.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showNotice('danger', `Failed to save 2FA token: ${msg}`);
    }
  };

  function startTicker(): void {
    stopTicker();
    intervalId = setInterval(() => {
      void tickNow();
    }, 1000);
  }

  function stopTicker(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function closeStudio(): void {
    stopTicker();
    pendingDeleteId = null;
    if (dialog.open) dialog.close();
    lastTrigger?.focus();
  }

  closeFooterBtn.onclick = closeStudio;
  headerCloseBtn.onclick = closeStudio;
  dialog.onclose = () => {
    stopTicker();
  };

  async function refresh(): Promise<void> {
    items = [...(await bridge.listTokens())];
    renderTokenList();
  }

  return {
    dialog,
    open: async (triggerEl?: HTMLElement | null) => {
      lastTrigger = triggerEl ?? null;
      showNotice('none');
      await refresh();
      if (!dialog.open) dialog.showModal();
      startTicker();
    },
    close: closeStudio,
    refresh,
    tickNow,
  };
}

// ============================================================================
// PART B: Full-Screen Obsidian App Lock PIN Overlay & PIN Settings Modal
// ============================================================================

export function createAppLockPinUi(
  bridge: AppLockPinBridge,
  doc: Document = document,
): AppLockPinUiController {
  interface NormalizedPinState {
    hasPin: boolean;
    locked: boolean;
    pinLength: number;
    autoLockSeconds: AutoLockPresetSeconds;
    failedAttempts: number;
    cooldownRemainingMs: number;
  }

  function normalizePinState(
    raw: Partial<AppLockPinStatus>,
    fallback: NormalizedPinState,
  ): NormalizedPinState {
    const hasPin = raw.hasPin ?? raw.isPinConfigured ?? fallback.hasPin;
    const locked = raw.locked ?? raw.isLocked ?? fallback.locked;
    const rawLen = raw.pinLength ?? fallback.pinLength;
    const pinLength = typeof rawLen === 'number' && rawLen >= 4 && rawLen <= 8 ? rawLen : 6;
    const autoLockSeconds =
      raw.autoLockSeconds ?? raw.autoLockTimeoutSeconds ?? fallback.autoLockSeconds;
    return {
      hasPin,
      locked,
      pinLength,
      autoLockSeconds,
      failedAttempts: raw.failedAttempts ?? fallback.failedAttempts,
      cooldownRemainingMs: raw.cooldownRemainingMs ?? fallback.cooldownRemainingMs,
    };
  }

  let status: NormalizedPinState = {
    hasPin: false,
    locked: false,
    pinLength: 6,
    autoLockSeconds: 300,
    failedAttempts: 0,
    cooldownRemainingMs: 0,
  };
  let enteredDigits = '';
  let verifying = false;
  let cooldownUntilMs = 0;
  let cooldownTimer: ReturnType<typeof setInterval> | null = null;
  let settingsTrigger: HTMLElement | null = null;

  // ---- 1. Full-Screen Obsidian Lock Overlay (#070B12) ----
  const overlay = doc.createElement('div');
  overlay.id = 'jala-app-lock-overlay';
  overlay.className = 'jala-pin-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'jala-pin-lock-title');
  overlay.hidden = true;

  const lockCard = doc.createElement('div');
  lockCard.className = 'jala-pin-lock-card';

  const emblem = doc.createElement('div');
  emblem.className = 'jala-pin-emblem';
  emblem.append(jalaSvgIcon('shield', doc, 28));

  const lockTitle = doc.createElement('h2');
  lockTitle.id = 'jala-pin-lock-title';
  lockTitle.className = 'jala-pin-title';
  lockTitle.textContent = 'JalaDesk Workspace Locked';

  const lockSubtitle = doc.createElement('p');
  lockSubtitle.id = 'jala-pin-lock-subtitle';
  lockSubtitle.className = 'jala-pin-subtitle';
  lockSubtitle.textContent = 'Enter your security PIN to unlock sessions and credentials';

  const dotsRow = doc.createElement('div');
  dotsRow.id = 'jala-pin-dots';
  dotsRow.className = 'jala-pin-dots';
  dotsRow.setAttribute('aria-live', 'polite');

  const lockErrorMsg = doc.createElement('p');
  lockErrorMsg.id = 'jala-pin-lock-error';
  lockErrorMsg.className = 'jala-pin-error';
  lockErrorMsg.setAttribute('role', 'alert');
  lockErrorMsg.hidden = true;

  // Tactile 3x4 Numeric Keypad
  const keypad = doc.createElement('div');
  keypad.className = 'jala-pin-keypad';
  const keypadButtons: HTMLButtonElement[] = [];

  for (const keySpec of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'jala-pin-key';
    btn.dataset.pinKey = keySpec;
    if (keySpec === 'clear') {
      btn.classList.add('jala-pin-key-aux');
      btn.textContent = 'Clear';
      btn.setAttribute('aria-label', 'Clear entered PIN');
      btn.onclick = () => clearDigits();
    } else if (keySpec === 'back') {
      btn.classList.add('jala-pin-key-aux');
      btn.append(jalaSvgIcon('backspace', doc, 18));
      btn.setAttribute('aria-label', 'Delete last digit');
      btn.onclick = () => backspace();
    } else {
      btn.textContent = keySpec;
      btn.setAttribute('aria-label', `Digit ${keySpec}`);
      btn.onclick = () => {
        void feedDigit(keySpec);
      };
    }
    keypadButtons.push(btn);
    keypad.append(btn);
  }

  lockCard.append(emblem, lockTitle, lockSubtitle, dotsRow, lockErrorMsg, keypad);
  overlay.append(lockCard);

  function expectedPinLen(): number {
    const len = status.pinLength ?? 6;
    return Math.max(4, Math.min(8, len));
  }

  function renderDots(errorState = false): void {
    const count = Math.max(expectedPinLen(), enteredDigits.length);
    const dotNodes: HTMLElement[] = [];
    for (let i = 0; i < count; i++) {
      const dot = doc.createElement('span');
      dot.className = 'jala-pin-dot';
      dot.dataset.filled = i < enteredDigits.length ? 'true' : 'false';
      if (errorState) dot.dataset.error = 'true';
      dotNodes.push(dot);
    }
    dotsRow.replaceChildren(...dotNodes);
  }

  function setKeypadDisabled(disabled: boolean): void {
    for (const btn of keypadButtons) {
      btn.disabled = disabled;
    }
  }

  function stopCooldownTicker(): void {
    if (cooldownTimer !== null) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }

  function applyCooldown(ms: number): void {
    stopCooldownTicker();
    if (ms <= 0) {
      cooldownUntilMs = 0;
      setKeypadDisabled(verifying);
      return;
    }
    cooldownUntilMs = Date.now() + ms;
    const updateTick = () => {
      const remMs = cooldownUntilMs - Date.now();
      if (remMs <= 0) {
        stopCooldownTicker();
        cooldownUntilMs = 0;
        setKeypadDisabled(false);
        lockErrorMsg.hidden = true;
        lockErrorMsg.textContent = '';
        renderDots(false);
        return;
      }
      const remSec = Math.ceil(remMs / 1000);
      setKeypadDisabled(true);
      lockErrorMsg.hidden = false;
      lockErrorMsg.textContent = `Too many failed attempts. Try again in ${remSec}s.`;
    };
    updateTick();
    cooldownTimer = setInterval(updateTick, 250);
  }

  function triggerShake(message: string): void {
    lockErrorMsg.hidden = false;
    lockErrorMsg.textContent = message;
    lockCard.dataset.shake = 'true';
    renderDots(true);
    setTimeout(() => {
      delete lockCard.dataset.shake;
      enteredDigits = '';
      renderDots(false);
    }, 380);
  }

  async function submitUnlockAttempt(candidatePin: string): Promise<void> {
    if (verifying || candidatePin.length < 4) return;
    if (cooldownUntilMs > Date.now()) return;
    verifying = true;
    setKeypadDisabled(true);
    try {
      const res = await bridge.verifyPin(candidatePin);
      const isVerified = Boolean(res.ok ?? res.verified);
      if (isVerified) {
        enteredDigits = '';
        status.locked = false;
        status.failedAttempts = 0;
        status.cooldownRemainingMs = 0;
        lockErrorMsg.hidden = true;
        lockErrorMsg.textContent = '';
        overlay.hidden = true;
        renderDots(false);
        bridge.onUnlocked?.();
      } else {
        enteredDigits = '';
        if (res.cooldownRemainingMs && res.cooldownRemainingMs > 0) {
          renderDots(true);
          applyCooldown(res.cooldownRemainingMs);
        } else {
          triggerShake(res.message || 'Incorrect PIN. Please try again.');
        }
      }
    } catch (err) {
      enteredDigits = '';
      const msg = err instanceof Error ? err.message : String(err);
      triggerShake(`Verification error: ${msg}`);
    } finally {
      verifying = false;
      if (cooldownUntilMs <= Date.now()) {
        setKeypadDisabled(false);
      }
    }
  }

  async function feedDigit(digit: string): Promise<void> {
    if (overlay.hidden || verifying || cooldownUntilMs > Date.now()) return;
    if (!/^[0-9]$/.test(digit)) return;
    if (enteredDigits.length >= 8) return;

    lockErrorMsg.hidden = true;
    enteredDigits += digit;
    renderDots(false);

    // Instant unlock on final digit (no Enter needed!)
    if (enteredDigits.length === expectedPinLen()) {
      await submitUnlockAttempt(enteredDigits);
    }
  }

  function backspace(): void {
    if (overlay.hidden || verifying || cooldownUntilMs > Date.now()) return;
    if (enteredDigits.length === 0) return;
    enteredDigits = enteredDigits.slice(0, -1);
    renderDots(false);
  }

  function clearDigits(): void {
    if (overlay.hidden || verifying || cooldownUntilMs > Date.now()) return;
    enteredDigits = '';
    lockErrorMsg.hidden = true;
    renderDots(false);
  }

  const onWindowKeyDown = (ev: KeyboardEvent): void => {
    if (overlay.hidden) return;
    if (/^[0-9]$/.test(ev.key)) {
      ev.preventDefault();
      ev.stopPropagation();
      void feedDigit(ev.key);
    } else if (ev.key === 'Backspace') {
      ev.preventDefault();
      ev.stopPropagation();
      backspace();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      clearDigits();
    } else if (ev.key === 'Enter' && enteredDigits.length >= 4) {
      ev.preventDefault();
      ev.stopPropagation();
      void submitUnlockAttempt(enteredDigits);
    }
  };

  if (typeof globalThis.window !== 'undefined' && typeof globalThis.window.addEventListener === 'function') {
    globalThis.window.addEventListener('keydown', onWindowKeyDown, true);
  }

  // ---- 2. App Lock PIN Settings Modal (#141D29 / #0D141F / #0A1018) ----
  const settingsDialog = doc.createElement('dialog');
  settingsDialog.id = 'jala-pin-settings-dialog';
  settingsDialog.className = 'jala-studio-dialog jala-pin-settings-dialog';
  settingsDialog.setAttribute('aria-labelledby', 'jala-pin-settings-title');

  const sHeader = doc.createElement('div');
  sHeader.className = 'jala-studio-header';

  const sLead = doc.createElement('div');
  sLead.className = 'jala-studio-header-lead';

  const sBadge = doc.createElement('div');
  sBadge.className = 'jala-studio-icon-badge';
  sBadge.dataset.tone = 'gold';
  sBadge.append(jalaSvgIcon('lock', doc, 18));

  const sTitleGroup = doc.createElement('div');
  sTitleGroup.className = 'jala-studio-title-group';

  const sTitle = doc.createElement('h2');
  sTitle.id = 'jala-pin-settings-title';
  sTitle.className = 'jala-studio-title';
  sTitle.textContent = 'App Lock PIN & Auto-Lock';

  const sSubtitle = doc.createElement('p');
  sSubtitle.className = 'jala-studio-subtitle';
  sSubtitle.textContent = 'Zero-trust 4-8 digit workspace screen lock (PBKDF2-HMAC-SHA256)';

  sTitleGroup.append(sTitle, sSubtitle);
  sLead.append(sBadge, sTitleGroup);

  const sHeaderRight = doc.createElement('div');
  sHeaderRight.className = 'jala-studio-header-actions';

  const pinStatePill = doc.createElement('span');
  pinStatePill.id = 'jala-pin-state-pill';
  pinStatePill.className = 'jala-status-pill';
  pinStatePill.dataset.tone = 'neutral';
  pinStatePill.textContent = 'PIN Disabled';

  const sHeaderClose = doc.createElement('button');
  sHeaderClose.type = 'button';
  sHeaderClose.className = 'jala-icon-close-btn quiet';
  sHeaderClose.setAttribute('aria-label', 'Close PIN Settings');
  sHeaderClose.append(jalaSvgIcon('close', doc, 15));

  sHeaderRight.append(pinStatePill, sHeaderClose);
  sHeader.append(sLead, sHeaderRight);

  const sBody = doc.createElement('div');
  sBody.className = 'jala-studio-body';

  const sFeedback = doc.createElement('div');
  sFeedback.className = 'jala-alert-banner';
  sFeedback.setAttribute('role', 'status');
  sFeedback.hidden = true;

  // Auto-Lock 1-row Segmented Bar: Immediate | 1m | 5m | 15m | Off
  const autoLockSection = doc.createElement('section');
  autoLockSection.className = 'jala-studio-section';

  const autoLockRowTop = doc.createElement('div');
  autoLockRowTop.className = 'jala-section-row-between';

  const autoLockHeading = doc.createElement('h3');
  autoLockHeading.className = 'jala-section-heading';
  autoLockHeading.textContent = 'Inactivity Auto-Lock Timer';

  const lockNowBtn = doc.createElement('button');
  lockNowBtn.id = 'jala-pin-lock-now-btn';
  lockNowBtn.type = 'button';
  lockNowBtn.className = 'jala-btn quiet';
  lockNowBtn.append(jalaSvgIcon('lock', doc, 13));
  const lockNowLbl = doc.createElement('span');
  lockNowLbl.textContent = 'Lock Workspace Now';
  lockNowBtn.append(lockNowLbl);

  autoLockRowTop.append(autoLockHeading, lockNowBtn);

  const autoLockBar = createJalaSegmentedBar<AutoLockPresetSeconds>({
    ariaLabel: 'Auto-Lock Timeout',
    testId: 'app-lock-timeout-bar',
    doc,
    initialValue: 300,
    items: [
      { value: 0, label: 'Immediate' },
      { value: 60, label: '1m' },
      { value: 300, label: '5m' },
      { value: 900, label: '15m' },
      { value: -1, label: 'Off' },
    ],
    onChange: async (seconds) => {
      status.autoLockSeconds = seconds;
      try {
        await bridge.setAutoLockSeconds(seconds);
        setSettingsFeedback('ok', 'Updated Auto-Lock inactivity timeout.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setSettingsFeedback('danger', `Failed to save Auto-Lock timeout: ${msg}`);
      }
    },
  });

  autoLockSection.append(autoLockRowTop, autoLockBar.root);

  // Set / Change / Remove PIN Section
  const pinFormSection = doc.createElement('section');
  pinFormSection.className = 'jala-studio-section';

  const pinFormHeading = doc.createElement('h3');
  pinFormHeading.className = 'jala-section-heading';
  pinFormHeading.textContent = 'Configure 4-8 Digit Security PIN';

  const currentPinInput = doc.createElement('input');
  currentPinInput.id = 'jala-pin-current-input';
  currentPinInput.type = 'password';
  currentPinInput.inputMode = 'numeric';
  currentPinInput.maxLength = 8;
  currentPinInput.className = 'jala-input jala-mono';
  currentPinInput.placeholder = 'Enter current PIN';
  const currentPinField = makeField('Current PIN', currentPinInput, doc);

  const newPinInput = doc.createElement('input');
  newPinInput.id = 'jala-pin-new-input';
  newPinInput.type = 'password';
  newPinInput.inputMode = 'numeric';
  newPinInput.maxLength = 8;
  newPinInput.className = 'jala-input jala-mono';
  newPinInput.placeholder = '4 to 8 numeric digits';

  const confirmPinInput = doc.createElement('input');
  confirmPinInput.id = 'jala-pin-confirm-input';
  confirmPinInput.type = 'password';
  confirmPinInput.inputMode = 'numeric';
  confirmPinInput.maxLength = 8;
  confirmPinInput.className = 'jala-input jala-mono';
  confirmPinInput.placeholder = 'Repeat new PIN';

  const newPinGrid = doc.createElement('div');
  newPinGrid.className = 'jala-form-grid-2';
  newPinGrid.append(
    makeField('New Security PIN (4-8 Digits)', newPinInput, doc),
    makeField('Confirm New PIN', confirmPinInput, doc),
  );

  const pinHint = doc.createElement('p');
  pinHint.className = 'jala-helper-note';
  pinHint.textContent =
    'Unlock triggers automatically as soon as the final PIN digit is entered — no Enter key required.';

  pinFormSection.append(pinFormHeading, currentPinField, newPinGrid, pinHint);
  sBody.append(sFeedback, autoLockSection, pinFormSection);

  // Separated #0A1018 Footer
  const sFooter = doc.createElement('div');
  sFooter.className = 'jala-studio-footer';

  const sFooterLeft = doc.createElement('div');
  sFooterLeft.className = 'jala-studio-footer-left';

  const removePinBtn = doc.createElement('button');
  removePinBtn.id = 'jala-pin-remove-btn';
  removePinBtn.type = 'button';
  removePinBtn.className = 'jala-btn jala-btn-danger-outline quiet';
  removePinBtn.textContent = 'Remove PIN';

  sFooterLeft.append(removePinBtn);

  const sFooterRight = doc.createElement('div');
  sFooterRight.className = 'jala-studio-footer-right';

  const sCloseBtn = doc.createElement('button');
  sCloseBtn.id = 'jala-pin-settings-close-btn';
  sCloseBtn.type = 'button';
  sCloseBtn.className = 'jala-btn quiet';
  sCloseBtn.textContent = 'Close';

  const savePinBtn = doc.createElement('button');
  savePinBtn.id = 'jala-pin-save-btn';
  savePinBtn.type = 'button';
  savePinBtn.className = 'jala-btn jala-btn-primary';
  savePinBtn.append(jalaSvgIcon('shield', doc, 14));
  const savePinLbl = doc.createElement('span');
  savePinLbl.textContent = 'Save Security PIN';
  savePinBtn.append(savePinLbl);

  sFooterRight.append(sCloseBtn, savePinBtn);
  sFooter.append(sFooterLeft, sFooterRight);
  settingsDialog.append(sHeader, sBody, sFooter);

  function setSettingsFeedback(tone: 'ok' | 'warn' | 'danger' | 'none', text = ''): void {
    if (tone === 'none' || !text.trim()) {
      sFeedback.hidden = true;
      sFeedback.textContent = '';
      delete sFeedback.dataset.tone;
      return;
    }
    sFeedback.hidden = false;
    sFeedback.dataset.tone = tone;
    sFeedback.textContent = text;
  }

  function renderSettingsState(): void {
    pinStatePill.dataset.tone = status.hasPin ? 'ok' : 'neutral';
    pinStatePill.textContent = status.hasPin
      ? `PIN Enabled (${expectedPinLen()} digits)`
      : 'PIN Disabled';
    currentPinField.hidden = !status.hasPin;
    removePinBtn.hidden = !status.hasPin;
    lockNowBtn.hidden = !status.hasPin;
    pinFormHeading.textContent = status.hasPin
      ? 'Change Security PIN'
      : 'Set 4-8 Digit Security PIN';
    autoLockBar.setValue(status.autoLockSeconds, true);
  }

  function closeOpenModalDialogs(): void {
    if (settingsDialog.open) settingsDialog.close();
    if (typeof doc.querySelectorAll === 'function') {
      for (const d of Array.from(doc.querySelectorAll('dialog[open]'))) {
        (d as HTMLDialogElement).close?.();
      }
    }
  }

  async function syncLockState(): Promise<void> {
    const wasLocked = status.locked;
    status = normalizePinState(await bridge.getStatus(), status);
    renderSettingsState();
    if (status.hasPin && status.locked) {
      closeOpenModalDialogs();
      enteredDigits = '';
      overlay.hidden = false;
      renderDots(false);
      if (status.cooldownRemainingMs > 0) {
        applyCooldown(status.cooldownRemainingMs);
      } else {
        setKeypadDisabled(false);
      }
      const firstEnabledKey = keypadButtons.find((b) => !b.disabled);
      firstEnabledKey?.focus?.();
      if (!wasLocked) bridge.onLocked?.();
    } else {
      overlay.hidden = true;
      stopCooldownTicker();
    }
  }

  async function lockScreen(): Promise<void> {
    const wasLocked = status.locked;
    await bridge.lockNow?.();
    await syncLockState();
    if (status.hasPin && !status.locked) {
      status.locked = true;
      closeOpenModalDialogs();
      enteredDigits = '';
      lockErrorMsg.hidden = true;
      overlay.hidden = false;
      renderDots(false);
      const firstEnabledKey = keypadButtons.find((b) => !b.disabled);
      firstEnabledKey?.focus?.();
      if (!wasLocked) bridge.onLocked?.();
    }
  }

  lockNowBtn.onclick = () => {
    void lockScreen();
  };

  savePinBtn.onclick = async () => {
    const cur = currentPinInput.value.trim();
    const next = newPinInput.value.trim();
    const confirm = confirmPinInput.value.trim();
    if (status.hasPin && !/^[0-9]{4,8}$/.test(cur)) {
      setSettingsFeedback('danger', 'Enter your current 4-8 digit numeric PIN.');
      currentPinInput.focus();
      return;
    }
    if (!/^[0-9]{4,8}$/.test(next)) {
      setSettingsFeedback('danger', 'New Security PIN must be 4 to 8 numeric digits (0-9).');
      newPinInput.focus();
      return;
    }
    if (next !== confirm) {
      setSettingsFeedback('danger', 'New PIN and confirmation do not match.');
      confirmPinInput.focus();
      return;
    }
    try {
      const res = await bridge.setPin(next, status.hasPin ? cur : undefined);
      if (res.ok === false) {
        setSettingsFeedback('danger', res.message || 'Could not update Security PIN.');
        return;
      }
      status.hasPin = true;
      status.pinLength = next.length;
      if (res.status) status = normalizePinState(res.status, status);
      if (res.state) status = normalizePinState(res.state, status);
      currentPinInput.value = '';
      newPinInput.value = '';
      confirmPinInput.value = '';
      renderSettingsState();
      renderDots(false);
      setSettingsFeedback('ok', res.message || `Security PIN enabled (${next.length} digits).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSettingsFeedback('danger', `Could not save PIN: ${msg}`);
    }
  };

  removePinBtn.onclick = async () => {
    const cur = currentPinInput.value.trim();
    if (!/^[0-9]{4,8}$/.test(cur)) {
      setSettingsFeedback('danger', 'Enter your Current PIN above to remove App Lock protection.');
      currentPinInput.focus();
      return;
    }
    try {
      const res = await bridge.removePin(cur);
      if (res.ok === false) {
        setSettingsFeedback('danger', res.message || 'Incorrect current PIN.');
        return;
      }
      status.hasPin = false;
      status.locked = false;
      if (res.status) status = normalizePinState(res.status, status);
      if (res.state) status = normalizePinState(res.state, status);
      currentPinInput.value = '';
      newPinInput.value = '';
      confirmPinInput.value = '';
      overlay.hidden = true;
      renderSettingsState();
      setSettingsFeedback('ok', res.message || 'App Lock PIN removed.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSettingsFeedback('danger', `Failed to remove PIN: ${msg}`);
    }
  };

  function closeSettings(): void {
    currentPinInput.value = '';
    newPinInput.value = '';
    confirmPinInput.value = '';
    if (settingsDialog.open) settingsDialog.close();
    settingsTrigger?.focus();
  }

  sCloseBtn.onclick = closeSettings;
  sHeaderClose.onclick = closeSettings;

  return {
    overlay,
    settingsDialog,
    syncLockState,
    lockScreen,
    openSettings: async (triggerEl?: HTMLElement | null) => {
      settingsTrigger = triggerEl ?? null;
      setSettingsFeedback('none');
      await syncLockState();
      if (!(status.hasPin && status.locked) && !settingsDialog.open) {
        settingsDialog.showModal();
      }
    },
    closeSettings,
    feedDigit,
    backspace,
    clearDigits,
    dispose: () => {
      stopCooldownTicker();
      if (typeof globalThis.window !== 'undefined' && typeof globalThis.window.removeEventListener === 'function') {
        globalThis.window.removeEventListener('keydown', onWindowKeyDown, true);
      }
    },
  };
}
