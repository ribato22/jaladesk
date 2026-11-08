import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTO_SPACING_MS, KEEP_REVISIONS, MAX_REVISION_BYTES, MIN_REVISIONS, createDocument, listRevisions, openDocument, openRevision, openRevisionWithKey, realFs, revisionTime, saveDocument, StoreError, type StoreFs } from '../src/documents/store.js';
import { rewrap } from '../src/documents/envelope.js';

const kdf = { logN: 14, r: 8, p: 1 };
const text = (s: string) => Buffer.from(s, 'utf8');
const workdir = () => mkdtemp(join(tmpdir(), 'rwdoc-'));
const MINUTE = 60_000;
const contentsOf = async (path: string) => Promise.all((await listRevisions(path)).map(async (name) => (await openRevision(path, 'pw', name)).toString()));

async function started(first = 'v00') {
  const path = join(await workdir(), 'a.rwdoc');
  await createDocument(path, text(first), 'pw', { kdf });
  return { path, handle: (await openDocument(path, 'pw')).handle };
}

test('twenty revisions are kept unless it is said otherwise: the twenty newest', async () => {
  const { path, handle } = await started();
  let tick = 1_700_000_000_000;
  for (let i = 1; i <= 23; i++) await saveDocument(handle, text(`v${String(i).padStart(2, '0')}`), { now: () => (tick += 1000) });
  const kept = await contentsOf(path);
  assert.equal(kept.length, 20);
  assert.deepEqual([kept[0], kept[19]], ['v22', 'v03'], 'the file before each of the 23 saves was kept: v00 to v22, and the three oldest are gone');
});

test('the revisions are held to a size as well: the oldest go first, and the three newest stay however large they are', async () => {
  const { path, handle } = await started();
  let tick = 1_700_000_000_000;
  const save = (i: number, options: { maxRevisionBytes?: number; keepRevisions?: number } = {}) => saveDocument(handle, text(`v${String(i).padStart(2, '0')}`), { now: () => (tick += 1000), ...options });
  for (let i = 1; i <= 8; i++) await save(i);
  const [newest] = await listRevisions(path);
  const size = (await stat(join(`${path}.revisions`, newest!))).size;
  await save(9, { maxRevisionBytes: size * 5 + 10 });
  assert.deepEqual(await contentsOf(path), ['v08', 'v07', 'v06', 'v05', 'v04'], 'five of them fit');
  await save(10, { maxRevisionBytes: 1 });
  assert.deepEqual(await contentsOf(path), ['v09', 'v08', 'v07'], 'nothing fits: the three newest stay');
  await save(11, { maxRevisionBytes: 1, keepRevisions: 2 });
  assert.deepEqual(await contentsOf(path), ['v10', 'v09'], 'and never more than the number that is asked for');
});

test('an automatic save keeps the file it replaces only when the newest revision is old enough; a save that the person asked for always does', async () => {
  const { path, handle } = await started('v0');
  const t = 1_700_000_000_000;
  const save = (s: string, at: number, auto: boolean) => saveDocument(handle, text(s), { now: () => at, ...(auto ? { auto: true } : {}) });
  await save('v1', t, false);
  assert.deepEqual(await contentsOf(path), ['v0'], 'asked for: the file it replaced is kept');
  await save('v2', t + 1 * MINUTE, true);
  await save('v3', t + 9 * MINUTE, true);
  assert.deepEqual(await contentsOf(path), ['v0'], 'automatic, and the newest revision is nine minutes old: the history is not spent');
  await save('v4', t + 11 * MINUTE, true);
  assert.deepEqual(await contentsOf(path), ['v3', 'v0'], 'eleven minutes: the file it replaced is kept');
  await save('v5', t + 11 * MINUTE + 1000, false);
  assert.deepEqual(await contentsOf(path), ['v4', 'v3', 'v0'], 'asked for: always');
  await save('v6', t + 12 * MINUTE, true);
  assert.deepEqual(await contentsOf(path), ['v4', 'v3', 'v0'], 'one minute after the newest');
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v6', 'the document itself is saved every time');
});

test('the time that an automatic save waits is a setting, and a clock that went back does not stop the revisions', async () => {
  const { path, handle } = await started('v0');
  const t = 1_700_000_000_000;
  await saveDocument(handle, text('v1'), { now: () => t, auto: true });
  await saveDocument(handle, text('v2'), { now: () => t + MINUTE, auto: true });
  assert.deepEqual(await contentsOf(path), ['v0'], 'the first automatic save has no revision before it: its file is kept; the second is a minute later');
  await saveDocument(handle, text('v3'), { now: () => t + 3 * MINUTE, auto: true, autoSpacingMs: 2 * MINUTE });
  assert.deepEqual(await contentsOf(path), ['v2', 'v0'], 'two minutes is enough when that is the setting');
  await saveDocument(handle, text('v4'), { now: () => t - 86_400_000, auto: true });
  assert.equal((await listRevisions(path)).length, 3, 'a revision from the future is not a reason to keep nothing');
});

test('the time of a revision is read from its name', async () => {
  const { path, handle } = await started();
  await saveDocument(handle, text('v1'), { now: () => 1_700_000_000_123 });
  const [name] = await listRevisions(path);
  assert.equal(revisionTime(name!), 1_700_000_000_123);
  for (const bad of ['', 'a.rwdoc', '20231114T221320123Z-abc.rwdoc', '../20231114T221320123Z-0123456789ab.rwdoc']) assert.ok(Number.isNaN(revisionTime(bad)), bad);
});

test('a revision opens with the key of the open document, without the password; a name that is not a revision, a revision that is not there and one sealed with another key are told apart', async () => {
  const { path, handle } = await started('v0');
  await saveDocument(handle, text('v1'));
  const [name] = await listRevisions(path);
  assert.equal((await openRevisionWithKey(handle, name!)).toString(), 'v0');
  await saveDocument(handle, text('v2'));
  assert.equal((await openRevisionWithKey(handle, name!)).toString(), 'v0', 'saving again does not change it');
  const code = async (promise: Promise<unknown>) => { try { await promise; return 'opened'; } catch (e) { return e instanceof StoreError ? e.code : String(e); } };
  assert.equal(await code(openRevisionWithKey(handle, '../../etc/passwd')), 'bad-revision');
  assert.equal(await code(openRevisionWithKey(handle, '20200101T000000000Z-000000000000.rwdoc')), 'missing');
  const other = join(await workdir(), 'b.rwdoc');
  await createDocument(other, text('other'), 'pw', { kdf });
  await copyFile(other, join(`${path}.revisions`, '20200101T000000000Z-111111111111.rwdoc'));
  assert.equal(await code(openRevisionWithKey(handle, '20200101T000000000Z-111111111111.rwdoc')), 'rekeyed', 'it was sealed with the key of another document');
});

test('the numbers that the plan states are the ones in the code: twenty revisions, three that always stay, 256 MiB, ten minutes', () => {
  assert.deepEqual([KEEP_REVISIONS, MIN_REVISIONS, MAX_REVISION_BYTES, AUTO_SPACING_MS], [20, 3, 256 * 1024 * 1024, 10 * MINUTE]);
});

test('the spacing is exactly the setting: ten minutes keeps the file, a millisecond less does not, and a revision of this very millisecond counts as a revision', async () => {
  const { path, handle } = await started('v0');
  const t = 1_700_000_000_000;
  const auto = (s: string, at: number) => saveDocument(handle, text(s), { now: () => at, auto: true });
  await saveDocument(handle, text('v1'), { now: () => t });                 // v0 is kept, at t
  await auto('v2', t);                                                      // the newest revision is of this very millisecond: nothing is kept
  assert.deepEqual(await contentsOf(path), ['v0'], 'age 0 is an age');
  await auto('v3', t + 10 * MINUTE - 1);
  assert.deepEqual(await contentsOf(path), ['v0'], 'a millisecond short of ten minutes');
  await auto('v4', t + 10 * MINUTE);
  assert.deepEqual(await contentsOf(path), ['v3', 'v0'], 'ten minutes: the file is kept');
});

test('the size that the revisions may weigh is a budget that can be used up exactly', async () => {
  const { path, handle } = await started();
  let tick = 1_700_000_000_000;
  for (let i = 1; i <= 8; i++) await saveDocument(handle, text(`v${String(i).padStart(2, '0')}`), { now: () => (tick += 1000) });
  const names = await listRevisions(path);
  const sizes = await Promise.all(names.map(async (name) => (await stat(join(`${path}.revisions`, name))).size));
  const exact = sizes.slice(0, 5).reduce((sum, size) => sum + size, 0);
  await saveDocument(handle, text('v09'), { now: () => (tick += 1000), maxRevisionBytes: exact + sizes[0]! });   // the revision that this save makes is as large as the newest was
  assert.deepEqual(await contentsOf(path), ['v08', 'v07', 'v06', 'v05', 'v04', 'v03'], 'the budget of six revisions is used up exactly');
});

test('a revision that is stamped in the future does not stop the spacing for good: a save by a timer a moment later keeps nothing again', async () => {
  const { path, handle } = await started('v0');
  const t = 1_700_000_000_000;
  await saveDocument(handle, text('v1'), { now: () => t });                           // v0 is kept, at t
  await saveDocument(handle, text('v2'), { now: () => t - 86_400_000, auto: true }); // the clock is a day back: no revision is younger than the spacing, and v1 is kept
  const kept = (await listRevisions(path)).length;
  assert.equal(kept, 2);
  await saveDocument(handle, text('v3'), { now: () => t - 86_400_000 + 1000, auto: true });
  assert.equal((await listRevisions(path)).length, kept, 'the revision of a second ago counts, not the one from tomorrow');
});

test('the revision that a save has just made is never the one that goes, whatever the clock says', async () => {
  const { path, handle } = await started('v00');
  let tick = 1_700_000_000_000;
  for (let i = 1; i <= 22; i++) await saveDocument(handle, text(`v${String(i).padStart(2, '0')}`), { now: () => (tick += MINUTE) });
  assert.equal((await listRevisions(path)).length, 20);
  await saveDocument(handle, text('v23'), { now: () => 1_600_000_000_000 });           // the clock was set back by years
  const kept = await contentsOf(path);
  assert.equal(kept.length, 20);
  assert.ok(kept.includes('v22'), 'the file that the save replaced is kept');
});

test('a save whose rename fails does not leave copies for a retry to repeat, and does not cost the oldest revisions', async () => {
  const { path, handle } = await started('v0');
  let tick = 1_700_000_000_000;
  for (let i = 1; i <= 5; i++) await saveDocument(handle, text(`v${i}`), { now: () => (tick += 1000), keepRevisions: 5 });
  assert.deepEqual(await contentsOf(path), ['v4', 'v3', 'v2', 'v1', 'v0']);
  const failing: StoreFs = { ...realFs, rename: async (from, to) => { if (to === path) throw Object.assign(new Error('in use'), { code: 'EPERM' }); return realFs.rename(from, to); } };
  for (let i = 0; i < 3; i++) await assert.rejects(saveDocument(handle, text('x'), { now: () => (tick += 1000), keepRevisions: 5, fs: failing }));
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v5', 'the document is as it was');
  assert.deepEqual(await contentsOf(path), ['v5', 'v4', 'v3', 'v2', 'v1', 'v0'], 'the file is kept once, and nothing was let go of while the save had not happened');
  await saveDocument(handle, text('v6'), { now: () => (tick += 1000), keepRevisions: 5 });
  assert.deepEqual(await contentsOf(path), ['v5', 'v4', 'v3', 'v2', 'v1'], 'the save that happens keeps that same file once more, and then the oldest goes');
});

test('a folder of revisions that cannot be read is told, not taken for one with nothing in it; one that is not there has no revisions', async () => {
  const { path } = await started();
  assert.deepEqual(await listRevisions(path), []);
  const denied: StoreFs = { ...realFs, readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  await assert.rejects(listRevisions(path, { fs: denied }), (e: unknown) => e instanceof StoreError && e.code === 'io');
});

test('a revision that is damaged is told as damaged, and one that cannot be read for another reason as an error of the disk', async () => {
  const { path, handle } = await started('v0');
  await saveDocument(handle, text('v1'));
  const [name] = await listRevisions(path);
  const file = join(`${path}.revisions`, name!);
  const unharmed = await readFile(file);
  const bytes = Buffer.from(unharmed);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(file, bytes);
  await assert.rejects(openRevisionWithKey(handle, name!), (e: unknown) => e instanceof StoreError && e.code === 'damaged', 'the key is the right one: the file is what is wrong');
  const deaf: StoreFs = { ...realFs, readFile: async (target: string) => { if (target === path) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return realFs.readFile(target); } };
  await assert.rejects(openRevisionWithKey(handle, name!, { fs: deaf }), (e: unknown) => e instanceof StoreError && e.code === 'damaged', 'whether the document itself can be read has nothing to do with it');
  await writeFile(file, unharmed);
  assert.equal((await openRevisionWithKey(handle, name!)).toString(), 'v0');
  const denied: StoreFs = { ...realFs, readFile: async (target: string) => { if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return realFs.readFile(target); } };
  await assert.rejects(openRevisionWithKey(handle, name!, { fs: denied }), (e: unknown) => e instanceof StoreError && e.code === 'io');
});

test('only a whole name is the name of a revision: nothing may follow it', async () => {
  const { path, handle } = await started('v0');
  await saveDocument(handle, text('v1'));
  const [name] = await listRevisions(path);
  for (const bad of [`${name}/../../x`, `${name}x`, `x${name}`, `${name}\n`]) {
    assert.ok(Number.isNaN(revisionTime(bad)), bad);
    await assert.rejects(openRevisionWithKey(handle, bad), (e: unknown) => e instanceof StoreError && e.code === 'bad-revision', bad);
  }
});

test('a copy that was cut short (the process died while the revision was written) is never taken for the revision: the next save makes a whole one, and nothing of the dead copy is left', async () => {
  const { path, handle } = await started('v0');
  let dead = false;
  const dying: StoreFs = {                                // the process is killed half-way through the copy: nothing more happens, not even the clean-up
    ...realFs,
    copyFile: async (from, to) => {
      const bytes = await readFile(from);
      await writeFile(to, bytes.subarray(0, bytes.length >> 1));
      dead = true;
      throw new Error('killed');
    },
    unlink: async (target) => { if (dead) throw new Error('killed'); return realFs.unlink(target); },
  };
  await assert.rejects(saveDocument(handle, text('v1'), { fs: dying }), /killed/);
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v0', 'the document is as it was');
  assert.deepEqual(await listRevisions(path), [], 'half a file is not a revision');
  assert.equal((await readdir(`${path}.revisions`)).length, 1, 'the dead copy is still there');
  await assert.rejects(saveDocument(handle,text('v1'),{lockStaleMs:0}),(e:unknown)=>e instanceof StoreError&&e.code==='busy');
  await unlink(path+'.lock'); // The fixture's writer is stopped: explicit offline recovery, never age-only reclamation.
  await saveDocument(handle,text('v1'));
  assert.deepEqual(await contentsOf(path), ['v0'], 'the next save keeps the file, whole');
  assert.deepEqual((await readdir(`${path}.revisions`)).filter((n) => !n.endsWith('.rwdoc')), [], 'and the leftover of the dead copy is cleaned');
});

test('revisions that are stamped in the future (the clock was set back) do not crowd the present out: three of today survive twenty from next year', async () => {
  const { path, handle } = await started('v00');
  const year = 365 * 24 * 60 * MINUTE;
  let tick = 1_700_000_000_000 + year;                  // a clock that is a year ahead
  for (let i = 1; i <= 21; i++) await saveDocument(handle, text(`a${String(i).padStart(2, '0')}`), { now: () => (tick += 1000) });
  assert.equal((await listRevisions(path)).length, 20);
  tick = 1_700_000_000_000;                             // and now it is set right
  for (let i = 1; i <= 3; i++) await saveDocument(handle, text(`p${i}`), { now: () => (tick += 1000) });
  const names = await listRevisions(path);
  assert.equal(names.length, 20, 'the history is still twenty long');
  assert.equal(names.filter((n) => revisionTime(n) < 1_700_000_000_000 + year / 2).length, 3, 'and the three revisions of the present are all in it');
});

test('a revision that another key sealed is told as sealed with another key, also when the file on disk is under that key too (the password was changed elsewhere and a save kept it)', async () => {
  const { path, handle } = await started('v0');          // `handle` holds the key of the old password
  await writeFile(path, await rewrap(await readFile(path), 'pw', 'new', { kdf }));
  const other = (await openDocument(path, 'new')).handle;
  await saveDocument(other, text('v1'));                 // the file that this save replaces is under the new key, and it is kept
  const [name] = await listRevisions(path);
  await assert.rejects(openRevisionWithKey(handle, name!), (e: unknown) => e instanceof StoreError && e.code === 'rekeyed', 'the key of this handle is not the one of the revision');
  assert.equal((await openRevisionWithKey(other, name!)).toString(), 'v0', 'and whoever holds the new key reads it');
});

test('a rename that fails once because another program holds the file is tried again; one that fails for another reason is not; one that keeps failing is given up after four tries', async () => {
  const { path, handle } = await started('v0');
  const failing = (code: string, failures: number) => {
    let n = 0;
    const fs: StoreFs = { ...realFs, rename: async (from, to) => { if (to === path && n++ < failures) throw Object.assign(new Error(code), { code }); return realFs.rename(from, to); } };
    return { fs, count: () => n };
  };
  const codeOf = (e: unknown) => (e as { code?: string }).code;
  const once = failing('EPERM', 1);
  await saveDocument(handle, text('v1'), { fs: once.fs });
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v1');
  assert.equal(once.count(), 2, 'one failure and the try that worked');
  const full = failing('ENOSPC', 99);
  await assert.rejects(saveDocument(handle, text('v2'), { fs: full.fs }), (e: unknown) => codeOf(e) === 'ENOSPC');
  assert.equal(full.count(), 1, 'a disk that is full is not tried again');
  const stuck = failing('EBUSY', 99);
  await assert.rejects(saveDocument(handle, text('v3'), { fs: stuck.fs }), (e: unknown) => codeOf(e) === 'EBUSY');
  assert.equal(stuck.count(), 4, 'one try and three more');
});

test('what goes wrong after the file is in place does not fail the save: a folder of revisions that cannot be read, a directory that cannot be synced', async () => {
  const { path, handle } = await started('v0');
  let tick = 1_700_000_000_000;
  let placed = false;
  const unreadable: StoreFs = {
    ...realFs,
    rename: async (from, to) => { await realFs.rename(from, to); if (to === path) placed = true; },
    readdir: async (dir) => { if (placed && dir.endsWith('.revisions')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return realFs.readdir(dir); },
  };
  await saveDocument(handle, text('v1'), { fs: unreadable, now: () => (tick += 1000) });
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v1', 'saved, though the pruning could not look');
  await saveDocument(handle, text('v2'), { fs: { ...realFs, syncDir: async () => { throw new Error('no sync'); } }, now: () => (tick += 1000) });
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v2');
  await saveDocument(handle, text('v3'), { now: () => (tick += 1000) });       // the handle knows the file that was written: this is an ordinary save
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v3');
});

test('a revision that cannot be deleted does not stop the older ones from being deleted, and one that cannot be measured does not count as a heavy one', async () => {
  const { path, handle } = await started('v0');
  let tick = 1_700_000_000_000;
  for (let i = 1; i <= 4; i++) await saveDocument(handle, text(`v${i}`), { now: () => (tick += 1000) });
  const before = await listRevisions(path);              // v3, v2, v1, v0
  assert.equal(before.length, 4);
  const held: StoreFs = { ...realFs, unlink: async (target) => { if (target.endsWith(before[1]!)) throw Object.assign(new Error('held'), { code: 'EPERM' }); return realFs.unlink(target); } };
  await saveDocument(handle, text('v5'), { now: () => (tick += 1000), keepRevisions: 2, fs: held });
  const after = await listRevisions(path);
  assert.deepEqual(after.filter((n) => before.includes(n)), [before[0], before[1]], 'the one that is held stays, the older ones are gone');
  assert.equal(after.length, 3);
  const blind: StoreFs = { ...realFs, stat: async (target) => { if (target.includes('.revisions')) throw new Error('no stat'); return realFs.stat(target); } };
  for (let i = 0; i < 4; i++) await saveDocument(handle, text(`w${i}`), { now: () => (tick += 1000), fs: blind });
  assert.ok((await listRevisions(path)).length >= 6, 'nothing is thrown away because its size is not known');
});

test('a save that fails leaves no temporary file, and an open leaves alone a temporary file that a live save may still be writing', async () => {
  const { path, handle } = await started('v0');
  const full: StoreFs = { ...realFs, rename: async (from, to) => { if (to === path) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); return realFs.rename(from, to); } };
  await assert.rejects(saveDocument(handle, text('v1'), { fs: full }));
  assert.deepEqual((await readdir(join(path, '..'))).filter((n) => n.endsWith('.tmp')), [], 'the temporary file of the failed save is gone');
  const fresh = `${path}.abcdef.tmp`;
  await writeFile(fresh, 'being written');
  await openDocument(path, 'pw');
  assert.equal(await readFile(fresh, 'utf8'), 'being written', 'one of a moment ago may belong to a live save: it stays');
  await openDocument(path, 'pw', { now: () => Date.now() + 120_000 });
  assert.equal(await readFile(fresh,'utf8'),'being written','age or a changed clock cannot authorize a reader to unlink a writer temp');
  await unlink(fresh); // Explicit cleanup of this fixture's own file.
});

test('a copy that fails (the disk is full) leaves nothing of itself, and the save fails with the document as it was', async () => {
  const { path, handle } = await started('v0');
  const full: StoreFs = {
    ...realFs,
    copyFile: async (from, to) => {
      const bytes = await readFile(from);
      await writeFile(to, bytes.subarray(0, bytes.length >> 1));
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    },
  };
  await assert.rejects(saveDocument(handle, text('v1'), { fs: full }), (e: unknown) => (e as { code?: string }).code === 'ENOSPC');
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v0', 'the document is as it was');
  assert.deepEqual(await readdir(`${path}.revisions`), [], 'and the half of a copy is not left in the folder');
});

test('the revision that a save has just made is never the one that goes, also when the clock went back between the copy and the pruning', async () => {
  const { path, handle } = await started('v00');
  const t0 = 1_700_000_000_000;
  let tick = t0 - 10 * 24 * 60 * MINUTE;
  for (let i = 1; i <= 21; i++) await saveDocument(handle, text(`v${String(i).padStart(2, '0')}`), { now: () => (tick += 1000) });
  assert.equal((await listRevisions(path)).length, 20);
  let calls = 0;
  const flaky = () => (++calls <= 2 ? t0 : t0 - 24 * 60 * MINUTE);   // the lock and the name of the revision see the time; the pruning sees it a day earlier
  await saveDocument(handle, text('v22'), { now: flaky });
  const names = await listRevisions(path);
  assert.equal(names.length, 20, 'the history is still twenty long');
  assert.equal(revisionTime(names[0]!), t0, 'and the newest revision is the one that this save made: it is not counted as one from the future and let go of');
  assert.equal((await contentsOf(path))[0], 'v21', 'it holds the file that the save replaced');
});
