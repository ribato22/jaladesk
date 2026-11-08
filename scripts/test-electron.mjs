// Runs the compiled tests under the Electron that ships the app (its embedded Node and BoringSSL), because the document format depends on
// crypto that differs from the Node that runs `npm test` (no Argon2id or ChaCha20 there). Windows shells do not expand globs, so the files
// are listed here. Usage: node scripts/test-electron.mjs [file-name-fragment ...]   (default: documents-, shell- and credentials-)
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron'); // in plain Node the package exports the path of the binary
const dir = fileURLToPath(new URL('../dist/tests/', import.meta.url));
const fragments = process.argv.length > 2 ? process.argv.slice(2) : ['documents-', 'shell-', 'credentials-'];
const files = readdirSync(dir).filter((name) => name.endsWith('.test.js') && fragments.some((fragment) => name.includes(fragment))).map((name) => dir + name);
if (files.length === 0) { console.error(`no compiled test matches "${fragments.join('", "')}"; run npm run build first`); process.exit(1); }
const result = spawnSync(electron, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
process.exit(result.status ?? 1);
