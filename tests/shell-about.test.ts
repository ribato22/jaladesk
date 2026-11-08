import assert from 'node:assert/strict';
import test from 'node:test';
import { aboutNotice, platformName } from '../src/desktop/about.js';

const INFO = { name: 'Remote Workspace RDP', version: '0.1.0', electron: '44.7.2', chrome: '140.0.7339.0', node: '24.1.0', platform: 'darwin', arch: 'arm64' };

test('the dialog About says what the application is and what it runs on, in one place, as plain data', () => {
  const notice = aboutNotice(INFO);
  assert.equal(notice.type, 'info');
  assert.equal(notice.message, 'Tentang Remote Workspace RDP');
  assert.deepEqual(notice.detail.split('\n'), ['Versi 0.1.0', 'Electron 44.7.2 · Chromium 140.0.7339.0 · Node.js 24.1.0', 'macOS arm64']);
  assert.deepEqual(notice.buttons, ['Tutup']);
  assert.equal(notice.defaultId, 0);
  assert.equal(notice.cancelId, 0);
});

test('the platforms are called by their names, and one that is not known is told as it is', () => {
  assert.equal(platformName('darwin'), 'macOS');
  assert.equal(platformName('win32'), 'Windows');
  assert.equal(platformName('linux'), 'Linux');
  assert.equal(platformName('freebsd'), 'freebsd');
  for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(platformName(inherited), inherited, `${inherited} is not a platform`);
  assert.equal(aboutNotice({ ...INFO, platform: 'win32', arch: 'x64' }).detail.split('\n')[2], 'Windows x64');
});

test('nothing in the dialog is made from something that could add lines or markup: only the fields of the process, each on its own line', () => {
  const notice = aboutNotice({ ...INFO, version: '1.0.0\nhttps://example.invalid' });
  assert.equal(notice.detail.split('\n').length, 3, 'a line break in a field is made into a space');
  assert.equal(notice.detail.split('\n')[0], 'Versi 1.0.0 https://example.invalid', 'the field stays on its own line');
  assert.equal(aboutNotice({ ...INFO, name: '  Remote   Workspace ' }).message, 'Tentang Remote Workspace');
  // every field, not only the first two: the versions of Electron, Chromium and Node, the platform and the architecture all come from the process
  for (const field of ['electron', 'chrome', 'node', 'platform', 'arch'] as const) {
    const lines = aboutNotice({ ...INFO, [field]: `a\nb\r\nc` }).detail.split('\n');
    assert.equal(lines.length, 3, `${field}: a line break is made into a space`);
    assert.ok(lines.some((line) => line.includes('a b c')), `${field}: the field stays on its own line, with its words kept`);
  }
});
