// Cross-OS check, writing side: seals a synthetic document on THIS OS (the lowest KDF cost, a synthetic password) and writes
// <base>.rwdoc and <base>.rwdoc.b64 into the current directory, then prints its size and SHA-256. The other OS opens the file with
// scripts/check-crossos-file.mjs. Needs `npm run build` first. Usage: node scripts/make-crossos-file.mjs [base]   (default: crossos-<platform>)
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { seal } from '../dist/src/documents/envelope.js';
import { serializeDocument } from '../dist/src/documents/model.js';

const base = process.argv[2] ?? `crossos-${process.platform}`;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const doc = {
  schemaVersion: 1, id: id(901), kind: 'workspace', name: `Made on ${process.platform}`, revision: 1,
  objects: {
    [id(1)]: { id: id(1), type: 'folder', name: 'Cross-OS folder', parentId: null, order: 0, props: {} },
    [id(2)]: { id: id(2), type: 'connection', name: 'Server é 日本', parentId: id(1), order: 0, props: { protocol: 'rdp', host: 'crossos.example.test', port: 3389 } },
  },
};
const { file, unlocked } = await seal(serializeDocument(doc), 'crossos-fixture-pw', { kdf: { logN: 14, r: 8, p: 1 } });
unlocked.dispose();
writeFileSync(`${base}.rwdoc`, file);
writeFileSync(`${base}.rwdoc.b64`, file.toString('base64'));
console.log(JSON.stringify({ platform: process.platform, file: `${base}.rwdoc`, bytes: file.length, sha256: createHash('sha256').update(file).digest('hex') }));
