// The order of the tabs, as plain functions: where a tab goes when it is moved, where a dragged tab would land, when a press on a tab has become a drag, what is said to a screen reader afterwards, and
// which colour a tab may show. The window (tabs-ui.ts) holds the buttons; the order of the buttons in the page is the one order there is, and these functions say what it becomes.
import { COLORS, type ColorId } from '../documents/meta.js';

/** How far the pointer has to move sideways, in pixels, before a press on a tab is a drag and not a click that wobbled. */
export const DRAG_START = 5;
export function isDrag(dx: number): boolean { return Math.abs(dx) >= DRAG_START; }

/** The tabs in the order they have when `id` sits at `to` among the others (counted without it); a place beyond the ends is the end, a place that is not a finite number (NaN, an infinity) moves nothing, and so does a tab that is not there. Always a new list. */
export function moveTab(ids: readonly string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0 || !Number.isFinite(to)) return [...ids];
  const rest = ids.filter((_, i) => i !== from);
  const at = Math.min(Math.max(Math.floor(to), 0), rest.length);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** What a key press on a tab does to its place: Alt with the left arrow moves it one place to the left, Alt with the right arrow one to the right; any other key, and any other modifier, is for something else. */
export function moveKeyDelta(press: { readonly key: string; readonly altKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean }): -1 | 1 | undefined {
  if (!press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return undefined;
  return press.key === 'ArrowLeft' ? -1 : press.key === 'ArrowRight' ? 1 : undefined;
}

/** One place to the left (-1) or to the right (1); a tab at the end stays. */
export function shiftTab(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id);
  return from < 0 ? [...ids] : moveTab(ids, id, from + delta);
}

/** Where a dragged tab would land among the other tabs: how many of them have their middle to the left of the pointer. `centers` are the middles of the other tabs, left to right. A pointer that is not a number is at the left edge (0), one at plus infinity is past the last tab. */
export function dropIndex(centers: readonly number[], x: number): number {
  return centers.filter((center) => center < x).length;
}

/** What a screen reader is told when a tab has moved: its name and its place. */
export function movedWords(label: string, position: number, count: number): string {
  return label === '' ? `Tab ${position + 1} dari ${count}` : `${label}, tab ${position + 1} dari ${count}`;
}

/** What a screen reader is told when a tab is asked to go further than the end it is at: where it is, and that it is at that end (words other than those of a move, so that they are read). */
export function edgeWords(label: string, position: number, count: number, delta: -1 | 1): string {
  return `${movedWords(label, position, count)}, sudah di ujung ${delta < 0 ? 'kiri' : 'kanan'}`;
}

/** The colour a tab shows: that of its object when it is one of the colours of the palette, else none. */
export function tabColour(value: unknown): ColorId | undefined {
  return COLORS.find((colour) => colour.id === value)?.id;
}
