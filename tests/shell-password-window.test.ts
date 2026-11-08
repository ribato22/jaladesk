import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The window that asks for the password of a document offers, since 02-B3b, to keep its key in the keystore of the system. These tests read the three files of that window (the page, its script and its bridge);
// that the choice reaches the main process, and what the main process then does, is checked with the real window by the scenarios and with the channels by shell-documents-ipc-keys.test.ts.
const read = (name: string) => readFile(fileURLToPath(new URL(`../../src/desktop/${name}`, import.meta.url)), 'utf8');

test('the page has a box to remember the key that is hidden until the main process offers it and is not ticked until the person ticks it', async () => {
  const html = await read('password.html');
  assert.match(html, /<label class="check" id="remember-row" hidden><input id="remember" type="checkbox" aria-describedby="remember-note">[^<]+<\/label>/, 'and the note that says what ticking it does is what a screen reader reads with it');
  assert.doesNotMatch(html, /id="remember"[^>]*checked/, 'never ticked for the person');
  assert.match(html, /<p id="remember-note" class="hint" hidden>/);
  assert.equal([...html.matchAll(/\bid="remember"/g)].length, 1);
});

test('the script shows the box only when the request offers it, sends the choice with the password, and ticks nothing again after it', async () => {
  const js = await read('password.js');
  assert.match(js, /field\('#remember-row'\)\.hidden = value\.rememberable !== true;/);
  assert.match(js, /window\.password\.submit\(\{password, confirm, remember: request\.rememberable === true && field\('#remember'\)\.checked\}\);/);
  assert.match(js, /field\('#remember'\)\.checked = false;/);
});

test('a prompt that comes again after a wrong password shows the box as the person left it', async () => {
  const js = await read('password.js');
  assert.match(js, /field\('#remember'\)\.checked = value\.rememberable === true && value\.remember === true;/);
});

test('the bridge lets the offer through as a yes or no and nothing else', async () => {
  const bridge = await read('password-preload.cjs');
  assert.match(bridge, /rememberable:value\?\.rememberable===true,remember:value\?\.remember===true\}/);
  assert.match(bridge, /submit:value=>ipcRenderer\.send\('password:submit',value\)/);
});
