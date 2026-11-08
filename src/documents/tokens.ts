import type { Json } from './model.js';
import { isPlainRecord } from './groups.js';
import { validateTarget } from '../protocols/rdp/wire.js';

export type TokenContext = Record<string, string | number | boolean | null | undefined>;
export type TokenOptions = { sink: 'host' | 'label' | 'preview' | 'log' | 'filename' | 'port'; type?: 'number' };
export class TokenError extends Error {
  constructor(readonly code: 'invalid-token' | 'unknown-token' | 'missing-token' | 'not-supported' | 'secret-token' | 'token-limit' | 'invalid-value') { super(code); this.name = 'TokenError'; }
}
function bad(code: TokenError['code']): never { throw new TokenError(code); }
export const isPublicTokenName = (name: string) => ['Host', 'Name', 'Description', 'UserName', 'Userdomain', 'Port', 'EffectiveHost', 'EffectiveName', 'EffectiveDescription', 'EffectiveUserName', 'EffectiveUserdomain', 'EffectivePort', 'EffectiveNotes', 'EffectiveColor'].includes(name) || /^(?:customField|standardCustomField|EffectiveCustomField)(?:[1-9]|10)$/.test(name);
const secretName = (name: string) => /^(?:Effective)?(?:Password|MfaCode|ProtectedField|PrivateKey|Passphrase|TotpSeed)(?:\..*)?$/.test(name) || /^(?:customField|standardCustomField|EffectiveCustomField)(?:1[1-9]|20)$/.test(name);
const dynamicName = (name: string) => /^(?:Env|Clipboard|DateTime|Shell|Provider)(?:\.|$)/.test(name);

/** Only a fixed public vocabulary is substituted; produced text is never scanned again. */
export function resolveToken(input: string | number, context: TokenContext, options: TokenOptions): string | number {
  const parts: (string | number | boolean | null)[] = [];
  let tokens = 0;
  if (typeof input === 'number') parts.push(input);
  else if (typeof input === 'string') {
    let literal = '';
    const flush = () => { if (literal) { parts.push(literal); literal = ''; } };
    for (let i = 0; i < input.length;) {
      if (input[i] !== '$') { literal += input[i++]; continue; }
      if (input[i + 1] === '$') { literal += '$'; i += 2; continue; }
      flush(); if (++tokens > 64) bad('token-limit');
      if (input[i + 1] === '"') {
        let end = i + 2, escaped = false;
        for (; end < input.length; end++) { if (!escaped && input[end] === '"') break; if (!escaped && input[end] === '\\') escaped = true; else escaped = false; }
        if (end >= input.length || input[end + 1] !== '$') bad('invalid-token');
        try { const value: unknown = JSON.parse(input.slice(i + 1, end + 1)); if (typeof value !== 'string') bad('invalid-token'); parts.push(value); } catch { bad('invalid-token'); }
        i = end + 2; continue;
      }
      const end = input.indexOf('$', i + 1);
      if (end < 0) bad('invalid-token');
      const name = input.slice(i + 1, end);
      if (secretName(name)) bad('secret-token');
      if (dynamicName(name)) bad('not-supported');
      if (!isPublicTokenName(name)) bad('unknown-token');
      if (!Object.hasOwn(context, name) || context[name] === undefined) bad('missing-token');
      const value = context[name];
      if (typeof value === 'object' && value !== null) bad('secret-token');
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) bad('invalid-value');
      if (typeof value === 'number' && !Number.isFinite(value)) bad('invalid-value');
      parts.push(value); i = end + 1;
    }
    flush();
  } else bad('invalid-value');
  if (options.type === 'number' || options.sink === 'port') {
    if (parts.length !== 1 || typeof parts[0] !== 'number' || !Number.isSafeInteger(parts[0]) || parts[0] < 1 || parts[0] > 65535) bad('invalid-value');
    return parts[0];
  }
  const output = parts.map(value => String(value)).join('');
  if (new TextEncoder().encode(output).length > 65536) bad('token-limit');
  if (options.sink === 'host') { try { validateTarget({ host: output, port: 3389, username: 'u' }); } catch { bad('invalid-value'); } }
  return output;
}

export function expandTokenFields(props: Record<string, Json>, context: TokenContext): Record<string, Json> {
  if (!isPlainRecord(props)) bad('invalid-value');
  const copy = structuredClone(props);
  for (const key of ['host', 'port', 'username', 'notes'] as const) if (Object.hasOwn(copy, key)) {
    const value = copy[key];
    if (typeof value !== 'string' && typeof value !== 'number') bad('invalid-value');
    copy[key] = resolveToken(value, context, { sink: key === 'port' ? 'port' : key === 'host' ? 'host' : 'label', ...(key === 'port' ? { type: 'number' as const } : {}) });
  }
  return copy;
}
