import test from 'node:test';
import assert from 'node:assert/strict';
import { electronSecretBox, type SafeStorageLike } from '../src/documents/safestorage.js';

const fake = (over: Partial<SafeStorageLike> = {}): SafeStorageLike => ({
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`SEALED:${plain}`),
  decryptString: (blob) => blob.toString().replace(/^SEALED:/, ''),
  ...over,
});

test('keys survive the round trip through safeStorage, which only ever sees text', () => {
  const box = electronSecretBox(fake());
  const key = Buffer.from([0, 255, 1, 254, 10, 13]);
  const blob = box.seal(key);
  assert.ok(!blob.includes(key), 'the raw key bytes are not in the sealed blob');
  assert.deepEqual(box.open(blob), key);
});

test('an unavailable keystore, including the Linux basic_text fallback, is reported and refuses to seal', () => {
  assert.equal(electronSecretBox(fake({ isEncryptionAvailable: () => false })).available(), false);
  const weak = electronSecretBox(fake({ getSelectedStorageBackend: () => 'basic_text' }));
  assert.equal(weak.available(), false);
  assert.throws(() => weak.seal(Buffer.from('x')), /not available/);
  assert.equal(electronSecretBox(fake({ getSelectedStorageBackend: () => 'gnome_libsecret' })).available(), true);
});
