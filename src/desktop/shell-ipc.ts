// IPC for the shell. The window reports what it can do now (`shell:report`: nothing comes back), asks for the settings and changes the toolbar, and asks for the commands that are the main
// process's own (the full screen, the theme, About, quitting); the main process sends the window the commands that are chosen in the menu (`shell:command`), the settings when they change
// (`shell:settings-changed`) and a notice when a choice could not be kept (`shell:notice`); those three are sent by shell.ts, not registered here.
// Every channel checks its sender first (the same check as every other channel), and what arrives is validated before anything is done with it: a report is taken in only whole
// (commands.ts), the toolbar is changed only by what settings.ts accepts, and a command is run only when it is one of the main process's own (shell.ts decides whether it can be done now).
// Answers are { ok: true, ... } or { ok: false, code, message } as everywhere else; the only thing that ever rejects is a sender that is not the window of the application.
import { isCommand, parseReport } from './commands.js';
import { SettingsError, type SettingsValues } from './settings.js';
import type { SettingsLike, Shell } from './shell.js';

export type ShellIpc = {
  handle(channel: string, listener: (event: any, payload?: unknown) => unknown): void;
  on(channel: string, listener: (event: any, payload?: unknown) => void): void;
};
/** Why the settings are not what the person left: the file that could not be understood was set aside (`reset`), or could not be used at all (`unavailable`, `too-new`). */
export type SettingsNotice = 'reset' | 'unavailable' | 'too-new';
export type ShellIpcDeps = {
  ipc: ShellIpc;
  /** Throws when the sender is not the window of the application. */
  check(event: unknown): void;
  shell: Pick<Shell, 'report' | 'run'>;
  settings: Pick<SettingsLike, 'values' | 'setToolbar'>;
  /** Asked for with the settings; what it answers is told to the window, and it is expected to answer it once. */
  notice?: () => SettingsNotice | undefined;
  report(error: unknown): void;
};

const settingsReply = (values: SettingsValues) => ({ ok: true as const, theme: values.theme, toolbar: values.toolbar });
const fail = (code: string, message: string) => ({ ok: false as const, code, message });

export function registerShellIpc(deps: ShellIpcDeps): void {
  const { ipc, check, shell, settings } = deps;

  ipc.on('shell:report', (event, payload) => {
    try { check(event); } catch { return; }
    const report = parseReport(payload);
    if (report) shell.report(report);
  });

  ipc.handle('shell:settings', (event) => {
    check(event);
    const notice = deps.notice?.();
    return { ...settingsReply(settings.values()), ...(notice ? { notice } : {}) };
  });

  ipc.handle('shell:set-toolbar', async (event, payload) => {
    check(event);
    try { return settingsReply(await settings.setToolbar(payload)); } catch (error) {
      if (error instanceof SettingsError && error.code === 'invalid') return fail('invalid', 'Perubahan toolbar tidak dikenal.');
      deps.report(error);
      return fail('io', 'Pengaturan tidak dapat disimpan di komputer ini.');
    }
  });

  ipc.handle('shell:run', async (event, payload) => {
    check(event);
    const keys = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? Object.keys(payload) : [];
    const id = keys.length === 1 && keys[0] === 'id' ? (payload as { id: unknown }).id : undefined;
    if (!isCommand(id)) return fail('invalid', 'Perintah tidak dikenal.');
    const refused = fail('refused', 'Perintah tidak dapat dijalankan sekarang.');
    try { return (await shell.run(id)) ? { ok: true as const } : refused; } catch (error) {
      deps.report(error);      // a dialog that cannot be shown, a window that cannot go full screen: the window is told in words, not left with the error of Electron
      return refused;
    }
  });
}
