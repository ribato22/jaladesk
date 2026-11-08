import { createHash } from 'node:crypto';
import { decodeBase32 } from '../credentials/totp.js';
import { validateGroups, validateInheritance, type GroupSettings } from './groups.js';
import { LIMITS, UUID, fail, isRecord, checkJson, validateBase, validateV1, type DocV1, type Json, type ObjectNode, type ValidationOptions } from './schema-v1.js';
export type StoredSecretRef = { secretId: string };
export type PrivateKey = { mode: 'path'; path: string } | { mode: 'embedded'; base64: string };
export type TotpConfig = { secretBase32: string; algorithm: 'sha1' | 'sha256' | 'sha512'; digits: 6 | 8; period: number };
export type SecretRecord = { kind: 'credential'; username: string; domain: string; password?: string; privateKey?: PrivateKey; passphrase?: string; totp?: TotpConfig } | { kind: 'protected-value'; value: Json };
export type Doc2 = { schemaVersion: 2; id: string; kind: 'workspace' | 'vault' | 'overrides'; name: string; revision: number; objects: Record<string, ObjectNode>; meta: { createdAt: string | null; updatedAt: string | null; sort: { by: 'name' | 'type'; dir: 'asc' | 'desc' }[] }; defaults: { groups: GroupSettings }; secrets: Record<string, SecretRecord> };
const exact = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> => isRecord(raw) && Object.keys(raw).every(k => keys.includes(k));
const text = (raw: unknown): raw is string => typeof raw === 'string' && raw.length <= LIMITS.maxString;
const utc = (raw: unknown): boolean => raw === null || (typeof raw === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(raw) && Number.isFinite(Date.parse(raw)) && new Date(raw).toISOString() === (raw.includes('.') ? raw : raw.replace('Z', '.000Z')));
function invalid(): never { return fail('bad-props', 'Invalid version 2 document data'); }
function base32(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try { decodeBase32(raw).fill(0); return true; } catch { return false; }
}
export function validateSecret(raw: unknown): SecretRecord {
  if (!isRecord(raw)) return invalid();
  if (raw.kind === 'protected-value') {
    if (!exact(raw, ['kind', 'value']) || !Object.hasOwn(raw, 'value')) return invalid();
    checkJson(raw.value, 0);
  } else if (raw.kind === 'credential') {
    if (!exact(raw, ['kind', 'username', 'domain', 'password', 'privateKey', 'passphrase', 'totp']) || !text(raw.username) || !text(raw.domain)) return invalid();
    for (const key of ['password', 'passphrase']) if (Object.hasOwn(raw, key) && !text(raw[key])) invalid();
    if (Object.hasOwn(raw, 'privateKey')) {
      const key = raw.privateKey;
      if (!isRecord(key)) return invalid();
      if (key.mode === 'path') { if (!exact(key, ['mode', 'path']) || !text(key.path) || key.path.length === 0 || key.path.includes('\0')) invalid(); }
      else if (key.mode === 'embedded') { if (!exact(key, ['mode', 'base64']) || !text(key.base64) || !key.base64 || Buffer.from(key.base64, 'base64').toString('base64') !== key.base64) invalid(); }
      else invalid();
    }
    if (Object.hasOwn(raw, 'totp')) {
      const totp = raw.totp;
      if (!exact(totp, ['secretBase32', 'algorithm', 'digits', 'period']) || !base32(totp.secretBase32) || !['sha1', 'sha256', 'sha512'].includes(totp.algorithm as string) || ![6, 8].includes(totp.digits as number) || !Number.isInteger(totp.period) || (totp.period as number) < 15 || (totp.period as number) > 120) invalid();
    }
  } else return invalid();
  return raw as SecretRecord;
}
export function validateV2(value: unknown, options: ValidationOptions = {}): Doc2 {
  const raw = validateBase(value, 2, options);
  if (!exact(raw.meta, ['createdAt', 'updatedAt', 'sort']) || !utc(raw.meta.createdAt) || !utc(raw.meta.updatedAt) || !Array.isArray(raw.meta.sort) || raw.meta.sort.length > 2) invalid();
  const seen = new Set<string>();
  for (const criterion of raw.meta.sort) {
    if (!exact(criterion, ['by', 'dir']) || !['name', 'type'].includes(criterion.by as string) || !['asc', 'desc'].includes(criterion.dir as string) || seen.has(criterion.by as string)) invalid();
    seen.add(criterion.by as string);
  }
  if (!exact(raw.defaults, ['groups']) || !isRecord(raw.defaults.groups) || !isRecord(raw.secrets)) invalid();
  for (const [secretId, secret] of Object.entries(raw.secrets)) { if (!UUID.test(secretId)) invalid(); validateSecret(secret); }
  const doc = raw as Doc2;
  const groups = (input: unknown, inherit?: unknown): void => {
    let valid: GroupSettings;
    try { valid = validateGroups(input); if (inherit !== undefined) validateInheritance(inherit, valid); else validateInheritance({}, valid); } catch { return invalid(); }
    for (const [group, value] of Object.entries(valid)) {
      if (!isRecord(value)) continue;
      if (group === 'credentials' && value.mode === 'inline') requireSecret(doc, value.secretId, 'credential');
      else if (group === 'credentials' && value.mode === 'id' && value.vaultId === doc.id && (typeof value.credentialId !== 'string' || !Object.hasOwn(doc.objects, value.credentialId) || doc.objects[value.credentialId]!.type !== 'credential')) invalid();
      else if (group === 'customProperties' || /^customField(?:1[1-9]|20)$/.test(group)) requireSecret(doc, value.secretId, 'protected-value');
      else if (Object.hasOwn(value, 'documentId') && value.documentId === doc.id && (typeof value.objectId !== 'string' || !Object.hasOwn(doc.objects, value.objectId))) invalid();
    }
  };
  groups(doc.defaults.groups);
  for (const node of Object.values(doc.objects)) {
    for (const key of LEGACY_SECRET_FIELDS) if (Object.hasOwn(node.props, key)) invalid();
    for (const key of ['customProperties', ...PROTECTED_FIELDS]) if (Object.hasOwn(node.props, key)) invalid();
    if (Object.hasOwn(node.props, 'groups')) groups(node.props.groups, node.props.inherit);
    else if (Object.hasOwn(node.props, 'inherit')) { try { validateInheritance(node.props.inherit); } catch { invalid(); } }
    if (Object.hasOwn(node.props, 'secretId')) {
      if (node.type !== 'credential') invalid();
      requireSecret(doc, node.props.secretId, 'credential');
    }
  }
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > LIMITS.maxBytes) fail('too-large', 'Document too large');
  return raw as Doc2;
}
const PROTECTED_FIELDS = Array.from({ length: 10 }, (_, index) => `customField${index + 11}`);
const LEGACY_SECRET_FIELDS = ['password', 'privateKey', 'privateKeyPath', 'privateKeyBase64', 'passphrase', 'privateKeyPassphrase', 'totp', 'totpSecret', 'totpSeed', 'secretBase32'];
function requireSecret(doc: Doc2, secretId: unknown, kind: SecretRecord['kind']): void {
  if (typeof secretId !== 'string' || !UUID.test(secretId) || !Object.hasOwn(doc.secrets, secretId) || doc.secrets[secretId]!.kind !== kind) invalid();
}
function migrationId(docId: string, objectId: string, field: string): string {
  const hash = createHash('sha256').update(`rwdoc-schema2\0${docId}\0${objectId}\0${field}`).digest();
  hash[6] = (hash[6]! & 15) | 128;
  hash[8] = (hash[8]! & 63) | 128;
  const hex = hash.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function upgradeV1(value: DocV1): Doc2 {
  const old = validateV1(value);
  const doc: Doc2 = { ...structuredClone(old), schemaVersion: 2, meta: { createdAt: null, updatedAt: null, sort: [] }, defaults: { groups: {} }, secrets: {} };
  const addSecret = (node: ObjectNode, field: string, secret: SecretRecord): string => {
    validateSecret(secret);
    const secretId = migrationId(doc.id, node.id, field);
    if (Object.hasOwn(doc.secrets, secretId)) invalid();
    doc.secrets[secretId] = secret;
    return secretId;
  };
  for (const node of Object.values(doc.objects)) {
    const props = node.props;
    const has = (key: string) => Object.hasOwn(props, key);
    const select = (keys: string[]): Json | undefined => {
      const present = keys.filter(has);
      if (present.length > 1) invalid();
      return present.length === 1 ? props[present[0]!] : undefined;
    };
    if (node.type === 'credential' || LEGACY_SECRET_FIELDS.some(has)) {
      const secret: Extract<SecretRecord, { kind: 'credential' }> = { kind: 'credential', username: has('username') ? props.username as string : '', domain: has('domain') ? props.domain as string : '' };
      if (has('password')) secret.password = props.password as string;
      const key = select(['privateKey', 'privateKeyPath', 'privateKeyBase64']);
      if (key !== undefined) {
        if (has('privateKeyPath')) secret.privateKey = { mode: 'path', path: key as string };
        else if (has('privateKeyBase64')) secret.privateKey = { mode: 'embedded', base64: key as string };
        else if (typeof key === 'string') secret.privateKey = key.includes('-----BEGIN ') ? { mode: 'embedded', base64: Buffer.from(key, 'utf8').toString('base64') } : { mode: 'path', path: key };
        else secret.privateKey = key as unknown as PrivateKey;
      }
      const passphrase = select(['passphrase', 'privateKeyPassphrase']);
      if (passphrase !== undefined) secret.passphrase = passphrase as string;
      const seed = select(['totpSecret', 'totpSeed', 'secretBase32']);
      if (has('totp') && seed !== undefined) invalid();
      if (has('totp')) secret.totp = props.totp as unknown as TotpConfig;
      else if (seed !== undefined) secret.totp = { secretBase32: seed as string, algorithm: 'sha1', digits: 6, period: 30 };
      const secretId = addSecret(node, 'credential', secret);
      if (node.type === 'credential') { if (has('secretId')) invalid(); props.secretId = secretId; }
      else {
        const local = props.groups === undefined ? {} : props.groups;
        if (!isRecord(local) || Object.hasOwn(local, 'credentials')) invalid();
        props.groups = { ...local, credentials: { mode: 'inline', secretId } } as Json;
      }
      for (const field of [...LEGACY_SECRET_FIELDS, 'username', 'domain']) delete props[field];
    }
    for (const field of ['customProperties', ...PROTECTED_FIELDS]) {
      if (has(field)) {
        const local = props.groups === undefined ? {} : props.groups;
        if (!isRecord(local) || Object.hasOwn(local, field)) invalid();
        props.groups = { ...local, [field]: { secretId: addSecret(node, field, { kind: 'protected-value', value: props[field]! }) } } as Json;
        delete props[field];
      } else if (isRecord(props.groups) && Object.hasOwn(props.groups, field)) {
        const held = props.groups[field];
        if (held !== false && !(isRecord(held) && Object.keys(held).length === 1 && typeof held.secretId === 'string')) props.groups[field] = { secretId: addSecret(node, field, { kind: 'protected-value', value: held as Json }) };
      }
    }
  }
  return validateV2(doc);
}
