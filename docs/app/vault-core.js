/**
 * JalaDesk Web Companion — Zero-Knowledge Vault Crypto, RFC 6238 TOTP,
 * Deterministic Tombstone-Aware Merger, Cloud Sync Transports, and Sealed Storage.
 *
 * Pure zero-dependency ES module runnable in both modern browsers and Node 24+
 * using standard `globalThis.crypto.subtle` and `globalThis.fetch`.
 */

export const JALADESK_VAULT_FORMAT_ID = 'jaladesk-encrypted-vault-v1';
export const JDESK_SYNC_SCHEMA_ID = 'jdesk-sync-v1';
export const PBKDF2_HMAC_SHA256_KDF = 'PBKDF2-HMAC-SHA256';
export const AES_256_GCM_CIPHER = 'AES-256-GCM';
export const DEFAULT_PBKDF2_ITERATIONS = 100_000;
export const VAULT_SYNC_SCHEMA_VERSION = 2;
export const MAX_TOMBSTONES = 500;

export const GOOGLE_DRIVE_DEFAULT_API_BASE_URL = 'https://www.googleapis.com';
export const GOOGLE_DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_WEB_OAUTH_SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email profile';
export const GOOGLE_GSI_CLIENT_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_DRIVE_PRIMARY_VAULT_FILE = 'jaladesk-vault-v1.jvault';
export const GOOGLE_DRIVE_ALT_VAULT_FILE = 'jaladesk_vault_sync_v1.jdesk';
export const GOOGLE_DRIVE_APPDATA_MISSING_MESSAGE =
  'Google Drive AppData permission is missing. Reconnect your Google account and tick "See, create, and delete its own configuration data in your Google Drive".';

export const GITHUB_DEFAULT_API_BASE_URL = 'https://api.github.com';
export const GITHUB_PRIMARY_GIST_FILE = 'jaladesk-vault.jvault';
export const GITHUB_ALT_GIST_FILE = 'jaladesk_vault_sync.jdesk';

export const SEALED_VAULT_STORAGE_KEY = 'jaladesk.web.vault.sealed.v1';
export const UI_PREFS_STORAGE_KEY = 'jaladesk.web.vault.prefs.v1';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const VAULT_AAD_BYTES = TEXT_ENCODER.encode(JALADESK_VAULT_FORMAT_ID);
const JDESK_ALT_AAD_BYTES = TEXT_ENCODER.encode(JDESK_SYNC_SCHEMA_ID);
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const ALLOWED_UI_PREF_KEYS = new Set([
  'autoLockSeconds',
  'syncProvider',
  'vaultAuthMode',
  'useCustomPassphrase',
  'googleClientId',
  'googleAccountEmail',
  'googleAccountName',
  'githubGistId',
  'webdavUrl',
  'webdavUsername',
  'gatewayUrl',
  'lastSyncedAtMs',
  'activeView',
]);

export class VaultCoreError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {number | null} [statusCode]
   */
  constructor(message, code = 'vault-core-error', statusCode = null) {
    super(message);
    this.name = 'VaultCoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function getWebCrypto() {
  const c = globalThis.crypto;
  if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
    throw new VaultCoreError('WebCrypto API (crypto.subtle) is unavailable in this environment.', 'crypto-unavailable');
  }
  return c;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    const slice = arr.subarray(i, Math.min(i + chunkSize, arr.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  if (typeof b64 !== 'string') {
    throw new VaultCoreError('Invalid base64 encoding.', 'invalid-envelope');
  }
  const normalized = b64.replace(/\s+/g, '');
  try {
    const binary = atob(normalized);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    throw new VaultCoreError('Malformed base64 field in encrypted Vault envelope.', 'invalid-envelope');
  }
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function concatBytes(first, second) {
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}

function randomBytes(length) {
  const out = new Uint8Array(length);
  getWebCrypto().getRandomValues(out);
  return out;
}

function randomHex(byteLength) {
  const bytes = randomBytes(byteLength);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function derivePbkdf2AesKey(passphrase, saltBytes, iterations, usages) {
  const { subtle } = getWebCrypto();
  const passphraseBytes = TEXT_ENCODER.encode(passphrase);
  try {
    const baseKey = await subtle.importKey('raw', passphraseBytes, { name: 'PBKDF2' }, false, ['deriveKey']);
    return await subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usages,
    );
  } finally {
    passphraseBytes.fill(0);
  }
}

// ============================================================================
// 1. Byte-for-Byte Compatible WebCrypto `jdesk-sync-v1` / `.jvault` Engine
// ============================================================================

/**
 * Derives the deterministic Google-account-bound E2EE passphrase matching
 * JalaDesk Desktop (`cloud-sync-service.ts`) and Mobile (`vault_cloud_sync.dart`).
 *
 * @param {string} email
 * @returns {string}
 */
export function deriveGoogleAccountBoundPassphrase(email) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalized) {
    throw new VaultCoreError('Google account email is required to derive bound passphrase.', 'missing-email');
  }
  return `jaladesk-gdrive-e2ee-v1:${normalized}`;
}

/**
 * Seals a vault payload JSON object into the cross-platform `jaladesk-encrypted-vault-v1`
 * / `jdesk-sync-v1` AES-256-GCM envelope using WebCrypto PBKDF2-HMAC-SHA256 (100,000 iter).
 *
 * @param {Record<string, unknown>} payload
 * @param {string} passphrase
 * @param {{ iterations?: number }} [options]
 * @returns {Promise<string>}
 */
export async function sealVaultEnvelope(payload, passphrase, options = {}) {
  if (!isPlainObject(payload)) {
    throw new VaultCoreError('Vault payload must be a plain JSON object.', 'invalid-payload');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new VaultCoreError('Passphrase cannot be empty for encrypted backup.', 'weak-passphrase');
  }
  const iterations =
    typeof options.iterations === 'number' && Number.isInteger(options.iterations) && options.iterations >= 1000
      ? options.iterations
      : DEFAULT_PBKDF2_ITERATIONS;

  const { subtle } = getWebCrypto();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(payload));
  try {
    const key = await derivePbkdf2AesKey(passphrase, salt, iterations, ['encrypt']);
    const encryptedBuf = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: VAULT_AAD_BYTES,
        tagLength: 128,
      },
      key,
      plaintext,
    );
    const combined = new Uint8Array(encryptedBuf);
    const authTag = combined.subarray(combined.length - 16);
    const ivBase64 = bytesToBase64(iv);
    const envelope = {
      format: JALADESK_VAULT_FORMAT_ID,
      schema: JDESK_SYNC_SCHEMA_ID,
      kdf: PBKDF2_HMAC_SHA256_KDF,
      iterations,
      cipher: AES_256_GCM_CIPHER,
      salt: bytesToBase64(salt),
      iv: ivBase64,
      nonce: ivBase64,
      ciphertext: bytesToBase64(combined),
      mac: bytesToBase64(authTag),
      exportedAt: new Date().toISOString(),
    };
    return JSON.stringify(envelope, null, 2);
  } finally {
    plaintext.fill(0);
  }
}

function parseEnvelopeJson(rawEnvelopeJson) {
  if (typeof rawEnvelopeJson !== 'string' || rawEnvelopeJson.trim().length === 0) {
    throw new VaultCoreError('Invalid Vault snapshot JSON object.', 'invalid-envelope');
  }
  let decoded;
  try {
    decoded = JSON.parse(rawEnvelopeJson.replace(/^\uFEFF/, ''));
  } catch {
    throw new VaultCoreError('Invalid Vault snapshot JSON object.', 'invalid-envelope');
  }
  if (!isPlainObject(decoded)) {
    throw new VaultCoreError('Invalid Vault snapshot JSON object.', 'invalid-envelope');
  }

  const hasMobileFormat = decoded.format === JALADESK_VAULT_FORMAT_ID;
  const hasJdeskSchema = decoded.schema === JDESK_SYNC_SCHEMA_ID;
  if (!hasMobileFormat && !hasJdeskSchema) {
    throw new VaultCoreError('Unrecognized encrypted Vault envelope version.', 'unsupported-envelope');
  }
  if (typeof decoded.kdf === 'string' && decoded.kdf !== PBKDF2_HMAC_SHA256_KDF) {
    throw new VaultCoreError(`Unsupported KDF: ${decoded.kdf}`, 'unsupported-kdf');
  }
  const iterations =
    typeof decoded.iterations === 'number' && Number.isInteger(decoded.iterations) && decoded.iterations >= 1000
      ? decoded.iterations
      : DEFAULT_PBKDF2_ITERATIONS;

  const rawSalt = typeof decoded.salt === 'string' ? decoded.salt.trim() : '';
  const rawIv =
    typeof decoded.iv === 'string' && decoded.iv.trim().length > 0
      ? decoded.iv.trim()
      : typeof decoded.nonce === 'string'
        ? decoded.nonce.trim()
        : '';
  if (
    typeof decoded.iv === 'string' &&
    typeof decoded.nonce === 'string' &&
    decoded.iv.trim() !== decoded.nonce.trim()
  ) {
    throw new VaultCoreError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
  }
  const rawCiphertext = typeof decoded.ciphertext === 'string' ? decoded.ciphertext.trim() : '';
  const rawMac = typeof decoded.mac === 'string' && decoded.mac.trim().length > 0 ? decoded.mac.trim() : null;

  if (!rawSalt || !rawIv || !rawCiphertext) {
    throw new VaultCoreError('Encrypted Vault envelope is missing required fields.', 'invalid-envelope');
  }

  const salt = base64ToBytes(rawSalt);
  const iv = base64ToBytes(rawIv);
  const ciphertext = base64ToBytes(rawCiphertext);
  const mac = rawMac ? base64ToBytes(rawMac) : null;

  if (salt.length < 8 || iv.length !== 12) {
    throw new VaultCoreError('Encrypted Vault envelope has invalid salt or IV length.', 'invalid-envelope');
  }
  if (mac !== null && mac.length !== 16) {
    throw new VaultCoreError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
  }

  return {
    hasMobileFormat,
    hasJdeskSchema,
    iterations,
    salt,
    iv,
    ciphertext,
    mac,
  };
}

async function tryAesGcmOpen(key, iv, combinedCiphertextWithTag, aad) {
  const { subtle } = getWebCrypto();
  try {
    const algo = aad
      ? { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }
      : { name: 'AES-GCM', iv, tagLength: 128 };
    const clearBuf = await subtle.decrypt(algo, key, combinedCiphertextWithTag);
    return new Uint8Array(clearBuf);
  } catch {
    return null;
  }
}

/**
 * Opens and verifies a `jaladesk-encrypted-vault-v1` / `jdesk-sync-v1` envelope
 * sealed by JalaDesk Desktop, Mobile, or Web PWA.
 *
 * @param {string} rawEnvelopeJson
 * @param {string} passphrase
 * @returns {Promise<Record<string, unknown>>}
 */
export async function openVaultEnvelope(rawEnvelopeJson, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new VaultCoreError('Enter your Sync Passphrase to decrypt the cloud vault.', 'empty-passphrase');
  }
  const parts = parseEnvelopeJson(rawEnvelopeJson);
  const key = await derivePbkdf2AesKey(passphrase, parts.salt, parts.iterations, ['decrypt']);

  let clearBytes = null;
  if (parts.hasMobileFormat) {
    if (parts.ciphertext.length < 16) {
      throw new VaultCoreError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
    }
    const embeddedTag = parts.ciphertext.subarray(parts.ciphertext.length - 16);
    if (parts.mac !== null && !constantTimeEqual(embeddedTag, parts.mac)) {
      const detachedCombined = concatBytes(parts.ciphertext, parts.mac);
      clearBytes =
        (await tryAesGcmOpen(key, parts.iv, detachedCombined, VAULT_AAD_BYTES)) ??
        (await tryAesGcmOpen(key, parts.iv, detachedCombined, null));
      if (!clearBytes) {
        throw new VaultCoreError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
      }
    } else {
      clearBytes = await tryAesGcmOpen(key, parts.iv, parts.ciphertext, VAULT_AAD_BYTES);
    }
  } else if (parts.hasJdeskSchema) {
    if (parts.mac !== null) {
      if (
        parts.ciphertext.length >= 16 &&
        constantTimeEqual(parts.ciphertext.subarray(parts.ciphertext.length - 16), parts.mac)
      ) {
        clearBytes =
          (await tryAesGcmOpen(key, parts.iv, parts.ciphertext, VAULT_AAD_BYTES)) ??
          (await tryAesGcmOpen(key, parts.iv, parts.ciphertext, null)) ??
          (await tryAesGcmOpen(key, parts.iv, parts.ciphertext, JDESK_ALT_AAD_BYTES));
      }
      if (!clearBytes) {
        const detachedCombined = concatBytes(parts.ciphertext, parts.mac);
        clearBytes =
          (await tryAesGcmOpen(key, parts.iv, detachedCombined, null)) ??
          (await tryAesGcmOpen(key, parts.iv, detachedCombined, JDESK_ALT_AAD_BYTES)) ??
          (await tryAesGcmOpen(key, parts.iv, detachedCombined, VAULT_AAD_BYTES));
      }
    } else if (parts.ciphertext.length >= 16) {
      clearBytes =
        (await tryAesGcmOpen(key, parts.iv, parts.ciphertext, VAULT_AAD_BYTES)) ??
        (await tryAesGcmOpen(key, parts.iv, parts.ciphertext, null));
    }
  }

  if (!clearBytes) {
    throw new VaultCoreError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
  }

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(TEXT_DECODER.decode(clearBytes));
  } catch {
    throw new VaultCoreError('Decrypted payload is not valid JSON.', 'invalid-payload');
  } finally {
    clearBytes.fill(0);
  }
  if (!isPlainObject(parsedPayload)) {
    throw new VaultCoreError('Decrypted payload is not a valid Vault map.', 'invalid-payload');
  }
  return parsedPayload;
}

/**
 * Exports a normalized `.jvault` envelope (enforces minimum 4-character passphrase).
 *
 * @param {Record<string, unknown>} payload
 * @param {string} passphrase
 * @returns {Promise<string>}
 */
export async function exportEncryptedJvault(payload, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.trim().length < 4) {
    throw new VaultCoreError('Backup passphrase must be at least 4 characters.', 'weak-passphrase');
  }
  const normalized = normalizeVaultPayload(payload);
  return sealVaultEnvelope(normalized, passphrase);
}

/**
 * Imports and normalizes a `.jvault` envelope.
 *
 * @param {string} rawEnvelopeJson
 * @param {string} passphrase
 * @returns {Promise<ReturnType<typeof normalizeVaultPayload>>}
 */
export async function importEncryptedJvault(rawEnvelopeJson, passphrase) {
  const opened = await openVaultEnvelope(String(rawEnvelopeJson ?? '').trim(), passphrase);
  return normalizeVaultPayload(opened);
}

// ============================================================================
// 2. Deterministic Tombstone-Aware Merger (`syncSchema: 2`)
// ============================================================================

export function parseTombstones(raw) {
  const out = {};
  if (isPlainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const k = key.trim();
      const ts = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? '0'), 10);
      if (k.length > 0 && Number.isFinite(ts) && ts > 0) {
        out[k] = ts;
      }
    }
  }
  return out;
}

export function capTombstones(tombstones) {
  const entries = Object.entries(tombstones);
  if (entries.length <= MAX_TOMBSTONES) {
    return { ...tombstones };
  }
  entries.sort((a, b) => b[1] - a[1]);
  const capped = {};
  for (const [k, v] of entries.slice(0, MAX_TOMBSTONES)) {
    capped[k] = v;
  }
  return capped;
}

function extractMapList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (isPlainObject(item)) {
      out.push({ ...item });
    }
  }
  return out;
}

/**
 * Builds the canonical tombstone key for a deleted item across sync collections.
 *
 * @param {'hosts' | 'credentials' | 'folders' | 'totp' | 'snippets' | 'host' | 'cred' | 'folder' | 'snippet'} collection
 * @param {string} key
 * @returns {string}
 */
export function makeTombstoneKey(collection, key) {
  const cleanKey = String(key ?? '').trim();
  if (!cleanKey) {
    throw new VaultCoreError('Item key is required for tombstone.', 'invalid-tombstone-key');
  }
  switch (collection) {
    case 'hosts':
    case 'host':
      return `host:${cleanKey}`;
    case 'credentials':
    case 'cred':
      return `cred:${cleanKey}`;
    case 'folders':
    case 'folder':
      return `folder:${cleanKey}`;
    case 'totp':
      return `totp:${cleanKey}`;
    case 'snippets':
    case 'snippet':
      return `snippet:${cleanKey}`;
    default:
      throw new VaultCoreError(`Unsupported vault collection: ${collection}`, 'invalid-tombstone-collection');
  }
}

export function createEmptyVaultPayload(nowMs = Date.now()) {
  const ts = typeof nowMs === 'number' && Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
  return {
    syncSchema: VAULT_SYNC_SCHEMA_VERSION,
    updatedAtMs: ts,
    hosts: [],
    credentials: [],
    folders: [],
    totp: [],
    snippets: [],
    tombstones: {},
  };
}

/**
 * Normalizes any vault payload into the canonical `syncSchema: 2` shape matching
 * Desktop `VaultSyncPayloadMerger.normalizePayload`.
 *
 * @param {Record<string, unknown>} source
 * @param {{ nowMs?: number }} [options]
 */
export function normalizeVaultPayload(source, options = {}) {
  const safeSource = isPlainObject(source) ? source : {};
  const ts = options?.nowMs ?? Date.now();
  const tombstones = capTombstones(parseTombstones(safeSource.tombstones));
  const sourceTs =
    typeof safeSource.updatedAtMs === 'number' && Number.isFinite(safeSource.updatedAtMs)
      ? Math.trunc(safeSource.updatedAtMs)
      : 0;
  return {
    syncSchema: VAULT_SYNC_SCHEMA_VERSION,
    updatedAtMs: Math.max(ts, sourceTs),
    hosts: extractMapList(safeSource.hosts),
    credentials: extractMapList(safeSource.credentials),
    folders: extractMapList(safeSource.folders),
    totp: extractMapList(safeSource.totp),
    snippets: extractMapList(safeSource.snippets),
    tombstones,
  };
}

function mergeCollection({ localList, remoteList, keyField, tombstonePrefix, tombstones }) {
  const localByKey = new Map();
  const orderedKeys = [];

  for (const item of localList) {
    const k = String(item[keyField] ?? '').trim();
    if (!k) continue;
    if (!localByKey.has(k)) orderedKeys.push(k);
    localByKey.set(k, item);
  }

  const remoteByKey = new Map();
  for (const item of remoteList) {
    const k = String(item[keyField] ?? '').trim();
    if (!k) continue;
    if (!localByKey.has(k) && !remoteByKey.has(k)) {
      orderedKeys.push(k);
    }
    remoteByKey.set(k, item);
  }

  const merged = [];
  for (const k of orderedKeys) {
    const lItem = localByKey.get(k);
    const rItem = remoteByKey.get(k);
    const lTs =
      typeof lItem?.updatedAtMs === 'number' && Number.isFinite(lItem.updatedAtMs)
        ? Math.trunc(lItem.updatedAtMs)
        : 0;
    const rTs =
      typeof rItem?.updatedAtMs === 'number' && Number.isFinite(rItem.updatedAtMs)
        ? Math.trunc(rItem.updatedAtMs)
        : 0;
    const maxItemTs = Math.max(lTs, rTs);

    const tombKey = `${tombstonePrefix}${k}`;
    const deletedAt = tombstones[tombKey] ?? 0;
    if (deletedAt > maxItemTs) {
      continue;
    }
    if (deletedAt > 0 && maxItemTs >= deletedAt) {
      delete tombstones[tombKey];
    }

    if (lItem && rItem) {
      merged.push(rTs > lTs ? { ...rItem } : { ...lItem });
    } else if (lItem) {
      merged.push({ ...lItem });
    } else if (rItem) {
      merged.push({ ...rItem });
    }
  }
  return merged;
}

/**
 * Deterministic tombstone-aware multi-device payload merge matching Desktop & Mobile
 * `VaultSyncPayloadMerger.merge` (`syncSchema: 2`, up to 500 tombstones).
 *
 * @param {Record<string, unknown>} localPayload
 * @param {Record<string, unknown>} remotePayload
 * @param {{ nowMs?: number }} [options]
 */
export function mergeVaultPayloads(localPayload, remotePayload, options = {}) {
  const local = isPlainObject(localPayload) ? localPayload : {};
  const remote = isPlainObject(remotePayload) ? remotePayload : {};
  const ts = options?.nowMs ?? Date.now();
  const localTombs = parseTombstones(local.tombstones);
  const remoteTombs = parseTombstones(remote.tombstones);

  const unionTombstones = { ...localTombs };
  for (const [key, remoteDeletedAt] of Object.entries(remoteTombs)) {
    const prev = unionTombstones[key] ?? 0;
    if (remoteDeletedAt > prev) {
      unionTombstones[key] = remoteDeletedAt;
    }
  }

  const mergedHosts = mergeCollection({
    localList: extractMapList(local.hosts),
    remoteList: extractMapList(remote.hosts),
    keyField: 'id',
    tombstonePrefix: 'host:',
    tombstones: unionTombstones,
  });
  const mergedCreds = mergeCollection({
    localList: extractMapList(local.credentials),
    remoteList: extractMapList(remote.credentials),
    keyField: 'id',
    tombstonePrefix: 'cred:',
    tombstones: unionTombstones,
  });
  const mergedFolders = mergeCollection({
    localList: extractMapList(local.folders),
    remoteList: extractMapList(remote.folders),
    keyField: 'name',
    tombstonePrefix: 'folder:',
    tombstones: unionTombstones,
  });
  const mergedTotp = mergeCollection({
    localList: extractMapList(local.totp),
    remoteList: extractMapList(remote.totp),
    keyField: 'id',
    tombstonePrefix: 'totp:',
    tombstones: unionTombstones,
  });
  const mergedSnippets = mergeCollection({
    localList: extractMapList(local.snippets),
    remoteList: extractMapList(remote.snippets),
    keyField: 'id',
    tombstonePrefix: 'snippet:',
    tombstones: unionTombstones,
  });

  const localTopTs =
    typeof local.updatedAtMs === 'number' && Number.isFinite(local.updatedAtMs)
      ? Math.trunc(local.updatedAtMs)
      : 0;
  const remoteTopTs =
    typeof remote.updatedAtMs === 'number' && Number.isFinite(remote.updatedAtMs)
      ? Math.trunc(remote.updatedAtMs)
      : 0;

  return {
    syncSchema: VAULT_SYNC_SCHEMA_VERSION,
    updatedAtMs: Math.max(ts, Math.max(localTopTs, remoteTopTs)),
    hosts: mergedHosts,
    credentials: mergedCreds,
    folders: mergedFolders,
    totp: mergedTotp,
    snippets: mergedSnippets,
    tombstones: capTombstones(unionTombstones),
  };
}

// ============================================================================
// 3. Pure WebCrypto RFC 6238 TOTP Engine
// ============================================================================

export function parseTotpAlgorithm(raw) {
  if (typeof raw !== 'string') {
    throw new VaultCoreError('Invalid TOTP algorithm', 'invalid-totp-algorithm');
  }
  const normalized = raw.trim().toUpperCase().replace(/-/g, '');
  if (normalized === 'SHA1') return 'SHA1';
  if (normalized === 'SHA256') return 'SHA256';
  if (normalized === 'SHA512') return 'SHA512';
  throw new VaultCoreError('Unsupported TOTP algorithm', 'invalid-totp-algorithm');
}

function toWebCryptoHashName(algorithm) {
  switch (algorithm) {
    case 'SHA1':
      return 'SHA-1';
    case 'SHA256':
      return 'SHA-256';
    case 'SHA512':
      return 'SHA-512';
    default:
      throw new VaultCoreError('Unsupported TOTP algorithm', 'invalid-totp-algorithm');
  }
}

export function normalizeTotpSecretBase32(raw) {
  if (typeof raw !== 'string') {
    throw new VaultCoreError('Invalid TOTP Base32 secret', 'invalid-totp-secret');
  }
  const compact = raw.trim().replace(/[\s-]+/g, '').toUpperCase();
  if (!compact || !/^[A-Z2-7]+=*$/.test(compact)) {
    throw new VaultCoreError('Invalid TOTP Base32 secret', 'invalid-totp-secret');
  }
  const unpadded = compact.replace(/=+$/, '');
  if (unpadded.length < 2 || unpadded.length > 256) {
    throw new VaultCoreError('Invalid TOTP Base32 secret', 'invalid-totp-secret');
  }
  return unpadded;
}

export function decodeTotpSecretBase32(raw) {
  const cleaned = normalizeTotpSecretBase32(raw);
  const bytes = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of cleaned) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val < 0) {
      throw new VaultCoreError('Invalid TOTP Base32 secret', 'invalid-totp-secret');
    }
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
      buffer &= (1 << bitsLeft) - 1;
    }
  }
  if (bytes.length === 0 || bytes.length > 160) {
    throw new VaultCoreError('Invalid TOTP Base32 secret', 'invalid-totp-secret');
  }
  return new Uint8Array(bytes);
}

/**
 * Generates an RFC 6238 TOTP code via WebCrypto HMAC (`SHA1 | SHA256 | SHA512`, `6 | 8` digits, `30 | 60`s).
 *
 * @param {{ secretBase32: string, algorithm?: string, digits?: number, period?: number }} params
 * @param {number | { nowMs?: number, unixSeconds?: number }} [nowMs]
 * @returns {Promise<string>}
 */
export async function generateTotpCode(params, nowMs = Date.now()) {
  if (!params || typeof params.secretBase32 !== 'string') {
    throw new VaultCoreError('Invalid TOTP configuration', 'invalid-totp-config');
  }
  const algorithm = params.algorithm !== undefined ? parseTotpAlgorithm(params.algorithm) : 'SHA1';
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;
  if ((digits !== 6 && digits !== 8) || !Number.isInteger(period) || period < 10 || period > 120) {
    throw new VaultCoreError('Invalid TOTP configuration', 'invalid-totp-config');
  }

  let unixSeconds;
  if (typeof nowMs === 'number') {
    unixSeconds = Math.floor(nowMs / 1000);
  } else if (isPlainObject(nowMs) && typeof nowMs.unixSeconds === 'number') {
    unixSeconds = Math.floor(nowMs.unixSeconds);
  } else if (isPlainObject(nowMs) && typeof nowMs.nowMs === 'number') {
    unixSeconds = Math.floor(nowMs.nowMs / 1000);
  } else {
    unixSeconds = Math.floor(Date.now() / 1000);
  }
  if (!Number.isFinite(unixSeconds) || unixSeconds < 0 || unixSeconds > Number.MAX_SAFE_INTEGER) {
    throw new VaultCoreError('Invalid TOTP timestamp', 'invalid-totp-config');
  }

  const { subtle } = getWebCrypto();
  const keyBytes = decodeTotpSecretBase32(params.secretBase32);
  const counterBuf = new ArrayBuffer(8);
  const counterBytes = new Uint8Array(counterBuf);
  try {
    new DataView(counterBuf).setBigUint64(0, BigInt(Math.floor(unixSeconds / period)), false);
    const cryptoKey = await subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: { name: toWebCryptoHashName(algorithm) } },
      false,
      ['sign'],
    );
    const sigBuf = await subtle.sign('HMAC', cryptoKey, counterBytes);
    const digest = new Uint8Array(sigBuf);
    try {
      const offset = digest[digest.length - 1] & 0x0f;
      const binary =
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff);
      return String(binary % 10 ** digits).padStart(digits, '0');
    } finally {
      digest.fill(0);
    }
  } finally {
    keyBytes.fill(0);
    counterBytes.fill(0);
  }
}

export function formatTotpCode(code) {
  const trimmed = String(code ?? '').trim();
  if (trimmed.length === 6) return `${trimmed.slice(0, 3)} ${trimmed.slice(3)}`;
  if (trimmed.length === 8) return `${trimmed.slice(0, 4)} ${trimmed.slice(4)}`;
  return trimmed;
}

export function calculateTotpTiming(period = 30, nowMs = Date.now()) {
  if (!Number.isInteger(period) || period < 10 || period > 120 || !Number.isFinite(nowMs) || nowMs < 0) {
    throw new VaultCoreError('Invalid TOTP timing parameters', 'invalid-totp-config');
  }
  const periodMs = period * 1000;
  const wholeMs = Math.floor(nowMs);
  const elapsedMs = wholeMs % periodMs;
  const remainingMs = periodMs - elapsedMs;
  const unixSeconds = Math.floor(wholeMs / 1000);
  const remainingSeconds = period - (unixSeconds % period);
  const progressRatio = Math.max(0, Math.min(1, remainingMs / periodMs));
  const elapsedRatio = Math.max(0, Math.min(1, elapsedMs / periodMs));
  const counter = BigInt(Math.floor(unixSeconds / period));
  return {
    period,
    elapsedMs,
    remainingMs,
    remainingSeconds,
    progressRatio,
    elapsedRatio,
    counter,
  };
}

export async function evaluateTotpToken(item, nowMs = Date.now()) {
  const algorithm = item.algorithm !== undefined ? parseTotpAlgorithm(item.algorithm) : 'SHA1';
  const digits = item.digits ?? 6;
  const period = item.period ?? item.periodSeconds ?? 30;
  const timing = calculateTotpTiming(period, nowMs);
  const code = await generateTotpCode(
    { secretBase32: item.secretBase32, algorithm, digits, period },
    nowMs,
  );
  return {
    code,
    formattedCode: formatTotpCode(code),
    algorithm,
    digits,
    period,
    remainingSeconds: timing.remainingSeconds,
    remainingMs: timing.remainingMs,
    progressRatio: timing.progressRatio,
    elapsedRatio: timing.elapsedRatio,
    counter: timing.counter,
  };
}

export function parseOtpAuthUri(uri) {
  if (typeof uri !== 'string') {
    throw new VaultCoreError('Invalid otpauth URI', 'invalid-otpauth');
  }
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith('otpauth://')) {
    throw new VaultCoreError('URI must start with otpauth://', 'invalid-otpauth');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new VaultCoreError('Malformed otpauth URI', 'invalid-otpauth');
  }
  if (parsed.protocol.toLowerCase() !== 'otpauth:' || parsed.hostname.toLowerCase() !== 'totp') {
    throw new VaultCoreError('Only otpauth://totp/ URIs are supported', 'invalid-otpauth');
  }

  const rawSecret = parsed.searchParams.get('secret') ?? '';
  const decodedBytes = decodeTotpSecretBase32(rawSecret);
  decodedBytes.fill(0);
  const secretBase32 = normalizeTotpSecretBase32(rawSecret);

  const rawPath = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath).trim();
  } catch {
    throw new VaultCoreError('Malformed otpauth label encoding', 'invalid-otpauth');
  }

  let pathIssuer = '';
  let accountFromPath = decodedPath;
  const colonIdx = decodedPath.indexOf(':');
  if (colonIdx >= 0) {
    pathIssuer = decodedPath.slice(0, colonIdx).trim();
    accountFromPath = decodedPath.slice(colonIdx + 1).trim();
  }

  const queryIssuer = (parsed.searchParams.get('issuer') ?? '').trim();
  const issuer = queryIssuer || pathIssuer;
  const accountName = accountFromPath || issuer || 'Authenticator Key';
  const label = issuer ? `${issuer}:${accountName}` : accountName;

  const rawAlgo = parsed.searchParams.get('algorithm');
  const algorithm = rawAlgo !== null && rawAlgo.trim() !== '' ? parseTotpAlgorithm(rawAlgo) : 'SHA1';

  const rawDigits = parsed.searchParams.get('digits');
  let digits = 6;
  if (rawDigits !== null && rawDigits.trim() !== '') {
    const numDigits = Number(rawDigits.trim());
    if (numDigits !== 6 && numDigits !== 8) {
      throw new VaultCoreError('TOTP digits must be 6 or 8', 'invalid-otpauth');
    }
    digits = numDigits;
  }

  const rawPeriod = parsed.searchParams.get('period');
  let period = 30;
  if (rawPeriod !== null && rawPeriod.trim() !== '') {
    const numPeriod = Number(rawPeriod.trim());
    if (numPeriod !== 30 && numPeriod !== 60) {
      throw new VaultCoreError('TOTP period must be 30 or 60 seconds', 'invalid-otpauth');
    }
    period = numPeriod;
  }

  return {
    issuer,
    accountName,
    label,
    secretBase32,
    algorithm,
    digits,
    period,
  };
}

export function buildOtpAuthUri(item) {
  if (!item || typeof item.accountName !== 'string') {
    throw new VaultCoreError('Account name is required to build otpauth URI', 'invalid-otpauth');
  }
  const issuer = (item.issuer ?? '').trim();
  const accountName = item.accountName.trim() || issuer || 'Authenticator Key';
  const decoded = decodeTotpSecretBase32(item.secretBase32);
  decoded.fill(0);
  const secretBase32 = normalizeTotpSecretBase32(item.secretBase32);
  const algorithm = item.algorithm !== undefined ? parseTotpAlgorithm(item.algorithm) : 'SHA1';
  const digits = item.digits ?? 6;
  const period = item.period ?? item.periodSeconds ?? 30;
  if (digits !== 6 && digits !== 8) {
    throw new VaultCoreError('TOTP digits must be 6 or 8', 'invalid-otpauth');
  }
  if (period !== 30 && period !== 60) {
    throw new VaultCoreError('TOTP period must be 30 or 60 seconds', 'invalid-otpauth');
  }

  const pathLabel = issuer
    ? `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`
    : encodeURIComponent(accountName);
  const params = new URLSearchParams();
  params.set('secret', secretBase32);
  if (issuer) params.set('issuer', issuer);
  params.set('algorithm', algorithm);
  params.set('digits', String(digits));
  params.set('period', String(period));
  return `otpauth://totp/${pathLabel}?${params.toString()}`;
}

// ============================================================================
// 4. Zero-Knowledge Browser Cloud Sync Transports (`fetch`)
// ============================================================================

export function hasGoogleDriveAppDataScope(scopeStr) {
  if (typeof scopeStr !== 'string') return false;
  const trimmed = scopeStr.trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).includes(GOOGLE_DRIVE_APPDATA_SCOPE);
}

let cachedGsiLoadPromise = null;

/**
 * Lazily loads Google Identity Services (`https://accounts.google.com/gsi/client`) on demand.
 * Cached for the lifetime of the page; rejects cleanly offline without blocking PWA boot.
 *
 * @param {{ scriptUrl?: string, windowObj?: any, documentObj?: any }} [options]
 * @returns {Promise<any>}
 */
export function loadGoogleIdentityServicesScript(options = {}) {
  const win = options.windowObj ?? globalThis.window;
  const doc = options.documentObj ?? globalThis.document;
  const scriptUrl = (options.scriptUrl ?? GOOGLE_GSI_CLIENT_SCRIPT_URL).trim() || GOOGLE_GSI_CLIENT_SCRIPT_URL;
  const isDefaultBrowserEnv = !options.windowObj && !options.documentObj && !options.scriptUrl;

  if (win?.google?.accounts?.oauth2 && typeof win.google.accounts.oauth2.initTokenClient === 'function') {
    return Promise.resolve(win.google);
  }
  if (!doc || typeof doc.createElement !== 'function') {
    return Promise.reject(
      new VaultCoreError('Google Identity Services requires a browser document context.', 'gdrive-gsi-unavailable'),
    );
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return Promise.reject(
      new VaultCoreError(
        'Offline — reconnect to the internet to sign in with Google.',
        'gdrive-gsi-offline',
      ),
    );
  }
  if (isDefaultBrowserEnv && cachedGsiLoadPromise) {
    return cachedGsiLoadPromise;
  }

  const loadPromise = new Promise((resolve, reject) => {
    const finishReady = () => {
      if (win?.google?.accounts?.oauth2 && typeof win.google.accounts.oauth2.initTokenClient === 'function') {
        resolve(win.google);
      } else {
        if (isDefaultBrowserEnv) cachedGsiLoadPromise = null;
        reject(
          new VaultCoreError(
            'Google Identity Services loaded without OAuth2 token client support.',
            'gdrive-gsi-load-failed',
          ),
        );
      }
    };

    const failLoad = () => {
      if (isDefaultBrowserEnv) cachedGsiLoadPromise = null;
      reject(
        new VaultCoreError(
          'Unable to load Google Sign-In script. Check your network connection or content blockers and try again.',
          'gdrive-gsi-load-failed',
        ),
      );
    };

    const existing =
      typeof doc.querySelector === 'function'
        ? doc.querySelector(`script[src="${scriptUrl}"]`)
        : null;
    if (existing) {
      if (win?.google?.accounts?.oauth2 && typeof win.google.accounts.oauth2.initTokenClient === 'function') {
        resolve(win.google);
        return;
      }
      existing.addEventListener('load', finishReady, { once: true });
      existing.addEventListener('error', failLoad, { once: true });
      return;
    }

    const script = doc.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', finishReady, { once: true });
    script.addEventListener('error', failLoad, { once: true });
    const targetParent = doc.head || doc.documentElement || doc.body;
    if (!targetParent || typeof targetParent.appendChild !== 'function') {
      failLoad();
      return;
    }
    targetParent.appendChild(script);
  });

  if (isDefaultBrowserEnv) {
    cachedGsiLoadPromise = loadPromise;
  }
  return loadPromise;
}

/**
 * Launches a 1-click Google Identity Services OAuth2 browser popup and returns an ephemeral
 * in-memory access token scoped to Google Drive AppData + OpenID profile.
 *
 * @param {{
 *   clientId: string,
 *   loginHint?: string,
 *   prompt?: string,
 *   scope?: string,
 *   gsiLoader?: () => Promise<any>,
 *   windowObj?: any,
 * }} params
 * @returns {Promise<{ accessToken: string, grantedScope: string, expiresInSec: number, hasAppDataScope: boolean }>}
 */
export async function requestGoogleWebAccessToken(params) {
  const cleanClientId = typeof params?.clientId === 'string' ? params.clientId.trim() : '';
  if (!cleanClientId) {
    throw new VaultCoreError(
      'Google Web OAuth Client ID is not configured.',
      'gdrive-missing-client-id',
    );
  }
  const cleanHint = typeof params?.loginHint === 'string' ? params.loginHint.trim() : '';
  const cleanPrompt = typeof params?.prompt === 'string' ? params.prompt.trim() : '';
  const cleanScope =
    typeof params?.scope === 'string' && params.scope.trim().length > 0
      ? params.scope.trim()
      : GOOGLE_WEB_OAUTH_SCOPES;

  const gsi =
    typeof params?.gsiLoader === 'function'
      ? await params.gsiLoader()
      : await loadGoogleIdentityServicesScript({ windowObj: params?.windowObj });

  const win = params?.windowObj ?? globalThis.window;
  const oauth2 =
    gsi?.accounts?.oauth2 ??
    gsi?.oauth2 ??
    (typeof gsi?.initTokenClient === 'function' ? gsi : null) ??
    win?.google?.accounts?.oauth2 ??
    null;

  if (!oauth2 || typeof oauth2.initTokenClient !== 'function') {
    throw new VaultCoreError(
      'Google Identity Services OAuth2 token client is unavailable.',
      'gdrive-gsi-unavailable',
    );
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const settleResolve = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    try {
      const tokenClient = oauth2.initTokenClient({
        client_id: cleanClientId,
        scope: cleanScope,
        include_granted_scopes: true,
        ...(cleanHint ? { hint: cleanHint } : {}),
        prompt: cleanPrompt,
        callback: (response) => {
          if (!response || typeof response !== 'object') {
            settleReject(new VaultCoreError('Google Sign-In returned an empty response.', 'gdrive-oauth-error'));
            return;
          }
          if (response.error) {
            const code = String(response.error);
            if (code === 'access_denied') {
              settleReject(
                new VaultCoreError('Google Sign-In was cancelled or access was denied.', 'gdrive-oauth-denied'),
              );
              return;
            }
            const desc =
              typeof response.error_description === 'string' && response.error_description.trim()
                ? `: ${response.error_description.trim()}`
                : '';
            settleReject(new VaultCoreError(`Google Sign-In error (${code})${desc}`, 'gdrive-oauth-error'));
            return;
          }
          const accessToken = typeof response.access_token === 'string' ? response.access_token.trim() : '';
          if (!accessToken) {
            settleReject(new VaultCoreError('Google Sign-In did not return an access token.', 'gdrive-oauth-error'));
            return;
          }
          const grantedScope = typeof response.scope === 'string' ? response.scope.trim() : '';
          const rawExpires = Number(response.expires_in);
          const expiresInSec = Number.isFinite(rawExpires) && rawExpires > 0 ? Math.trunc(rawExpires) : 3600;
          settleResolve({
            accessToken,
            grantedScope,
            expiresInSec,
            hasAppDataScope: hasGoogleDriveAppDataScope(grantedScope),
          });
        },
        error_callback: (err) => {
          const type = typeof err?.type === 'string' ? err.type : '';
          if (type === 'popup_closed') {
            settleReject(new VaultCoreError('Google Sign-In popup was closed before completing.', 'gdrive-popup-closed'));
            return;
          }
          if (type === 'popup_failed_to_open') {
            settleReject(
              new VaultCoreError(
                'Browser blocked the Google Sign-In popup. Allow popups for this site and try again.',
                'gdrive-popup-blocked',
              ),
            );
            return;
          }
          const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : type || 'unknown error';
          settleReject(new VaultCoreError(`Google Sign-In failed: ${detail}`, 'gdrive-oauth-error'));
        },
      });

      tokenClient.requestAccessToken({ prompt: cleanPrompt });
    } catch (err) {
      settleReject(
        err instanceof VaultCoreError
          ? err
          : new VaultCoreError(
              `Google Sign-In initialization failed: ${err instanceof Error ? err.message : String(err)}`,
              'gdrive-oauth-error',
            ),
      );
    }
  });
}

/**
 * Fetches the signed-in Google account's OpenID Connect identity (`email` and `displayName`)
 * using an in-memory OAuth2 access token.
 *
 * @param {string} accessToken
 * @param {{ userInfoUrl?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ email: string, displayName: string }>}
 */
export async function fetchGoogleUserInfo(accessToken, options = {}) {
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!token) {
    throw new VaultCoreError('Google OAuth access token is required to fetch account info.', 'gdrive-missing-token');
  }
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const url = (options.userInfoUrl ?? GOOGLE_USERINFO_URL).trim() || GOOGLE_USERINFO_URL;
  let res;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    throw new VaultCoreError(
      `Network error fetching Google profile: ${err instanceof Error ? err.message : String(err)}`,
      'gdrive-userinfo-network',
    );
  }
  const text = await res.text();
  if (res.status === 401) {
    throw new VaultCoreError(
      'Google session expired (HTTP 401). Sign in again to refresh authorization.',
      'gdrive-http-401',
      401,
    );
  }
  if (res.status !== 200) {
    throw new VaultCoreError(
      `Google profile lookup failed (HTTP ${res.status}).`,
      `gdrive-userinfo-http-${res.status}`,
      res.status,
    );
  }
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new VaultCoreError('Google profile endpoint returned invalid JSON.', 'gdrive-userinfo-invalid');
  }
  if (!isPlainObject(decoded)) {
    throw new VaultCoreError('Google profile endpoint returned an unexpected payload.', 'gdrive-userinfo-invalid');
  }
  const email = typeof decoded.email === 'string' ? decoded.email.trim() : '';
  const displayName =
    typeof decoded.name === 'string' && decoded.name.trim().length > 0
      ? decoded.name.trim()
      : typeof decoded.given_name === 'string' && decoded.given_name.trim().length > 0
        ? decoded.given_name.trim()
        : '';
  return { email, displayName };
}

function normalizeSyncMode(rawMode) {
  if (rawMode === 'pullOnly' || rawMode === 'pushForce' || rawMode === 'smartMerge') {
    return rawMode;
  }
  return 'smartMerge';
}

function assertSyncPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.trim().length < 4) {
    throw new VaultCoreError('Sync Passphrase must be at least 4 characters.', 'weak-passphrase');
  }
}

async function runZeroKnowledgeSync({
  mode,
  localPayload,
  passphrase,
  providerLabel,
  downloadEnvelope,
  uploadEnvelope,
  nowMs,
}) {
  assertSyncPassphrase(passphrase);
  const resolvedMode = normalizeSyncMode(mode);
  const syncOptions = typeof nowMs === 'number' ? { nowMs } : undefined;

  if (resolvedMode === 'pushForce') {
    const normalized = normalizeVaultPayload(localPayload ?? {}, syncOptions);
    const sealed = await sealVaultEnvelope(normalized, passphrase);
    await uploadEnvelope(sealed);
    return {
      payload: normalized,
      mode: resolvedMode,
      hadRemote: false,
      uploaded: true,
      syncedAtMs: nowMs ?? Date.now(),
    };
  }

  if (resolvedMode === 'pullOnly') {
    const remoteRaw = await downloadEnvelope();
    if (!remoteRaw || remoteRaw.trim().length === 0) {
      throw new VaultCoreError(`No encrypted vault found on ${providerLabel} yet.`, 'remote-vault-empty');
    }
    const opened = await openVaultEnvelope(remoteRaw, passphrase);
    const normalized = normalizeVaultPayload(opened, syncOptions);
    return {
      payload: normalized,
      mode: resolvedMode,
      hadRemote: true,
      uploaded: false,
      syncedAtMs: nowMs ?? Date.now(),
    };
  }

  const remoteRaw = await downloadEnvelope();
  const hasRemote = Boolean(remoteRaw && remoteRaw.trim().length > 0);
  const resulting = hasRemote
    ? mergeVaultPayloads(localPayload ?? {}, await openVaultEnvelope(remoteRaw, passphrase), syncOptions)
    : normalizeVaultPayload(localPayload ?? {}, syncOptions);
  const sealed = await sealVaultEnvelope(resulting, passphrase);
  await uploadEnvelope(sealed);
  return {
    payload: resulting,
    mode: resolvedMode,
    hadRemote: hasRemote,
    uploaded: true,
    syncedAtMs: nowMs ?? Date.now(),
  };
}

function formatGoogleDriveHttpError(action, statusCode, body) {
  const lower = body.toLowerCase();
  if (
    statusCode === 403 &&
    (body.includes('accessNotConfigured') ||
      lower.includes('drive api has not been used') ||
      body.includes('SERVICE_DISABLED'))
  ) {
    return new VaultCoreError(
      'Google Drive API is disabled in your Google Cloud project. Enable Google Drive API and retry.',
      'gdrive-api-disabled',
      403,
    );
  }
  if (
    statusCode === 403 &&
    (body.includes('insufficientPermissions') ||
      body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') ||
      lower.includes('insufficient authentication scopes'))
  ) {
    return new VaultCoreError(GOOGLE_DRIVE_APPDATA_MISSING_MESSAGE, 'gdrive-missing-scope', 403);
  }
  if (statusCode === 401) {
    return new VaultCoreError(
      'Google Drive session expired (HTTP 401). Sign in again to refresh authorization.',
      'gdrive-http-401',
      401,
    );
  }
  try {
    const decoded = JSON.parse(body);
    if (isPlainObject(decoded) && isPlainObject(decoded.error) && typeof decoded.error.message === 'string') {
      const msg = decoded.error.message.trim();
      if (msg) {
        return new VaultCoreError(`Google Drive ${action} failed (HTTP ${statusCode}): ${msg}`, `gdrive-http-${statusCode}`, statusCode);
      }
    }
  } catch {
    // Ignore non-JSON error body
  }
  return new VaultCoreError(`Google Drive ${action} failed (HTTP ${statusCode}).`, `gdrive-http-${statusCode}`, statusCode);
}

/**
 * Zero-Knowledge Google Drive `appDataFolder` sync over browser `fetch`.
 * Reads/writes `jaladesk-vault-v1.jvault` (with compatibility lookup for `jaladesk_vault_sync_v1.jdesk`).
 *
 * @param {{
 *   accessToken: string,
 *   localPayload: Record<string, unknown>,
 *   passphrase: string,
 *   mode?: 'smartMerge' | 'pullOnly' | 'pushForce',
 *   apiBaseUrl?: string,
 *   fileName?: string,
 *   grantedScope?: string,
 *   scope?: string,
 *   nowMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} params
 */
export async function syncWithGoogleDriveAppData(params) {
  const token = typeof params?.accessToken === 'string' ? params.accessToken.trim() : '';
  if (!token) {
    throw new VaultCoreError('Google Drive OAuth access token is required.', 'gdrive-missing-token');
  }
  const declaredScope = typeof params.grantedScope === 'string' ? params.grantedScope : params.scope;
  if (typeof declaredScope === 'string' && declaredScope.trim().length > 0 && !hasGoogleDriveAppDataScope(declaredScope)) {
    throw new VaultCoreError(GOOGLE_DRIVE_APPDATA_MISSING_MESSAGE, 'gdrive-missing-scope', 403);
  }

  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const apiBaseUrl = (params.apiBaseUrl ?? GOOGLE_DRIVE_DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '');
  const fileName = (params.fileName ?? GOOGLE_DRIVE_PRIMARY_VAULT_FILE).trim() || GOOGLE_DRIVE_PRIMARY_VAULT_FILE;
  let resolvedFileId = null;

  async function gdriveFetch(url, init = {}) {
    let res;
    try {
      res = await fetchFn(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new VaultCoreError(
        `Network error reaching Google Drive API: ${err instanceof Error ? err.message : String(err)}`,
        'gdrive-network-error',
      );
    }
    const text = await res.text();
    return { status: res.status, text };
  }

  async function findAppDataFileId() {
    const candidates =
      fileName === GOOGLE_DRIVE_PRIMARY_VAULT_FILE
        ? [GOOGLE_DRIVE_PRIMARY_VAULT_FILE, GOOGLE_DRIVE_ALT_VAULT_FILE]
        : [fileName];
    const namePredicates = candidates.map((n) => `name = '${n.replace(/'/g, "\\'")}'`).join(' or ');
    const query = candidates.length > 1 ? `(${namePredicates}) and trashed = false` : `${namePredicates} and trashed = false`;
    const url =
      `${apiBaseUrl}/drive/v3/files` +
      `?spaces=appDataFolder` +
      `&q=${encodeURIComponent(query)}` +
      `&fields=${encodeURIComponent('files(id,name,modifiedTime)')}` +
      `&pageSize=10`;

    const res = await gdriveFetch(url, { method: 'GET' });
    if (res.status !== 200) {
      throw formatGoogleDriveHttpError('lookup', res.status, res.text);
    }
    let decoded;
    try {
      decoded = JSON.parse(res.text);
    } catch {
      return null;
    }
    if (isPlainObject(decoded) && Array.isArray(decoded.files) && decoded.files.length > 0) {
      const validFiles = decoded.files.filter(isPlainObject);
      const exactPrimary = validFiles.find((f) => f.name === fileName && typeof f.id === 'string' && f.id.trim());
      if (exactPrimary) {
        resolvedFileId = String(exactPrimary.id).trim();
        return resolvedFileId;
      }
      const fallback = validFiles.find((f) => typeof f.id === 'string' && f.id.trim());
      if (fallback) {
        resolvedFileId = String(fallback.id).trim();
        return resolvedFileId;
      }
    }
    return null;
  }

  async function downloadEnvelope() {
    const fileId = await findAppDataFileId();
    if (!fileId) return null;
    const url = `${apiBaseUrl}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    const res = await gdriveFetch(url, { method: 'GET' });
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw formatGoogleDriveHttpError('download', res.status, res.text);
    }
    return res.text.trim().length === 0 ? null : res.text;
  }

  async function uploadEnvelope(sealedJson) {
    const existingId = resolvedFileId ?? (await findAppDataFileId());
    if (existingId) {
      const patchUrl = `${apiBaseUrl}/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=media`;
      const res = await gdriveFetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: sealedJson,
      });
      if (res.status < 200 || res.status >= 300) {
        throw formatGoogleDriveHttpError('update', res.status, res.text);
      }
      resolvedFileId = existingId;
      return;
    }

    const boundary = `jaladesk_appdata_${Date.now()}_${randomHex(4)}`;
    const metadataJson = JSON.stringify({
      name: fileName,
      parents: ['appDataFolder'],
    });
    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadataJson}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${sealedJson}\r\n` +
      `--${boundary}--`;

    const createUrl = `${apiBaseUrl}/upload/drive/v3/files?uploadType=multipart`;
    const res = await gdriveFetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    });
    if (res.status !== 200 && res.status !== 201) {
      throw formatGoogleDriveHttpError('upload', res.status, res.text);
    }
    try {
      const created = JSON.parse(res.text);
      if (isPlainObject(created) && typeof created.id === 'string' && created.id.trim()) {
        resolvedFileId = created.id.trim();
      }
    } catch {
      // Non-JSON create response is acceptable when HTTP 200/201 succeeded
    }
  }

  const result = await runZeroKnowledgeSync({
    mode: params.mode,
    localPayload: params.localPayload,
    passphrase: params.passphrase,
    providerLabel: 'Google Drive',
    downloadEnvelope,
    uploadEnvelope,
    nowMs: params.nowMs,
  });

  return {
    ...result,
    provider: 'googleDrive',
    fileId: resolvedFileId,
    fileName,
  };
}

/**
 * Returning-user & first-run Google Drive AppData unlock + sync coordinator.
 *
 * When a local sealed vault already exists in `vaultStore`, FIRST attempts to
 * decrypt it with `passphrase` (e.g. account-bound key) and run `smartMerge`
 * against Google Drive so pending local deletions/tombstones and newly added
 * hosts are preserved and pushed instead of overwritten by stale remote data.
 * Falls back to `pullOnly` (or initializing an empty remote vault) ONLY when no
 * local vault exists or local unlock fails (such as switching Google accounts).
 *
 * @param {{
 *   vaultStore?: SealedBrowserVaultStore,
 *   accessToken: string,
 *   grantedScope?: string,
 *   passphrase: string,
 *   apiBaseUrl?: string,
 *   fileName?: string,
 *   nowMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} params
 */
export async function unlockOrSyncGoogleVault(params) {
  const { vaultStore, accessToken, grantedScope, passphrase, apiBaseUrl, fileName, nowMs, fetchImpl } = params ?? {};
  const sharedOpts = {
    accessToken,
    grantedScope: grantedScope || undefined,
    passphrase,
    apiBaseUrl,
    fileName,
    nowMs,
    fetchImpl,
  };

  if (vaultStore && typeof vaultStore.hasSealedVault === 'function' && vaultStore.hasSealedVault()) {
    let localPayload = null;
    let unlockedLocal = false;
    try {
      localPayload = await vaultStore.unlock(passphrase);
      unlockedLocal = true;
    } catch {
      // Different Google account or prior local passphrase vault -> fall back to remote pull
      unlockedLocal = false;
    }

    if (unlockedLocal && localPayload) {
      try {
        const merged = await syncWithGoogleDriveAppData({
          ...sharedOpts,
          localPayload,
          mode: 'smartMerge',
        });
        await vaultStore.savePayload(merged.payload);
        return {
          ...merged,
          mergedLocal: true,
          createdFresh: !merged.hadRemote,
        };
      } catch (err) {
        if (typeof vaultStore.lock === 'function') {
          vaultStore.lock();
        }
        throw err;
      }
    }
  }

  let result;
  let createdFresh = false;
  try {
    result = await syncWithGoogleDriveAppData({
      ...sharedOpts,
      localPayload: createEmptyVaultPayload(),
      mode: 'pullOnly',
    });
  } catch (err) {
    if (err instanceof VaultCoreError && err.code === 'remote-vault-empty') {
      result = await syncWithGoogleDriveAppData({
        ...sharedOpts,
        localPayload: createEmptyVaultPayload(),
        mode: 'pushForce',
      });
      createdFresh = true;
    } else {
      throw err;
    }
  }

  if (vaultStore && typeof vaultStore.createVault === 'function') {
    await vaultStore.createVault(passphrase, result.payload);
  }
  return {
    ...result,
    mergedLocal: false,
    createdFresh,
  };
}

/**
 * Zero-Knowledge GitHub Secret Gist sync (`jaladesk-vault.jvault`) over browser `fetch`.
 *
 * @param {{
 *   token: string,
 *   gistId?: string,
 *   localPayload: Record<string, unknown>,
 *   passphrase: string,
 *   mode?: 'smartMerge' | 'pullOnly' | 'pushForce',
 *   apiBaseUrl?: string,
 *   fileName?: string,
 *   nowMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} params
 */
export async function syncWithGithubGist(params) {
  const token = typeof params?.token === 'string' ? params.token.trim() : '';
  if (!token) {
    throw new VaultCoreError('Enter a GitHub Personal Access Token with gist scope.', 'github-missing-token');
  }
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const apiBaseUrl = (params.apiBaseUrl ?? GITHUB_DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '');
  const fileName = (params.fileName ?? GITHUB_PRIMARY_GIST_FILE).trim() || GITHUB_PRIMARY_GIST_FILE;
  let resolvedGistId = typeof params.gistId === 'string' && params.gistId.trim().length > 0 ? params.gistId.trim() : null;

  const candidateNames =
    fileName === GITHUB_PRIMARY_GIST_FILE ? [GITHUB_PRIMARY_GIST_FILE, GITHUB_ALT_GIST_FILE] : [fileName];

  async function githubFetch(url, init = {}, jsonBody = false) {
    let res;
    try {
      res = await fetchFn(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(jsonBody ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new VaultCoreError(
        `Network error reaching GitHub API: ${err instanceof Error ? err.message : String(err)}`,
        'github-network-error',
      );
    }
    const text = await res.text();
    return { status: res.status, text };
  }

  async function discoverExistingVaultGistId() {
    const res = await githubFetch(`${apiBaseUrl}/gists?per_page=50`, { method: 'GET' });
    if (res.status === 401 || res.status === 403) {
      throw new VaultCoreError(
        `GitHub token rejected (HTTP ${res.status}). Ensure the token has gist scope.`,
        `github-http-${res.status}`,
        res.status,
      );
    }
    if (res.status !== 200) {
      throw new VaultCoreError(`GitHub Gist list failed (HTTP ${res.status}).`, `github-http-${res.status}`, res.status);
    }
    let decoded;
    try {
      decoded = JSON.parse(res.text);
    } catch {
      return null;
    }
    if (!Array.isArray(decoded)) return null;

    let fallbackPublicMatch = null;
    for (const entry of decoded) {
      if (!isPlainObject(entry) || !isPlainObject(entry.files)) continue;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const hasVaultFile = candidateNames.some((n) => Object.hasOwn(entry.files, n));
      if (id && hasVaultFile) {
        if (entry.public !== true) {
          resolvedGistId = id;
          return id;
        }
        fallbackPublicMatch ??= id;
      }
    }
    if (fallbackPublicMatch) {
      resolvedGistId = fallbackPublicMatch;
      return fallbackPublicMatch;
    }
    return null;
  }

  async function downloadEnvelope() {
    const targetId = resolvedGistId ?? (await discoverExistingVaultGistId());
    if (!targetId) return null;

    const res = await githubFetch(`${apiBaseUrl}/gists/${encodeURIComponent(targetId)}`, { method: 'GET' });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new VaultCoreError(`GitHub token rejected (HTTP ${res.status}).`, `github-http-${res.status}`, res.status);
    }
    if (res.status !== 200) {
      throw new VaultCoreError(`GitHub Gist fetch failed (HTTP ${res.status}).`, `github-http-${res.status}`, res.status);
    }
    let decoded;
    try {
      decoded = JSON.parse(res.text);
    } catch {
      return null;
    }
    if (!isPlainObject(decoded) || !isPlainObject(decoded.files)) return null;

    for (const candidate of candidateNames) {
      const fileObj = decoded.files[candidate];
      if (isPlainObject(fileObj)) {
        const isTruncated = fileObj.truncated === true;
        const rawUrl = typeof fileObj.raw_url === 'string' ? fileObj.raw_url.trim() : '';
        if (isTruncated && rawUrl.length > 0) {
          const rawRes = await githubFetch(rawUrl, { method: 'GET' });
          if (rawRes.status === 200) {
            return rawRes.text.trim().length === 0 ? null : rawRes.text;
          }
        }
        const content = typeof fileObj.content === 'string' ? fileObj.content : '';
        return content.trim().length === 0 ? null : content;
      }
    }
    return null;
  }

  async function uploadEnvelope(sealedJson) {
    const targetId = resolvedGistId ?? (await discoverExistingVaultGistId());
    if (!targetId) {
      const createBody = JSON.stringify({
        description: 'JalaDesk Encrypted Vault (.jvault)',
        public: false,
        files: {
          [fileName]: { content: sealedJson },
        },
      });
      const res = await githubFetch(`${apiBaseUrl}/gists`, { method: 'POST', body: createBody }, true);
      if (res.status !== 201 && res.status !== 200) {
        throw new VaultCoreError(`GitHub Gist create failed (HTTP ${res.status}).`, `github-http-${res.status}`, res.status);
      }
      try {
        const decoded = JSON.parse(res.text);
        if (isPlainObject(decoded) && typeof decoded.id === 'string' && decoded.id.trim().length > 0) {
          resolvedGistId = decoded.id.trim();
        }
      } catch {
        // Ignore non-JSON body when creation succeeded
      }
      return;
    }

    const patchBody = JSON.stringify({
      description: 'JalaDesk Encrypted Vault (.jvault)',
      files: {
        [fileName]: { content: sealedJson },
      },
    });
    const res = await githubFetch(
      `${apiBaseUrl}/gists/${encodeURIComponent(targetId)}`,
      { method: 'PATCH', body: patchBody },
      true,
    );
    if (res.status !== 200) {
      throw new VaultCoreError(`GitHub Gist update failed (HTTP ${res.status}).`, `github-http-${res.status}`, res.status);
    }
    resolvedGistId = targetId;
  }

  const result = await runZeroKnowledgeSync({
    mode: params.mode,
    localPayload: params.localPayload,
    passphrase: params.passphrase,
    providerLabel: 'GitHub Gist',
    downloadEnvelope,
    uploadEnvelope,
    nowMs: params.nowMs,
  });

  return {
    ...result,
    provider: 'githubGist',
    gistId: resolvedGistId,
    fileName,
  };
}

function isLoopbackOrPrivateLanHost(hostname) {
  const lower = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower.endsWith('.local')) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Zero-Knowledge WebDAV sync (`GET`/`PUT`) over browser `fetch` with actionable CORS diagnostics.
 *
 * @param {{
 *   url: string,
 *   username?: string,
 *   password?: string,
 *   localPayload: Record<string, unknown>,
 *   passphrase: string,
 *   mode?: 'smartMerge' | 'pullOnly' | 'pushForce',
 *   nowMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} params
 */
export async function syncWithWebDav(params) {
  const rawUrl = typeof params?.url === 'string' ? params.url.trim() : '';
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new VaultCoreError('Enter a valid WebDAV .jvault URL.', 'webdav-invalid-url');
  }
  if (!parsedUrl.hostname || (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:')) {
    throw new VaultCoreError('Enter a valid WebDAV .jvault URL.', 'webdav-invalid-url');
  }
  if (parsedUrl.protocol === 'http:' && !isLoopbackOrPrivateLanHost(parsedUrl.hostname)) {
    throw new VaultCoreError(
      'WebDAV requires HTTPS over public networks (HTTP is only permitted on private LAN / loopback).',
      'webdav-insecure-url',
    );
  }

  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const username = typeof params.username === 'string' ? params.username : '';
  const password = typeof params.password === 'string' ? params.password : '';

  function buildHeaders(contentType) {
    const headers = {};
    if (username.length > 0 || password.length > 0) {
      headers.Authorization = `Basic ${bytesToBase64(TEXT_ENCODER.encode(`${username}:${password}`))}`;
    }
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return headers;
  }

  async function webdavFetch(method, body) {
    try {
      const res = await fetchFn(parsedUrl.toString(), {
        method,
        headers: buildHeaders(body !== undefined ? 'application/json; charset=utf-8' : undefined),
        body,
      });
      const text = await res.text();
      return { status: res.status, text };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new VaultCoreError(
        `WebDAV ${method} blocked by browser CORS policy or network error (${detail}). ` +
          'Configure your WebDAV server (Nextcloud, Caddy, or Nginx) to send Access-Control-Allow-Origin, ' +
          'Access-Control-Allow-Methods (GET, PUT, OPTIONS), and Access-Control-Allow-Headers (Authorization, Content-Type), ' +
          'and use HTTPS when accessing from an HTTPS origin.',
        'webdav-cors-or-network',
      );
    }
  }

  async function downloadEnvelope() {
    const res = await webdavFetch('GET');
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new VaultCoreError(
        `WebDAV authentication rejected (HTTP ${res.status}). Check username & app password.`,
        `webdav-http-${res.status}`,
        res.status,
      );
    }
    if (res.status !== 200) {
      throw new VaultCoreError(`WebDAV GET failed (HTTP ${res.status}).`, `webdav-http-${res.status}`, res.status);
    }
    return res.text.trim().length === 0 ? null : res.text;
  }

  async function uploadEnvelope(sealedJson) {
    const res = await webdavFetch('PUT', sealedJson);
    if (res.status === 401 || res.status === 403) {
      throw new VaultCoreError(
        `WebDAV authentication rejected (HTTP ${res.status}). Check username & app password.`,
        `webdav-http-${res.status}`,
        res.status,
      );
    }
    if (res.status === 409) {
      throw new VaultCoreError(
        'WebDAV parent folder does not exist (HTTP 409). Verify the folder path in your URL.',
        'webdav-http-409',
        409,
      );
    }
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
      throw new VaultCoreError(`WebDAV PUT failed (HTTP ${res.status}).`, `webdav-http-${res.status}`, res.status);
    }
  }

  const result = await runZeroKnowledgeSync({
    mode: params.mode,
    localPayload: params.localPayload,
    passphrase: params.passphrase,
    providerLabel: 'WebDAV',
    downloadEnvelope,
    uploadEnvelope,
    nowMs: params.nowMs,
  });

  return {
    ...result,
    provider: 'webdav',
    url: parsedUrl.toString(),
  };
}

// ============================================================================
// 5. Zero-Plaintext Browser Vault Storage (`SealedBrowserVaultStore`)
// ============================================================================

const DEFAULT_UI_PREFS = Object.freeze({
  autoLockSeconds: 300,
  syncProvider: 'googleDrive',
  vaultAuthMode: 'passphrase',
  useCustomPassphrase: false,
  googleClientId: '',
  googleAccountEmail: '',
  googleAccountName: '',
  githubGistId: '',
  webdavUrl: '',
  webdavUsername: '',
  gatewayUrl: '',
  lastSyncedAtMs: 0,
  activeView: 'connections',
});

function createInMemoryStorageFallback() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

function deepClone(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function sanitizeUiPrefs(raw) {
  const clean = { ...DEFAULT_UI_PREFS };
  if (!isPlainObject(raw)) return clean;
  for (const key of ALLOWED_UI_PREF_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const val = raw[key];
    switch (key) {
      case 'autoLockSeconds':
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
          clean.autoLockSeconds = Math.trunc(val);
        }
        break;
      case 'lastSyncedAtMs':
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
          clean.lastSyncedAtMs = Math.trunc(val);
        }
        break;
      case 'useCustomPassphrase':
        clean.useCustomPassphrase = Boolean(val);
        break;
      case 'syncProvider':
        if (val === 'googleDrive' || val === 'githubGist' || val === 'webdav') {
          clean.syncProvider = val;
        }
        break;
      case 'vaultAuthMode':
        if (val === 'googleAccount' || val === 'passphrase') {
          clean.vaultAuthMode = val;
        }
        break;
      default:
        if (typeof val === 'string') {
          clean[key] = val.trim();
        }
        break;
    }
  }
  return clean;
}

function scrubPayloadInPlace(payload) {
  if (!isPlainObject(payload)) return;
  for (const listKey of ['hosts', 'credentials', 'folders', 'totp', 'snippets']) {
    const list = payload[listKey];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (isPlainObject(item)) {
          for (const field of Object.keys(item)) {
            item[field] = '';
          }
        }
      }
      list.length = 0;
    }
  }
  if (isPlainObject(payload.tombstones)) {
    for (const k of Object.keys(payload.tombstones)) {
      delete payload.tombstones[k];
    }
  }
}

/**
 * Zero-plaintext browser Vault persistence store.
 * Writes ONLY the AES-256-GCM sealed envelope string under `jaladesk.web.vault.sealed.v1`
 * and strictly allow-listed non-secret UI prefs under `jaladesk.web.vault.prefs.v1`.
 */
export class SealedBrowserVaultStore {
  #storage;
  #vaultKey;
  #prefsKey;
  #payload = null;
  #passphrase = null;
  #unlocked = false;
  #lockTimer = null;
  #lockListeners = new Set();

  /**
   * @param {{ storage?: Storage, vaultKey?: string, prefsKey?: string }} [options]
   */
  constructor(options = {}) {
    this.#storage = options.storage ?? globalThis.localStorage ?? createInMemoryStorageFallback();
    this.#vaultKey = options.vaultKey ?? SEALED_VAULT_STORAGE_KEY;
    this.#prefsKey = options.prefsKey ?? UI_PREFS_STORAGE_KEY;
  }

  hasSealedVault() {
    const raw = this.#storage.getItem(this.#vaultKey);
    return typeof raw === 'string' && raw.trim().length > 0;
  }

  getSealedEnvelope() {
    const raw = this.#storage.getItem(this.#vaultKey);
    return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
  }

  isUnlocked() {
    return this.#unlocked && this.#payload !== null && this.#passphrase !== null;
  }

  getPayload() {
    if (!this.isUnlocked()) {
      throw new VaultCoreError('Vault is locked.', 'vault-locked');
    }
    return deepClone(this.#payload);
  }

  getUiPrefs() {
    const raw = this.#storage.getItem(this.#prefsKey);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    try {
      return sanitizeUiPrefs(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_UI_PREFS };
    }
  }

  saveUiPrefs(partial) {
    const merged = sanitizeUiPrefs({ ...this.getUiPrefs(), ...(isPlainObject(partial) ? partial : {}) });
    this.#storage.setItem(this.#prefsKey, JSON.stringify(merged));
    if (this.isUnlocked()) {
      this.#scheduleAutoLock(merged.autoLockSeconds);
    }
    return merged;
  }

  onLock(listener) {
    if (typeof listener === 'function') {
      this.#lockListeners.add(listener);
      return () => this.#lockListeners.delete(listener);
    }
    return () => {};
  }

  touchActivity() {
    if (!this.isUnlocked()) return;
    const prefs = this.getUiPrefs();
    this.#scheduleAutoLock(prefs.autoLockSeconds);
  }

  #clearAutoLockTimer() {
    if (this.#lockTimer !== null) {
      clearTimeout(this.#lockTimer);
      this.#lockTimer = null;
    }
  }

  #scheduleAutoLock(seconds) {
    this.#clearAutoLockTimer();
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      this.#lockTimer = setTimeout(() => {
        this.lock();
      }, seconds * 1000);
      if (typeof this.#lockTimer === 'object' && typeof this.#lockTimer.unref === 'function') {
        this.#lockTimer.unref();
      }
    }
  }

  async createVault(passphrase, initialPayload = null) {
    if (typeof passphrase !== 'string' || passphrase.trim().length < 4) {
      throw new VaultCoreError('Master passphrase must be at least 4 characters.', 'weak-passphrase');
    }
    const normalized = initialPayload ? normalizeVaultPayload(initialPayload) : createEmptyVaultPayload();
    const sealed = await sealVaultEnvelope(normalized, passphrase);
    this.#storage.setItem(this.#vaultKey, sealed);
    this.#payload = deepClone(normalized);
    this.#passphrase = passphrase;
    this.#unlocked = true;
    this.#scheduleAutoLock(this.getUiPrefs().autoLockSeconds);
    return deepClone(this.#payload);
  }

  async unlock(passphrase) {
    const raw = this.getSealedEnvelope();
    if (!raw) {
      throw new VaultCoreError('No sealed local vault found.', 'vault-not-found');
    }
    const opened = await openVaultEnvelope(raw, passphrase);
    const preservedTs =
      typeof opened.updatedAtMs === 'number' && Number.isFinite(opened.updatedAtMs) && opened.updatedAtMs > 0
        ? Math.trunc(opened.updatedAtMs)
        : Date.now();
    const normalized = normalizeVaultPayload(opened, { nowMs: preservedTs });
    this.#payload = deepClone(normalized);
    this.#passphrase = passphrase;
    this.#unlocked = true;
    this.#scheduleAutoLock(this.getUiPrefs().autoLockSeconds);
    return deepClone(this.#payload);
  }

  async savePayload(nextPayload) {
    if (!this.isUnlocked()) {
      throw new VaultCoreError('Vault is locked.', 'vault-locked');
    }
    const normalized = normalizeVaultPayload(nextPayload);
    const sealed = await sealVaultEnvelope(normalized, this.#passphrase);
    this.#storage.setItem(this.#vaultKey, sealed);
    this.#payload = deepClone(normalized);
    this.touchActivity();
    return deepClone(this.#payload);
  }

  async importEnvelope(rawEnvelopeJson, passphrase, options = {}) {
    const opened = await openVaultEnvelope(String(rawEnvelopeJson ?? '').trim(), passphrase);
    const mode = options.mode === 'merge' && this.isUnlocked() ? 'merge' : 'replace';
    const nextPayload =
      mode === 'merge'
        ? mergeVaultPayloads(this.#payload, opened)
        : normalizeVaultPayload(opened);
    const sealingPassphrase =
      typeof options.localPassphrase === 'string' && options.localPassphrase.trim().length >= 4
        ? options.localPassphrase
        : this.isUnlocked() && mode === 'merge'
          ? this.#passphrase
          : passphrase;
    if (typeof sealingPassphrase !== 'string' || sealingPassphrase.trim().length < 4) {
      throw new VaultCoreError('Master passphrase must be at least 4 characters.', 'weak-passphrase');
    }
    const sealed = await sealVaultEnvelope(nextPayload, sealingPassphrase);
    this.#storage.setItem(this.#vaultKey, sealed);
    this.#payload = deepClone(nextPayload);
    this.#passphrase = sealingPassphrase;
    this.#unlocked = true;
    this.#scheduleAutoLock(this.getUiPrefs().autoLockSeconds);
    return deepClone(this.#payload);
  }

  async exportEnvelope(overridePassphrase) {
    if (!this.isUnlocked()) {
      throw new VaultCoreError('Vault is locked.', 'vault-locked');
    }
    const effective =
      typeof overridePassphrase === 'string' && overridePassphrase.length > 0 ? overridePassphrase : this.#passphrase;
    return exportEncryptedJvault(this.#payload, effective);
  }

  async changePassphrase(newPassphrase) {
    if (!this.isUnlocked()) {
      throw new VaultCoreError('Vault is locked.', 'vault-locked');
    }
    if (typeof newPassphrase !== 'string' || newPassphrase.trim().length < 4) {
      throw new VaultCoreError('New passphrase must be at least 4 characters.', 'weak-passphrase');
    }
    const normalized = normalizeVaultPayload(this.#payload);
    const sealed = await sealVaultEnvelope(normalized, newPassphrase);
    this.#storage.setItem(this.#vaultKey, sealed);
    this.#passphrase = newPassphrase;
    this.#payload = deepClone(normalized);
    this.touchActivity();
    return deepClone(this.#payload);
  }

  lock() {
    this.#clearAutoLockTimer();
    const wasUnlocked = this.#unlocked;
    if (this.#payload !== null) {
      scrubPayloadInPlace(this.#payload);
    }
    this.#payload = null;
    this.#passphrase = null;
    this.#unlocked = false;
    if (wasUnlocked) {
      for (const listener of this.#lockListeners) {
        try {
          listener();
        } catch {
          // Ignore listener exceptions during lock cleanup
        }
      }
    }
  }

  resetVault(options = {}) {
    this.lock();
    this.#storage.removeItem(this.#vaultKey);
    if (options.clearPrefs === true) {
      this.#storage.removeItem(this.#prefsKey);
    }
  }
}
