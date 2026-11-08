import assert from 'node:assert/strict';
import test from 'node:test';
import type { SettingsView } from '../src/desktop/settings-ipc.js';
import { describeSettings } from '../src/desktop/settings-model.js';

const view = (over: Partial<{ keys: SettingsView['keys']; recent: SettingsView['recent']; theme: SettingsView['theme'] }> = {}): SettingsView =>
  ({ ok: true, theme: 'system', toolbar: { visible: true }, tabs: { colorize: true }, fullscreen: { extended: false }, keys: { allow: false, usable: null, count: 0 }, recent: { count: 0 }, ...over });

test('what the controls of the window of the settings show is what the settings are, each one its own: no two of them hold the same value in both of two states', () => {
  // toolbar true/true, colours true/false, full screen false/true, keys false/false: four different patterns, so a control shown from the wrong setting is a different page in one of the states
  const a = describeSettings({ ...view(), theme: 'dark', toolbar: { visible: true }, tabs: { colorize: true }, fullscreen: { extended: false }, keys: { allow: false, usable: null, count: 0 } });
  assert.deepEqual([a.theme, a.toolbar, a.colorize, a.extended, a.keysAllow], ['dark', true, true, false, false]);
  const b = describeSettings({ ...view(), theme: 'light', toolbar: { visible: true }, tabs: { colorize: false }, fullscreen: { extended: true }, keys: { allow: false, usable: null, count: 0 } });
  assert.deepEqual([b.theme, b.toolbar, b.colorize, b.extended, b.keysAllow], ['light', true, false, true, false]);
  const c = describeSettings({ ...view(), toolbar: { visible: false }, tabs: { colorize: false }, fullscreen: { extended: false }, keys: { allow: true, usable: true, count: 2 } });
  assert.deepEqual([c.theme, c.toolbar, c.colorize, c.extended, c.keysAllow], ['system', false, false, false, true]);
});

test('the words about the keys say what the setting does while it is off, where the keys are kept while it is on, and that the keystore is missing when it is: the sentences are pinned, they are a promise to the person', () => {
  const OFF = 'Bila dinyalakan, jendela sandi menawarkan untuk mengingat kunci dokumen di komputer ini, dan dokumen itu kemudian dibuka tanpa sandi. Sandinya sendiri tidak pernah disimpan.';
  const ON = 'Kunci disimpan oleh keystore sistem (Keychain di macOS, DPAPI di Windows) dan hanya berlaku di komputer ini. Berkas dokumen tetap hanya dapat dibuka dengan sandi di tempat lain.';
  const MISSING = 'Keystore sistem tidak tersedia di komputer ini; kunci tidak diingat sampai keystore itu tersedia.';
  assert.equal(describeSettings(view()).keysNote, OFF);
  assert.equal(describeSettings(view({ keys: { allow: true, usable: true, count: 0 } })).keysNote, ON);
  assert.equal(describeSettings(view({ keys: { allow: true, usable: false, count: 0 } })).keysNote, MISSING);
  // the main process never leaves `usable` unknown while the keys are allowed (it asks the keystore then); if it ever did, the window must not promise what it does not know
  assert.equal(describeSettings(view({ keys: { allow: true, usable: null, count: 0 } })).keysNote, MISSING);
});

test('how many keys are remembered is told in words, and forgetting them can be asked only if there are some', () => {
  const words = (count: number) => describeSettings(view({ keys: { allow: false, usable: null, count } }));
  assert.equal(words(0).keysCount, 'Tidak ada kunci yang diingat.');
  assert.equal(words(1).keysCount, '1 kunci diingat.');
  assert.equal(words(12).keysCount, '12 kunci diingat.');
  assert.deepEqual([words(0).canForget, words(1).canForget, words(12).canForget], [false, true, true]);
});

test('how many documents are in the list of recent documents is told in words, and clearing it can be asked only if there are some', () => {
  const words = (count: number) => describeSettings(view({ recent: { count } }));
  assert.equal(words(0).recentCount, 'Daftar terbaru kosong.');
  assert.equal(words(1).recentCount, '1 dokumen di daftar terbaru.');
  assert.equal(words(10).recentCount, '10 dokumen di daftar terbaru.');
  assert.deepEqual([words(0).canClear, words(1).canClear], [false, true]);
});
