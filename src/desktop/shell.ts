// The shell of the application in the main process: it keeps the menu in step with what the window reports and with what is chosen (the theme, the toolbar, the full screen), runs the commands
// that are the main process's own (the theme, the toolbar's visibility, the full screen, About, quitting), and sends the others to the window. It touches nothing of Electron itself: the menu
// is handed over as a template, the window, the theme of the system and the two dialogs are handed in, so that everything it does can be tested without a window (main.ts hands in the real ones).
//
// The menu is made again only when it would be a different menu (the model is compared, not the report), because a key that is offered to a menu that is being replaced is a key that may be lost.
//
// Three things here come from how Electron behaves. (1) It turns a check box or a radio item on or off BEFORE it handles the click, so a choice that is not made (the settings cannot be written, the
// page refuses) leaves the menu saying what was not chosen: after a click on such an item the menu is put in place again if nothing else did. (2) What a click does is done after the click has
// returned (`defer`), so that the menu is never replaced in the middle of the action of one of its own items; a key that is taken is dealt with the same way. (3) The page is offered a key before the
// menu and the screen of a connected session consumes every key, so the few keys that must work while a session holds the keyboard are taken here, before the page (`keyDown`, fed by
// before-input-event). And when no menu of ours can be put in place at all, a plain one is: the default menu of Electron has Reload, which throws the window away, and the tools of the developer.
import { EMPTY_REPORT, isCommand, recentIndex, sameReport, spec, type CommandId, type Platform, type Report, type ThemeChoice } from './commands.js';
import { contextMenu, editMenu, type ContextRequest, type EditParams } from './context-menu.js';
import { reservedCommand, type KeyInput } from './key-match.js';
import { buildMenu, findCommand, type Flags } from './menu-model.js';
import { toTemplate, type TemplateItem } from './menu.js';
import type { OptionName, SettingsValues } from './settings.js';
import { backgroundOf } from './theme.js';

/** What the window is told when a choice could not be kept. */
export const NOT_SAVED = 'Pengaturan tidak dapat disimpan di komputer ini; perubahan tidak dilakukan.';
/** What the window is told when the list of recent documents was cleared but the file that keeps it could not be written. */
export const NOT_CLEARED = 'Daftar dokumen terbaru sudah dibersihkan, tetapi berkasnya tidak dapat ditulis; daftar lama dapat muncul lagi saat aplikasi dibuka berikutnya.';

export type WindowLike = {
  send(channel: string, payload: unknown): void;
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  setBackgroundColor(color: string): void;
};
export type SettingsLike = {
  values(): SettingsValues;
  setTheme(choice: unknown): Promise<SettingsValues>;
  setToolbar(patch: unknown): Promise<SettingsValues>;
  toggleToolbar(): Promise<SettingsValues>;
  toggleOption(name: OptionName): Promise<SettingsValues>;
  subscribe(listener: (values: SettingsValues) => void): () => void;
};
export type ShellDeps = {
  platform: Platform;
  appName: string;
  settings: SettingsLike;
  /** Puts a menu in place: Menu.setApplicationMenu(Menu.buildFromTemplate(template)). */
  setApplicationMenu(template: TemplateItem[]): void;
  /** A plain menu of the application's own (no Reload, no tools of the developer), put in place when no menu of ours could be put in place at all; without it the default menu of Electron would stay. */
  fallbackMenu?(): void;
  /** The window of the application, when there is one. */
  window(): WindowLike | undefined;
  /** The theme of the system as the application sees it: the choice is made known to it, and it says whether the window is dark now. */
  nativeTheme: { setSource(choice: ThemeChoice): void; isDark(): boolean };
  showAbout(): void;
  quit(): void;
  report(error: unknown): void;
  /** Runs what a click on an item of the menu does once the click has returned (setImmediate); without it the action is done at once. */
  defer?(run: () => void): void;
  /**
   * The recent documents when the application keeps a list: the words of the menu for them (newest first), clearing the list (false when the file that keeps it could not be written), being told when it changes, and
   * `choose`: the person chose the document at a place of the list, which lets the window open that document (it is recorded before the window is told). Without it the menu has no recent documents.
   */
  recent?: { labels(): string[]; clear(): Promise<boolean>; subscribe(listener: () => void): () => void; choose(place: number): void };
  /** The keys that the system remembers when the application keeps them: how many there are, and being told when that number is another. Without it the menu knows of no key. */
  keys?: { known(): number; subscribe(listener: () => void): () => void };
  /** Opens the window of the settings, or brings it to the front. Without it Pengaturan does nothing. */
  openSettings?(): void;
  /** Shows a menu (a context menu): the template, the place in the window where it opens (without one, where the pointer is) and the window it opens on (without one, the main window). Without it no context menu is shown. */
  popup?(template: TemplateItem[], at?: { x: number; y: number }, target?: unknown): void;
};
/** How the window should look, as far as the main process decides it: whether the tabs show their colour, and whether the panels give way to the screen (the extended full screen is chosen and the window is in the full screen). */
export type View = { readonly colorTabs: boolean; readonly extended: boolean };
export type Shell = {
  /** Applies the theme that was chosen, puts the menu in place and follows the settings. */
  start(): void;
  stop(): void;
  /** What the window reports; says whether it was news. */
  report(report: Report): boolean;
  /** A window of the main process that asks for a password opens (true) or closes (false). */
  setPrompt(open: boolean): void;
  /** Another window of the application than the main window has the focus (true), or the main window has it again (false): the commands of the main window are off meanwhile. */
  setAway(away: boolean): void;
  /** The process of the page died: what the page said it could do is not true any more, and nothing of the window can be done until a page reports again. */
  pageGone(): void;
  fullScreenChanged(on: boolean): void;
  /** The system changed its theme. */
  themeChanged(): void;
  /** How the window should look now; the window is told (`shell:view-changed`) whenever this changes. */
  view(): View;
  /** A context menu asked for by the window: shown where it said, with the items that apply. Nothing is shown when no item applies, while a window of the main process is asking something, or when the page is gone. */
  context(request: ContextRequest): void;
  /** The editing menu of a box that can be typed in (what the browser says about the place that was clicked): shown where the pointer is, on the window that has the box (`target`; the main window when there is none). */
  editContext(params: EditParams, target?: unknown): void;
  /**
   * A key press, before the page gets it. Says whether it was taken (the page must not see it): while a connected session holds the keyboard, the keys that stay the application's (quitting and the full
   * screen on macOS, the key that gives the keyboard back) are done here, and held down they are done once. Every other key is the session's. The release of a key that was taken never comes: Chromium does
   * not deliver it (seen with webContents.sendInputEvent, see the plan), so nothing is remembered.
   */
  keyDown(input: KeyInput): boolean;
  /** A command of the main process, from the window or from the menu; says whether it was done. */
  run(id: CommandId): Promise<boolean>;
  state(): { report: Report; flags: Flags };
};

export function createShell(deps: ShellDeps): Shell {
  let report: Report = EMPTY_REPORT;
  let prompts = 0;
  let fullscreen = false;
  let stopFollowing: (() => void) | undefined;
  let installed = '';
  let installs = 0;
  let plain = false;      // the plain menu is in place
  let gone = false;      // the page is gone
  let away = false;      // another window of the application has the focus
  let stopRecent: (() => void) | undefined;
  let stopKeys: (() => void) | undefined;
  let toldView = '';      // the view the window was told last, or would have been told: it is told again only when the view is another
  const defer = deps.defer ?? ((run: () => void) => run());
  const attempt = (step: () => void) => { try { step(); } catch (error) { deps.report(error); } };

  const flags = (): Flags => {
    const values = deps.settings.values();
    return { theme: values.theme, toolbar: values.toolbar.visible, fullscreen, prompt: prompts > 0, pageGone: gone, colorTabs: values.tabs.colorize, extendedFullscreen: values.fullscreen.extended, recent: deps.recent?.labels() ?? [], keys: deps.keys?.known() ?? 0, away };
  };
  const viewNow = (): View => { const values = deps.settings.values(); return { colorTabs: values.tabs.colorize, extended: fullscreen && values.fullscreen.extended }; };
  /** Tells the window how it should look when that is not what it was told last. */
  function tellView(): void {
    const now = viewNow();
    const key = JSON.stringify(now);
    if (key === toldView) return;
    toldView = key;
    attempt(() => deps.window()?.send('shell:view-changed', now));
  }
  const model = () => buildMenu({ platform: deps.platform, appName: deps.appName, report, flags: flags() });
  function rebuild(): void {
    try {
      const current = model();
      const key = JSON.stringify(current);
      if (key === installed) return;
      // remembered only once it is in place: a menu that could not be put in place is made again at the next change, even if it is the same menu
      deps.setApplicationMenu(toTemplate(current, (id) => defer(() => dispatch(id))));
      installed = key;
      installs++;
    } catch (error) {
      deps.report(error);
      // no menu of ours was ever in place: the default menu of Electron would stay, with Reload (which throws away the window) and the tools of the developer
      if (installs === 0 && !plain) { plain = true; attempt(() => deps.fallbackMenu?.()); }
    }
  }
  function paint(): void { deps.window()?.setBackgroundColor(backgroundOf('page', deps.nativeTheme.isDark())); }
  function applyTheme(): void {
    deps.nativeTheme.setSource(deps.settings.values().theme);
    paint();
  }
  // each step on its own: one that fails is reported and does not keep the window from hearing of the change
  function followed(values: SettingsValues): void {
    attempt(applyTheme);
    rebuild();
    tellView();
    attempt(() => deps.window()?.send('shell:settings-changed', values));
  }
  /** A choice that is kept: when it cannot be, it is not made, and the window is told. */
  async function keep(change: () => Promise<unknown>): Promise<boolean> {
    try { await change(); return true; } catch (error) {
      deps.report(error);
      deps.window()?.send('shell:notice', { text: NOT_SAVED });
      return false;
    }
  }

  async function run(id: CommandId): Promise<boolean> {
    if (!isCommand(id) || spec(id).owner !== 'main' || !findCommand(model(), id)?.enabled) return false;
    switch (id) {
      case 'view.toolbar': return keep(() => deps.settings.toggleToolbar());
      case 'view.colorizeTabs': return keep(() => deps.settings.toggleOption('tabs.colorize'));
      case 'view.extendedFullscreen': return keep(() => deps.settings.toggleOption('fullscreen.extended'));
      case 'app.settings': if (!deps.openSettings) return false; deps.openSettings(); return true;
      case 'doc.recent.clear': {
        if (!deps.recent) return false;
        if (await deps.recent.clear()) return true;
        deps.window()?.send('shell:notice', { text: NOT_CLEARED });      // the menu is empty now, the file is not
        return false;
      }
      case 'view.theme.system': case 'view.theme.light': case 'view.theme.dark': return keep(() => deps.settings.setTheme(id.slice('view.theme.'.length)));
      case 'view.fullscreen': { const window = deps.window(); if (!window) return false; window.setFullScreen(!window.isFullScreen()); return true; }
      case 'app.about': deps.showAbout(); return true;
      case 'app.quit': deps.quit(); return true;
      default: return false;
    }
  }
  /** A click on an item of the menu: a command of the window goes to the window, one of the main process is done here; an item that is off now (the click is old) does nothing. */
  function dispatch(id: CommandId): void {
    const item = findCommand(model(), id);
    if (!item?.enabled) return;
    const before = installs;
    // a check box or a radio item has been turned on or off by Electron already: when nothing has made the menu again by the time the action is over, it is made again, as it was
    const settle = () => { if (item.control && installs === before) { installed = ''; rebuild(); } };
    if (spec(id).owner === 'main') void run(id).catch(deps.report).finally(settle);
    else {
      const place = recentIndex(id);
      if (place !== undefined) attempt(() => deps.recent?.choose(place));      // the click is the person's choice of that document, and it is recorded before the window hears of it
      deps.window()?.send('shell:command', { id });
      settle();
    }
  }

  return {
    start() {
      attempt(applyTheme);
      rebuild();
      stopFollowing = deps.settings.subscribe(followed);
      stopRecent = deps.recent?.subscribe(rebuild);
      stopKeys = deps.keys?.subscribe(rebuild);
      toldView = JSON.stringify(viewNow());
    },
    stop() { stopFollowing?.(); stopFollowing = undefined; stopRecent?.(); stopRecent = undefined; stopKeys?.(); stopKeys = undefined; },
    report(next) {
      const back = gone;      // a page that reports is there, and what it says is news even when it is what was said before it went
      gone = false;
      if (!back && sameReport(report, next)) return false;
      report = next;
      rebuild();
      return true;
    },
    pageGone() { gone = true; report = EMPTY_REPORT; rebuild(); },
    setPrompt(open) { prompts = Math.max(0, prompts + (open ? 1 : -1)); rebuild(); },
    setAway(on) { if (away === on) return; away = on; rebuild(); },
    fullScreenChanged(on) { fullscreen = on; rebuild(); tellView(); },
    themeChanged() { paint(); },
    view: viewNow,
    context(request) {
      if (prompts > 0 || gone) return;
      const entries = contextMenu(request.kind, { platform: deps.platform, appName: deps.appName, report, flags: flags() });
      if (entries.length === 0) return;
      attempt(() => deps.popup?.(toTemplate(entries, (id) => defer(() => dispatch(id))), { x: request.x, y: request.y }));
    },
    editContext(params, target) {
      const entries = editMenu(params);
      if (entries.length === 0) return;
      attempt(() => deps.popup?.(toTemplate(entries, () => undefined), undefined, target));
    },
    keyDown(input) {
      if (input.type !== 'keyDown' || !report.capture || prompts > 0) return false;
      const id = reservedCommand(deps.platform, input);
      if (id === undefined) return false;
      if (!input.isAutoRepeat) defer(() => dispatch(id));     // like the click of an item: after the key event has returned
      return true;
    },
    run,
    state: () => ({ report, flags: flags() }),
  };
}
