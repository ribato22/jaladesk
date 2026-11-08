import assert from 'node:assert/strict';
import test from 'node:test';
import type { Json, ObjectNode, ObjectType } from '../src/documents/model.js';
import { COLORS, ICONS, MAX_NOTES, MAX_SORT, checkMeta, colorOf, compareFor, iconOf, notesOf, sortOf, type SortCriterion } from '../src/documents/meta.js';
import { compareSiblings } from '../src/documents/order.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, name: string, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name, parentId: null, order: 0, props: {}, ...over });
const folder = (n: number, name: string, over: Partial<ObjectNode> = {}) => node(n, name, { type: 'folder', ...over });
const order = (sort: SortCriterion[], ...list: ObjectNode[]) => [...list].sort(compareFor(sort)).map((o) => o.name);
const NAME_UP: SortCriterion = { by: 'name', dir: 'asc' };
const NAME_DOWN: SortCriterion = { by: 'name', dir: 'desc' };
const TYPE_UP: SortCriterion = { by: 'type', dir: 'asc' };
const TYPE_DOWN: SortCriterion = { by: 'type', dir: 'desc' };

test('the colours and the icons are fixed lists with a name each, and nothing is listed twice', () => {
  assert.equal(COLORS.length, 9);
  assert.equal(ICONS.length, 16);
  for (const list of [COLORS, ICONS]) {
    assert.equal(new Set(list.map((x) => x.id)).size, list.length, 'every id once');
    for (const x of list) {
      assert.match(x.id, /^[a-z]+$/, 'an id is a short lower-case word');
      assert.ok(x.label.trim().length > 0, `${x.id} has a name`);
    }
  }
  assert.equal(MAX_SORT, 2, 'two properties can be sorted by today: the name and the type');
});

test('what is stored is read back as itself and anything else as nothing: a document written by another writer can hold any value', () => {
  assert.equal(notesOf({ notes: 'ssh via the jump host' }), 'ssh via the jump host');
  for (const bad of [undefined, null, 5, true, ['x'], { a: 1 }]) assert.equal(notesOf({ notes: bad as Json }), '', JSON.stringify(bad));
  assert.equal(notesOf({}), '');
  assert.equal(colorOf({ color: 'red' }), 'red');
  assert.equal(iconOf({ icon: 'server' }), 'server');
  for (const bad of ['plaid', '', 'RED', 7, null, ['red'], 'constructor', '__proto__', 'toString']) {
    assert.equal(colorOf({ color: bad as Json }), undefined, `colour ${JSON.stringify(bad)}`);
    assert.equal(iconOf({ icon: bad as Json }), undefined, `icon ${JSON.stringify(bad)}`);
  }
  assert.equal(colorOf({}), undefined);
  assert.equal(iconOf({}), undefined);
});

test('a sort setting is one or two criteria, each a different property with a direction; anything else is read as no sort at all', () => {
  assert.deepEqual(sortOf({ sort: [NAME_DOWN] }), [NAME_DOWN]);
  assert.deepEqual(sortOf({ sort: [TYPE_UP, NAME_UP] }), [TYPE_UP, NAME_UP]);
  const bad: Json[] = [null, 'name', 7, {}, [], [{ by: 'name' }], [{ dir: 'asc' }], [{ by: 'date', dir: 'asc' }], [{ by: 'name', dir: 'up' }], [{ by: 'name', dir: 'asc' }, { by: 'name', dir: 'desc' }],
    [{ by: 'name', dir: 'asc', extra: 1 }], [1], [null], [['name', 'asc']], [NAME_UP, TYPE_UP, { by: 'name', dir: 'asc' }]];
  for (const value of bad) assert.deepEqual(sortOf({ sort: value }), [], JSON.stringify(value));
  assert.deepEqual(sortOf({}), []);
});

test('checkMeta names every value that may not be written: notes that are too long or not text, an unknown colour or icon, a sort that is invalid or on something that is not a folder', () => {
  const fields = (type: ObjectType, props: Record<string, Json>) => checkMeta(type, props).map((p) => p.field);
  assert.deepEqual(checkMeta('folder', {}), []);
  assert.deepEqual(checkMeta('connection', { notes: 'x'.repeat(MAX_NOTES), color: 'blue', icon: 'cloud', host: 'h' }), [], 'the longest notes, and properties it does not own');
  assert.deepEqual(checkMeta('folder', { notes: 'two\nlines\tand a tab', color: 'teal', icon: 'box', sort: [TYPE_UP, NAME_DOWN] }), []);
  assert.deepEqual(fields('connection', { notes: 'x'.repeat(MAX_NOTES + 1) }), ['notes']);
  const emoji = '\u{1F600}'.repeat(MAX_NOTES / 2);   // 2,000 characters as a person counts them, 4,000 units as the text box (maxlength) and the counter count them
  assert.equal(emoji.length, MAX_NOTES);
  assert.deepEqual(fields('connection', { notes: emoji }), [], 'the text box lets this much in');
  assert.deepEqual(fields('connection', { notes: emoji + 'a' }), ['notes'], 'and not one unit more');
  assert.deepEqual(fields('connection', { notes: 5 }), ['notes']);
  assert.deepEqual(fields('connection', { notes: null }), ['notes']);
  assert.deepEqual(fields('connection', { notes: 'a\u0000b' }), ['notes'], 'a control character is not text');
  assert.deepEqual(fields('connection', { color: 'plaid' }), ['color']);
  assert.deepEqual(fields('connection', { icon: 'nope' }), ['icon']);
  assert.deepEqual(fields('folder', { sort: [] }), ['sort'], 'an empty setting is removed by the writer, not stored');
  assert.deepEqual(fields('folder', { sort: 'name' }), ['sort']);
  assert.deepEqual(fields('folder', { sort: [NAME_UP, NAME_DOWN] }), ['sort']);
  assert.deepEqual(fields('connection', { sort: [NAME_UP] }), ['sort'], 'only a folder is sorted');
  assert.deepEqual(fields('folder', { notes: 5, color: 'x', icon: 'y', sort: 1 }), ['notes', 'color', 'icon', 'sort']);
  for (const problem of checkMeta('folder', { color: 'x', icon: 'y' })) assert.ok(problem.message.length > 0, 'every problem says what is wrong');
});

test('sorting by name ignores case and accents and reads digits as numbers; descending reverses it', () => {
  const list = [node(1, 'srv10'), node(2, 'srv2'), node(3, 'Srv1'), node(4, 'émile')];
  assert.deepEqual(order([NAME_UP], ...list), ['émile', 'Srv1', 'srv2', 'srv10']);
  assert.deepEqual(order([NAME_DOWN], ...list), ['srv10', 'srv2', 'Srv1', 'émile']);
});

test('sorting by type puts folders before connections, or after them when descending, and connections of one protocol together', () => {
  const list = [node(1, 'a', { props: { protocol: 'rdp' } }), folder(2, 'b'), node(3, 'c', { props: { protocol: 'ssh' } }), folder(4, 'd'), node(5, 'e', { props: { protocol: 'rdp' } })];
  assert.deepEqual(order([TYPE_UP], ...list), ['b', 'd', 'a', 'e', 'c'], 'folders, then rdp, then ssh; inside each the manual order, then the name');
  assert.deepEqual(order([TYPE_DOWN], ...list), ['c', 'a', 'e', 'b', 'd']);
});

test('the second criterion decides only between objects that are equal under the first', () => {
  const list = [node(1, 'zeta'), folder(2, 'beta'), node(3, 'alpha'), folder(4, 'alpha')];
  assert.deepEqual(order([TYPE_UP, NAME_UP], ...list), ['alpha', 'beta', 'alpha', 'zeta'], 'folders by name, then connections by name');
  assert.deepEqual(order([TYPE_UP, NAME_DOWN], ...list), ['beta', 'alpha', 'zeta', 'alpha']);
  assert.deepEqual(order([NAME_UP, TYPE_DOWN], ...list), ['alpha', 'alpha', 'beta', 'zeta'], 'equal names: the connection (type descending) before the folder');
  assert.equal([...list].sort(compareFor([NAME_UP, TYPE_DOWN]))[0]!.type, 'connection');
});

test('objects that are equal under every criterion keep the manual order, then the name, then the id: never the order they arrive in', () => {
  const x = node(1, 'same', { order: 5 }), y = node(2, 'Same', { order: 5 }), z = node(3, 'same', { order: 1 });
  const sort = [TYPE_UP];
  assert.deepEqual([x, y, z].sort(compareFor(sort)).map((o) => o.id), [id(3), id(1), id(2)]);
  assert.deepEqual([y, z, x].sort(compareFor(sort)).map((o) => o.id), [id(3), id(1), id(2)]);
});

test('no criteria is the manual order itself', () => {
  assert.equal(compareFor([]), compareSiblings);
});

/** A seeded generator (mulberry32) that gives a whole number below `n`. A congruential generator computed in float64 loses its low bits and soon gives the same number every time. */
function prng(seed: number): (n: number) => number {
  let a = seed;
  return (n) => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
}

test('whatever the order the objects arrive in, a sorted list is the same list (property over random objects and settings)', () => {
  const random = prng(7);
  const seen = { folders: 0, connections: 0, orders: new Set<number>(), protocols: new Set<string>(), settings: new Set<number>() };
  const names = ['alpha', 'Alpha', 'beta', 'srv1', 'srv2', 'srv10', 'émile', 'emile', 'zeta'];
  const settings: SortCriterion[][] = [[NAME_UP], [NAME_DOWN], [TYPE_UP], [TYPE_DOWN], [TYPE_UP, NAME_UP], [NAME_DOWN, TYPE_UP], [TYPE_DOWN, NAME_DOWN]];
  for (let round = 0; round < 60; round++) {
    const list = Array.from({ length: 24 }, (_, i) => {
      const o = random(3) === 0 ? folder(i + 1, names[random(names.length)]!, { order: random(4) }) : node(i + 1, names[random(names.length)]!, { order: random(4), props: { protocol: random(2) ? 'rdp' : 'ssh' } });
      seen[o.type === 'folder' ? 'folders' : 'connections']++;
      seen.orders.add(o.order);
      if (typeof o.props.protocol === 'string') seen.protocols.add(o.props.protocol);
      return o;
    });
    const which = random(settings.length);
    seen.settings.add(which);
    const sort = settings[which]!;
    const expected = [...list].sort(compareFor(sort)).map((o) => o.id);
    for (let shuffle = 0; shuffle < 6; shuffle++) {
      const mixed = [...list];
      for (let i = mixed.length - 1; i > 0; i--) { const j = random(i + 1); [mixed[i], mixed[j]] = [mixed[j]!, mixed[i]!]; }
      assert.deepEqual(mixed.sort(compareFor(sort)).map((o) => o.id), expected, `round ${round}, setting ${JSON.stringify(sort)}`);
    }
  }
  assert.ok(seen.folders > 100 && seen.connections > 300, `both kinds of objects are made: ${seen.folders} folders, ${seen.connections} connections`);
  assert.equal(seen.orders.size, 4, 'every manual order is made');
  assert.deepEqual([...seen.protocols].sort(), ['rdp', 'ssh']);
  assert.equal(seen.settings.size, settings.length, 'every setting is tried');
});

test('a property counts only when the object has it itself: what Object.prototype happens to hold is not stored', () => {
  const inherited: Record<string, unknown> = { notes: 'inherited', color: 'red', icon: 'box', sort: [{ by: 'name', dir: 'asc' }] };
  for (const [key, value] of Object.entries(inherited)) Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false });
  try {
    const props = {};
    assert.deepEqual([notesOf(props), colorOf(props), iconOf(props), sortOf(props)], ['', undefined, undefined, []]);
  } finally { for (const key of Object.keys(inherited)) delete (Object.prototype as Record<string, unknown>)[key]; }
});

test('notes are text: a tab, a line break and a carriage return are allowed, any other control character is refused wherever it stands', () => {
  const fields = (type: ObjectType, props: Record<string, Json>) => checkMeta(type, props).map((problem) => problem.field);
  for (const good of ['a\tb', 'a\nb', 'a\rb', 'a\r\nb', 'ünï — ✓ 日本語', '']) assert.deepEqual(fields('folder', { notes: good }), [], JSON.stringify(good));
  const refused = [...Array.from({ length: 9 }, (_, n) => n), 0x0b, 0x0c, ...Array.from({ length: 18 }, (_, n) => 0x0e + n), 0x7f];   // 0-8, 11, 12, 14-31 and 127
  for (const code of refused) {
    const c = String.fromCharCode(code);
    for (const text of [c, `a${c}`, `${c}b`]) assert.deepEqual(fields('folder', { notes: text }), ['notes'], `U+${code.toString(16).padStart(4, '0')} in ${JSON.stringify(text)}`);
  }
});

test('connections with no protocol, or one that is not text, come before those that have one, and the protocols are in order; the name decides what is left', () => {
  const none = node(1, 'a'), rdp = node(2, 'b', { props: { protocol: 'rdp' } }), odd = node(3, 'c', { props: { protocol: 5 } }), ssh = node(4, 'd', { props: { protocol: 'ssh' } });
  assert.deepEqual(order([TYPE_UP, NAME_UP], ssh, rdp, odd, none), ['a', 'c', 'b', 'd']);
  assert.deepEqual(order([TYPE_DOWN, NAME_UP], none, rdp, odd, ssh), ['d', 'b', 'a', 'c']);
  assert.deepEqual(order([TYPE_UP, NAME_DOWN], none, rdp, odd, ssh), ['c', 'a', 'b', 'd']);
});
