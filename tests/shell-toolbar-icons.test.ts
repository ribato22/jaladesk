import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { COMMANDS } from '../src/desktop/commands.js';
import { toolbarIcon, toolbarShapes } from '../src/desktop/toolbar-icons.js';

/** The smallest stand-in for the parts of a document that drawing an icon uses. */
class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  constructor(readonly namespace: string, readonly tag: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
}
const fake = { createElementNS: (namespace: string, tag: string) => new FakeElement(namespace, tag) } as unknown as Document;
const SVG = 'http://www.w3.org/2000/svg';
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const KINDS = new Set(['path', 'rect', 'circle', 'ellipse', 'line']);
const named = [...new Set(COMMANDS.flatMap((c) => (c.icon !== undefined ? [c.icon] : [])))];

test('every picture that a command asks for is drawn, and nothing is drawn that no command asks for', () => {
  assert.deepEqual(Object.keys(toolbarShapes).sort(), [...named].sort());
  assert.equal(named.length, COMMANDS.filter((c) => c.icon !== undefined).length, 'one picture for each command');
  for (const name of named) assert.ok(toolbarShapes[name]!.length >= 1 && toolbarShapes[name]!.length <= 6, `${name}: a few strokes`);
});

test('a picture is one small drawing that says nothing to a screen reader: a 16 by 16 grid in the colour of the text, with the shapes of the list only', () => {
  for (const name of named) {
    const svg = toolbarIcon(name, fake) as unknown as FakeElement;
    assert.deepEqual([svg.namespace, svg.tag], [SVG, 'svg'], name);
    assert.deepEqual([svg.attributes.get('viewBox'), svg.attributes.get('width'), svg.attributes.get('height'), svg.attributes.get('aria-hidden'), svg.attributes.get('data-icon')], ['0 0 16 16', '16', '16', 'true', name]);
    assert.deepEqual([svg.attributes.get('fill'), svg.attributes.get('stroke'), svg.attributes.get('stroke-linecap'), svg.attributes.get('stroke-linejoin'), svg.attributes.get('stroke-width')], ['none', 'currentColor', 'round', 'round', '1.4']);
    assert.equal(svg.children.length, toolbarShapes[name]!.length);
    // each shape is made of exactly what the list says: its kind and every attribute of it, none more and none less
    svg.children.forEach((shape, i) => {
      const [kind, attributes] = toolbarShapes[name]![i]!;
      assert.equal(shape.tag, kind, `${name} #${i}: the kind`);
      assert.deepEqual([...shape.attributes].sort(), Object.entries(attributes).sort(), `${name} #${i}: the attributes`);
    });
    for (const shape of svg.children) {
      assert.equal(shape.namespace, SVG);
      assert.ok(KINDS.has(shape.tag), `${name}: ${shape.tag} is a shape of the list`);
      for (const [attribute, value] of shape.attributes) {
        assert.doesNotMatch(attribute, /^(on|style|href|xlink)/i, `${name}: ${attribute} could run or load something`);
        if (attribute === 'd') assert.match(value, PATH_DATA, `${name}: path data`);
        else if (attribute === 'fill') assert.equal(value, 'currentColor');
        else assert.match(value, NUMBER, `${name}: ${attribute}=${value}`);
      }
    }
  }
});

test('the pictures differ from one another, and a picture that is not one of the list is refused', () => {
  const drawn = named.map((name) => JSON.stringify(toolbarShapes[name]));
  assert.equal(new Set(drawn).size, named.length);
  assert.throws(() => toolbarIcon('nothing', fake), /unknown icon/);
  assert.throws(() => toolbarIcon('constructor', fake), /unknown icon/);
  assert.throws(() => toolbarIcon('__proto__', fake), /unknown icon/);
  assert.throws(() => toolbarIcon('toString', fake), /unknown icon/);
  assert.throws(() => toolbarIcon('hasOwnProperty', fake), /unknown icon/);
});

test('the corners of a rectangle that has them are rounded, and the dot of a sign is filled', () => {
  const rounded = toolbarShapes['duplicate']!.filter(([kind, attributes]) => kind === 'rect' && 'rx' in attributes);
  assert.ok(rounded.length >= 1, 'duplicate has a rectangle with corners');
  const svg = toolbarIcon('duplicate', fake) as unknown as FakeElement;
  assert.ok(svg.children.some((s) => s.tag === 'rect' && s.attributes.has('rx')));
  const dot = toolbarIcon('conflict', fake) as unknown as FakeElement;
  assert.ok(dot.children.some((s) => s.tag === 'circle' && s.attributes.get('fill') === 'currentColor' && s.attributes.get('r') === '0.6'));
  assert.ok((toolbarIcon('search', fake) as unknown as FakeElement).children.some((s) => s.tag === 'circle'), 'search is a lens');
});

test('no number of a drawing is larger than the grid it is drawn on', () => {
  for (const name of named) {
    for (const [, attributes] of toolbarShapes[name]!) {
      const numbers = Object.entries(attributes).flatMap(([key, value]) => (key === 'd' || key === 'fill' ? (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number) : [Number(value)]));
      for (const n of numbers) assert.ok(Math.abs(n) <= 16, `${name}: ${n} is on the grid`);
    }
  }
});

// Review of the execution (22 October 2026): no test looked at the drawings themselves (only that they are well formed, on the grid and not alike). The drawings were looked at in the window and approved;
// this is the digest of the 22 of them as they were then, so that a drawing changes on purpose, by a person who looked at it and changes the digest with it
test('the drawings are the ones that were looked at and approved: changing any of them changes this digest', () => {
  assert.equal(Object.keys(toolbarShapes).length, 22);
  assert.equal(createHash('sha256').update(JSON.stringify(toolbarShapes)).digest('hex'), 'd1c0b51be8be0295fcc09f6a10b5e33f452fa4b0741bb6157d7291c37aa60923');
});
