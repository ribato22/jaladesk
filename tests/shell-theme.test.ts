import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COLORS } from '../src/documents/meta.js';
import { THEME_CHOICES } from '../src/desktop/commands.js';
import { BACKGROUNDS, COLOUR_NAMES, PAIRS, backgroundOf, colourLiterals, contrast, luminance, mixHex, parseHex, parseThemeChoice, readPalettes, tokensUsed } from '../src/desktop/theme.js';

const css = async () => readFile(fileURLToPath(new URL('../../src/desktop/style.css', import.meta.url)), 'utf8');

test('a choice of theme is one of the three words, and nothing else', () => {
  for (const choice of THEME_CHOICES) assert.equal(parseThemeChoice(choice), choice);
  for (const wrong of ['', 'Dark', 'dark ', 'auto', 'automatic', 'constructor', '__proto__', 1, null, undefined, {}, ['dark']]) assert.equal(parseThemeChoice(wrong), undefined, String(wrong));
});

test('colours are read from #rgb and #rrggbb, and the contrast between two of them is the one of the Web Content Accessibility Guidelines', () => {
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.deepEqual(parseHex('#223349'), [0x22, 0x33, 0x49]);
  assert.deepEqual(parseHex('#00000014'), [0, 0, 0], 'a colour with transparency: its colour');
  assert.deepEqual(parseHex('#0006'), [0, 0, 0], 'four digits: a colour with transparency, short');
  assert.deepEqual(parseHex('#f0a8'), [255, 0, 170], 'each digit is said twice');
  assert.deepEqual(parseHex('#FFF'), [255, 255, 255], 'capitals are digits too');
  assert.deepEqual(parseHex('#A1b2C3'), [0xa1, 0xb2, 0xc3]);
  for (const wrong of ['', 'fff', '#ff', '#ggg', '#12345', '#1234567', 'white', 'rgb(0,0,0)']) assert.equal(parseHex(wrong), undefined, wrong);
  assert.equal(luminance('#000000'), 0);
  assert.equal(luminance('#ffffff'), 1);
  // the weight of each channel, and the dark end of the curve, which is a straight line
  assert.ok(Math.abs(luminance('#ff0000') - 0.2126) < 1e-9 && Math.abs(luminance('#00ff00') - 0.7152) < 1e-9 && Math.abs(luminance('#0000ff') - 0.0722) < 1e-9);
  assert.ok(Math.abs(luminance('#0a0a0a') - 10 / 255 / 12.92) < 1e-9, 'a channel of 10 is on the straight part');
  assert.ok(Math.abs(luminance('#808080') - 0.2158605) < 1e-6, 'and a middle grey on the curve');
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(Math.abs(contrast('#ffffff', '#000000') - 21) < 1e-9, 'the same either way round');
  assert.equal(contrast('#336699', '#336699'), 1);
  assert.ok(Math.abs(contrast('#777777', '#ffffff') - 4.478) < 0.01, 'the well-known #777 on white');
  assert.ok(contrast('#767676', '#ffffff') >= 4.5 && contrast('#777777', '#ffffff') < 4.5, 'and the first grey that passes');
  assert.throws(() => contrast('red', '#ffffff'), /not a colour/);
});

test('the stylesheet has two palettes, a light one and a dark one, with the same words in both, and tells the system that it has both', async () => {
  const text = await css();
  const { light, dark } = readPalettes(text);
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
  assert.equal(Object.keys(light).length, 45);
  assert.match(text, /:root\{color-scheme:light dark;/);
  assert.equal((text.match(/prefers-color-scheme/g) ?? []).length, 1, 'one place decides when it is dark');
  for (const [name, value] of [...Object.entries(light), ...Object.entries(dark)]) assert.match(value, /^#[0-9a-f]{3,8}$/, `--${name}: ${value}`);
});

test('the light palette is the colours of the window as they were before there was a dark one, with the changes that make every text readable', async () => {
  const { light } = readPalettes(await css());
  assert.deepEqual(light, {
    page: '#edf1f5', aside: '#fafbfd', surface: '#ffffff', bar: '#f7f9fc', tabs: '#e3e9ef', selected: '#dce8f3', drop: '#cfe3f6', confirm: '#fbf3e4', fav: '#f6e9cf',
    header: '#263b51', chip: '#354c64', canvas: '#1d2731',
    line: '#d4dde6', 'line-input': '#bfcbd8',
    text: '#223349', 'text-2': '#38506a', muted: '#536579', placeholder: '#5f7187', glyph: '#627489', 'glyph-icon': '#6f7f91', decor: '#8da2b8', 'decor-line': '#a6b7c8',
    accent: '#285b7d', 'accent-line': '#285b7d', 'on-accent': '#ffffff', focus: '#a97434', amber: '#a97231', 'fav-text': '#6b4710', danger: '#a42c2c', ok: '#2d6a4f',
    'header-text': '#ffffff', 'header-sub': '#b5c3d2', brand: '#edba6e', 'chip-text': '#dce7f3',
    'mark-red': '#c0392b', 'mark-orange': '#c16617', 'mark-yellow': '#997a00', 'mark-green': '#2e8b57', 'mark-teal': '#178c8c', 'mark-blue': '#2f6fb5', 'mark-purple': '#7b4fb0', 'mark-pink': '#d1498a', 'mark-gray': '#6b7785',
    shadow: '#00000014', backdrop: '#0006',
  });
});

test('a stylesheet that does not hold both palettes is refused, with the reason, and not read as empty palettes', () => {
  assert.throws(() => readPalettes('a{color:var(--text)}'), /no light and dark palette/);
  assert.throws(() => readPalettes(':root{--page:#fff}'), /no light and dark palette/, 'only the light one');
  assert.throws(() => readPalettes('@media (prefers-color-scheme:dark){:root{--page:#000}}'), /no light and dark palette/, 'only the dark one');
  assert.deepEqual(readPalettes(':root{--page:#fff;--text:#000}@media (prefers-color-scheme:dark){:root{--page:#000;--text:#fff}}'), { light: { page: '#fff', text: '#000' }, dark: { page: '#000', text: '#fff' } });
});

test('the dark palette is written out: every word of it, so that a colour of it cannot change without a person meaning it', async () => {
  const { dark } = readPalettes(await css());
  assert.deepEqual(dark, {
    page: '#141a21', aside: '#19212a', surface: '#1f2833', bar: '#1b232d', tabs: '#10161c', selected: '#2a4560', drop: '#2d4e6c', confirm: '#3a2f1b', fav: '#3b301f',
    header: '#0e141a', chip: '#243242', canvas: '#1d2731',
    line: '#2f3b49', 'line-input': '#4a5a6d',
    text: '#e3eaf2', 'text-2': '#c3cfdb', muted: '#afbecf', placeholder: '#8b9db1', glyph: '#9aabbe', 'glyph-icon': '#8a9cb0', decor: '#566a80', 'decor-line': '#43546a',
    accent: '#2f6f9c', 'accent-line': '#5aa2d4', 'on-accent': '#ffffff', focus: '#e2a850', amber: '#dda254', 'fav-text': '#f3d8a0', danger: '#ffaaa1', ok: '#80d3a3',
    'header-text': '#ffffff', 'header-sub': '#9fb2c6', brand: '#edba6e', 'chip-text': '#d0deee',
    'mark-red': '#f07568', 'mark-orange': '#f28d3d', 'mark-yellow': '#e8c33a', 'mark-green': '#4fbf85', 'mark-teal': '#3cc0c0', 'mark-blue': '#609ee1', 'mark-purple': '#a98be0', 'mark-pink': '#ed6eab', 'mark-gray': '#98a5b5',
    shadow: '#00000066', backdrop: '#000000a6',
  });
});

test('no colour is written anywhere but in the palettes: everything else asks for a word of a palette, so that both themes can reach it', async () => {
  const text = await css();
  assert.deepEqual(colourLiterals(text), []);
  assert.deepEqual(colourLiterals(':root{color:#fff;background:white;border:1px solid rgb(0 0 0 / 50%);outline:hsl(3 4% 5%)} a{color:red}'), ['#fff', 'white', 'rgb(0 0 0 / 50%)', 'hsl(3 4% 5%)', 'red'], 'the check finds what it is for');
  assert.deepEqual(colourLiterals('a{color:var(--text);background:transparent;border:0;color:currentColor;color:inherit}'), []);
  assert.deepEqual(colourLiterals('[data-color=red]{--mark:var(--mark-red)} .row[data-color=blue] .glyph{color:var(--mark)}'), [], 'the name of a colour in a selector is not a colour that is drawn');
  assert.deepEqual(colourLiterals(':root{--page:#fff}@media (prefers-color-scheme:dark){:root{--page:#000}}a{color:var(--page)}'), [], 'the palettes are not literals of the rest');
  assert.deepEqual(colourLiterals('/* a note that says #fff and white and red */ a{color:var(--text)}'), [], 'a colour in a comment is not drawn');
  assert.deepEqual(colourLiterals(':root{--page:#fff}@media (prefers-color-scheme:dark){:root{--page:#000}}a{color:#abc}'), ['#abc'], 'the palettes are cut away and the rest is still looked at');
  assert.deepEqual(colourLiterals('a{color:var(--mark-red);background:var(--red)}'), [], 'a word of a palette that is also the name of a colour is not that colour');
  // every name of a colour that CSS knows is found, and a word that merely contains one is not
  assert.equal(COLOUR_NAMES.length, 148);
  assert.equal(new Set(COLOUR_NAMES).size, 148);
  for (const name of COLOUR_NAMES) assert.deepEqual(colourLiterals(`a{color:${name}}`), [name], name);
  assert.deepEqual(colourLiterals('a{color:tomato;background:lightgray;border-color:whitesmoke;outline-color:rebeccapurple;fill:gold}'), ['tomato', 'lightgray', 'whitesmoke', 'rebeccapurple', 'gold']);
  assert.deepEqual(colourLiterals('.tomato-soup{margin:0} .goldfish{margin:0} .tanned{margin:0}'), [], 'a name inside a longer word is not a colour');
});

test('the tint of a row that has a colour is what the stylesheet says it is: the colour mixed into the surface, in sRGB, as CSS does', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#ff0000', '#ffffff', 0.12), '#ffe0e0');
  assert.equal(mixHex('#336699', '#336699', 0.3), '#336699');
  assert.equal(mixHex('#ffffff', '#000000', 1), '#ffffff');
  assert.equal(mixHex('#ffffff', '#000000', 0), '#000000');
  assert.throws(() => mixHex('red', '#000000', 0.5), /not a colour/);
});

test('every word of a palette that is asked for is there, and every word that is there is asked for', async () => {
  const text = await css();
  const { light } = readPalettes(text);
  const asked = tokensUsed(text);
  for (const name of asked) assert.ok(name in light || name === 'mark', `var(--${name}) is not in the palette`);
  for (const name of Object.keys(light)) assert.ok(asked.has(name), `--${name} is never asked for`);
});

test('every text and every sign of the window can be read in both palettes: the contrast of each pair is at least the one asked for', async () => {
  const { light, dark } = readPalettes(await css());
  assert.equal(PAIRS.length, 87, 'the pairs that matter: the list changes when a person means it to');      // 02-B3b: twenty more (the colour of a tab on the strip and on the bar, the place where a tab is dropped)
  const failures: string[] = [];
  for (const [name, palette] of [['light', light], ['dark', dark]] as const) {
    for (const [foreground, background, minimum] of PAIRS) {
      assert.ok(foreground in palette && background in palette, `${foreground} on ${background} are words of the palette`);
      const ratio = contrast(palette[foreground]!, palette[background]!);
      if (ratio < minimum) failures.push(`${name}: ${foreground} ${palette[foreground]} on ${background} ${palette[background]} is ${ratio.toFixed(2)}, below ${minimum}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(PAIRS.every(([, , minimum]) => minimum === 3 || minimum === 4.5), 'the two levels of the guidelines: text and signs');
  assert.equal(PAIRS.filter(([, , minimum]) => minimum === 4.5).length, 36, 'text');
  assert.equal(PAIRS.filter(([, , minimum]) => minimum === 3).length, 51, 'signs');      // 02-B3b: twenty more
});

test('every colour a mark can have can be seen on every row it can be drawn on: the row, the selected row, the row that is dropped on, and the row that is tinted by that very colour; and the words of such a row can be read', async () => {
  const { light, dark } = readPalettes(await css());
  for (const [name, palette] of [['light', light], ['dark', dark]] as const) {
    for (const { id } of COLORS) {
      const mark = palette[`mark-${id}`]!, tint = mixHex(mark, palette.surface!, 0.12);
      for (const [where, on] of [['surface', palette.surface!], ['selected', palette.selected!], ['drop', palette.drop!], ['tint', tint]] as const) assert.ok(contrast(mark, on) >= 3, `${name}: ${id} on ${where} is ${contrast(mark, on).toFixed(2)}`);
      for (const word of ['text', 'text-2', 'muted'] as const) assert.ok(contrast(palette[word]!, tint) >= 4.5, `${name}: ${word} on the tint of ${id} is ${contrast(palette[word]!, tint).toFixed(2)}`);
      assert.ok(contrast(palette.amber!, tint) >= 3 && contrast(palette['glyph-icon']!, tint) >= 3, `${name}: the star and the picture on the tint of ${id}`);
    }
  }
});

test('every word of the palette is in a pair that is looked at, or is on a short list of words that are not text or signs, with the reason', async () => {
  const { light } = readPalettes(await css());
  const inPairs = new Set(PAIRS.flatMap(([foreground, background]) => [foreground, background]));
  const NOT_TEXT_OR_SIGN: Record<string, string> = {
    canvas: 'the screen of the remote desktop, drawn by the remote machine', line: 'a border between parts (decoration)', 'line-input': 'the border of a box: 1.65 to 1, a known limit', decor: 'a handle (decoration)',
    'decor-line': 'a line of decoration', shadow: 'a shadow', backdrop: 'the shade behind a dialog',
  };
  for (const name of Object.keys(light)) assert.ok(inPairs.has(name) || name in NOT_TEXT_OR_SIGN, `--${name} is neither in a pair nor on the list`);
  for (const name of Object.keys(NOT_TEXT_OR_SIGN)) assert.ok(!inPairs.has(name) && name in light, `--${name} is on the list and must not be in a pair`);
  assert.equal(Object.keys(light).length - Object.keys(NOT_TEXT_OR_SIGN).length, inPairs.size, 'and no pair names a word that is not there');
});

test('the pairs are the ones the window really draws: text on every surface it is drawn on, the ring of the focus on every surface, and the colours of the marks on the tree', () => {
  const has = (foreground: string, background: string) => PAIRS.some(([f, b]) => f === foreground && b === background);
  for (const surface of ['page', 'aside', 'surface', 'bar', 'selected', 'drop', 'confirm']) assert.ok(has('text', surface), `text on ${surface}`);
  for (const surface of ['page', 'aside', 'surface', 'bar', 'tabs', 'selected', 'drop']) assert.ok(has('focus', surface), `the ring of the focus on ${surface}`);
  for (const surface of ['aside', 'surface', 'bar', 'tabs', 'selected', 'drop', 'confirm']) assert.ok(has('muted', surface), `muted words on ${surface}`);
  for (const surface of ['page', 'aside', 'surface', 'bar', 'tabs', 'selected']) assert.ok(has('text-2', surface), `secondary words on ${surface}`);
  for (const surface of ['surface', 'selected', 'drop']) assert.ok(has('glyph', surface) && has('glyph-icon', surface) && has('amber', surface), `the arrow, the picture and the star on ${surface}`);
  assert.ok(has('danger', 'selected') && has('danger', 'drop'), 'a warning on the selected row and on the row that is dropped on (a marked row can be both)');
  for (const { id } of COLORS) assert.ok(has(`mark-${id}`, 'surface'), `the colour ${id} on the tree`);
  assert.ok(has('on-accent', 'accent') && has('header-text', 'header') && has('chip-text', 'chip') && has('fav-text', 'fav'));
  assert.ok(has('danger', 'aside') && has('ok', 'aside') && has('placeholder', 'surface'));
  assert.ok(has('accent-line', 'selected') && has('accent-line', 'drop'), 'the line of a drop and of the version that is shown');
});

test('the dark palette is a dark one: the page is darker than the text, the surfaces are darker than they were, and the screen of the remote desktop stays what it was', async () => {
  const { light, dark } = readPalettes(await css());
  assert.ok(luminance(light.page!) > luminance(light.text!) && luminance(dark.page!) < luminance(dark.text!));
  for (const surface of ['page', 'aside', 'surface', 'bar', 'tabs', 'selected', 'drop', 'confirm', 'fav', 'header', 'chip']) assert.ok(luminance(dark[surface]!) < 0.1, `dark ${surface}`);
  for (const surface of ['page', 'aside', 'surface', 'bar', 'tabs', 'selected', 'drop', 'confirm', 'fav']) assert.ok(luminance(dark[surface]!) < luminance(light[surface]!), `${surface} is darker in the dark palette`);
  for (const text of ['text', 'text-2', 'muted', 'placeholder']) assert.ok(luminance(dark[text]!) > luminance(light[text]!), `${text} is lighter in the dark palette`);
  assert.equal(dark.canvas, light.canvas, 'the screen of the remote desktop');
  assert.equal(dark['header-text'], '#ffffff');
  assert.notEqual(dark.page, light.page);
});

test('every colour that an object can be given has a rule of its own, and the rule asks for the word of the palette', async () => {
  const text = await css();
  const { light, dark } = readPalettes(text);
  for (const { id } of COLORS) {
    assert.ok(text.includes(`[data-color=${id}]{--mark:var(--mark-${id})}`), `the rule of ${id}`);
    assert.ok(`mark-${id}` in light && `mark-${id}` in dark, id);
  }
  assert.equal(Object.keys(light).filter((name) => name.startsWith('mark-')).length, COLORS.length, 'and no colour of a mark that no object can have');
  assert.ok(text.includes('color-mix(in srgb,var(--mark) 12%,var(--surface))'), 'the tint of a row mixes with the surface of the theme, not with white');
});

test('the colour a window starts with is the colour of its page, so that it does not flash white when the theme is dark', async () => {
  const { light, dark } = readPalettes(await css());
  assert.equal(BACKGROUNDS.page.light, light.page);
  assert.equal(BACKGROUNDS.page.dark, dark.page);
  assert.equal(BACKGROUNDS.aside.light, light.aside);
  assert.equal(BACKGROUNDS.aside.dark, dark.aside);
  assert.equal(backgroundOf('page', false), light.page);
  assert.equal(backgroundOf('page', true), dark.page);
  assert.equal(backgroundOf('aside', true), dark.aside);
  assert.equal(backgroundOf('aside', false), light.aside);
});

test('the other pages of the application, the windows that ask for a password, use the same stylesheet and so follow the theme', async () => {
  for (const name of ['credential.html', 'password.html', 'index.html']) {
    const html = await readFile(fileURLToPath(new URL(`../../src/desktop/${name}`, import.meta.url)), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="style\.css">/, name);
    assert.doesNotMatch(html, /<style\b/i, name);
  }
});

// Review of the execution (22 October 2026): the names and the functions of colours are found whatever their case, and all the functions of colours that the style sheet could use
test('a colour written outside the palettes is found whatever the case of its name, and whichever function of colour it is', () => {
  for (const written of ['Red', 'WHITE', 'RGBA(1,2,3,.5)', 'HSL(1 2% 3%)', 'hwb(1 2% 3%)', 'lab(1 2 3)', 'lch(1 2 3)', 'oklab(1 2 3)', 'oklch(1 2 3)', 'color(srgb 1 1 1)', '#ABC', '#12345678', 'Tomato']) {
    assert.equal(colourLiterals(`a{color:${written}}`).length, 1, written);
  }
  for (const quiet of ['transparent', 'currentColor', 'inherit', 'var(--text)', 'Transparent']) assert.deepEqual(colourLiterals(`a{color:${quiet}}`), [], quiet);
  assert.deepEqual(colourLiterals('a[data-color=Red]{--mark:var(--mark-red)}'), [], 'the name of the colour of an object in a selector is not a colour that is drawn');
});


// Review of the execution (22 October 2026): the lighter hover of the buttons (a filter) lightened the words of a tab that is not in front, whose background is the bar of the tabs, from 4.9 to 4.1:1 in the
// light palette; the tab under the pointer now takes the colour of the tab in front and keeps its words as they are
test('a tab that is not in front keeps its words as they are under the pointer, on a colour they can be read on', async () => {
  const sheet = await css();
  const rule = sheet.match(/#tabs button:not\(\.active\):hover:not\(:disabled\)\{([^}]*)\}/);
  assert.ok(rule, 'a rule for the tab that is not in front, under the pointer');
  assert.match(rule[1]!, /(?:^|;)filter:none(?:;|$)/, 'the hover of buttons lightens what it is on: not here, where the background is not part of the button');
  const background = rule[1]!.match(/(?:^|;)background:var\(--([a-z0-9-]+)\)(?:;|$)/);
  assert.ok(background, 'a background of a word of the palette');
  assert.notEqual(background[1], 'tabs', 'a colour other than the bar of the tabs, or the tab under the pointer would not be seen to change');
  const { light, dark } = readPalettes(sheet);
  for (const [name, palette] of [['light', light], ['dark', dark]] as const) {
    const need = PAIRS.find(([foreground, behind]) => foreground === 'muted' && behind === background[1]);
    assert.ok(need && need[2] >= 4.5, `${name}: the words of a tab (muted) on ${background[1]} are a pair that is looked at`);
    assert.ok(contrast(palette.muted!, palette[background[1]!]!) >= 4.5, `${name}: muted on ${background[1]} is ${contrast(palette.muted!, palette[background[1]!]!).toFixed(2)}`);
  }
});
