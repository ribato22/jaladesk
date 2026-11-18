import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  pbkdf2,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';
import {
  BUILTIN_GOOGLE_DESKTOP_CLIENT_ID,
  BUILTIN_GOOGLE_DESKTOP_CLIENT_SECRET,
  UNCONFIGURED_GOOGLE_OAUTH_ADMIN_MESSAGE,
  resolveGoogleDesktopOAuthCredentials,
  setBuiltInGoogleDesktopOAuthForTesting,
  type GoogleDesktopOAuthCredentialSource,
  type ResolveGoogleOAuthOptions,
  type ResolvedGoogleDesktopOAuthCredentials,
} from './oauth-client-config.js';

export {
  BUILTIN_GOOGLE_DESKTOP_CLIENT_ID,
  BUILTIN_GOOGLE_DESKTOP_CLIENT_SECRET,
  UNCONFIGURED_GOOGLE_OAUTH_ADMIN_MESSAGE,
  resolveGoogleDesktopOAuthCredentials,
  setBuiltInGoogleDesktopOAuthForTesting,
  type GoogleDesktopOAuthCredentialSource,
  type ResolveGoogleOAuthOptions,
  type ResolvedGoogleDesktopOAuthCredentials,
};

export type VaultSyncProviderKind = 'googleDrive' | 'sftp' | 'webdav' | 'githubGist';

export type VaultSyncOperationMode = 'smartMerge' | 'pullOnly' | 'pushForce';

export const VAULT_SYNC_PROVIDER_KINDS: readonly VaultSyncProviderKind[] = [
  'googleDrive',
  'sftp',
  'webdav',
  'githubGist',
];

export const VAULT_SYNC_OPERATION_MODES: readonly VaultSyncOperationMode[] = [
  'smartMerge',
  'pullOnly',
  'pushForce',
];

export const JDESK_SYNC_SCHEMA_ID = 'jdesk-sync-v1';
export const JALADESK_VAULT_FORMAT_ID = 'jaladesk-encrypted-vault-v1';
export const PBKDF2_HMAC_SHA256_KDF = 'PBKDF2-HMAC-SHA256';
export const AES_256_GCM_CIPHER = 'AES-256-GCM';
export const DEFAULT_PBKDF2_ITERATIONS = 100_000;
export const GOOGLE_DRIVE_DEFAULT_API_BASE_URL = 'https://www.googleapis.com';
export const GOOGLE_OAUTH_DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OAUTH_DEFAULT_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_DRIVE_APPDATA_SCOPE =
  'https://www.googleapis.com/auth/drive.appdata openid email profile';
export const GOOGLE_DRIVE_PRIMARY_VAULT_FILE = 'jaladesk-vault-v1.jvault';
export const GOOGLE_DRIVE_ALT_VAULT_FILE = 'jaladesk_vault_sync_v1.jdesk';
export const SFTP_DEFAULT_REMOTE_PATH = '.jaladesk/jaladesk-vault.jvault';
export const SFTP_ALT_REMOTE_PATH = '.jaladesk/vault-sync.jdesk';
export const GITHUB_DEFAULT_API_BASE_URL = 'https://api.github.com';
export const GITHUB_PRIMARY_GIST_FILE = 'jaladesk-vault.jvault';
export const GITHUB_ALT_GIST_FILE = 'jaladesk_vault_sync.jdesk';
export const DIRECT_NO_JUMP_OVERRIDE = '__direct__';

export interface EncryptedVaultEnvelope {
  format: string;
  schema: string;
  kdf: string;
  iterations: number;
  cipher: string;
  salt: string;
  iv: string;
  nonce: string;
  ciphertext: string;
  mac: string;
  exportedAt: string;
}

export interface VaultSyncHostRecord {
  id: string;
  name: string;
  address: string;
  port: number;
  protocol: 'rdp' | 'vnc' | 'ssh' | 'sftp' | string;
  folder: string;
  osLabel: string;
  domain: string;
  username: string;
  password: string;
  privateKeyPem: string;
  jumpHostId: string | null;
  credentialId: string | null;
  isJumpHost: boolean;
  isFavorite: boolean;
  latencyMs?: number | null;
  isOnline?: boolean | null;
  accentTint: string;
  updatedAtMs: number;
  [key: string]: unknown;
}

export interface VaultSyncCredentialRecord {
  id: string;
  label: string;
  domain: string;
  username: string;
  password: string;
  privateKeyPem: string;
  notes: string;
  updatedAtMs: number;
  [key: string]: unknown;
}

export interface VaultSyncFolderRecord {
  name: string;
  jumpHostId: string | null;
  credentialId: string | null;
  accentTint: string;
  updatedAtMs: number;
  [key: string]: unknown;
}

export interface VaultSyncTotpRecord {
  id: string;
  label: string;
  issuer: string;
  secretBase32: string;
  algorithm: string;
  digits: number;
  periodSeconds: number;
  updatedAtMs: number;
  [key: string]: unknown;
}

export interface VaultSyncSnippetRecord {
  id: string;
  title?: string;
  name?: string;
  command: string;
  category?: string;
  updatedAtMs: number;
  [key: string]: unknown;
}

export interface VaultSyncPayload {
  syncSchema: number;
  updatedAtMs: number;
  hosts: Record<string, unknown>[];
  credentials: Record<string, unknown>[];
  folders: Record<string, unknown>[];
  totp: Record<string, unknown>[];
  snippets: Record<string, unknown>[];
  tombstones: Record<string, number>;
  [key: string]: unknown;
}

export interface SftpSyncHostPreset {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPem?: string;
  jumpHost?: string;
  isJumpHost?: boolean;
}

export interface VaultSyncConfig {
  isBound: boolean;
  provider: VaultSyncProviderKind;
  syncPassphrase: string;
  useCustomPassphrase: boolean;
  autoSyncEnabled: boolean;
  lastSyncedAtMs: number;
  lastSyncError: string;

  googleClientId: string;
  googleClientSecret: string;
  googleAccountEmail: string;
  googleDisplayName: string;
  googleApiBaseUrl: string;
  googleAuthEndpoint: string;
  googleTokenEndpoint: string;
  googleUserInfoEndpoint: string;

  sftpHost: string;
  sftpPort: number;
  sftpUsername: string;
  sftpPassword: string;
  sftpPrivateKeyPem: string;
  sftpRemotePath: string;
  sftpPresetHostId: string | null;
  sftpJumpHost: string;

  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;

  githubToken: string;
  githubGistId: string;
  githubApiBaseUrl: string;
}

export interface GoogleOAuthTokenState {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  scope: string;
  tokenType: string;
}

export interface GoogleAuthAccountInfo {
  email: string;
  displayName: string;
}

export interface VaultSyncRunSummary {
  updatedConfig: VaultSyncConfig;
  message: string;
  connectionCount: number;
  gatewayCount: number;
  credentialCount: number;
  totpCount: number;
  mode: VaultSyncOperationMode;
}

export interface GoogleSignInFlowResult {
  account: GoogleAuthAccountInfo;
  updatedConfig: VaultSyncConfig;
  syncSummary: VaultSyncRunSummary | null;
  initialSyncError: string | null;
}

export class VaultCloudSyncError extends Error {
  readonly code: string;

  constructor(message: string, code = 'cloud-sync-error') {
    super(message);
    this.name = 'VaultCloudSyncError';
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function normalizeProviderKind(raw: unknown): VaultSyncProviderKind {
  if (typeof raw === 'string' && (VAULT_SYNC_PROVIDER_KINDS as readonly string[]).includes(raw)) {
    return raw as VaultSyncProviderKind;
  }
  return 'googleDrive';
}

export function normalizeOperationMode(raw: unknown): VaultSyncOperationMode {
  if (typeof raw === 'string' && (VAULT_SYNC_OPERATION_MODES as readonly string[]).includes(raw)) {
    return raw as VaultSyncOperationMode;
  }
  return 'smartMerge';
}

export function providerLabel(provider: VaultSyncProviderKind): string {
  switch (provider) {
    case 'googleDrive':
      return 'Google Drive';
    case 'sftp':
      return 'SFTP Server';
    case 'webdav':
      return 'WebDAV';
    case 'githubGist':
      return 'GitHub Gist';
  }
}

export function createDefaultVaultSyncConfig(): VaultSyncConfig {
  return {
    isBound: false,
    provider: 'googleDrive',
    syncPassphrase: '',
    useCustomPassphrase: false,
    autoSyncEnabled: true,
    lastSyncedAtMs: 0,
    lastSyncError: '',
    googleClientId: '',
    googleClientSecret: '',
    googleAccountEmail: '',
    googleDisplayName: '',
    googleApiBaseUrl: GOOGLE_DRIVE_DEFAULT_API_BASE_URL,
    googleAuthEndpoint: GOOGLE_OAUTH_DEFAULT_AUTH_URL,
    googleTokenEndpoint: GOOGLE_OAUTH_DEFAULT_TOKEN_URL,
    googleUserInfoEndpoint: GOOGLE_OAUTH_DEFAULT_USERINFO_URL,
    sftpHost: '',
    sftpPort: 22,
    sftpUsername: 'root',
    sftpPassword: '',
    sftpPrivateKeyPem: '',
    sftpRemotePath: SFTP_DEFAULT_REMOTE_PATH,
    sftpPresetHostId: null,
    sftpJumpHost: '',
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    githubToken: '',
    githubGistId: '',
    githubApiBaseUrl: GITHUB_DEFAULT_API_BASE_URL,
  };
}

export function normalizeVaultSyncConfig(raw: unknown): VaultSyncConfig {
  const defaults = createDefaultVaultSyncConfig();
  if (!isPlainObject(raw)) {
    return defaults;
  }
  const provider = normalizeProviderKind(raw.provider);
  const syncPassphrase = typeof raw.syncPassphrase === 'string' ? raw.syncPassphrase : '';
  const useCustomPassphrase =
    typeof raw.useCustomPassphrase === 'boolean'
      ? raw.useCustomPassphrase
      : provider === 'googleDrive' && syncPassphrase.trim().length >= 4;
  const rawPort = typeof raw.sftpPort === 'number' ? Math.trunc(raw.sftpPort) : Number.parseInt(String(raw.sftpPort ?? '22'), 10);
  const sftpPort = Number.isFinite(rawPort) ? Math.min(65535, Math.max(1, rawPort)) : 22;
  const rawPreset = typeof raw.sftpPresetHostId === 'string' ? raw.sftpPresetHostId.trim() : '';

  const nonEmptyOrDefault = (val: unknown, fallback: string): string => {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
    return fallback;
  };

  return {
    isBound: Boolean(raw.isBound),
    provider,
    syncPassphrase,
    useCustomPassphrase,
    autoSyncEnabled: typeof raw.autoSyncEnabled === 'boolean' ? raw.autoSyncEnabled : true,
    lastSyncedAtMs:
      typeof raw.lastSyncedAtMs === 'number' && Number.isFinite(raw.lastSyncedAtMs) && raw.lastSyncedAtMs > 0
        ? Math.trunc(raw.lastSyncedAtMs)
        : 0,
    lastSyncError: typeof raw.lastSyncError === 'string' ? raw.lastSyncError : '',
    googleClientId: typeof raw.googleClientId === 'string' ? raw.googleClientId.trim() : '',
    googleClientSecret: typeof raw.googleClientSecret === 'string' ? raw.googleClientSecret.trim() : '',
    googleAccountEmail: typeof raw.googleAccountEmail === 'string' ? raw.googleAccountEmail.trim() : '',
    googleDisplayName: typeof raw.googleDisplayName === 'string' ? raw.googleDisplayName.trim() : '',
    googleApiBaseUrl: nonEmptyOrDefault(raw.googleApiBaseUrl, GOOGLE_DRIVE_DEFAULT_API_BASE_URL),
    googleAuthEndpoint: nonEmptyOrDefault(raw.googleAuthEndpoint, GOOGLE_OAUTH_DEFAULT_AUTH_URL),
    googleTokenEndpoint: nonEmptyOrDefault(raw.googleTokenEndpoint, GOOGLE_OAUTH_DEFAULT_TOKEN_URL),
    googleUserInfoEndpoint: nonEmptyOrDefault(raw.googleUserInfoEndpoint, GOOGLE_OAUTH_DEFAULT_USERINFO_URL),
    sftpHost: typeof raw.sftpHost === 'string' ? raw.sftpHost.trim() : '',
    sftpPort,
    sftpUsername: nonEmptyOrDefault(raw.sftpUsername, 'root'),
    sftpPassword: typeof raw.sftpPassword === 'string' ? raw.sftpPassword : '',
    sftpPrivateKeyPem: typeof raw.sftpPrivateKeyPem === 'string' ? raw.sftpPrivateKeyPem : '',
    sftpRemotePath: nonEmptyOrDefault(raw.sftpRemotePath, SFTP_DEFAULT_REMOTE_PATH),
    sftpPresetHostId: rawPreset.length > 0 ? rawPreset : null,
    sftpJumpHost: typeof raw.sftpJumpHost === 'string' ? raw.sftpJumpHost.trim() : '',
    webdavUrl: typeof raw.webdavUrl === 'string' ? raw.webdavUrl.trim() : '',
    webdavUsername: typeof raw.webdavUsername === 'string' ? raw.webdavUsername.trim() : '',
    webdavPassword: typeof raw.webdavPassword === 'string' ? raw.webdavPassword : '',
    githubToken: typeof raw.githubToken === 'string' ? raw.githubToken.trim() : '',
    githubGistId: typeof raw.githubGistId === 'string' ? raw.githubGistId.trim() : '',
    githubApiBaseUrl: nonEmptyOrDefault(raw.githubApiBaseUrl, GITHUB_DEFAULT_API_BASE_URL),
  };
}

export function effectiveEncryptionPassphrase(config: VaultSyncConfig): string {
  if (config.provider === 'googleDrive' && !config.useCustomPassphrase) {
    const email = config.googleAccountEmail.trim().toLowerCase();
    if (email.length > 0) {
      return `jaladesk-gdrive-e2ee-v1:${email}`;
    }
  }
  return config.syncPassphrase;
}

export function hasValidEncryptionKey(config: VaultSyncConfig): boolean {
  if (config.provider === 'googleDrive') {
    return config.useCustomPassphrase
      ? config.syncPassphrase.trim().length >= 4
      : config.googleAccountEmail.trim().length > 0;
  }
  return config.syncPassphrase.trim().length >= 4;
}

export function getVaultSyncAccountSummary(config: VaultSyncConfig): string {
  switch (config.provider) {
    case 'googleDrive':
      return config.googleAccountEmail.trim().length > 0 ? config.googleAccountEmail.trim() : 'AppData';
    case 'sftp': {
      const h = config.sftpHost.trim();
      if (!h) return 'SSH Endpoint';
      const u = config.sftpUsername.trim() || 'root';
      return `${u}@${h}:${config.sftpPort}`;
    }
    case 'webdav': {
      try {
        const parsed = new URL(config.webdavUrl.trim());
        if (parsed.hostname) {
          return parsed.port && parsed.port !== '443' && parsed.port !== '80'
            ? `${parsed.hostname}:${parsed.port}`
            : parsed.hostname;
        }
      } catch {
        // Ignore invalid draft URL
      }
      return 'WebDAV Endpoint';
    }
    case 'githubGist': {
      const g = config.githubGistId.trim();
      if (g.length > 0) {
        return `Gist ${g.length > 8 ? g.slice(0, 8) : g}`;
      }
      return 'Secret Gist';
    }
  }
}

export function formatSyncRelativeTime(lastSyncedAtMs: number, nowMs = Date.now()): string {
  if (!Number.isFinite(lastSyncedAtMs) || lastSyncedAtMs <= 0) {
    return 'Never synced';
  }
  const diffSec = Math.max(0, Math.floor((nowMs - lastSyncedAtMs) / 1000));
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

const VAULT_AAD_BYTES = Buffer.from(JALADESK_VAULT_FORMAT_ID, 'utf8');
const JDESK_ALT_AAD_BYTES = Buffer.from(JDESK_SYNC_SCHEMA_ID, 'utf8');

function derivePbkdf2KeyAsync(passphrase: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256', (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function buildSealedEnvelopeFromKey(
  payload: Record<string, unknown>,
  key: Buffer,
  salt: Buffer,
  iv: Buffer,
  iterations: number,
): string {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(VAULT_AAD_BYTES);
  const encryptedBytes = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Mobile PointyCastle GCMBlockCipher appends the 16-byte MAC tag at the end of ciphertext
  // and authenticates AAD = 'jaladesk-encrypted-vault-v1'. Including both 'format' and 'schema'/'nonce'/'mac'
  // guarantees 100% byte-level interoperability with Mobile v1.16.0+18 and jdesk-sync-v1 verifiers.
  const combinedCiphertext = Buffer.concat([encryptedBytes, authTag]);
  const ivBase64 = iv.toString('base64');
  const envelope: EncryptedVaultEnvelope = {
    format: JALADESK_VAULT_FORMAT_ID,
    schema: JDESK_SYNC_SCHEMA_ID,
    kdf: PBKDF2_HMAC_SHA256_KDF,
    iterations,
    cipher: AES_256_GCM_CIPHER,
    salt: salt.toString('base64'),
    iv: ivBase64,
    nonce: ivBase64,
    ciphertext: combinedCiphertext.toString('base64'),
    mac: authTag.toString('base64'),
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(envelope, null, 2);
}

interface ParsedEnvelopeParts {
  hasMobileFormat: boolean;
  hasJdeskSchema: boolean;
  iterations: number;
  salt: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  mac: Buffer | null;
}

function parseEnvelopeJson(rawEnvelopeJson: string): ParsedEnvelopeParts {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawEnvelopeJson);
  } catch {
    throw new VaultCloudSyncError('Invalid Vault snapshot JSON object.', 'invalid-envelope');
  }
  if (!isPlainObject(decoded)) {
    throw new VaultCloudSyncError('Invalid Vault snapshot JSON object.', 'invalid-envelope');
  }
  const hasMobileFormat = decoded.format === JALADESK_VAULT_FORMAT_ID;
  const hasJdeskSchema = decoded.schema === JDESK_SYNC_SCHEMA_ID;
  if (!hasMobileFormat && !hasJdeskSchema) {
    throw new VaultCloudSyncError('Unrecognized encrypted Vault envelope version.', 'unsupported-envelope');
  }
  if (typeof decoded.kdf === 'string' && decoded.kdf !== PBKDF2_HMAC_SHA256_KDF) {
    throw new VaultCloudSyncError(`Unsupported KDF: ${decoded.kdf}`, 'unsupported-kdf');
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
    throw new VaultCloudSyncError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
  }
  const rawCiphertext = typeof decoded.ciphertext === 'string' ? decoded.ciphertext.trim() : '';
  const rawMac = typeof decoded.mac === 'string' && decoded.mac.trim().length > 0 ? decoded.mac.trim() : null;

  if (!rawSalt || !rawIv || !rawCiphertext) {
    throw new VaultCloudSyncError('Encrypted Vault envelope is missing required fields.', 'invalid-envelope');
  }

  const salt = Buffer.from(rawSalt, 'base64');
  const iv = Buffer.from(rawIv, 'base64');
  const ciphertext = Buffer.from(rawCiphertext, 'base64');
  const mac = rawMac ? Buffer.from(rawMac, 'base64') : null;

  if (salt.length < 8 || iv.length !== 12) {
    throw new VaultCloudSyncError('Encrypted Vault envelope has invalid salt or IV length.', 'invalid-envelope');
  }
  if (mac !== null && mac.length !== 16) {
    throw new VaultCloudSyncError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
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

function tryAesGcmOpen(key: Buffer, iv: Buffer, enc: Buffer, tag: Buffer, aad?: Buffer): Buffer | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    if (aad) {
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    return null;
  }
}

function decryptParsedEnvelopeWithKey(parts: ParsedEnvelopeParts, key: Buffer): Record<string, unknown> {
  let clearBytes: Buffer | null = null;

  if (parts.hasMobileFormat) {
    if (parts.ciphertext.length < 16) {
      throw new VaultCloudSyncError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
    }
    const embeddedTag = parts.ciphertext.subarray(parts.ciphertext.length - 16);
    if (parts.mac !== null && !timingSafeEqual(embeddedTag, parts.mac)) {
      // Check if caller constructed a detached-MAC envelope while still setting format
      clearBytes =
        tryAesGcmOpen(key, parts.iv, parts.ciphertext, parts.mac, VAULT_AAD_BYTES) ??
        tryAesGcmOpen(key, parts.iv, parts.ciphertext, parts.mac);
      if (!clearBytes) {
        throw new VaultCloudSyncError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
      }
    } else {
      const encBody = parts.ciphertext.subarray(0, parts.ciphertext.length - 16);
      clearBytes = tryAesGcmOpen(key, parts.iv, encBody, embeddedTag, VAULT_AAD_BYTES);
    }
  } else if (parts.hasJdeskSchema) {
    if (parts.mac !== null) {
      // Support both detached ciphertext+mac and combined ciphertext||mac
      if (
        parts.ciphertext.length >= 16 &&
        timingSafeEqual(parts.ciphertext.subarray(parts.ciphertext.length - 16), parts.mac)
      ) {
        const encBody = parts.ciphertext.subarray(0, parts.ciphertext.length - 16);
        clearBytes =
          tryAesGcmOpen(key, parts.iv, encBody, parts.mac, VAULT_AAD_BYTES) ??
          tryAesGcmOpen(key, parts.iv, encBody, parts.mac) ??
          tryAesGcmOpen(key, parts.iv, encBody, parts.mac, JDESK_ALT_AAD_BYTES);
      }
      if (!clearBytes) {
        clearBytes =
          tryAesGcmOpen(key, parts.iv, parts.ciphertext, parts.mac) ??
          tryAesGcmOpen(key, parts.iv, parts.ciphertext, parts.mac, JDESK_ALT_AAD_BYTES) ??
          tryAesGcmOpen(key, parts.iv, parts.ciphertext, parts.mac, VAULT_AAD_BYTES);
      }
    } else if (parts.ciphertext.length >= 16) {
      const embeddedTag = parts.ciphertext.subarray(parts.ciphertext.length - 16);
      const encBody = parts.ciphertext.subarray(0, parts.ciphertext.length - 16);
      clearBytes =
        tryAesGcmOpen(key, parts.iv, encBody, embeddedTag, VAULT_AAD_BYTES) ??
        tryAesGcmOpen(key, parts.iv, encBody, embeddedTag);
    }
  }

  if (!clearBytes) {
    throw new VaultCloudSyncError('Incorrect passphrase or tampered encrypted Vault backup.', 'decrypt-failed');
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(clearBytes.toString('utf8'));
  } catch {
    throw new VaultCloudSyncError('Decrypted payload is not valid JSON.', 'invalid-payload');
  }
  if (!isPlainObject(parsedPayload)) {
    throw new VaultCloudSyncError('Decrypted payload is not a valid Vault map.', 'invalid-payload');
  }
  return parsedPayload;
}

/**
 * Byte-compatible `.jvault` / `jdesk-sync-v1` codec matching Mobile's `EncryptedVaultBackupCodec`
 * (`PBKDF2-HMAC-SHA256` 100,000 iterations, 16B salt, 12B IV/nonce, `AES-256-GCM` 16B MAC).
 */
export class EncryptedVaultBackupCodec {
  static readonly magicFormat = JALADESK_VAULT_FORMAT_ID;
  static readonly schemaId = JDESK_SYNC_SCHEMA_ID;
  static readonly pbkdf2Iterations = DEFAULT_PBKDF2_ITERATIONS;

  static sealJson(params: { payload: Record<string, unknown>; passphrase: string; iterations?: number }): string {
    if (!params.passphrase || params.passphrase.length === 0) {
      throw new VaultCloudSyncError('Passphrase cannot be empty for encrypted backup.', 'weak-passphrase');
    }
    const iterations = params.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = pbkdf2Sync(Buffer.from(params.passphrase, 'utf8'), salt, iterations, 32, 'sha256');
    return buildSealedEnvelopeFromKey(params.payload, key, salt, iv, iterations);
  }

  static openJson(params: { rawEnvelopeJson: string; passphrase: string }): Record<string, unknown> {
    if (!params.passphrase || params.passphrase.length === 0) {
      throw new VaultCloudSyncError('Enter your Sync Passphrase to decrypt the cloud vault.', 'empty-passphrase');
    }
    const parts = parseEnvelopeJson(params.rawEnvelopeJson);
    const key = pbkdf2Sync(Buffer.from(params.passphrase, 'utf8'), parts.salt, parts.iterations, 32, 'sha256');
    return decryptParsedEnvelopeWithKey(parts, key);
  }
}

/**
 * Non-blocking async E2EE Cloud Sync Crypto matching Mobile's `VaultCloudSyncCrypto`.
 */
export class VaultCloudSyncCrypto {
  static async sealAsync(params: {
    payload: Record<string, unknown>;
    passphrase: string;
    iterations?: number;
  }): Promise<string> {
    if (params.passphrase.trim().length < 4) {
      throw new VaultCloudSyncError('Sync passphrase must be at least 4 characters.', 'weak-passphrase');
    }
    const iterations = params.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await derivePbkdf2KeyAsync(params.passphrase, salt, iterations);
    return buildSealedEnvelopeFromKey(params.payload, key, salt, iv, iterations);
  }

  static async openAsync(params: {
    rawEnvelopeJson: string;
    passphrase: string;
  }): Promise<Record<string, unknown>> {
    if (params.passphrase.length === 0) {
      throw new VaultCloudSyncError('Enter your Sync Passphrase to decrypt the cloud vault.', 'empty-passphrase');
    }
    const parts = parseEnvelopeJson(params.rawEnvelopeJson);
    const key = await derivePbkdf2KeyAsync(params.passphrase, parts.salt, parts.iterations);
    return decryptParsedEnvelopeWithKey(parts, key);
  }
}

export async function exportEncryptedJvault(
  payload: Record<string, unknown>,
  passphrase: string,
): Promise<string> {
  if (passphrase.trim().length < 4) {
    throw new VaultCloudSyncError('Backup passphrase must be at least 4 characters.', 'weak-passphrase');
  }
  const normalized = VaultSyncPayloadMerger.normalizePayload(payload);
  return VaultCloudSyncCrypto.sealAsync({ payload: normalized, passphrase });
}

export async function importEncryptedJvault(
  rawEnvelopeJson: string,
  passphrase: string,
): Promise<VaultSyncPayload> {
  const opened = await VaultCloudSyncCrypto.openAsync({
    rawEnvelopeJson: rawEnvelopeJson.trim(),
    passphrase,
  });
  return VaultSyncPayloadMerger.normalizePayload(opened);
}

/**
 * Deterministic Tombstone-Aware Multi-Device `.jvault` / `jdesk-sync-v1` Payload Merger (`syncSchema: 2`).
 * Matches Mobile `VaultSyncPayloadMerger` behavior identically.
 */
export class VaultSyncPayloadMerger {
  static readonly syncSchemaVersion = 2;
  static readonly maxTombstones = 500;

  static parseTombstones(raw: unknown): Record<string, number> {
    const out: Record<string, number> = {};
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

  static capTombstones(tombstones: Record<string, number>): Record<string, number> {
    const entries = Object.entries(tombstones);
    if (entries.length <= VaultSyncPayloadMerger.maxTombstones) {
      return { ...tombstones };
    }
    entries.sort((a, b) => b[1] - a[1]);
    const capped: Record<string, number> = {};
    for (const [k, v] of entries.slice(0, VaultSyncPayloadMerger.maxTombstones)) {
      capped[k] = v;
    }
    return capped;
  }

  static normalizePayload(source: Record<string, unknown>, options?: { nowMs?: number }): VaultSyncPayload {
    const ts = options?.nowMs ?? Date.now();
    const tombstones = VaultSyncPayloadMerger.capTombstones(
      VaultSyncPayloadMerger.parseTombstones(source.tombstones),
    );
    const sourceTs =
      typeof source.updatedAtMs === 'number' && Number.isFinite(source.updatedAtMs)
        ? Math.trunc(source.updatedAtMs)
        : 0;
    return {
      syncSchema: VaultSyncPayloadMerger.syncSchemaVersion,
      updatedAtMs: Math.max(ts, sourceTs),
      hosts: VaultSyncPayloadMerger.extractMapList(source.hosts),
      credentials: VaultSyncPayloadMerger.extractMapList(source.credentials),
      folders: VaultSyncPayloadMerger.extractMapList(source.folders),
      totp: VaultSyncPayloadMerger.extractMapList(source.totp),
      snippets: VaultSyncPayloadMerger.extractMapList(source.snippets),
      tombstones,
    };
  }

  static merge(
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    options?: { nowMs?: number },
  ): VaultSyncPayload {
    const ts = options?.nowMs ?? Date.now();
    const localTombs = VaultSyncPayloadMerger.parseTombstones(local.tombstones);
    const remoteTombs = VaultSyncPayloadMerger.parseTombstones(remote.tombstones);

    const unionTombstones: Record<string, number> = { ...localTombs };
    for (const [key, remoteDeletedAt] of Object.entries(remoteTombs)) {
      const prev = unionTombstones[key] ?? 0;
      if (remoteDeletedAt > prev) {
        unionTombstones[key] = remoteDeletedAt;
      }
    }

    const mergedHosts = VaultSyncPayloadMerger.mergeCollection({
      localList: VaultSyncPayloadMerger.extractMapList(local.hosts),
      remoteList: VaultSyncPayloadMerger.extractMapList(remote.hosts),
      keyField: 'id',
      tombstonePrefix: 'host:',
      tombstones: unionTombstones,
    });
    const mergedCreds = VaultSyncPayloadMerger.mergeCollection({
      localList: VaultSyncPayloadMerger.extractMapList(local.credentials),
      remoteList: VaultSyncPayloadMerger.extractMapList(remote.credentials),
      keyField: 'id',
      tombstonePrefix: 'cred:',
      tombstones: unionTombstones,
    });
    const mergedFolders = VaultSyncPayloadMerger.mergeCollection({
      localList: VaultSyncPayloadMerger.extractMapList(local.folders),
      remoteList: VaultSyncPayloadMerger.extractMapList(remote.folders),
      keyField: 'name',
      tombstonePrefix: 'folder:',
      tombstones: unionTombstones,
    });
    const mergedTotp = VaultSyncPayloadMerger.mergeCollection({
      localList: VaultSyncPayloadMerger.extractMapList(local.totp),
      remoteList: VaultSyncPayloadMerger.extractMapList(remote.totp),
      keyField: 'id',
      tombstonePrefix: 'totp:',
      tombstones: unionTombstones,
    });
    const mergedSnippets = VaultSyncPayloadMerger.mergeCollection({
      localList: VaultSyncPayloadMerger.extractMapList(local.snippets),
      remoteList: VaultSyncPayloadMerger.extractMapList(remote.snippets),
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
      syncSchema: VaultSyncPayloadMerger.syncSchemaVersion,
      updatedAtMs: Math.max(ts, Math.max(localTopTs, remoteTopTs)),
      hosts: mergedHosts,
      credentials: mergedCreds,
      folders: mergedFolders,
      totp: mergedTotp,
      snippets: mergedSnippets,
      tombstones: VaultSyncPayloadMerger.capTombstones(unionTombstones),
    };
  }

  private static extractMapList(raw: unknown): Record<string, unknown>[] {
    if (!Array.isArray(raw)) return [];
    const out: Record<string, unknown>[] = [];
    for (const item of raw) {
      if (isPlainObject(item)) {
        out.push({ ...item });
      }
    }
    return out;
  }

  private static mergeCollection(params: {
    localList: Record<string, unknown>[];
    remoteList: Record<string, unknown>[];
    keyField: string;
    tombstonePrefix: string;
    tombstones: Record<string, number>;
  }): Record<string, unknown>[] {
    const localByKey = new Map<string, Record<string, unknown>>();
    const orderedKeys: string[] = [];

    for (const item of params.localList) {
      const k = String(item[params.keyField] ?? '').trim();
      if (!k) continue;
      if (!localByKey.has(k)) orderedKeys.push(k);
      localByKey.set(k, item);
    }

    const remoteByKey = new Map<string, Record<string, unknown>>();
    for (const item of params.remoteList) {
      const k = String(item[params.keyField] ?? '').trim();
      if (!k) continue;
      if (!localByKey.has(k) && !remoteByKey.has(k)) {
        orderedKeys.push(k);
      }
      remoteByKey.set(k, item);
    }

    const merged: Record<string, unknown>[] = [];
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

      const tombKey = `${params.tombstonePrefix}${k}`;
      const deletedAt = params.tombstones[tombKey] ?? 0;
      if (deletedAt > maxItemTs) {
        continue;
      }
      if (deletedAt > 0 && maxItemTs >= deletedAt) {
        delete params.tombstones[tombKey];
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
}

export interface HttpResponseSnapshot {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export async function executeRawHttp(params: {
  method: string;
  url: string | URL;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  maxRedirects?: number;
}): Promise<HttpResponseSnapshot> {
  const timeoutMs = params.timeoutMs ?? 20_000;
  const maxRedirects = params.maxRedirects ?? 4;

  const attempt = (targetUrl: URL, redirectsLeft: number): Promise<HttpResponseSnapshot> =>
    new Promise((resolve, reject) => {
      const isHttps = targetUrl.protocol === 'https:';
      if (!isHttps && targetUrl.protocol !== 'http:') {
        reject(new VaultCloudSyncError(`Unsupported URL protocol: ${targetUrl.protocol}`, 'invalid-url'));
        return;
      }
      const bodyBuf =
        params.body === undefined
          ? undefined
          : Buffer.isBuffer(params.body)
            ? params.body
            : Buffer.from(params.body, 'utf8');

      const headers: Record<string, string> = { ...(params.headers ?? {}) };
      if (bodyBuf !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
        headers['Content-Length'] = String(bodyBuf.length);
      }

      const transport = isHttps ? https : http;
      const req = transport.request(
        targetUrl,
        {
          method: params.method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (
            (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
            typeof location === 'string' &&
            location.length > 0 &&
            redirectsLeft > 0 &&
            (params.method === 'GET' || status === 307 || status === 308)
          ) {
            res.resume();
            let nextUrl: URL;
            try {
              nextUrl = new URL(location, targetUrl);
            } catch {
              reject(new VaultCloudSyncError('Invalid redirect location from cloud server.', 'redirect-error'));
              return;
            }
            attempt(nextUrl, redirectsLeft - 1).then(resolve, reject);
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: status,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', (err) => {
            reject(new VaultCloudSyncError(`Network stream failed: ${err.message}`, 'network-error'));
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new VaultCloudSyncError('Cloud request timed out.', 'timeout'));
      });
      req.on('error', (err) => {
        if (err instanceof VaultCloudSyncError) {
          reject(err);
        } else {
          reject(new VaultCloudSyncError(`Network connection failed: ${err.message}`, 'network-error'));
        }
      });

      if (bodyBuf !== undefined) {
        req.write(bodyBuf);
      }
      req.end();
    });

  const initialUrl = typeof params.url === 'string' ? new URL(params.url) : params.url;
  return attempt(initialUrl, maxRedirects);
}

export interface VaultCloudSyncTransport {
  downloadEnvelope(): Promise<string | null>;
  uploadEnvelope(sealedJson: string): Promise<void>;
}

export interface GoogleAccessTokenProvider {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = toBase64Url(randomBytes(48));
  const codeChallenge = toBase64Url(createHash('sha256').update(codeVerifier, 'ascii').digest());
  return { codeVerifier, codeChallenge };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildLoopbackOAuthHtml(params: { ok: boolean; title: string; detail: string }): string {
  const accent = params.ok ? '#80D3A3' : '#FFAAA1';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(params.title)} — JalaDesk</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #090E17;
      color: #E3EAF2;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 440px;
      margin: 24px;
      padding: 28px;
      background: #141D29;
      border: 1px solid #26364A;
      border-radius: 12px;
    }
    h1 {
      margin: 0 0 10px 0;
      font-size: 19px;
      font-weight: 600;
      color: ${accent};
    }
    p {
      margin: 0;
      font-size: 14px;
      line-height: 1.55;
      color: #C3CFDB;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.title)}</h1>
    <p>${escapeHtml(params.detail)}</p>
  </main>
</body>
</html>`;
}

function decodeJwtPayloadClaims(jwt: string): Record<string, unknown> | null {
  const segments = jwt.split('.');
  if (segments.length < 2 || !segments[1]) return null;
  try {
    const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface GoogleOAuthLoopbackOptions {
  clientId?: string;
  clientSecret?: string;
  authEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  scope?: string;
  openExternal: (authUrl: string) => Promise<void> | void;
  authTimeoutMs?: number;
  httpTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface GoogleOAuthSignInOutput {
  account: GoogleAuthAccountInfo;
  tokens: GoogleOAuthTokenState;
  redirectUri: string;
}

export async function runGoogleDesktopLoopbackOAuth(
  options: GoogleOAuthLoopbackOptions,
): Promise<GoogleOAuthSignInOutput> {
  const resolvedOAuth = resolveGoogleDesktopOAuthCredentials(options.clientId, options.clientSecret);
  const clientId = resolvedOAuth.clientId;
  if (!clientId) {
    throw new VaultCloudSyncError(
      UNCONFIGURED_GOOGLE_OAUTH_ADMIN_MESSAGE,
      'missing-oauth-client-id',
    );
  }
  const clientSecret = resolvedOAuth.clientSecret;
  const authEndpoint = (options.authEndpoint ?? GOOGLE_OAUTH_DEFAULT_AUTH_URL).trim() || GOOGLE_OAUTH_DEFAULT_AUTH_URL;
  const tokenEndpoint =
    (options.tokenEndpoint ?? GOOGLE_OAUTH_DEFAULT_TOKEN_URL).trim() || GOOGLE_OAUTH_DEFAULT_TOKEN_URL;
  const userInfoEndpoint =
    (options.userInfoEndpoint ?? GOOGLE_OAUTH_DEFAULT_USERINFO_URL).trim() || GOOGLE_OAUTH_DEFAULT_USERINFO_URL;
  const scope = (options.scope ?? GOOGLE_DRIVE_APPDATA_SCOPE).trim() || GOOGLE_DRIVE_APPDATA_SCOPE;
  const authTimeoutMs = options.authTimeoutMs ?? 180_000;
  const httpTimeoutMs = options.httpTimeoutMs ?? 20_000;

  const { codeVerifier, codeChallenge } = createPkcePair();
  const expectedState = toBase64Url(randomBytes(24));

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  let settled = false;
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== '/oauth2callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('Not Found');
      return;
    }

    const oauthErr = reqUrl.searchParams.get('error');
    const returnedState = reqUrl.searchParams.get('state') ?? '';
    const authCode = reqUrl.searchParams.get('code') ?? '';

    if (oauthErr) {
      const desc = reqUrl.searchParams.get('error_description') ?? oauthErr;
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      res.end(
        buildLoopbackOAuthHtml({
          ok: false,
          title: 'Google Sign-In Cancelled',
          detail: `Google returned "${desc}". Return to JalaDesk to try again.`,
        }),
      );
      if (!settled) {
        settled = true;
        rejectCode(new VaultCloudSyncError(`Google Sign-In failed: ${desc}`, 'oauth-denied'));
      }
      return;
    }

    if (returnedState !== expectedState || !authCode) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      res.end(
        buildLoopbackOAuthHtml({
          ok: false,
          title: 'Invalid Authorization Callback',
          detail: 'State mismatch or missing authorization code. Return to JalaDesk and retry Sign in with Google.',
        }),
      );
      if (!settled) {
        settled = true;
        rejectCode(new VaultCloudSyncError('Invalid OAuth callback state or missing authorization code.', 'oauth-state-mismatch'));
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
    res.end(
      buildLoopbackOAuthHtml({
        ok: true,
        title: 'Google Account Connected',
        detail: 'Zero-knowledge encrypted Cloud Sync is now bound in JalaDesk. You can close this browser tab.',
      }),
    );
    if (!settled) {
      settled = true;
      resolveCode(authCode);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== 'number') {
    server.close();
    throw new VaultCloudSyncError('Unable to allocate loopback port for Google OAuth.', 'loopback-failed');
  }
  const redirectUri = `http://127.0.0.1:${addr.port}/oauth2callback`;

  const authUrl = new URL(authEndpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', expectedState);

  let timer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    if (!settled) {
      settled = true;
      rejectCode(new VaultCloudSyncError('Google Sign-In was cancelled.', 'oauth-cancelled'));
    }
  };

  try {
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectCode(new VaultCloudSyncError('Google Sign-In timed out waiting for browser authorization.', 'oauth-timeout'));
      }
    }, authTimeoutMs);

    await options.openExternal(authUrl.toString());
    const authorizationCode = await codePromise;

    const tokenForm = new URLSearchParams({
      code: authorizationCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });
    if (clientSecret.length > 0) {
      tokenForm.set('client_secret', clientSecret);
    }

    const tokenRes = await executeRawHttp({
      method: 'POST',
      url: tokenEndpoint,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenForm.toString(),
      timeoutMs: httpTimeoutMs,
    });

    let tokenJson: unknown;
    try {
      tokenJson = JSON.parse(tokenRes.body);
    } catch {
      tokenJson = null;
    }

    if (tokenRes.statusCode !== 200 || !isPlainObject(tokenJson)) {
      const errDetail =
        isPlainObject(tokenJson) && typeof tokenJson.error_description === 'string'
          ? tokenJson.error_description
          : isPlainObject(tokenJson) && typeof tokenJson.error === 'string'
            ? tokenJson.error
            : `HTTP ${tokenRes.statusCode}`;
      throw new VaultCloudSyncError(`Google OAuth token exchange failed (${errDetail}).`, 'oauth-token-failed');
    }

    const accessToken = typeof tokenJson.access_token === 'string' ? tokenJson.access_token.trim() : '';
    const refreshToken = typeof tokenJson.refresh_token === 'string' ? tokenJson.refresh_token.trim() : '';
    const expiresInSec =
      typeof tokenJson.expires_in === 'number' && Number.isFinite(tokenJson.expires_in) ? tokenJson.expires_in : 3600;
    const idToken = typeof tokenJson.id_token === 'string' ? tokenJson.id_token : '';

    if (!accessToken) {
      throw new VaultCloudSyncError('Google OAuth token response did not include an access_token.', 'oauth-token-failed');
    }

    let email = '';
    let displayName = '';

    try {
      const profileRes = await executeRawHttp({
        method: 'GET',
        url: userInfoEndpoint,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        timeoutMs: httpTimeoutMs,
      });
      if (profileRes.statusCode === 200) {
        const profileJson: unknown = JSON.parse(profileRes.body);
        if (isPlainObject(profileJson)) {
          if (typeof profileJson.email === 'string') email = profileJson.email.trim();
          if (typeof profileJson.name === 'string') displayName = profileJson.name.trim();
        }
      }
    } catch {
      // Fallback to id_token claims if userinfo endpoint is unreachable
    }

    if (!email && idToken) {
      const claims = decodeJwtPayloadClaims(idToken);
      if (claims) {
        if (typeof claims.email === 'string') email = claims.email.trim();
        if (!displayName && typeof claims.name === 'string') displayName = claims.name.trim();
      }
    }

    if (!email) {
      throw new VaultCloudSyncError(
        'Unable to read Google account email. Ensure openid and email scopes were granted.',
        'oauth-userinfo-failed',
      );
    }

    return {
      account: { email, displayName },
      tokens: {
        accessToken,
        refreshToken,
        expiresAtMs: Date.now() + Math.max(60, expiresInSec) * 1000,
        scope: typeof tokenJson.scope === 'string' ? tokenJson.scope : scope,
        tokenType: typeof tokenJson.token_type === 'string' ? tokenJson.token_type : 'Bearer',
      },
      redirectUri,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function refreshGoogleOAuthAccessToken(params: {
  clientId?: string;
  clientSecret?: string;
  refreshToken: string;
  tokenEndpoint?: string;
  timeoutMs?: number;
}): Promise<GoogleOAuthTokenState> {
  const resolvedOAuth = resolveGoogleDesktopOAuthCredentials(params.clientId, params.clientSecret);
  const clientId = resolvedOAuth.clientId;
  const refreshToken = params.refreshToken.trim();
  if (!clientId) {
    throw new VaultCloudSyncError(
      UNCONFIGURED_GOOGLE_OAUTH_ADMIN_MESSAGE,
      'missing-oauth-client-id',
    );
  }
  if (!refreshToken) {
    throw new VaultCloudSyncError(
      'Google session expired and no refresh token is stored. Click "Sign in with Google" to reconnect.',
      'oauth-refresh-missing',
    );
  }
  const tokenEndpoint =
    (params.tokenEndpoint ?? GOOGLE_OAUTH_DEFAULT_TOKEN_URL).trim() || GOOGLE_OAUTH_DEFAULT_TOKEN_URL;
  const form = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const secret = resolvedOAuth.clientSecret;
  if (secret.length > 0) {
    form.set('client_secret', secret);
  }

  const res = await executeRawHttp({
    method: 'POST',
    url: tokenEndpoint,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
    timeoutMs: params.timeoutMs ?? 20_000,
  });

  let decoded: unknown;
  try {
    decoded = JSON.parse(res.body);
  } catch {
    decoded = null;
  }
  if (res.statusCode !== 200 || !isPlainObject(decoded) || typeof decoded.access_token !== 'string') {
    const detail =
      isPlainObject(decoded) && typeof decoded.error_description === 'string'
        ? decoded.error_description
        : `HTTP ${res.statusCode}`;
    throw new VaultCloudSyncError(
      `Google Drive session refresh failed (${detail}). Click "Sign in with Google" to reauthorize.`,
      'oauth-refresh-failed',
    );
  }
  const expiresInSec =
    typeof decoded.expires_in === 'number' && Number.isFinite(decoded.expires_in) ? decoded.expires_in : 3600;

  return {
    accessToken: decoded.access_token.trim(),
    refreshToken:
      typeof decoded.refresh_token === 'string' && decoded.refresh_token.trim().length > 0
        ? decoded.refresh_token.trim()
        : refreshToken,
    expiresAtMs: Date.now() + Math.max(60, expiresInSec) * 1000,
    scope: typeof decoded.scope === 'string' ? decoded.scope : GOOGLE_DRIVE_APPDATA_SCOPE,
    tokenType: typeof decoded.token_type === 'string' ? decoded.token_type : 'Bearer',
  };
}

/**
 * Adapter 1: Google Drive v3 `appDataFolder` REST Transport.
 * Reads and writes `jaladesk-vault-v1.jvault` (with automatic compatibility lookup for `jaladesk_vault_sync_v1.jdesk`).
 */
export class GoogleDriveAppDataSyncTransport implements VaultCloudSyncTransport {
  static readonly defaultApiBaseUrl = GOOGLE_DRIVE_DEFAULT_API_BASE_URL;
  static readonly defaultVaultFileName = GOOGLE_DRIVE_PRIMARY_VAULT_FILE;

  private readonly authProvider: GoogleAccessTokenProvider;
  private readonly apiBaseUrl: string;
  private readonly fileName: string;
  private readonly timeoutMs: number;

  constructor(options: {
    authProvider: GoogleAccessTokenProvider;
    apiBaseUrl?: string;
    fileName?: string;
    timeoutMs?: number;
  }) {
    this.authProvider = options.authProvider;
    this.apiBaseUrl = (options.apiBaseUrl ?? GOOGLE_DRIVE_DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '');
    this.fileName = (options.fileName ?? GOOGLE_DRIVE_PRIMARY_VAULT_FILE).trim() || GOOGLE_DRIVE_PRIMARY_VAULT_FILE;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async authorizedCall(params: {
    method: string;
    url: string;
    extraHeaders?: Record<string, string>;
    body?: Buffer | string;
  }): Promise<HttpResponseSnapshot> {
    let token = await this.authProvider.getAccessToken({ forceRefresh: false });
    const buildHeaders = (bearer: string): Record<string, string> => ({
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
      ...(params.extraHeaders ?? {}),
    });

    let res = await executeRawHttp({
      method: params.method,
      url: params.url,
      headers: buildHeaders(token),
      body: params.body,
      timeoutMs: this.timeoutMs,
    });
    if (res.statusCode === 401) {
      token = await this.authProvider.getAccessToken({ forceRefresh: true });
      res = await executeRawHttp({
        method: params.method,
        url: params.url,
        headers: buildHeaders(token),
        body: params.body,
        timeoutMs: this.timeoutMs,
      });
    }
    return res;
  }

  private formatGoogleDriveHttpError(action: string, res: HttpResponseSnapshot): string {
    const body = res.body;
    const lower = body.toLowerCase();
    if (
      res.statusCode === 403 &&
      (body.includes('accessNotConfigured') ||
        lower.includes('drive api has not been used') ||
        body.includes('SERVICE_DISABLED'))
    ) {
      return 'Google Drive API is disabled in your Google Cloud project. Enable Google Drive API and click Sync Now.';
    }
    if (
      res.statusCode === 403 &&
      (body.includes('insufficientPermissions') || body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT'))
    ) {
      return 'Google Drive AppData permission is missing. Reconnect your Google account and grant AppData access.';
    }
    if (res.statusCode === 401) {
      return 'Google Drive session expired (HTTP 401). Click Sync Now to refresh authorization.';
    }
    try {
      const decoded: unknown = JSON.parse(body);
      if (isPlainObject(decoded) && isPlainObject(decoded.error)) {
        const msg = typeof decoded.error.message === 'string' ? decoded.error.message.trim() : '';
        if (msg.length > 0) {
          return `Google Drive ${action} failed (HTTP ${res.statusCode}): ${msg}`;
        }
      }
    } catch {
      // Ignore non-JSON error body
    }
    return `Google Drive ${action} failed (HTTP ${res.statusCode}).`;
  }

  private async findAppDataFileId(): Promise<string | null> {
    const candidates =
      this.fileName === GOOGLE_DRIVE_PRIMARY_VAULT_FILE
        ? [GOOGLE_DRIVE_PRIMARY_VAULT_FILE, GOOGLE_DRIVE_ALT_VAULT_FILE]
        : [this.fileName];
    const namePredicates = candidates.map((n) => `name = '${n.replace(/'/g, "\\'")}'`).join(' or ');
    const query = candidates.length > 1 ? `(${namePredicates}) and trashed = false` : `${namePredicates} and trashed = false`;
    const url =
      `${this.apiBaseUrl}/drive/v3/files` +
      `?spaces=appDataFolder` +
      `&q=${encodeURIComponent(query)}` +
      `&fields=${encodeURIComponent('files(id,name,modifiedTime)')}` +
      `&pageSize=10`;

    const res = await this.authorizedCall({ method: 'GET', url });
    if (res.statusCode !== 200) {
      throw new VaultCloudSyncError(this.formatGoogleDriveHttpError('lookup', res), `gdrive-http-${res.statusCode}`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(res.body);
    } catch {
      return null;
    }
    if (isPlainObject(decoded) && Array.isArray(decoded.files) && decoded.files.length > 0) {
      const validFiles = decoded.files.filter(isPlainObject);
      const exactPrimary = validFiles.find((f) => f.name === this.fileName && typeof f.id === 'string' && f.id.trim());
      if (exactPrimary) return String(exactPrimary.id).trim();
      const fallback = validFiles.find((f) => typeof f.id === 'string' && f.id.trim());
      if (fallback) return String(fallback.id).trim();
    }
    return null;
  }

  async downloadEnvelope(): Promise<string | null> {
    const fileId = await this.findAppDataFileId();
    if (!fileId) return null;
    const url = `${this.apiBaseUrl}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    const res = await this.authorizedCall({ method: 'GET', url });
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) {
      throw new VaultCloudSyncError(this.formatGoogleDriveHttpError('download', res), `gdrive-http-${res.statusCode}`);
    }
    return res.body.trim().length === 0 ? null : res.body;
  }

  async uploadEnvelope(sealedJson: string): Promise<void> {
    const existingId = await this.findAppDataFileId();
    if (existingId) {
      const patchUrl = `${this.apiBaseUrl}/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=media`;
      const res = await this.authorizedCall({
        method: 'PATCH',
        url: patchUrl,
        extraHeaders: { 'Content-Type': 'application/json; charset=utf-8' },
        body: Buffer.from(sealedJson, 'utf8'),
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new VaultCloudSyncError(this.formatGoogleDriveHttpError('update', res), `gdrive-http-${res.statusCode}`);
      }
      return;
    }

    const boundary = `jaladesk_appdata_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const metadataJson = JSON.stringify({
      name: this.fileName,
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

    const createUrl = `${this.apiBaseUrl}/upload/drive/v3/files?uploadType=multipart`;
    const res = await this.authorizedCall({
      method: 'POST',
      url: createUrl,
      extraHeaders: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: Buffer.from(multipartBody, 'utf8'),
    });
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new VaultCloudSyncError(this.formatGoogleDriveHttpError('upload', res), `gdrive-http-${res.statusCode}`);
    }
  }
}

export interface SftpRunnerContext {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKeyPem: string;
  jumpHost: string;
  remotePath: string;
  timeoutMs: number;
}

export interface SftpCommandExecutor {
  readRemoteFile(ctx: SftpRunnerContext): Promise<string | null>;
  writeRemoteFile(ctx: SftpRunnerContext, content: string): Promise<void>;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runSpawnWithInput(params: {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdinData?: Buffer;
  timeoutMs: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.bin, params.args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: params.env,
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new VaultCloudSyncError('SFTP connection timed out.', 'sftp-timeout'));
      }
    }, params.timeoutMs);

    child.stdout.on('data', (c: Buffer) => outChunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new VaultCloudSyncError(`Failed to launch ${params.bin}: ${err.message}`, 'sftp-spawn-error'));
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
        });
      }
    });

    if (params.stdinData !== undefined) {
      child.stdin.write(params.stdinData);
    }
    child.stdin.end();
  });
}

const defaultSystemSftpExecutor: SftpCommandExecutor = {
  async readRemoteFile(ctx: SftpRunnerContext): Promise<string | null> {
    return withSshTempMaterial(ctx, async ({ sshBin, baseArgs, env }) => {
      const target = `${ctx.username}@${ctx.host}`;
      const pathsToTry =
        ctx.remotePath === SFTP_DEFAULT_REMOTE_PATH
          ? [SFTP_DEFAULT_REMOTE_PATH, SFTP_ALT_REMOTE_PATH]
          : [ctx.remotePath];

      for (const candidate of pathsToTry) {
        const q = shellSingleQuote(candidate);
        const remoteScript = `if [ -f ${q} ]; then cat ${q}; else exit 44; fi`;
        const res = await runSpawnWithInput({
          bin: sshBin,
          args: [...baseArgs, '-p', String(ctx.port), target, remoteScript],
          env,
          timeoutMs: ctx.timeoutMs,
        });
        if (res.code === 0) {
          return res.stdout.trim().length === 0 ? null : res.stdout;
        }
        if (res.code !== 44) {
          // Try sftp batch fallback when remote user uses sftp-only/restricted shell
          const fetched = await sftpBatchDownloadFallback(ctx, candidate, baseArgs, env);
          if (fetched !== undefined) return fetched;
          throw new VaultCloudSyncError(
            `SFTP download failed: ${res.stderr.trim() || `exit code ${res.code}`}`,
            'sftp-read-failed',
          );
        }
      }
      return null;
    });
  },

  async writeRemoteFile(ctx: SftpRunnerContext, content: string): Promise<void> {
    await withSshTempMaterial(ctx, async ({ sshBin, baseArgs, env, scratchDir }) => {
      const target = `${ctx.username}@${ctx.host}`;
      const cleanPath = ctx.remotePath;
      const slashIdx = cleanPath.lastIndexOf('/');
      const parentDir = slashIdx > 0 ? cleanPath.slice(0, slashIdx) : '';
      const qPath = shellSingleQuote(cleanPath);
      const qTmp = shellSingleQuote(`${cleanPath}.tmp`);
      const mkdirPart = parentDir ? `mkdir -p ${shellSingleQuote(parentDir)} && ` : '';
      const remoteScript = `${mkdirPart}cat > ${qTmp} && mv -f ${qTmp} ${qPath}`;

      const res = await runSpawnWithInput({
        bin: sshBin,
        args: [...baseArgs, '-p', String(ctx.port), target, remoteScript],
        env,
        stdinData: Buffer.from(content, 'utf8'),
        timeoutMs: ctx.timeoutMs,
      });
      if (res.code === 0) return;

      // Fallback to sftp batch mode for restricted SFTP-only accounts
      const okFallback = await sftpBatchUploadFallback(ctx, content, baseArgs, env, scratchDir);
      if (!okFallback) {
        throw new VaultCloudSyncError(
          `SFTP upload failed: ${res.stderr.trim() || `exit code ${res.code}`}`,
          'sftp-write-failed',
        );
      }
    });
  },
};

export function expandSshKeyPath(rawPath: string, home = homedir()): string {
  const trimmed = rawPath.trim();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(home, trimmed.slice(2));
  }
  return trimmed;
}

export async function withSshTempMaterial<T>(
  ctx: SftpRunnerContext,
  fn: (prepared: {
    sshBin: string;
    baseArgs: string[];
    env: NodeJS.ProcessEnv;
    scratchDir: string;
  }) => Promise<T>,
): Promise<T> {
  const scratchDir = join(tmpdir(), `jaladesk-sftp-${randomUUID()}`);
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  try {
    const baseArgs: string[] = [
      '-o',
      `ConnectTimeout=${Math.max(5, Math.ceil(ctx.timeoutMs / 1000))}`,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ServerAliveInterval=15',
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };

    if (ctx.jumpHost.trim().length > 0) {
      baseArgs.push('-J', ctx.jumpHost.trim());
    }
    if (ctx.privateKeyPem.trim().length > 0) {
      if (ctx.privateKeyPem.includes('-----BEGIN')) {
        const keyPath = join(scratchDir, 'id_sync_key');
        const normalizedKey = ctx.privateKeyPem.endsWith('\n') ? ctx.privateKeyPem : `${ctx.privateKeyPem}\n`;
        await writeFile(keyPath, normalizedKey, { encoding: 'utf8', mode: 0o600 });
        await chmod(keyPath, 0o600);
        baseArgs.push('-i', keyPath, '-o', 'IdentitiesOnly=yes');
      } else {
        const expandedPath = expandSshKeyPath(ctx.privateKeyPem);
        baseArgs.push('-i', expandedPath, '-o', 'IdentitiesOnly=yes');
      }
    }
    if (ctx.password.length > 0) {
      const askpassPath = join(scratchDir, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
      if (process.platform === 'win32') {
        await writeFile(askpassPath, '@echo off\r\necho %JALADESK_SFTP_PASS%\r\n', {
          encoding: 'utf8',
          mode: 0o700,
        });
      } else {
        await writeFile(askpassPath, '#!/bin/sh\nprintf "%s\\n" "$JALADESK_SFTP_PASS"\n', {
          encoding: 'utf8',
          mode: 0o700,
        });
        await chmod(askpassPath, 0o700);
      }
      baseArgs.push('-o', 'NumberOfPasswordPrompts=1');
      env.SSH_ASKPASS = askpassPath;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.DISPLAY = env.DISPLAY || 'jaladesk:0';
      env.JALADESK_SFTP_PASS = ctx.password;
    } else {
      baseArgs.push('-o', 'BatchMode=yes');
    }

    const sshBin = process.platform === 'win32' ? 'ssh' : '/usr/bin/ssh';
    return await fn({ sshBin, baseArgs, env, scratchDir });
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function sftpBatchDownloadFallback(
  ctx: SftpRunnerContext,
  remotePath: string,
  baseArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null | undefined> {
  const localOut = join(tmpdir(), `jaladesk-sftp-dl-${randomUUID()}.jvault`);
  const batchFile = `${localOut}.batch`;
  try {
    await writeFile(batchFile, `get "${remotePath.replace(/"/g, '\\"')}" "${localOut.replace(/"/g, '\\"')}"\n`, {
      mode: 0o600,
    });
    const sftpBin = process.platform === 'win32' ? 'sftp' : '/usr/bin/sftp';
    const res = await runSpawnWithInput({
      bin: sftpBin,
      args: [...baseArgs, '-P', String(ctx.port), '-b', batchFile, `${ctx.username}@${ctx.host}`],
      env,
      timeoutMs: ctx.timeoutMs,
    });
    if (res.code === 0) {
      const content = await readFile(localOut, 'utf8');
      return content.trim().length === 0 ? null : content;
    }
    const lowerErr = res.stderr.toLowerCase();
    if (lowerErr.includes('not found') || lowerErr.includes('no such file')) {
      return null;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await unlink(localOut).catch(() => undefined);
    await unlink(batchFile).catch(() => undefined);
  }
}

async function sftpBatchUploadFallback(
  ctx: SftpRunnerContext,
  content: string,
  baseArgs: string[],
  env: NodeJS.ProcessEnv,
  scratchDir: string,
): Promise<boolean> {
  try {
    const localPayload = join(scratchDir, 'upload.jvault');
    const batchFile = join(scratchDir, 'upload.batch');
    await writeFile(localPayload, content, { encoding: 'utf8', mode: 0o600 });

    const lines: string[] = [];
    const slashIdx = ctx.remotePath.lastIndexOf('/');
    if (slashIdx > 0) {
      const parent = ctx.remotePath.slice(0, slashIdx);
      const isAbs = parent.startsWith('/');
      let cur = '';
      for (const seg of parent.split('/').filter(Boolean)) {
        cur = cur ? `${cur}/${seg}` : isAbs ? `/${seg}` : seg;
        lines.push(`-mkdir "${cur.replace(/"/g, '\\"')}"`);
      }
    }
    lines.push(`put "${localPayload.replace(/"/g, '\\"')}" "${ctx.remotePath.replace(/"/g, '\\"')}"`);
    await writeFile(batchFile, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });

    const sftpBin = process.platform === 'win32' ? 'sftp' : '/usr/bin/sftp';
    const res = await runSpawnWithInput({
      bin: sftpBin,
      args: [...baseArgs, '-P', String(ctx.port), '-b', batchFile, `${ctx.username}@${ctx.host}`],
      env,
      timeoutMs: ctx.timeoutMs,
    });
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * Adapter 2: Private SSH / SFTP Server Transport.
 */
export class SftpVaultSyncTransport implements VaultCloudSyncTransport {
  static readonly defaultRemotePath = SFTP_DEFAULT_REMOTE_PATH;

  private readonly ctx: SftpRunnerContext;
  private readonly executor: SftpCommandExecutor;

  constructor(options: {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKeyPem?: string;
    jumpHost?: string;
    remotePath?: string;
    timeoutMs?: number;
    executor?: SftpCommandExecutor;
  }) {
    const normalizedRemote = (options.remotePath ?? SFTP_DEFAULT_REMOTE_PATH).trim().replace(/\\/g, '/');
    this.ctx = {
      host: options.host.trim(),
      port: options.port && options.port > 0 ? Math.min(65535, Math.trunc(options.port)) : 22,
      username: options.username.trim() || 'root',
      password: options.password ?? '',
      privateKeyPem: options.privateKeyPem ?? '',
      jumpHost: (options.jumpHost ?? '').trim(),
      remotePath: normalizedRemote || SFTP_DEFAULT_REMOTE_PATH,
      timeoutMs: options.timeoutMs ?? 15_000,
    };
    this.executor = options.executor ?? defaultSystemSftpExecutor;
  }

  private assertConfigured(): void {
    if (!this.ctx.host) {
      throw new VaultCloudSyncError('Enter an SFTP server host or IP address.', 'sftp-missing-host');
    }
  }

  async downloadEnvelope(): Promise<string | null> {
    this.assertConfigured();
    return this.executor.readRemoteFile(this.ctx);
  }

  async uploadEnvelope(sealedJson: string): Promise<void> {
    this.assertConfigured();
    await this.executor.writeRemoteFile(this.ctx, sealedJson);
  }
}

/**
 * Adapter 3: WebDAV Basic-Auth Transport (Nextcloud / OwnCloud / Synology / Private NAS).
 */
export class WebDavVaultSyncTransport implements VaultCloudSyncTransport {
  private readonly fileUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;

  constructor(options: {
    fileUrl: string;
    username: string;
    password: string;
    timeoutMs?: number;
  }) {
    this.fileUrl = options.fileUrl;
    this.username = options.username;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  static isLoopbackOrPrivateLanHost(rawHost: string): boolean {
    const h = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1' || h.startsWith('127.')) {
      return true;
    }
    const parts = h.split('.');
    if (parts.length === 4) {
      const octets = parts.map((p) => (/^\d+$/.test(p) ? Number.parseInt(p, 10) : -1));
      if (octets.every((x) => x >= 0 && x <= 255)) {
        const a = octets[0]!;
        const b = octets[1]!;
        if (a === 10) return true;
        if (a === 192 && b === 168) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
      }
    }
    return false;
  }

  private validatedUrl(): URL {
    const trimmed = this.fileUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new VaultCloudSyncError('Enter a valid WebDAV .jvault URL.', 'webdav-invalid-url');
    }
    if (!parsed.hostname || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      throw new VaultCloudSyncError('Enter a valid WebDAV .jvault URL.', 'webdav-invalid-url');
    }
    if (parsed.protocol === 'http:' && !WebDavVaultSyncTransport.isLoopbackOrPrivateLanHost(parsed.hostname)) {
      throw new VaultCloudSyncError(
        'WebDAV requires HTTPS over public networks (HTTP is only permitted on private LAN / loopback).',
        'webdav-insecure-url',
      );
    }
    return parsed;
  }

  private authHeaders(contentType?: string): Record<string, string> {
    const basic = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      'User-Agent': 'JalaDesk-Desktop',
      ...(contentType ? { 'Content-Type': contentType } : {}),
    };
  }

  async downloadEnvelope(): Promise<string | null> {
    const url = this.validatedUrl();
    const res = await executeRawHttp({
      method: 'GET',
      url,
      headers: this.authHeaders(),
      timeoutMs: this.timeoutMs,
    });
    if (res.statusCode === 404) return null;
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new VaultCloudSyncError(
        `WebDAV authentication rejected (HTTP ${res.statusCode}). Check username & app password.`,
        `webdav-http-${res.statusCode}`,
      );
    }
    if (res.statusCode !== 200) {
      throw new VaultCloudSyncError(`WebDAV GET failed (HTTP ${res.statusCode}).`, `webdav-http-${res.statusCode}`);
    }
    return res.body.trim().length === 0 ? null : res.body;
  }

  async uploadEnvelope(sealedJson: string): Promise<void> {
    const url = this.validatedUrl();
    const res = await executeRawHttp({
      method: 'PUT',
      url,
      headers: this.authHeaders('application/json; charset=utf-8'),
      body: Buffer.from(sealedJson, 'utf8'),
      timeoutMs: this.timeoutMs,
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new VaultCloudSyncError(
        `WebDAV authentication rejected (HTTP ${res.statusCode}). Check username & app password.`,
        `webdav-http-${res.statusCode}`,
      );
    }
    if (res.statusCode === 409) {
      throw new VaultCloudSyncError(
        'WebDAV parent folder does not exist (HTTP 409). Verify the folder path in your URL.',
        'webdav-http-409',
      );
    }
    if (res.statusCode !== 200 && res.statusCode !== 201 && res.statusCode !== 204) {
      throw new VaultCloudSyncError(`WebDAV PUT failed (HTTP ${res.statusCode}).`, `webdav-http-${res.statusCode}`);
    }
  }
}

/**
 * Adapter 4: GitHub Secret Gist Transport (`POST /gists`, `GET /gists`, `PATCH /gists/{id}`).
 * Compatible with both `jaladesk-vault.jvault` (Mobile) and `jaladesk_vault_sync.jdesk`.
 */
export class GitHubGistVaultSyncTransport implements VaultCloudSyncTransport {
  static readonly defaultApiBaseUrl = GITHUB_DEFAULT_API_BASE_URL;
  static readonly defaultGistFileName = GITHUB_PRIMARY_GIST_FILE;

  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly gistFileName: string;
  private readonly onGistIdResolved: ((resolvedGistId: string) => void) | undefined;
  private readonly timeoutMs: number;
  private resolvedId: string | null;

  constructor(options: {
    token: string;
    gistId?: string;
    apiBaseUrl?: string;
    gistFileName?: string;
    onGistIdResolved?: (resolvedGistId: string) => void;
    timeoutMs?: number;
  }) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? GITHUB_DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '');
    this.gistFileName = (options.gistFileName ?? GITHUB_PRIMARY_GIST_FILE).trim() || GITHUB_PRIMARY_GIST_FILE;
    this.onGistIdResolved = options.onGistIdResolved;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    const initialId = (options.gistId ?? '').trim();
    this.resolvedId = initialId.length > 0 ? initialId : null;
  }

  get resolvedGistId(): string | null {
    return this.resolvedId;
  }

  private headers(jsonBody = false): Record<string, string> {
    const cleanToken = this.token.trim();
    if (!cleanToken) {
      throw new VaultCloudSyncError('Enter a GitHub Personal Access Token with gist scope.', 'github-missing-token');
    }
    return {
      Authorization: `Bearer ${cleanToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'JalaDesk-Desktop',
      ...(jsonBody ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    };
  }

  private candidateFileNames(): string[] {
    return this.gistFileName === GITHUB_PRIMARY_GIST_FILE
      ? [GITHUB_PRIMARY_GIST_FILE, GITHUB_ALT_GIST_FILE]
      : [this.gistFileName];
  }

  private async discoverExistingVaultGistId(): Promise<string | null> {
    const res = await executeRawHttp({
      method: 'GET',
      url: `${this.apiBaseUrl}/gists?per_page=50`,
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new VaultCloudSyncError(
        `GitHub token rejected (HTTP ${res.statusCode}). Ensure the token has gist scope.`,
        `github-http-${res.statusCode}`,
      );
    }
    if (res.statusCode !== 200) {
      throw new VaultCloudSyncError(
        `GitHub Gist list failed (HTTP ${res.statusCode}).`,
        `github-http-${res.statusCode}`,
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(res.body);
    } catch {
      return null;
    }
    if (!Array.isArray(decoded)) return null;

    const names = this.candidateFileNames();
    let fallbackPublicMatch: string | null = null;
    for (const entry of decoded) {
      if (!isPlainObject(entry) || !isPlainObject(entry.files)) continue;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const hasVaultFile = names.some((n) => Object.hasOwn(entry.files as object, n));
      if (id && hasVaultFile) {
        if (entry.public !== true) {
          this.resolvedId = id;
          this.onGistIdResolved?.(id);
          return id;
        }
        fallbackPublicMatch ??= id;
      }
    }
    if (fallbackPublicMatch) {
      this.resolvedId = fallbackPublicMatch;
      this.onGistIdResolved?.(fallbackPublicMatch);
      return fallbackPublicMatch;
    }
    return null;
  }

  async downloadEnvelope(): Promise<string | null> {
    const targetId = this.resolvedId ?? (await this.discoverExistingVaultGistId());
    if (!targetId) return null;

    const res = await executeRawHttp({
      method: 'GET',
      url: `${this.apiBaseUrl}/gists/${encodeURIComponent(targetId)}`,
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
    });
    if (res.statusCode === 404) return null;
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new VaultCloudSyncError(
        `GitHub token rejected (HTTP ${res.statusCode}).`,
        `github-http-${res.statusCode}`,
      );
    }
    if (res.statusCode !== 200) {
      throw new VaultCloudSyncError(
        `GitHub Gist fetch failed (HTTP ${res.statusCode}).`,
        `github-http-${res.statusCode}`,
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(res.body);
    } catch {
      return null;
    }
    if (!isPlainObject(decoded) || !isPlainObject(decoded.files)) return null;

    for (const candidate of this.candidateFileNames()) {
      const fileObj = decoded.files[candidate];
      if (isPlainObject(fileObj)) {
        const isTruncated = fileObj.truncated === true;
        const rawUrl = typeof fileObj.raw_url === 'string' ? fileObj.raw_url.trim() : '';
        if (isTruncated && rawUrl.length > 0) {
          const rawRes = await executeRawHttp({
            method: 'GET',
            url: rawUrl,
            headers: this.headers(),
            timeoutMs: this.timeoutMs,
          });
          if (rawRes.statusCode === 200) {
            return rawRes.body.trim().length === 0 ? null : rawRes.body;
          }
        }
        const content = typeof fileObj.content === 'string' ? fileObj.content : '';
        return content.trim().length === 0 ? null : content;
      }
    }
    return null;
  }

  async uploadEnvelope(sealedJson: string): Promise<void> {
    const targetId = this.resolvedId ?? (await this.discoverExistingVaultGistId());
    if (!targetId) {
      const createBody = JSON.stringify({
        description: 'JalaDesk Encrypted Vault (.jvault)',
        public: false,
        files: {
          [this.gistFileName]: { content: sealedJson },
        },
      });
      const res = await executeRawHttp({
        method: 'POST',
        url: `${this.apiBaseUrl}/gists`,
        headers: this.headers(true),
        body: Buffer.from(createBody, 'utf8'),
        timeoutMs: this.timeoutMs,
      });
      if (res.statusCode !== 201 && res.statusCode !== 200) {
        throw new VaultCloudSyncError(
          `GitHub Gist create failed (HTTP ${res.statusCode}).`,
          `github-http-${res.statusCode}`,
        );
      }
      try {
        const decoded: unknown = JSON.parse(res.body);
        if (isPlainObject(decoded) && typeof decoded.id === 'string' && decoded.id.trim().length > 0) {
          this.resolvedId = decoded.id.trim();
          this.onGistIdResolved?.(this.resolvedId);
        }
      } catch {
        // Ignore parse error when status succeeded
      }
      return;
    }

    const patchBody = JSON.stringify({
      description: 'JalaDesk Encrypted Vault (.jvault)',
      files: {
        [this.gistFileName]: { content: sealedJson },
      },
    });
    const res = await executeRawHttp({
      method: 'PATCH',
      url: `${this.apiBaseUrl}/gists/${encodeURIComponent(targetId)}`,
      headers: this.headers(true),
      body: Buffer.from(patchBody, 'utf8'),
      timeoutMs: this.timeoutMs,
    });
    if (res.statusCode !== 200) {
      throw new VaultCloudSyncError(
        `GitHub Gist update failed (HTTP ${res.statusCode}).`,
        `github-http-${res.statusCode}`,
      );
    }
    this.resolvedId = targetId;
  }
}

interface PersistedCloudSyncRecord {
  config: VaultSyncConfig;
  googleTokens: GoogleOAuthTokenState | null;
  tombstones: Record<string, number>;
}

const LOCAL_STORE_MAGIC = 'jaladesk-desktop-cloud-sync-store-v1';

/**
 * Encrypted-at-rest local store for Desktop Cloud Sync config, OAuth refresh tokens, and tombstones.
 * Uses a per-userData `0o600` random 256-bit key + HKDF-SHA256 + AES-256-GCM + atomic temp-rename
 * and a strict serialized async write queue (never triggering unrequested OS Keychain prompts).
 */
export class EncryptedCloudSyncConfigStore {
  private readonly userDataDir: string;
  private readonly stateFilePath: string;
  private readonly masterKeyPath: string;
  private cachedDek: Buffer | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { userDataDir: string; fileName?: string }) {
    this.userDataDir = options.userDataDir;
    this.stateFilePath = join(options.userDataDir, options.fileName ?? 'cloud-sync-state.enc.json');
    this.masterKeyPath = join(options.userDataDir, '.cloud-sync-local.key');
  }

  get filePath(): string {
    return this.stateFilePath;
  }

  private async getOrCreateDek(): Promise<Buffer> {
    if (this.cachedDek) return this.cachedDek;
    await mkdir(this.userDataDir, { recursive: true, mode: 0o700 });

    let rawSeed: Buffer | null = null;
    try {
      const existing = await readFile(this.masterKeyPath);
      if (existing.length >= 32) {
        rawSeed = existing.subarray(0, 32);
      }
    } catch {
      rawSeed = null;
    }

    if (!rawSeed) {
      rawSeed = randomBytes(32);
      const tmpKey = `${this.masterKeyPath}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmpKey, rawSeed, { mode: 0o600 });
      await rename(tmpKey, this.masterKeyPath);
    }

    const derived = Buffer.from(
      hkdfSync(
        'sha256',
        rawSeed,
        Buffer.from(this.userDataDir, 'utf8'),
        Buffer.from(LOCAL_STORE_MAGIC, 'utf8'),
        32,
      ),
    );
    this.cachedDek = derived;
    return derived;
  }

  async load(): Promise<PersistedCloudSyncRecord> {
    await this.writeQueue;
    let rawText: string;
    try {
      rawText = await readFile(this.stateFilePath, 'utf8');
    } catch {
      return {
        config: createDefaultVaultSyncConfig(),
        googleTokens: null,
        tombstones: {},
      };
    }

    try {
      const outer: unknown = JSON.parse(rawText);
      if (
        !isPlainObject(outer) ||
        outer.v !== 1 ||
        outer.magic !== LOCAL_STORE_MAGIC ||
        typeof outer.iv !== 'string' ||
        typeof outer.tag !== 'string' ||
        typeof outer.ciphertext !== 'string'
      ) {
        return {
          config: createDefaultVaultSyncConfig(),
          googleTokens: null,
          tombstones: {},
        };
      }
      const dek = await this.getOrCreateDek();
      const iv = Buffer.from(outer.iv, 'base64');
      const tag = Buffer.from(outer.tag, 'base64');
      const enc = Buffer.from(outer.ciphertext, 'base64');
      const plain = tryAesGcmOpen(dek, iv, enc, tag, Buffer.from(LOCAL_STORE_MAGIC, 'utf8'));
      if (!plain) {
        return {
          config: createDefaultVaultSyncConfig(),
          googleTokens: null,
          tombstones: {},
        };
      }
      const inner: unknown = JSON.parse(plain.toString('utf8'));
      if (!isPlainObject(inner)) {
        return {
          config: createDefaultVaultSyncConfig(),
          googleTokens: null,
          tombstones: {},
        };
      }

      const config = normalizeVaultSyncConfig(inner.config);
      let googleTokens: GoogleOAuthTokenState | null = null;
      if (isPlainObject(inner.googleTokens)) {
        const gt = inner.googleTokens;
        const accessToken = typeof gt.accessToken === 'string' ? gt.accessToken : '';
        const refreshToken = typeof gt.refreshToken === 'string' ? gt.refreshToken : '';
        if (accessToken || refreshToken) {
          googleTokens = {
            accessToken,
            refreshToken,
            expiresAtMs: typeof gt.expiresAtMs === 'number' && Number.isFinite(gt.expiresAtMs) ? gt.expiresAtMs : 0,
            scope: typeof gt.scope === 'string' ? gt.scope : GOOGLE_DRIVE_APPDATA_SCOPE,
            tokenType: typeof gt.tokenType === 'string' ? gt.tokenType : 'Bearer',
          };
        }
      }
      const tombstones = VaultSyncPayloadMerger.capTombstones(
        VaultSyncPayloadMerger.parseTombstones(inner.tombstones),
      );
      return { config, googleTokens, tombstones };
    } catch {
      return {
        config: createDefaultVaultSyncConfig(),
        googleTokens: null,
        tombstones: {},
      };
    }
  }

  save(record: PersistedCloudSyncRecord): Promise<void> {
    const snapshot: PersistedCloudSyncRecord = {
      config: { ...record.config },
      googleTokens: record.googleTokens ? { ...record.googleTokens } : null,
      tombstones: { ...record.tombstones },
    };
    const nextOp = this.writeQueue.then(async () => {
      const dek = await this.getOrCreateDek();
      await mkdir(dirname(this.stateFilePath), { recursive: true, mode: 0o700 });
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(LOCAL_STORE_MAGIC, 'utf8'));
      const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();

      const envelope = JSON.stringify(
        {
          v: 1,
          magic: LOCAL_STORE_MAGIC,
          iv: iv.toString('base64'),
          tag: tag.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          savedAtMs: Date.now(),
        },
        null,
        2,
      );

      const tmpPath = `${this.stateFilePath}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmpPath, envelope, { encoding: 'utf8', mode: 0o600 });
        await rename(tmpPath, this.stateFilePath);
      } catch (err) {
        await unlink(tmpPath).catch(() => undefined);
        throw err;
      }
    });
    this.writeQueue = nextOp.catch(() => undefined);
    return nextOp;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

/**
 * Monotonic bound protection matching Mobile `_protectBoundCloudSyncDraft` so closing the UI
 * or flushing a partial draft NEVER downgrades `isBound: true` to `false` or wipes `googleAccountEmail`.
 */
export function protectBoundCloudSyncDraft(
  current: VaultSyncConfig,
  draft: Partial<VaultSyncConfig> | VaultSyncConfig,
): VaultSyncConfig {
  const merged = normalizeVaultSyncConfig({ ...current, ...draft });
  if (current.isBound && !merged.isBound) {
    merged.isBound = true;
  }
  if (
    current.provider === 'googleDrive' &&
    merged.provider === 'googleDrive' &&
    current.googleAccountEmail.trim().length > 0 &&
    merged.googleAccountEmail.trim().length === 0
  ) {
    merged.googleAccountEmail = current.googleAccountEmail;
    merged.googleDisplayName = current.googleDisplayName;
  }
  if (current.googleClientId.length > 0 && draft.googleClientId === undefined) {
    merged.googleClientId = current.googleClientId;
  }
  if (current.googleClientSecret.length > 0 && draft.googleClientSecret === undefined) {
    merged.googleClientSecret = current.googleClientSecret;
  }
  return merged;
}

export interface DesktopCloudSyncVaultBridge {
  exportLocalPayload(tombstones: Record<string, number>): Promise<Record<string, unknown>> | Record<string, unknown>;
  applySyncedPayload(payload: VaultSyncPayload): Promise<void> | void;
  listSftpPresets?(): Promise<SftpSyncHostPreset[]> | SftpSyncHostPreset[];
}

export interface CloudSyncStateView {
  config: VaultSyncConfig;
  accountSummary: string;
  relativeLastSync: string;
  hasGoogleRefreshToken: boolean;
  sftpPresets: SftpSyncHostPreset[];
}

export interface DesktopCloudSyncServiceOptions {
  userDataDir: string;
  vaultBridge: DesktopCloudSyncVaultBridge;
  openExternal: (url: string) => Promise<void> | void;
  sftpExecutor?: SftpCommandExecutor;
  oauthTimeoutMs?: number;
  httpTimeoutMs?: number;
}

/**
 * High-level Desktop Cloud Sync orchestrator managing:
 * - Encrypted-at-rest local config + OAuth refresh token persistence
 * - 1-tap Google Drive OAuth2 PKCE Loopback sign-in with IMMEDIATE `isBound = true` persistence BEFORE sync
 * - Monotonic bound protection across UI close / HTTP 403 disabled Drive API / network errors
 * - Smart Merge, Force Push, Pull Only across Google Drive AppData, SFTP, WebDAV, and GitHub Secret Gist
 * - `.jvault` encrypted backup export & import
 */
export class DesktopCloudSyncService {
  private readonly store: EncryptedCloudSyncConfigStore;
  private readonly vaultBridge: DesktopCloudSyncVaultBridge;
  private readonly openExternal: (url: string) => Promise<void> | void;
  private readonly sftpExecutor: SftpCommandExecutor | undefined;
  private readonly oauthTimeoutMs: number;
  private readonly httpTimeoutMs: number;

  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private config: VaultSyncConfig = createDefaultVaultSyncConfig();
  private googleTokens: GoogleOAuthTokenState | null = null;
  private tombstones: Record<string, number> = {};

  constructor(options: DesktopCloudSyncServiceOptions) {
    this.store = new EncryptedCloudSyncConfigStore({ userDataDir: options.userDataDir });
    this.vaultBridge = options.vaultBridge;
    this.openExternal = options.openExternal;
    this.sftpExecutor = options.sftpExecutor;
    this.oauthTimeoutMs = options.oauthTimeoutMs ?? 180_000;
    this.httpTimeoutMs = options.httpTimeoutMs ?? 20_000;
  }

  get configFilePath(): string {
    return this.store.filePath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const loaded = await this.store.load();
        this.config = loaded.config;
        this.googleTokens = loaded.googleTokens;
        this.tombstones = loaded.tombstones;
        if (
          this.config.provider === 'googleDrive' &&
          this.config.googleAccountEmail.trim().length > 0 &&
          this.googleTokens !== null &&
          hasValidEncryptionKey(this.config) &&
          !this.config.isBound
        ) {
          this.config = { ...this.config, isBound: true };
          await this.persistNow();
        }
        this.initialized = true;
      })();
    }
    await this.initPromise;
  }

  private async persistNow(): Promise<void> {
    await this.store.save({
      config: this.config,
      googleTokens: this.googleTokens,
      tombstones: this.tombstones,
    });
  }

  async getState(): Promise<CloudSyncStateView> {
    await this.init();
    const sftpPresets = this.vaultBridge.listSftpPresets ? await this.vaultBridge.listSftpPresets() : [];
    return {
      config: { ...this.config },
      accountSummary: getVaultSyncAccountSummary(this.config),
      relativeLastSync: formatSyncRelativeTime(this.config.lastSyncedAtMs),
      hasGoogleRefreshToken: Boolean(this.googleTokens?.refreshToken),
      sftpPresets,
    };
  }

  async recordTombstone(tombstoneKey: string, deletedAtMs = Date.now()): Promise<void> {
    await this.init();
    const clean = tombstoneKey.trim();
    if (!clean) return;
    this.tombstones[clean] = Math.max(deletedAtMs, this.tombstones[clean] ?? 0);
    this.tombstones = VaultSyncPayloadMerger.capTombstones(this.tombstones);
    await this.persistNow();
  }

  getTombstones(): Record<string, number> {
    return { ...this.tombstones };
  }

  /**
   * Saves draft edits from UI while strictly enforcing monotonic bound protection:
   * closing the Cloud Sync studio never downgrades `isBound: true` to `false`.
   */
  async saveDraft(draft: Partial<VaultSyncConfig>): Promise<CloudSyncStateView> {
    await this.init();
    this.config = protectBoundCloudSyncDraft(this.config, draft);
    await this.persistNow();
    return this.getState();
  }

  /**
   * 1-Tap Google OAuth 2.0 PKCE Loopback Sign-In:
   * 1. Opens browser to Google authorization URL & captures code on `127.0.0.1:<ephemeral_port>/oauth2callback`.
   * 2. Exchanges code for tokens + fetches user email/name.
   * 3. IMMEDIATELY sets `isBound = true` and persists encrypted state to disk BEFORE running initial `smartMerge`.
   * 4. Runs initial `smartMerge`; if Drive API returns HTTP 403 (disabled) or network error, keeps `isBound = true`
   *    and `googleAccountEmail` intact and stores actionable `lastSyncError`.
   */
  async signInGoogle(
    draftPatch?: Partial<VaultSyncConfig>,
    options?: { runInitialSync?: boolean; signal?: AbortSignal },
  ): Promise<GoogleSignInFlowResult> {
    await this.init();
    if (draftPatch) {
      this.config = protectBoundCloudSyncDraft(this.config, draftPatch);
    }

    const resolvedOAuth = resolveGoogleDesktopOAuthCredentials(
      this.config.googleClientId,
      this.config.googleClientSecret,
    );
    const oauthResult = await runGoogleDesktopLoopbackOAuth({
      clientId: resolvedOAuth.clientId,
      clientSecret: resolvedOAuth.clientSecret,
      authEndpoint: this.config.googleAuthEndpoint,
      tokenEndpoint: this.config.googleTokenEndpoint,
      userInfoEndpoint: this.config.googleUserInfoEndpoint,
      openExternal: this.openExternal,
      authTimeoutMs: this.oauthTimeoutMs,
      httpTimeoutMs: this.httpTimeoutMs,
      signal: options?.signal,
    });

    const previousRefresh = this.googleTokens?.refreshToken ?? '';
    this.googleTokens = {
      ...oauthResult.tokens,
      refreshToken: oauthResult.tokens.refreshToken || previousRefresh,
    };

    const shouldDisableEmptyCustomPass =
      this.config.useCustomPassphrase && this.config.syncPassphrase.trim().length < 4;

    // STEP 1 (CRITICAL): Immediately bind and persist to disk BEFORE attempting Drive sync!
    this.config = {
      ...this.config,
      provider: 'googleDrive',
      isBound: true,
      googleAccountEmail: oauthResult.account.email,
      googleDisplayName: oauthResult.account.displayName,
      useCustomPassphrase: shouldDisableEmptyCustomPass ? false : this.config.useCustomPassphrase,
      lastSyncError: '',
    };
    await this.persistNow();

    if (options?.runInitialSync === false) {
      return {
        account: oauthResult.account,
        updatedConfig: { ...this.config },
        syncSummary: null,
        initialSyncError: null,
      };
    }

    try {
      const summary = await this.executeSync(this.config, 'smartMerge');
      return {
        account: oauthResult.account,
        updatedConfig: { ...this.config },
        syncSummary: summary,
        initialSyncError: null,
      };
    } catch (err) {
      const friendly = err instanceof Error ? err.message : String(err);
      // NEVER revert isBound or clear googleAccountEmail on initial sync error
      this.config = {
        ...this.config,
        isBound: true,
        googleAccountEmail: oauthResult.account.email,
        googleDisplayName: oauthResult.account.displayName,
        lastSyncError: friendly,
      };
      await this.persistNow();
      return {
        account: oauthResult.account,
        updatedConfig: { ...this.config },
        syncSummary: null,
        initialSyncError: friendly,
      };
    }
  }

  async signOutUnbind(): Promise<CloudSyncStateView> {
    await this.init();
    const preservedClientId = this.config.googleClientId;
    const preservedClientSecret = this.config.googleClientSecret;
    const preservedApiBase = this.config.googleApiBaseUrl;
    const preservedAuthUrl = this.config.googleAuthEndpoint;
    const preservedTokenUrl = this.config.googleTokenEndpoint;
    const preservedUserInfoUrl = this.config.googleUserInfoEndpoint;

    this.googleTokens = null;
    this.config = {
      ...createDefaultVaultSyncConfig(),
      googleClientId: preservedClientId,
      googleClientSecret: preservedClientSecret,
      googleApiBaseUrl: preservedApiBase,
      googleAuthEndpoint: preservedAuthUrl,
      googleTokenEndpoint: preservedTokenUrl,
      googleUserInfoEndpoint: preservedUserInfoUrl,
    };
    await this.persistNow();
    return this.getState();
  }

  private createGoogleTokenProvider(activeConfig: VaultSyncConfig): GoogleAccessTokenProvider {
    return {
      getAccessToken: async ({ forceRefresh = false } = {}): Promise<string> => {
        if (!this.googleTokens) {
          throw new VaultCloudSyncError(
            'Google account is not signed in. Click "Sign in with Google" first.',
            'google-not-signed-in',
          );
        }
        const expiringSoon =
          this.googleTokens.expiresAtMs > 0 && Date.now() + 60_000 >= this.googleTokens.expiresAtMs;
        if (!forceRefresh && !expiringSoon && this.googleTokens.accessToken.trim().length > 0) {
          return this.googleTokens.accessToken;
        }
        if (!this.googleTokens.refreshToken) {
          if (!forceRefresh && this.googleTokens.accessToken.trim().length > 0) {
            return this.googleTokens.accessToken;
          }
          throw new VaultCloudSyncError(
            'Google session expired. Click "Sign in with Google" to reconnect.',
            'google-token-expired',
          );
        }
        const resolvedOAuth = resolveGoogleDesktopOAuthCredentials(
          activeConfig.googleClientId,
          activeConfig.googleClientSecret,
        );
        const refreshed = await refreshGoogleOAuthAccessToken({
          clientId: resolvedOAuth.clientId,
          clientSecret: resolvedOAuth.clientSecret,
          refreshToken: this.googleTokens.refreshToken,
          tokenEndpoint: activeConfig.googleTokenEndpoint,
          timeoutMs: this.httpTimeoutMs,
        });
        this.googleTokens = refreshed;
        await this.persistNow();
        return refreshed.accessToken;
      },
    };
  }

  private buildTransport(
    cfg: VaultSyncConfig,
    onGistIdResolved: (id: string) => void,
  ): VaultCloudSyncTransport {
    switch (cfg.provider) {
      case 'googleDrive':
        return new GoogleDriveAppDataSyncTransport({
          authProvider: this.createGoogleTokenProvider(cfg),
          apiBaseUrl: cfg.googleApiBaseUrl,
          timeoutMs: this.httpTimeoutMs,
        });
      case 'sftp':
        return new SftpVaultSyncTransport({
          host: cfg.sftpHost,
          port: cfg.sftpPort,
          username: cfg.sftpUsername,
          password: cfg.sftpPassword,
          privateKeyPem: cfg.sftpPrivateKeyPem,
          jumpHost: cfg.sftpJumpHost,
          remotePath: cfg.sftpRemotePath,
          executor: this.sftpExecutor,
        });
      case 'webdav':
        return new WebDavVaultSyncTransport({
          fileUrl: cfg.webdavUrl,
          username: cfg.webdavUsername,
          password: cfg.webdavPassword,
          timeoutMs: this.httpTimeoutMs,
        });
      case 'githubGist':
        return new GitHubGistVaultSyncTransport({
          token: cfg.githubToken,
          gistId: cfg.githubGistId,
          apiBaseUrl: cfg.githubApiBaseUrl,
          onGistIdResolved,
          timeoutMs: this.httpTimeoutMs,
        });
    }
  }

  async executeSync(
    draftInput?: Partial<VaultSyncConfig>,
    rawMode: VaultSyncOperationMode = 'smartMerge',
  ): Promise<VaultSyncRunSummary> {
    await this.init();
    const mode = normalizeOperationMode(rawMode);
    const draft = draftInput ? protectBoundCloudSyncDraft(this.config, draftInput) : { ...this.config };

    if (!hasValidEncryptionKey(draft)) {
      const msg =
        draft.provider === 'googleDrive' && !draft.useCustomPassphrase
          ? 'Sign in with Google first to bind your encrypted vault.'
          : 'Sync Passphrase must be at least 4 characters.';
      throw new VaultCloudSyncError(msg, 'missing-encryption-key');
    }

    let resolvedGistId = draft.githubGistId;
    const passphrase = effectiveEncryptionPassphrase(draft);

    try {
      const transport = this.buildTransport(draft, (id) => {
        resolvedGistId = id;
      });

      const localRaw = await this.vaultBridge.exportLocalPayload({ ...this.tombstones });
      let resultingPayload: VaultSyncPayload;

      if (mode === 'pushForce') {
        resultingPayload = VaultSyncPayloadMerger.normalizePayload(localRaw);
        const sealed = await VaultCloudSyncCrypto.sealAsync({
          payload: resultingPayload as unknown as Record<string, unknown>,
          passphrase,
        });
        await transport.uploadEnvelope(sealed);
      } else if (mode === 'pullOnly') {
        const remoteRaw = await transport.downloadEnvelope();
        if (!remoteRaw || remoteRaw.trim().length === 0) {
          throw new VaultCloudSyncError(
            `No encrypted vault found on ${providerLabel(draft.provider)} yet.`,
            'remote-vault-empty',
          );
        }
        const opened = await VaultCloudSyncCrypto.openAsync({
          rawEnvelopeJson: remoteRaw,
          passphrase,
        });
        resultingPayload = VaultSyncPayloadMerger.normalizePayload(opened);
        this.tombstones = { ...resultingPayload.tombstones };
        await this.vaultBridge.applySyncedPayload(resultingPayload);
      } else {
        const remoteRaw = await transport.downloadEnvelope();
        if (remoteRaw && remoteRaw.trim().length > 0) {
          const remotePayload = await VaultCloudSyncCrypto.openAsync({
            rawEnvelopeJson: remoteRaw,
            passphrase,
          });
          resultingPayload = VaultSyncPayloadMerger.merge(localRaw, remotePayload);
        } else {
          resultingPayload = VaultSyncPayloadMerger.normalizePayload(localRaw);
        }
        const sealed = await VaultCloudSyncCrypto.sealAsync({
          payload: resultingPayload as unknown as Record<string, unknown>,
          passphrase,
        });
        await transport.uploadEnvelope(sealed);
        this.tombstones = { ...resultingPayload.tombstones };
        await this.vaultBridge.applySyncedPayload(resultingPayload);
      }

      const nowMs = Date.now();
      this.config = {
        ...draft,
        isBound: true,
        lastSyncedAtMs: nowMs,
        lastSyncError: '',
        githubGistId: resolvedGistId,
      };
      await this.persistNow();

      const gatewayCount = resultingPayload.hosts.filter((h) => h.isJumpHost === true).length;
      const connectionCount = Math.max(0, resultingPayload.hosts.length - gatewayCount);
      const credentialCount = resultingPayload.credentials.length;
      const totpCount = resultingPayload.totp.length;
      const message =
        gatewayCount > 0
          ? `Synced ${connectionCount} connection${connectionCount === 1 ? '' : 's'} & ${gatewayCount} gateway${gatewayCount === 1 ? '' : 's'}`
          : `Synced ${resultingPayload.hosts.length} connection${resultingPayload.hosts.length === 1 ? '' : 's'}`;

      return {
        updatedConfig: { ...this.config },
        message,
        connectionCount,
        gatewayCount,
        credentialCount,
        totpCount,
        mode,
      };
    } catch (err) {
      const cleanError = err instanceof Error ? err.message : String(err);
      const shouldRetainBound =
        draft.isBound ||
        this.config.isBound ||
        (draft.provider === 'googleDrive' && draft.googleAccountEmail.trim().length > 0);

      if (shouldRetainBound) {
        this.config = {
          ...draft,
          isBound: true,
          lastSyncError: cleanError,
          githubGistId: resolvedGistId,
          googleAccountEmail:
            draft.googleAccountEmail.trim() || this.config.googleAccountEmail,
          googleDisplayName:
            draft.googleDisplayName.trim() || this.config.googleDisplayName,
        };
        await this.persistNow();
      }
      throw err instanceof VaultCloudSyncError ? err : new VaultCloudSyncError(cleanError);
    }
  }

  async exportJvault(passphrase: string): Promise<string> {
    await this.init();
    const localRaw = await this.vaultBridge.exportLocalPayload({ ...this.tombstones });
    return exportEncryptedJvault(localRaw, passphrase);
  }

  async importJvault(
    rawEnvelopeJson: string,
    passphrase: string,
    mode: 'merge' | 'replace' = 'merge',
  ): Promise<{
    payload: VaultSyncPayload;
    hostCount: number;
    credentialCount: number;
    totpCount: number;
  }> {
    await this.init();
    const imported = await importEncryptedJvault(rawEnvelopeJson, passphrase);
    let finalPayload: VaultSyncPayload;
    if (mode === 'replace') {
      finalPayload = imported;
    } else {
      const localRaw = await this.vaultBridge.exportLocalPayload({ ...this.tombstones });
      finalPayload = VaultSyncPayloadMerger.merge(localRaw, imported as unknown as Record<string, unknown>);
    }
    this.tombstones = { ...finalPayload.tombstones };
    await this.vaultBridge.applySyncedPayload(finalPayload);
    await this.persistNow();
    return {
      payload: finalPayload,
      hostCount: finalPayload.hosts.length,
      credentialCount: finalPayload.credentials.length,
      totpCount: finalPayload.totp.length,
    };
  }
}
