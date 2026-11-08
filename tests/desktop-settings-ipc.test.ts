import assert from 'node:assert/strict';
import test from 'node:test';
import { Recent } from '../src/desktop/recent.js';
import { Settings, SettingsError } from '../src/desktop/settings.js';
import { registerSettingsIpc, type SettingsKeystore } from '../src/desktop/settings-ipc.js';

// The channels of the window of the settings. It asks for the settings and changes them one at a time, forgets the keys that are remembered (after a question the main process asks) and clears the list of recent documents.
// The keystore of the system is never used here: it is a stand-in that says whether it is there and how many keys it holds.
type Handler = (event: unknown, payload?: unknown) => Promise<any>;
function fixture(options: { keystore?: boolean; recent?: boolean; available?: boolean; keys?: number; settings?: Settings; confirm?: boolean; forgetThrows?: boolean; availableThrows?: boolean; countThrows?: boolean; clearFails?: boolean; countWaits?: Promise<unknown> } = {}) {
  const handlers = new Map<string, Handler>(), listeners = new Map<string, unknown>();
  const reported: unknown[] = [], asked: number[] = [];
  const state = { allow: false, available: options.available ?? true, keys: options.keys ?? 0, availableAsked: 0 };
  const settings = options.settings ?? Settings.memory();
  const recent = Recent.memory();
  const keystore: SettingsKeystore = {
    available: () => { state.availableAsked++; if (options.availableThrows) throw new Error('the keystore fell over'); return state.available; },
    count: async () => { await options.countWaits; if (options.countThrows) throw new Error('the folder cannot be read'); return state.keys; },
    forgetAll: async () => { if (options.forgetThrows) throw new Error('could not delete'); const n = state.keys; state.keys = 0; return n; },
  };
  let allow = true;
  const api = registerSettingsIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, async (event, payload) => handler(event, payload)); }, on: (channel, listener) => { listeners.set(channel, listener); } },
    check: () => { if (!allow) throw new Error('Access denied'); },
    settings, ...(options.keystore === false ? {} : { keystore }), ...(options.recent === false ? {} : { recent: options.clearFails ? { list: () => recent.list(), clear: async () => { await recent.clear(); return false; } } : recent }),
    confirmForget: async (count) => { asked.push(count); return options.confirm ?? true; },
    report: (error) => { reported.push(error); },
  });
  return { handlers, listeners, reported, asked, state, settings, recent, api, deny: () => { allow = false; }, call: (channel: string, payload?: unknown) => handlers.get(channel)!({}, payload) };
}

test('the window of the settings has four channels and listens on none', () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()].sort(), ['settings:clear-recent', 'settings:forget-keys', 'settings:get', 'settings:set']);
  assert.deepEqual([...f.listeners.keys()], []);
  const bare = fixture({ keystore: false, recent: false });
  assert.deepEqual([...bare.handlers.keys()].sort(), ['settings:get', 'settings:set'], 'what there is nothing behind is not offered');
});

test('every channel is closed to anyone but the window of the settings, and nothing is touched for a stranger', async () => {
  const f = fixture({ keys: 2 });
  f.deny();
  for (const channel of ['settings:get', 'settings:set', 'settings:forget-keys', 'settings:clear-recent']) await assert.rejects(Promise.resolve().then(() => f.call(channel, {})), /Access denied/, channel);
  assert.deepEqual(f.asked, []);
  assert.equal(f.state.keys, 2);
  assert.equal(f.state.availableAsked, 0);
});

test('the settings are told as they are, with how many keys are remembered and how many documents are recent, and the keystore of the system is not asked while the keys are not allowed', async () => {
  const f = fixture({ keys: 3 });
  await f.recent.add('/a/kantor.rwdoc');
  const reply = await f.call('settings:get');
  assert.deepEqual(reply, { ok: true, theme: 'system', toolbar: { visible: true }, tabs: { colorize: true }, fullscreen: { extended: false }, keys: { allow: false, usable: null, count: 3 }, recent: { count: 1 } });
  assert.equal(f.state.availableAsked, 0, 'not allowed: not asked, because asking can bring up a prompt of the system');
  assert.deepEqual(await f.api.view(), reply, 'the main process tells the window the same thing when something changes');
  await f.settings.setOption('keys.allow', true);
  assert.deepEqual((await f.call('settings:get')).keys, { allow: true, usable: true, count: 3 });
  f.state.available = false;
  assert.deepEqual((await f.call('settings:get')).keys, { allow: true, usable: false, count: 3 });
  const bare = fixture({ keystore: false, recent: false });
  assert.deepEqual((await bare.call('settings:get')).keys, { allow: false, usable: null, count: 0 });
  assert.deepEqual((await bare.call('settings:get')).recent, { count: 0 });
  assert.ok(!JSON.stringify(reply).includes('kantor'), 'no name and no path of a document goes to the window');
});

test('a keystore that falls over is no keystore, keys that are allowed with none wired in are not usable, and keys that cannot be counted are none', async () => {
  const falls = fixture({ availableThrows: true, countThrows: true });
  await falls.settings.setOption('keys.allow', true);
  assert.deepEqual((await falls.call('settings:get')).keys, { allow: true, usable: false, count: 0 });
  const refused = await falls.call('settings:set', { name: 'keys.allow', value: false });
  assert.equal(refused.ok, true);
  const bare = fixture({ keystore: false });
  await bare.settings.setOption('keys.allow', true);
  assert.deepEqual((await bare.call('settings:get')).keys, { allow: true, usable: false, count: 0 }, 'allowed, and nothing to keep keys with');
});

test('a setting that the settings themselves refuse as not valid is told as a wrong request, not as a failure of the computer, and is not reported', async () => {
  const picky = Object.assign(Settings.memory(), { setOption: () => Promise.reject(new SettingsError('invalid', 'not a choice')) });
  const f = fixture({ settings: picky });
  const reply = await f.call('settings:set', { name: 'tabs.colorize', value: false });
  assert.deepEqual([reply.ok, reply.code, reply.message], [false, 'invalid', 'Perubahan itu tidak dikenal.']);
  assert.deepEqual(f.reported, []);
});

test('each setting is changed by its name and a value, kept, and the answer is the settings after it', async () => {
  const f = fixture();
  assert.equal((await f.call('settings:set', { name: 'theme', value: 'dark' })).theme, 'dark');
  assert.equal(f.settings.values().theme, 'dark');
  assert.equal((await f.call('settings:set', { name: 'toolbar.visible', value: false })).toolbar.visible, false);
  assert.equal(f.settings.values().toolbar.visible, false);
  assert.equal((await f.call('settings:set', { name: 'tabs.colorize', value: false })).tabs.colorize, false);
  assert.equal((await f.call('settings:set', { name: 'fullscreen.extended', value: true })).fullscreen.extended, true);
  assert.deepEqual([f.settings.values().tabs.colorize, f.settings.values().fullscreen.extended], [false, true]);
  assert.equal((await f.call('settings:set', { name: 'theme', value: 'system' })).theme, 'system');
});

test('a setting that is not one, a value that is not for it, or more than a name and a value, is refused and changes nothing', async () => {
  const f = fixture();
  const before = JSON.stringify(f.settings.values());
  const wrong: unknown[] = [undefined, null, 'theme', 7, [], {}, { name: 'theme' }, { value: 'dark' }, { name: 'theme', value: 'sepia' }, { name: 'theme', value: true }, { name: 'toolbar.visible', value: 'no' }, { name: 'tabs.colorize', value: 1 },
    { name: 'keys.allow', value: 'yes' }, { name: 'toolbar.items', value: [] }, { name: '__proto__', value: true }, { name: 'constructor', value: true }, { name: 'theme', value: 'dark', extra: 1 }, { name: 'tabs', value: true },
    Object.assign([], { name: 'theme', value: 'dark' }), Object.assign(Object.create({ name: 'theme' }), { value: 'dark', other: 1 })];
  for (const payload of wrong) {
    const reply = await f.call('settings:set', payload);
    assert.equal(reply.ok, false, JSON.stringify(payload));
    assert.equal(reply.code, 'invalid', JSON.stringify(payload));
  }
  assert.equal(JSON.stringify(f.settings.values()), before);
});

test('the keys are allowed only if the system has a keystore: turning them on without one is refused and says why, turning them off is never refused', async () => {
  const f = fixture({ available: false });
  const refused = await f.call('settings:set', { name: 'keys.allow', value: true });
  assert.deepEqual([refused.ok, refused.code], [false, 'keystore']);
  assert.match(refused.message, /tidak tersedia/);
  assert.equal(f.settings.values().keys.allow, false);
  f.state.available = true;
  const accepted = await f.call('settings:set', { name: 'keys.allow', value: true });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.keys, { allow: true, usable: true, count: 0 });
  f.state.available = false;
  const off = await f.call('settings:set', { name: 'keys.allow', value: false });
  assert.equal(off.ok, true);
  assert.equal(f.settings.values().keys.allow, false);
  assert.equal(f.state.availableAsked, 3, 'the keystore is asked when it is turned on, and when the settings are told with the keys allowed');
  const bare = fixture({ keystore: false });
  assert.equal((await bare.call('settings:set', { name: 'keys.allow', value: true })).code, 'keystore', 'no keystore wired in at all');
});

test('a setting that cannot be kept is told as such, and the main process is told why', async () => {
  const broken = Object.assign(Settings.memory(), { setOption: () => Promise.reject(new SettingsError('io', 'not written')), setTheme: () => Promise.reject(new Error('odd')) });
  const f = fixture({ settings: broken });
  const reply = await f.call('settings:set', { name: 'tabs.colorize', value: false });
  assert.deepEqual([reply.ok, reply.code], [false, 'io']);
  assert.match(reply.message, /tidak dapat disimpan/);
  assert.equal(f.reported.length, 1);
  assert.equal((await f.call('settings:set', { name: 'theme', value: 'dark' })).code, 'io');
  assert.equal(f.reported.length, 2);
});

test('forgetting all the keys asks first, says how many there were, and does nothing when the answer is no or when there are none', async () => {
  const f = fixture({ keys: 4 });
  const done = await f.call('settings:forget-keys');
  assert.deepEqual(f.asked, [4]);
  assert.deepEqual(done, { ok: true, forgot: 4 });
  assert.equal(f.state.keys, 0);
  const none = await f.call('settings:forget-keys');
  assert.deepEqual(f.asked, [4], 'no question when there is nothing to forget');
  assert.deepEqual(none, { ok: true, forgot: 0 });
  const no = fixture({ keys: 2, confirm: false });
  const declined = await no.call('settings:forget-keys');
  assert.deepEqual([declined.ok, declined.code], [false, 'cancelled']);
  assert.equal(no.state.keys, 2);
  const broken = fixture({ keys: 2, forgetThrows: true });
  const failed = await broken.call('settings:forget-keys');
  assert.deepEqual([failed.ok, failed.code], [false, 'io']);
  assert.equal(broken.reported.length, 1);
});

test('the list of recent documents is cleared on request, and the answer says what is left', async () => {
  const f = fixture();
  await f.recent.add('/a/kantor.rwdoc');
  await f.recent.add('/a/rumah.rwdoc');
  const reply = await f.call('settings:clear-recent');
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.recent, { count: 0 });
  assert.deepEqual(f.recent.list(), []);
});

test('a list that cannot be cleared on disk is told as such: the list is empty now, and the answer says the file is not', async () => {
  const f = fixture({ clearFails: true });
  await f.recent.add('/a/kantor.rwdoc');
  const reply = await f.call('settings:clear-recent');
  assert.deepEqual([reply.ok, reply.code], [false, 'io']);
  assert.match(reply.message, /berkas/);
  assert.deepEqual(f.recent.list(), []);
  assert.deepEqual(f.reported, [], 'it is not a failure of the program');
});

test('keys that cannot all be forgotten are told in words about keys, not about settings', async () => {
  const f = fixture({ keys: 2, forgetThrows: true });
  const reply = await f.call('settings:forget-keys');
  assert.deepEqual([reply.ok, reply.code], [false, 'io']);
  assert.match(reply.message, /kunci/);
  assert.doesNotMatch(reply.message, /Pengaturan/);
});

// What the review after the execution (23 October 2026) found.

test('what is told is what the settings are when the count of the keys comes back, not what they were when it was asked for', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture({ keys: 1, countWaits: gate });
  const pending = f.call('settings:get');
  await f.settings.setTheme('dark');      // changed while the keys are being counted
  await f.settings.setToolbar({ visible: false });
  await f.recent.add('/a/kantor.rwdoc');
  release();
  const reply = await pending;
  assert.equal(reply.theme, 'dark');
  assert.deepEqual(reply.toolbar, { visible: false });
  assert.deepEqual(reply.recent, { count: 1 });
  assert.deepEqual(reply.keys, { allow: false, usable: null, count: 1 });
});
