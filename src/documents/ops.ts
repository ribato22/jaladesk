// Operations on a document: add, update, remove, move and duplicate an object. Each one takes a document and returns a NEW document that shares
// every object it did not touch with the old one (the old document is never changed), plus the change: exactly the objects that are new or
// different, and the ids that are gone. Only what an operation touches is checked, so one edit costs one copy of the table of objects (a few
// milliseconds at 90,000 objects) and not a validation of every object; validateDocument() stays the judge of a whole file, and the tests hold
// the operations to it: whatever they accept must pass it, and what they refuse must fail it.
import { DocumentError, LIMITS, UUID, validateDocument, validateNode, type Doc, type Json, type ObjectNode, type ObjectType, type SecretRecord } from './model.js';
import { compareSiblings } from './order.js';
import { referencedSecretIds, remapNodeReferences } from './references.js';

export type Props = Record<string, Json>;
/** A change to the properties of an object that names what it sets and what it removes, so that every other property stays as the document holds it now. */
export type Patch = { set?: Props; unset?: string[] };
export type Op =
  | { op: 'add'; id: string; parentId: string | null; type: ObjectType; name: string; props: Props; index?: number }
  | { op: 'update'; id: string; name?: string; props?: Props; patch?: Patch; spreadSort?: boolean }  // props: all of them, replaced; patch: some of them; spreadSort: the folders below get the sort setting this folder has after the update
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; parentId: string | null; index?: number }
  | { op: 'duplicate'; id: string; name: string };
/** The objects that are new or different after an operation (whole objects, in their new state) and the ids that no longer exist. */
export type Change = { upsert: ObjectNode[]; remove: string[] };
export type Applied = { doc: Doc; change: Change; created?: string };
export type Env = { newId: () => string; limits?: { maxObjects?: number; maxDepth?: number } };

/** Refusals that belong to the operation (the document would be fine): the rest are DocumentErrors with the code validateDocument would give. */
export type OpErrorCode = 'unknown-object' | 'exists' | 'bad-index' | 'bad-patch';
export class OpError extends Error {
  constructor(readonly code: OpErrorCode, message: string) { super(message); this.name = 'OpError'; }
}

const none: Change = { upsert: [], remove: [] };
/** An id counts only when the document itself has it: "__proto__" and "constructor" are found on every object and are not objects. */
const own = (objects: Record<string, ObjectNode>, id: unknown): ObjectNode | undefined => (typeof id === 'string' && Object.hasOwn(objects, id) ? objects[id] : undefined);
function missing(): never { throw new OpError('unknown-object', 'That object does not exist'); }
const need = (objects: Record<string, ObjectNode>, id: unknown): ObjectNode => own(objects, id) ?? missing();
const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** The folders from `id` up to the top level, `id` itself included (0 for the top level): a new child of that folder is at this depth + 1. A document that passed validateDocument has no cycle; the bound is for the one that did not. */
function depthOf(objects: Record<string, ObjectNode>, id: string | null): number {
  let depth = 0;
  for (let cursor = id; cursor !== null; cursor = own(objects, cursor)?.parentId ?? null) {
    if (++depth > LIMITS.maxDepth + 2) throw new DocumentError('cycle', 'The folder tree contains a cycle');
  }
  return depth;
}

function childrenIndex(objects: Record<string, ObjectNode>): Map<string | null, ObjectNode[]> {
  const index = new Map<string | null, ObjectNode[]>();
  for (const o of Object.values(objects)) {
    const group = index.get(o.parentId);
    if (group) group.push(o); else index.set(o.parentId, [o]);
  }
  return index;
}

/** The object and everything below it, parents before children. */
function subtree(index: Map<string | null, ObjectNode[]>, root: ObjectNode): ObjectNode[] {
  const found: ObjectNode[] = [root];
  for (let i = 0; i < found.length; i++) for (const child of index.get(found[i]!.id) ?? []) found.push(child); // by position: shift() on a long array is slow, and push(...children) can overflow the stack
  return found;
}

function height(index: Map<string | null, ObjectNode[]>, root: ObjectNode): number {
  let levels = 0;
  for (let level = [root]; level.length > 0; levels++) level = level.flatMap((o) => index.get(o.id) ?? []);
  return levels;
}

/** `base` with the patch applied, as a new object (nothing is shared with the patch); `base` itself when there is no patch. */
export function applyPatch(base: Props, patch: Patch | undefined): Props {
  if (!patch) return base;
  const set = patch.set ?? {}, unset = patch.unset ?? [];
  if (unset.some((key) => Object.hasOwn(set, key))) throw new OpError('bad-patch', 'A property cannot be set and removed at once');
  const next: Props = { ...base };
  for (const key of unset) delete next[key];
  for (const [key, value] of Object.entries(set)) {
    if (key === '__proto__') throw new OpError('bad-patch', 'Not a property name');
    next[key] = structuredClone(value);
  }
  return next;
}

/** The folders below `folder` whose sort setting is not the one `props` holds, each as it becomes (with that setting, or without any). */
function spreadSortOf(objects: Record<string, ObjectNode>, folder: ObjectNode, props: Props): ObjectNode[] {
  const setting = Object.hasOwn(props, 'sort') ? props.sort : undefined;
  const changed: ObjectNode[] = [];
  for (const below of subtree(childrenIndex(objects), folder)) {
    if (below.id === folder.id || below.type !== 'folder') continue;
    if (sameJson(Object.hasOwn(below.props, 'sort') ? below.props.sort : undefined, setting)) continue;
    const next: Props = { ...below.props };
    if (setting === undefined) delete next.sort; else next.sort = structuredClone(setting);
    changed.push(validateNode({ ...below, props: next }, below.id));
  }
  return changed;
}

const siblingsOf = (objects: Record<string, ObjectNode>, parentId: string | null, except?: string): ObjectNode[] =>
  Object.values(objects).filter((o) => o.parentId === parentId && o.id !== except).sort(compareSiblings);

/**
 * Where an object goes among its siblings (in display order, without the object itself): its own order, and the siblings after it that must move up
 * to keep the order strictly increasing. Putting it last moves nobody; putting it first moves everybody that has no gap to spare.
 */
function place(siblings: ObjectNode[], index: number | undefined): { order: number; shifted: ObjectNode[] } {
  const at = index === undefined ? siblings.length : index;
  if (!Number.isInteger(at) || at < 0 || at > siblings.length) throw new OpError('bad-index', 'The position is outside the folder');
  const order = at === 0 ? 0 : siblings[at - 1]!.order + 1;
  const shifted: ObjectNode[] = [];
  let needed = order + 1;
  for (let i = at; i < siblings.length && siblings[i]!.order < needed; i++, needed++) shifted.push({ ...siblings[i]!, order: needed });
  return { order, shifted };
}

const parentFolder = (objects: Record<string, ObjectNode>, parentId: unknown): string | null => {
  if (parentId === null) return null;
  if (own(objects, parentId)?.type !== 'folder') throw new DocumentError('bad-parent', 'A parent must be an existing folder');
  return parentId as string;
};

const finish = (doc: Doc, objects: Record<string, ObjectNode>, change: Change, created?: string): Applied => ({ doc: { ...doc, objects }, change, ...(created === undefined ? {} : { created }) });

export function applyOp(doc: Doc, op: Op, env: Env): Applied {
  const objects = doc.objects;
  const maxObjects = env.limits?.maxObjects ?? LIMITS.maxObjects;
  const maxDepth = env.limits?.maxDepth ?? LIMITS.maxDepth;
  switch (op.op) {
    case 'add': {
      if (typeof op.id === 'string' && Object.hasOwn(objects, op.id)) throw new OpError('exists', 'An object with that id exists');
      if (Object.keys(objects).length + 1 > maxObjects) throw new DocumentError('too-many-objects', 'Too many objects');
      const parentId = parentFolder(objects, op.parentId);
      if (depthOf(objects, parentId) + 1 > maxDepth) throw new DocumentError('too-deep', 'Folders nested too deeply');
      const { order, shifted } = place(siblingsOf(objects, parentId), op.index);
      const node = validateNode({ id: op.id, type: op.type, name: op.name, parentId, order, props: structuredClone(op.props) }, op.id);
      const next = { ...objects, [node.id]: node };
      for (const s of shifted) next[s.id] = s;
      return finish(doc, next, { upsert: [node, ...shifted], remove: [] }, node.id);
    }
    case 'update': {
      const node = need(objects, op.id);
      if (op.props !== undefined && op.patch !== undefined) throw new OpError('bad-patch', 'Properties are either replaced or patched, not both');
      const name = op.name ?? node.name;
      const props = applyPatch(op.props === undefined ? node.props : structuredClone(op.props), op.patch);
      const below = op.spreadSort === true && node.type === 'folder' ? spreadSortOf(objects, node, props) : [];
      const same = name === node.name && sameJson(props, node.props);
      if (same && below.length === 0) return { doc, change: none };
      const changed = same ? node : validateNode({ ...node, name, props }, node.id);
      const next = { ...objects };
      for (const o of same ? below : [changed, ...below]) next[o.id] = o;
      return finish(doc, next, { upsert: same ? below : [changed, ...below], remove: [] });
    }
    case 'remove': {
      const ids = subtree(childrenIndex(objects), need(objects, op.id)).map((o) => o.id);
      const next = { ...objects };
      for (const id of ids) delete next[id];
      return finish(doc, next, { upsert: [], remove: ids });
    }
    case 'move': {
      const node = need(objects, op.id);
      const parentId = parentFolder(objects, op.parentId);
      const above = depthOf(objects, parentId); // also proves the walk up from the new parent ends
      for (let cursor = parentId; cursor !== null; cursor = own(objects, cursor)?.parentId ?? null) {
        if (cursor === node.id) throw new DocumentError('cycle', 'A folder cannot be moved into itself');
      }
      if (above + height(childrenIndex(objects), node) > maxDepth) throw new DocumentError('too-deep', 'Folders nested too deeply');
      const { order, shifted } = place(siblingsOf(objects, parentId, node.id), op.index);
      if (node.parentId === parentId && node.order === order && shifted.length === 0) return { doc, change: none };
      const moved = validateNode({ ...node, parentId, order }, node.id);
      const next = { ...objects, [moved.id]: moved };
      for (const s of shifted) next[s.id] = s;
      return finish(doc, next, { upsert: [moved, ...shifted], remove: [] });
    }
    case 'duplicate': {
      const original = need(objects, op.id);
      const copies = subtree(childrenIndex(objects), original);
      if (Object.keys(objects).length + copies.length > maxObjects) throw new DocumentError('too-many-objects', 'Too many objects');
      const siblings = siblingsOf(objects, original.parentId);
      const { order, shifted } = place(siblings, siblings.findIndex((s) => s.id === original.id) + 1);
      const used = new Set([...Object.keys(objects), ...(doc.schemaVersion === 2 ? Object.keys(doc.secrets) : [])]);
      const fresh = (): string => {
        const id = env.newId();
        if (!UUID.test(id)) throw new DocumentError('bad-id', 'Invalid generated id');
        if (used.has(id)) throw new OpError('exists', 'An object or secret with that id exists');
        used.add(id); return id;
      };
      const ids = new Map(copies.map((o) => [o.id, fresh()]));
      const secretIds: Record<string, string> = {}, copiedSecrets: Record<string, SecretRecord> = {};
      if (doc.schemaVersion === 2) for (const node of copies) for (const secretId of referencedSecretIds(node)) {
        if (Object.hasOwn(secretIds, secretId)) continue;
        if (!Object.hasOwn(doc.secrets, secretId)) throw new DocumentError('bad-props', 'A referenced secret is missing');
        const newId = fresh(); secretIds[secretId] = newId; copiedSecrets[newId] = structuredClone(doc.secrets[secretId]!);
      }
      const objectIds = Object.fromEntries(ids);
      const made = copies.map((o, i) => validateNode({
        id: ids.get(o.id)!, type: o.type, name: i === 0 ? op.name : o.name, parentId: i === 0 ? original.parentId : ids.get(o.parentId!)!,
        order: i === 0 ? order : o.order, props: doc.schemaVersion === 2 ? remapNodeReferences(o, { objectIds, secretIds, sourceDocumentId: doc.id, targetDocumentId: doc.id }).props : structuredClone(o.props),
      }, ids.get(o.id)));
      const next = { ...objects };
      for (const n of [...made, ...shifted]) next[n.id] = n;
      const result = finish(doc, next, { upsert: [...made, ...shifted], remove: [] }, made[0]!.id);
      // A copied subtree may refer outside itself; the complete validator checks the resulting reference closure.
      if (doc.schemaVersion === 2) result.doc = validateDocument({ ...result.doc, secrets: { ...doc.secrets, ...copiedSecrets } });
      return result;
    }
  }
}
