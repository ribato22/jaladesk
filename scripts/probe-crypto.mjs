// Prints what this runtime's crypto offers and exits 1 when a REQUIRED primitive is missing. Run it under plain Node and under the
// Electron that ships the app, because Electron's BoringSSL offers less than Node's OpenSSL:
//   node scripts/probe-crypto.mjs
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/probe-crypto.mjs
import { argon2Sync, createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto';

const attempt = (fn) => { try { fn(); return true; } catch { return false; } };
const key = Buffer.alloc(32, 2);
const nonce = Buffer.alloc(12, 3);
const required = {
  'aes-256-gcm': () => { const c = createCipheriv('aes-256-gcm', key, nonce); const ct = Buffer.concat([c.update('x'), c.final()]); const d = createDecipheriv('aes-256-gcm', key, nonce); d.setAuthTag(c.getAuthTag()); d.update(ct); d.final(); },
  'scrypt N=2^17 r=8': () => scryptSync('pw', Buffer.alloc(16, 1), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }),
  'hkdf-sha256': () => hkdfSync('sha256', key, Buffer.alloc(16), Buffer.from('x'), 32),
  'randomBytes': () => randomBytes(32),
};
const optional = {
  'argon2id': () => argon2Sync('argon2id', { message: Buffer.from('pw'), nonce: Buffer.alloc(16, 1), parallelism: 1, tagLength: 32, memory: 65536, passes: 3 }),
  'chacha20-poly1305': () => { const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 }); c.update('x'); c.final(); },
};
const result = {
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  required: Object.fromEntries(Object.entries(required).map(([name, fn]) => [name, attempt(fn)])),
  optional: Object.fromEntries(Object.entries(optional).map(([name, fn]) => [name, attempt(fn)])),
};
console.log(JSON.stringify(result));
process.exit(Object.values(result.required).every(Boolean) ? 0 : 1);
