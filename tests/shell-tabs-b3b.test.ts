import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// What the independent review of the spike found in the tabs and the panels, kept from coming back. The page itself is tried by the GUI scenarios (shell2.mjs); these read the sources for what a scenario cannot
// show from outside: a style that must not be there, a listener that must be.
const read = (name: string) => readFile(fileURLToPath(new URL(`../../src/desktop/${name}`, import.meta.url)), 'utf8');

test('the panels of the extended full screen stay open for the keyboard and not for a click of the mouse: the focus that a mouse leaves behind does not keep them open', async () => {
  const css = await read('style.css');
  assert.match(css, /body\.extended #chrome:has\(:focus-visible\)/);
  assert.match(css, /body\.extended aside:has\(:focus-visible\)/);
  assert.doesNotMatch(css, /:focus-within/, 'a focus left by the mouse in the tree or on a button would keep a panel over the remote screen until a click elsewhere');
});

test('a tab can be panned with a finger, and the marks of a drag are not lost in forced colours', async () => {
  const css = await read('style.css');
  assert.doesNotMatch(css, /touch-action/, 'no tab takes the gesture of the finger away from the strip');
  const forced = css.match(/@media \(forced-colors:active\)\{(.*)\}\n/)?.[1] ?? '';
  for (const part of ['#tabs button.drop-before', '#tabs button.drop-after', '#tabs button[aria-current=true]']) assert.ok(forced.includes(part), `${part} is drawn with borders in forced colours (a shadow and a background are not drawn there)`);
  assert.match(forced, /Highlight/);
  const renderer = await read('renderer.ts');
  assert.match(renderer, /setAttribute\('aria-current','true'\)/, 'the tab in front says so, in words that do not depend on how it is painted');
  assert.match(renderer, /removeAttribute\('aria-current'\)/);
});

test('a drag that loses its end is over at the next thing that happens, and Escape cancels it', async () => {
  const source = await read('tabs-ui.ts');
  assert.match(source, /\(event\.buttons & 1\) === 0/, 'the pointer moves with no button held');
  assert.match(source, /document\.addEventListener\('lostpointercapture'/, 'the capture is lost, also when the tab that held it was closed');
  assert.match(source, /addEventListener\('pointercancel'/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(source, /nav\.addEventListener\('pointerdown', \(event\) => \{\n    end\(\);/, 'a new press starts from nothing');
  assert.match(source, /event\.ctrlKey \|\| !button/, 'Ctrl and a press is the right button on the Mac, not a drag');
  assert.match(source, /scrollIntoView\(/, 'a tab that was moved is in sight');
  assert.doesNotMatch(source, /live\.textContent = ''/, 'clearing and writing in the same turn says nothing to a screen reader');
});

test('a view that cannot be asked for is told in the page, as the settings that cannot be asked for are', async () => {
  const source = await read('shell-ui.ts');
  assert.match(source, /if \(view\?\.ok\) applyView\(view\); else say\(VIEW_UNREADABLE, true\);/);
});
