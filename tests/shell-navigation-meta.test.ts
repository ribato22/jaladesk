import assert from 'node:assert/strict';
import test from 'node:test';
import type { Json, ObjectNode } from '../src/documents/model.js';
import { modelOf, sortedChildren, type DocModel } from '../src/desktop/docmodel.js';
import { buildRows, documentKey, fold, isSorted, moveTarget, narrows, objectKey, resolveDrop, type RowFilter, type RowView } from '../src/desktop/navigation.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, type: ObjectNode['type'], name: string, parent: number | null, order = 0, props: Record<string, Json> = {}): ObjectNode =>
  ({ id: id(n), type, name, parentId: parent === null ? null : id(parent), order, props });
const view = (sessionId: string, name: string, objects: ObjectNode[]): DocModel =>
  modelOf({ id: sessionId, docId: id(900), name, revision: 1, dirty: false, conflicts: 0, seq: 0, objects });
const everything = (...models: DocModel[]) => new Set(models.flatMap((m) => [documentKey(m.id), ...[...m.objects.keys()].map((o) => objectKey(m.id, o))]));
const names = (rows: { name: string }[]) => rows.map((r) => r.name);
const filter = (query: string, over: Partial<RowFilter> = {}): RowFilter => ({ query, notes: false, onlyFavorites: false, ...over });
const SORT_DOWN: Json = [{ by: 'name', dir: 'desc' }];

// Lab > Prod (folder) > [web1 (host web1.prod.example), db1 (host db.prod.example, notes "backup runs at night")], Test (folder) > [web2], jump (connection, host Jump.example), Café (connection)
const lab = () => view('s1', 'Lab', [
  node(1, 'folder', 'Prod', null, 0), node(2, 'connection', 'web1', 1, 0, { host: 'web1.prod.example' }), node(3, 'connection', 'db1', 1, 1, { host: 'db.prod.example', notes: 'backup runs at night' }),
  node(4, 'folder', 'Test', null, 1), node(5, 'connection', 'web2', 4, 0, { host: 'web2.test.example' }),
  node(6, 'connection', 'jump', null, 2, { host: 'Jump.example' }), node(7, 'connection', 'Café', null, 3),
]);

test('a row carries what the object chose to be seen as, and only that: an icon, a colour, a mark for notes and for a favourite, and for a folder that it is sorted', () => {
  const model = view('s1', 'Lab', [
    node(1, 'folder', 'plain', null, 0), node(2, 'folder', 'dressed', null, 1, { icon: 'box', color: 'teal', notes: 'hello', sort: SORT_DOWN }),
    node(3, 'connection', 'c', null, 2, { icon: 'server', color: 'red' }), node(4, 'connection', 'fav', null, 3),
  ]);
  const rows = buildRows([model], everything(model), { favorites: new Map([['s1', new Set([id(4)])]]) });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  for (const key of ['icon', 'color', 'favorite', 'note', 'sorted']) assert.equal(key in by.plain!, false, `a plain folder has no ${key}`);
  assert.deepEqual([by.dressed!.icon, by.dressed!.color, by.dressed!.note, by.dressed!.sorted, 'favorite' in by.dressed!], ['box', 'teal', true, true, false]);
  assert.deepEqual([by.c!.icon, by.c!.color, 'note' in by.c!, 'sorted' in by.c!], ['server', 'red', false, false]);
  assert.deepEqual([by.fav!.favorite, 'icon' in by.fav!, 'color' in by.fav!], [true, false, false]);
  assert.equal(by.Lab!.favorite, undefined, 'the document row has none of them');
});

test('a value this app does not know is not a mark: another writer may have stored anything', () => {
  const model = view('s1', 'Lab', [node(1, 'folder', 'f', null, 0, { icon: 'toString', color: 'plaid', notes: 5, sort: [{ by: 'date', dir: 'asc' }] }), node(2, 'connection', 'c', null, 1, { notes: '' })]);
  const rows = buildRows([model], everything(model));
  for (const row of rows.slice(1)) for (const key of ['icon', 'color', 'note', 'sorted']) assert.equal(key in row, false, `${row.name} ${key}`);
});

test('the rows of a sorted folder come in its sort order and a row says where it stands in that order', () => {
  const model = view('s1', 'Lab', [node(1, 'folder', 'sorted', null, 0, { sort: SORT_DOWN }), node(2, 'connection', 'a', 1, 0), node(3, 'connection', 'c', 1, 1), node(4, 'connection', 'b', 1, 2)]);
  const rows = buildRows([model], everything(model));
  assert.deepEqual(rows.slice(2).map((r) => [r.name, r.posInSet, r.setSize]), [['c', 1, 3], ['b', 2, 3], ['a', 3, 3]]);
});

test('no search and no favourites filter is the tree as it was: nothing is hidden and nothing is opened that was closed', () => {
  const model = lab();
  const closed = new Set([documentKey('s1')]);
  for (const f of [undefined, filter(''), filter('   ')]) assert.deepEqual(buildRows([model], closed, f ? { filter: f } : {}), buildRows([model], closed));
});

test('a search keeps the objects whose name or host has every word, without regard to case or accents, and the folders above them, all opened', () => {
  const model = lab();
  const closed = new Set([documentKey('s1')]);
  const rows = (query: string) => buildRows([model], closed, { filter: filter(query) });
  assert.deepEqual(names(rows('web')), ['Lab', 'Prod', 'web1', 'Test', 'web2'], 'two folders closed in the tree are open now, because something below them matches');
  assert.deepEqual(names(rows('PROD')), ['Lab', 'Prod', 'web1', 'db1'], 'the name of a folder and a host that has the word, in any case');
  assert.deepEqual(names(rows('db.prod')), ['Lab', 'Prod', 'db1'], 'a host');
  assert.deepEqual(names(rows('jump')), ['Lab', 'jump'], 'a connection at the top level');
  assert.deepEqual(names(rows('cafe')), ['Lab', 'Café'], 'without regard to accents');
  assert.deepEqual(names(rows('CAFÉ')), ['Lab', 'Café']);
  assert.deepEqual(names(rows('web prod')), ['Lab', 'Prod', 'web1'], 'every word must be somewhere in the name or the host');
  assert.deepEqual(names(rows('prod  web')), ['Lab', 'Prod', 'web1'], 'the order of the words and the spaces between them do not matter');
  assert.deepEqual(names(rows('zzz')), ['Lab'], 'nothing matches: the document row is all that is left');
  const none = rows('zzz')[0]!;
  assert.deepEqual([none.hasChildren, none.expanded], [false, false]);
  const prod = rows('web').find((r) => r.name === 'Prod')!;
  assert.deepEqual([prod.expanded, prod.hasChildren, prod.setSize, prod.posInSet], [true, true, 2, 1], 'the siblings counted are those that are shown');
  assert.deepEqual(rows('web').find((r) => r.name === 'web1')!.setSize, 1, 'db1 is not shown, so web1 is the only one');
});

test('a folder that matches by its own name is shown with the folders above it, but not with everything inside it', () => {
  const rows = buildRows([lab()], new Set([documentKey('s1')]), { filter: filter('test') });
  assert.deepEqual(names(rows), ['Lab', 'Test', 'web2'], 'web2 has the word in its host (web2.test.example); Test by its name');
  const only = buildRows([lab()], new Set([documentKey('s1')]), { filter: filter('Prod') });
  assert.deepEqual(names(only), ['Lab', 'Prod', 'web1', 'db1'], 'the hosts of both children have "prod"');
  const folderOnly = view('s1', 'Lab', [node(1, 'folder', 'Archive', null), node(2, 'connection', 'x', 1), node(3, 'connection', 'y', 1)]);
  assert.deepEqual(names(buildRows([folderOnly], new Set(), { filter: filter('archive') })), ['Lab', 'Archive'], 'its children are not shown, and it has none to show');
  assert.equal(buildRows([folderOnly], new Set(), { filter: filter('archive') })[1]!.hasChildren, false);
});

test('notes are searched only when asked for', () => {
  const model = lab();
  const closed = new Set([documentKey('s1')]);
  assert.deepEqual(names(buildRows([model], closed, { filter: filter('night') })), ['Lab']);
  assert.deepEqual(names(buildRows([model], closed, { filter: filter('night', { notes: true }) })), ['Lab', 'Prod', 'db1']);
  assert.deepEqual(names(buildRows([model], closed, { filter: filter('night backup', { notes: true }) })), ['Lab', 'Prod', 'db1'], 'words may be found in different places');
  assert.deepEqual(names(buildRows([model], closed, { filter: filter('db night', { notes: true }) })), ['Lab', 'Prod', 'db1'], 'one in the name, one in the notes');
});

test('only favourites keeps the favourites and the folders above them; with a search, the favourites that match', () => {
  const model = lab();
  const closed = new Set([documentKey('s1')]);
  const favorites = new Map([['s1', new Set([id(3), id(5), id(6)])]]);
  assert.deepEqual(names(buildRows([model], closed, { filter: filter('', { onlyFavorites: true }), favorites })), ['Lab', 'Prod', 'db1', 'Test', 'web2', 'jump']);
  assert.deepEqual(names(buildRows([model], closed, { filter: filter('web', { onlyFavorites: true }), favorites })), ['Lab', 'Test', 'web2']);
  assert.deepEqual(names(buildRows([model], closed, { filter: filter('', { onlyFavorites: true }), favorites: new Map() })), ['Lab'], 'no favourites: only the document');
  const folderFavorite = buildRows([model], closed, { filter: filter('', { onlyFavorites: true }), favorites: new Map([['s1', new Set([id(1)])]]) });
  assert.deepEqual(names(folderFavorite), ['Lab', 'Prod'], 'a favourite folder is shown without its children, which are not favourites');
  assert.equal(folderFavorite[1]!.favorite, true);
});

test('a search looks in every open document, and a document is told its favourites by its own session', () => {
  const one = lab(), two = view('s2', 'Other', [node(1, 'connection', 'web9', null, 0, { host: 'x.example' }), node(2, 'connection', 'plain', null, 1)]);
  const rows = buildRows([one, two], new Set([documentKey('s1'), documentKey('s2')]), { filter: filter('web') });
  assert.deepEqual(names(rows), ['Lab', 'Prod', 'web1', 'Test', 'web2', 'Other', 'web9']);
  assert.deepEqual(rows.filter((r) => r.type === 'document').map((r) => [r.posInSet, r.setSize]), [[1, 2], [2, 2]]);
  const favorites = new Map([['s2', new Set([id(1)])]]);
  assert.deepEqual(names(buildRows([one, two], new Set(), { filter: filter('', { onlyFavorites: true }), favorites })), ['Lab', 'Other', 'web9']);
});

test('fold reads text as a person does: no case, no accents, composed or not', () => {
  assert.equal(fold('CAFÉ'), 'cafe');
  assert.equal(fold('Café'), 'cafe');
  assert.equal(fold('Srv-10'), 'srv-10');
});

test('dropping inside a sorted folder never chooses a place: from outside the object is appended to it, within it the drop is refused as sorted', () => {
  const model = view('s1', 'Lab', [
    node(1, 'folder', 'sorted', null, 0, { sort: SORT_DOWN }), node(2, 'connection', 'a', 1, 0), node(3, 'connection', 'c', 1, 1), node(4, 'connection', 'b', 1, 2),
    node(5, 'connection', 'outside', null, 1), node(6, 'folder', 'plain', null, 2), node(7, 'connection', 'p', 6, 0),
  ]);
  const models = new Map([['s1', model]]);
  const drag = (n: number) => objectKey('s1', id(n));
  for (const zone of ['before', 'after', 'into'] as const) {
    assert.deepEqual(resolveDrop(models, drag(2), drag(3), zone), { refused: 'sorted' }, `within the sorted folder: ${zone}`);
  }
  assert.deepEqual(resolveDrop(models, drag(2), drag(1), 'into'), { refused: 'sorted' }, 'dropping a child on its own sorted folder');
  const fromOutside = resolveDrop(models, drag(5), drag(3), 'before');
  assert.deepEqual(fromOutside, { sessionId: 's1', objectId: id(5), parentId: id(1), index: 3 }, 'before a child of the sorted folder: into the folder, appended');
  assert.deepEqual(resolveDrop(models, drag(5), drag(1), 'into'), { sessionId: 's1', objectId: id(5), parentId: id(1), index: 3 });
  assert.deepEqual(resolveDrop(models, drag(2), drag(7), 'before'), { sessionId: 's1', objectId: id(2), parentId: id(6), index: 0 }, 'out of the sorted folder into a plain one: the place is chosen as before');
  assert.deepEqual(resolveDrop(models, drag(7), drag(5), 'before'), { sessionId: 's1', objectId: id(7), parentId: null, index: 1 }, 'at the top level too');
});

test('keys do not reorder inside a sorted folder; going out of it and into a folder still work, as the sorted list shows it', () => {
  const model = view('s1', 'Lab', [
    node(1, 'folder', 'sorted', null, 0, { sort: SORT_DOWN }), node(2, 'connection', 'a', 1, 0), node(3, 'folder', 'f', 1, 1), node(4, 'connection', 'b', 1, 2), node(5, 'connection', 'z', 1, 3),
  ]);
  assert.deepEqual(sortedChildren(model, id(1)).map((o) => o.name), ['z', 'f', 'b', 'a']);
  assert.equal(moveTarget(model, id(2), 'up'), undefined);
  assert.equal(moveTarget(model, id(2), 'down'), undefined);
  assert.equal(moveTarget(model, id(5), 'up'), undefined, 'not even where it would have moved in the manual order');
  assert.deepEqual(moveTarget(model, id(4), 'in'), { parentId: id(3), index: 0 }, 'b is just below the folder f in the sorted list');
  assert.equal(moveTarget(model, id(5), 'in'), undefined, 'z is the first in the sorted list: nothing above it');
  assert.deepEqual(moveTarget(model, id(4), 'out'), { parentId: null, index: 1 });
});

/** A seeded generator (mulberry32) that gives a whole number below `n`. A congruential generator computed in float64 loses its low bits and soon gives the same number every time. */
function prng(seed: number): (n: number) => number {
  let a = seed;
  return (n) => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
}

test('a search never shows an object without the folders above it, and shows every object that matches (random documents)', () => {
  const random = prng(5);
  const seen = { matches: 0, deepMatches: 0, deepest: 0, found: 0 };
  const words = ['web', 'db', 'prod', 'test', 'alpha', 'Café', 'srv1', 'jump'];
  for (let round = 0; round < 40; round++) {
    const objects: ObjectNode[] = [];
    for (let n = 1; n <= 40; n++) {
      const folders = objects.filter((o) => o.type === 'folder');
      const parent = folders.length > 0 && random(4) > 0 ? folders[random(folders.length)]!.id : null;
      objects.push({ id: id(n), type: random(3) === 0 ? 'folder' : 'connection', name: `${words[random(words.length)]} ${words[random(words.length)]}`, parentId: parent, order: random(4), props: random(2) ? { host: `${words[random(words.length)]}.example` } : {} });
    }
    const model = view('s1', 'Doc', objects);
    const query = words[random(words.length)]!.toLowerCase();
    const rows = buildRows([model], new Set(), { filter: filter(query) });
    const shown = new Set(rows.filter((r) => r.objectId).map((r) => r.objectId!));
    const text = (o: ObjectNode) => fold(`${o.name}\n${typeof o.props.host === 'string' ? o.props.host : ''}`);
    const matching = objects.filter((o) => text(o).includes(fold(query)));
    for (const o of matching) {
      assert.equal(shown.has(o.id), true, `round ${round}: ${o.name} matches and is shown`);
      const depth = depthOf(model, o);
      seen.matches++; seen.deepest = Math.max(seen.deepest, depth); if (depth >= 2) seen.deepMatches++;
    }
    if (matching.length > 0) seen.found++;
    for (const row of rows) if (row.objectId) {
      const o = model.objects.get(row.objectId)!;
      const below = objects.some((x) => text(x).includes(fold(query)) && isBelow(model, x, o.id));
      assert.equal(text(o).includes(fold(query)) || below, true, `round ${round}: ${o.name} is shown for a reason`);
      if (o.parentId) assert.equal(shown.has(o.parentId), true, `round ${round}: ${o.name} has its folder above it`);
    }
  }
  assert.ok(seen.matches >= 100 && seen.deepMatches >= 20 && seen.deepest >= 3 && seen.found >= 30, `the documents have matches, some of them folders deep: ${JSON.stringify(seen)}`);
  function isBelow(model: DocModel, object: ObjectNode, ancestor: string): boolean {
    for (let cursor = object.parentId; cursor !== null; cursor = model.objects.get(cursor)?.parentId ?? null) if (cursor === ancestor) return true;
    return false;
  }
  function depthOf(model: DocModel, object: ObjectNode): number {
    let depth = 0;
    for (let cursor = object.parentId; cursor !== null; cursor = model.objects.get(cursor)?.parentId ?? null) depth++;
    return depth;
  }
});

test('a match keeps every folder above it, however deep, and opens them all without touching what the tree has open', () => {
  const model = view('s1', 'Lab', [
    node(1, 'folder', 'Region', null, 0), node(2, 'folder', 'Rack', 1, 0), node(3, 'folder', 'Shelf', 2, 0), node(4, 'connection', 'web-1', 3, 0),
    node(5, 'connection', 'other', 1, 1), node(6, 'folder', 'Elsewhere', null, 1), node(7, 'connection', 'db', 6, 0),
  ]);
  const open = new Set([documentKey('s1')]);
  const rows = buildRows([model], open, { filter: filter('web') });
  assert.deepEqual(names(rows), ['Lab', 'Region', 'Rack', 'Shelf', 'web-1'], 'every folder above the match, however deep, and nothing else');
  assert.deepEqual(rows.map((r) => r.expanded), [true, true, true, true, false], 'the folders above a match are open (a connection has nothing to open)');
  assert.deepEqual([...open], [documentKey('s1')], 'and what the tree has open is as it was');
});

test('the name and the host are two things: a word cannot be made of the end of one and the start of the other', () => {
  const model = view('s1', 'Lab', [node(1, 'connection', 'db1', null, 0, { host: 'db.prod.example' })]);
  assert.deepEqual(names(buildRows([model], everything(model), { filter: filter('db1db') })), ['Lab'], 'db1 and db.prod.example do not join into db1db: nothing is found, only the document stays');
  assert.deepEqual(names(buildRows([model], everything(model), { filter: filter('db1 db') })), ['Lab', 'db1'], 'two words: each one in the name or the host');
});

test('a filter narrows the tree only when it has a word or asks for favourites only: spaces are not a word', () => {
  assert.equal(narrows(undefined), false);
  assert.equal(narrows(filter('')), false);
  assert.equal(narrows(filter('  \t ', { notes: true })), false);
  assert.equal(narrows(filter('x')), true);
  assert.equal(narrows(filter('', { onlyFavorites: true })), true);
  const model = lab();
  assert.deepEqual(names(buildRows([model], new Set([documentKey('s1')]), { filter: filter('   ') })), ['Lab', 'Prod', 'Test', 'jump', 'Café'], 'a blank search is no search: the top level, the folders as closed as they were');
});

test('a folder is sorted when its setting says so; the top level, a folder with no valid setting and an object that is not there are not', () => {
  const model = view('s1', 'Lab', [node(1, 'folder', 'sorted', null, 0, { sort: SORT_DOWN }), node(2, 'folder', 'manual', null, 1), node(3, 'folder', 'odd', null, 2, { sort: [{ by: 'date', dir: 'asc' }] })]);
  assert.deepEqual([isSorted(model, id(1)), isSorted(model, id(2)), isSorted(model, id(3)), isSorted(model, null), isSorted(model, id(99))], [true, false, false, false, false]);
});

test('a connection is never marked as sorted, whatever its properties say', () => {
  const model = view('s1', 'Lab', [node(1, 'connection', 'c', null, 0, { sort: SORT_DOWN })]);
  const rows = buildRows([model], everything(model));
  assert.equal('sorted' in rows[1]!, false);
});

test('down does not reorder inside a sorted folder either, wherever the object is among its siblings', () => {
  const model = view('s1', 'Lab', [node(1, 'folder', 'f', null, 0, { sort: SORT_DOWN }), node(2, 'connection', 'a', 1, 0), node(3, 'connection', 'b', 1, 1), node(4, 'connection', 'c', 1, 2)]);
  for (const n of [2, 3, 4]) assert.deepEqual([moveTarget(model, id(n), 'up'), moveTarget(model, id(n), 'down')], [undefined, undefined], `object ${n}`);
});

test('a search shows the children of a sorted folder in its sort order, and a row counts its place among the siblings that are shown', () => {
  const model = view('s1', 'Lab', [node(1, 'folder', 'F', null, 0, { sort: SORT_DOWN }), node(2, 'connection', 'alpha', 1, 0, { host: 'a.example' }), node(3, 'connection', 'bravo', 1, 1, { host: 'b.example' }), node(4, 'connection', 'charlie', 1, 2, { host: 'c.example' })]);
  assert.deepEqual(names(buildRows([model], new Set(), { filter: filter('example') })), ['Lab', 'F', 'charlie', 'bravo', 'alpha']);
  const rows = buildRows([model], new Set(), { filter: filter('r') });          // bravo and charlie have an r; alpha and F do not
  assert.deepEqual(names(rows), ['Lab', 'F', 'charlie', 'bravo']);
  assert.deepEqual(rows.slice(2).map((r) => [r.posInSet, r.setSize]), [[1, 2], [2, 2]], 'the place among the siblings that are shown, not among those that are hidden');
});
