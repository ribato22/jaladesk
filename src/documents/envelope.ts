// Portable encrypted container (format version 1): one password slot wraps a random 256-bit document key (DEK);
// every save derives a fresh payload key from the DEK (HKDF, random salt) and encrypts with AES-256-GCM under a random nonce.
// Only primitives that the pinned Electron 44.7.2 (BoringSSL) really provides are used: scrypt, AES-256-GCM and HKDF
// (Argon2id and ChaCha20-Poly1305 are NOT available there, measured 2026-10-19). Layout, little-endian:
//   0   4  magic "RWDX"      4  2  format version      6  1  flags (0)      7  1  slot count (1)
//   8  80  slot: type(1)=1 password-scrypt, logN(1), r(1), p(1), salt(16), wrapNonce(12), wrapped DEK(32), wrapTag(16)
//  88  48  payload header: saveSalt(32), payloadNonce(12), ciphertextLength(4)
// 136   n  ciphertext, then 16 bytes GCM tag. The AAD of the payload is bytes 0..136; the AAD of the wrap is bytes 0..8 plus slot bytes 0..20.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt as scryptCallback, type ScryptOptions } from 'node:crypto';

export const FIXED_BYTES = 8;
export const SLOT_BYTES = 80;
export const PAYLOAD_HEADER_BYTES = 48;
export const HEADER_BYTES = FIXED_BYTES + SLOT_BYTES + PAYLOAD_HEADER_BYTES;
export const TAG_BYTES = 16;
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_PASSWORD_BYTES = 1024;
export const MAX_KDF_MEMORY = 256 * 1024 * 1024;
export const FORMAT_VERSION = 1;
const MAGIC = Buffer.from('RWDX', 'ascii');
const SLOT_PASSWORD_SCRYPT = 1;
const PAYLOAD_INFO = Buffer.from('rwdoc-v1 payload', 'ascii');

export type KdfParams = { logN: number; r: number; p: number };
export const DEFAULT_KDF: KdfParams = { logN: 17, r: 8, p: 1 }; // 128 MiB, about 0.26 s measured under Electron on arm64

export type EnvelopeErrorCode =
  | 'bad-magic' | 'unsupported-version' | 'bad-header' | 'truncated' | 'bad-length' | 'kdf-params' | 'bad-password' | 'auth' | 'disposed';
export class EnvelopeError extends Error {
  constructor(readonly code: EnvelopeErrorCode, message: string) { super(message); this.name = 'EnvelopeError'; }
}

export function checkKdf(kdf: KdfParams): void {
  const ok = Number.isInteger(kdf.logN) && kdf.logN >= 14 && kdf.logN <= 22 && Number.isInteger(kdf.r) && kdf.r >= 1 && kdf.r <= 16
    && Number.isInteger(kdf.p) && kdf.p >= 1 && kdf.p <= 4 && 128 * 2 ** kdf.logN * kdf.r <= MAX_KDF_MEMORY;
  if (!ok) throw new EnvelopeError('kdf-params', 'KDF parameters outside the accepted range');
}

function passwordBytes(password: string): Buffer {
  const bytes = Buffer.from(password.normalize('NFC'), 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_PASSWORD_BYTES) throw new EnvelopeError('bad-password', 'Password must be 1 to 1024 bytes');
  return bytes;
}

function derive(password: Buffer, salt: Buffer, kdf: KdfParams): Promise<Buffer> {
  const N = 2 ** kdf.logN;
  const options: ScryptOptions = { N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.r * (N + kdf.p + 2) };
  return new Promise((resolve, reject) => scryptCallback(password, salt, 32, options, (error, key) => (error ? reject(error) : resolve(key))));
}

function gcm(key: Buffer, nonce: Buffer, aad: Buffer, data: Buffer): { out: Buffer; tag: Buffer } {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const out = Buffer.concat([cipher.update(data), cipher.final()]);
  return { out, tag: cipher.getAuthTag() };
}

function ungcm(key: Buffer, nonce: Buffer, aad: Buffer, data: Buffer, tag: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new EnvelopeError('auth', 'Wrong password or damaged file');
  }
}

function payloadKey(dek: Buffer, saveSalt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', dek, saveSalt, PAYLOAD_INFO, 32));
}

// The part of the file that identifies the key: fixed header plus slot. A document keeps it unchanged across saves.
function head(file: Buffer): Buffer { return file.subarray(0, FIXED_BYTES + SLOT_BYTES); }

function parseHeader(file: Uint8Array): { head: Buffer; slot: Buffer; saveSalt: Buffer; nonce: Buffer; length: number; header: Buffer; ciphertext: Buffer; tag: Buffer } {
  const buffer = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (buffer.length < FIXED_BYTES) throw new EnvelopeError('truncated', 'File too short');
  if (!buffer.subarray(0, 4).equals(MAGIC)) throw new EnvelopeError('bad-magic', 'Not a workspace document');
  if (buffer.readUInt16LE(4) !== FORMAT_VERSION) throw new EnvelopeError('unsupported-version', 'Format version not supported');
  if (buffer[6] !== 0 || buffer[7] !== 1) throw new EnvelopeError('bad-header', 'Unexpected flags or slot count');
  if (buffer.length < HEADER_BYTES + TAG_BYTES) throw new EnvelopeError('truncated', 'File too short');
  const slot = buffer.subarray(FIXED_BYTES, FIXED_BYTES + SLOT_BYTES);
  if (slot[0] !== SLOT_PASSWORD_SCRYPT) throw new EnvelopeError('bad-header', 'Unknown slot type');
  checkKdf({ logN: slot[1], r: slot[2], p: slot[3] });
  const base = FIXED_BYTES + SLOT_BYTES;
  const length = buffer.readUInt32LE(base + 44);
  if (length > MAX_PAYLOAD_BYTES) throw new EnvelopeError('bad-length', 'Payload larger than the accepted maximum');
  if (buffer.length !== HEADER_BYTES + length + TAG_BYTES) throw new EnvelopeError(buffer.length < HEADER_BYTES + length + TAG_BYTES ? 'truncated' : 'bad-length', 'Payload length does not match the file size');
  return {
    head: head(buffer), slot, saveSalt: buffer.subarray(base, base + 32), nonce: buffer.subarray(base + 32, base + 44), length,
    header: buffer.subarray(0, HEADER_BYTES), ciphertext: buffer.subarray(HEADER_BYTES, HEADER_BYTES + length), tag: buffer.subarray(HEADER_BYTES + length),
  };
}

function build(headBytes: Buffer, dek: Buffer, plaintext: Uint8Array): Buffer {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new EnvelopeError('bad-length', 'Document larger than the accepted maximum');
  const saveSalt = randomBytes(32);
  const nonce = randomBytes(12);
  const lengthField = Buffer.alloc(4);
  lengthField.writeUInt32LE(plaintext.length, 0);
  const header = Buffer.concat([headBytes, saveSalt, nonce, lengthField]);
  const key = payloadKey(dek, saveSalt);
  try {
    const { out, tag } = gcm(key, nonce, header, Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength));
    return Buffer.concat([header, out, tag]);
  } finally {
    key.fill(0);
  }
}

// Created only by seal() and open(), so a key can never be paired with a slot it does not belong to.
export class Unlocked {
  #dek: Buffer | undefined;
  readonly #head: Buffer;
  constructor(dek: Buffer, headBytes: Buffer) { this.#dek = dek; this.#head = Buffer.from(headBytes); }
  #key(): Buffer {
    if (!this.#dek) throw new EnvelopeError('disposed', 'The document key was disposed');
    return this.#dek;
  }
  /** Encrypt a new revision without running the KDF: fresh salt and nonce, same slot. */
  seal(plaintext: Uint8Array): Buffer { return build(this.#head, this.#key(), plaintext); }
  /** Decrypt a file that carries this key's slot (for a reload after another writer saved with the same password). */
  open(file: Uint8Array): Buffer {
    const parts = parseHeader(file);
    if (!parts.head.equals(this.#head)) throw new EnvelopeError('auth', 'The file was re-keyed; the password is needed again');
    const key = payloadKey(this.#key(), parts.saveSalt);
    try { return ungcm(key, parts.nonce, parts.header, parts.ciphertext, parts.tag); } finally { key.fill(0); }
  }
  /** The raw document key, for the OS-keystore cache only: treat it exactly like the password. */
  exportKey(): Buffer { return Buffer.from(this.#key()); }
  dispose(): void { this.#dek?.fill(0); this.#dek = undefined; }
}

export async function seal(plaintext: Uint8Array, password: string, options: { kdf?: KdfParams } = {}): Promise<{ file: Buffer; unlocked: Unlocked }> {
  const kdf = options.kdf ?? DEFAULT_KDF;
  checkKdf(kdf);
  const pw = passwordBytes(password);
  const dek = randomBytes(32);
  const salt = randomBytes(16);
  const wrapNonce = randomBytes(12);
  const fixed = Buffer.alloc(FIXED_BYTES);
  MAGIC.copy(fixed, 0);
  fixed.writeUInt16LE(FORMAT_VERSION, 4);
  fixed[6] = 0;
  fixed[7] = 1;
  const slotHead = Buffer.concat([Buffer.from([SLOT_PASSWORD_SCRYPT, kdf.logN, kdf.r, kdf.p]), salt]);
  const kek = await derive(pw, salt, kdf);
  pw.fill(0);
  try {
    const { out, tag } = gcm(kek, wrapNonce, Buffer.concat([fixed, slotHead]), dek);
    const headBytes = Buffer.concat([fixed, slotHead, wrapNonce, out, tag]);
    return { file: build(headBytes, dek, plaintext), unlocked: new Unlocked(dek, headBytes) };
  } finally {
    kek.fill(0);
  }
}

export async function open(file: Uint8Array, password: string): Promise<{ plaintext: Buffer; unlocked: Unlocked }> {
  const parts = parseHeader(file); // validates magic, version, bounds and the KDF cost BEFORE any scrypt runs
  const pw = passwordBytes(password);
  const kek = await derive(pw, parts.slot.subarray(4, 20), { logN: parts.slot[1], r: parts.slot[2], p: parts.slot[3] });
  pw.fill(0);
  let dek: Buffer;
  try {
    const wrapAad = Buffer.concat([parts.header.subarray(0, FIXED_BYTES), parts.slot.subarray(0, 20)]);
    dek = ungcm(kek, parts.slot.subarray(20, 32), wrapAad, parts.slot.subarray(32, 64), parts.slot.subarray(64, 80));
  } finally {
    kek.fill(0);
  }
  const unlocked = new Unlocked(dek, parts.head);
  try {
    return { plaintext: unlocked.open(file), unlocked };
  } catch (error) {
    unlocked.dispose();
    throw error;
  }
}

/** Change the password: opens with the old one, then seals a NEW file with a new document key, salt and slot. */
export async function rewrap(file: Uint8Array, oldPassword: string, newPassword: string, options: { kdf?: KdfParams } = {}): Promise<Buffer> {
  const opened = await open(file, oldPassword);
  opened.unlocked.dispose();
  const next = await seal(opened.plaintext, newPassword, options);
  next.unlocked.dispose();
  opened.plaintext.fill(0);
  return next.file;
}

/** Identifies the key a file needs: it changes when the password is changed (new document key and slot). */
export function keyFingerprint(file: Uint8Array): string { return createHash('sha256').update(parseHeader(file).head).digest('hex'); }

/** Open with a cached document key instead of a password; a key that does not belong to the file is rejected like a wrong password. */
export function resume(file: Uint8Array, key: Uint8Array): { plaintext: Buffer; unlocked: Unlocked } {
  const unlocked = new Unlocked(Buffer.from(key), parseHeader(file).head);
  try { return { plaintext: unlocked.open(file), unlocked }; } catch (error) { unlocked.dispose(); throw error; }
}
