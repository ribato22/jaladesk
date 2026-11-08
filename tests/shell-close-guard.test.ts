import assert from 'node:assert/strict';
import test from 'node:test';
import { decideClose, type CloseDialogs, type NotSaved } from '../src/desktop/close-guard.js';

type Answer = 'save' | 'discard' | 'cancel';

// A library with just what decideClose uses. `dirty` maps the unsaved documents' ids to their names, `saved` lists documents with nothing to save; `onSave` decides what each save does.
function setup(dirty: Record<string, string>, answer: Answer, onSave: (id: string, state: { dirty: Record<string, string> }) => Promise<{ saved: boolean }> | never, saved: string[] = []) {
  const state = { dirty: { ...dirty }, saves: [] as string[], asked: [] as string[][], told: [] as { reason: string; documents: NotSaved[] }[] };
  const library = {
    views: () => [...Object.entries(state.dirty).map(([id, name]) => ({ id, name, dirty: true })), ...saved.map((name) => ({ id: `saved-${name}`, name, dirty: false }))],
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

test('nothing unsaved: the window closes without a question', async () => {
  const { library, dialogs, state } = setup({}, 'cancel', savesFine);
  assert.equal(await decideClose(library, dialogs), 'close');
  assert.deepEqual(state.asked, []);
});

test('cancel keeps the window and saves nothing; discard closes it and saves nothing', async () => {
  const a = setup({ a: 'Lab' }, 'cancel', savesFine);
  assert.equal(await decideClose(a.library, a.dialogs), 'stay');
  assert.deepEqual([a.state.saves, a.state.asked], [[], [['Lab']]]);
  const b = setup({ a: 'Lab' }, 'discard', savesFine);
  assert.equal(await decideClose(b.library, b.dialogs), 'close');
  assert.deepEqual(b.state.saves, []);
});

test('save all: one question naming every unsaved document, every one saved, then the window closes', async () => {
  const { library, dialogs, state } = setup({ a: 'One', b: 'Two' }, 'save', savesFine);
  assert.equal(await decideClose(library, dialogs), 'close');
  assert.deepEqual([state.asked, state.saves, state.told], [[['One', 'Two']], ['a', 'b'], []]);
});

test('a save that fails or is held back keeps the window and says which document and why; the document that failed is still unsaved', async () => {
  const failing = setup({ a: 'One' }, 'save', async () => { throw Object.assign(new Error('disk full'), { code: 'busy' }); });
  assert.equal(await decideClose(failing.library, failing.dialogs), 'stay');
  assert.deepEqual([failing.state.saves, failing.state.told, Object.keys(failing.state.dirty)], [['a'], [{ reason: 'failed', documents: [{ name: 'One', code: 'busy' }] }], ['a']]);
  const unnamed = setup({ a: 'One' }, 'save', async () => { throw new Error('no code at all'); });
  assert.equal(await decideClose(unnamed.library, unnamed.dialogs), 'stay');
  assert.deepEqual(unnamed.state.told, [{ reason: 'failed', documents: [{ name: 'One', code: 'io' }] }], 'a failure without a code is an I/O failure');
  const held = setup({ a: 'One' }, 'save', async () => ({ saved: false }));
  assert.equal(await decideClose(held.library, held.dialogs), 'stay');
  assert.deepEqual(held.state.told, [{ reason: 'failed', documents: [{ name: 'One', code: 'conflict' }] }], 'held back by a conflict');
});

test('one document that cannot be saved does not keep the others from being saved; the window stays and names only the one that failed', async () => {
  const { library, dialogs, state } = setup({ a: 'One', b: 'Two', c: 'Three' }, 'save', async (id, s) => {
    if (id === 'b') throw Object.assign(new Error('locked'), { code: 'busy' });
    delete s.dirty[id];
    return { saved: true };
  });
  assert.equal(await decideClose(library, dialogs), 'stay');
  assert.deepEqual(state.saves, ['a', 'b', 'c'], 'every document was tried');
  assert.deepEqual(Object.keys(state.dirty), ['b'], 'only the one that failed is still unsaved');
  assert.deepEqual(state.told, [{ reason: 'failed', documents: [{ name: 'Two', code: 'busy' }] }]);
});

test('an edit that arrives while the documents are being saved is not thrown away: the window stays and the next close asks again', async () => {
  const { library, dialogs, state } = setup({ a: 'One' }, 'save', async (id, s) => { delete s.dirty[id]; s.dirty.a = 'One'; return { saved: true }; });
  assert.equal(await decideClose(library, dialogs), 'stay');
  assert.deepEqual(state.told, [{ reason: 'changed', documents: [{ name: 'One', code: 'changed' }] }], 'told which document changed again');
  const again = setup({ a: 'One' }, 'save', savesFine);
  assert.equal(await decideClose(again.library, again.dialogs), 'close');
});

test('a document that was closed while the others were being saved is not a failure', async () => {
  const { library, dialogs, state } = setup({ a: 'One', b: 'Two' }, 'save', async (id, s) => {
    if (id === 'a') { delete s.dirty.a; return { saved: true }; }
    delete s.dirty.b; // closed by the user meanwhile: the save is refused, but nothing is left to lose
    throw new Error('That document is not open');
  });
  assert.equal(await decideClose(library, dialogs), 'close');
  assert.deepEqual(state.told, []);
});

test('only documents with unsaved changes are named, and a window whose documents are all saved closes without a question', async () => {
  const mixed = setup({ a: 'Changed' }, 'discard', savesFine, ['Saved one', 'Saved two']);
  assert.equal(await decideClose(mixed.library, mixed.dialogs), 'close');
  assert.deepEqual(mixed.state.asked, [['Changed']]);
  const allSaved = setup({}, 'cancel', savesFine, ['Saved one']);
  assert.equal(await decideClose(allSaved.library, allSaved.dialogs), 'close');
  assert.deepEqual(allSaved.state.asked, []);
});
