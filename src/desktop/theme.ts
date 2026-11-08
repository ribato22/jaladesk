// The theme of the window. The stylesheet (style.css) holds two palettes, a light one and a dark one, and everything else in it asks for a word of the palette (var(--text), var(--page));
// which palette is in force is decided by one rule, `prefers-color-scheme: dark`, and that is decided by the main process: nativeTheme.themeSource is the person's choice
// (Otomatis follows the system, Terang and Gelap do not), and the page follows it. Nothing here touches Electron or the page: it is what can be tested of this without a window, which
// is what the colours are worth: how the choice is read, the contrast of every text and sign against what it is drawn on in both palettes (the guidelines of the W3C: 4.5 to 1 for text, 3 to 1
// for signs), and that no colour is written anywhere but in a palette.
import { THEME_CHOICES, type ThemeChoice } from './commands.js';

export function parseThemeChoice(value: unknown): ThemeChoice | undefined { return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value) ? (value as ThemeChoice) : undefined; }
/** The colour a window has before its page is drawn, so that it does not flash white when the theme is dark; checked against the palettes in the stylesheet. */
export const BACKGROUNDS = {
  page: { light: '#edf1f5', dark: '#141a21' },
  aside: { light: '#fafbfd', dark: '#19212a' },
} as const;
/** `page` for the main window, `aside` for the windows that ask for a password or a credential. */
export function backgroundOf(kind: keyof typeof BACKGROUNDS, dark: boolean): string { return BACKGROUNDS[kind][dark ? 'dark' : 'light']; }

// ---- colours
export function parseHex(value: string): [number, number, number] | undefined {
  const found = value.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!found) return undefined;
  const digits = found[1]!.length <= 4 ? [...found[1]!].map((d) => d + d).join('') : found[1]!;
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
}
const channel = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
/** The relative luminance of a colour, from 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`not a colour: ${hex}`);
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
/** `share` of `a` mixed into `b`, channel by channel in sRGB, as CSS color-mix(in srgb, ...) does: the tint of a row that has a colour is the colour mixed into the surface. */
export function mixHex(a: string, b: string, share: number): string {
  const [ca, cb] = [parseHex(a), parseHex(b)];
  if (!ca || !cb) throw new Error(`not a colour: ${ca ? b : a}`);
  return `#${ca.map((channelA, i) => Math.round(channelA * share + cb[i]! * (1 - share)).toString(16).padStart(2, '0')).join('')}`;
}
/** The contrast between two colours, from 1 (the same) to 21 (black on white), the same whichever is in front. */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** What is drawn in one word of the palette on another, and the contrast it needs: 4.5 for text, 3 for signs (a ring of the focus, a mark, a line that says what is chosen). */
export type Pair = readonly [foreground: string, background: string, minimum: number];
export const PAIRS: readonly Pair[] = [
  ['text', 'page', 4.5], ['text', 'aside', 4.5], ['text', 'surface', 4.5], ['text', 'bar', 4.5], ['text', 'selected', 4.5], ['text', 'drop', 4.5], ['text', 'confirm', 4.5],
  ['text-2', 'page', 4.5], ['text-2', 'aside', 4.5], ['text-2', 'surface', 4.5], ['text-2', 'bar', 4.5], ['text-2', 'tabs', 4.5], ['text-2', 'selected', 4.5],
  ['muted', 'page', 4.5], ['muted', 'aside', 4.5], ['muted', 'surface', 4.5], ['muted', 'bar', 4.5], ['muted', 'tabs', 4.5], ['muted', 'selected', 4.5], ['muted', 'drop', 4.5], ['muted', 'confirm', 4.5],
  ['placeholder', 'surface', 4.5],
  ['glyph', 'surface', 3], ['glyph', 'selected', 3], ['glyph', 'drop', 3], ['glyph-icon', 'surface', 3], ['glyph-icon', 'selected', 3], ['glyph-icon', 'drop', 3],
  ['on-accent', 'accent', 4.5], ['header-text', 'header', 4.5], ['header-sub', 'header', 4.5], ['chip-text', 'chip', 4.5], ['brand', 'header', 3],
  ['danger', 'aside', 4.5], ['danger', 'surface', 4.5], ['danger', 'bar', 4.5], ['danger', 'confirm', 4.5], ['danger', 'selected', 4.5], ['danger', 'drop', 4.5],
  ['ok', 'aside', 4.5], ['ok', 'surface', 4.5], ['ok', 'bar', 4.5],
  ['fav-text', 'fav', 4.5], ['amber', 'surface', 3], ['amber', 'selected', 3], ['amber', 'drop', 3], ['amber', 'fav', 3],
  ['focus', 'page', 3], ['focus', 'aside', 3], ['focus', 'surface', 3], ['focus', 'bar', 3], ['focus', 'tabs', 3], ['focus', 'selected', 3], ['focus', 'drop', 3],
  // (the marks are also looked at on the other rows they are drawn on: the selected row, the row that is dropped on and the tinted row; see the tests)
  ['mark-red', 'surface', 3], ['mark-orange', 'surface', 3], ['mark-yellow', 'surface', 3], ['mark-green', 'surface', 3], ['mark-teal', 'surface', 3], ['mark-blue', 'surface', 3],
  ['mark-purple', 'surface', 3], ['mark-pink', 'surface', 3], ['mark-gray', 'surface', 3],
  ['accent-line', 'surface', 3], ['accent-line', 'aside', 3], ['accent-line', 'selected', 3], ['accent-line', 'drop', 3],
  // 02-B3b: the colour of a tab is a line over it, on the strip behind the tabs and, for the tab in front, on the bar; the place where a tab is dropped is a line of the accent on the strip
  ['mark-red', 'tabs', 3], ['mark-orange', 'tabs', 3], ['mark-yellow', 'tabs', 3], ['mark-green', 'tabs', 3], ['mark-teal', 'tabs', 3], ['mark-blue', 'tabs', 3], ['mark-purple', 'tabs', 3], ['mark-pink', 'tabs', 3], ['mark-gray', 'tabs', 3],
  ['mark-red', 'bar', 3], ['mark-orange', 'bar', 3], ['mark-yellow', 'bar', 3], ['mark-green', 'bar', 3], ['mark-teal', 'bar', 3], ['mark-blue', 'bar', 3], ['mark-purple', 'bar', 3], ['mark-pink', 'bar', 3], ['mark-gray', 'bar', 3],
  ['accent-line', 'tabs', 3], ['accent-line', 'bar', 3],
];

// ---- the stylesheet
export type Palette = Readonly<Record<string, string>>;
function declarations(body: string): Palette {
  const palette: Record<string, string> = {};
  for (const part of body.split(';')) {
    const found = part.match(/^\s*--([a-z0-9-]+)\s*:\s*(.+?)\s*$/);
    if (found) palette[found[1]!] = found[2]!;
  }
  return palette;
}
const LIGHT_BLOCK = /:root\{([^}]*--page:[^}]*)\}/;
const DARK_BLOCK = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/;
/** The two palettes of a stylesheet: the words of `:root` that name colours, and the same words inside the media rule for a dark system. */
export function readPalettes(css: string): { light: Palette; dark: Palette } {
  const dark = css.match(DARK_BLOCK), light = css.replace(DARK_BLOCK, '').match(LIGHT_BLOCK);   // (the dark palette is itself a `:root` block: it is cut away before the light one is looked for)
  if (!light || !dark) throw new Error('the stylesheet has no light and dark palette');
  return { light: declarations(light[1]!), dark: declarations(dark[1]!) };
}
const WITHOUT_PALETTES = (css: string) => css.replace(DARK_BLOCK, '').replace(LIGHT_BLOCK, ':root{');
/** The names of the colours that CSS knows (the 148 of CSS Color 4, without `transparent`, which draws nothing, and the system colours, which are the person's own). */
export const COLOUR_NAMES: readonly string[] = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral',
  'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid',
  'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick',
  'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen',
  'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple',
  'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab',
  'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown',
  'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle',
  'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
];
const LITERAL = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^)]*\\)|\\b(?:${COLOUR_NAMES.join('|')})\\b(?![-\\w])`, 'gi');      // the names and the functions of colours do not care for capitals
/** Every colour written out in a stylesheet outside the two palettes: a hex number, a colour function or the name of a colour. Words of a palette, `transparent`, `currentColor` and `inherit` are not written colours. */
export function colourLiterals(css: string): string[] {
  // an attribute selector such as [data-color=red] names a colour of an object, it does not draw one
  const rest = WITHOUT_PALETTES(css).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[[^\]]*\]/g, '').replace(/var\(--[a-z0-9-]+\)/g, '');
  return [...rest.matchAll(LITERAL)].map((m) => m[0]);
}
/** The words of a palette that the stylesheet asks for with var(--word). */
export function tokensUsed(css: string): Set<string> { return new Set([...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!)); }
