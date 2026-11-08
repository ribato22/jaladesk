import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, rewrap, EnvelopeError, FIXED_BYTES, SLOT_BYTES } from '../src/documents/envelope.js';

const fast = { logN: 14, r: 8, p: 1 }; // lowest accepted cost; production default is logN 17
const bytes = (s: string) => Buffer.from(s, 'utf8');
const isAuth = (e: unknown) => e instanceof EnvelopeError && e.code === 'auth';

test('round trip: the plaintext comes back only with the right password', async () => {
  const { file } = await seal(bytes('{"a":1}'), 'correct horse', { kdf: fast });
  const opened = await open(file, 'correct horse');
  assert.equal(opened.plaintext.toString(), '{"a":1}');
  await assert.rejects(open(file, 'wrong'), isAuth);
});

test('every single flipped bit of the file is rejected: header, slot, nonce, ciphertext and tag', async () => {
  const { file } = await seal(bytes('x'.repeat(40)), 'pw', { kdf: fast });
  for (let i = 0; i < file.length; i++) {
    const bad = Buffer.from(file);
    bad[i] ^= 0x01;
    await assert.rejects(open(bad, 'pw'), EnvelopeError, `byte ${i} was accepted`);
  }
});

test('truncation at any length and trailing bytes are rejected', async () => {
  const { file } = await seal(bytes('hello'), 'pw', { kdf: fast });
  for (let n = 0; n < file.length; n++) await assert.rejects(open(file.subarray(0, n), 'pw'), EnvelopeError, `length ${n}`);
  await assert.rejects(open(Buffer.concat([file, Buffer.from([0])]), 'pw'), EnvelopeError);
});

test('an untrusted header cannot make the opener burn memory or time: the KDF cost is checked before any scrypt', async () => {
  const { file } = await seal(bytes('hello'), 'pw', { kdf: fast });
  const evil = Buffer.from(file);
  evil[FIXED_BYTES + 1] = 31; // logN byte of the slot
  const started = Date.now();
  await assert.rejects(open(evil, 'pw'), (e: unknown) => e instanceof EnvelopeError && e.code === 'kdf-params');
  assert.ok(Date.now() - started < 200, 'the check must not run scrypt');
  await assert.rejects(seal(bytes('x'), 'pw', { kdf: { logN: 13, r: 8, p: 1 } }), (e: unknown) => e instanceof EnvelopeError && e.code === 'kdf-params');
});

test('magic and version are checked first', async () => {
  const { file } = await seal(bytes('hello'), 'pw', { kdf: fast });
  const badMagic = Buffer.from(file); badMagic[0] = 0x58;
  await assert.rejects(open(badMagic, 'pw'), (e: unknown) => e instanceof EnvelopeError && e.code === 'bad-magic');
  const future = Buffer.from(file); future.writeUInt16LE(2, 4);
  await assert.rejects(open(future, 'pw'), (e: unknown) => e instanceof EnvelopeError && e.code === 'unsupported-version');
});

test('saving again with the unlocked key skips the KDF, uses a fresh salt and nonce, and the old password still opens it', async () => {
  const { file, unlocked } = await seal(bytes('one'), 'pw', { kdf: fast });
  const started = Date.now();
  const second = unlocked.seal(bytes('two'));
  assert.ok(Date.now() - started < 50, 'no KDF on a re-save');
  assert.notDeepEqual(second.subarray(FIXED_BYTES + SLOT_BYTES), file.subarray(FIXED_BYTES + SLOT_BYTES));
  assert.equal((await open(second, 'pw')).plaintext.toString(), 'two');
  assert.equal(unlocked.open(second).toString(), 'two');
  const third = unlocked.seal(bytes('two'));
  assert.notDeepEqual(third, second, 'the same plaintext is never encrypted to the same bytes twice');
});

test('a disposed key can no longer seal or open', async () => {
  const { file, unlocked } = await seal(bytes('one'), 'pw', { kdf: fast });
  unlocked.dispose();
  assert.throws(() => unlocked.seal(bytes('x')), EnvelopeError);
  assert.throws(() => unlocked.open(file), EnvelopeError);
});

test('changing the password re-keys the file; the old password stops working', async () => {
  const { file } = await seal(bytes('secret'), 'old', { kdf: fast });
  const next = await rewrap(file, 'old', 'new', { kdf: fast });
  assert.equal((await open(next, 'new')).plaintext.toString(), 'secret');
  await assert.rejects(open(next, 'old'), isAuth);
  await assert.rejects(rewrap(file, 'not-old', 'new', { kdf: fast }), isAuth);
});

test('passwords are Unicode-normalised, and empty or oversized ones are refused', async () => {
  const { file } = await seal(bytes('x'), 'é', { kdf: fast }); // e + combining acute
  assert.equal((await open(file, 'é')).plaintext.toString(), 'x'); // precomposed é
  await assert.rejects(seal(bytes('x'), '', { kdf: fast }), (e: unknown) => e instanceof EnvelopeError && e.code === 'bad-password');
  await assert.rejects(seal(bytes('x'), 'a'.repeat(1025), { kdf: fast }), (e: unknown) => e instanceof EnvelopeError && e.code === 'bad-password');
});

test('an empty document seals and opens', async () => {
  const { file } = await seal(Buffer.alloc(0), 'pw', { kdf: fast });
  assert.equal((await open(file, 'pw')).plaintext.length, 0);
});
