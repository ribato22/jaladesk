import assert from 'node:assert/strict';
import test from 'node:test';
import { Autosaver, LONGEST_MS, QUIET_MS, realTimers, type AutosaveHost } from '../src/desktop/autosave.js';
import type { AutosaveMode } from '../src/desktop/preferences.js';
import { FakeClock, flush } from './fake-clock.js';

/** A host that holds what the autosaver asks about: the mode and the state of each document, and a save that the test decides the end of. */
function host(now: () => number = () => 0) {
  const state = { modes: new Map<string, AutosaveMode>(), docs: new Map<string, { dirty: boolean; conflicts: number }>(), saves: [] as string[], times: [] as number[], said: [] as string[], outcome: (async () => ({ saved: true, conflicts: 0 })) as (id: string) => Promise<{ saved: boolean; conflicts: number }> };
  const value: AutosaveHost = {
    mode: (id) => state.modes.get(id),
    state: (id) => state.docs.get(id),
    save: async (id) => { state.saves.push(id); state.times.push(now()); return state.outcome(id); },
    say: (id, what, code) => { state.said.push(`${id}:${what}${code ? `:${code}` : ''}`); },
  };
  return { state, value };
}
const setup = () => { const clock = new FakeClock(), h = host(clock.now); return { clock, ...h, saver: new Autosaver(h.value, clock) }; };
const edit = (s: ReturnType<typeof setup>, id = 'd1', conflicts = 0) => { s.state.docs.set(id, { dirty: true, conflicts }); s.saver.changed({ id, dirty: true, conflicts }); };

test('a document that saves by itself on edit is saved a few seconds after the last edit, and an edit in the meantime puts it off', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  edit(s);
  await s.clock.advance(QUIET_MS - 1);
  assert.deepEqual(s.state.saves, [], 'not yet');
  edit(s);
  await s.clock.advance(QUIET_MS - 1);
  assert.deepEqual(s.state.saves, [], 'another edit: the wait starts again');
  await s.clock.advance(1);
  assert.deepEqual(s.state.saves, ['d1']);
  assert.equal(s.clock.pending, 0, 'and nothing is waiting any more');
});

test('a document that is edited without a pause is still saved, no later than a minute after the first edit that was not saved', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  for (let t = 0; t < LONGEST_MS; t += 4000) { edit(s); await s.clock.advance(Math.min(4000, LONGEST_MS - t)); }
  assert.deepEqual([s.state.saves, s.state.times], [['d1'], [LONGEST_MS]], 'at the minute, to the millisecond');
});

test('only the documents that were chosen to save on edit are saved: not one that saves when it is closed, and not one that is left as it is', async () => {
  const s = setup();
  s.state.modes.set('d1', 'close');
  edit(s, 'd1');
  edit(s, 'd2');
  s.state.modes.set('d3', 'edit');
  edit(s, 'd3');
  await s.clock.advance(10 * 60_000);
  assert.deepEqual(s.state.saves, ['d3']);
});

test('a document that was saved (by anybody), or is closed, is not saved again: what was waiting is forgotten', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  s.state.modes.set('d2', 'edit');
  edit(s, 'd1');
  edit(s, 'd2');
  s.state.docs.set('d1', { dirty: false, conflicts: 0 });
  s.saver.changed({ id: 'd1', dirty: false, conflicts: 0 });
  s.saver.changed({ id: 'd2', dirty: false, conflicts: 0, closed: true });
  assert.equal(s.clock.pending, 0);
  await s.clock.advance(5 * 60_000);
  assert.deepEqual(s.state.saves, []);
});

test('while there is a conflict nothing is saved by itself, and it goes on when the conflict is decided and there is still something to save', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  edit(s, 'd1');
  edit(s, 'd1', 2);
  assert.equal(s.clock.pending, 0, 'what was waiting is stopped');
  await s.clock.advance(5 * 60_000);
  assert.deepEqual(s.state.saves, []);
  edit(s, 'd1', 0);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.saves, ['d1']);
});

test('one save at a time for a document: what is edited while it is being saved is saved after it, a quiet time after the edit', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  let finish!: () => void;
  s.state.outcome = () => new Promise((resolve) => { finish = () => resolve({ saved: true, conflicts: 0 }); });
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.saves, ['d1']);
  edit(s);
  await s.clock.advance(QUIET_MS * 3);
  assert.deepEqual(s.state.saves, ['d1'], 'the first is not finished: no second one');
  s.state.outcome = async () => ({ saved: true, conflicts: 0 });
  finish();
  await flush();
  assert.equal(s.clock.pending > 0, true, 'what was edited meanwhile is waiting');
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.saves, ['d1', 'd1']);
});

test('a save that fails is said once, however often it fails; it is said again after one that worked, and the next edit tries again', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  s.state.outcome = async () => { throw new Error('disk is full'); };
  edit(s);
  await s.clock.advance(QUIET_MS);
  edit(s);
  await s.clock.advance(QUIET_MS);
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual([s.state.saves.length, s.state.said], [3, ['d1:failed']], 'tried each time, said once');
  s.state.outcome = async () => ({ saved: true, conflicts: 0 });
  edit(s);
  await s.clock.advance(QUIET_MS);
  s.state.outcome = async () => { throw new Error('disk is full'); };
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.said, ['d1:failed', 'd1:failed']);
});

test('a save that finds the file changed elsewhere and is held back is said once, and is not tried again until the conflict is decided', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  s.state.outcome = async () => { s.state.docs.set('d1', { dirty: true, conflicts: 2 }); s.saver.changed({ id: 'd1', dirty: true, conflicts: 2 }); return { saved: false, conflicts: 2 }; };
  edit(s);
  await s.clock.advance(QUIET_MS);
  await s.clock.advance(10 * 60_000);
  assert.deepEqual([s.state.saves, s.state.said], [['d1'], ['d1:held']]);
  s.state.outcome = async () => ({ saved: true, conflicts: 0 });
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.saves, ['d1', 'd1']);
});

test('choosing another way of saving takes effect at once: on edit starts the wait for a document that has unsaved changes, and anything else stops it', async () => {
  const s = setup();
  s.state.docs.set('d1', { dirty: true, conflicts: 0 });
  s.state.modes.set('d1', 'edit');
  s.saver.chose('d1');
  assert.equal(s.clock.pending > 0, true);
  s.state.modes.set('d1', 'close');
  s.saver.chose('d1');
  assert.equal(s.clock.pending, 0);
  await s.clock.advance(5 * 60_000);
  assert.deepEqual(s.state.saves, []);
  s.state.modes.set('d1', 'edit');
  s.saver.chose('d1');
  s.state.docs.delete('d1');
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.saves, [], 'a document that is not open any more is not saved');
  s.saver.chose('gone');
  assert.equal(s.clock.pending, 0);
});

test('a host that fails does not stop the others or the timers, and disposing stops everything', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  s.state.modes.set('d2', 'edit');
  const original = s.value;
  const ran: string[] = [];
  const broken = new Autosaver({ ...original, say: () => { throw new Error('the window is gone'); }, save: async (id) => { ran.push(id); if (id === 'd1') throw new Error('x'); return { saved: true, conflicts: 0 }; } }, s.clock);
  broken.changed({ id: 'd1', dirty: true, conflicts: 0 });
  broken.changed({ id: 'd2', dirty: true, conflicts: 0 });
  s.state.docs.set('d1', { dirty: true, conflicts: 0 });
  s.state.docs.set('d2', { dirty: true, conflicts: 0 });
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(ran.sort(), ['d1', 'd2'], 'both ran, one failed and told nobody, and nothing escaped');
  assert.equal(s.clock.pending, 0);
  broken.changed({ id: 'd1', dirty: true, conflicts: 0 });
  broken.dispose();
  assert.equal(s.clock.pending, 0);
});

test('idle waits for a save that is under way and for nothing else', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  let finish!: () => void;
  s.state.outcome = () => new Promise((resolve) => { finish = () => resolve({ saved: true, conflicts: 0 }); });
  await s.saver.idle();
  edit(s);
  await s.saver.idle(); // a timer that is waiting for its time is not a save under way
  assert.deepEqual(s.state.saves, []);
  await s.clock.advance(QUIET_MS);
  let idle = false;
  const waiting = s.saver.idle().then(() => { idle = true; });
  await flush();
  assert.equal(idle, false, 'the save has not ended');
  finish();
  await waiting;
  assert.equal(idle, true);
});

test('the reason that a failed save carries is handed on with what is said, and a failure that has none says nothing of it', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  s.state.outcome = async () => { throw Object.assign(new Error('x'), { code: 'busy' }); };
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.said, ['d1:failed:busy']);
  s.state.outcome = async () => ({ saved: true, conflicts: 0 });
  edit(s);
  await s.clock.advance(QUIET_MS);
  s.state.outcome = async () => { throw 'a string that is not an error'; };
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.said, ['d1:failed:busy', 'd1:failed']);
});

test('the quiet time and the longest time are the numbers the plan states: five seconds and a minute', () => {
  assert.deepEqual([QUIET_MS, LONGEST_MS], [5_000, 60_000]);
});

type World = ReturnType<typeof setup>;
for (const [what, spoil] of [
  ['it was saved by somebody', (s: World) => s.state.docs.set('d1', { dirty: false, conflicts: 0 })],
  ['a conflict holds it back', (s: World) => s.state.docs.set('d1', { dirty: true, conflicts: 1 })],
  ['it is not chosen to save by itself any more', (s: World) => s.state.modes.set('d1', 'close')],
  ['it is not open any more', (s: World) => s.state.docs.delete('d1')],
] as const) {
  test(`when the time comes a document is not saved if ${what}, although nobody told the autosaver`, async () => {
    const s = setup();
    s.state.modes.set('d1', 'edit');
    edit(s);
    spoil(s);
    await s.clock.advance(QUIET_MS);
    assert.deepEqual(s.state.saves, []);
  });
}

test('choosing for a document that is not open any more stops what was waiting for it', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  edit(s);
  assert.equal(s.clock.pending > 0, true);
  s.state.docs.delete('d1');
  s.saver.chose('d1');
  assert.equal(s.clock.pending, 0);
});

test('a failure after the document was saved by somebody else is news again, and so is one after the way of saving was chosen again', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  s.state.outcome = async () => { throw new Error('disk is full'); };
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.said, ['d1:failed']);
  s.state.docs.set('d1', { dirty: false, conflicts: 0 });
  s.saver.changed({ id: 'd1', dirty: false, conflicts: 0 });   // somebody saved it by hand
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.said, ['d1:failed', 'd1:failed']);
  s.saver.chose('d1');
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.said, ['d1:failed', 'd1:failed', 'd1:failed']);
});

test('a document that was closed is forgotten with what was said about it', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  s.state.outcome = async () => { throw new Error('disk is full'); };
  edit(s);
  await s.clock.advance(QUIET_MS);
  s.saver.changed({ id: 'd1', dirty: false, conflicts: 0, closed: true });
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.said, ['d1:failed', 'd1:failed']);
});

test('the minute is counted from the first edit that was not saved, also when that edit was made while a save was under way', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  const times: number[] = [];
  let finish!: () => void;
  s.state.outcome = () => { times.push(s.clock.at); return new Promise((resolve) => { finish = () => resolve({ saved: true, conflicts: 0 }); }); };
  edit(s);                                  // at 0
  await s.clock.advance(QUIET_MS);          // at 5 s the save starts, and it takes its time
  await s.clock.advance(1000);
  edit(s);                                  // at 6 s: the first edit that is not saved
  await s.clock.advance(34_000);            // at 40 s the save is still not over
  s.state.outcome = async () => { times.push(s.clock.at); return { saved: true, conflicts: 0 }; };
  finish();
  await flush();
  for (let at = 40_000; times.length < 2 && at < 300_000; at += 4000) { edit(s); await s.clock.advance(4000); }   // edited without a pause from then on
  assert.equal(times.length, 2);
  assert.equal(times[1], 6000 + LONGEST_MS, 'a minute after the edit of 6 s, not a minute after the save that ended at 40 s');
});

test('disposing stops a save that is under way from arming anything when it ends, and what changes after is not followed', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  let finish!: () => void;
  s.state.outcome = () => new Promise((resolve) => { finish = () => resolve({ saved: true, conflicts: 0 }); });
  edit(s);
  await s.clock.advance(QUIET_MS);
  edit(s);                                  // while the save is under way
  s.saver.dispose();
  finish();
  await flush();
  await s.saver.idle();
  assert.equal(s.clock.pending, 0);
  edit(s);
  s.saver.chose('d1');
  assert.equal(s.clock.pending, 0);
});

test('every failure is reported, not only the one that the window is told of; so is a window that cannot be told; a report that fails does not stop the saves', async () => {
  const clock = new FakeClock(), h = host(), reported: unknown[] = [];
  h.state.modes.set('d1', 'edit');
  h.state.outcome = async () => { throw new Error('disk'); };
  const saver = new Autosaver({ ...h.value, say: () => { throw new Error('gone'); } }, clock, QUIET_MS, LONGEST_MS, (error) => reported.push(error));
  for (let i = 0; i < 3; i++) { h.state.docs.set('d1', { dirty: true, conflicts: 0 }); saver.changed({ id: 'd1', dirty: true, conflicts: 0 }); await clock.advance(QUIET_MS); }
  assert.equal(h.state.saves.length, 3);
  assert.equal(reported.length, 4, 'three saves that failed, and the one time that the window was to be told of it');
  const loud = new Autosaver(h.value, clock, QUIET_MS, LONGEST_MS, () => { throw new Error('the log is gone too'); });
  h.state.docs.set('d2', { dirty: true, conflicts: 0 });
  h.state.modes.set('d2', 'edit');
  loud.changed({ id: 'd2', dirty: true, conflicts: 0 });
  await clock.advance(QUIET_MS);
  assert.equal(h.state.saves.length, 4, 'it was tried all the same');
});

test('a failure is not tried again by itself, also after an edit made while the failing save was under way: only an edit tries again', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  let fail!: (error: Error) => void;
  s.state.outcome = () => new Promise((_, reject) => { fail = reject; });
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual(s.state.saves, ['d1']);
  edit(s);                                                    // an edit while the save is under way
  s.state.outcome = async () => { throw new Error('disk is full'); };
  fail(new Error('disk is full'));
  await flush();
  assert.equal(s.clock.pending > 0, true, 'the edit made meanwhile is waiting');
  await s.clock.advance(QUIET_MS);
  assert.equal(s.state.saves.length, 2, 'it is tried for that edit');
  await s.clock.advance(10 * 60_000);
  assert.equal(s.state.saves.length, 2, 'and then not again until there is another edit');
  assert.equal(s.clock.pending, 0);
});

test('what waited before a conflict is not counted when the wait starts again: the first edit after the conflict is saved a quiet time later, not at once', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  edit(s, 'd1');                                              // the first unsaved edit: the minute counts from here
  edit(s, 'd1', 2);                                           // a conflict holds the save back
  await s.clock.advance(5 * 60_000);
  assert.deepEqual(s.state.saves, []);
  edit(s, 'd1', 0);                                           // it is decided
  await s.clock.advance(QUIET_MS - 1);
  assert.deepEqual(s.state.saves, [], 'a quiet time must pass first: the old minute is not counted');
  await s.clock.advance(1);
  assert.deepEqual(s.state.saves, ['d1']);
});

test('a document that is closed while it has unsaved changes is forgotten at once: nothing waits for it, though it is still said to be edited', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  edit(s);
  assert.equal(s.clock.pending > 0, true);
  s.saver.changed({ id: 'd1', dirty: true, conflicts: 0, closed: true });
  assert.equal(s.clock.pending, 0);
  await s.clock.advance(5 * 60_000);
  assert.deepEqual(s.state.saves, []);
});

test('a save that wrote nothing and holds nothing back says nothing', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  s.state.outcome = async () => ({ saved: false, conflicts: 0 });
  edit(s);
  await s.clock.advance(QUIET_MS);
  assert.deepEqual([s.state.saves, s.state.said], [['d1'], []]);
});

test('an edit made during a save that takes longer than a minute is saved at once after it: the minute that was left is spent', async () => {
  const s = setup();
  s.state.modes.set('d1', 'edit');
  let finish!: () => void;
  s.state.outcome = () => new Promise((resolve) => { finish = () => resolve({ saved: true, conflicts: 0 }); });
  edit(s);
  await s.clock.advance(QUIET_MS);                            // the save begins
  edit(s);                                                    // an edit meanwhile: the minute counts from here
  await s.clock.advance(2 * 60_000);                          // and the save takes two minutes
  s.state.outcome = async () => ({ saved: true, conflicts: 0 });
  finish();
  await flush();
  await s.clock.advance(0);
  assert.equal(s.state.saves.length, 2, 'no waiting: the edit has been unsaved for more than a minute');
});

test('the timers of the application are the real ones: one that is cleared does not fire, one that is not does, and the time is the time', async () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let cleared = false, fired = false;
  realTimers.clear(realTimers.set(() => { cleared = true; }, 10));
  realTimers.set(() => { fired = true; }, 10);
  await wait(100);
  assert.deepEqual([cleared, fired], [false, true]);
  assert.ok(Math.abs(realTimers.now() - Date.now()) < 1000);
});
