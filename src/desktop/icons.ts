// The icons an object can choose (the list is in documents/meta.ts), drawn here: each is a few strokes on a 16 by 16 grid, in the colour of the text around it. Nothing is read
// from a file and no markup is parsed: the shapes are made with createElementNS and attributes, like everything else the window draws, and the attributes that can be
// set are the numbers and path data written below.
import { type IconId } from '../documents/meta.js';

type Shape = readonly [kind: 'path' | 'rect' | 'circle' | 'ellipse' | 'line', attributes: Readonly<Record<string, string>>];
const path = (d: string): Shape => ['path', { d }];
const rect = (x: string, y: string, width: string, height: string, rx?: string): Shape => ['rect', { x, y, width, height, ...(rx ? { rx } : {}) }];
const circle = (cx: string, cy: string, r: string): Shape => ['circle', { cx, cy, r }];
const dot = (cx: string, cy: string): Shape => ['circle', { cx, cy, r: '0.6', fill: 'currentColor' }];

export const iconShapes: Readonly<Record<IconId, readonly Shape[]>> = {
  server: [rect('2', '2.5', '12', '4.5', '1'), rect('2', '9', '12', '4.5', '1'), dot('4.8', '4.75'), dot('4.8', '11.25')],
  desktop: [rect('1.5', '2.5', '13', '8.5', '1'), path('M8 11v2.5'), path('M5 13.5h6')],
  laptop: [rect('3', '3', '10', '7.5', '1'), path('M1.5 12.5h13')],
  database: [['ellipse', { cx: '8', cy: '4', rx: '5.5', ry: '2' }], path('M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-0.9 5.5-2V4'), path('M2.5 8c0 1.1 2.5 2 5.5 2s5.5-0.9 5.5-2')],
  cloud: [path('M4.5 12.5h7a2.5 2.5 0 0 0 0.3-4.98A4 4 0 0 0 4.2 7 3 3 0 0 0 4.5 12.5z')],
  network: [circle('8', '3.5', '1.6'), circle('3.5', '12', '1.6'), circle('12.5', '12', '1.6'), path('M7.2 4.9L4.3 10.6'), path('M8.8 4.9L11.7 10.6'), path('M5.1 12h5.8')],
  router: [rect('1.5', '8.5', '13', '4.5', '1'), path('M4.5 8.5V4.5'), path('M11.5 8.5V4.5'), dot('5', '10.75'), dot('7.5', '10.75')],
  shield: [path('M8 1.8l5.5 2v4c0 3-2.3 5.2-5.5 6.4C4.8 13 2.5 10.8 2.5 7.8v-4z')],
  key: [circle('5', '10.5', '2.6'), path('M6.9 8.6L13.5 2.2'), path('M11.2 4.5l1.8 1.8'), path('M9.4 6.3l1.4 1.4')],
  terminal: [rect('1.5', '2.5', '13', '11', '1.5'), path('M4.5 6.5L7 8.5L4.5 10.5'), path('M8.5 10.5h3')],
  globe: [circle('8', '8', '6.2'), ['ellipse', { cx: '8', cy: '8', rx: '2.6', ry: '6.2' }], path('M1.8 8h12.4')],
  printer: [rect('4', '2', '8', '3.5'), rect('1.5', '5.5', '13', '6', '1'), rect('4.5', '9.5', '7', '4.5')],
  phone: [rect('4.5', '1.5', '7', '13', '1.5'), path('M7 12.3h2')],
  chip: [rect('4', '4', '8', '8', '1'), path('M6.5 1.8v2.2'), path('M9.5 1.8v2.2'), path('M6.5 12v2.2'), path('M9.5 12v2.2'), path('M1.8 6.5h2.2'), path('M1.8 9.5h2.2'), path('M12 6.5h2.2'), path('M12 9.5h2.2')],
  wrench: [path('M13.8 5.2a3.2 3.2 0 0 1-4.2 3.7L4 14.5a1.4 1.4 0 0 1-2.1-2.1l5.6-5.6A3.2 3.2 0 0 1 11.2 2.6l-2 2 0.6 1.6 1.6 0.6z')],
  box: [path('M8 1.8l5.5 2.8v6.8L8 14.2 2.5 11.4V4.6z'), path('M2.5 4.6L8 7.4l5.5-2.8'), path('M8 7.4v6.8')],
};

const SVG = 'http://www.w3.org/2000/svg';
const ROOT = { viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** The picture of an icon, for an element of the window to hold. `doc` is the document it is made for (the window's own unless a test gives another). */
export function iconElement(id: IconId, doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg') as SVGSVGElement;
  for (const [name, value] of Object.entries(ROOT)) svg.setAttribute(name, value);
  svg.setAttribute('data-icon', id);
  for (const [kind, attributes] of iconShapes[id]) {
    const shape = doc.createElementNS(SVG, kind);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}
