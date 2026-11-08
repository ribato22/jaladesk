import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The page of the settings is plain markup that settings-ui.ts finds its controls in by id. A control that is renamed in one of the two would stop the window from starting, and nothing would say so.
const read = (name: string) => readFile(fileURLToPath(new URL(`../../src/desktop/${name}`, import.meta.url)), 'utf8');

test('every control that the script of the settings looks for is on the page, once, and the page asks for nothing but its own script and the style sheet', async () => {
  const html = await read('settings.html');
  const script = await read('settings-ui.ts');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(new Set(ids).size, ids.length, 'an id once');
  const used = new Set([...script.matchAll(/el(?:<[^>]+>)?\('([a-z0-9-]+)'\)/g)].map((m) => m[1]!));
  for (const theme of ['system', 'light', 'dark']) used.add(`st-theme-${theme}`);
  used.delete('st-theme-${theme}');
  for (const id of used) assert.ok(ids.includes(id), `#${id} is on the page`);
  const referenced = new Set([...html.matchAll(/\baria-(?:labelledby|describedby)="([^"]+)"/g)].flatMap((m) => m[1]!.split(' ')));
  for (const id of ids) assert.ok(used.has(id) || referenced.has(id), `#${id} is used by the script or by the markup itself`);
  for (const id of referenced) assert.ok(ids.includes(id), `#${id} is on the page, as the markup says`);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'">/);
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.match(html, /<script type="module" src="\.\.\/\.\.\/dist\/src\/desktop\/settings-ui\.js"><\/script>/);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no handler in the markup: the policy would refuse it');
  assert.match(html, /<body class="settings">/);
});

test('the three themes, and the checkboxes the script changes, are the ones the settings know by name', async () => {
  const script = await read('settings-ui.ts');
  for (const name of ['toolbar.visible', 'tabs.colorize', 'fullscreen.extended', 'keys.allow']) assert.ok(script.includes(`'${name}'`), name);
  assert.match(script, /THEMES: readonly ThemeChoice\[\] = \['system', 'light', 'dark'\]/);
});

test('the bridge of the window of the settings has the four channels and the push, and nothing that takes a path', async () => {
  const bridge = await read('settings-preload.cjs');
  for (const channel of ['settings:get', 'settings:set', 'settings:forget-keys', 'settings:clear-recent', 'settings:changed']) assert.ok(bridge.includes(`'${channel}'`), channel);
  assert.match(bridge, /exposeInMainWorld\('settingsWindow'/);
  assert.doesNotMatch(bridge.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'), /path|require\('fs'\)|child_process/);
});

// The independent review of the spike (slices 3 and 4): the page borrowed the class of the rows of the tree, a group of radio buttons held two checkboxes, and the notes were not tied to the controls they explain.
test('the rows of the page are not the rows of the tree: the class that the tree positions absolutely is not used, and the style sheet gives the settings rows a class of their own', async () => {
  const html = await read('settings.html');
  const css = await read('style.css');
  assert.doesNotMatch(html, /class="(?:[^"]*\s)?row(?:\s[^"]*)?"/, 'a row of the tree is positioned absolutely, with a height of its own');
  assert.match(html, /class="field-row"/);
  assert.match(css, /body\.settings \.field-row\{/);
  assert.doesNotMatch(css, /body\.settings \.row\b/);
});

test('a group of radio buttons holds radio buttons and nothing else, and the checkboxes sit in groups of their own', async () => {
  const html = await read('settings.html');
  for (const group of html.matchAll(/<fieldset role="radiogroup"[^>]*>([\s\S]*?)<\/fieldset>/g)) {
    assert.doesNotMatch(group[1]!, /type="checkbox"|<button/, 'a checkbox or a button in a group of radio buttons');
    assert.equal([...group[1]!.matchAll(/type="radio"/g)].length, 3, 'the three themes');
  }
  assert.equal([...html.matchAll(/role="radiogroup"/g)].length, 1);
  for (const id of ['st-toolbar', 'st-colorize']) assert.doesNotMatch(html.slice(html.indexOf('role="radiogroup"'), html.indexOf('</fieldset>')), new RegExp(id), `${id} is not in the group of themes`);
});

test('the notes are tied to the controls they explain, so that a screen reader says them with the control', async () => {
  const html = await read('settings.html');
  assert.match(html, /<input type="checkbox" id="st-keys"[^>]*aria-describedby="st-keys-note"/);
  assert.match(html, /<input type="checkbox" id="st-extended"[^>]*aria-describedby="st-extended-hint"/);
  assert.match(html, /id="st-extended-hint"/);
  assert.match(html, /<button type="button" id="st-forget"[^>]*aria-describedby="st-keys-count"/);
  assert.match(html, /<button type="button" id="st-clear"[^>]*aria-describedby="st-recent-count"/);
});

test('a note is written to the page only when it says something else, so that a screen reader is not told the same thing again each time the window is asked', async () => {
  const script = await read('settings-ui.ts');
  assert.match(script, /function setText\(/);
  assert.equal([...script.matchAll(/\.textContent = /g)].length, 1, 'every text goes through the function that writes it only when it changed: the one place that writes is that function');
});

// What the review after the execution (23 October 2026) found.

test('what the person must hear is in a region that is announced: the error as an alert, the counts as status', async () => {
  const html = await read('settings.html');
  assert.match(html, /<p id="st-error" role="alert"><\/p>/);
  assert.match(html, /<span id="st-keys-count" role="status"><\/span>/);
  assert.match(html, /<span id="st-recent-count" role="status"><\/span>/);
});
