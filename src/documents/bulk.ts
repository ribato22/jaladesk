// Pure, atomic in-memory batch. Create actions are trusted main-process output after Task 7 expansion;
// renderer input must first pass the service's public-only parser. No secret map is copied here.
import { isDeepStrictEqual } from 'node:util';
import { DocumentError, isRecord, LIMITS, UUID, validateNode, validateV2, type Doc2, type Json, type ObjectNode } from './model.js';
import { applyPatch, type Change, type Env, type Patch, type Props } from './ops.js';
import { publicPropertyValue, writablePublicProperty } from './projection.js';
import { checkMeta } from './meta.js';
import { compareSiblings } from './order.js';

export type BulkAction =
  | { kind: 'create'; parentId: string | null; type: 'folder' | 'connection'; name: string; props?: Props }
  | { kind: 'update'; objectId: string; name?: string; patch?: Patch };
export type BatchApplied = { doc: Doc2; change: Change; createdIds: string[] };
export class BulkError extends Error {
  constructor(readonly code: 'invalid' | 'too-many' | 'id-collision') { super(code); this.name = 'BulkError'; }
}
const invalid = (): never => { throw new BulkError('invalid'); };
function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).some(key => !keys.includes(key))) return invalid();
  return raw;
}
function name(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > LIMITS.maxName) return invalid();
  return raw;
}
function patch(raw: unknown): Patch | undefined {
  if (raw === undefined) return undefined;
  const value = exact(raw, ['set', 'unset']);
  if (value.set !== undefined && !isRecord(value.set)) return invalid();
  const set = (value.set === undefined ? {} : value.set) as Record<string, unknown>;
  if (Object.entries(set).some(([key, value]) => !writablePublicProperty(key) || value === undefined || !publicPropertyValue(key, value as Json))) return invalid();
  const unset = value.unset === undefined ? [] : value.unset;
  if (!Array.isArray(unset) || unset.some(key => typeof key !== 'string' || !writablePublicProperty(key) || Object.hasOwn(set, key)) || new Set(unset).size !== unset.length) return invalid();
  return { set: set as Props, unset: unset as string[] };
}
const visible = (node: ObjectNode | undefined): node is ObjectNode => node !== undefined && (node.type === 'folder' || node.type === 'connection');

/** A single table copy and one complete graph/secret-closure check; nothing is published or mutated on refusal. */
export function applyBatch(doc: Doc2, actions: readonly BulkAction[], env: Env): BatchApplied {
  if (!Array.isArray(actions)) return invalid();
  if (actions.length > 10000) throw new BulkError('too-many');
  const upsert: ObjectNode[] = [], createdIds: string[] = [], updates = new Map<string, ObjectNode>();
  const used = new Set([...Object.keys(doc.objects), ...Object.keys(doc.secrets)]);
  const orders = new Map<string | null, number>();
  for (const node of Object.values(doc.objects)) orders.set(node.parentId, Math.max(orders.get(node.parentId) ?? 0, node.order + 1));
  for (const raw of actions) {
    if (!isRecord(raw)) return invalid();
    if (raw.kind === 'create') {
      const action = exact(raw, ['kind', 'parentId', 'type', 'name', 'props']);
      const parent = action.parentId;
      if (parent !== null && (typeof parent !== 'string' || !Object.hasOwn(doc.objects, parent) || doc.objects[parent]!.type !== 'folder')) return invalid();
      if (action.type !== 'folder' && action.type !== 'connection') return invalid();
      const nodeName = name(action.name), props = action.props === undefined ? {} : action.props;
      if (!isRecord(props) || checkMeta(action.type, props as Props).length) return invalid();
      const id = env.newId();
      if (typeof id !== 'string' || !UUID.test(id) || used.has(id)) throw new BulkError('id-collision');
      used.add(id);
      const order = orders.get(parent as string | null) ?? 0;
      const node = validateNode({ id, type: action.type, name: nodeName, parentId: parent, order, props: structuredClone(props) }, id);
      orders.set(node.parentId, order + 1); upsert.push(node); createdIds.push(id);
    } else if (raw.kind === 'update') {
      const action = exact(raw, ['kind', 'objectId', 'name', 'patch']);
      if (typeof action.objectId !== 'string' || !Object.hasOwn(doc.objects, action.objectId)) return invalid();
      const prior = doc.objects[action.objectId]!;
      if (!visible(prior)) return invalid();
      const nodeName = action.name === undefined ? prior.name : name(action.name), p = patch(action.patch);
      if (checkMeta(prior.type, p?.set ?? {}).length) return invalid();
      const node = validateNode({ ...prior, name: nodeName, props: applyPatch(prior.props, p) }, prior.id);
      const earlier = updates.get(prior.id);
      if (earlier && !isDeepStrictEqual(earlier, node)) return invalid();
      if (!earlier) { updates.set(prior.id, node); if (!isDeepStrictEqual(prior, node)) upsert.push(node); }
    } else return invalid();
  }
  if (Object.keys(doc.objects).length + createdIds.length > (env.limits?.maxObjects ?? LIMITS.maxObjects)) throw new DocumentError('too-many-objects', 'Too many objects');
  if (!upsert.length) return { doc, change: { upsert: [], remove: [] }, createdIds };
  const objects = { ...doc.objects };
  for (const node of upsert) objects[node.id] = node;
  const next = validateV2({ ...doc, objects }, env.limits);
  return { doc: next, change: { upsert, remove: [] }, createdIds };
}

/** UI field states preserve the difference between absent, explicitly empty, false and mixed. */
export function mixedPublicField(nodes: readonly ObjectNode[], key: string): { kind: 'unset' | 'mixed' } | { kind: 'value'; value: Json } {
  if (!nodes.length || !writablePublicProperty(key) || nodes.some(node => Object.hasOwn(node.props, key) && !publicPropertyValue(key, node.props[key]))) return invalid();
  const first = nodes[0]!, present = Object.hasOwn(first.props, key), value = first.props[key];
  if (nodes.some(node => Object.hasOwn(node.props, key) !== present || !isDeepStrictEqual(node.props[key], value))) return { kind: 'mixed' };
  return present ? { kind: 'value', value: structuredClone(value!) } : { kind: 'unset' };
}

/** Expand selected folders once, keeping first-selected root order and deterministic sibling order. */
export function selectedConnections(doc: Doc2, ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length > 10000) return invalid();
  const children = new Map<string, ObjectNode[]>();
  for (const node of Object.values(doc.objects)) if (node.parentId !== null) { const list = children.get(node.parentId) ?? []; list.push(node); children.set(node.parentId, list); }
  for (const list of children.values()) list.sort(compareSiblings);
  const seen = new Set<string>(), result: string[] = [];
  for (const id of ids) {
    const root = typeof id === 'string' && Object.hasOwn(doc.objects, id) ? doc.objects[id] : undefined;
    if (!visible(root)) return invalid();
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i]!; if (seen.has(node.id)) continue; seen.add(node.id);
      if (node.type === 'connection') { result.push(node.id); if (result.length > 64) throw new BulkError('too-many'); }
      if (node.type === 'folder') for (const child of children.get(node.id) ?? []) queue.push(child);
    }
  }
  return result;
}
