import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { realFs, type StoreFs } from '../documents/store.js';

export interface TotpConfig { secretBase32: string; algorithm: 'sha1' | 'sha256' | 'sha512'; digits: 6 | 8; period: number }
export type MfaConfig = { mode: 'none' } | { mode: 'prompt'; field: 'username' | 'password'; pattern: 'ValueMfaCode' | 'MfaCodeValue' } | { mode: 'generate'; field: 'username' | 'password'; pattern: 'ValueMfaCode' | 'MfaCodeValue'; totp: TotpConfig };
export interface MfaIdentity { username: string; domain: string; password?: string }

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';
export type TotpAlgorithmInput = TotpAlgorithm | 'sha1' | 'sha256' | 'sha512' | 'SHA-1' | 'SHA-256' | 'SHA-512';
export type TotpDigits = 6 | 8;
export type TotpPeriod = 30 | 60;

export interface ParsedOtpAuthUri {
  issuer: string;
  accountName: string;
  label: string;
  secretBase32: string;
  algorithm: TotpAlgorithm;
  digits: TotpDigits;
  period: TotpPeriod;
}

export interface BuildOtpAuthUriInput {
  issuer?: string;
  accountName: string;
  secretBase32: string;
  algorithm?: TotpAlgorithmInput;
  digits?: TotpDigits;
  period?: TotpPeriod;
}

export interface TotpTimingInfo {
  period: number;
  elapsedMs: number;
  remainingMs: number;
  remainingSeconds: number;
  progressRatio: number;
  elapsedRatio: number;
  counter: bigint;
}

export interface DesktopTotpVaultItem {
  id: string;
  issuer: string;
  accountName: string;
  secretBase32: string;
  algorithm: TotpAlgorithm;
  digits: TotpDigits;
  period: TotpPeriod;
  updatedAtMs: number;
}

export interface DesktopTotpLiveItem extends DesktopTotpVaultItem {
  code: string;
  formattedCode: string;
  remainingSeconds: number;
  remainingMs: number;
  progressRatio: number;
  elapsedRatio: number;
}

export interface DesktopTotpUpsertInput {
  id?: string;
  issuer?: string;
  accountName: string;
  secretBase32: string;
  algorithm?: TotpAlgorithmInput;
  digits?: TotpDigits;
  period?: TotpPeriod;
  updatedAtMs?: number;
}

/**
 * Interoperable Cloud Sync `totp` record matching JalaDesk Mobile (`TotpEntryItem`)
 * while preserving all Desktop fields.
 */
export interface CloudSyncTotpItem {
  id: string;
  label: string;
  accountName: string;
  issuer: string;
  secretBase32: string;
  algorithm: TotpAlgorithm;
  digits: TotpDigits;
  period: TotpPeriod;
  periodSeconds: TotpPeriod;
  updatedAtMs: number;
}

export interface DesktopTotpVaultStoreOptions {
  fs?: StoreFs;
  now?: () => number;
  vaultFileName?: string;
  keyFileName?: string;
  masterKey?: Uint8Array;
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const invalid = () => new Error('Configuration TOTP tidak valid');
const VAULT_SCHEMA = 'jaladesk-desktop-totp-vault-v1';
const VAULT_AAD = Buffer.from(VAULT_SCHEMA, 'utf8');
const MAX_TOMBSTONES = 500;

function mapNodeAlgorithm(algorithm: unknown): 'sha1' | 'sha256' | 'sha512' | undefined {
  switch (algorithm) {
    case 'sha1':
    case 'SHA1':
      return 'sha1';
    case 'sha256':
    case 'SHA256':
      return 'sha256';
    case 'sha512':
    case 'SHA512':
      return 'sha512';
    default:
      return undefined;
  }
}

export function parseTotpAlgorithm(raw: unknown): TotpAlgorithm {
  if (typeof raw !== 'string') throw new Error('Invalid TOTP algorithm');
  const normalized = raw.trim().toUpperCase().replace(/-/g, '');
  if (normalized === 'SHA1') return 'SHA1';
  if (normalized === 'SHA256') return 'SHA256';
  if (normalized === 'SHA512') return 'SHA512';
  throw new Error('Unsupported TOTP algorithm');
}

export function normalizeTotpAlgorithm(raw: unknown, fallback: TotpAlgorithm = 'SHA1'): TotpAlgorithm {
  try {
    return parseTotpAlgorithm(raw);
  } catch {
    return fallback;
  }
}

export function toLowerTotpAlgorithm(algorithm: TotpAlgorithmInput): 'sha1' | 'sha256' | 'sha512' {
  const upper = parseTotpAlgorithm(algorithm);
  return upper.toLowerCase() as 'sha1' | 'sha256' | 'sha512';
}

export function decodeBase32(value: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Z2-7]+={0,6}$/.test(value) || value.length > 208) throw invalid();
  const unpadded = value.replace(/=+$/, ''); const remainder = unpadded.length % 8;
  const padding: Record<number, number> = { 0: 0, 2: 6, 4: 4, 5: 3, 7: 1 };
  if (padding[remainder] === undefined || (value.includes('=') && value.length - unpadded.length !== padding[remainder])) throw invalid();
  const bytes: number[] = []; let bits = 0; let buffer = 0;
  for (const char of unpadded) {
    buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); buffer &= (1 << bits) - 1; }
  }
  if (buffer !== 0 || !bytes.length || bytes.length > 128) throw invalid();
  return Buffer.from(bytes);
}

/**
 * Normalizes user-entered or `otpauth://` Base32 secrets (strips spaces, hyphens, and `=` padding,
 * uppercases, and validates RFC 4648 alphabet) matching JalaDesk Mobile v1.16.
 */
export function normalizeTotpSecretBase32(raw: string): string {
  if (typeof raw !== 'string') throw new Error('Invalid TOTP Base32 secret');
  const compact = raw.trim().replace(/[\s-]+/g, '').toUpperCase();
  if (!compact || !/^[A-Z2-7]+=*$/.test(compact)) {
    throw new Error('Invalid TOTP Base32 secret');
  }
  const unpadded = compact.replace(/=+$/, '');
  if (unpadded.length < 2 || unpadded.length > 256) {
    throw new Error('Invalid TOTP Base32 secret');
  }
  return unpadded;
}

/**
 * Decodes normalized Base32 secret bytes (including unpadded secrets emitted by Google/GitHub/Okta/AWS).
 */
export function decodeTotpSecretBase32(raw: string): Buffer {
  const cleaned = normalizeTotpSecretBase32(raw);
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of cleaned) {
    const val = alphabet.indexOf(char);
    if (val < 0) throw new Error('Invalid TOTP Base32 secret');
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
      buffer &= (1 << bitsLeft) - 1;
    }
  }
  if (bytes.length === 0 || bytes.length > 160) {
    throw new Error('Invalid TOTP Base32 secret');
  }
  return Buffer.from(bytes);
}

function hmacOtpFromKey(
  key: Buffer,
  nodeAlgorithm: 'sha1' | 'sha256' | 'sha512',
  digits: TotpDigits,
  period: number,
  unixSeconds: number,
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / period)));
  try {
    const digest = createHmac(nodeAlgorithm, key).update(counter).digest();
    try {
      const offset = digest[digest.length - 1]! & 15;
      const binary = digest.readUInt32BE(offset) & 0x7fffffff;
      return String(binary % (10 ** digits)).padStart(digits, '0');
    } finally {
      digest.fill(0);
    }
  } finally {
    counter.fill(0);
  }
}

/** RFC6238/RFC4226. The caller passes the current time immediately before using the credential. */
export function totp(
  config: TotpConfig | { secretBase32: string; algorithm: 'sha1' | 'sha256' | 'sha512' | TotpAlgorithm; digits: 6 | 8; period: number },
  unixSeconds: number,
): string {
  const nodeAlgo = config ? mapNodeAlgorithm(config.algorithm) : undefined;
  if (
    !config ||
    !nodeAlgo ||
    ![6, 8].includes(config.digits) ||
    !Number.isInteger(config.period) ||
    config.period < 15 ||
    config.period > 120 ||
    !Number.isFinite(unixSeconds) ||
    unixSeconds < 0 ||
    unixSeconds > Number.MAX_SAFE_INTEGER
  ) {
    throw invalid();
  }
  const key = decodeBase32(config.secretBase32);
  try {
    return hmacOtpFromKey(key, nodeAlgo, config.digits, config.period, unixSeconds);
  } finally {
    key.fill(0);
  }
}

/**
 * Generates an RFC 6238 TOTP code with full JalaDesk Mobile v1.16 parity (`SHA1 | SHA256 | SHA512`, `6 | 8` digits, `30 | 60`s period).
 */
export function generateTotpCode(
  params: {
    secretBase32: string;
    algorithm?: TotpAlgorithmInput;
    digits?: TotpDigits;
    period?: number;
  },
  time?: number | { unixSeconds?: number; nowMs?: number },
): string {
  if (!params || typeof params.secretBase32 !== 'string') throw invalid();
  const algorithm = params.algorithm !== undefined ? parseTotpAlgorithm(params.algorithm) : 'SHA1';
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;
  if (![6, 8].includes(digits) || !Number.isInteger(period) || period < 10 || period > 120) {
    throw invalid();
  }
  let unixSeconds: number;
  if (typeof time === 'number') {
    unixSeconds = time;
  } else if (time && typeof time.unixSeconds === 'number') {
    unixSeconds = time.unixSeconds;
  } else if (time && typeof time.nowMs === 'number') {
    unixSeconds = Math.floor(time.nowMs / 1000);
  } else {
    unixSeconds = Math.floor(Date.now() / 1000);
  }
  if (!Number.isFinite(unixSeconds) || unixSeconds < 0 || unixSeconds > Number.MAX_SAFE_INTEGER) {
    throw invalid();
  }
  const key = decodeTotpSecretBase32(params.secretBase32);
  try {
    return hmacOtpFromKey(key, toLowerTotpAlgorithm(algorithm), digits, period, unixSeconds);
  } finally {
    key.fill(0);
  }
}

export function formatTotpCode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 6) return `${trimmed.slice(0, 3)} ${trimmed.slice(3)}`;
  if (trimmed.length === 8) return `${trimmed.slice(0, 4)} ${trimmed.slice(4)}`;
  return trimmed;
}

/**
 * Computes remaining seconds and countdown progress ratio (`1.0` -> `0.0`) for a TOTP period window.
 */
export function calculateTotpTiming(period: number = 30, nowMs: number = Date.now()): TotpTimingInfo {
  if (!Number.isInteger(period) || period < 10 || period > 120 || !Number.isFinite(nowMs) || nowMs < 0) {
    throw invalid();
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

export function evaluateTotpToken(
  item: {
    secretBase32: string;
    algorithm?: TotpAlgorithmInput;
    digits?: TotpDigits;
    period?: number;
  },
  nowMs: number = Date.now(),
): {
  code: string;
  formattedCode: string;
  algorithm: TotpAlgorithm;
  digits: TotpDigits;
  period: number;
  remainingSeconds: number;
  remainingMs: number;
  progressRatio: number;
  elapsedRatio: number;
} {
  const algorithm = item.algorithm !== undefined ? parseTotpAlgorithm(item.algorithm) : 'SHA1';
  const digits: TotpDigits = item.digits ?? 6;
  const period = item.period ?? 30;
  const timing = calculateTotpTiming(period, nowMs);
  const code = generateTotpCode(
    { secretBase32: item.secretBase32, algorithm, digits, period },
    { nowMs },
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
  };
}

/**
 * Parses `otpauth://totp/Issuer:Account?secret=...&issuer=...&algorithm=SHA256&digits=8&period=30`.
 */
export function parseOtpAuthUri(uri: string): ParsedOtpAuthUri {
  if (typeof uri !== 'string') throw new Error('Invalid otpauth URI');
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith('otpauth://')) {
    throw new Error('URI must start with otpauth://');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Malformed otpauth URI');
  }
  if (parsed.protocol.toLowerCase() !== 'otpauth:' || parsed.hostname.toLowerCase() !== 'totp') {
    throw new Error('Only otpauth://totp/ URIs are supported');
  }

  const rawSecret = parsed.searchParams.get('secret') ?? '';
  const decodedBytes = decodeTotpSecretBase32(rawSecret);
  decodedBytes.fill(0);
  const secretBase32 = normalizeTotpSecretBase32(rawSecret);

  const rawPath = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath).trim();
  } catch {
    throw new Error('Malformed otpauth label encoding');
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
  const algorithm: TotpAlgorithm = rawAlgo !== null && rawAlgo.trim() !== ''
    ? parseTotpAlgorithm(rawAlgo)
    : 'SHA1';

  const rawDigits = parsed.searchParams.get('digits');
  let digits: TotpDigits = 6;
  if (rawDigits !== null && rawDigits.trim() !== '') {
    const numDigits = Number(rawDigits.trim());
    if (numDigits !== 6 && numDigits !== 8) {
      throw new Error('TOTP digits must be 6 or 8');
    }
    digits = numDigits;
  }

  const rawPeriod = parsed.searchParams.get('period');
  let period: TotpPeriod = 30;
  if (rawPeriod !== null && rawPeriod.trim() !== '') {
    const numPeriod = Number(rawPeriod.trim());
    if (numPeriod !== 30 && numPeriod !== 60) {
      throw new Error('TOTP period must be 30 or 60 seconds');
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

/**
 * Builds a standard KeyUriFormat `otpauth://totp/...` URI compatible with Mobile & major authenticators.
 */
export function buildOtpAuthUri(input: BuildOtpAuthUriInput): string {
  if (!input || typeof input.accountName !== 'string') {
    throw new Error('Account name is required to build otpauth URI');
  }
  const issuer = (input.issuer ?? '').trim();
  const accountName = input.accountName.trim() || issuer || 'Authenticator Key';
  const decoded = decodeTotpSecretBase32(input.secretBase32);
  decoded.fill(0);
  const secretBase32 = normalizeTotpSecretBase32(input.secretBase32);
  const algorithm: TotpAlgorithm = input.algorithm !== undefined ? parseTotpAlgorithm(input.algorithm) : 'SHA1';
  const digits: TotpDigits = input.digits ?? 6;
  const period: TotpPeriod = input.period ?? 30;
  if (digits !== 6 && digits !== 8) throw new Error('TOTP digits must be 6 or 8');
  if (period !== 30 && period !== 60) throw new Error('TOTP period must be 30 or 60 seconds');

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

export function composeMfa(identity: MfaIdentity, config: MfaConfig, context: { unixSeconds: number; promptCode?: { value: string; expiresAt: number } }): MfaIdentity {
  const denied = () => new Error('Konfigurasi atau konfirmasi MFA tidak valid');
  if (!identity || typeof identity.username !== 'string' || typeof identity.domain !== 'string' || (identity.password !== undefined && typeof identity.password !== 'string') || !config) throw denied();
  if (config.mode === 'none') return { ...identity };
  if (!['prompt', 'generate'].includes(config.mode) || !['username', 'password'].includes(config.field) || !['ValueMfaCode', 'MfaCodeValue'].includes(config.pattern) || !Number.isFinite(context.unixSeconds) || context.unixSeconds < 0) throw denied();
  let code: string;
  if (config.mode === 'generate') code = totp(config.totp, context.unixSeconds);
  else {
    const prompt = context.promptCode;
    if (!prompt || !/^(?:[0-9]{6}|[0-9]{8})$/.test(prompt.value) || !Number.isFinite(prompt.expiresAt) || prompt.expiresAt <= context.unixSeconds || prompt.expiresAt > context.unixSeconds + 120) throw denied();
    code = prompt.value;
  }
  const value = identity[config.field] ?? '';
  return { ...identity, [config.field]: config.pattern === 'ValueMfaCode' ? value + code : code + value };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePeriod(raw: unknown, fallback: TotpPeriod = 30): TotpPeriod {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (n === 60) return 60;
  if (n === 30) return 30;
  return fallback;
}

function normalizeDigits(raw: unknown, fallback: TotpDigits = 6): TotpDigits {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (n === 8) return 8;
  if (n === 6) return 6;
  return fallback;
}

export function toCloudSyncTotpItem(item: DesktopTotpVaultItem): CloudSyncTotpItem {
  return {
    id: item.id,
    label: item.accountName,
    accountName: item.accountName,
    issuer: item.issuer,
    secretBase32: item.secretBase32,
    algorithm: item.algorithm,
    digits: item.digits,
    period: item.period,
    periodSeconds: item.period,
    updatedAtMs: item.updatedAtMs,
  };
}

export function fromCloudSyncTotpItem(raw: unknown, nowMs: number = Date.now()): DesktopTotpVaultItem | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const rawSecret = typeof raw.secretBase32 === 'string' ? raw.secretBase32 : '';
  let secretBase32: string;
  try {
    const key = decodeTotpSecretBase32(rawSecret);
    key.fill(0);
    secretBase32 = normalizeTotpSecretBase32(rawSecret);
  } catch {
    return undefined;
  }
  const id = typeof raw.id === 'string' && raw.id.trim().length > 0
    ? raw.id.trim()
    : `totp-${randomUUID()}`;
  const issuer = typeof raw.issuer === 'string' ? raw.issuer.trim() : '';
  const rawAccount = typeof raw.accountName === 'string' && raw.accountName.trim().length > 0
    ? raw.accountName.trim()
    : typeof raw.label === 'string' && raw.label.trim().length > 0
      ? raw.label.trim()
      : issuer || 'Authenticator Key';
  const algorithm = normalizeTotpAlgorithm(raw.algorithm, 'SHA1');
  const digits = normalizeDigits(raw.digits, 6);
  const period = normalizePeriod(raw.period ?? raw.periodSeconds, 30);
  const updatedAtMs = typeof raw.updatedAtMs === 'number' && Number.isFinite(raw.updatedAtMs) && raw.updatedAtMs >= 0
    ? Math.floor(raw.updatedAtMs)
    : nowMs;

  return {
    id,
    issuer,
    accountName: rawAccount,
    secretBase32,
    algorithm,
    digits,
    period,
    updatedAtMs,
  };
}

function capTombstones(tombstones: Record<string, number>): Record<string, number> {
  const entries = Object.entries(tombstones).filter(([k, ts]) => k.length > 0 && Number.isFinite(ts) && ts > 0);
  if (entries.length <= MAX_TOMBSTONES) {
    return Object.fromEntries(entries);
  }
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_TOMBSTONES));
}

async function atomicWriteBytes(fs: StoreFs, targetPath: string, content: Buffer): Promise<void> {
  const tmpPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.mkdir(dirname(targetPath));
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmpPath, targetPath);
        break;
      } catch (error) {
        if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as { code?: string }).code ?? '')) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * (3 ** attempt)));
      }
    }
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
  await fs.syncDir(dirname(targetPath)).catch(() => undefined);
}

function sealTotpVaultPayload(plaintextJson: string, key32: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key32, iv);
  cipher.setAAD(VAULT_AAD);
  const encrypted = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${JSON.stringify({
    schema: VAULT_SCHEMA,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  })}\n`;
}

function openTotpVaultPayload(rawEnvelope: string, key32: Uint8Array): { items: DesktopTotpVaultItem[]; tombstones: Record<string, number> } {
  const parsed: unknown = JSON.parse(rawEnvelope.replace(/^\uFEFF/, ''));
  if (
    !isPlainRecord(parsed) ||
    parsed.schema !== VAULT_SCHEMA ||
    parsed.cipher !== 'aes-256-gcm' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.tag !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new Error('Invalid encrypted TOTP vault envelope');
  }
  const iv = Buffer.from(parsed.iv, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  const ciphertext = Buffer.from(parsed.ciphertext, 'base64');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('Malformed encrypted TOTP vault parameters');
  }
  const decipher = createDecipheriv('aes-256-gcm', key32, iv);
  decipher.setAAD(VAULT_AAD);
  decipher.setAuthTag(tag);
  const clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const body: unknown = JSON.parse(clear);
  if (!isPlainRecord(body)) {
    return { items: [], tombstones: {} };
  }
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items: DesktopTotpVaultItem[] = [];
  const seen = new Set<string>();
  for (const entry of rawItems) {
    const normalized = fromCloudSyncTotpItem(entry, 0);
    if (normalized && !seen.has(normalized.id)) {
      seen.add(normalized.id);
      items.push(normalized);
    }
  }
  const tombstones: Record<string, number> = {};
  if (isPlainRecord(body.tombstones)) {
    for (const [k, v] of Object.entries(body.tombstones)) {
      const ts = typeof v === 'number' ? Math.floor(v) : Number(v);
      if (k && Number.isFinite(ts) && ts > 0) tombstones[k] = ts;
    }
  }
  return { items, tombstones: capTombstones(tombstones) };
}

/**
 * Standalone AES-256-GCM Encrypted-At-Rest Desktop 2FA Authenticator Vault Store
 * with Tombstone-Aware Cloud Sync (`totpItems`) interoperability.
 */
export class DesktopTotpVaultStore {
  readonly #fs: StoreFs;
  readonly #now: () => number;
  readonly #vaultPath: string;
  readonly #key32: Buffer;
  #items: DesktopTotpVaultItem[];
  #tombstones: Record<string, number>;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    fs: StoreFs,
    now: () => number,
    vaultPath: string,
    key32: Buffer,
    items: DesktopTotpVaultItem[],
    tombstones: Record<string, number>,
  ) {
    this.#fs = fs;
    this.#now = now;
    this.#vaultPath = vaultPath;
    this.#key32 = Buffer.from(key32);
    this.#items = items;
    this.#tombstones = tombstones;
  }

  static async open(userDataDir: string, options: DesktopTotpVaultStoreOptions = {}): Promise<DesktopTotpVaultStore> {
    const fs = options.fs ?? realFs;
    const now = options.now ?? Date.now;
    const vaultPath = join(userDataDir, options.vaultFileName ?? 'jaladesk-totp-vault.v1.json');
    const keyPath = join(userDataDir, options.keyFileName ?? 'jaladesk-totp-vault.dek');

    let key32: Buffer;
    if (options.masterKey) {
      if (options.masterKey.byteLength !== 32) {
        throw new Error('DesktopTotpVaultStore masterKey must be exactly 32 bytes');
      }
      key32 = Buffer.from(options.masterKey);
    } else {
      key32 = await DesktopTotpVaultStore.#loadOrCreateDek(fs, keyPath);
    }

    let items: DesktopTotpVaultItem[] = [];
    let tombstones: Record<string, number> = {};
    try {
      const raw = await fs.readFile(vaultPath);
      const opened = openTotpVaultPayload(raw.toString('utf8'), key32);
      items = opened.items;
      tombstones = opened.tombstones;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw error;
      }
    }

    return new DesktopTotpVaultStore(fs, now, vaultPath, key32, items, tombstones);
  }

  static async #loadOrCreateDek(fs: StoreFs, keyPath: string): Promise<Buffer> {
    try {
      const raw = await fs.readFile(keyPath);
      const trimmed = raw.toString('utf8').trim();
      const decoded = Buffer.from(trimmed, 'base64');
      if (decoded.length === 32) return decoded;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw error;
      }
    }
    const fresh = randomBytes(32);
    await atomicWriteBytes(fs, keyPath, Buffer.from(`${fresh.toString('base64')}\n`, 'utf8'));
    return fresh;
  }

  list(): DesktopTotpVaultItem[] {
    return this.#items.map((item) => ({ ...item }));
  }

  listWithCodes(nowMs: number = this.#now()): DesktopTotpLiveItem[] {
    return this.#items.map((item) => {
      const live = evaluateTotpToken(item, nowMs);
      return {
        ...item,
        code: live.code,
        formattedCode: live.formattedCode,
        remainingSeconds: live.remainingSeconds,
        remainingMs: live.remainingMs,
        progressRatio: live.progressRatio,
        elapsedRatio: live.elapsedRatio,
      };
    });
  }

  get(id: string): DesktopTotpVaultItem | undefined {
    const found = this.#items.find((item) => item.id === id);
    return found ? { ...found } : undefined;
  }

  getTombstones(): Record<string, number> {
    return { ...this.#tombstones };
  }

  exportCloudSyncItems(): CloudSyncTotpItem[] {
    return this.#items.map((item) => toCloudSyncTotpItem(item));
  }

  async upsert(input: DesktopTotpUpsertInput): Promise<DesktopTotpVaultItem> {
    if (!input || typeof input.accountName !== 'string') {
      throw new Error('Account name is required');
    }
    const decoded = decodeTotpSecretBase32(input.secretBase32);
    decoded.fill(0);
    const secretBase32 = normalizeTotpSecretBase32(input.secretBase32);
    const algorithm: TotpAlgorithm = input.algorithm !== undefined ? parseTotpAlgorithm(input.algorithm) : 'SHA1';
    const digits: TotpDigits = input.digits ?? 6;
    const period: TotpPeriod = input.period ?? 30;
    if (digits !== 6 && digits !== 8) throw new Error('TOTP digits must be 6 or 8');
    if (period !== 30 && period !== 60) throw new Error('TOTP period must be 30 or 60 seconds');

    const issuer = (input.issuer ?? '').trim();
    const accountName = input.accountName.trim() || issuer || 'Authenticator Key';

    return this.#queued(async () => {
      const nowMs = input.updatedAtMs !== undefined && Number.isFinite(input.updatedAtMs)
        ? Math.max(0, Math.floor(input.updatedAtMs))
        : this.#now();
      const id = input.id && input.id.trim().length > 0 ? input.id.trim() : `totp-${randomUUID()}`;
      const record: DesktopTotpVaultItem = {
        id,
        issuer,
        accountName,
        secretBase32,
        algorithm,
        digits,
        period,
        updatedAtMs: nowMs,
      };
      const existingIdx = this.#items.findIndex((item) => item.id === id);
      const nextItems = [...this.#items];
      if (existingIdx >= 0) {
        nextItems[existingIdx] = record;
      } else {
        nextItems.push(record);
      }
      const nextTombstones = { ...this.#tombstones };
      delete nextTombstones[`totp:${id}`];
      await this.#persist(nextItems, nextTombstones);
      return { ...record };
    });
  }

  async addFromOtpAuthUri(
    uri: string,
    overrides: Partial<Pick<DesktopTotpUpsertInput, 'id' | 'issuer' | 'accountName'>> = {},
  ): Promise<DesktopTotpVaultItem> {
    const parsed = parseOtpAuthUri(uri);
    return this.upsert({
      id: overrides.id,
      issuer: overrides.issuer !== undefined ? overrides.issuer : parsed.issuer,
      accountName: overrides.accountName !== undefined ? overrides.accountName : parsed.accountName,
      secretBase32: parsed.secretBase32,
      algorithm: parsed.algorithm,
      digits: parsed.digits,
      period: parsed.period,
    });
  }

  async remove(id: string): Promise<boolean> {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (!trimmed) return false;
    return this.#queued(async () => {
      const idx = this.#items.findIndex((item) => item.id === trimmed);
      if (idx < 0) return false;
      const nextItems = this.#items.filter((item) => item.id !== trimmed);
      const nextTombstones = capTombstones({
        ...this.#tombstones,
        [`totp:${trimmed}`]: this.#now(),
      });
      await this.#persist(nextItems, nextTombstones);
      return true;
    });
  }

  async clear(): Promise<void> {
    return this.#queued(async () => {
      const nowMs = this.#now();
      const nextTombstones = { ...this.#tombstones };
      for (const item of this.#items) {
        nextTombstones[`totp:${item.id}`] = nowMs;
      }
      await this.#persist([], capTombstones(nextTombstones));
    });
  }

  async replaceFromCloudSync(
    rawItems: readonly unknown[],
    tombstones?: Record<string, number>,
  ): Promise<DesktopTotpVaultItem[]> {
    return this.#queued(async () => {
      const nowMs = this.#now();
      const nextItems: DesktopTotpVaultItem[] = [];
      const seen = new Set<string>();
      for (const raw of rawItems) {
        const parsed = fromCloudSyncTotpItem(raw, nowMs);
        if (parsed && !seen.has(parsed.id)) {
          seen.add(parsed.id);
          nextItems.push(parsed);
        }
      }
      const nextTombstones = tombstones ? capTombstones({ ...tombstones }) : { ...this.#tombstones };
      await this.#persist(nextItems, nextTombstones);
      return this.list();
    });
  }

  /**
   * Tombstone-aware deterministic merge matching `VaultSyncPayloadMerger` (`totp:<id>`).
   */
  async mergeCloudSyncItems(
    remoteItems: readonly unknown[],
    remoteTombstones: Record<string, number> = {},
  ): Promise<{
    items: DesktopTotpVaultItem[];
    cloudItems: CloudSyncTotpItem[];
    tombstones: Record<string, number>;
  }> {
    return this.#queued(async () => {
      const nowMs = this.#now();
      const unionTombstones: Record<string, number> = { ...this.#tombstones };
      for (const [k, v] of Object.entries(remoteTombstones)) {
        const ts = typeof v === 'number' ? Math.floor(v) : Number(v);
        if (k && Number.isFinite(ts) && ts > (unionTombstones[k] ?? 0)) {
          unionTombstones[k] = ts;
        }
      }

      const localById = new Map<string, DesktopTotpVaultItem>();
      const orderedIds: string[] = [];
      for (const item of this.#items) {
        localById.set(item.id, item);
        orderedIds.push(item.id);
      }

      const remoteById = new Map<string, DesktopTotpVaultItem>();
      for (const raw of remoteItems) {
        const parsed = fromCloudSyncTotpItem(raw, 0);
        if (!parsed) continue;
        if (!localById.has(parsed.id) && !remoteById.has(parsed.id)) {
          orderedIds.push(parsed.id);
        }
        remoteById.set(parsed.id, parsed);
      }

      const merged: DesktopTotpVaultItem[] = [];
      for (const id of orderedIds) {
        const localItem = localById.get(id);
        const remoteItem = remoteById.get(id);
        const lTs = localItem?.updatedAtMs ?? 0;
        const rTs = remoteItem?.updatedAtMs ?? 0;
        const maxItemTs = Math.max(lTs, rTs);
        const tombKey = `totp:${id}`;
        const deletedAt = unionTombstones[tombKey] ?? 0;

        if (deletedAt > maxItemTs) {
          continue;
        }
        if (deletedAt > 0 && maxItemTs >= deletedAt) {
          delete unionTombstones[tombKey];
        }

        if (localItem && remoteItem) {
          merged.push(rTs > lTs ? { ...remoteItem } : { ...localItem });
        } else if (localItem) {
          merged.push({ ...localItem });
        } else if (remoteItem) {
          merged.push({ ...remoteItem });
        }
      }

      const cappedTombs = capTombstones(unionTombstones);
      await this.#persist(merged, cappedTombs, nowMs);
      return {
        items: this.list(),
        cloudItems: this.exportCloudSyncItems(),
        tombstones: this.getTombstones(),
      };
    });
  }

  #queued<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #persist(
    nextItems: DesktopTotpVaultItem[],
    nextTombstones: Record<string, number>,
    updatedAtMs: number = this.#now(),
  ): Promise<void> {
    const payloadJson = JSON.stringify({
      version: 1,
      updatedAtMs,
      items: nextItems.map((item) => toCloudSyncTotpItem(item)),
      tombstones: nextTombstones,
    });
    const sealed = sealTotpVaultPayload(payloadJson, this.#key32);
    await atomicWriteBytes(this.#fs, this.#vaultPath, Buffer.from(sealed, 'utf8'));
    this.#items = nextItems;
    this.#tombstones = nextTombstones;
  }
}
