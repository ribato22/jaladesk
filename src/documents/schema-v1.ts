// The document model: a flat map of typed objects with stable ids, a parent pointer and a sibling order. Everything that
// reads a file goes through validateDocument(), so a damaged, hostile or merely newer file cannot reach the rest of the app.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectType = 'folder' | 'connection' | 'credential' | 'task' | 'template' | 'gateway' | 'dynamicProvider' | 'override';
export type ObjectNode = { id: string; type: ObjectType; name: string; parentId: string | null; order: number; props: Record<string, Json> };
export type DocV1 = { schemaVersion: 1; id: string; kind: 'workspace' | 'vault'; name: string; revision: number; objects: Record<string, ObjectNode> };

export const OBJECT_TYPES: readonly ObjectType[] = ['folder', 'connection', 'credential', 'task', 'template', 'gateway', 'dynamicProvider'];
export const LIMITS = { maxObjects: 100_000, maxDepth: 64, maxName: 256, maxProps: 256, maxPropDepth: 5, maxString: 64 * 1024, maxObjectBytes: 256 * 1024, maxBytes: 64 * 1024 * 1024 };

export type DocumentErrorCode =
  | 'bad-document' | 'unsupported-schema' | 'bad-json' | 'too-large' | 'bad-id' | 'bad-type' | 'bad-name' | 'bad-props' | 'bad-order'
  | 'bad-parent' | 'cycle' | 'too-deep' | 'too-many-objects';
export class DocumentError extends Error {
  constructor(readonly code: DocumentErrorCode, message: string) { super(message); this.name = 'DocumentError'; }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROP_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
export function fail(code: DocumentErrorCode, message: string): never { throw new DocumentError(code, message); }

export function checkJson(value: unknown, depth: number): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('bad-props', 'Non-finite number'); return; }
  if (typeof value === 'string') { if (value.length > LIMITS.maxString) fail('bad-props', 'String too long'); return; }
  if (Array.isArray(value) || isRecord(value)) {
    if (depth > LIMITS.maxPropDepth) fail('bad-props', 'Properties nested too deeply');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('bad-props', 'Not plain data'); // a Map, a Date or a class instance is not JSON
    for (const item of Array.isArray(value) ? value : Object.values(value)) checkJson(item, depth + 1);
    if (isRecord(value)) for (const key of Object.keys(value)) if (!PROP_KEY.test(key)) fail('bad-props', 'Invalid property name');
    return;
  }
  return fail('bad-props', 'Not a JSON value');
}

/** What can be said about one object on its own; how objects relate (parents, cycles, depth, count) is checked by validateDocument, or by the operation that changes them. */
export function validateNode(o: unknown, key?: string, allowOverride = true): ObjectNode {
  if (!isRecord(o)) return fail('bad-document', 'An object is not a record');
  if (Object.keys(o).some((k) => !['id', 'type', 'name', 'parentId', 'order', 'props'].includes(k))) fail('bad-document', 'Unknown object field');
  if (typeof o.id !== 'string' || !UUID.test(o.id) || (key !== undefined && o.id !== key)) fail('bad-id', 'Invalid or mismatched object id');
  if (typeof o.type !== 'string' || !((OBJECT_TYPES as readonly string[]).includes(o.type) || (allowOverride && o.type === 'override'))) fail('bad-type', 'Unknown object type');
  if (typeof o.name !== 'string' || o.name.length > LIMITS.maxName) fail('bad-name', 'Invalid object name');
  if (!Number.isSafeInteger(o.order) || (o.order as number) < 0) fail('bad-order', 'Invalid sibling order');
  if (o.parentId !== null && typeof o.parentId !== 'string') fail('bad-parent', 'Invalid parent');
  if (!isRecord(o.props) || Object.keys(o.props).length > LIMITS.maxProps) fail('bad-props', 'Invalid properties');
  for (const k of Object.keys(o.props)) if (!PROP_KEY.test(k)) fail('bad-props', 'Invalid property name');
  checkJson(o.props, 0);
  if (JSON.stringify(o.props).length > LIMITS.maxObjectBytes) fail('bad-props', 'Properties too large');
  return o as ObjectNode;
}

export type ValidationOptions = { maxObjects?: number; maxDepth?: number };
export function validateBase(value: unknown, schemaVersion: 1 | 2, options: ValidationOptions = {}): Record<string, unknown> {
  const maxObjects = options.maxObjects ?? LIMITS.maxObjects;
  const maxDepth = options.maxDepth ?? LIMITS.maxDepth;
  if (!isRecord(value)) return fail('bad-document', 'The document is not an object');
  const allowed = ['schemaVersion', 'id', 'kind', 'name', 'revision', 'objects', ...(schemaVersion === 2 ? ['meta', 'defaults', 'secrets'] : [])];
  if (Object.keys(value).some((k) => !allowed.includes(k))) fail('bad-document', 'Unknown top-level field');
  if (value.schemaVersion !== schemaVersion) fail('unsupported-schema', 'Schema version not supported');
  if (typeof value.id !== 'string' || !UUID.test(value.id)) fail('bad-id', 'Invalid document id');
  if (value.kind !== 'workspace' && value.kind !== 'vault' && !(schemaVersion === 2 && value.kind === 'overrides')) fail('bad-document', 'Invalid document kind');
  if (typeof value.name !== 'string' || value.name.length > LIMITS.maxName) fail('bad-name', 'Invalid document name');
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) fail('bad-document', 'Invalid revision');
  if (!isRecord(value.objects)) return fail('bad-document', 'Missing objects');
  const objects = value.objects;
  const keys = Object.keys(objects);
  if (keys.length > maxObjects) fail('too-many-objects', 'Too many objects');
  for (const key of keys) {
    const node = validateNode(objects[key], key, schemaVersion === 2);
    if (node.type === 'override' && value.kind !== 'overrides') fail('bad-type', 'An override requires a private overrides document');
  }
  const typeOf = (id: string) => (objects[id] as Record<string, unknown> | undefined)?.type;
  for (const key of keys) {
    const parent = (objects[key] as Record<string, unknown>).parentId as string | null;
    if (parent !== null && typeOf(parent) !== 'folder') fail('bad-parent', 'A parent must be an existing folder');
  }
  const depth = new Map<string, number>();
  for (const key of keys) {
    const path: string[] = [];
    let cursor: string | null = key;
    while (cursor !== null && !depth.has(cursor)) {
      if (path.includes(cursor)) return fail('cycle', 'The folder tree contains a cycle');
      path.push(cursor);
      cursor = (objects[cursor] as Record<string, unknown>).parentId as string | null;
    }
    let d = cursor === null ? 0 : depth.get(cursor)!;
    for (let i = path.length - 1; i >= 0; i--) { depth.set(path[i]!, ++d); if (d > maxDepth) fail('too-deep', 'Folders nested too deeply'); }
  }
  return value;
}

export function validateV1(value: unknown, options: ValidationOptions = {}): DocV1 { return validateBase(value, 1, options) as DocV1; }
