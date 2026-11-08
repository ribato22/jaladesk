import type { Doc, PrivateKey, TotpConfig } from '../documents/model.js';
import type { CredentialBinding } from '../documents/effective.js';
import { isGroupValue, isPlainRecord } from '../documents/groups.js';
import { UUID } from '../documents/schema-v1.js';
import { validateSecret } from '../documents/schema-v2.js';

export type CredentialErrorCode = 'missing' | 'locked' | 'stale' | 'scope-denied' | 'ambiguous' | 'invalid';
export class CredentialError extends Error {
  constructor(readonly code: CredentialErrorCode) { super('Credential resolution refused'); this.name = 'CredentialError'; }
}
const refuse = (code: CredentialErrorCode): never => { throw new CredentialError(code); };
const identityText = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export function normalizeIdentity(username: string, domain: string): { username: string; domain: string } {
  if (!identityText(username, 513) || !identityText(domain) || domain.includes('\\') || domain.includes('@')) return refuse('invalid');
  const parts = username.split('\\');
  if (parts.length > 2) return refuse('invalid');
  if (parts.length === 2) {
    const [prefix, user] = parts;
    if (!prefix || !user || !identityText(prefix) || !identityText(user) || prefix.includes('@') || user.includes('@') || (domain && prefix.toLowerCase() !== domain.toLowerCase())) return refuse('invalid');
    return { username: user, domain: prefix };
  }
  if (!identityText(username)) return refuse('invalid');
  if (username.includes('@') && (domain || !/^[^@]+@[^@]+$/.test(username))) return refuse('invalid');
  return { username, domain };
}
export type ResolvedCredential = { username: string; domain: string; password: string; privateKey?: PrivateKey; passphrase?: string; totp?: TotpConfig };
export type CredentialContext = { documents: readonly { doc: Doc; generation: number; unlocked: boolean }[]; scope: ReadonlySet<string> };

function openDocument(context: CredentialContext, documentId: string) {
  const matches = context.documents.filter(entry => entry.doc.id === documentId);
  if (matches.length === 0) return refuse('missing');
  if (matches.length !== 1) return refuse('ambiguous');
  const found = matches[0]!;
  if (found.unlocked !== true) return refuse('locked');
  return found;
}
function secretFrom(doc: Doc, secretId: string): ResolvedCredential {
  if (doc.schemaVersion !== 2 || !Object.hasOwn(doc.secrets, secretId)) return refuse('missing');
  const secret = doc.secrets[secretId]!;
  try { validateSecret(secret); } catch { return refuse('invalid'); }
  if (secret.kind !== 'credential') return refuse('invalid');
  const identity = normalizeIdentity(secret.username, secret.domain), password = secret.password ?? '';
  if (password.length > 4096 || password.includes('\0')) return refuse('invalid');
  return { ...identity, password, ...(secret.privateKey ? { privateKey: structuredClone(secret.privateKey) } : {}), ...(secret.passphrase !== undefined ? { passphrase: secret.passphrase } : {}), ...(secret.totp ? { totp: structuredClone(secret.totp) } : {}) };
}
/** The result is for a trusted adapter only. The selected binding always supplies its own owner. */
export function resolveCredential(binding: CredentialBinding, context: CredentialContext): ResolvedCredential {
  if (!isPlainRecord(binding) || Object.keys(binding).length !== 3 || typeof binding.ownerDocumentId !== 'string' || !UUID.test(binding.ownerDocumentId) || !Number.isSafeInteger(binding.ownerGeneration) || binding.ownerGeneration < 0 || !isGroupValue('credentials', binding.selection)) return refuse('invalid');
  const owner = openDocument(context, binding.ownerDocumentId);
  if (!Number.isSafeInteger(owner.generation) || owner.generation < 0) return refuse('invalid');
  if (owner.generation !== binding.ownerGeneration) return refuse('stale');
  const ref = binding.selection;
  if (ref.mode === 'none') return { username: '', domain: '', password: '' };
  if (ref.mode === 'inline') return secretFrom(owner.doc, ref.secretId);
  if (ref.mode === 'parent') return refuse('invalid');
  const source = (documentId: string): Doc => {
    if (!context.scope.has(documentId)) return refuse('scope-denied');
    const doc = openDocument(context, documentId).doc;
    if (doc.kind !== 'vault' && doc.kind !== 'workspace') return refuse('invalid');
    return doc;
  };
  const credential = (doc: Doc, credentialId: string): ResolvedCredential => {
    if (!Object.hasOwn(doc.objects, credentialId) || doc.objects[credentialId]!.type !== 'credential') return refuse('missing');
    const secretId = doc.objects[credentialId]!.props.secretId;
    if (typeof secretId !== 'string') return refuse('missing');
    if (!UUID.test(secretId)) return refuse('invalid');
    return secretFrom(doc, secretId);
  };
  if (ref.mode === 'id') return credential(source(ref.vaultId), ref.credentialId);
  if (ref.mode !== 'name') return refuse('invalid');
  const sources = ref.scopeVaultIds.map(source), matches: { doc: Doc; credentialId: string }[] = [];
  for (const doc of sources) for (const node of Object.values(doc.objects)) if (node.type === 'credential' && node.name.normalize('NFC') === ref.name.normalize('NFC')) matches.push({ doc, credentialId: node.id });
  if (matches.length === 0) return refuse('missing');
  if (matches.length !== 1) return refuse('ambiguous');
  return credential(matches[0]!.doc, matches[0]!.credentialId);
}
