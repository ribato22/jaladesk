import test from 'node:test';
import assert from 'node:assert/strict';
import { unlink, mkdtemp, readdir, readFile, writeFile, truncate, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocument, openDocument, openRevision, saveDocument, rebase, listRevisions, recover, realFs, StoreError, type StoreFs } from '../src/documents/store.js';
import { rewrap, EnvelopeError } from '../src/documents/envelope.js';

const kdf = { logN: 14, r: 8, p: 1 };
const text = (s: string) => Buffer.from(s, 'utf8');
const workdir = () => mkdtemp(join(tmpdir(), 'rwdoc-'));
const later = { now: () => Date.now() + 120_000 }; // a clock far enough ahead to treat leftovers of a dead process as stale

test('create, reopen, save and reopen again', async () => {
  const path = join(await workdir(), 'a.rwdoc');
  await createDocument(path, text('v0'), 'pw', { kdf });
  const { handle, plaintext } = await openDocument(path, 'pw');
  assert.equal(plaintext.toString(), 'v0');
  await saveDocument(handle, text('v1'));
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v1');
  await assert.rejects(createDocument(path, text('x'), 'pw', { kdf }), (e: unknown) => e instanceof StoreError && e.code === 'exists');
  await assert.rejects(openDocument(path, 'wrong'), (e: unknown) => e instanceof EnvelopeError && e.code === 'auth');
});

test('another writer is never overwritten silently: the save conflicts, rebase returns their version, then the save goes through', async () => {
  const path = join(await workdir(), 'a.rwdoc');
  await createDocument(path, text('base'), 'pw', { kdf });
  const a = (await openDocument(path, 'pw')).handle;
  const b = (await openDocument(path, 'pw')).handle;
  await saveDocument(b, text('from b'));
  await assert.rejects(saveDocument(a, text('from a')), (e: unknown) => e instanceof StoreError && e.code === 'conflict');
  assert.equal((await rebase(a)).toString(), 'from b');
  await saveDocument(a, text('merged'));
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'merged');
});

test('a password change by another writer is reported as rekeyed, not as a conflict that could be forced', async () => {
  const path = join(await workdir(), 'a.rwdoc');
  await createDocument(path, text('base'), 'pw', { kdf });
  const a = (await openDocument(path, 'pw')).handle;
  await writeFile(path, await rewrap(await readFile(path), 'pw', 'new', { kdf }));
  await assert.rejects(rebase(a), (e: unknown) => e instanceof StoreError && e.code === 'rekeyed');
});

// A fake file system that dies at operation number failAt and then does nothing more, like a killed process.
class Crash extends Error {}
function crashingFs(base: StoreFs, failAt: number): { fs: StoreFs; crashed: () => boolean } {
  let count = 0;
  let dead = false;
  const step = () => { count++; if (dead || count === failAt) { dead = true; throw new Crash('simulated process death'); } };
  const wrap = <A extends unknown[], R>(f: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => { step(); return f(...args); };
  return {
    crashed: () => dead,
    fs: {
      open: async (p, flags, mode) => {
        step();
        const h = await base.open(p, flags, mode);
        return {
          writeFile: async (d) => { step(); return h.writeFile(d); },
          sync: async () => { step(); return h.sync(); },
          close: async () => { await h.close(); step(); },
        };
      },
      readFile: wrap(base.readFile), link: wrap(base.link), rename: wrap(base.rename), unlink: wrap(base.unlink), mkdir: wrap(base.mkdir), readdir: wrap(base.readdir),
      copyFile: wrap(base.copyFile), syncDir: wrap(base.syncDir), stat: wrap(base.stat),
    },
  };
}

test('wherever a save stops the head is valid and saving resumes after explicit fixture-only orphan recovery', async () => {
  let crashPoints = 0;
  for (let failAt = 1; failAt < 200; failAt++) {
    const path = join(await workdir(), 'a.rwdoc');
    await createDocument(path, text('old'), 'pw', { kdf });
    const { handle } = await openDocument(path, 'pw');
    const harness = crashingFs(realFs, failAt);
    let died = false;
    try { await saveDocument(handle, text('new'), { fs: harness.fs }); } catch (e) { if (!(e instanceof Crash || (e instanceof StoreError && e.cause instanceof Crash))) throw e; died = true; }
    died = harness.crashed();
    if (died) crashPoints++;
    const orphanTemps=(await readdir(join(path,'..'))).filter(n=>n.endsWith('.tmp'));
    const reopened = await openDocument(path, 'pw', later);
    assert.ok(['old', 'new'].includes(reopened.plaintext.toString()), `crash point ${failAt}: the document is ${reopened.plaintext.toString()}`);
    assert.deepEqual((await readdir(join(path,'..'))).filter(n=>n.endsWith('.tmp')),orphanTemps,'opening never unlinks a writer temp');
    // This fixture's writer is stopped; explicit offline recovery is not product auto-reclamation.
    for(const name of orphanTemps)await unlink(join(path,'..',name));
    await unlink(path+'.lock').catch(()=>undefined);
    await saveDocument(reopened.handle, text('after'), later);
    assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'after');
    if (!died) break;
  }
  assert.ok(crashPoints >= 8, `only ${crashPoints} crash points were exercised`);
});

test('the newest revisions are kept and older ones pruned', async () => {
  const path = join(await workdir(), 'a.rwdoc');
  await createDocument(path, text('v0'), 'pw', { kdf });
  const { handle } = await openDocument(path, 'pw');
  let tick = 1_700_000_000_000;
  for (let i = 1; i <= 5; i++) await saveDocument(handle, text(`v${i}`), { keepRevisions: 3, now: () => (tick += 1000) });
  const names = await listRevisions(path);
  assert.equal(names.length, 3);
  const contents: string[] = [];
  for (const name of names) contents.push((await openRevision(path, 'pw', name)).toString());
  assert.deepEqual(contents.sort(), ['v2', 'v3', 'v4']);
});

test('a damaged main file is recoverable from a revision, and the damaged file is kept aside', async () => {
  const path = join(await workdir(), 'a.rwdoc');
  await createDocument(path, text('v0'), 'pw', { kdf });
  const { handle } = await openDocument(path, 'pw');
  await saveDocument(handle, text('v1'));
  await truncate(path, 60);
  await assert.rejects(openDocument(path, 'pw'), EnvelopeError);
  const [newest] = await listRevisions(path);
  const restored = await recover(path, 'pw', newest!);
  assert.equal(restored.plaintext.toString(), 'v0');
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v0');
  assert.ok((await readdir(join(path, '..'))).some((n) => n.includes('.broken-')));
  await assert.rejects(recover(path, 'pw', '../../etc/passwd'), StoreError);
});

test('fresh and stale locks both stay busy until an explicit offline owner recovery', async () => {
  const path = join(await workdir(), 'a.rwdoc');
  await createDocument(path, text('v0'), 'pw', { kdf });
  const { handle } = await openDocument(path, 'pw');
  await writeFile(`${path}.lock`, '{}');
  await assert.rejects(saveDocument(handle, text('v1')), (e: unknown) => e instanceof StoreError && e.code === 'busy');
  const old = new Date(Date.now() - 120_000);
  await utimes(`${path}.lock`, old, old);
  await assert.rejects(saveDocument(handle,text('v1')), (e:unknown)=>e instanceof StoreError&&e.code==='busy');
  assert.equal((await openDocument(path,'pw')).plaintext.toString(),'v0');
  await unlink(path+'.lock'); // The fixture owns this stopped writer; this is explicit offline recovery.
  await saveDocument(handle, text('v1'));
  assert.equal((await openDocument(path, 'pw')).plaintext.toString(), 'v1');
  assert.deepEqual((await readdir(join(path, '..'))).filter((n) => n.endsWith('.lock')), []);
});
