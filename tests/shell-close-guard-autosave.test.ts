import assert from 'node:assert/strict';
import test from 'node:test';
import { decideClose, notSavedNotice, saveAllQuestion, type CloseDialogs, type NotSaved } from '../src/desktop/close-guard.js';

type Answer = 'save' | 'discard' | 'cancel';

// A library with just what decideClose uses: `dirty` maps the unsaved documents' ids to their names; `onSave` decides what each save does.
function setup(dirty: Record<string, string>, answer: Answer, onSave: (id: string, state: { dirty: Record<string, string> }) => Promise<{ saved: boolean }>) {
  const state = { dirty: { ...dirty }, saves: [] as string[], asked: [] as string[][], told: [] as { reason: string; documents: NotSaved[] }[] };
  const library = {
    views: () => Object.entries(state.dirty).map(([id, name]) => ({ id, name, dirty: true })),
    dirtyIds: () => Object.keys(state.dirty),
    save: async (id: string) => { state.saves.push(id); return onSave(id, state); },
  };
  const dialogs: CloseDialogs = {
    askSaveAll: async (names) => { state.asked.push(names); return answer; },
    tellNotSaved: async (reason, documents) => { state.told.push({ reason, documents }); },
  };
  return { state, library, dialogs };
}
const savesFine = async (id: string, state: { dirty: Record<string, string> }) => { delete state.dirty[id]; return { saved: true }; };
const automatic = (...ids: string[]) => (id: string) => ids.includes(id);

test('the documents that save by themselves are saved first, and only the others are asked about', async () => {
  const { library, dialogs, state } = setup({ a: 'Auto', b: 'Manual' }, 'discard', savesFine);
  assert.equal(await decideClose(library, dialogs, automatic('a')), 'close');
  assert.deepEqual([state.saves, state.asked], [['a'], [['Manual']]], 'Manual is thrown away on the word of the person, Auto was saved without being asked');
  const saved = setup({ a: 'Auto', b: 'Manual' }, 'save', savesFine);
  assert.equal(await decideClose(saved.library, saved.dialogs, automatic('a')), 'close');
  assert.deepEqual([saved.state.saves, saved.state.asked], [['a', 'b'], [['Manual']]]);
});

test('when every unsaved document saves by itself nothing is asked at all', async () => {
  const { library, dialogs, state } = setup({ a: 'One', b: 'Two' }, 'cancel', savesFine);
  assert.equal(await decideClose(library, dialogs, automatic('a', 'b')), 'close');
  assert.deepEqual([state.saves, state.asked, state.told], [['a', 'b'], [], []]);
});

test('one that saves by itself and cannot be saved is told with its reason, and then asked about like any document that has unsaved changes, together with the others', async () => {
  const failing = () => setup({ a: 'Auto', b: 'Manual' }, 'cancel', async (id, state) => { if (id === 'a') throw Object.assign(new Error('disk full'), { code: 'busy' }); delete state.dirty[id]; return { saved: true }; });
  const cancel = failing();
  assert.equal(await decideClose(cancel.library, cancel.dialogs, automatic('a')), 'stay');
  assert.deepEqual([cancel.state.saves, cancel.state.asked, cancel.state.told], [['a'], [['Auto', 'Manual']], [{ reason: 'automatic', documents: [{ name: 'Auto', code: 'busy' }] }]], 'said why, then asked: the window stays on a cancel');
  const discard = failing();
  discard.state.dirty.c = 'Third';
  const throwAway = setup({ a: 'Auto', b: 'Manual' }, 'discard', async () => { throw Object.assign(new Error('the share is gone'), { code: 'io' }); });
  assert.equal(await decideClose(throwAway.library, throwAway.dialogs, automatic('a')), 'close', 'a document that cannot be saved can be thrown away, on the word of the person');
  assert.deepEqual(throwAway.state.asked, [['Auto', 'Manual']]);
  const retry = setup({ a: 'Auto' }, 'save', async () => { throw Object.assign(new Error('still gone'), { code: 'io' }); });
  assert.equal(await decideClose(retry.library, retry.dialogs, automatic('a')), 'stay', 'and saying "save" tries again, and says again why not');
  assert.deepEqual([retry.state.saves, retry.state.told.map((t) => t.documents[0]!.code), retry.state.told.map((t) => t.reason)], [['a', 'a'], ['io', 'io'], ['automatic', 'failed']], 'the first time it was told before the question (the window may still close); the second time the window stays');
  const held = setup({ a: 'Auto' }, 'cancel', async () => ({ saved: false }));
  assert.equal(await decideClose(held.library, held.dialogs, automatic('a')), 'stay');
  assert.deepEqual(held.state.told, [{ reason: 'automatic', documents: [{ name: 'Auto', code: 'conflict' }] }], 'held back by a conflict');
  assert.deepEqual(held.state.asked, [['Auto']]);
});

test('one that saves by itself and is edited again while it is being saved is asked about, like any document that has unsaved changes', async () => {
  const { library, dialogs, state } = setup({ a: 'Auto' }, 'discard', async () => ({ saved: true })); // saved, and still unsaved: an edit arrived
  assert.equal(await decideClose(library, dialogs, automatic('a')), 'close');
  assert.deepEqual([state.saves, state.asked], [['a'], [['Auto']]]);
});

test('what closing the window asks: Enter saves and Escape cancels, so that nothing is thrown away by a key; and the notices say what is true of the window', () => {
  const one = saveAllQuestion(['Lab']), many = saveAllQuestion(['A', 'B', 'C']);
  for (const question of [one, many]) assert.deepEqual([question.buttons[question.defaultId], question.buttons[question.cancelId], question.buttons.length], ['Simpan semua', 'Batal', 3]);
  assert.match(one.message, /“Lab”/);
  assert.match(many.message, /3 dokumen/);
  assert.match(one.detail, /akan hilang/);
  const documents = [{ name: 'A', code: 'busy' }, { name: 'B', code: 'changed' }];
  const automatic = notSavedNotice('automatic', documents), failed = notSavedNotice('failed', documents), changed = notSavedNotice('changed', documents);
  assert.doesNotMatch(`${automatic.message} ${automatic.detail}`, /tidak ditutup/, 'the window is asked about next and may close: it is not promised to stay');
  assert.match(automatic.message, /sendiri/);
  assert.match(automatic.detail, /ditanya/);
  assert.match(failed.message, /jendela tidak ditutup/);
  assert.match(changed.message, /jendela tidak ditutup/);
  for (const notice of [automatic, failed, changed]) {
    assert.equal(notice.type, 'error');
    assert.match(notice.detail, /“A”: Berkas sedang dipakai/, 'each says why a document was not saved');
    assert.match(notice.detail, /“B”(?!:)/, 'and a document that was edited again is only named');
  }
  assert.equal(new Set([automatic.message, failed.message, changed.message]).size, 3);
});
