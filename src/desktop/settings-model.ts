// What the window of the settings shows, worked out from what the main process told it (settings-ipc.ts: SettingsView): the state of each control and the words next to them. Plain data and functions, so what the
// window says about a setting (and whether a button can be pressed) is tested without a window; settings-ui.ts is the glue that makes it elements of the page.
import type { ThemeChoice } from './commands.js';
import type { SettingsView } from './settings-ipc.js';

export type SettingsPage = {
  readonly theme: ThemeChoice;
  readonly toolbar: boolean;
  readonly colorize: boolean;
  readonly extended: boolean;
  readonly keysAllow: boolean;
  readonly keysNote: string;
  readonly keysCount: string;
  readonly canForget: boolean;
  readonly recentCount: string;
  readonly canClear: boolean;
};

const OFF_NOTE = 'Bila dinyalakan, jendela sandi menawarkan untuk mengingat kunci dokumen di komputer ini, dan dokumen itu kemudian dibuka tanpa sandi. Sandinya sendiri tidak pernah disimpan.';
const ON_NOTE = 'Kunci disimpan oleh keystore sistem (Keychain di macOS, DPAPI di Windows) dan hanya berlaku di komputer ini. Berkas dokumen tetap hanya dapat dibuka dengan sandi di tempat lain.';
const MISSING_NOTE = 'Keystore sistem tidak tersedia di komputer ini; kunci tidak diingat sampai keystore itu tersedia.';

export function describeSettings(view: SettingsView): SettingsPage {
  const { keys, recent } = view;
  return {
    theme: view.theme, toolbar: view.toolbar.visible, colorize: view.tabs.colorize, extended: view.fullscreen.extended, keysAllow: keys.allow,
    keysNote: !keys.allow ? OFF_NOTE : keys.usable === true ? ON_NOTE : MISSING_NOTE,
    keysCount: keys.count === 0 ? 'Tidak ada kunci yang diingat.' : `${keys.count} kunci diingat.`,
    canForget: keys.count > 0,
    recentCount: recent.count === 0 ? 'Daftar terbaru kosong.' : `${recent.count} dokumen di daftar terbaru.`,
    canClear: recent.count > 0,
  };
}
