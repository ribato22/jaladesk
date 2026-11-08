import { randomUUID } from 'node:crypto';
import { UUID, validateV2, type Doc2, type Json, type ObjectNode } from './model.js';
import { resolveEffective, type ResolutionLayers } from './effective.js';
import { GROUP_REGISTRY, isGroup, isPlainRecord, type CredentialSelection, type GroupSettings } from './groups.js';
import { publicPropertyValue, writablePublicProperty } from './projection.js';
import { remapNodeReferences } from './references.js';

export type TemplateSnapshot = { sourceDocumentId: string; roots: string[]; objects: ObjectNode[] };
export type TemplateOptions = { copyCredentialReferences?: boolean; allowedCredentialDocumentIds?: readonly string[] };
export class TemplateError extends Error {
  constructor(readonly code: 'invalid-template' | 'credential-scope' | 'reference-cycle') { super(code); this.name = 'TemplateError'; }
}
function bad(code: TemplateError['code'] = 'invalid-template'): never { throw new TemplateError(code); }
const blank = (id: string, nodes: ObjectNode[]): Doc2 => ({ schemaVersion: 2, id, kind: 'workspace', name: '', revision: 0, objects: Object.fromEntries(nodes.map(node => [node.id, node])), meta: { createdAt: null, updatedAt: null, sort: [] }, defaults: { groups: {} }, secrets: {} });
const allowed = (node: ObjectNode) => ['folder', 'connection'].includes(node.type);
const safeSelection = (value: unknown): value is Extract<CredentialSelection, { mode: 'id' | 'name' }> => isPlainRecord(value) && (value.mode === 'id' || value.mode === 'name');
function checkCycles(snapshot: TemplateSnapshot): void {
  const edges = new Map(snapshot.objects.map(node => [node.id, Object.values(isPlainRecord(node.props.groups) ? node.props.groups : {}).flatMap(ref => isPlainRecord(ref) && ref.documentId === snapshot.sourceDocumentId && typeof ref.objectId === 'string' ? [ref.objectId] : [])]));
  const state = new Map<string, number>();
  for (const start of edges.keys()) {
    const stack: [string, boolean][] = [[start, false]];
    while (stack.length) {
      const [id, done] = stack.pop()!;
      if (done) { state.set(id, 2); continue; }
      if (state.get(id) === 2) continue;
      if (state.get(id) === 1) bad('reference-cycle');
      state.set(id, 1); stack.push([id, true]);
      for (const target of edges.get(id) ?? []) if (edges.has(target)) stack.push([target, false]);
    }
  }
}

/** Snapshots contain only selected public data and explicitly copied credential references, never a secret map. */
export function validateTemplateSnapshot(raw: unknown): TemplateSnapshot {
  if (!isPlainRecord(raw) || Object.keys(raw).sort().join(',') !== 'objects,roots,sourceDocumentId' || typeof raw.sourceDocumentId !== 'string' || !UUID.test(raw.sourceDocumentId) || !Array.isArray(raw.roots) || !raw.roots.length || !Array.isArray(raw.objects) || !raw.objects.length || raw.objects.length > 100000) bad();
  const snapshot = raw as TemplateSnapshot;
  if (snapshot.objects.some(node => !isPlainRecord(node)) || new Set(snapshot.objects.map(node => node.id)).size !== snapshot.objects.length || new Set(snapshot.roots).size !== snapshot.roots.length) bad();
  try { validateV2(blank(snapshot.sourceDocumentId, snapshot.objects)); } catch { bad(); }
  const roots = snapshot.objects.filter(node => node.parentId === null).map(node => node.id);
  if (roots.length !== snapshot.roots.length || snapshot.roots.some(id => !roots.includes(id))) bad();
  for (const node of snapshot.objects) {
    if (!allowed(node)) bad();
    for (const [key, value] of Object.entries(node.props)) {
      if (key === 'groups' && isPlainRecord(value)) {
        for (const [group, setting] of Object.entries(value)) if (!isGroup(group) || (GROUP_REGISTRY[group].privacy === 'private' && !(group === 'credentials' && safeSelection(setting)))) bad();
      } else if (!writablePublicProperty(key) || !publicPropertyValue(key, value)) bad();
    }
  }
  checkCycles(snapshot);
  return structuredClone(snapshot);
}

export function captureTemplate(doc: Doc2, objectIds: readonly string[], layers: ResolutionLayers | ((objectId: string) => ResolutionLayers), options: TemplateOptions = {}): TemplateSnapshot {
  try { validateV2(doc); } catch { return bad(); }
  if (doc.kind === 'overrides' || !Array.isArray(objectIds) || !objectIds.length || objectIds.length > 100000 || new Set(objectIds).size !== objectIds.length || objectIds.some(id => !Object.hasOwn(doc.objects, id) || !allowed(doc.objects[id]!))) bad();
  const children = new Map<string, ObjectNode[]>();
  for (const node of Object.values(doc.objects)) if (node.parentId !== null) { const siblings = children.get(node.parentId) ?? []; siblings.push(node); children.set(node.parentId, siblings); }
  const selected = new Set<string>(), queue = [...objectIds];
  for (let i = 0; i < queue.length; i++) { const id = queue[i]!; if (selected.has(id)) continue; selected.add(id); for (const child of children.get(id) ?? []) { if (!allowed(child)) bad(); queue.push(child.id); } }
  const sourceDocumentId = randomUUID(), objectMap = Object.fromEntries([...selected].map(id => [id, randomUUID()]));
  const nodes: ObjectNode[] = [];
  for (const id of selected) {
    const node = doc.objects[id]!, effective = resolveEffective(doc, id, typeof layers === 'function' ? layers(id) : layers);
    if (!effective.ok) bad();
    const props: Record<string, Json> = {}, groups: GroupSettings = {};
    for (const [key, value] of Object.entries(node.props)) if (writablePublicProperty(key) && publicPropertyValue(key, value)) props[key] = structuredClone(value);
    for (const [group, value] of Object.entries(effective.value.private.groups)) if (isGroup(group) && GROUP_REGISTRY[group].privacy === 'public') groups[group] = structuredClone(value);
    if (options.copyCredentialReferences) {
      const selection = effective.value.private.credentialBinding?.selection;
      if (safeSelection(selection)) {
        const ids = selection.mode === 'id' ? [selection.vaultId] : selection.scopeVaultIds;
        if (ids.some(id => !options.allowedCredentialDocumentIds?.includes(id))) bad('credential-scope');
        groups.credentials = structuredClone(selection) as Json;
      }
    }
    if (Object.keys(groups).length) props.groups = groups as Json;
    const copy = remapNodeReferences({ ...node, props }, { sourceDocumentId: doc.id, targetDocumentId: sourceDocumentId, objectIds: objectMap, secretIds: {} });
    copy.id = objectMap[id]!; copy.parentId = node.parentId !== null && selected.has(node.parentId) ? objectMap[node.parentId]! : null;
    nodes.push(copy);
  }
  return validateTemplateSnapshot({ sourceDocumentId, roots: nodes.filter(node => node.parentId === null).map(node => node.id), objects: nodes });
}

export function instantiateTemplate(raw: unknown, destination: Doc2, options: { parentId?: string | null; name?: string } = {}): { doc: Doc2; objectIds: string[] } {
  const snapshot = validateTemplateSnapshot(raw);
  try { validateV2(destination); } catch { return bad(); }
  if (destination.kind !== 'workspace') bad();
  const parentId = options.parentId ?? null;
  if (parentId !== null && (!Object.hasOwn(destination.objects, parentId) || destination.objects[parentId]!.type !== 'folder')) bad();
  if (options.name !== undefined && (typeof options.name !== 'string' || options.name.length > 256 || snapshot.roots.length !== 1)) bad();
  const next = structuredClone(destination), ids: Record<string, string> = {}, used = new Set(Object.keys(next.objects));
  for (const node of snapshot.objects) { let id: string; do { id = randomUUID(); } while (used.has(id)); ids[node.id] = id; used.add(id); }
  let order = 0;
  for (const node of Object.values(destination.objects)) if (node.parentId === parentId) order = Math.max(order, node.order + 1);
  if (!Number.isSafeInteger(order)) bad();
  for (const node of snapshot.objects) {
    const copy = remapNodeReferences(node, { sourceDocumentId: snapshot.sourceDocumentId, targetDocumentId: next.id, objectIds: ids, secretIds: {} });
    copy.id = ids[node.id]!; copy.parentId = node.parentId === null ? parentId : ids[node.parentId]!;
    if (node.parentId === null) { copy.order = order++; if (options.name !== undefined) copy.name = options.name; }
    next.objects[copy.id] = copy;
  }
  try { validateV2(next); } catch { return bad(); }
  return { doc: next, objectIds: snapshot.roots.map(id => ids[id]!) };
}

export function adHocTemplate(raw: unknown, options: { name?: string } = {}): ObjectNode {
  const snapshot = validateTemplateSnapshot(raw);
  if (snapshot.objects.length !== 1 || snapshot.objects[0]!.type !== 'connection') bad();
  const result = instantiateTemplate(snapshot, blank(randomUUID(), []), options);
  return result.doc.objects[result.objectIds[0]!]!;
}
