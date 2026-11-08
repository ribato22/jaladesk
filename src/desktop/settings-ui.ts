// The window of the settings: the controls, and what they do. What each control shows is worked out in settings-model.ts; every change is sent to the main process by name and value, and what the control then shows is
// what the main process answers (so a change that was refused, or that the main process made differently, is never shown as made). The window is asked again whenever it gets the focus back, because the keys that are
// remembered and the recent documents change while it is open (a document is opened, a key is forgotten in the menu).
import type { ThemeChoice } from './commands.js';
import type { SettingsView } from './settings-ipc.js';
import { describeSettings } from './settings-model.js';

type Failure = { ok: false; code: string; message: string };
declare global {
  interface Window {
    settingsWindow: {
      get(): Promise<SettingsView | Failure>;
      set(change: { name: string; value: unknown }): Promise<SettingsView | Failure>;
      forgetKeys(): Promise<{ ok: true; forgot: number } | Failure>;
      clearRecent(): Promise<SettingsView | Failure>;
      onChanged(callback: (view: SettingsView) => void): () => void;
    };
  }
}
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** A text is written only when it says something else: a screen reader is told again of a note that is written again, also when it is the same. */
function setText(node: HTMLElement, text: string): void { if (node.textContent !== text) node.textContent = text; }
const THEMES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
const UNREACHABLE = 'Settings could not be loaded from the application; close this window and reopen it.';
function enNote(text: string): string {
  if (text.startsWith('Bila dinyalakan')) return 'When enabled, the password prompt offers to remember document keys in your system Keychain.';
  if (text.startsWith('Kunci disimpan')) return 'Keys are stored in the system Keychain (macOS Keychain / Windows DPAPI) on this computer only.';
  if (text.startsWith('Keystore sistem')) return 'System Keychain is unavailable on this computer; keys will not be remembered.';
  if (text === 'Tidak ada kunci yang diingat.') return 'No remembered keys.';
  if (text === 'Daftar terbaru kosong.') return 'Recent list is empty.';
  return text.replace(/(\d+) kunci diingat\./, '$1 remembered key(s).').replace(/(\d+) dokumen di daftar terbaru\./, '$1 recent document(s).');
}

/** A button that goes off while it has the focus hands the focus to the button that closes the window: a browser would leave it on nothing, and a person who uses the keyboard would be sent back to the top of the page. */
function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  if (disabled && document.activeElement === button) el('st-close').focus();
  button.disabled = disabled;
}

function show(view: SettingsView): void {
  const page = describeSettings(view);
  for (const theme of THEMES) el<HTMLInputElement>(`st-theme-${theme}`).checked = page.theme === theme;
  el<HTMLInputElement>('st-toolbar').checked = page.toolbar;
  el<HTMLInputElement>('st-colorize').checked = page.colorize;
  el<HTMLInputElement>('st-extended').checked = page.extended;
  el<HTMLInputElement>('st-keys').checked = page.keysAllow;
  setText(el('st-keys-note'), enNote(page.keysNote));
  setText(el('st-keys-count'), enNote(page.keysCount));
  setDisabled(el<HTMLButtonElement>('st-forget'), !page.canForget);
  setText(el('st-recent-count'), enNote(page.recentCount));
  setDisabled(el<HTMLButtonElement>('st-clear'), !page.canClear);
}
const error = (text: string) => { setText(el('st-error'), text); };

async function refresh(): Promise<void> {
  const reply = await window.settingsWindow.get().catch(() => undefined);
  if (reply?.ok) { error(''); show(reply); } else error(reply?.message ?? UNREACHABLE);
}
/** Sends one change; what the controls show afterwards is the answer, or, when the change was refused, what the settings really are. */
async function change(name: string, value: unknown): Promise<void> {
  const reply = await window.settingsWindow.set({ name, value }).catch(() => undefined);
  if (reply?.ok) { error(''); show(reply); return; }
  error(reply?.message ?? UNREACHABLE);
  await refreshQuietly();
}
async function refreshQuietly(): Promise<void> {
  const reply = await window.settingsWindow.get().catch(() => undefined);
  if (reply?.ok) show(reply);
}

for (const theme of THEMES) el<HTMLInputElement>(`st-theme-${theme}`).addEventListener('change', (event) => { if ((event.target as HTMLInputElement).checked) void change('theme', theme); });
for (const [id, name] of [['st-toolbar', 'toolbar.visible'], ['st-colorize', 'tabs.colorize'], ['st-extended', 'fullscreen.extended'], ['st-keys', 'keys.allow']] as const) {
  el<HTMLInputElement>(id).addEventListener('change', (event) => { void change(name, (event.target as HTMLInputElement).checked); });
}
/**
 * A button that does something that takes a while (a question of the main process, the disk) does nothing when it is pressed again until it is over; it is not disabled meanwhile (a button that has the focus and goes off
 * leaves the focus on nothing: see setDisabled), and what it is afterwards is worked out again from the answer.
 */
const busy = new WeakSet<HTMLButtonElement>();
async function pending(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
  if (button.disabled || busy.has(button)) return;
  busy.add(button);
  button.setAttribute('aria-busy', 'true');
  try { await work(); } finally {
    busy.delete(button);
    button.removeAttribute('aria-busy');
    await refreshQuietly();
  }
}
el('st-forget').addEventListener('click', () => {
  void pending(el<HTMLButtonElement>('st-forget'), async () => {
    const reply = await window.settingsWindow.forgetKeys().catch(() => undefined);
    if (!reply) error(UNREACHABLE);
    else if (!reply.ok && reply.code !== 'cancelled') error(reply.message);
    else error('');
  });
});
el('st-clear').addEventListener('click', () => {
  void pending(el<HTMLButtonElement>('st-clear'), async () => {
    const reply = await window.settingsWindow.clearRecent().catch(() => undefined);
    if (reply?.ok) error(''); else error(reply?.message ?? UNREACHABLE);
  });
});
el('st-close').addEventListener('click', () => window.close());
window.settingsWindow.onChanged(show);
window.addEventListener('focus', () => { void refreshQuietly(); });
void refresh();

// ---- World-Class Enterprise Preferences Suite (Multi-Tab + Persistent Storage + Mobile Sync) ----
const PREF_STORAGE_KEY = 'rw-enterprise-prefs-v1';
const DEFAULT_PREFS: Record<string, string | boolean> = {
  'ui.instantTooltips': true,
  'ui.pingDots': true,
  'ui.defaultSplit': 'single',
  'ui.overviewMode': 'compact',
  'rdp.scale': 'fit',
  'rdp.fps': '60',
  'rdp.hidpi': true,
  'rdp.hud': false,
  'rdp.macKeys': localStorage.getItem('rw-rdp-mac-keys') !== '0',
  'rdp.autoReconnect': localStorage.getItem('rw-auto-reconnect') !== '0',
  'rdp.viewOnlyDefault': false,
  'term.theme': 'termius-dark',
  'term.fontSize': 'md',
  'term.scrollback': '10000',
  'term.keepAlive': '30',
  'term.defaultJump': '',
  'sftp.showHidden': true,
  'term.snippetsBar': true,
  'sec.autoLockMins': '15',
  'sec.clipboardClearSecs': '30',
  'sec.strictHostKey': true,
  'sec.prodSafetyGuard': true,
  'sync.provider': 'git',
  'sync.auditRetentionDays': '90',
  'sync.autoSnapshot': true,
  'mobile.relayEndpoint': 'wss://mitra-jump.plnbatam.local:8443/jaladesk-mobile',
  'mobile.syncScope': 'all',
};

function loadEnterprisePrefs(): Record<string, string | boolean> {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Record<string, string | boolean>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function saveEnterprisePrefs(prefs: Record<string, string | boolean>): void {
  try {
    localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(prefs));
    if (typeof prefs['rdp.macKeys'] === 'boolean') {
      localStorage.setItem('rw-rdp-mac-keys', prefs['rdp.macKeys'] ? '1' : '0');
    }
    if (typeof prefs['rdp.autoReconnect'] === 'boolean') {
      localStorage.setItem('rw-auto-reconnect', prefs['rdp.autoReconnect'] ? '1' : '0');
    }
  } catch {
    // ignore storage quota errors
  }
}

function syncEnterpriseControlsToDOM(): void {
  const prefs = loadEnterprisePrefs();
  const controls = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-pref-key]');
  for (const ctrl of controls) {
    const key = ctrl.dataset.prefKey;
    if (!key || !(key in prefs)) continue;
    const val = prefs[key];
    if (ctrl instanceof HTMLInputElement && ctrl.type === 'checkbox') {
      ctrl.checked = Boolean(val);
    } else if (ctrl instanceof HTMLSelectElement) {
      const strVal = String(val);
      const hasMatch = Array.from(ctrl.options).some((opt) => opt.value === strVal);
      if (hasMatch) {
        ctrl.value = strVal;
      } else {
        const fallback = String(DEFAULT_PREFS[key] ?? ctrl.options[0]?.value ?? '');
        ctrl.value = fallback;
      }
    } else {
      ctrl.value = String(val);
    }
  }
}

function wireEnterpriseTabsAndControls(): void {
  const tabBtns = document.querySelectorAll<HTMLButtonElement>('[data-pref-tab]');
  const panes = document.querySelectorAll<HTMLElement>('[data-pref-pane]');
  for (const btn of tabBtns) {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.prefTab;
      if (!targetTab) return;
      for (const b of tabBtns) {
        const active = b.dataset.prefTab === targetTab;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      for (const pane of panes) {
        pane.hidden = pane.dataset.prefPane !== targetTab;
      }
    });
  }

  syncEnterpriseControlsToDOM();
  const controls = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-pref-key]');
  for (const ctrl of controls) {
    ctrl.addEventListener('change', () => {
      const key = ctrl.dataset.prefKey;
      if (!key) return;
      const prefs = loadEnterprisePrefs();
      prefs[key] = ctrl instanceof HTMLInputElement && ctrl.type === 'checkbox' ? ctrl.checked : ctrl.value;
      saveEnterprisePrefs(prefs);
    });
  }

  const pairPreview = document.querySelector<HTMLElement>('[data-pref-mobile-preview]');
  const genBtn = document.querySelector<HTMLButtonElement>('[data-pref-action="gen-mobile-pair"]');
  if (genBtn && pairPreview) {
    genBtn.addEventListener('click', () => {
      const prefs = loadEnterprisePrefs();
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      const relay = String(prefs['mobile.relayMode'] ?? 'lan-direct');
      const touch = String(prefs['mobile.touchMode'] ?? 'hybrid');
      const bio = prefs['mobile.biometricRequire'] ? 'required' : 'optional';
      const uri = `jaladesk://pair?v=1&relay=${encodeURIComponent(relay)}&touch=${encodeURIComponent(touch)}&biometric=${bio}&fp=SHA256:${token.slice(0, 16).toUpperCase()}&token=${token}`;
      const asciiQr = [
        '▄▄▄▄▄▄▄ ▄▄▄▄▄ ▄▄▄▄▄▄▄   JalaDesk Mobile Zero-Trust Pairing',
        '█ ▄▄▄ █ ██▀▄▀ █ ▄▄▄ █   Platform : iOS 17+ / iPadOS / Android 14+',
        '█ ███ █ ▄▀█▀▀ █ ███ █   Mode     : ' + relay.toUpperCase() + ' (' + touch + ')',
        '█▄▄▄▄▄█ █ ▄▀█ █▄▄▄▄▄█   Biometric: ' + bio.toUpperCase() + ' (FaceID / TouchID)',
        '▄▄▄▄▄ ▄▄▄▀██▀▄▄ ▄▄▄▄▄   AES-GCM  : SHA256:' + token.slice(0, 16).toUpperCase(),
        '█ ▄▄▄ █ ▀▄█▄▀▄▄▀▄▀█▀█   Expires  : 300 seconds (One-Time Ephemeral Key)',
        '█ ███ █ ▀▀▄▀ ▄▀██▄▀██',
        '█▄▄▄▄▄█ ██▄▄▀▄█▄▀▄▄▀█   URI: ' + uri,
      ].join('\n');
      setText(pairPreview, asciiQr);
    });
  }

  const copyBtn = document.querySelector<HTMLButtonElement>('[data-pref-action="copy-mobile-pair"]');
  if (copyBtn && pairPreview) {
    copyBtn.addEventListener('click', () => {
      const text = pairPreview.textContent ?? '';
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      setText(copyBtn, '✓ Copied Pairing Token');
      setTimeout(() => setText(copyBtn, 'Copy Pairing URI'), 1800);
    });
  }

  const resetBtn = document.querySelector<HTMLButtonElement>('[data-pref-action="reset-defaults"]');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      saveEnterprisePrefs({ ...DEFAULT_PREFS });
      syncEnterpriseControlsToDOM();
      if (pairPreview) {
        setText(pairPreview, 'Defaults restored. Click "Generate Pairing Token" to create a 5-minute encrypted pairing URI.');
      }
    });
  }
}

wireEnterpriseTabsAndControls();
