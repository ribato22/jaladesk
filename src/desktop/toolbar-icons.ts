// The pictures of the toolbar's buttons (the names are in commands.ts), drawn here like the icons of the objects (icons.ts): a few strokes on a 16 by 16 grid, in the colour of the text
// around them. Nothing is read from a file and no markup is parsed: the shapes are made with createElementNS and attributes, and the attributes that can be set are the numbers and path
// data written below.

type Shape = readonly [kind: 'path' | 'rect' | 'circle' | 'ellipse' | 'line', attributes: Readonly<Record<string, string>>];
const path = (d: string): Shape => ['path', { d }];
const rect = (x: string, y: string, width: string, height: string, rx?: string): Shape => ['rect', { x, y, width, height, ...(rx ? { rx } : {}) }];
const circle = (cx: string, cy: string, r: string): Shape => ['circle', { cx, cy, r }];
const dot = (cx: string, cy: string): Shape => ['circle', { cx, cy, r: '0.6', fill: 'currentColor' }];

export const toolbarShapes: Readonly<Record<string, readonly Shape[]>> = {
  new: [path('M4 1.8h5.2l3.3 3.2v9.2H4z'), path('M9 1.8V5h3.5'), path('M8.2 8v4'), path('M6.2 10h4')],
  open: [path('M1.8 12.8V3.6h4.2l1.4 1.6h6.8v2.4'), path('M1.8 12.8l2-5h10.4l-2 5z')],
  save: [path('M2.5 2.5h8.6l2.4 2.4v8.6h-11z'), rect('5', '2.5', '5', '3.5'), rect('4.5', '8.5', '7', '5')],
  close: [path('M4 1.8h5.2l3.3 3.2v9.2H4z'), path('M9 1.8V5h3.5'), path('M6.4 8.4l3.4 3.4'), path('M9.8 8.4l-3.4 3.4')],
  reload: [path('M13 8a5 5 0 1 1-1.6-3.7'), path('M13 2.5v3h-3')],
  conflict: [path('M8 2l6.2 11H1.8z'), path('M8 6.5v3'), dot('8', '11.3')],
  history: [circle('8', '8', '5.8'), path('M8 4.8V8l2.3 1.4')],
  connect: [path('M5.5 2v3.5'), path('M10.5 2v3.5'), path('M3.8 5.5h8.4v2a4.2 4.2 0 0 1-8.4 0z'), path('M8 11.7v2.8')],
  'folder-add': [path('M1.8 12.8V3.8h4.2l1.4 1.6h6.8v7.4z'), path('M8 7.4v3.6'), path('M6.2 9.2h3.6')],
  'connection-add': [rect('1.5', '2.5', '13', '8.5', '1'), path('M8 11v2.5'), path('M5 13.5h6'), path('M8 4.8v3.4'), path('M6.3 6.5h3.4')],
  properties: [path('M3 13l.7-3L11.2 2.5l2.3 2.3L6 12.3z'), path('M9.8 3.9l2.3 2.3')],
  duplicate: [rect('5.5', '5.5', '8', '8', '1'), path('M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2')],
  favorite: [path('M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z')],
  remove: [path('M2.5 4.5h11'), path('M6 4.5V2.8h4v1.7'), path('M3.8 4.5l.7 9h7l.7-9'), path('M6.5 7v4'), path('M9.5 7v4')],
  expand: [path('M3.5 6.5L8 2.5l4.5 4'), path('M3.5 9.5L8 13.5l4.5-4')],
  collapse: [path('M3.5 2.5L8 6.5l4.5-4'), path('M3.5 13.5L8 9.5l4.5 4')],
  search: [circle('7', '7', '4.5'), path('M10.4 10.4L14 14')],
  quick: [path('M9 1.8L3.5 9H8l-1 5.2L12.5 7H8z')],
  reconnect: [path('M2.5 8a5.5 5.5 0 0 1 9.4-3.9'), path('M12.5 2v3h-3'), path('M13.5 8a5.5 5.5 0 0 1-9.4 3.9'), path('M3.5 14v-3h3')],
  disconnect: [circle('8', '8', '5.8'), path('M5.8 5.8l4.4 4.4'), path('M10.2 5.8l-4.4 4.4')],
  'close-tab': [rect('2', '3.5', '12', '9', '1'), path('M6.2 6.2l3.6 3.6'), path('M9.8 6.2l-3.6 3.6')],
  fullscreen: [path('M2 5.5V2h3.5'), path('M10.5 2H14v3.5'), path('M14 10.5V14h-3.5'), path('M5.5 14H2v-3.5')],
};

const SVG = 'http://www.w3.org/2000/svg';
const ROOT = { viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** The picture of a button, for an element of the window to hold. `doc` is the document it is made for (the window's own unless a test gives another). */
export function toolbarIcon(name: string, doc: Document = document): SVGSVGElement {
  if (!Object.hasOwn(toolbarShapes, name)) throw new Error(`unknown icon: ${name}`);
  const svg = doc.createElementNS(SVG, 'svg') as SVGSVGElement;
  for (const [attribute, value] of Object.entries(ROOT)) svg.setAttribute(attribute, value);
  svg.setAttribute('data-icon', name);
  for (const [kind, attributes] of toolbarShapes[name]!) {
    const shape = doc.createElementNS(SVG, kind);
    for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, value);
    svg.append(shape);
  }
  return svg;
}
