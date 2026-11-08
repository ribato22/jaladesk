import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentLibrary } from '../src/documents/library.js';
import { MAX_NOTES } from '../src/documents/meta.js';
import { DEFAULT_RDP, toProps } from '../src/desktop/connection-settings.js';
import { registerDocumentIpc, type Dialogs, type FavoritesStore } from '../src/desktop/documents-ipc.js';
import { Preferences, PreferencesError } from '../src/desktop/preferences.js';

const kdf = { logN: 14, r: 8, p: 1 };
const rdp = toProps({ ...DEFAULT_RDP, host: 'win-lab.example', username: 'ops' });
const SORT = [{ by: 'name', dir: 'asc' }];
/** What each fixed text says that no other says, so that a text given for the wrong failure is noticed. */
const WORDS = { reset: /disimpan di sampingnya/, unavailable: /tidak dapat dibuka/, 'too-new': /versi aplikasi yang lebih baru/, 'cannot-keep': /Preferensi tidak dapat disimpan/, 'too-many': /Terlalu banyak favorit/ } as const;
const saysOnly = (text: string, key: keyof typeof WORDS, label: string) => { for (const [other, words] of Object.entries(WORDS)) assert.equal(words.test(text), other === key, `${label}: "${text}" ${other === key ? 'says' : 'must not say'} ${other}`); };

/** The IPC layer on a real library and (unless told otherwise) real preferences in a temporary folder; the dialogs answer from `state`. */
async function harness(options: { preferences?: FavoritesStore | null; withoutPreferences?: boolean; notice?: 'reset' | 'unavailable' | 'too-new' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rwipcm-'));
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<any>>();
  const library = new DocumentLibrary({ kdf });
  const prefsPath = join(dir, 'preferences.json');
  const preferences = options.withoutPreferences ? undefined : (options.preferences ?? await Preferences.open(prefsPath));
  const state = { savePath: join(dir, 'lab.rwdoc') as string | undefined, openPath: undefined as string | undefined, reported: [] as unknown[] };
  const dialogs: Dialogs = {
    chooseOpenPath: async () => state.openPath,
    chooseSavePath: async () => state.savePath,
    askPassword: async () => 'pw-12345678',
    confirmClose: async () => 'discard',
    confirmRemove: async () => true,
  };
  const check = (event: unknown) => { if (event === 'stranger') throw new Error('Access denied'); };
  registerDocumentIpc({ ipc: { handle: (channel, listener) => { handlers.set(channel, async (event, payload) => listener(event, payload)); } }, check, library, dialogs, report: (error) => { state.reported.push(error); }, ...(preferences ? { preferences } : {}), ...(options.notice ? { notice: options.notice } : {}) });
  const call = (channel: string, payload?: unknown) => handlers.get(channel)!('window', payload);
  const start = async () => { const made = await call('documents:create', { name: 'Lab' }); assert.equal(made.ok, true); return made.snapshot; };
  return { dir, prefsPath, handlers, library, state, call, start, preferences };
}
const add = async (call: (c: string, p?: unknown) => Promise<any>, id: string, parentId: string | null, type: string, name: string, props: unknown = {}) => {
  const reply = await call('documents:add', { id, parentId, type, name, props });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.objectId as string;
};

test('the favourites channel is there when there are preferences, and every channel, that one too, refuses a sender that is not the app window', async () => {
  const { handlers } = await harness();
  assert.deepEqual([...handlers.keys()].sort(), ['documents:add', 'documents:close', 'documents:create', 'documents:duplicate', 'documents:favorite', 'documents:move', 'documents:open', 'documents:remove', 'documents:save', 'documents:snapshot', 'documents:update', 'documents:views']);
  for (const [channel, handler] of handlers) await assert.rejects(handler('stranger', {}), /Access denied/, channel);
  const without = await harness({ withoutPreferences: true });
  assert.equal(without.handlers.has('documents:favorite'), false, 'without preferences there is nothing to choose favourites in');
});

test('every snapshot the window is given carries the favourites of the document that still exist, and none is given without preferences', async () => {
  const { call, start, library, preferences } = await harness();
  const view = await start();
  assert.deepEqual(view.favorites, []);
  const a = await add(call, view.id, null, 'folder', 'A'), b = await add(call, view.id, a, 'connection', 'b', rdp);
  assert.deepEqual((await call('documents:favorite', { id: view.id, objectId: b, on: true })).favorites, [b]);
  assert.deepEqual((await call('documents:favorite', { id: view.id, objectId: a, on: true })).favorites, [b, a], 'in the order they were chosen');
  for (const reply of [await call('documents:snapshot', { id: view.id }), (await call('documents:views')).snapshots[0]]) assert.deepEqual((reply.snapshot ?? reply).favorites, [b, a]);
  await call('documents:remove', { id: view.id, objectId: a });   // takes b with it
  assert.deepEqual((await call('documents:snapshot', { id: view.id })).snapshot.favorites, [], 'the favourites of objects that are gone are not told');
  assert.equal(preferences!.favoritesOf(library.view(view.id).docId).length, 2, 'they stay in the file until the document is opened again');
  const plain = await harness({ withoutPreferences: true });
  assert.equal('favorites' in (await plain.start()), false);
});

test('choosing a favourite is refused for what the window may not name: an object of a hidden kind, an object that is not there, ids that are not ids, a choice that is not true or false', async () => {
  const { call, start, library } = await harness();
  const view = await start();
  const folder = await add(call, view.id, null, 'folder', 'A');
  const secret = library.add(view.id, { parentId: null, type: 'credential', name: 'K', props: {} }).objectId;
  const refused = [
    { id: view.id, objectId: secret, on: true }, { id: view.id, objectId: '00000000-0000-4000-8000-0000000000ee', on: true }, { id: view.id, objectId: 'x', on: true }, { id: view.id, objectId: '__proto__', on: true },
    { id: 'x', objectId: folder, on: true }, { id: view.id, objectId: folder, on: 'yes' }, { id: view.id, objectId: folder }, { id: view.id, on: true }, 'nope', null,
  ];
  for (const payload of refused) assert.equal((await call('documents:favorite', payload)).ok, false, JSON.stringify(payload));
  assert.equal((await call('documents:favorite', { id: view.id, objectId: secret, on: true })).code, 'unknown-object', 'a hidden kind is, for the window, an object that does not exist');
  assert.deepEqual((await call('documents:favorite', { id: '00000000-0000-4000-8000-000000000f00', objectId: folder, on: true })).code, 'unknown-document');
  assert.deepEqual((await call('documents:snapshot', { id: view.id })).snapshot.favorites, []);
});

test('a favourite belongs to the document, not to the open session or the file: it is there again when the document is opened, and the favourites of objects that are not in that file are neither told nor forgotten', async () => {
  const { call, state, start, library, preferences, prefsPath } = await harness();
  const view = await start();
  const keep = await add(call, view.id, null, 'folder', 'Keep');
  const docId = library.view(view.id).docId;
  const elsewhere = '00000000-0000-4000-8000-0000000000ee';
  await call('documents:favorite', { id: view.id, objectId: keep, on: true });
  await preferences!.setFavorite(docId, elsewhere, true);   // an object that this file does not have (another copy of the document, an older one, may)
  assert.equal((await call('documents:save', { id: view.id })).saved, true);
  assert.equal((await call('documents:close', { id: view.id })).ok, true);
  state.openPath = state.savePath;
  const again = await call('documents:open');
  assert.equal(again.ok, true);
  assert.deepEqual(again.snapshot.favorites, [keep], 'the one that is not there is not told');
  assert.deepEqual(JSON.parse(await readFile(prefsPath, 'utf8')).favorites[docId], [keep, elsewhere], 'and it is not forgotten: opening a file must not decide what another copy of the document keeps');
});

test('the window is told, in fixed words and without a path, when the favourites start empty because a damaged file was set aside or are not available; and told nothing when all is well', async () => {
  for (const notice of ['reset', 'unavailable', 'too-new'] as const) {
    const { call, dir } = await harness({ notice, withoutPreferences: notice !== 'reset' });
    const views = await call('documents:views');
    assert.equal(views.ok, true);
    assert.equal(typeof views.notice, 'string', notice);
    assert.ok(views.notice.length > 20 && !views.notice.includes(dir), notice);
    saysOnly(views.notice, notice, 'notice');
  }
  const quiet = await harness();
  assert.equal('notice' in (await quiet.call('documents:views')), false);
});

test('a favourite that cannot be kept is said plainly, with a fixed text, and what went wrong stays in the main process', async () => {
  const broken: FavoritesStore = {
    favoritesOf: () => [],
    setFavorite: async () => { throw new PreferencesError('io', 'The preferences cannot be written: EACCES /Users/someone/secret-path'); },
  };
  const { call, start, state } = await harness({ preferences: broken });
  const view = await start();
  const folder = await add(call, view.id, null, 'folder', 'A');
  const reply = await call('documents:favorite', { id: view.id, objectId: folder, on: true });
  assert.deepEqual([reply.ok, reply.code], [false, 'preferences']);
  saysOnly(reply.message, 'cannot-keep', 'io');
  assert.equal(JSON.stringify(reply).includes('secret-path'), false);
  assert.equal(state.reported.length, 1);
  const crowded: FavoritesStore = { favoritesOf: () => [], setFavorite: async () => { throw new PreferencesError('too-many', 'Too many favourites in this document'); } };
  const other = await harness({ preferences: crowded });
  const v2 = await other.start();
  const f2 = await add(other.call, v2.id, null, 'folder', 'A');
  const full = await other.call('documents:favorite', { id: v2.id, objectId: f2, on: true });
  assert.deepEqual([full.ok, full.code], [false, 'too-many-favorites']);
  saysOnly(full.message, 'too-many', 'too-many');
  assert.equal(other.state.reported.length, 0, 'a refusal is not an incident: nothing is reported');
  const newer: FavoritesStore = { favoritesOf: () => [], setFavorite: async () => { throw new PreferencesError('too-new', 'The preferences were written by a newer version of this app'); } };
  const third = await harness({ preferences: newer });
  const v3 = await third.start();
  const f3 = await add(third.call, v3.id, null, 'folder', 'A');
  const refusal = await third.call('documents:favorite', { id: v3.id, objectId: f3, on: true });
  assert.deepEqual([refusal.ok, refusal.code], [false, 'preferences-too-new'], 'a file of a newer version is said as what it is, the same words as the notice at the start');
  saysOnly(refusal.message, 'too-new', 'too-new');
  assert.equal(third.state.reported.length, 0, 'and is expected, not an incident');
});

test('notes, colour, icon and sort are written only when they are valid, on add and on update, and the refusal changes nothing', async () => {
  const { call, start, library } = await harness();
  const view = await start();
  const ok = [
    { type: 'folder', props: { notes: 'two\nlines', color: 'teal', icon: 'box', sort: SORT } },
    { type: 'connection', props: { ...rdp, notes: 'x'.repeat(MAX_NOTES), color: 'blue', icon: 'cloud' } },
  ];
  for (const { type, props } of ok) assert.equal((await call('documents:add', { id: view.id, parentId: null, type, name: type, props })).ok, true, type);
  const before = library.size(view.id);
  const bad = [
    { type: 'folder', props: { other: 1 } }, { type: 'folder', props: { notes: 5 } }, { type: 'folder', props: { notes: 'x'.repeat(MAX_NOTES + 1) } }, { type: 'folder', props: { color: 'plaid' } }, { type: 'folder', props: { icon: 'nope' } },
    { type: 'folder', props: { sort: [] } }, { type: 'folder', props: { sort: [{ by: 'name', dir: 'up' }] } }, { type: 'connection', props: { ...rdp, sort: SORT } },
  ];
  for (const { type, props } of bad) assert.equal((await call('documents:add', { id: view.id, parentId: null, type, name: 'bad', props })).code, 'invalid', JSON.stringify(props));
  assert.equal(library.size(view.id), before);
  const folder = await add(call, view.id, null, 'folder', 'F');
  for (const { props } of bad.filter((b) => b.type === 'folder')) assert.equal((await call('documents:update', { id: view.id, objectId: folder, props })).code, 'invalid', JSON.stringify(props));
  library.update(view.id, folder, { patch: { set: { opaque: { nested: 'keep encrypted' } } } }); // another writer's private/unknown fields cannot be replaced by a public DTO
  const whole = { notes: 'two\nlines', color: 'teal', icon: 'box', sort: SORT };
  const replaced = await call('documents:update', { id: view.id, objectId: folder, props: whole });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.deepEqual(library.node(view.id, folder)!.props, { opaque: { nested: 'keep encrypted' }, ...whole });
  assert.equal(Object.hasOwn(replaced.delta.upsert[0].props, 'opaque'), false, 'the preserved field is not read back');
});

test('a patch is applied to the properties as the document holds them, names what it sets and removes, and is checked for what it touches only', async () => {
  const { call, start, library } = await harness();
  const view = await start();
  const web = library.add(view.id, { parentId: null, type: 'connection', name: 'web', props: { ...rdp, note: 'keep me', color: 'plaid' } }).objectId;   // a colour that this app does not know, from another writer
  library.update(view.id, web, { patch: { set: { host: 'new.example' } } });   // changed behind the window's back
  const before = library.snapshot(view.id).seq;
  assert.equal((await call('documents:update', { id: view.id, objectId: web, patch: { unset: ['note'] } })).code, 'invalid', 'unknown fields cannot be mutated through generic IPC');
  assert.equal(library.snapshot(view.id).seq, before, 'the rejected removal publishes no change');
  const reply = await call('documents:update', { id: view.id, objectId: web, patch: { set: { notes: 'hello', icon: 'server' } } });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(reply.delta.upsert[0].props, { ...rdp, host: 'new.example', color: 'plaid', notes: 'hello', icon: 'server' }, 'the current host, not the one the window knew; the unknown colour is not blocking');
  assert.equal(library.node(view.id, web)!.props.note, 'keep me', 'the opaque old value stays encrypted in the document');
  assert.equal((await call('documents:update', { id: view.id, objectId: web, patch: { set: { color: 'plaid' } } })).code, 'invalid', 'but writing an unknown colour is refused');
  assert.equal((await call('documents:update', { id: view.id, objectId: web, patch: { set: { port: 'x' } } })).code, 'invalid', 'a setting of the connection is checked like before');
  assert.equal((await call('documents:update', { id: view.id, objectId: web, patch: { unset: ['host'] } })).code, 'invalid', 'removing one is checked too');
  const malformed = library.add(view.id, { parentId: null, type: 'connection', name: 'old', props: { protocol: 'rdp', host: '127.0.0.1', port: '3390', username: 'u' } }).objectId;   // a stored port of the wrong type
  assert.equal((await call('documents:update', { id: view.id, objectId: malformed, patch: { set: { color: 'red' } } })).ok, true, 'a colour does not need the connection to be well-formed');
});

test('a patch that is not a patch is refused: both lists naming one property, a whole set of properties beside it, a shape that is not set and unset, names that are not property names', async () => {
  const { call, start } = await harness();
  const view = await start();
  const folder = await add(call, view.id, null, 'folder', 'F', { icon: 'box' });
  const refused: unknown[] = [
    { set: { color: 'red' }, unset: ['color'] }, 'nope', [], { other: 1 }, { set: [] }, { set: 'x' }, { unset: 'icon' }, { unset: [1] }, { unset: ['bad key'] }, { unset: ['__proto__'] },
    { set: { 'bad key': 1 } }, { set: JSON.parse('{"__proto__": {"x": 1}}') }, { unset: Array.from({ length: 300 }, () => 'icon') },
  ];
  for (const patch of refused) assert.equal((await call('documents:update', { id: view.id, objectId: folder, patch })).code, 'invalid', JSON.stringify(patch));
  assert.equal((await call('documents:update', { id: view.id, objectId: folder, props: {}, patch: { set: { icon: 'server' } } })).code, 'invalid', 'props and patch together');
  assert.equal((await call('documents:update', { id: view.id, objectId: folder, patch: {} })).ok, true, 'an empty patch is a patch that changes nothing');
});

test('the sort setting can be spread to the folders below, from a folder only, in one change', async () => {
  const { call, start } = await harness();
  const view = await start();
  const top = await add(call, view.id, null, 'folder', 'top');
  const mid = await add(call, view.id, top, 'folder', 'mid');
  await add(call, view.id, mid, 'folder', 'low');
  const web = await add(call, view.id, mid, 'connection', 'web', rdp);
  const reply = await call('documents:update', { id: view.id, objectId: top, patch: { set: { sort: SORT } }, spreadSort: true });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.delta.upsert.map((o: any) => o.name).sort(), ['low', 'mid', 'top']);
  assert.equal(reply.delta.seq - reply.delta.from, 1);
  for (const spread of [true, 'yes', 1]) assert.equal((await call('documents:update', { id: view.id, objectId: web, patch: { set: { color: 'red' } }, spreadSort: spread })).code, 'invalid', `a connection has nothing to spread: ${String(spread)}`);
  assert.equal((await call('documents:update', { id: view.id, objectId: top, patch: { set: { color: 'red' } }, spreadSort: false })).ok, true);
});

test('a favourite of an object of a hidden kind is never told, even if the preferences hold its id', async () => {
  const { call, start, library, preferences } = await harness();
  const view = await start();
  const folder = await add(call, view.id, null, 'folder', 'A');
  const secret = library.add(view.id, { parentId: null, type: 'credential', name: 'K', props: {} }).objectId;
  const docId = library.view(view.id).docId;
  await preferences!.setFavorite(docId, secret, true);
  await preferences!.setFavorite(docId, folder, true);
  assert.deepEqual((await call('documents:snapshot', { id: view.id })).snapshot.favorites, [folder]);
});

test('the sort setting is spread only when the folder is left with one that may be written: a stored value that is not valid is not copied to the folders below', async () => {
  const { call, start, library } = await harness();
  const view = await start();
  const top = await add(call, view.id, null, 'folder', 'top');
  const low = await add(call, view.id, top, 'folder', 'low', { sort: SORT });
  library.update(view.id, top, { props: { sort: [{ by: 'date', dir: 'desc' }] } });          // a newer version, or another writer, stored a sort this app does not know
  assert.equal((await call('documents:update', { id: view.id, objectId: top, name: 'top', spreadSort: true })).code, 'invalid', 'as it stands it is not copied');
  assert.deepEqual(library.snapshot(view.id).objects.find((o) => o.id === low)!.props.sort, SORT, 'and nothing changed');
  const cleared = await call('documents:update', { id: view.id, objectId: top, patch: { unset: ['sort'] }, spreadSort: true });   // what the dialog sends when it shows "manual" and the box is ticked
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal('sort' in library.snapshot(view.id).objects.find((o) => o.id === low)!.props, false, 'the folders below are manual too');
  const set = await call('documents:update', { id: view.id, objectId: top, patch: { set: { sort: [{ by: 'type', dir: 'asc' }] } }, spreadSort: true });
  assert.equal(set.ok, true);
  assert.deepEqual(library.snapshot(view.id).objects.find((o) => o.id === low)!.props.sort, [{ by: 'type', dir: 'asc' }]);
  assert.equal((await call('documents:update', { id: view.id, objectId: top, props: { sort: [{ by: 'date', dir: 'asc' }] }, spreadSort: true })).code, 'invalid', 'a whole set of properties is held to the same rule');
});

test('every way of changing an object refuses what the window may not name, hidden kinds included, and a sort on a connection', async () => {
  const { call, start, library } = await harness();
  const view = await start();
  for (const kind of ['credential', 'task', 'template', 'gateway', 'dynamicProvider'] as const) {
    const hidden = library.add(view.id, { parentId: null, type: kind, name: 'secret', props: { keep: 1 } }).objectId;
    for (const change of [{ patch: { set: { color: 'red' } } }, { props: { color: 'red' } }, { name: 'x', spreadSort: true }, { patch: { unset: ['icon'] } }]) {
      const reply = await call('documents:update', { id: view.id, objectId: hidden, ...change });
      assert.deepEqual([reply.ok, reply.code], [false, 'unknown-object'], `${kind}: ${JSON.stringify(change)}`);
    }
    assert.deepEqual(library.node(view.id, hidden)!.props, { keep: 1 }, `${kind} is as it was`);
  }
  const web = await add(call, view.id, null, 'connection', 'web', rdp);
  assert.equal((await call('documents:update', { id: view.id, objectId: web, patch: { set: { sort: SORT } } })).code, 'invalid', 'a connection has no sort');
  assert.equal((await call('documents:update', { id: view.id, objectId: web, props: { ...rdp, sort: SORT } })).code, 'invalid');
});

test('a request that only asks for the sort to be spread has nothing to change: the dialog always sends the sort it shows with it', async () => {
  const { call, start } = await harness();
  const view = await start();
  const top = await add(call, view.id, null, 'folder', 'top');
  const reply = await call('documents:update', { id: view.id, objectId: top, spreadSort: true });
  assert.deepEqual([reply.ok, reply.code], [false, 'invalid']);
});
