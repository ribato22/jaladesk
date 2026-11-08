// What the properties dialog starts from and what it changes. The dialog shows an object's settings (a connection's), its notes, colour and icon and (a folder's) sort;
// what it sends is a patch: only what the person changed, so that everything else, including what another writer changed meanwhile, stays as the document holds it.
import { colorOf, iconOf, notesOf, sortOf, type ColorId, type IconId, type SortCriterion } from '../documents/meta.js';
import type { Json, ObjectNode } from '../documents/model.js';
import { DEFAULT_RDP, fromProps, type RdpSettings } from './connection-settings.js';
import type { DocModel } from './docmodel.js';

export type Meta = { notes: string; color?: ColorId; icon?: IconId; sort: SortCriterion[] }; // no sort: the manual order
export type PropertyPatch = { set?: Record<string, Json>; unset?: string[] };

/** What is stored of an object's notes, colour, icon and sort, as far as it is valid; only a folder has a sort. Notes come with one kind of line break, as the dialog's text box gives them back. */
export function metaOf(node: ObjectNode): Meta {
  const color = colorOf(node.props), icon = iconOf(node.props);
  return { notes: notesOf(node.props).replace(/\r\n?/g, '\n'), ...(color ? { color } : {}), ...(icon ? { icon } : {}), sort: node.type === 'folder' ? sortOf(node.props) : [] };
}

/** The properties that say what `meta` says, for an object that is new: only what is given (an empty note or no sort is not stored). */
export function metaProps(meta: Meta): Record<string, Json> {
  const props: Record<string, Json> = {};
  if (meta.notes !== '') props.notes = meta.notes;
  if (meta.color) props.color = meta.color;
  if (meta.icon) props.icon = meta.icon;
  if (meta.sort.length > 0) props.sort = meta.sort.map((c) => ({ by: c.by, dir: c.dir }));
  return props;
}

/** The properties of `after` that `before` did not have the same: what the dialog may be held to (a stored value that it did not change was not written by it). */
export function changedMetaProps(before: Meta, after: Meta): Record<string, Json> {
  const was = metaProps(before);
  return Object.fromEntries(Object.entries(metaProps(after)).filter(([key, value]) => !Object.hasOwn(was, key) || JSON.stringify(was[key]) !== JSON.stringify(value)));
}

/** The RDP settings the dialog shows for a connection that is RDP or not marked yet. A connection of another protocol keeps its settings: they are not this dialog's to change. */
export function rdpOf(node: ObjectNode): RdpSettings | undefined {
  if (node.type !== 'connection') return undefined;
  const protocol = Object.hasOwn(node.props, 'protocol') ? node.props.protocol : undefined;
  return typeof protocol === 'string' && protocol !== 'rdp' ? undefined : fromProps(node.props);
}

/** How many folders are below a folder, at any depth (the folder itself is not counted). */
export function subfolderCount(model: DocModel, folderId: string): number {
  let count = 0;
  const pending = [folderId];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const childId of model.children.get(id) ?? []) {
      if (model.objects.get(childId)?.type === 'folder') count++;
      pending.push(childId);
    }
  }
  return count;
}

const sameSort = (a: readonly SortCriterion[], b: readonly SortCriterion[]): boolean => a.length === b.length && a.every((c, i) => c.by === b[i]!.by && c.dir === b[i]!.dir);
const SETTINGS = ['host', 'port', 'username', 'certificateSha256', 'clipboardToRemote', 'clipboardFromRemote'] as const;

/**
 * The patch that turns what the dialog started from into what it ended with, or nothing when nothing changed. A connection that is not marked as RDP (the dialog shows it as one) is
 * marked by OK, and a setting that is stored with the wrong type is not what the dialog showed (it showed the default): what the dialog ends with is written for it, changed
 * or not, so that pressing OK repairs a connection that could not be opened. With `spread` (the sort is to be given to the folders below) the sort the dialog shows is in the
 * patch whether or not it changed, because that is what the folders below get.
 */
export function patchFor(node: ObjectNode, before: { rdp?: RdpSettings; meta: Meta }, after: { rdp?: RdpSettings; meta: Meta }, options: { spread?: boolean } = {}): PropertyPatch | undefined {
  const set: Record<string, Json> = {};
  const unset: string[] = [];
  if (before.rdp && after.rdp) {
    const b = before.rdp, a = after.rdp;
    const wrong = (key: (typeof SETTINGS)[number]) => Object.hasOwn(node.props, key) && typeof node.props[key] !== typeof DEFAULT_RDP[key];
    if (a.host !== b.host) set.host = a.host;                    // a host or user of the wrong type shows as empty, which the dialog refuses: the person always types one
    if (a.port !== b.port || wrong('port')) set.port = a.port;
    if (a.username !== b.username) set.username = a.username;
    if (a.certificateSha256.toLowerCase() !== b.certificateSha256.toLowerCase() || wrong('certificateSha256')) { if (a.certificateSha256 === '') unset.push('certificateSha256'); else set.certificateSha256 = a.certificateSha256.toLowerCase(); }
    if (a.clipboardToRemote !== b.clipboardToRemote || wrong('clipboardToRemote')) set.clipboardToRemote = a.clipboardToRemote;
    if (a.clipboardFromRemote !== b.clipboardFromRemote || wrong('clipboardFromRemote')) set.clipboardFromRemote = a.clipboardFromRemote;
    if (node.props.protocol !== 'rdp') set.protocol = 'rdp';        // the dialog shows RDP settings for a connection that is not marked yet: OK marks it, as it repairs the settings of the wrong type
  }
  const was = before.meta, now = after.meta;
  if (now.notes !== was.notes) { if (now.notes === '') unset.push('notes'); else set.notes = now.notes; }
  if (now.color !== was.color) { if (now.color === undefined) unset.push('color'); else set.color = now.color; }
  if (now.icon !== was.icon) { if (now.icon === undefined) unset.push('icon'); else set.icon = now.icon; }
  if (options.spread === true || !sameSort(now.sort, was.sort)) { if (now.sort.length === 0) unset.push('sort'); else set.sort = now.sort.map((c) => ({ by: c.by, dir: c.dir })); }
  if (Object.keys(set).length === 0 && unset.length === 0) return undefined;
  return { ...(Object.keys(set).length > 0 ? { set } : {}), ...(unset.length > 0 ? { unset } : {}) };
}
