// The tree as the window draws it. Only the rows that can be seen (and a few beyond) are elements, whatever the size of the document: the list of rows
// lives in memory (navigation.ts builds it) and a spacer as tall as all of them gives the scroll bar its length. Focus stays on the tree itself and
// the selected row is named by aria-activedescendant, because a row that has scrolled out of view is not an element to hold focus. A row that stays
// in view stays the same element when the tree is drawn again, so a scroll only adds and removes the rows at its two ends; the row being dragged is
// kept as an element wherever the tree is scrolled, because the end of its drag is reported to that element and must reach the tree. A dragged object
// near the top or bottom edge makes the tree scroll without any code here: the browser scrolls the nearest scrollable box by itself. The DOM is built
// with textContent and attributes, never innerHTML. What an object chose to be seen as (an icon, a colour) and what is worth a mark (notes, a sorted folder, a
// favourite) is drawn on its row; the same is said in words to a screen reader, because a colour or a symbol alone is not said at all.
import { COLORS } from '../documents/meta.js';
import { iconElement } from './icons.js';
import { ROW_HEIGHT, dropZone, scrollTopFor, windowOf, type DropZone, type Row } from './navigation.js';

export type TreeHooks = {
  select(key: string): void;
  toggle(key: string, open: boolean): void;
  activate(key: string): void;
  key(event: KeyboardEvent): void;
  canDrop(dragKey: string, targetKey: string, zone: DropZone): boolean;
  drop(dragKey: string, targetKey: string, zone: DropZone): void;
  openForDrop(key: string): void;
};
export type TreeView = {
  /** The rows to show and the selected one; draws the window that is in view. */
  render(rows: readonly Row[], selected: string | undefined): void;
  /** Moves the selection without redrawing, so that a double click lands on the row the first click hit. */
  setSelected(key: string | undefined): void;
  /** Scrolls the least that shows the row. */
  reveal(key: string): void;
  focus(): void;
  hasFocus(): boolean;
  rowsInDom(): number;
};

const glyph = { document: '▦', folder: '▣', connection: '▭' } as const;
const DRAG_TYPE = 'application/x-remote-workspace-row'; // only a row of this tree can be dropped on it: a file or a link dragged in from outside is not
const OPEN_AFTER_MS = 700;                                // how long a dragged object rests on a closed folder before it opens

/** `readOnly`: the rows cannot be dragged (the tree of an earlier version of a document, which nothing can be moved in). */
export function createTreeView(tree: HTMLElement, hooks: TreeHooks, options: { readOnly?: boolean } = {}): TreeView {
  const sizer = document.createElement('div');
  sizer.className = 'tree-sizer';
  tree.replaceChildren(sizer);
  let rows: readonly Row[] = [];
  let indexOf = new Map<string, number>();                // a row's place in `rows`, by key
  let selected: string | undefined;
  let dragging: string | undefined;
  let over: { key: string; zone: DropZone } | undefined;
  let openTimer: number | undefined;
  let frame = 0;
  const live = new Map<string, HTMLElement>();            // the rows that are elements now, by key
  const viewport = () => tree.clientHeight || ROW_HEIGHT * 10;
  const rowOf = (key: string): Row | undefined => rows[indexOf.get(key) ?? -1];
  const classOf = (row: Row) => (over?.key === row.key ? `row ${row.type} drop-${over.zone}` : `row ${row.type}`);
  const paintDrop = (): void => { for (const [key, item] of live) item.className = classOf(rowOf(key)!); };
  const signature = (row: Row, index: number) => [row.key, row.type, row.name, row.level, row.setSize, row.posInSet, row.expanded, row.hasChildren, row.dirty ?? false, row.icon ?? '', row.color ?? '', row.favorite ?? false, row.note ?? false, row.sorted ?? false, row.conflicts ?? 0, row.compared ?? '', index].join('\u0000');

  /** Writes what a row looks like into its element (the element itself stays where it is in the page). */
  function fill(item: HTMLElement, row: Row, index: number): void {
    item.id = `row-${row.key}`;
    item.setAttribute('role', 'treeitem');
    item.dataset.key = row.key;
    item.dataset.sig = signature(row, index);
    item.setAttribute('aria-level', String(row.level));
    item.setAttribute('aria-setsize', String(row.setSize));
    item.setAttribute('aria-posinset', String(row.posInSet));
    if (row.hasChildren) item.setAttribute('aria-expanded', String(row.expanded)); else item.removeAttribute('aria-expanded');
    item.draggable = options.readOnly !== true && row.type !== 'document';
    item.style.top = `${index * ROW_HEIGHT}px`;
    item.style.paddingLeft = `${8 + row.depth * 16}px`;
    item.className = classOf(row);
    if (row.color) item.dataset.color = row.color; else delete item.dataset.color;
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.setAttribute('aria-hidden', 'true');
    twisty.textContent = row.hasChildren ? (row.expanded ? '▾' : '▸') : '';
    const icon = document.createElement('span');
    icon.className = 'glyph';
    icon.setAttribute('aria-hidden', 'true');
    if (row.icon) icon.append(iconElement(row.icon)); else icon.textContent = glyph[row.type === 'document' || row.type === 'folder' ? row.type : 'connection'];
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.name;
    item.replaceChildren(twisty, icon, name);
    const colour = row.color ? COLORS.find((c) => c.id === row.color)?.label : undefined;
    if (colour) icon.title = colour;
    const said: string[] = colour ? [colour] : [];
    const marks = document.createElement('span');
    marks.className = 'marks';
    const flag = (kind: string, symbol: string, title: string): void => {
      const mark = document.createElement('span');
      mark.className = `mark ${kind}`;
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = symbol;
      mark.title = title;
      marks.append(mark);
      said.push(title.toLowerCase());
    };
    if (row.note) flag('mark-note', '✎', 'Ada catatan');
    if (row.sorted) flag('mark-sorted', '⇅', 'Diurutkan otomatis');
    if (row.favorite) flag('mark-fav', '★', 'Favorit');
    if (row.conflicts) flag('mark-conflict', '⚠', `${row.conflicts} konflik`);
    if (row.compared === 'gone') flag('mark-gone', '✕', 'Tidak ada lagi di dokumen');
    if (row.compared === 'changed') flag('mark-changed', '≠', 'Berbeda dari dokumen sekarang');
    if (marks.childElementCount > 0) item.append(marks);
    if (said.length > 0) {
      const words = document.createElement('span');
      words.className = 'sr-only';
      words.textContent = `, ${said.join(', ')}`;
      item.append(words);
    }
    if (row.dirty) {
      const mark = document.createElement('span');
      mark.className = 'dirty';
      mark.textContent = '●';
      mark.title = 'Belum disimpan';
      mark.setAttribute('aria-label', 'belum disimpan');
      item.append(mark);
    }
  }

  function draw(): void {
    sizer.style.height = `${rows.length * ROW_HEIGHT}px`;
    // A list that has just got shorter leaves the scroll position beyond its end until the browser lays the tree out again, and a window taken from that position is empty:
    // the window is taken from the position the tree will have by then.
    const top = Math.min(tree.scrollTop, Math.max(0, rows.length * ROW_HEIGHT - viewport()));
    const { start, end } = windowOf(rows.length, top, viewport());
    const want = new Map<string, number>();
    for (let i = start; i < end; i++) want.set(rows[i]!.key, i);
    for (const key of [selected, dragging]) {              // elements wherever the tree is scrolled: the active row is named, the dragged row must stay in the page
      const i = key === undefined ? undefined : indexOf.get(key);
      if (key !== undefined && i !== undefined) want.set(key, i);
    }
    for (const [key, item] of live) if (!want.has(key)) { item.remove(); live.delete(key); }
    let cursor = sizer.firstElementChild;
    for (const [key, i] of [...want].sort((a, b) => a[1] - b[1])) {   // in the order of the rows; a row that is already in place is not touched
      const row = rows[i]!;
      let item = live.get(key);
      if (!item) { item = document.createElement('div'); live.set(key, item); }
      if (item.dataset.sig !== signature(row, i)) fill(item, row, i);
      const chosen = String(key === selected);
      if (item.getAttribute('aria-selected') !== chosen) item.setAttribute('aria-selected', chosen);
      if (item === cursor) cursor = cursor.nextElementSibling; else sizer.insertBefore(item, cursor);
    }
    if (selected !== undefined && indexOf.has(selected)) tree.setAttribute('aria-activedescendant', `row-${selected}`); else tree.removeAttribute('aria-activedescendant');
  }

  const clearDrop = (): void => {
    window.clearTimeout(openTimer);
    openTimer = undefined;
    if (over) { over = undefined; paintDrop(); }
  };
  const endDrag = (): void => {
    clearDrop();
    if (dragging !== undefined) { dragging = undefined; draw(); }
  };
  const itemOf = (event: Event): HTMLElement | null => (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]');

  tree.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); }, { passive: true });
  new ResizeObserver(() => draw()).observe(tree);
  tree.addEventListener('click', (event) => {
    const item = itemOf(event);
    if (!item?.dataset.key) return;
    hooks.select(item.dataset.key);
    if ((event.target as HTMLElement).classList.contains('twisty') && item.hasAttribute('aria-expanded')) hooks.toggle(item.dataset.key, item.getAttribute('aria-expanded') !== 'true');
  });
  tree.addEventListener('dblclick', (event) => { const item = itemOf(event); if (item?.dataset.key) hooks.activate(item.dataset.key); });
  tree.addEventListener('keydown', (event) => hooks.key(event));

  tree.addEventListener('dragstart', (event) => {
    const item = itemOf(event);
    if (!item?.dataset.key || item.getAttribute('draggable') !== 'true' || !event.dataTransfer) { event.preventDefault(); return; }
    dragging = item.dataset.key;
    event.dataTransfer.setData(DRAG_TYPE, dragging);
    event.dataTransfer.effectAllowed = 'move';
  });
  /** The row, and the part of it, that a drag event is over, when what is dragged can be dropped there. */
  const targetOf = (event: DragEvent): { row: Row; zone: DropZone } | undefined => {
    const item = itemOf(event);
    const row = item?.dataset.key ? rowOf(item.dataset.key) : undefined;
    if (!item || !row || dragging === undefined) return undefined;
    const rect = item.getBoundingClientRect();
    const zone: DropZone = row.type === 'document' ? 'into' : dropZone(event.clientY - rect.top, rect.height, row.type === 'folder');
    return hooks.canDrop(dragging, row.key, zone) ? { row, zone } : undefined;
  };
  tree.addEventListener('dragover', (event) => {
    if (dragging === undefined || !event.dataTransfer?.types.includes(DRAG_TYPE)) return;
    const target = targetOf(event);
    if (!target) { clearDrop(); return; }                        // no preventDefault: the pointer shows that it cannot be dropped here
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (over?.key === target.row.key && over.zone === target.zone) return;
    clearDrop();
    over = { key: target.row.key, zone: target.zone };
    paintDrop();
    if (target.zone === 'into' && target.row.hasChildren && !target.row.expanded) openTimer = window.setTimeout(() => hooks.openForDrop(target.row.key), OPEN_AFTER_MS);
  });
  tree.addEventListener('drop', (event) => {
    event.preventDefault();
    const from = dragging;
    const target = from === undefined ? undefined : targetOf(event); // where the pointer lets go, not where the last dragover was: rows can move under a pointer that stands still
    endDrag();
    if (from !== undefined && target) hooks.drop(from, target.row.key, target.zone);
  });
  tree.addEventListener('dragend', endDrag);
  tree.addEventListener('dragleave', (event) => { if (!tree.contains(event.relatedTarget as Node | null)) clearDrop(); });

  return {
    render(next, key) {
      rows = next;
      indexOf = new Map();
      for (let i = 0; i < next.length; i++) indexOf.set(next[i]!.key, i);
      selected = key;
      if (dragging !== undefined && !indexOf.has(dragging)) dragging = undefined; // what was dragged is gone from the list (another change took it away)
      draw();
    },
    setSelected(key) {
      selected = key;
      for (const [k, item] of live) item.setAttribute('aria-selected', String(k === key));
      if (key !== undefined && indexOf.has(key) && !live.has(key)) draw();
      if (key !== undefined && indexOf.has(key)) tree.setAttribute('aria-activedescendant', `row-${key}`); else tree.removeAttribute('aria-activedescendant');
    },
    reveal(key) {
      const at = indexOf.get(key);
      if (at === undefined) return;
      const wanted = scrollTopFor(at, tree.scrollTop, viewport());
      if (wanted !== tree.scrollTop) tree.scrollTop = wanted; // the scroll event draws the new window
    },
    focus() { tree.focus(); },
    hasFocus() { return document.activeElement === tree; },
    rowsInDom() { return live.size; },
  };
}
