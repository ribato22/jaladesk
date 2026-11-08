// The menus that open with a right click (or the Menu key): what the main process shows, built from the same list of commands and the same state as the menu of the application, so that an item has the same
// words, the same key and the same answer to "can it be done now" wherever it is. A menu of a kind is a fixed list of commands; what cannot be done now is left out and not shown off (a context menu is
// what applies here), and the lines that would be left at the top, at the bottom or twice in a row go too. The window asks for a kind of menu and a place, never for the items: it cannot make a menu of
// anything but these lists. A box that can be typed in gets the editing menu from what the browser says about it (the main process hears it from `context-menu` of the window).
import type { CommandId } from './commands.js';
import { buildMenu, findCommand, type Entry, type MenuInput } from './menu-model.js';

export const CONTEXT_KINDS = ['tree', 'tab', 'toolbar'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

const LISTS: Readonly<Record<ContextKind, readonly (CommandId | '|')[]>> = {
  tree: [
    'obj.connect', 'doc.vault', 'obj.templates', '|', 'obj.addFolder', 'obj.addConnection', '|', 'obj.edit', 'obj.duplicate', 'obj.transfer', 'obj.bulk', 'obj.favorite', 'obj.remove', '|',
    'doc.properties','doc.password', 'doc.save', 'doc.reload', 'doc.conflicts', 'doc.history', 'doc.forgetKey', 'doc.close', '|', 'tree.expandAll', 'tree.collapseAll',
  ],
  tab: ['session.reconnect', 'session.disconnect', '|', 'tab.moveLeft', 'tab.moveRight', '|', 'session.closeTab'],
  toolbar: ['view.toolbar', 'view.customizeToolbar'],
};

/** The menu of a kind for a state of the window: the items of the menu of the application that apply, with the lines between the groups that are left. Empty when nothing applies. */
export function contextMenu(kind: ContextKind, input: MenuInput): Entry[] {
  const menu = buildMenu(input);
  const out: Entry[] = [];
  for (const item of LISTS[kind]) {
    if (item === '|') { if (out.length > 0 && out.at(-1)!.kind !== 'separator') out.push({ kind: 'separator' }); continue; }
    const entry = findCommand(menu, item);
    if (entry?.enabled) out.push(entry);
  }
  while (out.at(-1)?.kind === 'separator') out.pop();
  return out;
}

/** What the browser says about the place that was clicked (the part of `params` of Electron's `context-menu` that is used). */
export type EditParams = {
  readonly isEditable: boolean;
  readonly selectionText: string;
  readonly editFlags: { readonly canUndo: boolean; readonly canRedo: boolean; readonly canCut: boolean; readonly canCopy: boolean; readonly canPaste: boolean; readonly canSelectAll: boolean };
};

/** The editing menu of a box that can be typed in (the items that cannot be used now are shown off), or Salin alone where text is selected on the page; nothing for anything else. */
export function editMenu(params: EditParams): Entry[] {
  const { editFlags: can } = params;
  const item = (role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll', label: string, on: boolean): Entry => (on ? { kind: 'role', role, label, enabled: true } : { kind: 'plain', label, enabled: false });
  if (params.isEditable) {
    return [item('undo', 'Urungkan', can.canUndo), item('redo', 'Ulangi', can.canRedo), { kind: 'separator' }, item('cut', 'Potong', can.canCut), item('copy', 'Salin', can.canCopy), item('paste', 'Tempel', can.canPaste), { kind: 'separator' }, item('selectAll', 'Pilih Semua', can.canSelectAll)];
  }
  return params.selectionText.trim() !== '' && can.canCopy ? [item('copy', 'Salin', true)] : [];
}

/** The furthest a menu may be asked to open from the corner of the window, in pixels. */
export const MAX_POINT = 20000;
export type ContextRequest = { readonly kind: ContextKind; readonly x: number; readonly y: number };
const isPoint = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_POINT;

/** A place in the window as the main process accepts it: whole numbers from 0 to `MAX_POINT`; what is not a finite number is the corner. (A tab that is scrolled partly out of the window has its left edge before 0.) */
export function toPoint(x: number, y: number): { x: number; y: number } {
  const fit = (n: number) => Math.min(Math.max(Number.isFinite(n) ? Math.round(n) : 0, 0), MAX_POINT);
  return { x: fit(x), y: fit(y) };
}

/** The request in what arrived, or nothing when any part of it is not what it should be: exactly a kind and a place, nothing else. */
export function parseContextRequest(value: unknown): ContextRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['kind', 'x', 'y'].every((k) => Object.hasOwn(value, k))) return undefined;
  const { kind, x, y } = value as Record<string, unknown>;
  if (!CONTEXT_KINDS.includes(kind as ContextKind) || !isPoint(x) || !isPoint(y)) return undefined;
  return { kind: kind as ContextKind, x, y };
}
