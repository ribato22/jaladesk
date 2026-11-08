import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../../src/desktop/', import.meta.url));
const code = async (name: string) => (await readFile(join(desktop, name), 'utf8')).split('\n').filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');   // a comment may say what is not done

// shell-csp.test.ts bans the ways of writing markup that were known when it was written; the browser has more of them (and more arrive), and the code of the shell builds a lot of the page.
test('the code of the window does not turn a string into markup or into a document by any way: not the ones that shell-csp.test.ts names, and not the newer ones', async () => {
  const banned = ['setHTMLUnsafe', 'parseHTMLUnsafe', 'createContextualFragment', 'DOMParser', 'parseFromString', 'srcdoc', 'execCommand', ['document', 'writeln'].join('.')];
  const files = (await readdir(desktop)).filter((name) => /\.(ts|js|cjs)$/.test(name));      // the code of the window and of the windows that ask for a password, and the bridges
  assert.ok(files.includes('shell-ui.ts') && files.includes('documents-ui.ts') && files.includes('password.js') && files.includes('preload.cjs'), 'the code of the window is among them');
  for (const name of files) {
    const source = await code(name);
    for (const token of banned) assert.equal(source.includes(token), false, `${name} does not use ${token}`);
  }
});

test('the code of the shell that builds the page builds it with elements and text: every label, title and word it shows is set as text or as a property, and nothing is styled inline', async () => {
  const source = await code('shell-ui.ts');
  assert.ok((source.match(/createElement\(/g) ?? []).length >= 8, 'it makes its own elements');
  assert.ok((source.match(/textContent =/g) ?? []).length >= 8, 'and sets their words as text');
  assert.equal(new RegExp('\\.(inner|outer)' + 'HTML\\b').test(source), false, 'no markup from a string');
  assert.equal(/\.style\b/.test(source), false, 'no inline style: the policy of the page forbids it, and a class is the way');
});
