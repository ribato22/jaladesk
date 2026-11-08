import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, parseDocument, serializeDocument, migrate, upgradeV1, validateV1, DocumentError, type DocV1, type ObjectNode } from '../src/documents/model.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: 0, props: {}, ...over });
const doc = (...nodes: ObjectNode[]): DocV1 => ({ schemaVersion: 1, id: id(900), kind: 'workspace', name: 'test', revision: 0, objects: Object.fromEntries(nodes.map((x) => [x.id, x])) });
const fails = (value: unknown, code: string, options?: Parameters<typeof validateDocument>[1]) =>
  assert.throws(() => validateDocument(value, options), (e: unknown) => e instanceof DocumentError && e.code === code, `expected ${code}`);

test('a well-formed document validates and is returned unchanged', () => {
  const d = doc(node(1, { type: 'folder' }), node(2, { parentId: id(1), props: { host: 'h', port: 3389, tags: ['a'], nested: { x: [1, null, true] } } }));
  assert.deepEqual(validateDocument(structuredClone(d)), d);
});

test('structure rules: ids, types, parents, cycles, depth', () => {
  fails(doc(node(1, { id: 'not-a-uuid' })), 'bad-id');
  fails({ ...doc(node(1)), objects: { [id(2)]: node(1) } }, 'bad-id'); // key differs from the node id
  fails(doc(node(1, { type: 'spaceship' as never })), 'bad-type');
  fails(doc(node(1, { parentId: id(7) })), 'bad-parent');
  fails(doc(node(1), node(2, { parentId: id(1) })), 'bad-parent'); // a connection cannot have children
  fails(doc(node(1, { type: 'folder', parentId: id(2) }), node(2, { type: 'folder', parentId: id(1) })), 'cycle');
  fails(doc(node(1, { type: 'folder' }), node(2, { type: 'folder', parentId: id(1) }), node(3, { type: 'folder', parentId: id(2) })), 'too-deep', { maxDepth: 2 });
});

test('size and shape bounds: object count, names, property count and depth, numbers, order, unknown keys', () => {
  fails(doc(node(1), node(2), node(3)), 'too-many-objects', { maxObjects: 2 });
  fails(doc(node(1, { name: 'x'.repeat(257) })), 'bad-name');
  fails(doc(node(1, { props: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, 1])) })), 'bad-props');
  fails(doc(node(1, { props: { 'bad key': 1 } })), 'bad-props');
  fails(doc(node(1, { props: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } })), 'bad-props'); // six containers below the properties; five are allowed
  fails(doc(node(1, { props: { n: Infinity } })), 'bad-props');
  fails(doc(node(1, { order: 1.5 })), 'bad-order');
  fails(doc(node(1, { order: -1 })), 'bad-order');
  fails({ ...doc(node(1)), surprise: true }, 'bad-document');
  fails({ ...doc(node(1)), revision: -1 }, 'bad-document');
  fails({ ...doc(node(1)), kind: 'other' }, 'bad-document');
  fails(null, 'bad-document');
});

test('serialisation is deterministic and parsing validates', () => {
  const a = doc(node(2, { props: { b: 1, a: 2 } }), node(1));
  const b = doc(node(1), node(2, { props: { a: 2, b: 1 } })); // same content, other insertion order
  assert.equal(serializeDocument(a).toString(), serializeDocument(b).toString());
  assert.deepEqual(parseDocument(serializeDocument(a)), upgradeV1(a));
  assert.throws(() => validateV1(parseDocument(serializeDocument(a))), DocumentError, 'the legacy reader still refuses payload 2');
  assert.throws(() => parseDocument(Buffer.from('{nope')), (e: unknown) => e instanceof DocumentError && e.code === 'bad-json');
  assert.throws(() => parseDocument(Buffer.alloc(100), { maxBytes: 50 }), (e: unknown) => e instanceof DocumentError && e.code === 'too-large');
  assert.throws(() => parseDocument(Buffer.from('{"schemaVersion":3}')), (e: unknown) => e instanceof DocumentError && e.code === 'unsupported-schema');
});

test('migration is a pure chain of steps; a newer file than this build understands is refused, never guessed', () => {
  const steps = { 0: (d: Record<string, unknown>) => ({ ...d, schemaVersion: 1, kind: 'workspace' }) };
  const old = { schemaVersion: 0, id: id(900), name: 'old', revision: 3, objects: {} };
  const frozen = structuredClone(old);
  const result = migrate(old, steps);
  assert.deepEqual(result, upgradeV1({ schemaVersion: 1, id: id(900), name: 'old', revision: 3, objects: {}, kind: 'workspace' }));
  assert.deepEqual(old, frozen, 'the input is not modified');
  assert.throws(() => migrate({ schemaVersion: 3 }, steps), (e: unknown) => e instanceof DocumentError && e.code === 'unsupported-schema');
  assert.throws(() => migrate({ schemaVersion: -1 }, steps), (e: unknown) => e instanceof DocumentError && e.code === 'unsupported-schema');
  assert.throws(() => migrate({ schemaVersion: 0 }, {}), (e: unknown) => e instanceof DocumentError && e.code === 'unsupported-schema'); // a gap in the chain
});

test('an order that cannot be added to, and properties that are not plain data, are refused: a file is not trusted', () => {
  fails(doc(node(1, { order: 2 ** 53 })), 'bad-order');
  fails(doc(node(1, { order: 1e300 })), 'bad-order');
  assert.doesNotThrow(() => validateDocument(doc(node(1, { order: Number.MAX_SAFE_INTEGER - 1 }))));
  class Odd { x = 1; }
  fails(doc(node(1, { props: { when: new Date(0) } as never })), 'bad-props');
  fails(doc(node(1, { props: { list: new Map([['a', 1]]) } as never })), 'bad-props');
  fails(doc(node(1, { props: { odd: new Odd() } as never })), 'bad-props');
  fails(doc(node(1, { props: new Map() as never })), 'bad-props');
  assert.doesNotThrow(() => validateDocument(JSON.parse(JSON.stringify(doc(node(1, { props: { a: { b: [1, { c: null }] } } }))))));
  assert.doesNotThrow(() => validateDocument(doc(node(1, { props: Object.assign(Object.create(null), { a: 1 }) }))));
});
