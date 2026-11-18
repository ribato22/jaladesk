// Self-contained Enterprise Studio UI for Zero-Knowledge Cloud Sync & .jvault Backup.
// Built with DOM createElement / createElementNS only (CSP style-src 'self' safe: no innerHTML or inline style).

export type CloudSyncProviderId = 'googleDrive' | 'sftp' | 'webdav' | 'githubGist';

export type CloudSyncMode = 'smartMerge' | 'pushForce' | 'pullOnly';

export type JvaultImportMode = 'merge' | 'replace';

export interface CloudSyncUiState {
  provider: CloudSyncProviderId;
  autoSync: boolean;
  isBound: boolean;
  googleAccountEmail: string;
  googleAccountName?: string;
  oauthClientId: string;
  oauthClientSecret: string;
  useCustomPassphrase: boolean;
  syncPassphrase: string;
  sftpHost: string;
  sftpPort: number;
  sftpUsername: string;
  sftpPassword: string;
  sftpPrivateKeyPath: string;
  sftpRemotePath: string;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  githubToken: string;
  githubGistId: string;
  githubFilename: string;
  lastSyncAtMs: number | null;
  lastSyncError: string | null;
  lastSyncSummary?: string | null;
}

export type CloudSyncDraftPatch = Partial<
  Omit<CloudSyncUiState, 'isBound' | 'googleAccountEmail' | 'googleAccountName' | 'lastSyncAtMs' | 'lastSyncError' | 'lastSyncSummary'>
>;

export interface CloudSyncActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  state?: Partial<CloudSyncUiState>;
  mergedCounts?: {
    connections?: number;
    folders?: number;
    gateways?: number;
    credentials?: number;
    totpItems?: number;
  };
}

export interface JvaultActionResult {
  ok: boolean;
  cancelled?: boolean;
  filePath?: string;
  message?: string;
  error?: string;
  importedCounts?: {
    connections?: number;
    credentials?: number;
    totpItems?: number;
  };
}

export interface CloudSyncUiBridge {
  getState: () => Promise<Partial<CloudSyncUiState>> | Partial<CloudSyncUiState>;
  saveDraft: (draft: CloudSyncDraftPatch) => Promise<Partial<CloudSyncUiState> | void> | Partial<CloudSyncUiState> | void;
  signInGoogle: (params: {
    oauthClientId: string;
    oauthClientSecret: string;
    useCustomPassphrase: boolean;
    syncPassphrase: string;
    autoSync: boolean;
  }) => Promise<CloudSyncActionResult>;
  signOutUnbind: () => Promise<CloudSyncActionResult>;
  executeSync: (mode: CloudSyncMode, draft: CloudSyncDraftPatch) => Promise<CloudSyncActionResult>;
  exportJvault: (passphrase: string) => Promise<JvaultActionResult>;
  importJvault: (passphrase: string, mode: JvaultImportMode) => Promise<JvaultActionResult>;
  onSyncApplied?: (result: CloudSyncActionResult | JvaultActionResult) => Promise<void> | void;
}

export interface CloudSyncStudioController {
  readonly dialog: HTMLDialogElement;
  open: (triggerEl?: HTMLElement | null) => Promise<void>;
  close: () => Promise<void>;
  refresh: () => Promise<void>;
  getDraft: () => CloudSyncDraftPatch;
}

export type JalaStudioIconName =
  | 'cloud'
  | 'shield'
  | 'key'
  | 'lock'
  | 'unlock'
  | 'sync'
  | 'upload'
  | 'download'
  | 'check'
  | 'alert'
  | 'close'
  | 'search'
  | 'book'
  | 'copy'
  | 'bolt'
  | 'plus'
  | 'trash'
  | 'backspace'
  | 'terminal'
  | 'desktop'
  | 'route'
  | 'server'
  | 'clock'
  | 'qr'
  | 'archive'
  | 'chevron'
  | 'command';

type SvgShapeSpec = readonly [
  tag: 'path' | 'rect' | 'circle' | 'line' | 'polyline',
  attrs: Readonly<Record<string, string>>,
];

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_SHAPES: Readonly<Record<JalaStudioIconName, readonly SvgShapeSpec[]>> = {
  cloud: [
    ['path', { d: 'M4.5 13h7.2a2.8 2.8 0 0 0 .3-5.58A4.2 4.2 0 0 0 4 6.8 3.1 3.1 0 0 0 4.5 13Z' }],
  ],
  shield: [
    ['path', { d: 'M8 1.75 13.5 3.8v4.1c0 3.15-2.35 5.45-5.5 6.6-3.15-1.15-5.5-3.45-5.5-6.6V3.8L8 1.75Z' }],
  ],
  key: [
    ['circle', { cx: '5.2', cy: '10.6', r: '2.6' }],
    ['path', { d: 'M7.1 8.7 13.6 2.2' }],
    ['path', { d: 'm11.2 4.6 1.8 1.8' }],
    ['path', { d: 'm9.3 6.5 1.5 1.5' }],
  ],
  lock: [
    ['rect', { x: '3.2', y: '7.2', width: '9.6', height: '7', rx: '1.6' }],
    ['path', { d: 'M5.2 7.2V5.1a2.8 2.8 0 0 1 5.6 0v2.1' }],
  ],
  unlock: [
    ['rect', { x: '3.2', y: '7.2', width: '9.6', height: '7', rx: '1.6' }],
    ['path', { d: 'M5.2 7.2V4.9a2.8 2.8 0 0 1 5.3-1.2' }],
  ],
  sync: [
    ['path', { d: 'M13.2 6.2A5.4 5.4 0 0 0 3.5 4.8L2.5 6' }],
    ['polyline', { points: '2.3 3.2 2.5 6 5.3 5.8' }],
    ['path', { d: 'M2.8 9.8a5.4 5.4 0 0 0 9.7 1.4l1-1.2' }],
    ['polyline', { points: '13.7 12.8 13.5 10 10.7 10.2' }],
  ],
  upload: [
    ['path', { d: 'M8 10.8V2.6' }],
    ['polyline', { points: '4.8 5.6 8 2.4 11.2 5.6' }],
    ['path', { d: 'M2.6 11.2v1.6a1.2 1.2 0 0 0 1.2 1.2h8.4a1.2 1.2 0 0 0 1.2-1.2v-1.6' }],
  ],
  download: [
    ['path', { d: 'M8 2.4v8.2' }],
    ['polyline', { points: '4.8 7.6 8 10.8 11.2 7.6' }],
    ['path', { d: 'M2.6 11.2v1.6a1.2 1.2 0 0 0 1.2 1.2h8.4a1.2 1.2 0 0 0 1.2-1.2v-1.6' }],
  ],
  check: [
    ['polyline', { points: '2.8 8.4 6.3 11.9 13.2 4.4' }],
  ],
  alert: [
    ['path', { d: 'M8 2.2 14.2 13.2H1.8L8 2.2Z' }],
    ['line', { x1: '8', y1: '6.4', x2: '8', y2: '9.4' }],
    ['circle', { cx: '8', cy: '11.4', r: '0.6', fill: 'currentColor' }],
  ],
  close: [
    ['line', { x1: '3.8', y1: '3.8', x2: '12.2', y2: '12.2' }],
    ['line', { x1: '12.2', y1: '3.8', x2: '3.8', y2: '12.2' }],
  ],
  search: [
    ['circle', { cx: '7.1', cy: '7.1', r: '4.4' }],
    ['line', { x1: '10.4', y1: '10.4', x2: '13.6', y2: '13.6' }],
  ],
  book: [
    ['path', { d: 'M2.4 3.2h4.4a1.6 1.6 0 0 1 1.6 1.6v8.4a1.2 1.2 0 0 0-1.2-1.2H2.4V3.2Z' }],
    ['path', { d: 'M13.6 3.2H9.2a1.6 1.6 0 0 0-1.6 1.6v8.4a1.2 1.2 0 0 1 1.2-1.2h4.8V3.2Z' }],
  ],
  copy: [
    ['rect', { x: '5.4', y: '5.4', width: '8.2', height: '8.2', rx: '1.4' }],
    ['path', { d: 'M3.8 10.6H3a1.2 1.2 0 0 1-1.2-1.2V3A1.2 1.2 0 0 1 3 1.8h6.4A1.2 1.2 0 0 1 10.6 3v.8' }],
  ],
  bolt: [
    ['path', { d: 'M8.8 1.8 3.4 9h4.2l-.6 5.2L12.6 7H8.4l.4-5.2Z' }],
  ],
  plus: [
    ['line', { x1: '8', y1: '3.2', x2: '8', y2: '12.8' }],
    ['line', { x1: '3.2', y1: '8', x2: '12.8', y2: '8' }],
  ],
  trash: [
    ['path', { d: 'M2.8 4.4h10.4' }],
    ['path', { d: 'M6 4.4V2.8h4v1.6' }],
    ['path', { d: 'M4.2 4.4 4.8 13.4h6.4l.6-9' }],
  ],
  backspace: [
    ['path', { d: 'M6.2 3.4h7.4v9.2H6.2L2.2 8l4-4.6Z' }],
    ['line', { x1: '8.2', y1: '6.2', x2: '11.4', y2: '9.8' }],
    ['line', { x1: '11.4', y1: '6.2', x2: '8.2', y2: '9.8' }],
  ],
  terminal: [
    ['rect', { x: '1.8', y: '2.6', width: '12.4', height: '10.8', rx: '1.6' }],
    ['polyline', { points: '4.6 6.2 7.2 8.2 4.6 10.2' }],
    ['line', { x1: '8.4', y1: '10.2', x2: '11.6', y2: '10.2' }],
  ],
  desktop: [
    ['rect', { x: '1.8', y: '2.4', width: '12.4', height: '8.4', rx: '1.4' }],
    ['line', { x1: '8', y1: '10.8', x2: '8', y2: '13.6' }],
    ['line', { x1: '5.2', y1: '13.6', x2: '10.8', y2: '13.6' }],
  ],
  route: [
    ['circle', { cx: '3.6', cy: '4', r: '1.6' }],
    ['circle', { cx: '12.4', cy: '12', r: '1.6' }],
    ['path', { d: 'M5.2 4h3.6a2 2 0 0 1 0 4H7.2a2 2 0 0 0 0 4h3.6' }],
  ],
  server: [
    ['rect', { x: '2.2', y: '2.4', width: '11.6', height: '4.6', rx: '1.1' }],
    ['rect', { x: '2.2', y: '9', width: '11.6', height: '4.6', rx: '1.1' }],
    ['circle', { cx: '4.8', cy: '4.7', r: '0.65', fill: 'currentColor' }],
    ['circle', { cx: '4.8', cy: '11.3', r: '0.65', fill: 'currentColor' }],
  ],
  clock: [
    ['circle', { cx: '8', cy: '8', r: '5.8' }],
    ['polyline', { points: '8 4.6 8 8.2 10.6 9.8' }],
  ],
  qr: [
    ['rect', { x: '2.2', y: '2.2', width: '4.4', height: '4.4', rx: '0.7' }],
    ['rect', { x: '9.4', y: '2.2', width: '4.4', height: '4.4', rx: '0.7' }],
    ['rect', { x: '2.2', y: '9.4', width: '4.4', height: '4.4', rx: '0.7' }],
    ['path', { d: 'M9.4 9.4h2.2v2.2H9.4zM11.6 11.6h2.2v2.2h-2.2zM11.6 9.4h2.2' }],
  ],
  archive: [
    ['rect', { x: '2', y: '2.6', width: '12', height: '3', rx: '0.9' }],
    ['path', { d: 'M3.2 5.6v7a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2v-7' }],
    ['line', { x1: '6.2', y1: '8.4', x2: '9.8', y2: '8.4' }],
  ],
  chevron: [
    ['polyline', { points: '6 3.8 10.2 8 6 12.2' }],
  ],
  command: [
    ['path', { d: 'M5.2 5.2V3.9a1.7 1.7 0 1 0-1.7 1.7h9a1.7 1.7 0 1 0-1.7-1.7v8.2a1.7 1.7 0 1 0 1.7-1.7h-9a1.7 1.7 0 1 0 1.7 1.7V5.2Z' }],
  ],
};

export function jalaSvgIcon(
  name: JalaStudioIconName,
  doc: Document = document,
  size = 16,
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('data-jala-icon', name);
  for (const [tag, attrs] of ICON_SHAPES[name]) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, v);
    }
    svg.append(node);
  }
  return svg;
}

export interface JalaSegmentedOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  readonly icon?: JalaStudioIconName;
  readonly tooltip?: string;
}

export interface JalaSegmentedBarControl<T extends string | number> {
  readonly root: HTMLElement;
  getValue: () => T;
  setValue: (value: T, silent?: boolean) => void;
  setDisabled: (disabled: boolean) => void;
}

export function createJalaSegmentedBar<T extends string | number>(options: {
  ariaLabel: string;
  items: readonly JalaSegmentedOption<T>[];
  initialValue: T;
  onChange?: (value: T) => void;
  testId?: string;
  doc?: Document;
}): JalaSegmentedBarControl<T> {
  const doc = options.doc ?? document;
  const root = doc.createElement('div');
  root.className = 'jala-segmented-bar';
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', options.ariaLabel);
  if (options.testId) root.setAttribute('data-testid', options.testId);

  let current = options.initialValue;
  let isDisabled = false;
  const buttons = new Map<T, HTMLButtonElement>();

  const syncSelection = () => {
    for (const [val, btn] of buttons) {
      const selected = val === current;
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('aria-checked', selected ? 'true' : 'false');
      btn.dataset.selected = selected ? 'true' : 'false';
      btn.disabled = isDisabled;
    }
  };

  for (const item of options.items) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'jala-segment-pill';
    btn.setAttribute('role', 'radio');
    btn.dataset.segmentValue = String(item.value);
    if (item.tooltip) btn.setAttribute('title', item.tooltip);

    if (item.icon) {
      const iconWrap = doc.createElement('span');
      iconWrap.className = 'jala-segment-icon';
      iconWrap.append(jalaSvgIcon(item.icon, doc, 14));
      btn.append(iconWrap);
    }

    const labelSpan = doc.createElement('span');
    labelSpan.className = 'jala-segment-label';
    labelSpan.textContent = item.label;
    btn.append(labelSpan);

    btn.onclick = () => {
      if (isDisabled || current === item.value) return;
      current = item.value;
      syncSelection();
      options.onChange?.(current);
    };
    buttons.set(item.value, btn);
    root.append(btn);
  }

  syncSelection();

  return {
    root,
    getValue: () => current,
    setValue: (value: T, silent = true) => {
      current = value;
      syncSelection();
      if (!silent) options.onChange?.(current);
    },
    setDisabled: (disabled: boolean) => {
      isDisabled = disabled;
      syncSelection();
    },
  };
}

export interface JalaToggleRowControl {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  getChecked: () => boolean;
  setChecked: (checked: boolean, silent?: boolean) => void;
  setDisabled: (disabled: boolean) => void;
  setSubtitle: (subtitle: string) => void;
}

export function createJalaToggleRow(options: {
  id?: string;
  title: string;
  subtitle: string;
  initialChecked?: boolean;
  onChange?: (checked: boolean) => void;
  doc?: Document;
}): JalaToggleRowControl {
  const doc = options.doc ?? document;
  let checked = Boolean(options.initialChecked);
  let disabled = false;

  const root = doc.createElement('div');
  root.className = 'jala-toggle-row';

  const copy = doc.createElement('div');
  copy.className = 'jala-toggle-copy';

  const titleEl = doc.createElement('span');
  titleEl.className = 'jala-toggle-title';
  titleEl.textContent = options.title;

  const subEl = doc.createElement('span');
  subEl.className = 'jala-toggle-subtitle';
  subEl.textContent = options.subtitle;

  copy.append(titleEl, subEl);

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'jala-switch';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', options.title);
  if (options.id) button.id = options.id;

  const thumb = doc.createElement('span');
  thumb.className = 'jala-switch-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  button.append(thumb);

  const syncDom = () => {
    button.setAttribute('aria-checked', checked ? 'true' : 'false');
    button.dataset.checked = checked ? 'true' : 'false';
    button.disabled = disabled;
    root.dataset.checked = checked ? 'true' : 'false';
    root.dataset.disabled = disabled ? 'true' : 'false';
  };

  const toggle = () => {
    if (disabled) return;
    checked = !checked;
    syncDom();
    options.onChange?.(checked);
  };

  button.onclick = () => toggle();
  copy.onclick = () => toggle();

  syncDom();
  root.append(copy, button);

  return {
    root,
    button,
    getChecked: () => checked,
    setChecked: (nextChecked: boolean, silent = true) => {
      checked = Boolean(nextChecked);
      syncDom();
      if (!silent) options.onChange?.(checked);
    },
    setDisabled: (nextDisabled: boolean) => {
      disabled = Boolean(nextDisabled);
      syncDom();
    },
    setSubtitle: (subtitle: string) => {
      subEl.textContent = subtitle;
    },
  };
}

export function defaultCloudSyncUiState(over: Partial<CloudSyncUiState> = {}): CloudSyncUiState {
  return {
    provider: 'googleDrive',
    autoSync: true,
    isBound: false,
    googleAccountEmail: '',
    googleAccountName: '',
    oauthClientId: '',
    oauthClientSecret: '',
    useCustomPassphrase: false,
    syncPassphrase: '',
    sftpHost: '',
    sftpPort: 22,
    sftpUsername: '',
    sftpPassword: '',
    sftpPrivateKeyPath: '',
    sftpRemotePath: '.jaladesk/vault-sync.jdesk',
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    githubToken: '',
    githubGistId: '',
    githubFilename: 'jaladesk_vault_sync.jdesk',
    lastSyncAtMs: null,
    lastSyncError: null,
    lastSyncSummary: null,
    ...over,
  };
}

function formatSyncTimestamp(ts: number | null): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return 'Not synced yet on this desktop';
  try {
    return `Last synced ${new Date(ts).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  } catch {
    return 'Synced recently';
  }
}

function isGoogleAppDataPermissionIssue(rawMessage: string | null | undefined): boolean {
  if (!rawMessage) return false;
  const lower = rawMessage.toLowerCase();
  return (
    lower.includes('appdata') ||
    lower.includes('checkbox') ||
    lower.includes('unchecked') ||
    lower.includes('configuration data in your google drive') ||
    lower.includes('insufficientpermissions') ||
    lower.includes('insufficient authentication scopes') ||
    (lower.includes('google drive') && (lower.includes('permission') || lower.includes('403') || lower.includes('scope')))
  );
}

function accountInitial(email: string, name?: string): string {
  const source = (name?.trim() || email.trim() || 'G');
  const ch = source[0] ?? 'G';
  return ch.toUpperCase();
}

function createFieldLabel(
  text: string,
  inputEl: HTMLElement,
  doc: Document,
  optionalHint?: string,
): HTMLLabelElement {
  const label = doc.createElement('label');
  label.className = 'jala-field-label';
  const textWrap = doc.createElement('span');
  textWrap.className = 'jala-field-title';
  textWrap.textContent = text;
  if (optionalHint) {
    const opt = doc.createElement('span');
    opt.className = 'jala-field-optional';
    opt.textContent = ` (${optionalHint})`;
    textWrap.append(opt);
  }
  label.append(textWrap, inputEl);
  return label;
}

function createDisclosureSection(options: {
  title: string;
  badgeText?: string;
  icon: JalaStudioIconName;
  doc: Document;
}): {
  readonly details: HTMLDetailsElement;
  readonly body: HTMLDivElement;
} {
  const { doc } = options;
  const details = doc.createElement('details');
  details.className = 'jala-studio-disclosure';

  const summary = doc.createElement('summary');
  summary.className = 'jala-disclosure-summary';

  const left = doc.createElement('span');
  left.className = 'jala-disclosure-lead';
  left.append(jalaSvgIcon(options.icon, doc, 15));

  const titleSpan = doc.createElement('span');
  titleSpan.className = 'jala-disclosure-title';
  titleSpan.textContent = options.title;
  left.append(titleSpan);

  const right = doc.createElement('span');
  right.className = 'jala-disclosure-meta';

  if (options.badgeText) {
    const badge = doc.createElement('span');
    badge.className = 'jala-disclosure-tag jala-mono';
    badge.textContent = options.badgeText;
    right.append(badge);
  }

  const chevron = doc.createElement('span');
  chevron.className = 'jala-disclosure-chevron';
  chevron.append(jalaSvgIcon('chevron', doc, 13));
  right.append(chevron);

  summary.append(left, right);

  const body = doc.createElement('div');
  body.className = 'jala-disclosure-body';

  details.append(summary, body);
  return { details, body };
}

export function createCloudSyncStudio(
  bridge: CloudSyncUiBridge,
  doc: Document = document,
): CloudSyncStudioController {
  let state = defaultCloudSyncUiState();
  let busy = false;
  let lastTrigger: HTMLElement | null = null;
  let closingFlushed = false;
  let transientTone: 'ok' | 'warn' | 'danger' | 'none' = 'none';
  let transientMessage = '';

  const dialog = doc.createElement('dialog');
  dialog.id = 'jala-cloud-sync-dialog';
  dialog.className = 'jala-studio-dialog jala-cloud-sync-dialog';
  dialog.setAttribute('aria-labelledby', 'jala-cloud-sync-title');

  // ---- Header ----
  const header = doc.createElement('div');
  header.className = 'jala-studio-header';

  const headerLead = doc.createElement('div');
  headerLead.className = 'jala-studio-header-lead';

  const badgeIcon = doc.createElement('div');
  badgeIcon.className = 'jala-studio-icon-badge';
  badgeIcon.dataset.tone = 'blue';
  badgeIcon.append(jalaSvgIcon('cloud', doc, 18));

  const titleGroup = doc.createElement('div');
  titleGroup.className = 'jala-studio-title-group';

  const titleEl = doc.createElement('h2');
  titleEl.id = 'jala-cloud-sync-title';
  titleEl.className = 'jala-studio-title';
  titleEl.textContent = 'Cloud Sync';

  const subtitleEl = doc.createElement('p');
  subtitleEl.className = 'jala-studio-subtitle';
  subtitleEl.textContent = 'Zero-knowledge AES-256-GCM sync across Desktop & Mobile';

  titleGroup.append(titleEl, subtitleEl);
  headerLead.append(badgeIcon, titleGroup);

  const headerRight = doc.createElement('div');
  headerRight.className = 'jala-studio-header-actions';

  const headerStatusPill = doc.createElement('span');
  headerStatusPill.id = 'jala-cloud-sync-status-pill';
  headerStatusPill.className = 'jala-status-pill';
  headerStatusPill.dataset.tone = 'neutral';
  headerStatusPill.textContent = 'Unbound';

  const headerCloseBtn = doc.createElement('button');
  headerCloseBtn.type = 'button';
  headerCloseBtn.className = 'jala-icon-close-btn quiet';
  headerCloseBtn.setAttribute('aria-label', 'Close Cloud Sync');
  headerCloseBtn.append(jalaSvgIcon('close', doc, 15));

  headerRight.append(headerStatusPill, headerCloseBtn);
  header.append(headerLead, headerRight);

  // ---- Body ----
  const body = doc.createElement('div');
  body.className = 'jala-studio-body';

  // 1-Row Provider Segmented Bar (sits cleanly below header with zero extra wrapper box)
  const providerBar = createJalaSegmentedBar<CloudSyncProviderId>({
    ariaLabel: 'Cloud Sync Provider',
    testId: 'cloud-sync-provider-bar',
    doc,
    initialValue: 'googleDrive',
    items: [
      { value: 'googleDrive', label: 'Google Drive', icon: 'cloud' },
      { value: 'sftp', label: 'Private SFTP', icon: 'server' },
      { value: 'webdav', label: 'WebDAV', icon: 'sync' },
      { value: 'githubGist', label: 'GitHub Gist', icon: 'key' },
    ],
    onChange: (nextProvider) => {
      state.provider = nextProvider;
      setFeedback('none');
      updateProviderVisibility();
      renderStatusAndCallout();
    },
  });

  // SINGLE Unified Status / Permission Callout (never duplicated!)
  const unifiedCallout = doc.createElement('div');
  unifiedCallout.id = 'jala-sync-warning-pill';
  unifiedCallout.className = 'jala-unified-callout';
  unifiedCallout.setAttribute('role', 'status');
  unifiedCallout.hidden = true;

  const calloutIconWrap = doc.createElement('span');
  calloutIconWrap.className = 'jala-callout-icon';

  const calloutContent = doc.createElement('div');
  calloutContent.className = 'jala-callout-content';

  const calloutTitle = doc.createElement('strong');
  calloutTitle.className = 'jala-callout-title';

  const calloutText = doc.createElement('p');
  calloutText.className = 'jala-callout-text';

  calloutContent.append(calloutTitle, calloutText);

  const grantAccessSyncBtn = doc.createElement('button');
  grantAccessSyncBtn.id = 'jala-gdrive-grant-sync-btn';
  grantAccessSyncBtn.type = 'button';
  grantAccessSyncBtn.className = 'jala-btn jala-btn-primary jala-callout-cta';
  grantAccessSyncBtn.append(jalaSvgIcon('sync', doc, 14));
  const grantAccessSyncLbl = doc.createElement('span');
  grantAccessSyncLbl.textContent = 'Grant Access & Sync';
  grantAccessSyncBtn.append(grantAccessSyncLbl);
  grantAccessSyncBtn.hidden = true;

  unifiedCallout.append(calloutIconWrap, calloutContent, grantAccessSyncBtn);

  // ---- Provider Surface A: Google Drive (flat studio surface, zero card-in-card!) ----
  const googlePane = doc.createElement('div');
  googlePane.className = 'jala-provider-surface';
  googlePane.dataset.provider = 'googleDrive';

  // Unbound Hero View
  const googleUnboundHero = doc.createElement('div');
  googleUnboundHero.className = 'cs-gdrive-hero';

  const heroEmblem = doc.createElement('div');
  heroEmblem.className = 'cs-gdrive-emblem';
  heroEmblem.append(jalaSvgIcon('cloud', doc, 22));

  const heroCopy = doc.createElement('div');
  heroCopy.className = 'cs-gdrive-hero-copy';

  const heroHeading = doc.createElement('strong');
  heroHeading.className = 'cs-gdrive-hero-title';
  heroHeading.textContent = 'Private Google Drive AppData Vault';

  const heroDesc = doc.createElement('p');
  heroDesc.className = 'cs-gdrive-hero-desc';
  heroDesc.textContent =
    'Your connections, credentials, and 2FA tokens are encrypted locally before upload and sync automatically with JalaDesk Mobile.';

  heroCopy.append(heroHeading, heroDesc);

  const signInGoogleBtn = doc.createElement('button');
  signInGoogleBtn.id = 'jala-gdrive-signin-btn';
  signInGoogleBtn.type = 'button';
  signInGoogleBtn.className = 'jala-btn jala-btn-primary cs-google-signin-btn';
  signInGoogleBtn.append(jalaSvgIcon('cloud', doc, 15));
  const signInGoogleLabel = doc.createElement('span');
  signInGoogleLabel.textContent = 'Sign in with Google';
  signInGoogleBtn.append(signInGoogleLabel);

  googleUnboundHero.append(heroEmblem, heroCopy, signInGoogleBtn);

  // Bound Account Identity Bar
  const accountIdentityBar = doc.createElement('div');
  accountIdentityBar.className = 'cs-account-bar';
  accountIdentityBar.hidden = true;

  const accountLead = doc.createElement('div');
  accountLead.className = 'cs-account-lead';

  const avatarEl = doc.createElement('div');
  avatarEl.className = 'cs-account-avatar';
  avatarEl.textContent = 'G';

  const accountMeta = doc.createElement('div');
  accountMeta.className = 'cs-account-meta';

  const accountTitleRow = doc.createElement('div');
  accountTitleRow.className = 'cs-account-title-row';

  const accountEmailEl = doc.createElement('strong');
  accountEmailEl.className = 'cs-account-email';

  const accountBoundBadge = doc.createElement('span');
  accountBoundBadge.id = 'jala-gdrive-account-pill';
  accountBoundBadge.className = 'jala-status-pill jala-status-pill-compact';
  accountBoundBadge.dataset.tone = 'ok';
  accountBoundBadge.textContent = 'Bound';

  accountTitleRow.append(accountEmailEl, accountBoundBadge);

  const accountSubtitleEl = doc.createElement('span');
  accountSubtitleEl.className = 'cs-account-sub';
  accountSubtitleEl.textContent = 'Google Drive AppData';

  accountMeta.append(accountTitleRow, accountSubtitleEl);
  accountLead.append(avatarEl, accountMeta);

  const accountActions = doc.createElement('div');
  accountActions.className = 'cs-account-actions';

  const reconnectGoogleBtn = doc.createElement('button');
  reconnectGoogleBtn.id = 'jala-gdrive-reconnect-btn';
  reconnectGoogleBtn.type = 'button';
  reconnectGoogleBtn.className = 'jala-btn jala-btn-compact quiet';
  reconnectGoogleBtn.textContent = 'Reconnect';

  const unbindGoogleBtn = doc.createElement('button');
  unbindGoogleBtn.id = 'jala-gdrive-unbind-btn';
  unbindGoogleBtn.type = 'button';
  unbindGoogleBtn.className = 'jala-btn jala-btn-compact jala-btn-subtle-danger quiet';
  unbindGoogleBtn.textContent = 'Disconnect';

  accountActions.append(reconnectGoogleBtn, unbindGoogleBtn);
  accountIdentityBar.append(accountLead, accountActions);

  googlePane.append(googleUnboundHero, accountIdentityBar);

  // ---- Provider Surface B: Private SFTP ----
  const sftpPane = doc.createElement('div');
  sftpPane.className = 'jala-provider-surface';
  sftpPane.dataset.provider = 'sftp';
  sftpPane.hidden = true;

  const sftpHostInput = doc.createElement('input');
  sftpHostInput.id = 'jala-sftp-host';
  sftpHostInput.type = 'text';
  sftpHostInput.className = 'jala-input jala-mono';
  sftpHostInput.placeholder = 'sftp.internal.example.com';

  const sftpPortInput = doc.createElement('input');
  sftpPortInput.id = 'jala-sftp-port';
  sftpPortInput.type = 'number';
  sftpPortInput.min = '1';
  sftpPortInput.max = '65535';
  sftpPortInput.className = 'jala-input jala-mono';
  sftpPortInput.value = '22';

  const sftpUserInput = doc.createElement('input');
  sftpUserInput.id = 'jala-sftp-user';
  sftpUserInput.type = 'text';
  sftpUserInput.className = 'jala-input';
  sftpUserInput.placeholder = 'ubuntu';

  const sftpPassInput = doc.createElement('input');
  sftpPassInput.id = 'jala-sftp-password';
  sftpPassInput.type = 'password';
  sftpPassInput.className = 'jala-input';
  sftpPassInput.placeholder = 'Optional if using SSH key';

  const sftpKeyPathInput = doc.createElement('input');
  sftpKeyPathInput.id = 'jala-sftp-key-path';
  sftpKeyPathInput.type = 'text';
  sftpKeyPathInput.className = 'jala-input jala-mono';
  sftpKeyPathInput.placeholder = '~/.ssh/id_ed25519';

  const sftpRemotePathInput = doc.createElement('input');
  sftpRemotePathInput.id = 'jala-sftp-remote-path';
  sftpRemotePathInput.type = 'text';
  sftpRemotePathInput.className = 'jala-input jala-mono';
  sftpRemotePathInput.placeholder = '.jaladesk/vault-sync.jdesk';

  const sftpHostPortRow = doc.createElement('div');
  sftpHostPortRow.className = 'jala-form-host-port';
  sftpHostPortRow.append(
    createFieldLabel('SSH / SFTP Host', sftpHostInput, doc),
    createFieldLabel('Port', sftpPortInput, doc),
  );

  const sftpAuthRow = doc.createElement('div');
  sftpAuthRow.className = 'jala-form-grid-2';
  sftpAuthRow.append(
    createFieldLabel('Username', sftpUserInput, doc),
    createFieldLabel('SSH Password', sftpPassInput, doc, 'optional'),
  );

  const sftpPathRow = doc.createElement('div');
  sftpPathRow.className = 'jala-form-grid-2';
  sftpPathRow.append(
    createFieldLabel('Private Key Path', sftpKeyPathInput, doc, 'optional'),
    createFieldLabel('Remote Envelope Path', sftpRemotePathInput, doc),
  );

  sftpPane.append(sftpHostPortRow, sftpAuthRow, sftpPathRow);

  // ---- Provider Surface C: WebDAV ----
  const webdavPane = doc.createElement('div');
  webdavPane.className = 'jala-provider-surface';
  webdavPane.dataset.provider = 'webdav';
  webdavPane.hidden = true;

  const webdavUrlInput = doc.createElement('input');
  webdavUrlInput.id = 'jala-webdav-url';
  webdavUrlInput.type = 'url';
  webdavUrlInput.className = 'jala-input jala-mono';
  webdavUrlInput.placeholder = 'https://nextcloud.example.com/remote.php/dav/files/user/jaladesk_vault_sync.jdesk';

  const webdavUserInput = doc.createElement('input');
  webdavUserInput.id = 'jala-webdav-user';
  webdavUserInput.type = 'text';
  webdavUserInput.className = 'jala-input';
  webdavUserInput.placeholder = 'WebDAV username';

  const webdavPassInput = doc.createElement('input');
  webdavPassInput.id = 'jala-webdav-password';
  webdavPassInput.type = 'password';
  webdavPassInput.className = 'jala-input';
  webdavPassInput.placeholder = 'App password or token';

  const webdavAuthGrid = doc.createElement('div');
  webdavAuthGrid.className = 'jala-form-grid-2';
  webdavAuthGrid.append(
    createFieldLabel('Username', webdavUserInput, doc),
    createFieldLabel('Password / App Token', webdavPassInput, doc),
  );

  webdavPane.append(
    createFieldLabel('WebDAV HTTPS Endpoint URL', webdavUrlInput, doc),
    webdavAuthGrid,
  );

  // ---- Provider Surface D: GitHub Gist ----
  const gistPane = doc.createElement('div');
  gistPane.className = 'jala-provider-surface';
  gistPane.dataset.provider = 'githubGist';
  gistPane.hidden = true;

  const githubTokenInput = doc.createElement('input');
  githubTokenInput.id = 'jala-gist-token';
  githubTokenInput.type = 'password';
  githubTokenInput.className = 'jala-input jala-mono';
  githubTokenInput.placeholder = 'ghp_... or github_pat_... (gist scope)';

  const githubGistIdInput = doc.createElement('input');
  githubGistIdInput.id = 'jala-gist-id';
  githubGistIdInput.type = 'text';
  githubGistIdInput.className = 'jala-input jala-mono';
  githubGistIdInput.placeholder = 'Auto-created on first push if empty';

  const githubFilenameInput = doc.createElement('input');
  githubFilenameInput.id = 'jala-gist-filename';
  githubFilenameInput.type = 'text';
  githubFilenameInput.className = 'jala-input jala-mono';
  githubFilenameInput.placeholder = 'jaladesk_vault_sync.jdesk';

  const gistMetaGrid = doc.createElement('div');
  gistMetaGrid.className = 'jala-form-grid-2';
  gistMetaGrid.append(
    createFieldLabel('Secret Gist ID', githubGistIdInput, doc, 'auto-filled'),
    createFieldLabel('Envelope Filename', githubFilenameInput, doc),
  );

  gistPane.append(
    createFieldLabel('Personal Access Token (gist scope)', githubTokenInput, doc),
    gistMetaGrid,
  );

  // ---- Hairline + Precision Toggle Switch Rows ----
  const dividerPrimary = doc.createElement('hr');
  dividerPrimary.className = 'jala-hairline';

  const togglesStack = doc.createElement('div');
  togglesStack.className = 'jala-toggles-stack';

  const autoSyncToggle = createJalaToggleRow({
    id: 'jala-sync-autosync',
    title: 'Automatic Background Sync',
    subtitle: 'Sync encrypted vault updates automatically when workspace changes are saved',
    initialChecked: true,
    doc,
  });

  const customPassToggle = createJalaToggleRow({
    id: 'jala-gdrive-custom-pass-toggle',
    title: 'Custom E2EE Passphrase',
    subtitle: 'Automatic Google account-bound AES-256-GCM key active (matches Mobile seamlessly)',
    initialChecked: false,
    doc,
    onChange: () => {
      updateProviderVisibility();
    },
  });

  const syncPassphraseInput = doc.createElement('input');
  syncPassphraseInput.id = 'jala-sync-passphrase';
  syncPassphraseInput.type = 'password';
  syncPassphraseInput.className = 'jala-input';
  syncPassphraseInput.placeholder = 'Minimum 4 characters (PBKDF2-HMAC-SHA256 -> AES-256-GCM)';

  const syncPassphraseField = createFieldLabel(
    'E2EE Vault Passphrase',
    syncPassphraseInput,
    doc,
  );
  syncPassphraseField.classList.add('jala-passphrase-reveal');

  togglesStack.append(autoSyncToggle.root, customPassToggle.root, syncPassphraseField);

  // ---- Hairline + Sleek Collapsible Disclosures ----
  const dividerDisclosures = doc.createElement('hr');
  dividerDisclosures.className = 'jala-hairline';

  const disclosuresGroup = doc.createElement('div');
  disclosuresGroup.className = 'jala-disclosures-group';

  // Disclosure 1: Custom Enterprise OAuth App
  const enterpriseDisclosure = createDisclosureSection({
    title: 'Custom Enterprise OAuth App',
    badgeText: 'Optional',
    icon: 'shield',
    doc,
  });

  const advancedNote = doc.createElement('p');
  advancedNote.className = 'jala-helper-note';
  advancedNote.textContent =
    'Leave blank for standard 1-click Google Sign-In. Organizations with restricted OAuth policies can specify a custom Desktop Client ID.';

  const oauthClientIdInput = doc.createElement('input');
  oauthClientIdInput.id = 'jala-gdrive-client-id';
  oauthClientIdInput.type = 'text';
  oauthClientIdInput.className = 'jala-input jala-mono';
  oauthClientIdInput.placeholder = 'Custom Client ID (*.apps.googleusercontent.com)';
  oauthClientIdInput.autocomplete = 'off';

  const oauthClientSecretInput = doc.createElement('input');
  oauthClientSecretInput.id = 'jala-gdrive-client-secret';
  oauthClientSecretInput.type = 'password';
  oauthClientSecretInput.className = 'jala-input jala-mono';
  oauthClientSecretInput.placeholder = 'Custom Client Secret';
  oauthClientSecretInput.autocomplete = 'off';

  const oauthGrid = doc.createElement('div');
  oauthGrid.className = 'jala-form-grid-2';
  oauthGrid.append(
    createFieldLabel('OAuth Client ID', oauthClientIdInput, doc),
    createFieldLabel('Client Secret', oauthClientSecretInput, doc, 'optional'),
  );

  enterpriseDisclosure.body.append(advancedNote, oauthGrid);

  // Disclosure 2: Portable .jvault Backup Archive
  const jvaultDisclosure = createDisclosureSection({
    title: 'Portable .jvault Backup Archive',
    badgeText: '.jvault',
    icon: 'archive',
    doc,
  });

  const jvaultDesc = doc.createElement('p');
  jvaultDesc.className = 'jala-helper-note';
  jvaultDesc.textContent =
    'Export or restore air-gapped AES-256-GCM snapshots compatible with JalaDesk Mobile and Desktop.';

  const jvaultPassInput = doc.createElement('input');
  jvaultPassInput.id = 'jala-jvault-passphrase';
  jvaultPassInput.type = 'password';
  jvaultPassInput.className = 'jala-input';
  jvaultPassInput.placeholder = 'Archive passphrase (min. 4 chars)';

  const jvaultModeBar = createJalaSegmentedBar<JvaultImportMode>({
    ariaLabel: 'Backup Restore Strategy',
    testId: 'jvault-import-mode-bar',
    doc,
    initialValue: 'merge',
    items: [
      { value: 'merge', label: 'Smart Merge' },
      { value: 'replace', label: 'Replace Local' },
    ],
  });

  const jvaultGrid = doc.createElement('div');
  jvaultGrid.className = 'jala-form-grid-2 jala-jvault-grid';
  jvaultGrid.append(
    createFieldLabel('Archive Passphrase', jvaultPassInput, doc),
    createFieldLabel('Restore Strategy', jvaultModeBar.root, doc),
  );

  const jvaultBtnRow = doc.createElement('div');
  jvaultBtnRow.className = 'jala-inline-actions';

  const exportJvaultBtn = doc.createElement('button');
  exportJvaultBtn.id = 'jala-jvault-export-btn';
  exportJvaultBtn.type = 'button';
  exportJvaultBtn.className = 'jala-btn quiet';
  exportJvaultBtn.append(jalaSvgIcon('download', doc, 14));
  const exportLbl = doc.createElement('span');
  exportLbl.textContent = 'Export .jvault';
  exportJvaultBtn.append(exportLbl);

  const importJvaultBtn = doc.createElement('button');
  importJvaultBtn.id = 'jala-jvault-import-btn';
  importJvaultBtn.type = 'button';
  importJvaultBtn.className = 'jala-btn quiet';
  importJvaultBtn.append(jalaSvgIcon('upload', doc, 14));
  const importLbl = doc.createElement('span');
  importLbl.textContent = 'Import .jvault';
  importJvaultBtn.append(importLbl);

  jvaultBtnRow.append(exportJvaultBtn, importJvaultBtn);
  jvaultDisclosure.body.append(jvaultDesc, jvaultGrid, jvaultBtnRow);

  disclosuresGroup.append(enterpriseDisclosure.details, jvaultDisclosure.details);

  body.append(
    providerBar.root,
    unifiedCallout,
    googlePane,
    sftpPane,
    webdavPane,
    gistPane,
    dividerPrimary,
    togglesStack,
    dividerDisclosures,
    disclosuresGroup,
  );

  // ---- Separated Footer Bar ----
  const footer = doc.createElement('div');
  footer.className = 'jala-studio-footer';

  const footerLeft = doc.createElement('div');
  footerLeft.className = 'jala-studio-footer-left';

  const pullBtn = doc.createElement('button');
  pullBtn.id = 'jala-sync-pull-btn';
  pullBtn.type = 'button';
  pullBtn.className = 'jala-btn quiet';
  pullBtn.append(jalaSvgIcon('download', doc, 14));
  const pullText = doc.createElement('span');
  pullText.textContent = 'Pull';
  pullBtn.append(pullText);

  const forcePushBtn = doc.createElement('button');
  forcePushBtn.id = 'jala-sync-push-btn';
  forcePushBtn.type = 'button';
  forcePushBtn.className = 'jala-btn quiet';
  forcePushBtn.append(jalaSvgIcon('upload', doc, 14));
  const pushText = doc.createElement('span');
  pushText.textContent = 'Force Push';
  forcePushBtn.append(pushText);

  footerLeft.append(pullBtn, forcePushBtn);

  const footerRight = doc.createElement('div');
  footerRight.className = 'jala-studio-footer-right';

  const closeFooterBtn = doc.createElement('button');
  closeFooterBtn.id = 'jala-sync-close-btn';
  closeFooterBtn.type = 'button';
  closeFooterBtn.className = 'jala-btn quiet';
  closeFooterBtn.textContent = 'Close';

  const smartMergeBtn = doc.createElement('button');
  smartMergeBtn.id = 'jala-sync-smart-merge-btn';
  smartMergeBtn.type = 'button';
  smartMergeBtn.className = 'jala-btn jala-btn-primary';
  smartMergeBtn.append(jalaSvgIcon('sync', doc, 15));
  const smartMergeText = doc.createElement('span');
  smartMergeText.textContent = 'Smart Merge Sync';
  smartMergeBtn.append(smartMergeText);

  footerRight.append(closeFooterBtn, smartMergeBtn);
  footer.append(footerLeft, footerRight);

  dialog.append(header, body, footer);

  function setFeedback(tone: 'ok' | 'warn' | 'danger' | 'none', message = ''): void {
    transientTone = tone;
    transientMessage = tone === 'none' ? '' : message.trim();
    renderStatusAndCallout();
  }

  function collectDraft(): CloudSyncDraftPatch {
    const parsedPort = Number.parseInt(sftpPortInput.value.trim(), 10);
    return {
      provider: providerBar.getValue(),
      autoSync: autoSyncToggle.getChecked(),
      oauthClientId: oauthClientIdInput.value.trim(),
      oauthClientSecret: oauthClientSecretInput.value.trim(),
      useCustomPassphrase: customPassToggle.getChecked(),
      syncPassphrase: syncPassphraseInput.value,
      sftpHost: sftpHostInput.value.trim(),
      sftpPort: Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 22,
      sftpUsername: sftpUserInput.value.trim(),
      sftpPassword: sftpPassInput.value,
      sftpPrivateKeyPath: sftpKeyPathInput.value.trim(),
      sftpRemotePath: sftpRemotePathInput.value.trim() || '.jaladesk/vault-sync.jdesk',
      webdavUrl: webdavUrlInput.value.trim(),
      webdavUsername: webdavUserInput.value.trim(),
      webdavPassword: webdavPassInput.value,
      githubToken: githubTokenInput.value.trim(),
      githubGistId: githubGistIdInput.value.trim(),
      githubFilename: githubFilenameInput.value.trim() || 'jaladesk_vault_sync.jdesk',
    };
  }

  function updateProviderVisibility(): void {
    const activeProvider = providerBar.getValue();
    googlePane.hidden = activeProvider !== 'googleDrive';
    sftpPane.hidden = activeProvider !== 'sftp';
    webdavPane.hidden = activeProvider !== 'webdav';
    gistPane.hidden = activeProvider !== 'githubGist';

    customPassToggle.root.hidden = activeProvider !== 'googleDrive';
    enterpriseDisclosure.details.hidden = activeProvider !== 'googleDrive';

    const useCustomPass = customPassToggle.getChecked();
    const showPassphraseField = activeProvider !== 'googleDrive' || useCustomPass;
    syncPassphraseField.hidden = !showPassphraseField;

    if (activeProvider === 'googleDrive') {
      customPassToggle.setSubtitle(
        useCustomPass
          ? 'Custom passphrase enabled — enter the exact same secret on Mobile and Desktop'
          : 'Automatic Google account-bound AES-256-GCM key active (matches Mobile seamlessly)',
      );
    }
  }

  function renderStatusAndCallout(): void {
    const activeProvider = providerBar.getValue();
    const email = state.googleAccountEmail.trim();
    const isBound = Boolean(state.isBound && email);
    const persistedErr = state.lastSyncError?.trim() ?? '';

    // 1. Account Identity vs Unbound Hero on Google Drive
    googleUnboundHero.hidden = isBound;
    accountIdentityBar.hidden = !isBound;

    if (isBound) {
      avatarEl.textContent = accountInitial(email, state.googleAccountName);
      accountEmailEl.textContent = email;
      const syncMeta = state.lastSyncSummary?.trim() || formatSyncTimestamp(state.lastSyncAtMs);
      accountSubtitleEl.textContent = `Google Drive AppData \u00b7 ${syncMeta}`;
    }

    // 2. Header Status Pill (Synced emerald / Action Needed amber / Bound emerald / Unbound slate)
    const fullStatusDetail = state.lastSyncSummary?.trim() || formatSyncTimestamp(state.lastSyncAtMs);
    headerStatusPill.title = fullStatusDetail;
    if (persistedErr.length > 0) {
      headerStatusPill.dataset.tone = 'warn';
      headerStatusPill.textContent = 'Action Needed';
    } else if (state.lastSyncAtMs && state.lastSyncAtMs > 0) {
      headerStatusPill.dataset.tone = 'ok';
      headerStatusPill.textContent = 'Synced';
    } else if (activeProvider === 'googleDrive' && isBound) {
      headerStatusPill.dataset.tone = 'ok';
      headerStatusPill.textContent = 'Bound';
    } else if (activeProvider !== 'googleDrive') {
      headerStatusPill.dataset.tone = 'neutral';
      headerStatusPill.textContent = 'Configured';
    } else {
      headerStatusPill.dataset.tone = 'neutral';
      headerStatusPill.textContent = 'Unbound';
    }

    // 3. SINGLE Unified Callout (never duplicated!)
    // Priority: active transient message (unless it's an AppData permission message, which gets the rich permission callout) -> persisted lastSyncError.
    const candidateProblem =
      transientTone === 'warn' || transientTone === 'danger'
        ? transientMessage
        : transientTone === 'none'
          ? persistedErr
          : '';

    if (activeProvider === 'googleDrive' && isGoogleAppDataPermissionIssue(candidateProblem)) {
      unifiedCallout.hidden = false;
      unifiedCallout.dataset.tone = 'warn';
      calloutIconWrap.replaceChildren(jalaSvgIcon('alert', doc, 16));
      calloutTitle.hidden = false;
      calloutTitle.textContent = 'Google Drive AppData permission required';
      calloutText.textContent =
        'In your browser, tick "See, create, and delete its own configuration data in your Google Drive" and click Continue.';
      grantAccessSyncBtn.hidden = false;
      return;
    }

    grantAccessSyncBtn.hidden = true;

    if (transientTone !== 'none' && transientMessage.length > 0) {
      unifiedCallout.hidden = false;
      unifiedCallout.dataset.tone = transientTone;
      const iconName: JalaStudioIconName =
        transientTone === 'ok' ? 'check' : transientTone === 'warn' ? 'sync' : 'alert';
      calloutIconWrap.replaceChildren(jalaSvgIcon(iconName, doc, 16));
      calloutTitle.hidden = true;
      calloutTitle.textContent = '';
      calloutText.textContent = transientMessage;
      return;
    }

    if (persistedErr.length > 0 && (activeProvider === state.provider || activeProvider === 'googleDrive')) {
      unifiedCallout.hidden = false;
      unifiedCallout.dataset.tone = 'warn';
      calloutIconWrap.replaceChildren(jalaSvgIcon('alert', doc, 16));
      calloutTitle.hidden = false;
      calloutTitle.textContent = 'Sync attention needed';
      calloutText.textContent = persistedErr;
      return;
    }

    unifiedCallout.hidden = true;
    delete unifiedCallout.dataset.tone;
    calloutTitle.hidden = true;
    calloutTitle.textContent = '';
    calloutText.textContent = '';
  }

  function applyStateToInputs(incoming: Partial<CloudSyncUiState>): void {
    state = defaultCloudSyncUiState({ ...state, ...incoming });
    providerBar.setValue(state.provider, true);
    autoSyncToggle.setChecked(state.autoSync, true);
    oauthClientIdInput.value = state.oauthClientId;
    oauthClientSecretInput.value = state.oauthClientSecret;
    if (state.oauthClientId.trim().length > 0) {
      enterpriseDisclosure.details.open = true;
    }
    customPassToggle.setChecked(state.useCustomPassphrase, true);
    syncPassphraseInput.value = state.syncPassphrase;
    sftpHostInput.value = state.sftpHost;
    sftpPortInput.value = String(state.sftpPort || 22);
    sftpUserInput.value = state.sftpUsername;
    sftpPassInput.value = state.sftpPassword;
    sftpKeyPathInput.value = state.sftpPrivateKeyPath;
    sftpRemotePathInput.value = state.sftpRemotePath || '.jaladesk/vault-sync.jdesk';
    webdavUrlInput.value = state.webdavUrl;
    webdavUserInput.value = state.webdavUsername;
    webdavPassInput.value = state.webdavPassword;
    githubTokenInput.value = state.githubToken;
    githubGistIdInput.value = state.githubGistId;
    githubFilenameInput.value = state.githubFilename || 'jaladesk_vault_sync.jdesk';
    updateProviderVisibility();
    renderStatusAndCallout();
  }

  function setBusyState(nextBusy: boolean): void {
    busy = nextBusy;
    providerBar.setDisabled(nextBusy);
    jvaultModeBar.setDisabled(nextBusy);
    autoSyncToggle.setDisabled(nextBusy);
    customPassToggle.setDisabled(nextBusy);
    signInGoogleBtn.disabled = nextBusy;
    reconnectGoogleBtn.disabled = nextBusy;
    unbindGoogleBtn.disabled = nextBusy;
    grantAccessSyncBtn.disabled = nextBusy;
    pullBtn.disabled = nextBusy;
    forcePushBtn.disabled = nextBusy;
    smartMergeBtn.disabled = nextBusy;
    exportJvaultBtn.disabled = nextBusy;
    importJvaultBtn.disabled = nextBusy;
  }

  function validateSyncInputs(): string | null {
    const draft = collectDraft();
    const provider = draft.provider ?? 'googleDrive';
    if (provider === 'googleDrive') {
      if (!state.isBound) {
        return 'Click Sign in with Google first to connect your Google Drive account.';
      }
      if (draft.useCustomPassphrase && (draft.syncPassphrase?.trim().length ?? 0) < 4) {
        return 'Custom E2EE Passphrase must be at least 4 characters.';
      }
      return null;
    }
    if ((draft.syncPassphrase?.trim().length ?? 0) < 4) {
      return 'E2EE Vault Passphrase must be at least 4 characters.';
    }
    if (provider === 'sftp' && (!draft.sftpHost || !draft.sftpUsername)) {
      return 'Enter both the SFTP Host and Username before syncing.';
    }
    if (provider === 'webdav' && !draft.webdavUrl) {
      return 'Enter the WebDAV HTTPS endpoint URL before syncing.';
    }
    if (provider === 'githubGist' && !draft.githubToken) {
      return 'Enter a GitHub Personal Access Token with gist scope before syncing.';
    }
    return null;
  }

  async function triggerGoogleSignIn(): Promise<void> {
    if (busy) return;
    const draft = collectDraft();
    if (draft.useCustomPassphrase && (draft.syncPassphrase?.trim().length ?? 0) < 4) {
      setFeedback('danger', 'Custom E2EE Passphrase must be at least 4 characters.');
      syncPassphraseInput.focus();
      return;
    }
    setBusyState(true);
    setFeedback('warn', 'Opening Google Sign-In in your default browser...');
    try {
      await bridge.saveDraft(draft);
      const res = await bridge.signInGoogle({
        oauthClientId: draft.oauthClientId ?? '',
        oauthClientSecret: draft.oauthClientSecret ?? '',
        useCustomPassphrase: Boolean(draft.useCustomPassphrase),
        syncPassphrase: draft.syncPassphrase ?? '',
        autoSync: Boolean(draft.autoSync),
      });
      if (res.state) {
        applyStateToInputs(res.state);
      } else {
        await refresh();
      }
      if (res.ok && !res.error && !state.lastSyncError) {
        setFeedback(
          'ok',
          res.message ||
            `Connected to ${state.googleAccountEmail || 'Google Drive'} and synchronized.`,
        );
        await bridge.onSyncApplied?.(res);
      } else if (res.ok) {
        setFeedback(
          'warn',
          res.error || state.lastSyncError || res.message || 'Action needed to finish Google Drive sync.',
        );
      } else {
        setFeedback(
          state.isBound ? 'warn' : 'danger',
          res.error || state.lastSyncError || res.message || 'Google sign-in or initial sync reported an issue.',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback('danger', `Google sign-in failed: ${msg}`);
    } finally {
      setBusyState(false);
    }
  }

  signInGoogleBtn.onclick = () => {
    void triggerGoogleSignIn();
  };

  reconnectGoogleBtn.onclick = () => {
    void triggerGoogleSignIn();
  };

  grantAccessSyncBtn.onclick = () => {
    if (state.isBound) {
      void runSyncAction('smartMerge', 'Smart Merge Sync');
    } else {
      void triggerGoogleSignIn();
    }
  };

  unbindGoogleBtn.onclick = async () => {
    if (busy) return;
    setBusyState(true);
    try {
      const res = await bridge.signOutUnbind();
      if (res.state) {
        applyStateToInputs(res.state);
      } else {
        state.isBound = false;
        state.googleAccountEmail = '';
        state.lastSyncError = null;
        renderStatusAndCallout();
      }
      setFeedback('ok', res.message || 'Google Drive account disconnected on this desktop.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback('danger', `Could not disconnect account: ${msg}`);
    } finally {
      setBusyState(false);
    }
  };

  async function runSyncAction(mode: CloudSyncMode, actionTitle: string): Promise<void> {
    if (busy) return;
    const validationErr = validateSyncInputs();
    if (validationErr) {
      setFeedback('danger', validationErr);
      return;
    }
    const draft = collectDraft();
    setBusyState(true);
    setFeedback('warn', `Running ${actionTitle}...`);
    try {
      const res = await bridge.executeSync(mode, draft);
      if (res.state) {
        applyStateToInputs(res.state);
      } else {
        await refresh();
      }
      if (res.ok) {
        setFeedback('ok', res.message || `${actionTitle} completed.`);
        await bridge.onSyncApplied?.(res);
      } else {
        setFeedback('danger', res.error || res.message || `${actionTitle} failed.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback('danger', `${actionTitle} failed: ${msg}`);
    } finally {
      setBusyState(false);
    }
  }

  smartMergeBtn.onclick = () => {
    void runSyncAction('smartMerge', 'Smart Merge Sync');
  };

  forcePushBtn.onclick = () => {
    void runSyncAction('pushForce', 'Force Push Overwrite');
  };

  pullBtn.onclick = () => {
    void runSyncAction('pullOnly', 'Pull Remote Vault');
  };

  exportJvaultBtn.onclick = async () => {
    if (busy) return;
    const pass = jvaultPassInput.value.trim();
    if (pass.length < 4) {
      jvaultDisclosure.details.open = true;
      setFeedback('danger', 'Enter an Archive Passphrase of at least 4 characters to export .jvault.');
      jvaultPassInput.focus();
      return;
    }
    setBusyState(true);
    try {
      const res = await bridge.exportJvault(pass);
      if (res.cancelled) {
        setFeedback('none');
      } else if (res.ok) {
        setFeedback(
          'ok',
          res.message || (res.filePath ? `Exported encrypted backup to ${res.filePath}` : 'Exported .jvault archive.'),
        );
      } else {
        setFeedback('danger', res.error || res.message || 'Export .jvault failed.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback('danger', `Export .jvault failed: ${msg}`);
    } finally {
      setBusyState(false);
    }
  };

  importJvaultBtn.onclick = async () => {
    if (busy) return;
    const pass = jvaultPassInput.value.trim();
    if (pass.length < 4) {
      jvaultDisclosure.details.open = true;
      setFeedback('danger', 'Enter the .jvault archive passphrase (at least 4 characters) before importing.');
      jvaultPassInput.focus();
      return;
    }
    setBusyState(true);
    try {
      const res = await bridge.importJvault(pass, jvaultModeBar.getValue());
      if (res.cancelled) {
        setFeedback('none');
      } else if (res.ok) {
        setFeedback('ok', res.message || 'Imported .jvault archive cleanly.');
        await bridge.onSyncApplied?.(res);
      } else {
        setFeedback('danger', res.error || res.message || 'Import .jvault failed. Check your passphrase.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback('danger', `Import .jvault failed: ${msg}`);
    } finally {
      setBusyState(false);
    }
  };

  async function flushDraftAndClose(): Promise<void> {
    if (closingFlushed) return;
    closingFlushed = true;
    try {
      const draft = collectDraft();
      const saved = await bridge.saveDraft(draft);
      if (saved) applyStateToInputs(saved);
    } catch {
      // Never block closing or unbind on draft flush error
    } finally {
      if (dialog.open) dialog.close();
      lastTrigger?.focus();
      closingFlushed = false;
    }
  }

  closeFooterBtn.onclick = () => {
    void flushDraftAndClose();
  };

  headerCloseBtn.onclick = () => {
    void flushDraftAndClose();
  };

  dialog.oncancel = (ev) => {
    ev.preventDefault();
    if (!busy) {
      void flushDraftAndClose();
    }
  };

  async function refresh(): Promise<void> {
    const fetched = await bridge.getState();
    applyStateToInputs(fetched);
  }

  return {
    dialog,
    open: async (triggerEl?: HTMLElement | null) => {
      lastTrigger = triggerEl ?? null;
      transientTone = 'none';
      transientMessage = '';
      await refresh();
      if (!dialog.open) dialog.showModal();
    },
    close: flushDraftAndClose,
    refresh,
    getDraft: collectDraft,
  };
}
