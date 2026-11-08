import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentLibrary, type ChangeEvent } from '../src/documents/library.js';
import { QUIET_MS, followLibrary } from '../src/desktop/autosave.js';
import { messageFor } from '../src/desktop/documents-ipc.js';
import { Preferences } from '../src/desktop/preferences.js';
import { realFs, type StoreFs } from '../src/documents/store.js';
import { FakeClock } from './fake-clock.js';

const kdf = { logN: 14, r: 8, p: 1 };
type Push = { channel: string; payload: any };

/** A library on a clock that the test moves, preferences in a temporary folder, and an autosaver that follows the library; what the windows would be sent is collected. */
async function world(options: { fs?: StoreFs; failPush?: (channel: string) => boolean; report?: (error: unknown) => void } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rwauto-'));
  const clock = new FakeClock();
  const library = new DocumentLibrary({ kdf, now: clock.now, ...(options.fs ? { fs: options.fs } : {}) });
  const preferences = await Preferences.open(join(dir, 'preferences.json'));
  const pushed: Push[] = [];
  const watching = followLibrary({ library, preferences, push: (channel, payload) => { if (options.failPush?.(channel)) throw new Error('the window is gone'); pushed.push({ channel, payload }); }, timers: clock, ...(options.report ? { report: options.report } : {}) });
  const made = await library.create(join(dir, 'lab.rwdoc'), 'Lab', 'pw');
  const chosen = async (mode: 'edit' | 'close' | 'off') => { await preferences.setAutosave(made.docId, mode); watching.autosaver.chose(made.id); };
  const edit = (name = 'A') => library.add(made.id, { parentId: null, type: 'folder', name }).objectId;
  /** Moves the clock and waits for the saves that the timers started: they use the real file system. */
  const run = async (ms: number) => { await clock.advance(ms); await watching.autosaver.idle(); };
  return { dir, clock, library, preferences, pushed, watching, id: made.id, docId: made.docId, chosen, edit, run };
}

test('a document that saves on edit is saved a quiet time after an edit, and the windows are told what the save left as a change they can take in', async () => {
  const w = await world();
  await w.chosen('edit');
  w.edit();
  assert.equal(w.library.view(w.id).dirty, true);
  await w.run(QUIET_MS);
  const view = w.library.view(w.id);
  assert.equal(view.dirty, false);
  assert.equal(w.pushed.length, 1);
  assert.equal(w.pushed[0]!.channel, 'documents:delta');
  assert.deepEqual([w.pushed[0]!.payload.id, w.pushed[0]!.payload.dirty, w.pushed[0]!.payload.seq], [w.id, false, view.seq]);
  assert.equal(w.pushed[0]!.payload.seq > w.pushed[0]!.payload.from, true, 'a change for the window to take in: it is saved now');
});

test('a document that does not save by itself is not saved, and one that saves when it is closed is left for the closing', async () => {
  const w = await world();
  w.edit();
  await w.run(10 * 60_000);
  assert.deepEqual([w.library.view(w.id).dirty, w.pushed.length], [true, 0]);
  await w.chosen('close');
  w.edit('B');
  await w.run(10 * 60_000);
  assert.deepEqual([w.library.view(w.id).dirty, w.pushed.length], [true, 0]);
  await w.chosen('edit');
  assert.equal(w.clock.pending > 0, true, 'choosing on edit starts the wait for what is unsaved already');
  await w.run(QUIET_MS);
  assert.equal(w.library.view(w.id).dirty, false);
});

test('the saves of a timer keep a revision only when the newest is old enough: a save every few seconds does not use up the history', async () => {
  const w = await world();
  await w.chosen('edit');
  for (let i = 0; i < 5; i++) { w.edit(`n${i}`); await w.run(QUIET_MS); }
  assert.equal((await w.library.revisions(w.id)).length, 1, 'five saves in half a minute: one revision');
  await w.run(10 * 60_000);
  w.edit('later');
  await w.run(QUIET_MS);
  assert.equal((await w.library.revisions(w.id)).length, 2);
});

test('a save that finds the file changed elsewhere is held back: the windows get the merge and are told once that it waits for a decision, and nothing is tried again', async () => {
  const w = await world();
  const web = w.library.add(w.id, { parentId: null, type: 'folder', name: 'web' }).objectId;
  await w.library.save(w.id);
  const path = w.library.views()[0]!.path;
  const other = new DocumentLibrary({ kdf });
  const b = (await other.open(path, 'pw')).id;
  other.update(b, web, { name: 'by other' });
  await other.save(b);
  await w.chosen('edit');
  w.library.update(w.id, web, { name: 'by me' });
  await w.run(QUIET_MS);
  const events = w.pushed.filter((p) => p.channel === 'documents:event');
  assert.deepEqual(events.map((e) => [e.payload.id, e.payload.code, e.payload.message]), [[w.id, 'autosave-held', messageFor('autosave-held')]]);
  const deltas = w.pushed.filter((p) => p.channel === 'documents:delta');
  assert.deepEqual([deltas.length, deltas[0]!.payload.reset, deltas[0]!.payload.conflicts], [1, true, 1], 'the window is told of the merge and of the count');
  w.pushed.length = 0;
  await w.run(10 * 60_000);
  w.library.update(w.id, web, { name: 'again' });
  await w.run(10 * 60_000);
  assert.deepEqual(w.pushed, [], 'while the conflict is open nothing is tried and nothing is said again');
});

test('a save that fails is said once, with the reason, and the next edit tries again', async () => {
  let failing = false;
  const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (failing && !to.endsWith('preferences.json')) throw Object.assign(new Error('EIO'), { code: 'EIO' }); await realFs.rename(from, to); } };
  const w = await world({ fs });
  await w.chosen('edit');
  failing = true;
  w.edit('one');
  await w.run(QUIET_MS);
  w.edit('two');
  await w.run(QUIET_MS);
  const events = w.pushed.filter((p) => p.channel === 'documents:event');
  assert.equal(events.length, 1, 'said once');
  assert.deepEqual([events[0]!.payload.id, events[0]!.payload.code], [w.id, 'autosave-failed']);
  assert.ok((events[0]!.payload.message as string).startsWith(messageFor('autosave-failed')) && (events[0]!.payload.message as string).includes(messageFor('io')), 'with the reason');
  assert.equal(w.library.view(w.id).dirty, true);
  failing = false;
  w.edit('three');
  await w.run(QUIET_MS);
  assert.equal(w.library.view(w.id).dirty, false, 'it worked when the disk did');
});

test('a document that is closed is not followed any more, and stopping follows nothing at all', async () => {
  const w = await world();
  await w.chosen('edit');
  w.edit();
  assert.equal(w.clock.pending > 0, true);
  w.library.close(w.id, { discard: true });
  assert.equal(w.clock.pending, 0);
  await w.run(10 * 60_000);
  assert.deepEqual(w.pushed, []);
  const second = await world();
  await second.chosen('edit');
  second.edit();
  assert.equal(second.clock.pending > 0, true, 'something is waiting');
  second.watching.stop();
  assert.equal(second.clock.pending, 0, 'stopping lets go of it');
  second.edit('later');
  assert.equal(second.clock.pending, 0, 'and nobody is listening any more');
});

test('a whole earlier version put back is saved by the timer with the file it replaces kept, although the newest revision is young', async () => {
  const w = await world();
  await w.chosen('edit');
  w.edit('one');
  await w.run(QUIET_MS);
  w.edit('two');
  await w.run(QUIET_MS);
  const list = await w.library.revisions(w.id);
  assert.equal(list.length, 1, 'two saves by the timer, seconds apart: one revision');
  await w.library.restore(w.id, list[0]!.name, { all: true });
  await w.run(QUIET_MS);
  assert.equal(w.library.view(w.id).dirty, false);
  assert.equal((await w.library.revisions(w.id)).length, 2, 'the file with what was written meanwhile is kept');
});

/** A library as far as the autosaver sees it: what a document says it is, and the listener. */
function stub(view: { docId: string; dirty: boolean; conflicts: number } | undefined) {
  const listeners = new Set<(event: ChangeEvent) => void>();
  const library = { view: () => { if (!view) throw new Error('not open'); return view; }, onChange: (l: (event: ChangeEvent) => void) => { listeners.add(l); return () => listeners.delete(l); }, save: async () => { throw new Error('not saved here'); } } as unknown as DocumentLibrary;
  return { library, listeners };
}

test('choosing on edit for a document that a conflict holds back waits for nothing, and a preference that fails is reported while a document that is not open is not', () => {
  const clock = new FakeClock();
  const held = stub({ docId: 'doc', dirty: true, conflicts: 2 });
  followLibrary({ library: held.library, preferences: { autosaveOf: () => 'edit' }, push: () => undefined, timers: clock }).autosaver.chose('d1');
  assert.equal(clock.pending, 0, 'held back: nothing is armed');
  const open = stub({ docId: 'doc', dirty: true, conflicts: 0 });
  const reported: unknown[] = [];
  const failing = followLibrary({ library: open.library, preferences: { autosaveOf: () => { throw new Error('preferences'); } }, push: () => undefined, timers: clock, report: (error) => reported.push(error) });
  failing.autosaver.chose('d1');
  assert.equal(reported.length, 1, 'the preferences failed: it is reported');
  assert.equal(clock.pending, 0);
  const gone = stub(undefined);
  const quiet: unknown[] = [];
  followLibrary({ library: gone.library, preferences: { autosaveOf: () => 'edit' }, push: () => undefined, timers: clock, report: (error) => quiet.push(error) }).autosaver.chose('d1');
  assert.deepEqual(quiet, [], 'a document that is not open is nothing to report');
  const normal = stub({ docId: 'doc', dirty: true, conflicts: 0 });
  followLibrary({ library: normal.library, preferences: { autosaveOf: () => 'edit' }, push: () => undefined, timers: clock }).autosaver.chose('d1');
  assert.equal(clock.pending > 0, true, 'a document that is chosen to save on edit and has unsaved changes waits');
});

test('stopping lets go of the library: nobody listens to it any more', () => {
  const clock = new FakeClock();
  const watched = stub({ docId: 'doc', dirty: false, conflicts: 0 });
  const following = followLibrary({ library: watched.library, preferences: { autosaveOf: () => 'edit' }, push: () => undefined, timers: clock });
  assert.equal(watched.listeners.size, 1, 'it listens');
  following.stop();
  assert.equal(watched.listeners.size, 0, 'and it does not any more');
});

test('a window that cannot be told after the file was written does not turn that save into a failed one: the document is saved, the failure is reported, and nobody is told that it was not saved', async () => {
  const reported: unknown[] = [];
  const w = await world({ failPush: (channel) => channel === 'documents:delta', report: (error) => { reported.push(error); } });
  await w.chosen('edit');
  w.edit();
  await w.run(QUIET_MS);
  assert.equal(w.library.view(w.id).dirty, false, 'it was saved');
  assert.equal(reported.length, 1, 'and what went wrong is reported');
  assert.deepEqual(w.pushed.filter((p) => p.channel === 'documents:event'), [], 'nobody is told that the save failed: it did not');
});
