import { createHmac } from 'node:crypto';

export interface TotpConfig { secretBase32: string; algorithm: 'sha1' | 'sha256' | 'sha512'; digits: 6 | 8; period: number }
export type MfaConfig = { mode: 'none' } | { mode: 'prompt'; field: 'username' | 'password'; pattern: 'ValueMfaCode' | 'MfaCodeValue' } | { mode: 'generate'; field: 'username' | 'password'; pattern: 'ValueMfaCode' | 'MfaCodeValue'; totp: TotpConfig };
export interface MfaIdentity { username: string; domain: string; password?: string }
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const invalid = () => new Error('Configuration TOTP tidak valid');

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

/** RFC6238/RFC4226. The caller passes the current time immediately before using the credential. */
export function totp(config: TotpConfig, unixSeconds: number): string {
  if (!config || !['sha1', 'sha256', 'sha512'].includes(config.algorithm) || ![6, 8].includes(config.digits) || !Number.isInteger(config.period) || config.period < 15 || config.period > 120 || !Number.isFinite(unixSeconds) || unixSeconds < 0 || unixSeconds > Number.MAX_SAFE_INTEGER) throw invalid();
  const key = decodeBase32(config.secretBase32); const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / config.period)));
  try {
    const digest = createHmac(config.algorithm, key).update(counter).digest();
    try { const offset = digest[digest.length - 1]! & 15; return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** config.digits)).padStart(config.digits, '0'); }
    finally { digest.fill(0); }
  } finally { key.fill(0); counter.fill(0); }
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
