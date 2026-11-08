import assert from 'node:assert/strict';
import test from 'node:test';
import { COLORS } from '../src/documents/meta.js';
import { DRAG_START, dropIndex, edgeWords, isDrag, movedWords, moveKeyDelta, moveTab, shiftTab, tabColour } from '../src/desktop/tab-order.js';

const mulberry32 = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ids = ['a', 'b', 'c', 'd'];

test('a tab is moved so that it sits at a place among the others, counted without it', () => {
  assert.deepEqual(moveTab(ids, 'a', 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveTab(ids, 'a', 3), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveTab(ids, 'd', 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveTab(ids, 'c', 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moveTab(ids, 'b', 1), ids, 'where it is');
  assert.deepEqual(moveTab(ids, 'b', 0), ['b', 'a', 'c', 'd']);
});

test('a place beyond the ends is the end, an id that is not there moves nothing, and what is handed in is not changed', () => {
  assert.deepEqual(moveTab(ids, 'a', 99), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveTab(ids, 'd', -5), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveTab(ids, 'a', Number.NaN), ids, 'not a place: the tab stays');
  assert.deepEqual(moveTab(ids, 'c', Number.NaN), ids, 'wherever it is');
  assert.deepEqual(moveTab(ids, 'c', Number.POSITIVE_INFINITY), ids, 'and a place that is not a number is not the end either');
  assert.deepEqual(moveTab(ids, 'a', 1.5), ['b', 'a', 'c', 'd'], 'a place between two is the one before: whole places only');
  assert.deepEqual(moveTab(ids, 'z', 1), ids);
  assert.deepEqual(moveTab([], 'a', 0), []);
  assert.deepEqual(moveTab(['a'], 'a', 0), ['a']);
  const before = [...ids];
  const moved = moveTab(ids, 'a', 3);
  assert.deepEqual(ids, before);
  assert.notEqual(moved, ids);
  assert.notEqual(moveTab(ids, 'b', 1), ids, 'a copy even when nothing moves');
  assert.notEqual(moveTab(ids, 'z', 1), ids, 'and when the tab is not there');
  assert.notEqual(shiftTab(ids, 'z', 1), ids, 'and when it is shifted');
});

test('whatever is moved, the tabs are the same tabs, once each, and the one that was moved is where it was sent', () => {
  const random = mulberry32(7);
  const seen = new Set<string>();
  for (let n = 0; n < 600; n++) {
    const size = 1 + Math.floor(random() * 12);
    const list = Array.from({ length: size }, (_, i) => `t${i}`);
    const id = list[Math.floor(random() * size)]!;
    const to = Math.floor(random() * (size + 4)) - 2;
    const moved = moveTab(list, id, to);
    assert.deepEqual([...moved].sort(), [...list].sort(), 'the same tabs');
    assert.equal(moved.indexOf(id), Math.min(Math.max(to, 0), size - 1), `${id} to ${to} of ${size}`);
    assert.deepEqual(moved.filter((x) => x !== id), list.filter((x) => x !== id), 'the others keep their order');
    seen.add(`${size}:${moved.indexOf(id)}`);
  }
  assert.ok(seen.size > 20, 'the data varies');
});

test('a tab is moved one place to the left or to the right, and stays where it is at the end', () => {
  assert.deepEqual(shiftTab(ids, 'b', -1), ['b', 'a', 'c', 'd']);
  assert.deepEqual(shiftTab(ids, 'b', 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(shiftTab(ids, 'a', -1), ids, 'the first has no left');
  assert.deepEqual(shiftTab(ids, 'd', 1), ids, 'the last has no right');
  assert.deepEqual(shiftTab(ids, 'z', 1), ids);
  assert.deepEqual(shiftTab(['a'], 'a', 1), ['a']);
  assert.notEqual(shiftTab(ids, 'a', -1), ids);
});

test('where a dragged tab would land: the number of other tabs whose middle is to the left of the pointer', () => {
  const centers = [50, 150, 250];
  assert.equal(dropIndex(centers, -10), 0);
  assert.equal(dropIndex(centers, 49), 0);
  assert.equal(dropIndex(centers, 50), 0, 'exactly on a middle: before that tab');
  assert.equal(dropIndex(centers, 51), 1);
  assert.equal(dropIndex(centers, 150), 1);
  assert.equal(dropIndex(centers, 200), 2);
  assert.equal(dropIndex(centers, 251), 3);
  assert.equal(dropIndex(centers, 9999), 3);
  assert.equal(dropIndex([], 100), 0);
  assert.equal(dropIndex(centers, Number.NaN), 0, 'a pointer that is not anywhere drops nowhere');
  assert.equal(dropIndex(centers, Number.POSITIVE_INFINITY), 3);
});

test('the pointer has to move a few pixels sideways before a press on a tab is a drag, so that a click that wobbles is still a click', () => {
  assert.equal(DRAG_START, 5);
  assert.equal(isDrag(0), false);
  assert.equal(isDrag(4), false);
  assert.equal(isDrag(-4), false);
  assert.equal(isDrag(5), true);
  assert.equal(isDrag(-5), true);
  assert.equal(isDrag(300), true);
  assert.equal(isDrag(Number.NaN), false);
});

test('what a screen reader is told after a tab moved: its place among the tabs and its name', () => {
  assert.equal(movedWords('Kantor', 1, 4), 'Kantor, tab 2 dari 4');
  assert.equal(movedWords('Rumah', 0, 1), 'Rumah, tab 1 dari 1');
  assert.equal(movedWords('', 2, 3), 'Tab 3 dari 3', 'a tab without a name is its place');
});

test('a tab shows the colour of its object only if it is one of the colours of the palette', () => {
  for (const colour of COLORS) assert.equal(tabColour(colour.id), colour.id);
  for (const wrong of [undefined, null, '', 'Red', 'red ', 'magenta', 'constructor', '__proto__', 'toString', 7, {}, ['red'], true]) assert.equal(tabColour(wrong), undefined, String(wrong));
});

// What a key does to a tab that has the focus: Alt and the arrow, and nothing else (every other key, and every other modifier, is for something else).
test('Alt with the left or the right arrow moves a tab one place, and no other key or modifier does', () => {
  const key = (name: string, held: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({ key: name, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...held });
  assert.equal(moveKeyDelta(key('ArrowLeft', { altKey: true })), -1);
  assert.equal(moveKeyDelta(key('ArrowRight', { altKey: true })), 1);
  assert.equal(moveKeyDelta(key('ArrowLeft')), undefined, 'the arrow alone moves the focus');
  for (const extra of ['ctrlKey', 'metaKey', 'shiftKey'] as const) {
    assert.equal(moveKeyDelta(key('ArrowLeft', { altKey: true, [extra]: true })), undefined, `Alt and ${extra}`);
    assert.equal(moveKeyDelta(key('ArrowRight', { altKey: true, [extra]: true })), undefined, `Alt and ${extra}`);
  }
  for (const other of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'a', 'Enter', ' ', 'Tab']) assert.equal(moveKeyDelta(key(other, { altKey: true })), undefined, other);
});

// What the review after the execution (23 October 2026) found: a tab that is asked to go further than the end said nothing, and a person who cannot see the strip was left without an answer.

test('a tab that cannot go further says where it is and which end it is at', () => {
  assert.equal(edgeWords('Polos', 0, 4, -1), 'Polos, tab 1 dari 4, sudah di ujung kiri');
  assert.equal(edgeWords('Abu', 3, 4, 1), 'Abu, tab 4 dari 4, sudah di ujung kanan');
  assert.equal(edgeWords('', 0, 2, -1), 'Tab 1 dari 2, sudah di ujung kiri', 'a tab without a name is its place');
  assert.notEqual(edgeWords('Polos', 0, 4, -1), movedWords('Polos', 0, 4), 'it is not the words of a move: a screen reader reads again only what has changed');
});
