// Cross-OS check, reading side: opens a file written by make-crossos-file.mjs on another OS and verifies what it holds.
// Needs `npm run build` first. Usage: node scripts/check-crossos-file.mjs <file> <platform-that-wrote-it>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open } from '../dist/src/documents/envelope.js';
import { parseDocument } from '../dist/src/documents/model.js';

const [path, platform] = process.argv.slice(2);
if (!path || !platform) { console.error('usage: node scripts/check-crossos-file.mjs <file> <platform>'); process.exit(2); }
const bytes = readFileSync(path);
const { plaintext, unlocked } = await open(bytes, 'crossos-fixture-pw');
unlocked.dispose();
const doc = parseDocument(plaintext);
const names = Object.values(doc.objects).map((o) => o.name).sort();
const ok = doc.name === `Made on ${platform}` && names.join('|') === ['Cross-OS folder', 'Server é 日本'].sort().join('|');
console.log(JSON.stringify({ ok, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), name: doc.name, names }));
process.exit(ok ? 0 : 1);
