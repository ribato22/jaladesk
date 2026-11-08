// What is on the toolbar and in what order, as a list of plain items, and what a person can do to it: put a command on or take it off, move it, put a gap (a separator) between two groups.
// A layout is a list of the ids of commands (commands.ts: the ones that have words and a picture for a button) and the mark `|` for a separator. Every layout the code makes is valid: only
// offered commands, none twice, no separator at an end or next to another, and not more than MAX_ITEMS. A layout that was kept in a file may be anything, so it is repaired, not trusted.
import { COMMANDS, spec, type CommandId } from './commands.js';

export const SEPARATOR = '|' as const;
export type Item = CommandId | typeof SEPARATOR;
export type Layout = readonly Item[];
export const MAX_ITEMS = 40;
/** The commands that can be on the toolbar, in the order of the list of commands. */
export const OFFERED: readonly CommandId[] = COMMANDS.filter((c) => c.short !== undefined).map((c) => c.id);
const offered = new Set<string>(OFFERED);

/** What the toolbar starts with: documents, connecting, the objects, favourites, and finding a place to connect to. */
export const DEFAULT_LAYOUT: Layout = [
  'doc.new', 'doc.open', 'doc.save', SEPARATOR,
  'obj.connect', 'session.reconnect', 'session.disconnect', SEPARATOR,
  'obj.addFolder', 'obj.addConnection', 'obj.edit', 'obj.duplicate', 'obj.remove', SEPARATOR,
  'obj.favorite', SEPARATOR,
  'find', 'adhoc.focus',
];

/** The same list with the separators put right: none at the start or the end, and one where there were several. */
export function tidy(layout: readonly Item[]): Item[] {
  const out: Item[] = [];
  for (const item of layout) {
    if (item === SEPARATOR && (out.length === 0 || out[out.length - 1] === SEPARATOR)) continue;
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1] === SEPARATOR) out.pop();
  return out;
}
const isTidy = (layout: Layout) => layout.every((item, i) => item !== SEPARATOR || (i > 0 && i < layout.length - 1 && layout[i + 1] !== SEPARATOR));

/**
 * The layout in what was read from a file: nothing when it is not a list of words, and otherwise the list with what is not offered dropped (a command of a newer version, or a made-up one),
 * a command kept once (the first), no more than MAX_ITEMS, and the separators put right. Not a reason to refuse the file: the person's other choices are still theirs.
 */
export function repairLayout(value: unknown): Layout | undefined {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) return undefined;
  const seen = new Set<string>();
  const kept: Item[] = [];
  for (const item of value as string[]) {
    if (item === SEPARATOR) kept.push(SEPARATOR);
    else if (offered.has(item) && !seen.has(item)) { seen.add(item); kept.push(item as CommandId); }
  }
  return tidy(tidy(kept).slice(0, MAX_ITEMS));
}

/** A command goes on the toolbar, at the end, or comes off it. What is not offered, or does not fit, changes nothing (the same list comes back). */
export function toggle(layout: Layout, id: CommandId): Layout {
  if (!offered.has(id)) return layout;
  if (layout.includes(id)) return tidy(layout.filter((item) => item !== id));
  if (layout.length >= MAX_ITEMS) return layout;
  return tidy([...layout, id]);
}

const place = (layout: Layout, index: number) => Number.isInteger(index) && index >= 0 && index < layout.length;
/** The item at `index` goes one place up (-1) or down (1), when there is a place and the result is a valid layout; otherwise the same list comes back. */
export function move(layout: Layout, index: number, delta: -1 | 1): Layout {
  const target = index + delta;
  if (!place(layout, index) || !place(layout, target)) return layout;
  const swapped = [...layout];
  [swapped[index], swapped[target]] = [swapped[target]!, swapped[index]!];
  return isTidy(swapped) ? swapped : layout;
}
/** A separator goes before the item at `at`, when that is between two items, none of the two is a separator, and there is room. */
export function addSeparator(layout: Layout, at: number): Layout {
  if (!Number.isInteger(at) || at < 1 || at >= layout.length || layout.length >= MAX_ITEMS || layout[at - 1] === SEPARATOR || layout[at] === SEPARATOR) return layout;
  return [...layout.slice(0, at), SEPARATOR, ...layout.slice(at)];
}
/** The item at `index` goes (a separator that is then left at an end goes with it). */
export function removeAt(layout: Layout, index: number): Layout {
  if (!place(layout, index)) return layout;
  return tidy([...layout.slice(0, index), ...layout.slice(index + 1)]);
}
export function sameLayout(a: Layout, b: Layout): boolean { return a.length === b.length && a.every((item, i) => item === b[i]); }

/** What the window draws for an item: a button with its words, its picture and the longer words of the menu for its tooltip, or a gap. */
export type Button = { readonly kind: 'button'; readonly id: CommandId; readonly label: string; readonly icon: string; readonly title: string } | { readonly kind: 'separator' };
export function buttons(layout: Layout): Button[] {
  return layout.flatMap((item): Button[] => {
    if (item === SEPARATOR) return [{ kind: 'separator' }];
    const command = spec(item);
    return command.short !== undefined && command.icon !== undefined ? [{ kind: 'button', id: item, label: command.short, icon: command.icon, title: command.label }] : [];
  });
}

/**
 * Which button the arrow keys go to: Left and Right to the previous and the next one that can be reached (around at the ends), Home and End to the first and the last. `focusable` says for
 * each button whether it can be reached (a button that is off is skipped); nothing comes back for a key that is not for the toolbar or when no button can be reached.
 */
export function rovingNext(focusable: readonly boolean[], current: number, key: string): number | undefined {
  const reach = focusable.flatMap((ok, i) => (ok ? [i] : []));
  if (reach.length === 0) return undefined;
  switch (key) {
    case 'Home': return reach[0];
    case 'End': return reach[reach.length - 1];
    case 'ArrowRight': return reach.find((i) => i > current) ?? reach[0];
    case 'ArrowLeft': return [...reach].reverse().find((i) => i < current) ?? reach[reach.length - 1];
    default: return undefined;
  }
}
/** The one button that the Tab key stops at: the one that was in front, while it can still be reached, else the first that can; -1 when none can. */
export function rovingStop(focusable: readonly boolean[], preferred: number): number { return focusable[preferred] === true ? preferred : focusable.indexOf(true); }
