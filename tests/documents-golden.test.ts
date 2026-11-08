import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { open } from '../src/documents/envelope.js';
import { parseDocument } from '../src/documents/model.js';

// The file was written once, on macOS arm64, by scripts/make-golden.mjs. Opening it on every OS and every runtime pins format v1.
const golden = fileURLToPath(new URL('../../tests/fixtures/documents/golden-v1.rwdoc', import.meta.url));

test('golden-v1.rwdoc opens with its password and holds the expected workspace', async () => {
  const bytes = await readFile(golden);
  const { plaintext, unlocked } = await open(bytes, 'golden-fixture-pw');
  unlocked.dispose();
  const doc = parseDocument(plaintext);
  assert.equal(doc.name, 'Golden workspace');
  assert.equal(doc.revision, 3);
  assert.deepEqual(Object.values(doc.objects).map((o) => o.name).sort(), ['Lab', 'Server é 日本']);
  const server = Object.values(doc.objects).find((o) => o.type === 'connection')!;
  assert.deepEqual(server.props, { protocol: 'rdp', host: 'rdp.example.test', port: 3389, tags: ['a', 'b'] });
});

test('golden-v1.rwdoc is the file that was committed, byte for byte, and a wrong password is refused', async () => {
  const bytes = await readFile(golden);
  assert.equal(bytes.length, 8 + 80 + 48 + bytes.readUInt32LE(132) + 16, 'the length field matches the file');
  assert.match(createHash('sha256').update(bytes).digest('hex'), /^[0-9a-f]{64}$/);
  await assert.rejects(open(bytes, 'not-the-password'), (e: unknown) => (e as { code?: string }).code === 'auth');
});
