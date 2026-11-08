// What a person sees of the conflicts a merge left, and what they can do about them. The merge keeps "mine" provisionally and reports; here each report
// is shown without anything the window must not know (the id of an object, the name or the value of an object of a kind the window never sees), and
// each can be decided: a field is mine or theirs, an object that was deleted on one side and edited on the other is kept or deleted, an orphan is kept at
// the top level or deleted, a cycle is accepted (the merge already put the folders back). Deciding is pure: it gives a new document and the conflicts that
// are still to be decided, never changes the one it is given, and a set of choices is made whole or not at all.
import { createHash } from 'node:crypto';
import { setDocumentValue, setCredentialGroupState, type Conflict } from './merge.js';
import { DocumentError, validateDocument, type Doc, type Json, type ObjectNode } from './model.js';
import { publicConflictField } from './projection.js';

export type Choice = 'mine' | 'theirs' | 'keep' | 'delete' | 'accept';
/**
 * A value as the window shows it: its text (cut when it is long), or that there is no value, that it is the top level, or that the folder is not there. `json`: the value is
 * not text, and which kind of value it is (the number 3390 and the text "3390" would be told by the same characters).
 */
export type Value = { text: string; none?: true; top?: true; gone?: true; cut?: true; json?: 'number' | 'boolean' | 'null' | 'array' | 'object' };
type Shown = 'folder' | 'connection';
export type ConflictView =
  | { key: string; kind: 'field'; choices: Choice[]; object: string; objectType: Shown | 'document'; field: string; what: 'name' | 'parent' | 'type' | 'property' | 'document-name'; property?: string; base: Value; mine: Value; theirs: Value }
  | { key: string; kind: 'delete-edit'; choices: Choice[]; object: string; objectType: Shown; deletedBy: 'mine' | 'theirs'; below: number }
  | { key: string; kind: 'orphan'; choices: Choice[]; object: string; objectType: Shown; below: number }
  | { key: string; kind: 'cycle'; choices: Choice[]; objects: string[]; total: number }
  | { key: string; kind: 'hidden'; of: 'field' | 'delete-edit' | 'orphan'; choices: Choice[] };

export type ConflictErrorCode = 'bad-choice' | 'unknown-conflict';
export class ConflictError extends Error {
  constructor(readonly code: ConflictErrorCode, message: string) { super(message); this.name = 'ConflictError'; }
}

export const MAX_VALUE = 400; // characters of a value that the window is told
const MAX_NAMES = 10;         // folders of a cycle that are named
const own = (objects: Record<string, ObjectNode>, id: string): ObjectNode | undefined => (Object.hasOwn(objects, id) ? objects[id] : undefined);

/** Names the conflict without telling what it is about: a hash of its kind and of what it is about (the field, or the folders of a cycle in order), so that it can be found again in the list the main process holds. */
export function keyOf(conflict: Conflict): string {
  const parts = conflict.kind === 'field' ? [conflict.kind, conflict.id, conflict.field] : conflict.kind === 'cycle' ? [conflict.kind, ...[...conflict.ids].sort()] : [conflict.kind, conflict.id];
  return `c-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)}`;
}

export const choicesOf = (conflict: Conflict): Choice[] => (conflict.kind === 'field' ? ['mine', 'theirs'] : conflict.kind === 'cycle' ? ['accept'] : ['keep', 'delete']);

/** What "mine" or "theirs" for everything means for one conflict: a field is that side's, an object that one side deleted and the other edited is deleted when that side is chosen and kept otherwise, and the other two stay as the merge made them. */
export function sideChoice(conflict: Conflict, side: 'mine' | 'theirs'): Choice {
  switch (conflict.kind) {
    case 'field': return side;
    case 'delete-edit': return conflict.deletedBy === side ? 'delete' : 'keep';
    case 'orphan': return 'keep';
    case 'cycle': return 'accept';
  }
}

/**
 * What "mine for everything" or "theirs for everything" decides, one item for each conflict in the order of the conflicts: `sideChoice`, except that an orphan follows the delete-edit
 * about the same object when there is one. An object that a side deleted together with its folder is both, and what that side chooses for the delete-edit is what it chooses for the
 * object (deleted when it is the side that deleted it, kept otherwise): an orphan on its own stays as the merge made it.
 */
export function sideItems(conflicts: readonly Conflict[], side: 'mine' | 'theirs'): { key: string; choice: Choice }[] {
  const ofEdit = new Map<string, Choice>();
  for (const conflict of conflicts) if (conflict.kind === 'delete-edit') ofEdit.set(conflict.id, sideChoice(conflict, side));
  return conflicts.map((conflict) => ({ key: keyOf(conflict), choice: (conflict.kind === 'orphan' ? ofEdit.get(conflict.id) : undefined) ?? sideChoice(conflict, side) }));
}

const kindOfJson = (value: Json): NonNullable<Value['json']> => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : (typeof value as 'number' | 'boolean'));

function show(value: Json | undefined): Value {
  if (value === undefined) return { text: '', none: true };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const kind = typeof value === 'string' ? {} : { json: kindOfJson(value) };
  if (text.length <= MAX_VALUE) return { text, ...kind };
  const end = (text.charCodeAt(MAX_VALUE - 1) & 0xfc00) === 0xd800 ? MAX_VALUE - 1 : MAX_VALUE; // not in the middle of a character of two units
  return { text: text.slice(0, end), cut: true, ...kind };
}

function showParent(doc: Doc, value: Json | undefined): Value {
  if (value === undefined) return { text: '', none: true }; // a side that did not have the object at all (both added it, in other folders) has no parent: that is not the top level
  if (value === null) return { text: '', top: true };
  const folder = typeof value === 'string' ? own(doc.objects, value) : undefined;
  return folder?.type === 'folder' ? { text: folder.name } : { text: '', gone: true };
}

/** For each object the ids of what is directly below it. */
function childrenOf(objects: Record<string, ObjectNode>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const o of Object.values(objects)) {
    if (o.parentId === null) continue;
    const group = children.get(o.parentId);
    if (group) group.push(o.id); else children.set(o.parentId, [o.id]);
  }
  return children;
}

/** How many objects of the kinds the window shows are below `id`, at any depth (what is not shown is not counted: how much of it there is, is not for the window to know). */
function shownBelow(objects: Record<string, ObjectNode>, children: Map<string, string[]>, id: string): number {
  const seen = new Set<string>([id]), queue = [id];
  let count = 0;
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
      const o = own(objects, child);
      if (o && (o.type === 'folder' || o.type === 'connection')) count++;
    }
  }
  return count;
}

function view(doc: Doc, conflict: Conflict, below: (id: string) => number): ConflictView {
  const key = keyOf(conflict), choices = choicesOf(conflict);
  if (conflict.kind === 'cycle') {
    const names = conflict.ids.flatMap((id) => { const folder = own(doc.objects, id); return folder ? [folder.name] : []; });
    return { key, kind: 'cycle', choices, objects: names.slice(0, MAX_NAMES), total: conflict.ids.length };
  }
  if (conflict.kind === 'field' && conflict.field === 'document.name') {
    return { key, kind: 'field', choices, object: doc.name, objectType: 'document', field: conflict.field, what: 'document-name', base: show(conflict.base), mine: show(conflict.mine), theirs: show(conflict.theirs) };
  }
  const target = own(doc.objects, conflict.id);
  if (target === undefined || (target.type !== 'folder' && target.type !== 'connection')) return { key, kind: 'hidden', of: conflict.kind, choices };
  const objectType = target.type, object = target.name;
  if (conflict.kind === 'delete-edit') return { key, kind: 'delete-edit', choices, object, objectType, deletedBy: conflict.deletedBy, below: below(conflict.id) };
  if (conflict.kind === 'orphan') return { key, kind: 'orphan', choices, object, objectType, below: below(conflict.id) };
  const { field } = conflict;
  if (field === 'parentId') return { key, kind: 'field', choices, object, objectType, field, what: 'parent', base: showParent(doc, conflict.base), mine: showParent(doc, conflict.mine), theirs: showParent(doc, conflict.theirs) };
  const sides = { base: show(conflict.base), mine: show(conflict.mine), theirs: show(conflict.theirs) };
  if (field === 'name' || field === 'type') return { key, kind: 'field', choices, object, objectType, field, what: field, ...sides };
  if (publicConflictField(field, [conflict.base,conflict.mine,conflict.theirs])) return { key, kind: 'field', choices, object, objectType, field, what: 'property', property: field.slice(6), ...sides };
  return { key, kind: 'hidden', of: 'field', choices }; // a field that no merge makes: nothing is said about it
}

/** One view for each conflict, in the same order; `doc` is the document the merge made, which holds the names. */
export function describe(doc: Doc, conflicts: readonly Conflict[]): ConflictView[] {
  let children: Map<string, string[]> | undefined;
  const below = (id: string): number => shownBelow(doc.objects, (children ??= childrenOf(doc.objects)), id);
  return conflicts.map((conflict) => view(doc, conflict, below));
}

/** Whether what the conflict is about is still in the document: the name of the document always is. */
const there = (doc: Doc, conflict: Conflict): boolean =>
  conflict.kind === 'cycle' ? conflict.ids.every((id) => own(doc.objects, id) !== undefined) : conflict.kind === 'field' && conflict.field.startsWith('document.') ? true : own(doc.objects, conflict.id) !== undefined;

/** The conflicts that are still about something: a choice that deleted an object, or what was below it, took its conflicts with it. */
export const prune = (doc: Doc, conflicts: readonly Conflict[]): Conflict[] => conflicts.filter((conflict) => there(doc, conflict));

/**
 * What choices made earlier make sure of, for the ones that follow (the session holds it until the file is written or another version of it is taken in): `kept`, the objects that
 * were chosen to be kept, which stay whatever else is chosen for them; `placed`, the objects that were put in a folder by choosing their parent, which only stay when that folder is
 * deleted later. A set of choices is made all at once, but a person decides a few at a time: without this, an object that was kept goes with its folder when the folder is decided next.
 */
export type Remembered = { readonly kept: ReadonlySet<string>; readonly placed: ReadonlySet<string> };
const NOTHING: Remembered = { kept: new Set(), placed: new Set() };

/**
 * The document with the choices made, checked once as a whole: "mine", "keep" and "accept" leave it as it is (what it holds now is what this side keeps, also
 * what was edited since), "theirs" puts their value in and "delete" removes the object and everything below it. What "theirs" puts in is put in first, so that an
 * object that they moved out of a folder that is deleted goes with their parent and not with the folder; an object that was chosen to be kept (now or earlier), in a folder that is
 * deleted, stays, at the top level, with what is below it, and so does one that was put in that folder earlier by choosing their parent. A choice about what a delete took away
 * has nothing left to do; a value that would make the document invalid (their parent can be a folder that this side deleted, or that the same choices delete) is refused,
 * as is the whole. What is chosen to be kept is kept. With what is remembered for the next choices.
 */
function choose(doc: Doc, picks: readonly { conflict: Conflict; choice: Choice }[], before: Remembered): { doc: Doc; remembered: Remembered } {
  let documentPatch: Doc | undefined;
  const patched = new Map<string, ObjectNode>();
  const parents: string[] = []; // the parents that "theirs" chose
  const placed = new Set<string>();
  let name = doc.name;
  for (const { conflict, choice } of picks) {
    if (conflict.kind !== 'field' || choice !== 'theirs') continue;
    if (conflict.field === 'document.name') { name = conflict.theirs as string; continue; }
    if (conflict.field.startsWith('document.')) {
      documentPatch ??= structuredClone(doc);
      setDocumentValue(documentPatch, conflict.field, conflict.theirs); continue;
    }
    const current = patched.get(conflict.id) ?? own(doc.objects, conflict.id);
    if (current === undefined) continue;
    const node = patched.get(conflict.id) ?? { ...current, props: { ...current.props } }; // never the object that the given document holds
    if(conflict.field==='props.groups.credentials'){setCredentialGroupState(node,conflict.theirs);patched.set(conflict.id,node);continue;}
    if (conflict.field.startsWith('props.')) {
      const key = conflict.field.slice(6);
      if (key.startsWith('groups.') || key.startsWith('inherit.')) {
        const [section, group] = key.split('.'); const values = { ...(node.props[section] as Record<string, Json> ?? {}) };
        if (conflict.theirs === undefined) delete values[group]; else values[group] = structuredClone(conflict.theirs);
        node.props[section] = values;
      } else if (conflict.theirs === undefined) delete node.props[key]; else node.props[key] = structuredClone(conflict.theirs);
    } else {
      (node as Record<string, unknown>)[conflict.field] = structuredClone(conflict.theirs);
      if (conflict.field === 'parentId' && typeof conflict.theirs === 'string') { parents.push(conflict.theirs); placed.add(conflict.id); }
    }
    patched.set(conflict.id, node);
  }
  const deleted: string[] = [], kept = new Set<string>();
  for (const id of before.kept) if (own(doc.objects, id) !== undefined) kept.add(id);
  for (const { conflict, choice } of picks) {
    if ((conflict.kind !== 'delete-edit' && conflict.kind !== 'orphan') || own(doc.objects, conflict.id) === undefined) continue;
    if (choice === 'delete') deleted.push(conflict.id); else if (choice === 'keep') kept.add(conflict.id);
  }
  // What was asked to be kept is kept, also when another choice about the same object asks for it to be deleted (two conflicts can be about one object).
  for (let i = deleted.length - 1; i >= 0; i--) if (kept.has(deleted[i]!)) deleted.splice(i, 1);
  const remember = (next: Doc): Remembered => ({
    kept: new Set([...kept].filter((id) => own(next.objects, id) !== undefined)),
    placed: new Set([...before.placed, ...placed].filter((id) => own(next.objects, id) !== undefined)),
  });
  if (deleted.length === 0 && patched.size === 0 && name === doc.name && !documentPatch) return { doc, remembered: remember(doc) };
  const objects = { ...doc.objects };
  for (const [id, node] of patched) objects[id] = node;
  const gone = new Set<string>(), rescued = new Set<string>();
  if (deleted.length > 0) {
    const children = childrenOf(objects);
    const queue = [...deleted];
    for (let i = 0; i < queue.length; i++) { // by position: a long array is not shifted, nor spread into push()
      const at = queue[i]!;
      if (gone.has(at)) continue;
      gone.add(at);
      for (const child of children.get(at) ?? []) { if (kept.has(child) || before.placed.has(child)) rescued.add(child); else queue.push(child); }
    }
  }
  if (parents.some((parent) => gone.has(parent))) throw new DocumentError('bad-parent', 'An object cannot be moved into a folder that is deleted');
  for (const id of gone) delete objects[id];
  let order = 0;
  for (const o of Object.values(objects)) if (o.parentId === null && !rescued.has(o.id) && o.order >= order) order = o.order + 1;
  for (const id of [...rescued].sort()) objects[id] = { ...objects[id]!, parentId: null, order: order++ };
  const next = validateDocument({ ...(documentPatch ?? doc), name, objects });
  return { doc: next, remembered: remember(next) };
}

/** The document with one choice made; a choice that does not belong to the kind of the conflict is refused. */
export function resolveConflict(doc: Doc, conflict: Conflict, choice: Choice): Doc {
  if (!choicesOf(conflict).includes(choice)) throw new ConflictError('bad-choice', 'That choice does not belong to this conflict');
  return choose(doc, [{ conflict, choice }], NOTHING).doc;
}

/**
 * Several choices, by the keys of the conflicts, made together or not at all: a key that is not in the list, a conflict decided twice and a choice that does
 * not belong to its conflict are refused, and so is a result that is not a document. What is not chosen is still to be decided, if it is still about something.
 * `before` is what the choices made earlier made sure of, and `remembered` what the next ones have to be given.
 */
export function resolveMany(doc: Doc, conflicts: readonly Conflict[], items: readonly { key: string; choice: Choice }[], before: Remembered = NOTHING): { doc: Doc; conflicts: Conflict[]; remembered: Remembered } {
  const at = new Map(conflicts.map((conflict, i) => [keyOf(conflict), i]));
  const chosen = new Map<number, Choice>();
  for (const { key, choice } of items) {
    const i = at.get(key);
    if (i === undefined) throw new ConflictError('unknown-conflict', 'There is no such conflict');
    if (chosen.has(i)) throw new ConflictError('bad-choice', 'A conflict is decided once');
    if (!choicesOf(conflicts[i]!).includes(choice)) throw new ConflictError('bad-choice', 'That choice does not belong to this conflict');
    chosen.set(i, choice);
  }
  const next = choose(doc, [...chosen].map(([i, choice]) => ({ conflict: conflicts[i]!, choice })), before);
  return { doc: next.doc, conflicts: prune(next.doc, conflicts.filter((_, i) => !chosen.has(i))), remembered: next.remembered };
}
