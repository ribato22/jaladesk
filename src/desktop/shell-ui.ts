// The shell in the window: the toolbar (and the dialog that changes what is on it), the list of keys, what the window tells the main process about what can be done, and what the window does when
// a command arrives from the menu. Like the rest of the window it holds no logic of its own that can be tested without a window: what the buttons are and where they go is toolbar-model.ts, what can
// be done is menu-model.ts (isAvailable), what is reported is dom-report.ts, the words and keys are commands.ts and shortcuts-view.ts; this file is the glue that makes them elements of the page.
//
// The commands of the documents, the objects and the sessions are the buttons the page already has: a command is done by pressing its button (a button that is off is not pressed), and what can be
// done is read back from the buttons by watching them (a MutationObserver), so that none of the code behind them is touched and the menu, the toolbar and the button never disagree.
import { COMMANDS, MAX_RECENT, describeKeys, isCommand, keysFor, platformFrom, recentIndex, spec, type CommandId, type Report } from './commands.js';
import { toPoint, type ContextKind, type ContextRequest } from './context-menu.js';
import { readReport, stepTab, type Reader } from './dom-report.js';
import { isAvailable } from './menu-model.js';
import { captureNote, shortcutRows, tabRows, treeRows } from './shortcuts-view.js';
import { moveActive } from './tabs-ui.js';
import { toolbarIcon } from './toolbar-icons.js';
import { DEFAULT_LAYOUT, MAX_ITEMS, OFFERED, SEPARATOR, addSeparator, buttons, move, removeAt, rovingNext, rovingStop, sameLayout, toggle, type Layout } from './toolbar-model.js';

type Values = { theme: string; toolbar: { visible: boolean; items: Layout } };
/** How the window looks, as the main process decides it (shell.ts: View). */
type ViewState = { colorTabs: boolean; extended: boolean };
/** What the documents part of the window does for the commands that have no button of the page. */
export type ShellDocuments = { openRecent(index: number): Promise<void>; forgetKey(): Promise<void> };
type Failure = { ok: false; code: string; message: string };
declare global {
  interface Window {
    shell: {
      report(report: Report): void;
      settings(): Promise<({ ok: true; notice?: string } & Values) | Failure>;
      setToolbar(patch: { visible?: boolean; items?: Layout }): Promise<({ ok: true } & Values) | Failure>;
      run(id: CommandId): Promise<{ ok: true } | Failure>;
      view(): Promise<({ ok: true } & ViewState) | Failure>;
      context(request: ContextRequest): void;
      onCommand(callback: (value: { id: string }) => void): () => void;
      onSettings(callback: (value: Values) => void): () => void;
      onNotice(callback: (value: { text: string }) => void): () => void;
      onViewChanged(callback: (value: ViewState) => void): () => void;
    };
  }
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const EN_CMD: Readonly<Record<string, { short: string; label: string }>> = {
  'doc.new': { short: 'New', label: 'New Document…' },
  'doc.open': { short: 'Open', label: 'Open Document…' },
  'doc.save': { short: 'Save', label: 'Save Document' },
  'doc.close': { short: 'Close', label: 'Close Document' },
  'doc.reload': { short: 'Reload', label: 'Reload Document…' },
  'doc.conflicts': { short: 'Conflicts', label: 'Conflicts…' },
  'doc.history': { short: 'History', label: 'Revision History…' },
  'obj.connect': { short: 'Connect', label: 'Connect' },
  'obj.addFolder': { short: 'Folder', label: 'New Folder…' },
  'obj.addConnection': { short: 'Connection', label: 'New Connection…' },
  'obj.edit': { short: 'Properties', label: 'Properties…' },
  'obj.duplicate': { short: 'Duplicate', label: 'Duplicate' },
  'obj.favorite': { short: 'Favorite', label: 'Favorite' },
  'obj.remove': { short: 'Delete', label: 'Delete' },
  'tree.expandAll': { short: 'Expand All', label: 'Expand All Folders' },
  'tree.collapseAll': { short: 'Collapse All', label: 'Collapse All Folders' },
  'find': { short: 'Search', label: 'Search…' },
  'adhoc.focus': { short: 'Quick Connect', label: 'Quick Connect' },
  'session.reconnect': { short: 'Reconnect', label: 'Reconnect' },
  'session.disconnect': { short: 'Disconnect', label: 'Disconnect' },
  'session.closeTab': { short: 'Close Tab', label: 'Close Tab' },
  'view.fullscreen': { short: 'Full Screen', label: 'Full Screen' },
};
const NOTICES: Readonly<Record<string, string>> = {
  reset: 'Application settings file was damaged and reset to defaults.',
  unavailable: 'Application settings could not be opened; theme and toolbar changes apply only until quit.',
  'too-new': 'Application settings were created by a newer version; changes apply only until quit.',
};
/** What is told about the file of settings that matters for as long as the app runs (the choices are not kept) stays until it is closed; the rest goes by itself. */
const STAYS: readonly string[] = ['unavailable', 'too-new'];
const SETTINGS_UNREADABLE = 'Application settings could not be read; using default toolbar and theme.';
const VIEW_UNREADABLE = 'Tab and fullscreen view state could not be loaded; please restart the application.';
const NOT_DONE = 'That command cannot be executed right now.';

export async function initShell(documents?: ShellDocuments): Promise<void> {
  const info = await window.rdp.info().catch(() => undefined);
  const platform = platformFrom(info?.platform);
  let layout: Layout = DEFAULT_LAYOUT;
  let report: Report = { enabled: [], checked: [], capture: false, dialog: false, tabs: 0, tab: -1 };
  let noticeTimer: number | undefined;

  // ---- what the window can tell about itself: read from the page
  const reader: Reader = {
    enabled: (id) => { const control = document.getElementById(id) as HTMLButtonElement | HTMLSelectElement | null; return control ? !control.disabled : undefined; },
    pressed: (id) => document.getElementById(id)?.getAttribute('aria-pressed') === 'true',
    value: (id) => (document.getElementById(id) as HTMLSelectElement | null)?.value,
    tabs: () => { const list = [...document.querySelectorAll('#tabs button')]; return { count: list.length, active: list.findIndex((tab) => tab.classList.contains('active')) }; },
    session: () => document.body.dataset.tab ?? 'none',
    focusOnScreen: () => document.activeElement instanceof HTMLCanvasElement && document.activeElement.closest('#screen') !== null,
    dialogOpen: () => document.querySelector('dialog[open]') !== null,
  };
  const tabButtons = () => [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
  // The window cannot say which documents are recent (the main process keeps the list): the menu shows the ones there are and the main process answers an index that is gone, so for the window all of them are there.
  // Nor can it say whether the system remembers a key: the main process decided that when it sent the command, so for the window one is there.
  const recentAll = Array.from({ length: MAX_RECENT }, () => '');
  const available = (id: CommandId) => isAvailable(id, report, { prompt: false, recent: recentAll, keys: 1 });
  // The bar is painted as if no dialog were open: a modal dialog makes the page behind it inert anyway, and a button that is switched off cannot take the focus back from the dialog that it opened
  // (the browser gives it back when the dialog closes, before the bar could be painted again). What a command from the menu does is still decided with the dialog taken into account (onCommand).
  const availableOnBar = (id: CommandId) => isAvailable(id, { ...report, dialog: false }, { prompt: false, recent: recentAll, keys: 1 });

  // ---- doing a command of the window
  function press(buttonId: string): void { const control = document.getElementById(buttonId) as HTMLButtonElement | null; if (control && !control.disabled) control.click(); }
  function chooseAutosave(mode: 'off' | 'close' | 'edit'): void {
    const select = el<HTMLSelectElement>('doc-autosave');
    if (select.disabled) return;
    select.value = mode;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function chooseTab(index: number): void { tabButtons()[index]?.click(); }
  function perform(id: CommandId): void {
    const command = spec(id);
    if (command.owner === 'main') { void window.shell.run(id).then((reply) => { if (!reply.ok) say(reply.message || NOT_DONE); }, () => say(NOT_DONE)); return; }
    if (id.startsWith('doc.autosave.')) { chooseAutosave(id.slice('doc.autosave.'.length) as 'off' | 'close' | 'edit'); return; }
    if (command.button !== undefined) { press(command.button); return; }
    switch (id) {
      case 'find': { const box = el<HTMLInputElement>('tree-search'); box.focus(); box.select(); return; }
      case 'adhoc.focus': { el<HTMLDetailsElement>('adhoc').open = true; el<HTMLInputElement>('host').focus(); return; }
      case 'tab.next': case 'tab.previous': {
        const list = tabButtons(), to = stepTab(list.findIndex((tab) => tab.classList.contains('active')), list.length, id === 'tab.next' ? 1 : -1);
        if (to !== undefined) chooseTab(to);
        return;
      }
      case 'tab.last': chooseTab(tabButtons().length - 1); return;
      case 'tab.moveLeft': moveActive(-1); return;
      case 'tab.moveRight': moveActive(1); return;
      case 'doc.forgetKey': void documents?.forgetKey(); return;
      case 'session.release': {
        (document.activeElement as HTMLElement | null)?.blur();
        (document.querySelector<HTMLElement>('#tabs button.active') ?? el('tree')).focus();
        return;
      }
      case 'view.customizeToolbar': openToolbarDialog(); return;
      case 'help.shortcuts': openShortcuts(); return;
      default: {
        const recent = recentIndex(id);
        if (recent !== undefined) void documents?.openRecent(recent);
        else if (id.startsWith('tab.')) chooseTab(Number(id.slice(4)) - 1);
      }
    }
  }

  // ---- the toolbar
  const bar = el('toolbar');
  const drawn = new Map<CommandId, HTMLButtonElement>();
  function keyHint(id: CommandId): string { const key = keysFor(spec(id), platform); return key === undefined ? '' : ` (${describeKeys(key, platform)})`; }
  function renderToolbar(): void {
    bar.replaceChildren();
    drawn.clear();
    for (const item of buttons(layout)) {
      if (item.kind === 'separator') {
        const gap = document.createElement('span');
        gap.className = 'tool-sep';
        gap.setAttribute('role', 'separator');
        gap.setAttribute('aria-orientation', 'vertical');
        bar.append(gap);
        continue;
      }
      const button = document.createElement('button');
      const label = document.createElement('span');
      const en = EN_CMD[item.id];
      label.textContent = en ? en.short : item.label;
      button.type = 'button';
      button.className = 'tool';
      button.dataset.command = item.id;
      button.title = `${en ? en.label : item.title}${keyHint(item.id)}`;
      button.dataset.tooltip = button.title;
      button.append(toolbarIcon(item.icon), label);
      button.onclick = () => perform(item.id);
      drawn.set(item.id, button);
      bar.append(button);
    }
    paintToolbar();
  }
  function paintToolbar(): void {
    const all = [...drawn.values()];
    const held = all.indexOf(document.activeElement as HTMLButtonElement);
    for (const [id, button] of drawn) {
      button.disabled = !availableOnBar(id);
      if (id === 'obj.favorite') button.setAttribute('aria-pressed', String(report.checked.includes(id)));
    }
    const stop = rovingStop(all.map((button) => !button.disabled), all.findIndex((button) => button.tabIndex === 0));
    all.forEach((button, i) => { button.tabIndex = i === stop ? 0 : -1; });
    // a button that has the focus and is switched off by what it did (Simpan, once saved) would drop the focus to the page: it goes to the button that is the stop now
    if (held >= 0 && all[held]!.disabled && stop >= 0) all[stop]!.focus();
  }
  bar.addEventListener('keydown', (event) => {
    const all = [...drawn.values()];
    const next = rovingNext(all.map((button) => !button.disabled), all.indexOf(document.activeElement as HTMLButtonElement), event.key);
    if (next !== undefined && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); all[next]!.focus(); }
  });
  // the button that has the focus, by key or by pointer, is the one the Tab key stops at
  bar.addEventListener('focusin', (event) => {
    const all = [...drawn.values()], at = all.indexOf(event.target as HTMLButtonElement);
    if (at >= 0) all.forEach((button, i) => { button.tabIndex = i === at ? 0 : -1; });
  });
  // The settings are told again whenever anything in them changes (the theme too): the bar and the list are drawn again only when the layout is another, so that choosing a theme does not take the focus from a button.
  function applySettings(values: Values): void {
    if (!values.toolbar.visible && bar.contains(document.activeElement)) el('tree').focus();      // a button of the bar that has the focus when the bar goes: the focus goes to the tree, not to nowhere
    bar.hidden = !values.toolbar.visible;
    if (sameLayout(values.toolbar.items, layout)) return;
    layout = values.toolbar.items;
    renderToolbar();
    if (el<HTMLDialogElement>('toolbar-dialog').open) renderList();
  }

  // ---- what to tell the main process: when something that matters changed, once
  let told = '';
  let scheduled = false;
  /** Reads the page now, and tells the main process when that is not what it was told last. */
  function flush(): void {
    report = readReport(reader);
    paintToolbar();
    const key = JSON.stringify(report);
    if (key === told) return;
    told = key;
    window.shell.report(report);
  }
  function changed(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; flush(); });
  }
  // The choice of saving by itself changes its value from code (safety-ui.ts, update()) with no event and no attribute, but it writes its title every time: that is what is watched.
  const watcher = new MutationObserver(changed);
  for (const command of COMMANDS) if (command.button !== undefined) { const control = document.getElementById(command.button); if (control) watcher.observe(control, { attributes: true, attributeFilter: ['disabled', 'aria-pressed', 'title'] }); }
  watcher.observe(el('tabs'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  watcher.observe(document.body, { attributes: true, attributeFilter: ['data-tab'] });
  for (const each of document.querySelectorAll('dialog')) watcher.observe(each, { attributes: true, attributeFilter: ['open'] });
  el<HTMLSelectElement>('doc-autosave').addEventListener('change', changed);
  document.addEventListener('focusin', changed);
  document.addEventListener('focusout', changed);

  // ---- the notice: what could not be kept, what is wrong with the file of settings, a command that was refused. It floats over the page (a line in the page would change the size of the screen of a live
  // session, which is then asked to change its resolution), is always in the page and empty when there is nothing to say (a live region that appears together with its words is not read out), and goes by
  // itself after a while, except what matters for as long as the app runs: that stays until it is closed.
  const notice = el('shell-notice'), noticeText = el('shell-notice-text'), noticeClose = el<HTMLButtonElement>('shell-notice-close');
  let sticky = '';      // what matters for as long as the app runs: it is there again when what goes by itself has gone
  function show(text: string, stays: boolean): void {
    clearTimeout(noticeTimer);
    noticeText.textContent = text;
    noticeClose.hidden = text === '' || !stays;
    notice.classList.toggle('empty', text === '');
    if (text !== '' && !stays) noticeTimer = window.setTimeout(() => show(sticky, sticky !== ''), 9000);
  }
  function say(text: string, stays = false): void { if (stays) sticky = text; show(text, stays); }
  noticeClose.onclick = () => { sticky = ''; show('', false); };

  // ---- the dialog that changes the toolbar
  const dialog = el<HTMLDialogElement>('toolbar-dialog');
  let opener: HTMLElement | undefined;
  let busy = false;
  type Place = { row: string; part: string };
  let fallback: string | undefined;   // where the focus goes when the control that had it is gone after a change (a separator that was taken off)
  let wanted: Place | undefined;      // where the focus goes after the next drawing when the control that has it now is not the one to follow (a separator that moved is found by its new place)
  async function change(next: Layout, after: string, to?: Place): Promise<void> {
    // another change is on its way: it draws the list again when it is answered, with the focus where it asked for it, and this one is let go (drawing the list now would use up that place)
    if (busy) return;
    // nothing changes, because it does not fit: a box that was ticked is put as it was, and the person is told why
    if (next === layout) { el('toolbar-error').textContent = `Toolbar is full: maximum ${MAX_ITEMS} items.`; renderList(); return; }
    busy = true;
    el('toolbar-error').textContent = '';
    fallback = after;
    wanted = to;
    const reply = await window.shell.setToolbar({ items: next }).catch(() => ({ ok: false as const, code: 'io', message: 'Toolbar could not be updated.' }));
    busy = false;
    if (!reply.ok) { el('toolbar-error').textContent = reply.message; renderList(); return; }
    layout = reply.toolbar.items;
    renderToolbar();
    renderList();
  }
  function listButton(text: string, name: string, act: string, run: () => void, off = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet';
    button.textContent = text;
    button.dataset.act = act;
    button.setAttribute('aria-label', name);
    button.disabled = off;
    button.onclick = run;
    return button;
  }
  // The list is made again after every change (and again when the main process says the settings changed): the control that has the focus is found again by what it is, so that the focus stays where it was.
  function placeOf(list: HTMLElement): Place | undefined {
    const active = document.activeElement;
    const row = active instanceof HTMLElement ? active.closest<HTMLElement>('#toolbar-list li') : null;
    if (!row || !(active instanceof HTMLElement) || !list.contains(active)) return undefined;
    return { row: row.dataset.command ?? `sep:${row.dataset.index}`, part: active instanceof HTMLInputElement ? 'input' : `[data-act=${active.dataset.act}]` };
  }
  const rowOf = (list: HTMLElement, place: Place) => list.querySelector<HTMLElement>(place.row.startsWith('sep:') ? `li.sep[data-index="${place.row.slice(4)}"]` : `li[data-command="${place.row}"]`);
  function findPlace(list: HTMLElement, place: Place): HTMLElement | null { return rowOf(list, place)?.querySelector<HTMLElement>(place.part) ?? null; }
  /** The controls of the row of a place that can take the focus when the control itself cannot (Naik at the top is off now): the other way of moving first, then the rest of the row. */
  function siblings(list: HTMLElement, place: Place): HTMLElement[] {
    const row = rowOf(list, place);
    if (!row) return [];
    const partner = place.part === '[data-act=up]' ? '[data-act=down]' : place.part === '[data-act=down]' ? '[data-act=up]' : '';
    return [...(partner ? [row.querySelector<HTMLElement>(partner)] : []), ...row.querySelectorAll<HTMLElement>('input, button')].filter((control): control is HTMLElement => control !== null);
  }
  function renderList(): void {
    const list = el('toolbar-list');
    const place = wanted ?? (dialog.open ? placeOf(list) : undefined);
    wanted = undefined;
    list.replaceChildren();
    layout.forEach((item, i) => {
      const row = document.createElement('li');
      const tools = document.createElement('span');
      tools.className = 'row-buttons';
      if (item === SEPARATOR) {
        row.className = 'sep';
        row.dataset.index = String(i);
        const words = document.createElement('span');
        words.textContent = 'Separator';
        row.append(words);
        tools.append(listButton('Up', 'Move separator up', 'up', () => void change(move(layout, i, -1), '#toolbar-close', { row: `sep:${i - 1}`, part: '[data-act=up]' }), move(layout, i, -1) === layout),
          listButton('Down', 'Move separator down', 'down', () => void change(move(layout, i, 1), '#toolbar-close', { row: `sep:${i + 1}`, part: '[data-act=down]' }), move(layout, i, 1) === layout),
          listButton('Remove', 'Remove separator', 'remove', () => void change(removeAt(layout, i), '#toolbar-separator')));
      } else {
        const command = spec(item);
        const enLabel = EN_CMD[item]?.label ?? command.label;
        row.dataset.command = item;
        row.dataset.index = String(i);
        const label = document.createElement('label');
        label.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        box.dataset.command = item;
        box.onchange = () => void change(toggle(layout, item), '#toolbar-close');
        const words = document.createElement('span');
        words.textContent = enLabel;
        label.append(box, words);
        row.append(label);
        tools.append(listButton('Up', `Move ${enLabel} up`, 'up', () => void change(move(layout, i, -1), '#toolbar-close'), move(layout, i, -1) === layout),
          listButton('Down', `Move ${enLabel} down`, 'down', () => void change(move(layout, i, 1), '#toolbar-close'), move(layout, i, 1) === layout),
          listButton('Separator', `Add separator below ${enLabel}`, 'separator', () => void change(addSeparator(layout, i + 1), '#toolbar-close'), addSeparator(layout, i + 1) === layout));
      }
      row.append(tools);
      list.append(row);
    });
    for (const id of OFFERED) {
      if (layout.includes(id)) continue;
      const row = document.createElement('li');
      row.dataset.command = id;
      row.className = 'absent';
      const label = document.createElement('label');
      label.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.command = id;
      box.onchange = () => void change(toggle(layout, id), '#toolbar-close');
      const words = document.createElement('span');
      words.textContent = EN_CMD[id]?.label ?? spec(id).label;
      label.append(box, words);
      row.append(label);
      list.append(row);
    }
    el<HTMLButtonElement>('toolbar-reset').disabled = layout.length === DEFAULT_LAYOUT.length && layout.every((item, i) => item === DEFAULT_LAYOUT[i]);
    if (dialog.open && (place || fallback)) {
      const choices = [place ? findPlace(list, place) : null, ...(place ? siblings(list, place) : []), fallback ? document.querySelector<HTMLElement>(fallback) : null, list.querySelector<HTMLElement>('input')];
      (choices.find((choice) => choice && !(choice as HTMLButtonElement).disabled) as HTMLElement | undefined)?.focus();
    }
    fallback = undefined;
  }
  function openToolbarDialog(): void {
    if (dialog.open) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    el('toolbar-error').textContent = '';
    renderList();
    dialog.showModal();
    list0().focus();
  }
  const list0 = () => el('toolbar-list').querySelector<HTMLElement>('input') ?? el('toolbar-close');
  el('toolbar-close').onclick = () => dialog.close();
  el('toolbar-reset').onclick = () => void change(DEFAULT_LAYOUT, '#toolbar-close');
  el('toolbar-separator').onclick = () => {
    const at = layout.findIndex((item, i) => addSeparator(layout, i) !== layout);
    if (at < 0) { el('toolbar-error').textContent = 'No room for a separator: place two commands next to each other first.'; return; }
    void change(addSeparator(layout, at), '#toolbar-separator');
  };
  // back to what had the focus when the dialog was opened, when that is still there and can be seen (a button that was taken off, or a bar that is hidden, cannot take it); else to a button of the bar that
  // can be used; else to the tree
  dialog.addEventListener('close', () => {
    const back = opener?.isConnected && opener.getClientRects().length > 0 ? opener : bar.hidden ? undefined : bar.querySelector<HTMLElement>('button:not(:disabled)');
    (back ?? el('tree')).focus();
    opener = undefined;
  });

  // ---- the menus that open with a right click or the Menu key: the window says which kind and where, and the main process builds the menu from what it was told last about the window (flush first: the row that
  // was clicked is chosen before the menu is asked for, as in any list). The remote screens keep their right click for the machine at the other end (renderer.ts); a box that can be typed in gets its own menu
  // from the main process, and the rest of the page has none.
  function ask(kind: ContextKind, x: number, y: number): void {
    flush();
    window.shell.context({ kind, ...toPoint(x, y) });
  }
  /** Where a menu opens: at the pointer when it was a pointer that asked, else below the element that has the focus (the Menu key has no pointer). */
  function anchor(event: MouseEvent, element: Element | null): { x: number; y: number } {
    if (event.button === 2 || !element) return { x: event.clientX, y: event.clientY };
    const box = element.getBoundingClientRect();
    return { x: box.left + 24, y: box.bottom };
  }
  const tree = el('tree');
  tree.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const row = (event.target as Element).closest<HTMLElement>('[role=treeitem]');
    if (row) row.querySelector<HTMLElement>('.name')?.click();      // the tree chooses the row that is clicked
    const at = anchor(event, document.getElementById(tree.getAttribute('aria-activedescendant') ?? '') ?? tree);
    ask('tree', at.x, at.y);
  });
  el('tabs').addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const tab = (event.target as Element).closest<HTMLButtonElement>('#tabs button');
    if (!tab) return;
    tab.click();      // and so does a tab
    const at = anchor(event, tab);
    ask('tab', at.x, at.y);
  });
  bar.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const at = anchor(event, (event.target as Element).closest('button') ?? bar);
    ask('toolbar', at.x, at.y);
  });

  // ---- how the window looks, as the main process decides it: whether the tabs show their colour, and whether the panels give way to the screen (the extended full screen; style.css does the rest)
  function applyView(view: ViewState): void {
    document.body.classList.toggle('plain-tabs', !view.colorTabs);
    document.body.classList.toggle('extended', view.extended);
    const wfBtn = document.getElementById('window-full');
    if (wfBtn) wfBtn.textContent = view.extended ? '❐ Normal View' : '⛶ Window Full';
  }

  // ---- the list of keys
  const shortcuts = el<HTMLDialogElement>('shortcuts-dialog');
  const EN_SHORTCUT_LABELS: Readonly<Record<string, string>> = {
    'Tampilkan atau Sembunyikan Toolbar': 'Show or Hide Toolbar',
    'Tab 1 sampai 9': 'Tabs 1 to 9',
    'Tab Berikutnya': 'Next Tab',
    'Tab Sebelumnya': 'Previous Tab',
    'Lepas Papan Ketik dari Sesi': 'Release Keyboard from Session',
    'Pengaturan…': 'Settings…',
    'Keluar': 'Quit',
    'Hubungkan': 'Connect',
    'Duplikat': 'Duplicate',
    'Favorit': 'Favorite',
    'Hapus': 'Delete',
    'Pindah': 'Move Object',
    'Pindahkan tab': 'Move Tab',
  };
  function openShortcuts(): void {
    if (shortcuts.open) return;
    const body = el('shortcuts-body');
    body.replaceChildren();
    for (const row of shortcutRows(platform)) {
      const line = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      name.textContent = EN_CMD[row.id]?.label ?? EN_SHORTCUT_LABELS[row.label] ?? row.label;
      const keys = document.createElement('td');
      keys.textContent = row.keys;
      line.append(name, keys);
      body.append(line);
    }
    const treeBody = el('shortcuts-tree-body');
    treeBody.replaceChildren();
    const group = document.createElement('tr'), groupName = document.createElement('th');
    groupName.scope = 'rowgroup';
    groupName.colSpan = 2;
    groupName.textContent = 'When focus is in the Navigation Tree';
    group.append(groupName);
    treeBody.append(group);
    for (const row of treeRows(platform)) {
      const line = document.createElement('tr'), name = document.createElement('th'), keys = document.createElement('td');
      name.scope = 'row';
      name.textContent = EN_SHORTCUT_LABELS[row.label] ?? row.label;
      keys.textContent = row.keys.replace('atau', 'or').replace('panah', 'Arrow');
      line.append(name, keys);
      treeBody.append(line);
    }
    const tabBody = el('shortcuts-tab-body');
    tabBody.replaceChildren();
    const tabGroup = document.createElement('tr'), tabGroupName = document.createElement('th');
    tabGroupName.scope = 'rowgroup';
    tabGroupName.colSpan = 2;
    tabGroupName.textContent = 'When focus is on a Session Tab';
    tabGroup.append(tabGroupName);
    tabBody.append(tabGroup);
    for (const row of tabRows(platform)) {
      const line = document.createElement('tr'), name = document.createElement('th'), keys = document.createElement('td');
      name.scope = 'row';
      name.textContent = EN_SHORTCUT_LABELS[row.label] ?? row.label;
      keys.textContent = row.keys.replace('panah kiri atau kanan', 'Left or Right Arrow');
      line.append(name, keys);
      tabBody.append(line);
    }
    void captureNote(platform);
    el('shortcuts-note').textContent = 'While a connected remote session has focus, all keys are sent to the remote machine except Release Keyboard from Session, Full Screen, and Quit.';
    shortcuts.showModal();
    el('shortcuts-close').focus();
  }
  el('shortcuts-close').onclick = () => shortcuts.close();      // the browser gives the focus back to what had it when the dialog was opened

  // ---- what the main process sends
  window.shell.onCommand(({ id }) => { if (isCommand(id) && spec(id).owner === 'window' && available(id)) perform(id); });
  window.shell.onSettings(applySettings);
  window.shell.onNotice(({ text }) => say(text));
  window.shell.onViewChanged(applyView);

  report = readReport(reader);
  renderToolbar();
  say('');
  const settings = await window.shell.settings().catch(() => undefined);
  if (settings?.ok) {
    applySettings(settings);
    if (settings.notice) say(NOTICES[settings.notice] ?? '', STAYS.includes(settings.notice));
  } else { bar.hidden = false; say(SETTINGS_UNREADABLE, true); }
  const view = await window.shell.view().catch(() => undefined);
  if (view?.ok) applyView(view); else say(VIEW_UNREADABLE, true);
  told = JSON.stringify(report);
  window.shell.report(report);
}
