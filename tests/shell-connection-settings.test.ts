import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObjectNode } from '../src/documents/model.js';
import { DEFAULT_RDP, checkSettings, checkStored, fromProps, requestFor, toProps, withSettings, type RdpSettings } from '../src/desktop/connection-settings.js';

const good: RdpSettings = { host: 'win-lab.example', port: 3389, username: 'ops', certificateSha256: 'A'.repeat(64), clipboardToRemote: true, clipboardFromRemote: false };
const stored = (props: ObjectNode['props'], over: Partial<ObjectNode> = {}): ObjectNode =>
  ({ id: '00000000-0000-4000-8000-000000000001', type: 'connection', name: 'Win lab', parentId: null, order: 0, props, ...over });

test('valid settings have no problems; each wrong field is named, and one wrong field does not hide another', () => {
  assert.deepEqual(checkSettings(good), []);
  assert.deepEqual(checkSettings({ ...DEFAULT_RDP, host: 'h', username: 'u' }), []);
  assert.deepEqual(checkSettings({ ...good, host: '' }).map((p) => p.field), ['host']);
  assert.deepEqual(checkSettings({ ...good, host: 'has space' }).map((p) => p.field), ['host']);
  assert.deepEqual(checkSettings({ ...good, port: 0 }).map((p) => p.field), ['port']);
  assert.deepEqual(checkSettings({ ...good, port: 70000 }).map((p) => p.field), ['port']);
  assert.deepEqual(checkSettings({ ...good, port: 3389.5 }).map((p) => p.field), ['port']);
  assert.deepEqual(checkSettings({ ...good, username: '' }).map((p) => p.field), ['username']);
  assert.deepEqual(checkSettings({ ...good, certificateSha256: 'xyz' }).map((p) => p.field), ['certificateSha256']);
  assert.deepEqual(checkSettings({ ...good, certificateSha256: '' }), [], 'the pin is optional');
  assert.deepEqual(checkSettings({ ...good, host: '', port: 0, username: '', certificateSha256: 'q' }).map((p) => p.field).sort(), ['certificateSha256', 'host', 'port', 'username']);
  assert.ok(checkSettings({ ...good, host: '' })[0]!.message.length > 5);
});

test('toProps stores one flat property per setting, leaves the pin out when empty, and fromProps reads it back', () => {
  assert.deepEqual(toProps(good), { protocol: 'rdp', host: 'win-lab.example', port: 3389, username: 'ops', certificateSha256: 'a'.repeat(64), clipboardToRemote: true, clipboardFromRemote: false });
  assert.equal('certificateSha256' in toProps({ ...good, certificateSha256: '' }), false);
  assert.deepEqual(fromProps(toProps(good)), { ...good, certificateSha256: 'a'.repeat(64) }, 'the pin is kept in lower case');
  assert.deepEqual(fromProps({}), DEFAULT_RDP);
  assert.deepEqual(fromProps({ host: 5, port: '3389', username: null, clipboardToRemote: 'yes' } as never), DEFAULT_RDP, 'values of the wrong type fall back to the defaults');
});

test('a stored RDP connection becomes the request the engine takes, named after the object', () => {
  const result = requestFor(stored(toProps(good)));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.request, { host: 'win-lab.example', port: 3389, username: 'ops', certificateSha256: 'a'.repeat(64), clipboard: { toRemote: true, fromRemote: false } });
  assert.equal(result.label, 'Win lab');
});

test('anything else, or settings that do not validate, is refused with the reasons', () => {
  const folder = requestFor(stored({}, { type: 'folder' }));
  assert.equal(folder.ok, false);
  const ssh = requestFor(stored({ protocol: 'ssh', host: 'h', port: 22, username: 'u' }));
  assert.deepEqual(ssh.ok ? [] : ssh.problems.map((p) => p.field), ['protocol']);
  const broken = requestFor(stored({ protocol: 'rdp', host: '', port: 99999, username: 'u' }));
  assert.deepEqual(broken.ok ? [] : broken.problems.map((p) => p.field).sort(), ['host', 'port']);
  const unset = requestFor(stored({}));
  assert.equal(unset.ok, false, 'a connection with nothing filled in yet cannot be opened');
});

test('a stored value of the wrong type is a problem, never a silent default (a port stored as text must not open port 3389)', () => {
  assert.deepEqual(checkStored(toProps(good)), []);
  assert.deepEqual(checkStored({ ...toProps(good), port: '3390' }).map((p) => p.field), ['port']);
  assert.deepEqual(checkStored({ ...toProps(good), host: 5, clipboardToRemote: 'yes' }).map((p) => p.field).sort(), ['clipboardToRemote', 'host']);
  assert.deepEqual(checkStored({ ...toProps(good), protocol: 'ssh' }).map((p) => p.field), ['protocol']);
  assert.deepEqual(checkStored({ protocol: 'rdp', host: 'h', username: 'u' }), [], 'settings that are absent take their defaults');
  const text = requestFor(stored({ ...toProps(good), port: '3390' }));
  assert.deepEqual(text.ok ? [] : text.problems.map((p) => p.field), ['port']);
});

test('applying the dialog\'s settings keeps properties it does not know and removes a pin that was cleared', () => {
  const before = { ...toProps(good), notes: 'keep me', futureSetting: { depth: [1, 2] } };
  const after = withSettings(before, { ...good, certificateSha256: '', port: 3390 });
  assert.equal('certificateSha256' in after, false);
  assert.deepEqual([after.port, after.notes, after.futureSetting], [3390, 'keep me', { depth: [1, 2] }]);
  assert.deepEqual(withSettings({}, good), toProps(good));
});

test('a pin stored in capitals is read and sent in lower case, and a folder is never opened even when it carries connection settings', () => {
  assert.equal(fromProps({ ...toProps(good), certificateSha256: 'AB'.repeat(32) }).certificateSha256, 'ab'.repeat(32));
  const upper = requestFor(stored({ ...toProps(good), certificateSha256: 'AB'.repeat(32) }));
  assert.equal(upper.ok && upper.request.certificateSha256, 'ab'.repeat(32));
  assert.equal(requestFor(stored(toProps(good), { type: 'folder' })).ok, false);
});
