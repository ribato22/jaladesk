// Version-aware file boundary. Legacy in-memory callers may still hold DocV1; every file load produces Doc2.
import { LIMITS, fail, isRecord, validateV1, type DocV1, type ValidationOptions } from './schema-v1.js';
import { upgradeV1, validateV2, type Doc2 } from './schema-v2.js';
export * from './schema-v1.js';
export { upgradeV1, validateV2 } from './schema-v2.js';
export type { Doc2, SecretRecord, StoredSecretRef, PrivateKey, TotpConfig } from './schema-v2.js';
export type Doc = DocV1 | Doc2;
export const CURRENT_SCHEMA = 2;

export function validateDocument(value: unknown, options: ValidationOptions = {}): Doc {
  return isRecord(value) && value.schemaVersion === 2 ? validateV2(value, options) : validateV1(value, options);
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])]));
  return value;
}
export function serializeDocument(doc: Doc): Buffer {
  const bytes = Buffer.from(JSON.stringify(sortKeys(doc)), 'utf8');
  if (bytes.length > LIMITS.maxBytes) fail('too-large', 'Document too large');
  return bytes;
}
export type MigrationSteps = Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>;
/** Older custom steps must reach schema 1, which is validated before the built-in upgrade can run. */
export function migrate(raw: unknown, steps: MigrationSteps = {}): Record<string, unknown> {
  if (!isRecord(raw)) return fail('bad-document', 'The document is not an object');
  let current: Record<string, unknown> = raw;
  const initial = current.schemaVersion;
  if (!Number.isInteger(initial) || (initial as number) < 0 || (initial as number) > CURRENT_SCHEMA) return fail('unsupported-schema', 'Schema version not supported');
  while ((current.schemaVersion as number) < 1) {
    const version = current.schemaVersion as number, step = steps[version];
    if (!step) return fail('unsupported-schema', 'No migration from this schema version');
    current = step(structuredClone(current));
    if (current.schemaVersion !== version + 1) fail('bad-document', 'A migration step did not advance the schema');
  }
  return current.schemaVersion === 1 ? upgradeV1(validateV1(current)) : validateV2(current);
}
export type LoadedDocument = { doc: Doc2; sourceSchema: 1 | 2 };
export function loadDocument(bytes: Uint8Array, options: { maxBytes?: number; migrations?: MigrationSteps } = {}): LoadedDocument {
  if (bytes.length > (options.maxBytes ?? LIMITS.maxBytes)) fail('too-large', 'Document too large');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('bad-json', 'The document is not valid JSON'); }
  const sourceSchema = isRecord(raw) && raw.schemaVersion === 2 ? 2 : 1;
  return { doc: validateV2(migrate(raw, options.migrations)), sourceSchema };
}
export function parseDocument(bytes: Uint8Array, options: Parameters<typeof loadDocument>[1] = {}): Doc2 { return loadDocument(bytes, options).doc; }
