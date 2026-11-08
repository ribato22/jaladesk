// Three-way merge of two edited copies of one document against their common base. Objects are matched by id and compared field
// by field (name, parent, order, type and every property). A field that changed on only one side takes that side's value;
// a field that changed to different values on both sides is a CONFLICT: the merge keeps "mine" provisionally and reports it,
// it never decides silently (no last-writer-wins). The result always passes validateDocument().
import { isDeepStrictEqual } from 'node:util';
import { validateDocument, upgradeV1, type Doc, type Json, type ObjectNode } from './model.js';
import { referencedSecretIds } from './references.js';

export type FieldConflict = { kind: 'field'; id: string; field: string; base: Json | undefined; mine: Json | undefined; theirs: Json | undefined };
export type Conflict =
  | FieldConflict
  | { kind: 'delete-edit'; id: string; deletedBy: 'mine' | 'theirs' } // deleted on one side, edited on the other: the edited object is kept
  | { kind: 'orphan'; id: string; parentId: string }                   // its parent was deleted on the other side: moved to the top level
  | { kind: 'cycle'; ids: string[] };                                  // concurrent moves formed a cycle: the folders go back to their base parents

function pick<T>(id: string, field: string, base: T | undefined, mine: T | undefined, theirs: T | undefined, conflicts: Conflict[]): T | undefined {
  if (isDeepStrictEqual(mine, theirs)) return mine;
  if (isDeepStrictEqual(mine, base)) return theirs;
  if (isDeepStrictEqual(theirs, base)) return mine;
  conflicts.push({ kind: 'field', id, field, base: base as Json | undefined, mine: mine as Json | undefined, theirs: theirs as Json | undefined });
  return mine;
}

// The place among the siblings is not something two people can disagree about: putting a folder in order moves many objects at once, and a conflict
// on each of them would only be noise. What one side changed is taken; when both did, mine is taken, and the merge numbers the siblings again at the end.
// An order is a place in a folder: an object that a side moved to another folder takes the order that side gave it there (the order the other side gave it
// belongs to the folder it left), and only when it stays in one folder are the orders of the two sides weighed against the base.
const pickOrder = (base: ObjectNode | undefined, mine: ObjectNode, theirs: ObjectNode, parentId: string | null): number => {
  if (base && parentId !== base.parentId) return parentId === mine.parentId ? mine.order : theirs.order;
  return mine.order === base?.order ? theirs.order : mine.order;
};

/** A property counts only when the object has it itself: "toString" and "constructor" are found on every object and are not properties that anybody wrote. */
const own = (props: Record<string, Json> | undefined, key: string): Json | undefined => (props !== undefined && Object.hasOwn(props, key) ? props[key] : undefined);

function mergeMap<T>(id: string, prefix: string, base: Record<string, T>, mine: Record<string, T>, theirs: Record<string, T>, conflicts: Conflict[]): Record<string, T> {
  const result: Record<string, T> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const get = (map: Record<string, T>) => Object.hasOwn(map, key) ? map[key] : undefined;
    const value = pick(id, `${prefix}${key}`, get(base), get(mine), get(theirs), conflicts);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const section = (node: ObjectNode | undefined, key: 'groups' | 'inherit'): Record<string, Json> => {
  const value=node?.props[key];return value && typeof value==='object' && !Array.isArray(value)?value:{};
};
/** Selection and the redundant parent flag are one identity decision, including an implicit parent or an unset selection. */
export function credentialGroupState(node: ObjectNode | undefined): Record<string,Json> {
  const groups=section(node,'groups'),inherit=section(node,'inherit');
  return {...(Object.hasOwn(groups,'credentials')?{selection:groups.credentials}:{}),...(Object.hasOwn(inherit,'credentials')?{inherit:inherit.credentials}:{})};
}
export function setCredentialGroupState(node: ObjectNode, value: Json | undefined): void {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='selection'&&k!=='inherit'))throw new Error('Invalid credential group conflict');
  for(const [name,field] of [['groups','selection'],['inherit','inherit']] as const){
    const next={...section(node,name)};delete next.credentials;
    if(Object.hasOwn(value,field))next.credentials=structuredClone(value[field]);
    if(Object.hasOwn(node.props,name)||Object.keys(next).length)node.props[name]=next;
  }
}

/** The only document-level conflict paths; callers never interpret an arbitrary dotted path. */
export function documentValue(doc: Doc, field: string): Json | undefined {
  if (field === 'document.name') return doc.name;
  if (doc.schemaVersion !== 2) return undefined;
  if (field === 'document.meta.sort') return doc.meta.sort as unknown as Json;
  if (field.startsWith('document.defaults.groups.')) return doc.defaults.groups[field.slice(25) as keyof typeof doc.defaults.groups];
  if (field.startsWith('document.secrets.')) return doc.secrets[field.slice(17)] as unknown as Json;
  throw new Error('Unknown document conflict field');
}
export function setDocumentValue(doc: Doc, field: string, value: Json | undefined): void {
  if (field === 'document.name') { doc.name = value as string; return; }
  if (doc.schemaVersion !== 2) throw new Error('Document version does not support this field');
  if (field === 'document.meta.sort') { doc.meta.sort = structuredClone(value) as unknown as typeof doc.meta.sort; return; }
  const record = field.startsWith('document.defaults.groups.') ? doc.defaults.groups : field.startsWith('document.secrets.') ? doc.secrets : undefined;
  if (!record) throw new Error('Unknown document conflict field');
  const key = field.slice(field.startsWith('document.defaults.groups.') ? 25 : 17);
  if (value === undefined) delete (record as Record<string, unknown>)[key]; else (record as Record<string, unknown>)[key] = structuredClone(value);
}

function mergeNode(base: ObjectNode | undefined, mine: ObjectNode, theirs: ObjectNode, conflicts: Conflict[]): ObjectNode {
  const id = mine.id;
  const props: Record<string, Json> = {};
  const credentialStates=[base,mine,theirs].map(credentialGroupState);
  const hasCredential=credentialStates.some(v=>Object.keys(v).length>0);
  const credential=hasCredential?pick(id,'props.groups.credentials',credentialStates[0],credentialStates[1],credentialStates[2],conflicts):undefined;
  for (const key of [...new Set([...Object.keys(base?.props ?? {}), ...Object.keys(mine.props), ...Object.keys(theirs.props)])].sort()) {
    if ((key === 'groups' || key === 'inherit') && [base?.props[key], mine.props[key], theirs.props[key]].every(v => v === undefined || (v !== null && typeof v === 'object' && !Array.isArray(v)))) {
      const withoutCredential=(node:ObjectNode|undefined)=>Object.fromEntries(Object.entries(section(node,key as 'groups'|'inherit')).filter(([name])=>!hasCredential||name!=='credentials'));
      const merged = mergeMap(id, `props.${key}.`, withoutCredential(base), withoutCredential(mine), withoutCredential(theirs), conflicts);
      if (Object.keys(merged).length || hasCredential) props[key] = merged;
      continue;
    }
    const value = pick(id, `props.${key}`, own(base?.props, key), own(mine.props, key), own(theirs.props, key), conflicts);
    if (value !== undefined) props[key] = value;
  }
  const parentId = pick(id, 'parentId', base?.parentId, mine.parentId, theirs.parentId, conflicts) ?? null;
  const node: ObjectNode = {
    id,
    type: pick(id, 'type', base?.type, mine.type, theirs.type, conflicts)!,
    name: pick(id, 'name', base?.name, mine.name, theirs.name, conflicts)!,
    parentId,
    order: pickOrder(base, mine, theirs, parentId),
    props,
  };
  if(credential)setCredentialGroupState(node,credential);
  return node;
}

function cycleMembers(objects: Record<string, ObjectNode>): string[][] {
  const cycles: string[][] = [];
  const done = new Set<string>();
  for (const start of Object.keys(objects)) {
    const path: string[] = [];
    let cursor: string | null = start;
    while (cursor !== null && !done.has(cursor) && objects[cursor]) {
      const at = path.indexOf(cursor);
      if (at >= 0) { cycles.push(path.slice(at).sort()); break; }
      path.push(cursor);
      cursor = objects[cursor]!.parentId;
    }
    for (const visited of path) done.add(visited);
  }
  return cycles;
}

export function merge3(base: Doc, mine: Doc, theirs: Doc): { merged: Doc; conflicts: Conflict[] } {
  if ([base, mine, theirs].some(d => d.schemaVersion === 2)) {
    if (base.schemaVersion === 1) base = upgradeV1(base);
    if (mine.schemaVersion === 1) mine = upgradeV1(mine);
    if (theirs.schemaVersion === 1) theirs = upgradeV1(theirs);
  }
  if (base.id !== mine.id || base.id !== theirs.id || base.kind !== mine.kind || base.kind !== theirs.kind) throw new Error('The documents are not the same document');
  const conflicts: Conflict[] = [];
  const objects: Record<string, ObjectNode> = {};
  for (const id of [...new Set([...Object.keys(base.objects), ...Object.keys(mine.objects), ...Object.keys(theirs.objects)])].sort()) {
    const b = base.objects[id];
    const m = mine.objects[id];
    const t = theirs.objects[id];
    if (!b) { // added
      if (m && t) objects[id] = isDeepStrictEqual(m, t) ? m : mergeNode(undefined, m, t, conflicts);
      else objects[id] = (m ?? t)!;
    } else if (!m && !t) { // deleted on both sides
      continue;
    } else if (!m || !t) { // deleted on one side
      const survivor = (m ?? t)!;
      const source = m ? mine : theirs;
      const secretEdited = base.schemaVersion === 2 && source.schemaVersion === 2 && referencedSecretIds(b).some(secretId => !isDeepStrictEqual(base.secrets[secretId], source.secrets[secretId]));
      if (!secretEdited && isDeepStrictEqual({ ...survivor, order: b.order }, b)) continue; // not edited on the other side (a new place among its siblings only moves it over): the delete wins
      objects[id] = survivor;
      conflicts.push({ kind: 'delete-edit', id, deletedBy: m ? 'theirs' : 'mine' });
    } else {
      objects[id] = mergeNode(b, m, t, conflicts);
    }
  }
  // The fixes below change nodes in place, and a node here can be the very object that belongs to `mine`, `theirs` or `base`: they work on copies.
  for (const key of Object.keys(objects)) objects[key] = { ...objects[key]! };
  for (const node of Object.values(objects)) { // parents that no longer exist
    if (node.parentId !== null && !objects[node.parentId]) {
      conflicts.push({ kind: 'orphan', id: node.id, parentId: node.parentId });
      node.parentId = null;
    }
  }
  for (const attempt of [0, 1]) { // concurrent moves that form a cycle: back to the base parent, then to the top level
    const cycles = cycleMembers(objects);
    if (cycles.length === 0) break;
    for (const ids of cycles) {
      if (attempt === 0) conflicts.push({ kind: 'cycle', ids });
      for (const id of ids) {
        const parent = attempt === 0 ? base.objects[id]?.parentId ?? null : null;
        objects[id]!.parentId = parent !== null && objects[parent] && !ids.includes(parent) ? parent : null;
      }
    }
  }
  const groups = new Map<string | null, ObjectNode[]>();
  for (const node of Object.values(objects)) { const group = groups.get(node.parentId); if (group) group.push(node); else groups.set(node.parentId, [node]); }
  for (const siblings of groups.values()) siblings.sort((x, y) => x.order - y.order || (x.id < y.id ? -1 : 1)).forEach((node, index) => { node.order = index; });
  const name = pick(base.id, 'document.name', base.name, mine.name, theirs.name, conflicts)!;
  let extras = {};
  if (base.schemaVersion === 2 && mine.schemaVersion === 2 && theirs.schemaVersion === 2) {
    const dates = (values: (string | null)[]) => values.filter((v): v is string => v !== null).sort();
    const createdAt = base.meta.createdAt ?? dates([mine.meta.createdAt, theirs.meta.createdAt])[0] ?? null;
    const updatedAt = dates([base.meta.updatedAt, mine.meta.updatedAt, theirs.meta.updatedAt]).at(-1) ?? null;
    const defaults = { groups: mergeMap(base.id, 'document.defaults.groups.', base.defaults.groups, mine.defaults.groups, theirs.defaults.groups, conflicts) };
    const secrets = mergeMap(base.id, 'document.secrets.', base.secrets, mine.secrets, theirs.secrets, conflicts);
    // A delete-edit keeps the surviving object until an explicit choice; its required secret must survive with it.
    const references = [...Object.values(objects), { id: base.id, type: 'folder' as const, name: '', parentId: null, order: 0, props: { groups: defaults.groups as Json } }];
    for (const node of references) for (const secretId of referencedSecretIds(node)) if (!Object.hasOwn(secrets, secretId)) {
      const record = mine.secrets[secretId] ?? theirs.secrets[secretId] ?? base.secrets[secretId];
      if (record) secrets[secretId] = structuredClone(record);
    }
    extras = {
      meta: { createdAt, updatedAt, sort: pick(base.id, 'document.meta.sort', base.meta.sort, mine.meta.sort, theirs.meta.sort, conflicts) },
      defaults, secrets,
    };
  }
  const merged = validateDocument({ schemaVersion: base.schemaVersion, id: base.id, kind: base.kind, name, revision: Math.max(mine.revision, theirs.revision), objects, ...extras });
  return { merged, conflicts };
}

/** Apply one side's value of a field conflict; the other kinds are resolved by explicit edits in the UI. */
export function resolveField(doc: Doc, conflict: FieldConflict, side: 'mine' | 'theirs'): Doc {
  const value = conflict[side];
  const copy = structuredClone(doc);
  if (conflict.field.startsWith('document.')) { setDocumentValue(copy, conflict.field, value); return validateDocument(copy); }
  const node = copy.objects[conflict.id];
  if (!node) throw new Error('The object no longer exists');
  if(conflict.field==='props.groups.credentials'){setCredentialGroupState(node,value);return validateDocument(copy);}
  if (conflict.field.startsWith('props.')) {
    const key = conflict.field.slice(6);
    if (key.startsWith('groups.') || key.startsWith('inherit.')) {
      const [section, group] = key.split('.'); const record = { ...(node.props[section] as Record<string, Json> ?? {}) };
      if (value === undefined) delete record[group]; else record[group] = structuredClone(value);
      node.props[section] = record; return validateDocument(copy);
    }
    if (value === undefined) delete node.props[key]; else node.props[key] = structuredClone(value);
  } else {
    (node as Record<string, unknown>)[conflict.field] = structuredClone(value);
  }
  return validateDocument(copy);
}
