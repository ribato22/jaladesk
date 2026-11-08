// Writes tests/fixtures/documents/golden-v1.rwdoc: a small workspace sealed with the synthetic password below at the lowest KDF cost.
// Run it ONCE per format version on one machine (npm run build first); the committed file then pins "format v1 stays readable" on every OS.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seal } from '../dist/src/documents/envelope.js';
import { serializeDocument } from '../dist/src/documents/model.js';

const target = fileURLToPath(new URL('../tests/fixtures/documents/golden-v1.rwdoc', import.meta.url));
if (existsSync(target)) { console.error('golden-v1.rwdoc exists; a format change needs a new golden file, not a new golden-v1'); process.exit(1); }
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const doc = {
  schemaVersion: 1, id: id(900), kind: 'workspace', name: 'Golden workspace', revision: 3,
  objects: {
    [id(1)]: { id: id(1), type: 'folder', name: 'Lab', parentId: null, order: 0, props: {} },
    [id(2)]: { id: id(2), type: 'connection', name: 'Server é 日本', parentId: id(1), order: 0, props: { protocol: 'rdp', host: 'rdp.example.test', port: 3389, tags: ['a', 'b'] } },
  },
};
const { file, unlocked } = await seal(serializeDocument(doc), 'golden-fixture-pw', { kdf: { logN: 14, r: 8, p: 1 } });
unlocked.dispose();
mkdirSync(new URL('../tests/fixtures/documents/', import.meta.url), { recursive: true });
writeFileSync(target, file);
console.log(`wrote ${target} (${file.length} bytes)`);
