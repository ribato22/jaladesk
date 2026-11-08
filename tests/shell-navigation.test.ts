import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObjectNode } from '../src/documents/model.js';
import { modelOf, sortedChildren, type DocModel } from '../src/desktop/docmodel.js';
import { ROW_HEIGHT, allExpanded, buildRows, documentKey, dropZone, keepSelection, moveTarget, navigate, objectKey, onlyDocuments, parseKey, resolveDrop, scrollTopFor, windowOf } from '../src/desktop/navigation.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, type: ObjectNode['type'], name: string, parent: number | null, order = 0): ObjectNode =>
  ({ id: id(n), type, name, parentId: parent === null ? null : id(parent), order, props: {} });
const view = (sessionId: string, name: string, objects: ObjectNode[]): DocModel =>
  modelOf({ id: sessionId, docId: id(900), name, revision: 1, dirty: false, conflicts: 0, seq: 0, objects });

// Lab (document) > Servers (folder) > [web2, web10], Zebra (connection), Alpha (connection, order 0 like Servers but sorts first by name)
const lab = view('s1', 'Lab', [
  node(1, 'folder', 'Servers', null, 0),
  node(2, 'connection', 'web10', 1, 1),
  node(3, 'connection', 'web2', 1, 0),
  node(4, 'connection', 'Zebra', null, 1),
  node(5, 'connection', 'alpha', null, 0),
  node(6, 'folder', 'Empty', null, 2),
]);

test('a collapsed document shows only its own row', () => {
  const rows = buildRows([lab], new Set());
  assert.deepEqual(rows.map((r) => [r.key, r.depth, r.expanded, r.hasChildren]), [[documentKey('s1'), 0, false, true]]);
});

test('an expanded document lists its top level by order, then by name without regard to case; only expanded folders show their children', () => {
  const rows = buildRows([lab], new Set([documentKey('s1')]));
  assert.deepEqual(rows.map((r) => r.name), ['Lab', 'alpha', 'Servers', 'Zebra', 'Empty']);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 1, 1, 1]);
  const open = buildRows([lab], new Set([documentKey('s1'), objectKey('s1', id(1))]));
  assert.deepEqual(open.map((r) => r.name), ['Lab', 'alpha', 'Servers', 'web2', 'web10', 'Zebra', 'Empty']);
  assert.deepEqual(open.map((r) => r.depth), [0, 1, 1, 2, 2, 1, 1]);
});

test('hasChildren is true only for a folder that has something in it; an empty folder or a connection cannot be expanded', () => {
  const rows = buildRows([lab], new Set([documentKey('s1'), objectKey('s1', id(6)), objectKey('s1', id(5))]));
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.Servers!.hasChildren, true);
  assert.equal(by.Empty!.hasChildren, false);
  assert.equal(by.Empty!.expanded, false, 'an empty folder never reports itself expanded');
  assert.equal(by.alpha!.hasChildren, false);
});

test('when the order is the same, names that contain numbers sort naturally (srv2 before srv10) and the id settles identical names', () => {
  const same = view('s3', 'Same', [node(1, 'connection', 'srv10', null), node(2, 'connection', 'srv2', null), node(4, 'connection', 'twin', null), node(3, 'connection', 'twin', null)]);
  const rows = buildRows([same], new Set([documentKey('s3')]));
  assert.deepEqual(rows.slice(1).map((r) => [r.name, r.objectId]), [['srv2', id(2)], ['srv10', id(1)], ['twin', id(3)], ['twin', id(4)]]);
});

test('two documents with the same name stay apart by session, and a row knows its parent', () => {
  const other = view('s2', 'Lab', [node(1, 'folder', 'Servers', null), node(2, 'connection', 'web', 1)]);
  const rows = buildRows([lab, other], new Set([documentKey('s1'), documentKey('s2'), objectKey('s2', id(1))]));
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
  const web = rows.find((r) => r.name === 'web')!;
  assert.equal(web.sessionId, 's2');
  assert.equal(web.parentKey, objectKey('s2', id(1)));
  assert.equal(rows.find((r) => r.key === objectKey('s2', id(1)))!.parentKey, documentKey('s2'));
});

test('a document row carries the unsaved marker; object rows do not', () => {
  const rows = buildRows([{ ...lab, dirty: true }], new Set([documentKey('s1')]));
  assert.equal(rows[0]!.dirty, true);
  assert.equal(rows[1]!.dirty, undefined);
});

test('keys survive a round trip and garbage is refused', () => {
  assert.deepEqual(parseKey(documentKey('s1')), { sessionId: 's1' });
  assert.deepEqual(parseKey(objectKey('s1', id(1))), { sessionId: 's1', objectId: id(1) });
  for (const bad of ['', 'x', 'd:', 'd:a:b', 'o:a', 'o::b', 'o:a:b:c', 'q:a']) assert.equal(parseKey(bad), undefined, bad);
});

test('arrow keys move through the visible rows and stop at both ends; Home and End jump', () => {
  const rows = buildRows([lab], new Set([documentKey('s1')]));
  const keys = rows.map((r) => r.key);
  assert.deepEqual(navigate(rows, keys[1], 'ArrowDown'), { focus: keys[2] });
  assert.deepEqual(navigate(rows, keys[1], 'ArrowUp'), { focus: keys[0] });
  assert.deepEqual(navigate(rows, keys[0], 'ArrowUp'), { focus: keys[0] });
  assert.deepEqual(navigate(rows, keys[4], 'ArrowDown'), { focus: keys[4] });
  assert.deepEqual(navigate(rows, keys[2], 'Home'), { focus: keys[0] });
  assert.deepEqual(navigate(rows, keys[2], 'End'), { focus: keys[4] });
});

test('ArrowRight opens a closed folder and then enters it; on a connection or empty folder it does nothing', () => {
  const closed = buildRows([lab], new Set([documentKey('s1')]));
  const servers = closed.find((r) => r.name === 'Servers')!;
  assert.deepEqual(navigate(closed, servers.key, 'ArrowRight'), { toggle: { key: servers.key, expanded: true } });
  const open = buildRows([lab], new Set([documentKey('s1'), servers.key]));
  assert.deepEqual(navigate(open, servers.key, 'ArrowRight'), { focus: open.find((r) => r.name === 'web2')!.key });
  assert.deepEqual(navigate(closed, closed.find((r) => r.name === 'alpha')!.key, 'ArrowRight'), {});
  assert.deepEqual(navigate(closed, closed.find((r) => r.name === 'Empty')!.key, 'ArrowRight'), {});
});

test('ArrowLeft closes an open folder, and otherwise goes to the parent; on the document row it does nothing when closed', () => {
  const open = buildRows([lab], new Set([documentKey('s1'), objectKey('s1', id(1))]));
  const servers = open.find((r) => r.name === 'Servers')!;
  assert.deepEqual(navigate(open, servers.key, 'ArrowLeft'), { toggle: { key: servers.key, expanded: false } });
  assert.deepEqual(navigate(open, open.find((r) => r.name === 'web2')!.key, 'ArrowLeft'), { focus: servers.key });
  assert.deepEqual(navigate(open, open.find((r) => r.name === 'alpha')!.key, 'ArrowLeft'), { focus: documentKey('s1') });
  assert.deepEqual(navigate(open, documentKey('s1'), 'ArrowLeft'), { toggle: { key: documentKey('s1'), expanded: false } });
  const closed = buildRows([lab], new Set());
  assert.deepEqual(navigate(closed, documentKey('s1'), 'ArrowLeft'), {});
});

test('with nothing focused (or a row that is gone) the first row takes focus, and End takes the last; no rows, no move', () => {
  const rows = buildRows([lab], new Set([documentKey('s1')]));
  assert.deepEqual(navigate(rows, undefined, 'ArrowDown'), { focus: rows[0]!.key });
  assert.deepEqual(navigate(rows, 'o:gone:gone', 'ArrowLeft'), { focus: rows[0]!.key });
  assert.deepEqual(navigate(rows, undefined, 'End'), { focus: rows[rows.length - 1]!.key });
  assert.deepEqual(navigate([], undefined, 'ArrowDown'), {});
});

test('after the tree is rebuilt the selection stays where it was; a row that is gone falls to its own document, never to another one', () => {
  const other = view('s2', 'Other', [node(1, 'folder', 'Elsewhere', null)]);
  const open = buildRows([lab, other], new Set([documentKey('s1'), documentKey('s2'), objectKey('s1', id(1))]));
  const web2 = objectKey('s1', id(3));
  assert.equal(keepSelection(open, web2), web2, 'still shown: stays');
  assert.equal(keepSelection(open, objectKey('s1', id(55))), documentKey('s1'), 'an object that no longer exists: its own document');
  const collapsed = buildRows([lab, other], new Set([documentKey('s1'), documentKey('s2')]));
  assert.equal(keepSelection(collapsed, web2), documentKey('s1'), 'hidden by a closed folder: its own document');
  assert.equal(keepSelection(open, objectKey('s2', id(77))), documentKey('s2'), 'an object of the second document that vanished: the second document, not the first');
  assert.equal(keepSelection(open, objectKey('s9', id(1))), open[0]!.key, 'its document is gone too: the first row');
  assert.equal(keepSelection(open, undefined), open[0]!.key, 'nothing selected yet: the first row');
  assert.equal(keepSelection([], documentKey('s1')), undefined, 'no rows, no selection');
});

test('a row says where it stands among its siblings, for a tree of which only a window is drawn: its level, how many siblings there are and its place among them', () => {
  const open = buildRows([lab], new Set([documentKey('s1'), objectKey('s1', id(1))]));
  const by = Object.fromEntries(open.map((r) => [r.name, [r.level, r.setSize, r.posInSet]]));
  assert.deepEqual(by, { Lab: [1, 1, 1], alpha: [2, 4, 1], Servers: [2, 4, 2], web2: [3, 2, 1], web10: [3, 2, 2], Zebra: [2, 4, 3], Empty: [2, 4, 4] });
  const two = buildRows([lab, view('s2', 'Other', [])], new Set());
  assert.deepEqual(two.map((r) => [r.setSize, r.posInSet]), [[2, 1], [2, 2]], 'the documents are siblings too');
});

test('expanding everything opens every document and every folder that has something in it, and nothing else; closing everything leaves the documents open', () => {
  const all = allExpanded([lab]);
  assert.deepEqual([...all].sort(), [documentKey('s1'), objectKey('s1', id(1))].sort(), 'Empty has nothing in it, and a connection has no children');
  assert.deepEqual(buildRows([lab], all).map((r) => r.name), ['Lab', 'alpha', 'Servers', 'web2', 'web10', 'Zebra', 'Empty']);
  assert.deepEqual([...onlyDocuments([lab, view('s2', 'Other', [])])], [documentKey('s1'), documentKey('s2')]);
});

test('the rows drawn are those in view and a few more on each side, at the top, in the middle and at the end of a long list; nothing to draw when there is nothing', () => {
  assert.deepEqual(windowOf(1000, 0, 280), { start: 0, end: 18 }, '10 rows in view and 8 beyond them');
  assert.deepEqual(windowOf(1000, 28 * 100, 280), { start: 92, end: 118 });
  assert.deepEqual(windowOf(1000, 28 * 990, 280), { start: 982, end: 1000 }, 'the end of the list is the end of the window');
  assert.deepEqual(windowOf(5, 0, 280), { start: 0, end: 5 }, 'a short list is drawn whole');
  assert.deepEqual(windowOf(0, 0, 280), { start: 0, end: 0 });
  assert.deepEqual(windowOf(1000, 28 * 5 + 10, 280), { start: 0, end: 24 }, 'a position between two rows shows the row that is cut');
  assert.deepEqual(windowOf(100, 99_999, 280), { start: 100, end: 100 }, 'a scroll position past the end draws nothing and does not fail');
});

test('revealing a row scrolls the least that shows it: not at all when it is in view', () => {
  const view = 280;
  assert.equal(scrollTopFor(3, 0, view), 0);
  assert.equal(scrollTopFor(20, 0, view), 20 * ROW_HEIGHT + ROW_HEIGHT - view, 'below: its bottom edge meets the bottom of the view');
  assert.equal(scrollTopFor(2, 28 * 10, view), 2 * ROW_HEIGHT, 'above: its top edge meets the top');
  assert.equal(scrollTopFor(12, 28 * 10, view), 28 * 10, 'in view already');
  assert.equal(scrollTopFor(0, 5, view), 0);
});

test('a pointer over the top or bottom quarter of a row means before or after it, over the middle means into it; a row that holds nothing only has before and after', () => {
  assert.deepEqual([0, 6, 7, 14, 21, 22, 28].map((y) => dropZone(y, 28, true)), ['before', 'before', 'into', 'into', 'into', 'after', 'after']);
  assert.deepEqual([0, 13, 14, 27].map((y) => dropZone(y, 28, false)), ['before', 'before', 'after', 'after']);
  assert.equal(dropZone(5, 0, true), 'into', 'a row with no height is not worth a division by zero');
});

// A document with Servers (web2, web10, Inner (deep)) and two connections at the top level; the display order of the top level is alpha, Servers, Zebra.
const tree = () => view('s1', 'Lab', [
  node(1, 'folder', 'Servers', null, 1), node(3, 'connection', 'web2', 1, 0), node(2, 'connection', 'web10', 1, 1), node(7, 'folder', 'Inner', 1, 2), node(8, 'connection', 'deep', 7, 0),
  node(4, 'connection', 'Zebra', null, 2), node(5, 'connection', 'alpha', null, 0),
]);
const models = (m: DocModel) => new Map([[m.id, m]]);
const drop = (m: DocModel, dragged: number, target: number | 'document', zone: 'before' | 'into' | 'after') =>
  resolveDrop(models(m), objectKey(m.id, id(dragged)), target === 'document' ? documentKey(m.id) : objectKey(m.id, id(target)), zone);

test('dropping onto a folder puts the object last in it; before or after a row puts it among that row\'s siblings, counted without the object itself', () => {
  const m = tree();
  assert.deepEqual(drop(m, 4, 1, 'into'), { sessionId: 's1', objectId: id(4), parentId: id(1), index: 3 }, 'Zebra into Servers: after web2, web10 and Inner');
  assert.deepEqual(drop(m, 4, 5, 'before'), { sessionId: 's1', objectId: id(4), parentId: null, index: 0 }, 'Zebra before alpha');
  assert.deepEqual(drop(m, 4, 5, 'after'), { sessionId: 's1', objectId: id(4), parentId: null, index: 1 }, 'Zebra right after alpha, i.e. before Servers');
  assert.deepEqual(drop(m, 5, 4, 'after'), { sessionId: 's1', objectId: id(5), parentId: null, index: 2 }, 'alpha after Zebra: the last place, counted without alpha');
  assert.deepEqual(drop(m, 5, 4, 'before'), { sessionId: 's1', objectId: id(5), parentId: null, index: 1 }, 'alpha before Zebra: between Servers... after it, counted without alpha');
  assert.deepEqual(drop(m, 3, 7, 'before'), { sessionId: 's1', objectId: id(3), parentId: id(1), index: 1 }, 'web2 before Inner, both in Servers: after web10');
  assert.deepEqual(drop(m, 8, 'document', 'into'), { sessionId: 's1', objectId: id(8), parentId: null, index: 3 }, 'onto the document row: the top level, last');
  assert.deepEqual(drop(m, 3, 4, 'into'), { sessionId: 's1', objectId: id(3), parentId: null, index: 3 }, 'into a connection means after it');
});

test('dropping where it already is, on itself, into its own folder tree or into another document goes nowhere, and says why', () => {
  const m = tree();
  assert.deepEqual(drop(m, 5, 5, 'into'), { refused: 'same-place' });
  assert.deepEqual(drop(m, 5, 1, 'before'), { refused: 'same-place' }, 'alpha before Servers is where alpha is');
  assert.deepEqual(drop(m, 4, 1, 'after'), { refused: 'same-place' }, 'Zebra after Servers is where Zebra is');
  assert.deepEqual(drop(m, 1, 1, 'into'), { refused: 'same-place' });
  assert.deepEqual(drop(m, 1, 7, 'into'), { refused: 'cycle' }, 'Servers into Inner, which is inside Servers');
  assert.deepEqual(drop(m, 1, 8, 'after'), { refused: 'cycle' }, 'and next to something inside it');
  assert.deepEqual(drop(m, 1, 3, 'before'), { refused: 'cycle' });
  const other = view('s2', 'Other', [node(1, 'folder', 'Elsewhere', null)]);
  assert.deepEqual(resolveDrop(new Map([[m.id, m], [other.id, other]]), objectKey('s1', id(4)), objectKey('s2', id(1)), 'into'), { refused: 'other-document' });
  assert.deepEqual(resolveDrop(models(m), documentKey('s1'), objectKey('s1', id(1)), 'into'), { refused: 'nothing' }, 'a document row is not dragged');
  assert.deepEqual(resolveDrop(models(m), objectKey('s1', id(4)), 'garbage', 'into'), { refused: 'nothing' });
  assert.deepEqual(resolveDrop(models(m), objectKey('s1', id(99)), objectKey('s1', id(1)), 'into'), { refused: 'nothing' });
});

test('keys move an object up or down among its siblings, out of its folder to right after it, or into the folder just above it; nothing when it cannot go that way', () => {
  const m = tree();
  assert.deepEqual(moveTarget(m, id(4), 'up'), { parentId: null, index: 1 }, 'Zebra above Servers');
  assert.equal(moveTarget(m, id(5), 'up'), undefined, 'alpha is first');
  assert.deepEqual(moveTarget(m, id(5), 'down'), { parentId: null, index: 1 });
  assert.equal(moveTarget(m, id(4), 'down'), undefined, 'Zebra is last');
  assert.deepEqual(moveTarget(m, id(3), 'out'), { parentId: null, index: 2 }, 'web2 leaves Servers and lands right after it: alpha, Servers, web2, Zebra');
  assert.equal(moveTarget(m, id(5), 'out'), undefined, 'already at the top level');
  assert.deepEqual(moveTarget(m, id(8), 'out'), { parentId: id(1), index: 3 }, 'deep leaves Inner and lands after Inner in Servers');
  assert.deepEqual(moveTarget(m, id(4), 'in'), { parentId: id(1), index: 3 }, 'Zebra goes into Servers, the folder above it, as its last');
  assert.equal(moveTarget(m, id(5), 'in'), undefined, 'nothing above alpha');
  assert.equal(moveTarget(m, id(2), 'in'), undefined, 'web10 is below web2, which is not a folder');
  assert.deepEqual(moveTarget(m, id(2), 'up'), { parentId: id(1), index: 0 });
  assert.equal(moveTarget(m, id(99), 'up'), undefined);
});

test('a document with nothing in it has no arrow: ArrowRight on its row does nothing, open or closed', () => {
  const empty = view('s9', 'Empty', []);
  const open = buildRows([empty], new Set([documentKey('s9')]));
  assert.equal(open[0]!.hasChildren, false);
  assert.deepEqual(navigate(open, documentKey('s9'), 'ArrowRight'), {});
  assert.deepEqual(navigate(buildRows([empty], new Set()), documentKey('s9'), 'ArrowRight'), {});
});

test('a key and a drop that mean the same thing give the same answer: up and down are a drop before the previous and after the next sibling, out is a drop after the folder, in is a drop into the folder above', () => {
  const m = tree();
  const resolve = (o: ObjectNode, target: ObjectNode, zone: 'before' | 'into' | 'after') => resolveDrop(models(m), objectKey(m.id, o.id), objectKey(m.id, target.id), zone);
  const agree = (key: ReturnType<typeof moveTarget>, dropped: ReturnType<typeof resolveDrop>, what: string) =>
    assert.deepEqual(key && { parentId: key.parentId, index: key.index }, 'refused' in dropped ? undefined : { parentId: dropped.parentId, index: dropped.index }, what);
  let compared = 0;
  for (const o of m.objects.values()) {
    const siblings = sortedChildren(m, o.parentId);
    const at = siblings.findIndex((s) => s.id === o.id);
    const above = at > 0 ? siblings[at - 1] : undefined;
    const below = at < siblings.length - 1 ? siblings[at + 1] : undefined;
    const parent = o.parentId === null ? undefined : m.objects.get(o.parentId);
    if (above) { agree(moveTarget(m, o.id, 'up'), resolve(o, above, 'before'), `${o.name} up`); compared++; }
    if (below) { agree(moveTarget(m, o.id, 'down'), resolve(o, below, 'after'), `${o.name} down`); compared++; }
    if (parent) { agree(moveTarget(m, o.id, 'out'), resolve(o, parent, 'after'), `${o.name} out`); compared++; }
    if (above?.type === 'folder') { agree(moveTarget(m, o.id, 'in'), resolve(o, above, 'into'), `${o.name} in`); compared++; }
  }
  assert.ok(compared >= 12, `${compared} intents were compared`);
});
