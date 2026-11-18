// Pure-English Built-In Interactive User Guide ("JalaDesk Guide") for JalaDesk Desktop.
// Strictly 100% English (zero Indonesian strings, zero language switcher, zero eyebrow kickers, zero 01/02 numbering).
// Built with DOM createElement / createElementNS only (CSP style-src 'self' safe).

import {
  jalaSvgIcon,
  type JalaStudioIconName,
} from './cloud-sync-ui.js';

export type GuideTopicId =
  | 'protocols'
  | 'jumphost'
  | 'display_sizing'
  | 'ssh_sftp_forwarding'
  | 'vault_pin_2fa'
  | 'cloud_sync_oauth'
  | 'jvault_troubleshooting';

export interface GuidePillSpec {
  readonly codeOrKey: string;
  readonly detail: string;
  readonly mono?: boolean;
}

export interface GuideBulletSpec {
  readonly heading: string;
  readonly body: string;
}

export interface GuideTopicSpec {
  readonly id: GuideTopicId;
  readonly filterLabel: string;
  readonly icon: JalaStudioIconName;
  readonly accentTone: 'blue' | 'gold' | 'green' | 'purple' | 'teal';
  readonly title: string;
  readonly summary: string;
  readonly pills: readonly GuidePillSpec[];
  readonly bullets: readonly GuideBulletSpec[];
}

export const JALADESK_GUIDE_TOPICS: readonly GuideTopicSpec[] = [
  {
    id: 'protocols',
    filterLabel: 'Protocols',
    icon: 'server',
    accentTone: 'blue',
    title: 'Quick Start & Multi-Protocol Workspace',
    summary:
      'Connect to Windows, macOS, Linux, and virtualization clusters from one encrypted desktop workspace.',
    pills: [
      { codeOrKey: 'RDP :3389', detail: 'FreeRDP NLA & Dynamic Display', mono: true },
      { codeOrKey: 'VNC :5900', detail: 'macOS Screen Sharing & RFB 3.8', mono: true },
      { codeOrKey: 'SSH :22', detail: 'Interactive PTY Shell', mono: true },
      { codeOrKey: 'SFTP :22', detail: 'Side-by-Side File Explorer', mono: true },
      { codeOrKey: 'Hypervisor :8006', detail: 'Proxmox VE & ESXi Nodes', mono: true },
    ],
    bullets: [
      {
        heading: 'Single-Row Protocol Creation & Quick Connect',
        body:
          'Create a saved host from the sidebar + menu or launch an ad-hoc session from the top Quick Connect bar. Selecting RDP, VNC, SSH, SFTP, or Hypervisor pre-fills standard ports automatically.',
      },
      {
        heading: 'Pinned Favorites, Folders & Live Reachability',
        body:
          'Group infrastructure into environment folders, assign semantic color marks, pin critical production hosts as Favorites, and inspect live TCP reachability badges before connecting.',
      },
      {
        heading: 'Multi-Tab Split Stage & Command Palette',
        body:
          'Keep multiple remote desktops and SSH terminals open simultaneously, tile sessions in 2x1 or 2x2 split view, and jump between hosts with keyboard shortcuts.',
      },
    ],
  },
  {
    id: 'jumphost',
    filterLabel: 'Jump Host',
    icon: 'route',
    accentTone: 'gold',
    title: 'Jump Host Bastion & Per-Connection vs Folder Routing',
    summary:
      'Reach isolated private VPC subnets through SSH ProxyJump bastions without external VPN daemons.',
    pills: [
      { codeOrKey: 'Per-Connection Bastion', detail: 'Routes even in unconfigured folders' },
      { codeOrKey: 'Folder Inheritance', detail: 'Automatic folder-wide relay' },
      { codeOrKey: 'Direct Override', detail: 'Bypass parent folder bastion' },
    ],
    bullets: [
      {
        heading: 'Per-Connection Jump Host Precedence',
        body:
          'Assigning a Jump Host directly on a connection routes that RDP, VNC, SSH, or SFTP session through the bastion even when its parent folder has no Jump Host configured.',
      },
      {
        heading: 'Folder-Wide Default Routing & Direct Override',
        body:
          'Configure a default Jump Host on an environment folder so child connections inherit the tunnel automatically, while individual public hosts can explicitly choose Direct connection.',
      },
      {
        heading: 'Reusable Credentials & Multi-Hop Chains',
        body:
          'Authenticate bastions with Ed25519 or RSA private keys, passwords, or linked Vault Credentials, and chain multiple SSH hops safely with built-in loop detection.',
      },
    ],
  },
  {
    id: 'display_sizing',
    filterLabel: 'Display Sizing',
    icon: 'desktop',
    accentTone: 'green',
    title: 'Proportional RDP & VNC Display Sizing',
    summary:
      'Crisp remote desktop rendering across ultrawide, Retina, and split-pane windows with zero aspect-ratio stretching.',
    pills: [
      { codeOrKey: 'Auto Match', detail: 'Dynamic FreeRDP DVC resize' },
      { codeOrKey: 'Fit', detail: 'Proportional letterbox frame' },
      { codeOrKey: 'Fill', detail: 'Aspect-preserving cover & pan' },
      { codeOrKey: '1:1', detail: 'Native server pixel mapping' },
    ],
    bullets: [
      {
        heading: 'Distortion-Free Fit & Fill Geometry',
        body:
          'Fit scales the entire remote desktop proportionally inside the viewport with centered letterboxing or pillarboxing, while Fill covers the viewport without ever stretching 16:9 or 4:3 frames.',
      },
      {
        heading: 'Auto Match & Native 1:1 Pixel Mode',
        body:
          'Auto Match dynamically negotiates remote Windows resolution updates via FreeRDP DisplayControl DVC as you resize the window, whereas 1:1 renders exact unscaled server pixels with scrollbars.',
      },
      {
        heading: 'Extended Fullscreen & Remote Modifiers',
        body:
          'Toggle Extended View to hide workspace chrome for edge-to-edge immersion, and send special key chords such as Ctrl+Alt+Del directly to the remote OS.',
      },
    ],
  },
  {
    id: 'ssh_sftp_forwarding',
    filterLabel: 'SSH & SFTP',
    icon: 'terminal',
    accentTone: 'purple',
    title: 'Interactive SSH, SFTP & Local Port Forwarding',
    summary:
      'Low-latency PTY terminal sessions paired with live SFTP file browsing and loopback TCP tunnels.',
    pills: [
      { codeOrKey: 'ssh -L', detail: 'Local loopback TCP tunnel', mono: true },
      { codeOrKey: '127.0.0.1:<port>', detail: 'Private DB & K8s relay', mono: true },
      { codeOrKey: 'SFTP Drawer', detail: 'Browse, upload & inspect paths' },
    ],
    bullets: [
      {
        heading: 'Unified SSH PTY Shell & Side-by-Side SFTP',
        body:
          'Open an interactive terminal with customizable color themes and font sizes, and toggle the integrated SFTP drawer to navigate remote directories and inspect file metadata.',
      },
      {
        heading: 'Local Port Forwarding (ssh -L)',
        body:
          'Launch a local port forward from a connection context menu or SSH studio bar to bind 127.0.0.1:<localPort> through the SSH server to an internal database, Redis node, or Kubernetes API.',
      },
      {
        heading: 'Reusable Command Snippets & Host Key Safety',
        body:
          'Execute frequent operational diagnostics in one click from the snippets bar while SSH host key verification protects against man-in-the-middle interception.',
      },
    ],
  },
  {
    id: 'vault_pin_2fa',
    filterLabel: 'Vault & 2FA',
    icon: 'shield',
    accentTone: 'gold',
    title: 'Security Vault, Full-Screen PIN & RFC 6238 2FA Authenticator',
    summary:
      'Zero-trust workspace screen locking and built-in TOTP code generation with active-session Auto-Type.',
    pills: [
      { codeOrKey: '4-8 Digit PIN', detail: 'Instant final-digit unlock' },
      { codeOrKey: 'SHA1 / SHA256 / SHA512', detail: '6 or 8 digits, 30s or 60s', mono: true },
      { codeOrKey: 'otpauth://', detail: '1-step URI import', mono: true },
    ],
    bullets: [
      {
        heading: 'Full-Screen Obsidian App Lock PIN & Auto-Lock',
        body:
          'Configure a 4 to 8 digit PBKDF2-HMAC-SHA256 PIN with Immediate, 1m, 5m, 15m, or Off inactivity auto-lock. Typing the final digit on the keypad or keyboard unlocks immediately without pressing Enter.',
      },
      {
        heading: 'RFC 6238 2FA Authenticator Studio',
        body:
          'Generate live 6-digit or 8-digit TOTP codes using SHA1, SHA256, or SHA512 over 30s or 60s windows. Add Base32 secrets manually or paste standard otpauth://totp/ provisioning URIs.',
      },
      {
        heading: '1-Click Copy & Auto-Type',
        body:
          'Copy formatted codes in one click or click Auto-Type to stream the live OTP directly into an open RDP, VNC, or SSH login prompt.',
      },
    ],
  },
  {
    id: 'cloud_sync_oauth',
    filterLabel: 'Cloud Sync',
    icon: 'cloud',
    accentTone: 'green',
    title: '1-Click Cross-Device Cloud Sync (Mobile & Desktop)',
    summary:
      'Synchronize connections, folders, gateways, credentials, and 2FA tokens seamlessly across JalaDesk Mobile and Desktop.',
    pills: [
      { codeOrKey: 'Google Drive', detail: 'Private AppData folder' },
      { codeOrKey: 'Private SFTP', detail: '.jaladesk/vault-sync.jdesk', mono: true },
      { codeOrKey: 'WebDAV', detail: 'Nextcloud & HTTPS DAV' },
      { codeOrKey: 'GitHub Gist', detail: 'Secret Gist API' },
    ],
    bullets: [
      {
        heading: 'Instant 1-Click Sign in with Google & Scope Upgrade',
        body:
          'Open Cloud Sync and click Sign in with Google to authenticate in your browser and sync immediately. If Google Drive AppData permission was left unchecked during consent, click Grant Access & Sync to approve the scope and complete synchronization in one step.',
      },
      {
        heading: 'Zero-Knowledge Account-Bound Key vs Custom Passphrase',
        body:
          'By default, Google Drive sync derives an automatic account-bound PBKDF2-HMAC-SHA256 + AES-256-GCM key matching JalaDesk Mobile with zero extra passphrase. Enable the Custom E2EE Passphrase switch when you want a separate secret, or use a passphrase for SFTP, WebDAV, and GitHub Gist.',
      },
      {
        heading: 'Smart Merge, Force Push & Pull',
        body:
          'Smart Merge reconciles per-object timestamps and deletion tombstones across Desktop and Mobile automatically, while Force Push and Pull give you explicit directional control.',
      },
    ],
  },
  {
    id: 'jvault_troubleshooting',
    filterLabel: 'Backup & Help',
    icon: 'archive',
    accentTone: 'teal',
    title: '.jvault Encrypted Backup & Troubleshooting',
    summary:
      'Create air-gapped vault snapshots and resolve common authentication, NLA, or cloud API errors quickly.',
    pills: [
      { codeOrKey: '.jvault', detail: 'Portable AES-256-GCM archive', mono: true },
      { codeOrKey: 'Smart Merge', detail: 'Non-destructive restore' },
      { codeOrKey: 'DOMAIN\\user', detail: 'Windows RDP NLA format', mono: true },
    ],
    bullets: [
      {
        heading: 'Portable .jvault Backup Archive',
        body:
          'Expand Portable .jvault Backup Archive inside Cloud Sync to export passphrase-sealed .jvault snapshots for offline backup, or restore them using Smart Merge or Replace Local.',
      },
      {
        heading: 'Resilient Account Binding on Cloud API Warnings',
        body:
          'If a network interruption or Google Drive AppData permission check (HTTP 403) occurs after sign-in, your Google account remains safely bound on Desktop so Smart Merge Sync can recover without re-entering credentials.',
      },
      {
        heading: 'RDP NLA Login & Bastion Connectivity Checks',
        body:
          'When Windows NLA declines credentials, verify DOMAIN\\username or user@domain UPN syntax and clock sync. If a private target times out, verify its assigned Jump Host is reachable on TCP port 22.',
      },
    ],
  },
];

export function topicMatchesQuery(topic: GuideTopicSpec, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const parts: string[] = [
    topic.filterLabel,
    topic.title,
    topic.summary,
  ];
  for (const p of topic.pills) {
    parts.push(p.codeOrKey, p.detail);
  }
  for (const b of topic.bullets) {
    parts.push(b.heading, b.body);
  }
  return parts.join(' ').toLowerCase().includes(q);
}

export interface UserGuidePanelOptions {
  initialTopic?: GuideTopicId | 'all';
  initialQuery?: string;
  onClose?: () => void;
  doc?: Document;
}

export interface UserGuidePanelController {
  readonly root: HTMLElement;
  setSearchQuery: (query: string) => void;
  setCategory: (category: GuideTopicId | 'all') => void;
  focusSearch: () => void;
}

export interface UserGuideModalController {
  readonly dialog: HTMLDialogElement;
  readonly panel: UserGuidePanelController;
  open: (triggerEl?: HTMLElement | null, initialTopic?: GuideTopicId | 'all') => void;
  close: () => void;
}

export function createUserGuidePanel(
  options: UserGuidePanelOptions = {},
): UserGuidePanelController {
  const doc = options.doc ?? document;
  let activeCategory: GuideTopicId | 'all' = options.initialTopic ?? 'all';
  let searchQuery = options.initialQuery ?? '';

  const root = doc.createElement('div');
  root.className = 'jala-guide-shell';

  // ---- Header ----
  const header = doc.createElement('div');
  header.className = 'jala-studio-header jala-guide-header';

  const headerLead = doc.createElement('div');
  headerLead.className = 'jala-studio-header-lead';

  const iconBadge = doc.createElement('div');
  iconBadge.className = 'jala-studio-icon-badge';
  iconBadge.dataset.tone = 'teal';
  iconBadge.append(jalaSvgIcon('book', doc, 18));

  const titleGroup = doc.createElement('div');
  titleGroup.className = 'jala-studio-title-group';

  const titleEl = doc.createElement('h2');
  titleEl.id = 'jala-user-guide-title';
  titleEl.className = 'jala-studio-title';
  titleEl.textContent = 'JalaDesk Guide';

  const subtitleEl = doc.createElement('p');
  subtitleEl.className = 'jala-studio-subtitle';
  subtitleEl.textContent =
    'Protocols, Jump Host bastions, proportional display sizing, 2FA vault & zero-knowledge Cloud Sync';

  titleGroup.append(titleEl, subtitleEl);
  headerLead.append(iconBadge, titleGroup);

  const headerActions = doc.createElement('div');
  headerActions.className = 'jala-studio-header-actions';

  const matchCountPill = doc.createElement('span');
  matchCountPill.id = 'jala-guide-count-pill';
  matchCountPill.className = 'jala-status-pill';
  matchCountPill.dataset.tone = 'neutral';

  headerActions.append(matchCountPill);

  if (options.onClose) {
    const closeIconBtn = doc.createElement('button');
    closeIconBtn.type = 'button';
    closeIconBtn.className = 'jala-icon-close-btn quiet';
    closeIconBtn.setAttribute('aria-label', 'Close JalaDesk Guide');
    closeIconBtn.append(jalaSvgIcon('close', doc, 15));
    closeIconBtn.onclick = () => options.onClose?.();
    headerActions.append(closeIconBtn);
  }

  header.append(headerLead, headerActions);

  // ---- Search + Editorial Category Filter Bar ----
  const filterStrip = doc.createElement('div');
  filterStrip.className = 'jala-guide-filter-strip';

  const searchRow = doc.createElement('div');
  searchRow.className = 'jala-guide-search-row';

  const searchFieldWrap = doc.createElement('div');
  searchFieldWrap.className = 'jala-search-field';

  const searchIconHolder = doc.createElement('span');
  searchIconHolder.className = 'jala-search-field-icon';
  searchIconHolder.append(jalaSvgIcon('search', doc, 14));

  const searchInput = doc.createElement('input');
  searchInput.id = 'jala-guide-search-input';
  searchInput.type = 'search';
  searchInput.className = 'jala-input jala-search-field-input';
  searchInput.placeholder =
    'Search guide topics (Jump Host, Fit, ssh -L, Google Drive, otpauth, .jvault)...';
  searchInput.value = searchQuery;
  searchInput.setAttribute('aria-label', 'Search JalaDesk Guide');

  searchFieldWrap.append(searchIconHolder, searchInput);

  const clearSearchBtn = doc.createElement('button');
  clearSearchBtn.id = 'jala-guide-search-clear';
  clearSearchBtn.type = 'button';
  clearSearchBtn.className = 'jala-btn jala-btn-compact quiet';
  clearSearchBtn.textContent = 'Clear';
  clearSearchBtn.hidden = searchQuery.trim().length === 0;

  searchRow.append(searchFieldWrap, clearSearchBtn);

  const categoryBar = doc.createElement('div');
  categoryBar.className = 'jala-guide-category-bar';
  categoryBar.setAttribute('role', 'tablist');
  categoryBar.setAttribute('aria-label', 'Guide Topic Categories');

  const categoryButtons = new Map<GuideTopicId | 'all', HTMLButtonElement>();

  function addCategoryChip(id: GuideTopicId | 'all', label: string, icon: JalaStudioIconName): void {
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'jala-guide-cat-chip';
    chip.setAttribute('role', 'tab');
    chip.dataset.category = id;
    chip.append(jalaSvgIcon(icon, doc, 13));
    const text = doc.createElement('span');
    text.textContent = label;
    chip.append(text);
    chip.onclick = () => {
      activeCategory = id;
      renderGuide();
    };
    categoryButtons.set(id, chip);
    categoryBar.append(chip);
  }

  addCategoryChip('all', 'All Topics', 'book');
  for (const topic of JALADESK_GUIDE_TOPICS) {
    addCategoryChip(topic.id, topic.filterLabel, topic.icon);
  }

  filterStrip.append(searchRow, categoryBar);

  // ---- Scrollable 2-Column Editorial Grid ----
  const body = doc.createElement('div');
  body.className = 'jala-studio-body jala-guide-body';

  const grid = doc.createElement('div');
  grid.id = 'jala-guide-grid';
  grid.className = 'jala-guide-grid';

  body.append(grid);

  // ---- Separated Footer ----
  const footer = doc.createElement('div');
  footer.className = 'jala-studio-footer';

  const footerNote = doc.createElement('span');
  footerNote.className = 'jala-footer-note';
  footerNote.textContent =
    'All encryption keys, SSH credentials, and TOTP secrets remain encrypted locally on your device.';

  const footerRight = doc.createElement('div');
  footerRight.className = 'jala-studio-footer-right';

  if (options.onClose) {
    const closeBtn = doc.createElement('button');
    closeBtn.id = 'jala-guide-close-btn';
    closeBtn.type = 'button';
    closeBtn.className = 'jala-btn jala-btn-primary';
    closeBtn.textContent = 'Done';
    closeBtn.onclick = () => options.onClose?.();
    footerRight.append(closeBtn);
  }

  footer.append(footerNote, footerRight);
  root.append(header, filterStrip, body, footer);

  function buildTopicCard(topic: GuideTopicSpec): HTMLElement {
    const card = doc.createElement('article');
    card.className = 'jala-guide-card';
    card.dataset.topicId = topic.id;
    card.dataset.accent = topic.accentTone;

    const cardHead = doc.createElement('div');
    cardHead.className = 'jala-guide-card-header';

    const cardIcon = doc.createElement('div');
    cardIcon.className = 'jala-studio-icon-badge jala-guide-topic-badge';
    cardIcon.dataset.tone = topic.accentTone;
    cardIcon.append(jalaSvgIcon(topic.icon, doc, 16));

    const headText = doc.createElement('div');
    headText.className = 'jala-guide-head-copy';

    const cardTitle = doc.createElement('h3');
    cardTitle.className = 'jala-guide-card-title';
    cardTitle.textContent = topic.title;

    const summaryP = doc.createElement('p');
    summaryP.className = 'jala-guide-card-summary';
    summaryP.textContent = topic.summary;

    headText.append(cardTitle, summaryP);
    cardHead.append(cardIcon, headText);

    const cardBody = doc.createElement('div');
    cardBody.className = 'jala-guide-card-body';

    if (topic.pills.length > 0) {
      const pillRow = doc.createElement('div');
      pillRow.className = 'jala-guide-pills';
      for (const pill of topic.pills) {
        const pillEl = doc.createElement('div');
        pillEl.className = 'jala-guide-pill';

        const keySpan = doc.createElement('kbd');
        keySpan.className = pill.mono ? 'jala-kbd jala-mono' : 'jala-kbd';
        keySpan.textContent = pill.codeOrKey;

        const detailSpan = doc.createElement('span');
        detailSpan.className = 'jala-guide-pill-detail';
        detailSpan.textContent = pill.detail;

        pillEl.append(keySpan, detailSpan);
        pillRow.append(pillEl);
      }
      cardBody.append(pillRow);
    }

    const bulletList = doc.createElement('ul');
    bulletList.className = 'jala-guide-bullets';
    for (const bullet of topic.bullets) {
      const li = doc.createElement('li');
      li.className = 'jala-guide-bullet';

      const bTitle = doc.createElement('strong');
      bTitle.className = 'jala-guide-bullet-title';
      bTitle.textContent = bullet.heading;

      const bText = doc.createElement('p');
      bText.className = 'jala-guide-bullet-text';
      bText.textContent = bullet.body;

      li.append(bTitle, bText);
      bulletList.append(li);
    }

    cardBody.append(bulletList);
    card.append(cardHead, cardBody);
    return card;
  }

  function renderGuide(): void {
    clearSearchBtn.hidden = searchQuery.trim().length === 0;
    for (const [catId, btn] of categoryButtons) {
      const selected = catId === activeCategory;
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    }

    const visible = JALADESK_GUIDE_TOPICS.filter((topic) => {
      if (activeCategory !== 'all' && topic.id !== activeCategory) return false;
      return topicMatchesQuery(topic, searchQuery);
    });

    matchCountPill.textContent = `${visible.length} of ${JALADESK_GUIDE_TOPICS.length} topics`;

    if (visible.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'jala-empty-state';
      const title = doc.createElement('strong');
      title.textContent = `No guide topics matched "${searchQuery.trim()}"`;
      const hint = doc.createElement('p');
      hint.textContent = 'Try searching for RDP, VNC, Jump Host, Fit, ssh -L, 2FA, Google Drive, or .jvault.';
      empty.append(title, hint);
      grid.replaceChildren(empty);
      return;
    }

    grid.replaceChildren(...visible.map((t) => buildTopicCard(t)));
  }

  searchInput.oninput = () => {
    searchQuery = searchInput.value;
    renderGuide();
  };

  clearSearchBtn.onclick = () => {
    searchInput.value = '';
    searchQuery = '';
    renderGuide();
    searchInput.focus();
  };

  renderGuide();

  return {
    root,
    setSearchQuery: (query: string) => {
      searchQuery = query;
      searchInput.value = query;
      renderGuide();
    },
    setCategory: (category: GuideTopicId | 'all') => {
      activeCategory = category;
      renderGuide();
    },
    focusSearch: () => {
      searchInput.focus();
    },
  };
}

export function createUserGuideModal(
  doc: Document = document,
): UserGuideModalController {
  let lastTrigger: HTMLElement | null = null;

  const dialog = doc.createElement('dialog');
  dialog.id = 'jala-user-guide-dialog';
  dialog.className = 'jala-studio-dialog jala-user-guide-dialog';
  dialog.setAttribute('aria-labelledby', 'jala-user-guide-title');

  const closeModal = (): void => {
    if (dialog.open) dialog.close();
    lastTrigger?.focus();
  };

  const panel = createUserGuidePanel({
    doc,
    onClose: closeModal,
  });

  dialog.append(panel.root);

  return {
    dialog,
    panel,
    open: (triggerEl?: HTMLElement | null, initialTopic?: GuideTopicId | 'all') => {
      lastTrigger = triggerEl ?? null;
      if (initialTopic) panel.setCategory(initialTopic);
      if (!dialog.open) dialog.showModal();
      panel.focusSearch();
    },
    close: closeModal,
  };
}
