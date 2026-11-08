// What an older revision of a document can give back: how it differs from the document as it is (what is not there any more, what is different), the objects that
// were named copied into a new folder at the top level (never over what the document holds), and the whole document made what the revision was. All of it is
// an edit of the working copy, like any other: it is saved like one, and the document that is on disk is not written here.
import { isDeepStrictEqual } from 'node:util';
import { DocumentError, LIMITS, UUID, upgradeV1, validateDocument, validateNode, type Doc, type ObjectNode, type SecretRecord } from './model.js';
import { OpError, type Applied, type Env } from './ops.js';
import { referencedSecretIds, remapNodeReferences } from './references.js';

/** The ids of the objects of the revision that the document does not have, and of those that are not the same (another kind, name, folder or properties: the place among the siblings is not a difference), and how many objects the document has that the revision did not. */
export type Comparison = { gone: string[]; changed: string[]; added: number };

export function compare(current: Doc, revision: Doc): Comparison {
  const gone: string[] = [], changed: string[] = [];
  for (const [id, old] of Object.entries(revision.objects)) {
    const now = Object.hasOwn(current.objects, id) ? current.objects[id] : undefined;
    if (now === undefined) gone.push(id);
    else if (now.type !== old.type || now.name !== old.name || now.parentId !== old.parentId || !isDeepStrictEqual(now.props, old.props) || (current.schemaVersion === 2 && revision.schemaVersion === 2 && referencedSecretIds(old).some(secretId => !isDeepStrictEqual(current.secrets[secretId], revision.secrets[secretId])))) changed.push(id);
  }
  let added = 0;
  for (const id of Object.keys(current.objects)) if (!Object.hasOwn(revision.objects, id)) added++;
  return { gone: gone.sort(), changed: changed.sort(), added };
}

/**
 * Copies the objects named (and everything below them, whatever kind) from the revision into a new folder that ends the top level, in the order named: one that is named
 * twice, or is below another that is named, is copied once, and one whose folder is not named comes by itself. An object keeps its id when the document has no object with
 * it (so that what is restored is the same object for everybody who still has it), and gets a new one when it has; what is below follows its parent either way.
 */
export function restoreObjects(current: Doc, revision: Doc, ids: readonly string[], env: Env, folderName: string): Applied {
  if (current.schemaVersion === 1 && revision.schemaVersion === 2) throw new DocumentError('bad-document', 'A version 2 revision cannot be downgraded');
  if (current.schemaVersion === 2 && revision.schemaVersion === 1) revision = upgradeV1(revision);
  if (current.schemaVersion === 2 && (current.id !== revision.id || current.kind !== revision.kind)) throw new DocumentError('bad-document', 'The revision belongs to another document');
  const named = [...new Set(ids)];
  if (named.length === 0) throw new OpError('unknown-object', 'Nothing was chosen to restore');
  for (const id of named) if (!Object.hasOwn(revision.objects, id)) throw new OpError('unknown-object', 'The revision does not have that object');
  const chosen = new Set(named);
  const roots = named.filter((id) => { for (let up = revision.objects[id]!.parentId; up !== null; up = revision.objects[up]?.parentId ?? null) if (chosen.has(up)) return false; return true; });
  const children = new Map<string, ObjectNode[]>();
  for (const o of Object.values(revision.objects)) {
    if (o.parentId === null) continue;
    const group = children.get(o.parentId);
    if (group) group.push(o); else children.set(o.parentId, [o]);
  }
  const found: { node: ObjectNode; depth: number }[] = []; // the folder is the first level: what is named is the second
  for (const root of roots) {
    const first = found.length;
    found.push({ node: revision.objects[root]!, depth: 2 });
    for (let i = first; i < found.length; i++) for (const child of children.get(found[i]!.node.id) ?? []) found.push({ node: child, depth: found[i]!.depth + 1 });
  }
  if (Object.keys(current.objects).length + 1 + found.length > (env.limits?.maxObjects ?? LIMITS.maxObjects)) throw new DocumentError('too-many-objects', 'Too many objects');
  let deepest = 1;
  for (const { depth } of found) if (depth > deepest) deepest = depth;
  if (deepest > (env.limits?.maxDepth ?? LIMITS.maxDepth)) throw new DocumentError('too-deep', 'Folders nested too deeply');
  let last = -1;
  for (const o of Object.values(current.objects)) if (o.parentId === null && o.order > last) last = o.order;
  const used = new Set([...Object.keys(current.objects), ...found.map(({ node }) => node.id), ...(current.schemaVersion === 2 ? Object.keys(current.secrets) : [])]);
  if (revision.schemaVersion === 2) for (const { node } of found) for (const secretId of referencedSecretIds(node)) used.add(secretId);
  const fresh = (): string => {
    const id = env.newId();
    if (!UUID.test(id)) throw new DocumentError('bad-id', 'Invalid generated id');
    if (used.has(id)) throw new OpError('exists', 'An object or secret with that id exists');
    used.add(id); return id;
  };
  const folderId = fresh();
  const made = [validateNode({ id: folderId, type: 'folder', name: folderName, parentId: null, order: last + 1, props: {} }, folderId)];
  const copyId = new Map<string, string>(), rootAt = new Map(roots.map((id, i) => [id, i]));
  for (const { node } of found) copyId.set(node.id, Object.hasOwn(current.objects, node.id) ? fresh() : node.id);
  const secretIds: Record<string, string> = {}, copiedSecrets: Record<string, SecretRecord> = {};
  if (current.schemaVersion === 2 && revision.schemaVersion === 2) for (const { node } of found) for (const secretId of referencedSecretIds(node)) {
    if (Object.hasOwn(secretIds, secretId)) continue;
    if (!Object.hasOwn(revision.secrets, secretId)) throw new DocumentError('bad-props', 'A referenced secret is missing');
    const newId = Object.hasOwn(current.secrets, secretId) ? fresh() : secretId;
    secretIds[secretId] = newId; copiedSecrets[newId] = structuredClone(revision.secrets[secretId]!);
  }
  const objectIds = Object.fromEntries(copyId);
  for (const { node } of found) {
    const id = copyId.get(node.id)!, top = rootAt.get(node.id);
    const props = current.schemaVersion === 2 ? remapNodeReferences(node, { objectIds, secretIds, sourceDocumentId: revision.id, targetDocumentId: current.id }).props : structuredClone(node.props);
    made.push(validateNode({ id, type: node.type, name: node.name, parentId: top === undefined ? copyId.get(node.parentId!)! : folderId, order: top ?? node.order, props }, id));
  }
  const objects = { ...current.objects };
  for (const o of made) {
    if (Object.hasOwn(objects, o.id)) throw new OpError('exists', 'An object with that id exists');
    objects[o.id] = o;
  }
  const restored = current.schemaVersion === 2 ? validateDocument({ ...current, objects, secrets: { ...current.secrets, ...copiedSecrets } }) : { ...current, objects };
  return { doc: restored, change: { upsert: made, remove: [] }, created: folderId };
}

/** The document made what the revision was: its objects and its name; the identity and the revision number stay the document's, so that saving it is an edit like the others. */
export function restoreAll(current: Doc, revision: Doc): Doc {
  if (revision.id !== current.id || revision.kind !== current.kind) throw new DocumentError('bad-document', 'The revision belongs to another document');
  if (current.schemaVersion === 1 && revision.schemaVersion === 2) throw new DocumentError('bad-document', 'A version 2 revision cannot be downgraded');
  const old = current.schemaVersion === 2 && revision.schemaVersion === 1 ? upgradeV1(revision) : revision;
  return validateDocument({ ...structuredClone(old), id: current.id, kind: current.kind, revision: current.revision });
}
