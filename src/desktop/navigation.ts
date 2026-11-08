// View-model of the navigation panel: the flat list of rows the tree shows, which of them are drawn for a scroll position, the keyboard moves between
// them, and where a dragged object goes when it is dropped. Pure functions of the open documents and of which folders are expanded; the DOM code
// draws what this returns and nothing else decides what a row is or where a drop lands.
import { colorOf, iconOf, notesOf, sortOf, type ColorId, type IconId } from '../documents/meta.js';
import type { ObjectNode, ObjectType } from '../documents/model.js';
import { sortedChildren, type DocModel } from './docmodel.js';

export type Row = {
  key: string;            // unique in the panel: documentKey() or objectKey()
  sessionId: string;
  objectId?: string;      // absent on a document row
  type: ObjectType | 'document';
  name: string;
  depth: number;          // 0 for a document
  level: number;          // depth + 1, the aria-level
  setSize: number;        // how many siblings there are (the rows are drawn a window at a time, so the browser cannot count them)
  posInSet: number;       // the 1-based place among them
  expanded: boolean;      // true only for a row that has children and is open
  hasChildren: boolean;
  parentKey?: string;     // absent on a document row
  dirty?: boolean;        // document rows only: unsaved changes
  conflicts?: number;     // document rows only: how many conflicts are held back (there only when there are some)
  compared?: 'gone' | 'changed'; // the rows of an earlier version only: the document does not have the object any more, or it is not the same
  // What the object chose to be seen as. Each is there only when it holds: a value this app does not know is not a mark.
  icon?: IconId;
  color?: ColorId;
  favorite?: boolean;     // the person's own choice on this computer (not part of the document)
  note?: boolean;         // it has notes
  sorted?: boolean;       // a folder whose children are sorted by a setting: a place among them means nothing
};
/** What narrows the tree: words that must all be found (in the name, the host and, when asked, the notes), and whether only favourites count. */
export type RowFilter = { query: string; notes: boolean; onlyFavorites: boolean };
export type RowView = { filter?: RowFilter; favorites?: ReadonlyMap<string, ReadonlySet<string>>; compared?: ReadonlyMap<string, 'gone' | 'changed'> }; // favourites by session id; `compared` by the key of the row
/** Whether a filter narrows the tree at all: it has a word (spaces are not one), or it asks for favourites only. */
export const narrows = (filter: RowFilter | undefined): filter is RowFilter => filter !== undefined && (filter.onlyFavorites || fold(filter.query).trim() !== '');

export const ROW_HEIGHT = 28;

export const documentKey = (sessionId: string): string => `d:${sessionId}`;
export const objectKey = (sessionId: string, objectId: string): string => `o:${sessionId}:${objectId}`;
export function parseKey(key: string): { sessionId: string; objectId?: string } | undefined {
  const parts = key.split(':');
  if (parts.length === 2 && parts[0] === 'd' && parts[1]) return { sessionId: parts[1] };
  if (parts.length === 3 && parts[0] === 'o' && parts[1] && parts[2]) return { sessionId: parts[1], objectId: parts[2] };
  return undefined;
}

/** Text as a person compares it: without case, without accents, composed or not. */
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
// What an object is searched by is folded once for as long as the object is the same (an edit makes a new object).
const names = new WeakMap<ObjectNode, string>();
const notes = new WeakMap<ObjectNode, string>();
const nameAndHost = (o: ObjectNode): string => {
  let found = names.get(o);
  if (found === undefined) { const host = Object.hasOwn(o.props, 'host') ? o.props.host : undefined; found = fold(`${o.name}\n${typeof host === 'string' ? host : ''}`); names.set(o, found); }
  return found;
};
const notesOfFolded = (o: ObjectNode): string => {
  let found = notes.get(o);
  if (found === undefined) { found = fold(notesOf(o.props)); notes.set(o, found); }
  return found;
};

/** The ids of the objects a filter keeps: those that match, and the folders above them (so that a match is never shown without where it is). */
function kept(model: DocModel, filter: RowFilter, favorites: ReadonlySet<string> | undefined): Set<string> {
  const terms = fold(filter.query).split(/\s+/).filter(Boolean);
  const keep = new Set<string>();
  for (const o of model.objects.values()) {
    if (filter.onlyFavorites && !favorites?.has(o.id)) continue;
    if (terms.length > 0) {
      const own = nameAndHost(o), written = filter.notes ? notesOfFolded(o) : '';
      if (!terms.every((term) => own.includes(term) || (written !== '' && written.includes(term)))) continue;
    }
    for (let at: ObjectNode | undefined = o; at && !keep.has(at.id); at = at.parentId === null ? undefined : model.objects.get(at.parentId)) keep.add(at.id);
  }
  return keep;
}

function marks(o: ObjectNode, favorite: boolean): Partial<Row> {
  const icon = iconOf(o.props), color = colorOf(o.props);
  return {
    ...(icon ? { icon } : {}), ...(color ? { color } : {}), ...(favorite ? { favorite: true } : {}),
    ...(notesOf(o.props) !== '' ? { note: true } : {}), ...(o.type === 'folder' && sortOf(o.props).length > 0 ? { sorted: true } : {}),
  };
}

/** Whether the children of a folder (not the top level) are shown in the order of a sort setting. */
export const isSorted = (model: DocModel, folderId: string | null): boolean => folderId===null?(model.meta?.sort.length??0)>0:sortOf(model.objects.get(folderId)?.props ?? {}).length > 0;

/**
 * The rows of the tree. With a filter that has words or asks for favourites, only the objects it keeps are rows, and every folder that has one below it is open,
 * whatever `expanded` says; without, the folders in `expanded` are open.
 */
export function buildRows(models: readonly DocModel[], expanded: ReadonlySet<string>, view: RowView = {}): Row[] {
  const rows: Row[] = [];
  const filter = narrows(view.filter) ? view.filter : undefined;
  models.forEach((model, at) => {
    const favorites = view.favorites?.get(model.id);
    const keep = filter ? kept(model, filter, favorites) : undefined;
    const rootKey = documentKey(model.id);
    const hasKids = keep ? sortedChildren(model, null).some((o) => keep.has(o.id)) : model.children.has(null);
    const open = keep ? hasKids : expanded.has(rootKey);
    rows.push({ key: rootKey, sessionId: model.id, type: 'document', name: model.name, depth: 0, level: 1, setSize: models.length, posInSet: at + 1, expanded: open, hasChildren: hasKids, dirty: model.dirty, ...(model.conflicts > 0 ? { conflicts: model.conflicts } : {}) });
    if (!open) return;
    const walk = (parentId: string | null, parentKey: string, depth: number): void => {
      const siblings = keep ? sortedChildren(model, parentId).filter((o) => keep.has(o.id)) : sortedChildren(model, parentId);
      siblings.forEach((o, index) => {
        const key = objectKey(model.id, o.id);
        const hasChildren = keep ? sortedChildren(model, o.id).some((c) => keep.has(c.id)) : model.children.has(o.id);
        const isOpen = hasChildren && (keep ? true : expanded.has(key));
        rows.push({ key, sessionId: model.id, objectId: o.id, type: o.type, name: o.name, depth, level: depth + 1, setSize: siblings.length, posInSet: index + 1, expanded: isOpen, hasChildren, parentKey, ...marks(o, favorites?.has(o.id) === true), ...(view.compared?.get(key) ? { compared: view.compared.get(key)! } : {}) });
        if (isOpen) walk(o.id, key, depth + 1);
      });
    };
    walk(null, rootKey, 1);
  });
  return rows;
}

/** Every document and every folder that has something in it, open. */
export function allExpanded(models: readonly DocModel[]): Set<string> {
  const keys = new Set<string>();
  for (const model of models) {
    keys.add(documentKey(model.id));
    for (const [parentId, ids] of model.children) if (parentId !== null && ids.size > 0) keys.add(objectKey(model.id, parentId));
  }
  return keys;
}

/** Only the documents open: every folder closed. */
export const onlyDocuments = (models: readonly DocModel[]): Set<string> => new Set(models.map((m) => documentKey(m.id)));

/** The row that stays selected once the tree is rebuilt: the same row if it is still shown, else its own document's row, else the first row. */
export function keepSelection(rows: readonly Row[], selected: string | undefined): string | undefined {
  if (selected && rows.some((r) => r.key === selected)) return selected;
  const parsed = parseKey(selected ?? '');
  const home = parsed && documentKey(parsed.sessionId);
  if (home && rows.some((r) => r.key === home)) return home;
  return rows[0]?.key;
}

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';
export type Move = { focus?: string; toggle?: { key: string; expanded: boolean } };

/** What a navigation key does in a tree (the WAI-ARIA tree pattern): move focus, or open or close a folder. */
export function navigate(rows: readonly Row[], current: string | undefined, key: NavKey): Move {
  if (rows.length === 0) return {};
  const at = rows.findIndex((r) => r.key === current);
  if (at < 0) return { focus: rows[key === 'End' ? rows.length - 1 : 0]!.key };
  const row = rows[at]!;
  switch (key) {
    case 'ArrowDown': return { focus: rows[Math.min(at + 1, rows.length - 1)]!.key };
    case 'ArrowUp': return { focus: rows[Math.max(at - 1, 0)]!.key };
    case 'Home': return { focus: rows[0]!.key };
    case 'End': return { focus: rows[rows.length - 1]!.key };
    case 'ArrowRight':
      if (!row.hasChildren) return {};
      return row.expanded ? { focus: rows[at + 1]!.key } : { toggle: { key: row.key, expanded: true } };
    case 'ArrowLeft':
      if (row.hasChildren && row.expanded) return { toggle: { key: row.key, expanded: false } };
      return row.parentKey ? { focus: row.parentKey } : {};
  }
}

// ---- drawing only what can be seen --------------------------------------------------------------------------------------------------------

/** The rows to draw for a scroll position: those in view and a few above and below them, as the half-open range [start, end). */
export function windowOf(count: number, scrollTop: number, viewport: number, rowHeight = ROW_HEIGHT, overscan = 8): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  const start = Math.min(count, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { start, end: Math.max(start, end) };
}

/** The scroll position that shows row `index` with the least movement: the same one when the row is in view already. */
export function scrollTopFor(index: number, scrollTop: number, viewport: number, rowHeight = ROW_HEIGHT): number {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return Math.max(0, top + rowHeight - viewport);
  return scrollTop;
}

// ---- moving objects: by dropping them, and by keys ----------------------------------------------------------------------------------------

export type DropZone = 'before' | 'into' | 'after';

/** Which part of a row a pointer is over: the top and bottom quarters put the dragged object before or after the row, the middle puts it into the row; a row that cannot hold anything is only before (upper half) or after. */
export function dropZone(offsetY: number, height: number, canContain: boolean): DropZone {
  const at = height > 0 ? offsetY / height : 0.5;
  if (canContain) return at < 0.25 ? 'before' : at > 0.75 ? 'after' : 'into';
  return at < 0.5 ? 'before' : 'after';
}

export type Drop = { sessionId: string; objectId: string; parentId: string | null; index: number };
export type Refusal = 'nothing' | 'other-document' | 'cycle' | 'same-place' | 'sorted';

/**
 * Where dropping `dragKey` on `targetKey` (in `zone`) puts the object: the folder (or the top level) and the position among that folder's children
 * counted without the object itself, which is how the main process takes it. Or why it cannot go: an object cannot be dropped on itself or into its own
 * folder tree, not into another document, and dropping it where it already is changes nothing. A sorted folder chooses the place of its children itself: an object
 * from outside is appended to it (the sort puts it where it belongs), and one that is in it already cannot be put elsewhere in it.
 */
export function resolveDrop(models: ReadonlyMap<string, DocModel>, dragKey: string, targetKey: string, zone: DropZone): Drop | { refused: Refusal } {
  const dragged = parseKey(dragKey);
  const target = parseKey(targetKey);
  if (!dragged?.objectId || !target) return { refused: 'nothing' };
  if (dragged.sessionId !== target.sessionId) return { refused: 'other-document' };
  const model = models.get(dragged.sessionId);
  const node = model?.objects.get(dragged.objectId);
  if (!model || !node) return { refused: 'nothing' };
  let parentId!: string | null; // both are set by every branch below (place() sets them from inside)
  let index!: number;
  const place = (parent: string | null, after: string | undefined): void => {
    parentId = parent;
    const siblings = sortedChildren(model, parent).filter((o) => o.id !== node.id);
    index = after === undefined ? siblings.length : siblings.findIndex((o) => o.id === after) + 1;
  };
  if (!target.objectId) {
    place(null, undefined);
  } else {
    const t = model.objects.get(target.objectId);
    if (!t) return { refused: 'nothing' };
    if (t.id === node.id) return { refused: 'same-place' };
    if (zone === 'into' && t.type === 'folder') place(t.id, undefined);
    else {
      const siblings = sortedChildren(model, t.parentId).filter((o) => o.id !== node.id);
      const at = siblings.findIndex((o) => o.id === t.id);
      parentId = t.parentId;
      index = zone === 'before' ? at : at + 1;
    }
  }
  for (let cursor: string | null = parentId; cursor !== null; cursor = model.objects.get(cursor)?.parentId ?? null) if (cursor === node.id) return { refused: 'cycle' };
  if (isSorted(model, parentId)) {
    if (parentId === node.parentId) return { refused: 'sorted' };
    return { sessionId: model.id, objectId: node.id, parentId, index: sortedChildren(model, parentId).filter((o) => o.id !== node.id).length };
  }
  const current = sortedChildren(model, node.parentId).findIndex((o) => o.id === node.id);
  if (parentId === node.parentId && index === current) return { refused: 'same-place' };
  return { sessionId: model.id, objectId: node.id, parentId, index };
}

export type Direction = 'up' | 'down' | 'out' | 'in';

/** Where a key moves an object: up or down among its siblings (not in a sorted folder, which keeps its own order), out of its folder (to right after it), or into the folder just above it. Nothing when it cannot go that way. */
export function moveTarget(model: DocModel, objectId: string, direction: Direction): { parentId: string | null; index: number } | undefined {
  const node = model.objects.get(objectId);
  if (!node) return undefined;
  const siblings = sortedChildren(model, node.parentId);
  const at = siblings.findIndex((o) => o.id === objectId);
  switch (direction) {
    case 'up': return at > 0 && !isSorted(model, node.parentId) ? { parentId: node.parentId, index: at - 1 } : undefined;
    case 'down': return at < siblings.length - 1 && !isSorted(model, node.parentId) ? { parentId: node.parentId, index: at + 1 } : undefined;
    case 'out': {
      const parent = node.parentId === null ? undefined : model.objects.get(node.parentId);
      return parent ? { parentId: parent.parentId, index: sortedChildren(model, parent.parentId).findIndex((o) => o.id === parent.id) + 1 } : undefined;
    }
    case 'in': {
      const above = at > 0 ? siblings[at - 1] : undefined;
      return above?.type === 'folder' ? { parentId: above.id, index: sortedChildren(model, above.id).length } : undefined;
    }
  }
}
