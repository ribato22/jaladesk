import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../../src/desktop/', import.meta.url));
const page = async () => readFile(join(desktop, 'index.html'), 'utf8');

test('the page asks for the content security policy it was built with, and for nothing looser: scripts and styles only from its own files', async () => {
  const policy = (await page()).match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)?.[1];
  assert.equal(policy, "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:");
  assert.equal(policy!.includes('unsafe'), false, 'neither unsafe-inline nor unsafe-eval');
});

test('what the policy forbids is not in the page: no inline script, no style element, no style attribute, no event attribute', async () => {
  const html = await page();
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, attributes, body] of scripts) assert.ok(/\bsrc="[^"]+"/.test(attributes!) && body!.trim() === '', `a script from a file only: ${attributes}`);
  assert.equal(/<style\b/i.test(html), false, 'no style element');
  assert.equal(/\sstyle\s*=/i.test(html), false, 'no style attribute');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'no event attribute');
});

test('the code of the window does not write markup or inline style: no innerHTML, outerHTML, insertAdjacentHTML, document.write, cssText or style attribute', async () => {
  const banned = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'cssText', "setAttribute('style'", 'setAttribute("style"'];
  const files = (await readdir(desktop)).filter((name) => name.endsWith('.ts'));
  assert.ok(files.includes('documents-ui.ts') && files.includes('tree-view.ts'), 'the code of the window is among them');
  for (const name of files) {
    const source = (await readFile(join(desktop, name), 'utf8')).split('\n').filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');   // a comment may say what is not done
    for (const token of banned) assert.equal(source.includes(token), false, `${name} does not use ${token}`);
  }
});
