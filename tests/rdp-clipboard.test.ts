import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIPBOARD_MAX_BYTES, decodeClipboard, describeClipboard, encodeClipboard, makeClipboardGate, type ClipboardResult } from '../src/protocols/rdp/clipboard.js';
import type { Clipboard } from '../src/protocols/rdp/wire.js';

test('text survives the base64 transport byte for byte', () => {
  const sample = '\ufeffhalo — 你好 😀\nbaris dua\r\nbaris tiga';
  assert.equal(decodeClipboard(encodeClipboard(sample)), sample);
  assert.equal(encodeClipboard('abc'), 'YWJj');
  assert.equal(decodeClipboard(''), '');
});
test('oversized or malformed text is rejected instead of truncated', () => {
  const max = 'a'.repeat(CLIPBOARD_MAX_BYTES);
  assert.equal(decodeClipboard(encodeClipboard(max)), max);
  assert.throws(() => encodeClipboard(max + 'a'), /too-large/);
  const wide = 'é'.repeat(CLIPBOARD_MAX_BYTES / 2);
  assert.equal(decodeClipboard(encodeClipboard(wide)), wide);
  assert.throws(() => encodeClipboard(wide + 'é'), /too-large/);
  assert.throws(() => encodeClipboard('ab\0c'), /invalid/);
  assert.throws(() => encodeClipboard('x\ud800y'), /invalid/);
  for (const bad of ['@@@@', 'YWJj\n', 'YWJ', 'YW=j', 'Y===', ' YWJj', 'YWK='])
    assert.throws(() => decodeClipboard(bad), /invalid/, bad);
  assert.throws(() => decodeClipboard(Buffer.from([0xff, 0xfe]).toString('base64')), /invalid/);
  assert.throws(() => decodeClipboard(Buffer.from('a\0b').toString('base64')), /invalid/);
  assert.throws(() => decodeClipboard(Buffer.alloc(CLIPBOARD_MAX_BYTES + 1, 97).toString('base64')), /too-large/);
});

// Electron 44's clipboard module is promise based, so the fake is too.
function fakeOs(initial = '') {
  let value = initial, reads = 0;const writes: string[] = [];
  return {
    readText: async () => { reads++; return value; }, writeText: async (text: string) => { value = text; writes.push(text); },
    set: (text: string) => { value = text; }, writes, reads: () => reads
  };
}
function fakeSession(clipboard: Clipboard = { toRemote: true, fromRemote: true }, result: ClipboardResult = 'sent') {
  const sent: string[] = [];
  return { clipboard, sent, sendClipboard: (text: string) => { sent.push(text); return result; } };
}
test('only the active session may write the local clipboard and its own text is not echoed back', async () => {
  const os = fakeOs(), gate = makeClipboardGate(os), a = fakeSession();
  assert.equal(await gate.remote('a', 'belum aktif'), false);
  assert.deepEqual(os.writes, []);
  gate.activate('a');
  assert.equal(await gate.remote('a', 'dari a'), true);
  assert.equal(await gate.remote('b', 'dari b'), false);
  assert.deepEqual(os.writes, ['dari a']);
  assert.equal(await gate.local('a', a), 'unchanged');
  assert.deepEqual(a.sent, []);
});
test('local text is read once per change, skipped when empty, and forgotten with the session', async () => {
  const os = fakeOs(), gate = makeClipboardGate(os), a = fakeSession();
  assert.equal(await gate.local('a', a), 'empty');
  os.set('satu');
  assert.equal(await gate.local('a', a), 'sent');
  assert.equal(await gate.local('a', a), 'unchanged');
  os.set('dua');
  assert.equal(await gate.local('a', a), 'sent');
  assert.deepEqual(a.sent, ['satu', 'dua']);
  gate.forget('a');
  const again = fakeSession();
  assert.equal(await gate.local('a', again), 'sent');
  assert.deepEqual(again.sent, ['dua']);
});
test('a direction that is off never reads the local clipboard, and a refusal is reported once per text', async () => {
  const os = fakeOs('rahasia'), gate = makeClipboardGate(os);
  assert.equal(await gate.local('a', fakeSession({ toRemote: false, fromRemote: true })), 'disabled');
  assert.equal(os.reads(), 0);
  const big = fakeSession(undefined, 'too-large');
  assert.equal(await gate.local('b', big), 'too-large');
  assert.equal(await gate.local('b', big), 'unchanged');
  assert.equal(big.sent.length, 1);
});
test('a forgotten session can no longer write the clipboard, and a failed write is not remembered', async () => {
  const os = fakeOs(), gate = makeClipboardGate(os);
  gate.activate('a'); gate.forget('a');
  assert.equal(await gate.remote('a', 'terlambat'), false);
  assert.deepEqual(os.writes, []);
  const broken = { readText: async () => 'x', writeText: async () => { throw new Error('ditolak OS'); } }, g = makeClipboardGate(broken);
  g.activate('a');
  await assert.rejects(g.remote('a', 'x'), /ditolak/);
  assert.equal(await g.local('a', fakeSession()), 'sent');
});
test('a closed session is not remembered, so a later live one still receives the text', async () => {
  const os = fakeOs('teks'), gate = makeClipboardGate(os);
  assert.equal(await gate.local('a', fakeSession(undefined, 'closed')), 'closed');
  const live = fakeSession();
  assert.equal(await gate.local('a', live), 'sent');
  assert.deepEqual(live.sent, ['teks']);
});
test('remote text is written only while the application window has focus', async () => {
  const os = fakeOs();let focused = false;
  const gate = makeClipboardGate(os, () => focused);gate.activate('a');
  assert.equal(await gate.remote('a', 'di latar'), false);
  assert.deepEqual(os.writes, []);
  focused = true;
  assert.equal(await gate.remote('a', 'di depan'), true);
  assert.deepEqual(os.writes, ['di depan']);
});
test('the password prompt states which clipboard directions the session will share', () => {
  assert.equal(describeClipboard(undefined), 'Clipboard: nonaktif');
  assert.equal(describeClipboard({ toRemote: false, fromRemote: false }), 'Clipboard: nonaktif');
  assert.equal(describeClipboard({ toRemote: true, fromRemote: false }), 'Clipboard teks: lokal → remote');
  assert.equal(describeClipboard({ toRemote: false, fromRemote: true }), 'Clipboard teks: remote → lokal');
  assert.equal(describeClipboard({ toRemote: true, fromRemote: true }), 'Clipboard teks: remote → lokal dan lokal → remote');
});
