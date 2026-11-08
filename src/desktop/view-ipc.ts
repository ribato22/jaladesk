// IPC for how the window looks and for the menus that open where it asks. The window asks `shell:view` how it should look (the colour of the tabs, the extended full screen) and is told when that
// changes (`shell:view-changed`, sent by shell.ts, not registered here); it asks for a context menu with `shell:context` and a kind and a place, and never says what is in it (context-menu.ts: the main
// process builds it). Both check their sender first, like every other channel of the shell, and what arrives is validated before anything is done with it.
import { parseContextRequest, type ContextRequest } from './context-menu.js';
import type { View } from './shell.js';
import type { ShellIpc } from './shell-ipc.js';

export type ViewIpcDeps = {
  ipc: ShellIpc;
  /** Throws when the sender is not the window of the application. */
  check(event: unknown): void;
  shell: { view(): View; context(request: ContextRequest): void };
  report(error: unknown): void;
};

export function registerViewIpc(deps: ViewIpcDeps): void {
  const { ipc, check, shell } = deps;
  ipc.handle('shell:view', (event) => {
    check(event);
    return { ok: true as const, ...shell.view() };
  });
  ipc.on('shell:context', (event, payload) => {
    try { check(event); } catch { return; }
    const request = parseContextRequest(payload);
    if (!request) return;
    try { shell.context(request); } catch (error) { deps.report(error); }
  });
}
