import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/probe-crypto.mjs', import.meta.url));
const electron = createRequire(import.meta.url)('electron') as string; // in plain Node the package exports the path of the binary
type Probe = { node: string; electron: string | null; required: Record<string, boolean>; optional: Record<string, boolean> };
const run = (command: string, env: NodeJS.ProcessEnv): Probe => {
  const result = spawnSync(command, [script], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `probe failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').pop()!) as Probe;
};

test('every primitive the document format needs exists in the Node that runs the tests', () => {
  const probe = run(process.execPath, {});
  assert.ok(Object.values(probe.required).every(Boolean));
});

test('every primitive the document format needs exists in the Electron that ships the app (its Argon2id and ChaCha20 are not required)', () => {
  const probe = run(electron, { ELECTRON_RUN_AS_NODE: '1' });
  assert.ok(probe.electron, 'this run must be inside Electron');
  assert.ok(Object.values(probe.required).every(Boolean));
});
