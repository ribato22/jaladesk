// What the window knows of one open document: its objects by id and whose children they are, kept up to date by taking in the changes the main
// process sends (library.ts: Snapshot once, then a Delta per change). Pure data and functions, so the rules of taking a change in are tested without a window.
import type { Delta, DocState, Snapshot } from '../documents/library.js';
import { compareFor, sortOf } from '../documents/meta.js';
import type { ObjectNode } from '../documents/model.js';

export type DocModel = DocState & { objects: Map<string, ObjectNode>; children: Map<string | null, Set<string>> };

// The children of a folder in the order they are shown are sorted once and kept until something that decides that order changes (a child that is new, gone, moved
// or changed, or a change of the folder itself, whose properties hold its sort setting). They are kept beside the model, not in it, so that a model stays its data.
const lists = new WeakMap<DocModel, Map<string | null, ObjectNode[]>>();
const forget = (model: DocModel, parentId: string | null): void => { lists.get(model)?.delete(parentId); };

function attach(model: DocModel, o: ObjectNode): void {
  const group = model.children.get(o.parentId);
  if (group) group.add(o.id); else model.children.set(o.parentId, new Set([o.id]));
}
function detach(model: DocModel, o: ObjectNode): void {
  const group = model.children.get(o.parentId);
  if (!group) return;
  group.delete(o.id);
  if (group.size === 0) model.children.delete(o.parentId);
}
function put(model: DocModel, o: ObjectNode): void {
  const before = model.objects.get(o.id);
  if (before && before.parentId !== o.parentId) { detach(model, before); forget(model, before.parentId); }
  if (!before || before.parentId !== o.parentId) attach(model, o);
  model.objects.set(o.id, o);
  forget(model, o.parentId); // the object may have a new name, order or type: its place among its siblings may be a new one
  forget(model, o.id);       // and its own children are sorted by what its properties say now
}
const take = (model: DocModel, state: DocState): void => { if(JSON.stringify(model.meta?.sort)!==JSON.stringify(state.meta?.sort))forget(model,null);model.meta=state.meta?structuredClone(state.meta):undefined;model.name = state.name; model.revision = state.revision; model.dirty = state.dirty; model.conflicts = state.conflicts; model.seq = state.seq; };

export function modelOf(snapshot: Snapshot): DocModel {
  const model: DocModel = { id: snapshot.id, docId: snapshot.docId, name: snapshot.name, revision: snapshot.revision, dirty: snapshot.dirty, conflicts: snapshot.conflicts, seq: snapshot.seq, objects: new Map(), children: new Map(), ...(snapshot.kind?{kind:snapshot.kind}:{}),...(snapshot.meta?{meta:structuredClone(snapshot.meta)}:{}) };
  for (const o of snapshot.objects) put(model, o);
  return model;
}

/**
 * What taking a change in came to: 'applied'; 'stale' (older than what the model has already, or the same one again: nothing to do); 'gap' (a change was
 * missed: ask for a Snapshot). A change follows the one it names (`from`), not just the next number: one that changes nothing carries the seq the document is
 * at now, which can be ahead of the window when an earlier change never reached it.
 */
export type Taken = 'applied' | 'stale' | 'gap';

export function applyDelta(model: DocModel, delta: Delta): Taken {
  if (delta.seq <= model.seq) return 'stale';
  if (delta.reset) {
    model.objects.clear();
    model.children.clear();
    lists.delete(model);
    for (const o of delta.upsert) put(model, o);
    take(model, delta);
    return 'applied';
  }
  if (delta.from !== model.seq) return 'gap';
  for (const id of delta.remove) {
    const gone = model.objects.get(id);
    if (gone) { detach(model, gone); model.objects.delete(id); forget(model, gone.parentId); forget(model, gone.id); }
  }
  for (const o of delta.upsert) put(model, o);
  take(model, delta);
  return 'applied';
}

/** The children of a folder (or of the document, `null`) in the order they are shown: the sort setting of the folder if it has one, else the manual order. The list is kept, so it must not be changed. */
export function sortedChildren(model: DocModel, parentId: string | null): readonly ObjectNode[] {
  let kept = lists.get(model);
  if (!kept) { kept = new Map(); lists.set(model, kept); }
  const known = kept.get(parentId);
  if (known) return known;
  const ids = model.children.get(parentId);
  const sort = parentId === null ? model.meta?.sort??[] : sortOf(model.objects.get(parentId)?.props ?? {});
  const list = ids ? [...ids].map((id) => model.objects.get(id)!).sort(compareFor(sort)) : [];
  kept.set(parentId, list);
  return list;
}
