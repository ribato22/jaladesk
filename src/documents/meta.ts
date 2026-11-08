// What a person can say about an object besides what it is: a note, a colour, an icon and, for a folder, how its children are sorted. All of it lives in
// the object's properties, so it travels with the document and merges field by field like any other property. This module is the one place that knows what
// is allowed: the main process refuses to write anything else, and everything that reads a document takes anything else as "nothing" (another writer, or a
// newer version of this app, may have stored what this one does not know). No Node modules: the window imports it too.
import type { Json, ObjectNode, ObjectType } from './model.js';
import { compareNames, compareSiblings } from './order.js';

export const MAX_NOTES = 4000; // characters

export const COLORS = [
  { id: 'red', label: 'Merah' }, { id: 'orange', label: 'Oranye' }, { id: 'yellow', label: 'Kuning' }, { id: 'green', label: 'Hijau' }, { id: 'teal', label: 'Hijau kebiruan' },
  { id: 'blue', label: 'Biru' }, { id: 'purple', label: 'Ungu' }, { id: 'pink', label: 'Merah muda' }, { id: 'gray', label: 'Abu-abu' },
] as const;
export const ICONS = [
  { id: 'server', label: 'Server' }, { id: 'desktop', label: 'Desktop' }, { id: 'laptop', label: 'Laptop' }, { id: 'database', label: 'Basis data' },
  { id: 'cloud', label: 'Awan' }, { id: 'network', label: 'Jaringan' }, { id: 'router', label: 'Router' }, { id: 'shield', label: 'Perisai' },
  { id: 'key', label: 'Kunci' }, { id: 'terminal', label: 'Terminal' }, { id: 'globe', label: 'Bola dunia' }, { id: 'printer', label: 'Printer' },
  { id: 'phone', label: 'Telepon' }, { id: 'chip', label: 'Cip' }, { id: 'wrench', label: 'Perkakas' }, { id: 'box', label: 'Kotak' },
] as const;
export type ColorId = (typeof COLORS)[number]['id'];
export type IconId = (typeof ICONS)[number]['id'];

export type SortBy = 'name' | 'type';
export type SortDir = 'asc' | 'desc';
export type SortCriterion = { by: SortBy; dir: SortDir };
/** One criterion per property, so as many as there are properties to sort by: the name and the type (a date needs a newer schema). */
export const MAX_SORT = 2;

type Props = Record<string, Json>;
const own = (props: Props, key: string): Json | undefined => (Object.hasOwn(props, key) ? props[key] : undefined); // "constructor" is not a property that was stored

/** The sort setting if `value` is one: one or two criteria, each a different property with a direction. Anything else is not a setting. */
function readSort(value: Json | undefined): SortCriterion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SORT) return undefined;
  const found: SortCriterion[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item) || Object.keys(item).length !== 2) return undefined;
    const { by, dir } = item;
    if ((by !== 'name' && by !== 'type') || (dir !== 'asc' && dir !== 'desc') || found.some((c) => c.by === by)) return undefined;
    found.push({ by, dir });
  }
  return found;
}

export const notesOf = (props: Props): string => { const value = own(props, 'notes'); return typeof value === 'string' ? value : ''; };
export const colorOf = (props: Props): ColorId | undefined => { const value = own(props, 'color'); return COLORS.find((c) => c.id === value)?.id; };
export const iconOf = (props: Props): IconId | undefined => { const value = own(props, 'icon'); return ICONS.find((i) => i.id === value)?.id; };
/** How the children of a folder are sorted; none (the manual order) when nothing valid is stored. */
export const sortOf = (props: Props): SortCriterion[] => readSort(own(props, 'sort')) ?? [];

export type MetaProblem = { field: 'notes' | 'color' | 'icon' | 'sort'; message: string };
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // a line break and a tab are text, the rest is not

/** What may not be written: the strict counterpart of the readers above (an empty setting is not stored; the writer removes the property instead). */
export function checkMeta(type: ObjectType, props: Props): MetaProblem[] {
  const problems: MetaProblem[] = [];
  if (Object.hasOwn(props, 'notes')) {
    const value = props.notes;
    if (typeof value !== 'string') problems.push({ field: 'notes', message: 'Catatan harus berupa teks.' });
    else if (value.length > MAX_NOTES) problems.push({ field: 'notes', message: `Catatan paling banyak ${MAX_NOTES} karakter.` });
    else if (CONTROL.test(value)) problems.push({ field: 'notes', message: 'Catatan memuat karakter kontrol.' });
  }
  if (Object.hasOwn(props, 'color') && colorOf(props) === undefined) problems.push({ field: 'color', message: 'Warna itu tidak ada dalam daftar.' });
  if (Object.hasOwn(props, 'icon') && iconOf(props) === undefined) problems.push({ field: 'icon', message: 'Ikon itu tidak ada dalam daftar.' });
  if (Object.hasOwn(props, 'sort')) {
    if (type !== 'folder') problems.push({ field: 'sort', message: 'Hanya folder yang diurutkan.' });
    else if (readSort(props.sort) === undefined) problems.push({ field: 'sort', message: 'Pengaturan urutan tidak valid.' });
  }
  return problems;
}

const typeRank = (o: ObjectNode): number => (o.type === 'folder' ? 0 : 1);
const protocolOf = (o: ObjectNode): string => { const value = own(o.props, 'protocol'); return typeof value === 'string' ? value : ''; };
const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The order in which the children of a sorted folder are shown: the criteria one after the other (the name as a person reads it; the type: folders before
 * connections, connections of one protocol together), and what they leave equal by the manual order, then the name, then the id, so that the result
 * never depends on the order the objects arrive in. No criteria is the manual order itself.
 */
export function compareFor(sort: readonly SortCriterion[]): (a: ObjectNode, b: ObjectNode) => number {
  if (sort.length === 0) return compareSiblings;
  return (a, b) => {
    for (const { by, dir } of sort) {
      const result = by === 'name' ? compareNames(a.name, b.name) : typeRank(a) - typeRank(b) || text(protocolOf(a), protocolOf(b));
      if (result !== 0) return dir === 'asc' ? result : -result;
    }
    return compareSiblings(a, b);
  };
}
