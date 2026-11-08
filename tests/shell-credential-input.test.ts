import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Electron default discovery runs credentials, documents and shell, leaving desktop separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rw-discovery-'));
  await Promise.all(['scripts', 'node_modules/electron', 'dist/tests'].map((p) => mkdir(join(root, p), { recursive: true })));
  await writeFile(join(root, 'scripts/test-electron.mjs'), await readFile(resolve('scripts/test-electron.mjs')));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'node_modules/electron/index.js'), `module.exports=${JSON.stringify(process.execPath)};`);
  for (const name of ['documents-proof', 'shell-proof', 'credentials-proof', 'desktop-proof']) {
    await writeFile(join(root, `dist/tests/${name}.test.js`), `import test from 'node:test';test('${name}',()=>{});`);
  }
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['scripts/test-electron.mjs'], { cwd: root, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /documents-proof/);
  assert.match(run.stdout, /shell-proof/);
  assert.match(run.stdout, /credentials-proof/);
  assert.doesNotMatch(run.stdout, /desktop-proof/);
});

import { requestCredentialInput, type CredentialInputEvent, type CredentialInputPublicRequest, type CredentialInputHost } from '../src/desktop/credentials-ipc.js';

function modal(label = 'Synthetic') {
  let sent!: CredentialInputPublicRequest;
  let submit!: (event: CredentialInputEvent, payload: unknown, generation: number) => void;
  let cancel!: (event?: CredentialInputEvent, payload?: unknown) => void;
  let timer!: () => void;
  let clear = 0; let close = 0; let removedTimer = 0; let now = 1000;
  const frame = {}; const event = { senderId: 8, origin: 'file:///trusted/credential-input.html', mainFrame: frame };
  const host: CredentialInputHost = {
    open: (value, onSubmit, onCancel) => { sent = value; submit = onSubmit; cancel = onCancel; return { ...event, clear: () => { clear++; }, close: () => { close++; } }; },
    now: () => now, randomNonce: () => 'a'.repeat(64), setTimer: (callback) => { timer = callback; return 7; }, clearTimer: () => { removedTimer++; },
  };
  const promise = requestCredentialInput({ binding: { promptId: 'prompt-a', generation: 3 }, label, purpose: 'edit', timeoutMs: 60000 }, host);
  const payload = (extra: Record<string, unknown> = {}) => ({ promptId: sent.promptId, generation: sent.generation, nonce: sent.nonce, username: 'administrator', domain: '', passwordAction: 'replace', password: 'input-canary', ...extra });
  return { promise, payload, submit: (...args: Parameters<typeof submit>) => submit(...args), cancel: (...args: Parameters<typeof cancel>) => cancel(...args), timer: () => timer(), advance: (milliseconds: number) => { now += milliseconds; }, event, sent: () => sent, counts: () => [clear, close, removedTimer] };
}

test('a maximum length endpoint is shown completely in the credential prompt',async()=>{
  const label='a'.repeat(253)+':65535';const h=modal(label);
  assert.equal(h.sent().label,label);h.cancel();assert.equal(await h.promise,undefined);
});

test('isolated input has no secret readback and consumes sender/frame/origin/nonce once', async () => {
  const h = modal();
  assert.deepEqual(Object.keys(h.sent()).sort(), ['expiresAt', 'generation', 'label', 'nonce', 'promptId', 'purpose']);
  for (const event of [{ ...h.event, senderId: 9 }, { ...h.event, mainFrame: {} }, { ...h.event, origin: 'file:///evil.html' }]) h.submit(event, h.payload(), 3);
  assert.deepEqual(h.counts(), [0, 0, 0]);
  h.submit(h.event, h.payload({ nonce: 'b'.repeat(64) }), 3);
  assert.deepEqual(h.counts(), [0, 0, 0]);
  h.submit(h.event, h.payload(), 3);
  assert.deepEqual(await h.promise, { username: 'administrator', domain: '', passwordAction: 'replace', password: 'input-canary' });
  h.submit(h.event, h.payload({ password: 'again' }), 3); h.cancel(); h.timer();
  assert.deepEqual(h.counts(), [1, 1, 1]);
});

test('cancel, timeout, malformed payload and stale generation clear pending input', async () => {
  for (const kind of ['cancel', 'timeout', 'stale', 'extra', 'oversized', 'keep-with-password', 'remove-with-password', 'bad-type']) {
    const h = modal();
    if (kind === 'cancel') h.cancel();
    else if (kind === 'timeout') h.timer();
    else h.submit(h.event, h.payload(kind === 'extra' ? { rawPath: '/private/canary' } : kind === 'oversized' ? { password: 'a'.repeat(65537) } : kind === 'keep-with-password' ? { passwordAction: 'keep' } : kind === 'remove-with-password' ? { passwordAction: 'remove' } : kind === 'bad-type' ? { username: {} } : {}), kind === 'stale' ? 4 : 3);
    assert.equal(await h.promise, undefined, kind); assert.deepEqual(h.counts(), [1, 1, 1], kind);
  }
  const h = modal(); h.cancel({ ...h.event, senderId: 999 }, h.payload()); assert.deepEqual(h.counts(), [0, 0, 0]); h.cancel(); await h.promise;
});

test('keep and remove are distinct, empty edit input never means removal', async () => {
  for (const passwordAction of ['keep', 'remove']) {
    const h = modal(); const payload: Record<string, unknown> = h.payload({ passwordAction }); delete payload.password;
    h.submit(h.event, payload, 3);
    assert.deepEqual(await h.promise, { username: 'administrator', domain: '', passwordAction });
  }
});

import { createContext, runInContext } from 'node:vm';

function inputPreload() {
  const listeners = new Map<string, Function>(); const sent: unknown[][] = []; let api: any;
  const context = createContext({ require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { api = value; } }, ipcRenderer: { once: (name: string, callback: Function) => { listeners.set(name, callback); }, on: (name: string, callback: Function) => { listeners.set(name, callback); }, send: (...args: unknown[]) => { sent.push(args); } } }) });
  return { listeners, sent, get api() { return api; }, context };
}

test('modal preload exposes only new input submit/cancel, binds request once and sends no readback', async () => {
  const source = await readFile(resolve('src/desktop/credential-input-preload.cjs'), 'utf8');
  const h = inputPreload(); runInContext(source, h.context);
  assert.deepEqual(Object.keys(h.api).sort(), ['cancel', 'onClear', 'onRequest', 'submit']);
  let request: any; h.api.onRequest((value: unknown) => { request = value; });
  h.listeners.get('credential-input:request')!({}, { promptId: 'one', generation: 2, nonce: 'a'.repeat(64), expiresAt: 999999, label: 'Synthetic', purpose: 'edit', password: 'stored-canary' });
  assert.equal(JSON.stringify(request).includes('stored-canary'), false);
  h.api.submit({ username: 'ops', domain: '', passwordAction: 'replace', password: 'new-canary' });
  h.api.submit({ username: 'evil', domain: '', passwordAction: 'replace', password: 'second' }); h.api.cancel();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0]![0], 'credential-input:submit');
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent[0]![1])), { promptId: 'one', generation: 2, nonce: 'a'.repeat(64), username: 'ops', domain: '', passwordAction: 'replace', password: 'new-canary' });
});

import { mountCredentialInput, type CredentialInputBridge } from '../src/desktop/credential-input.js';

test('input controller generates locally, submits once and clears on cancel/close', () => {
  const fields = new Map<string, any>();
  for (const id of ['input-form', 'username', 'domain', 'password', 'password-action', 'generate', 'length', 'lowercase', 'uppercase', 'digits', 'symbols', 'exclude-ambiguous', 'cancel', 'target', 'input-error']) {
    fields.set(id, { value: '', checked: ['lowercase', 'uppercase', 'digits', 'exclude-ambiguous'].includes(id), disabled: false, textContent: '', options: [{ disabled: false }], events: new Map(), addEventListener(name: string, handler: Function) { this.events.set(name, handler); } });
  }
  fields.get('length').value = '20';
  let request!: Parameters<CredentialInputBridge['onRequest']>[0]; let close!: () => void; const submitted: unknown[] = []; let cancelled = 0;
  mountCredentialInput({ getElementById: (id: string) => fields.get(id), defaultView: null } as unknown as Document, { onRequest: (callback) => { request = callback; }, onClear: (callback) => { close = callback; }, submit: (value) => submitted.push(value), cancel: () => { cancelled++; } });
  request({ promptId: 'p', generation: 1, nonce: 'a'.repeat(64), expiresAt: Date.now() + 1000, label: 'Synthetic', purpose: 'edit' });
  assert.equal(fields.get('password').value, ''); assert.equal(fields.get('password-action').value, 'keep');
  fields.get('generate').events.get('click')();
  assert.equal(fields.get('password').value.length, 20); assert.equal(submitted.length, 0);
  fields.get('username').value = 'ops';
  fields.get('input-form').events.get('submit')({ preventDefault() {} });
  assert.equal(submitted.length, 1); assert.equal((submitted[0] as any).password.length, 20); assert.equal(fields.get('password').value, '');
  fields.get('input-form').events.get('submit')({ preventDefault() {} }); assert.equal(submitted.length, 1);
  fields.get('password').value = 'must-clear'; close(); assert.equal(fields.get('password').value, '');
  fields.get('cancel').events.get('click')(); assert.equal(cancelled, 0, 'already consumed input cannot send again');
});


test('expired input and incompatible prompt identities never submit', async () => {
  const h = modal();
  h.submit(h.event, h.payload({ promptId: 'foreign' }), 3);
  h.submit(h.event, h.payload({ generation: 4 }), 3);
  assert.deepEqual(h.counts(), [0, 0, 0]);
  h.advance(60000); h.submit(h.event, h.payload(), 3);
  assert.equal(await h.promise, undefined); assert.deepEqual(h.counts(), [1, 1, 1]);
});

 test('extended isolated input accepts new TOTP/key actions but never stored readback',async()=>{
 const h=modal();const totp={secretBase32:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',algorithm:'sha1',digits:6,period:30};h.submit(h.event,h.payload({totpAction:'replace',totp,privateKeyAction:'replace',privateKey:{mode:'path',path:'/synthetic/key'},passphraseAction:'replace',passphrase:'new-key-pass'}),3);assert.deepEqual(await h.promise,{username:'administrator',domain:'',passwordAction:'replace',password:'input-canary',totpAction:'replace',totp,privateKeyAction:'replace',privateKey:{mode:'path',path:'/synthetic/key'},passphraseAction:'replace',passphrase:'new-key-pass'});
 });
 test('invalid TOTP seed, secret with keep, malformed key and hidden extras are refused',async()=>{for(const extra of [{totpAction:'replace',totp:{secretBase32:'bad'}},{totpAction:'keep',totp:{secretBase32:'STORED'}},{privateKeyAction:'replace',privateKey:{mode:'embedded',base64:'!!'}},{passphraseAction:'keep',passphrase:'stored'}]){const h=modal();h.submit(h.event,h.payload(extra),3);assert.equal(await h.promise,undefined);}});
