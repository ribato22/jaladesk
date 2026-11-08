import assert from 'node:assert/strict';
import test from 'node:test';
import { ICONS } from '../src/documents/meta.js';
import { iconElement, iconShapes } from '../src/desktop/icons.js';

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

test('every icon of the list is drawn, and nothing is drawn that is not in the list', () => {
  assert.deepEqual(Object.keys(iconShapes).sort(), ICONS.map((i) => i.id).sort());
  for (const { id } of ICONS) assert.ok(iconShapes[id].length >= 1 && iconShapes[id].length <= 12, `${id}: a few strokes`);
});

test('an icon is one small picture that says nothing to a screen reader: a 16 by 16 drawing in the colour of the text, with the shapes of the list only', () => {
  for (const { id } of ICONS) {
    const svg = iconElement(id, fake) as unknown as FakeElement;
    assert.deepEqual([svg.namespace, svg.tag], [SVG, 'svg'], id);
    assert.deepEqual([svg.attributes.get('viewBox'), svg.attributes.get('width'), svg.attributes.get('height'), svg.attributes.get('aria-hidden'), svg.attributes.get('data-icon')], ['0 0 16 16', '16', '16', 'true', id]);
    assert.deepEqual([svg.attributes.get('fill'), svg.attributes.get('stroke'), svg.attributes.get('stroke-linecap')], ['none', 'currentColor', 'round']);
    assert.equal(svg.children.length, iconShapes[id].length);
    for (const shape of svg.children) {
      assert.equal(shape.namespace, SVG);
      assert.ok(KINDS.has(shape.tag), `${id}: ${shape.tag} is a shape of the list`);
      for (const [name, value] of shape.attributes) {
        assert.doesNotMatch(name, /^(on|style|href|xlink)/i, `${id}: ${name} could run or load something`);
        if (name === 'd') assert.match(value, PATH_DATA, `${id}: path data`);
        else if (name === 'fill') assert.equal(value, 'currentColor');
        else assert.match(value, NUMBER, `${id}: ${name}=${value}`);
      }
    }
  }
});

test('the icons are different from one another', () => {
  const drawn = ICONS.map((i) => JSON.stringify(iconShapes[i.id]));
  assert.equal(new Set(drawn).size, ICONS.length);
});
