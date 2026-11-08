// Shared validation for the only values that participate in inheritance. Protocol properties remain local to an object.
import type { Json } from './model.js';

export const GROUPS = ['credentials', 'preConnectTask', 'postDisconnectTask', 'keySequence', 'rdGateway', 'managementEndpoint', 'secureGateway', 'color', 'notes', 'customProperties',
  'customField1', 'customField2', 'customField3', 'customField4', 'customField5', 'customField6', 'customField7', 'customField8', 'customField9', 'customField10',
  'customField11', 'customField12', 'customField13', 'customField14', 'customField15', 'customField16', 'customField17', 'customField18', 'customField19', 'customField20'] as const;
export type Group = typeof GROUPS[number];
export type GroupSettings = Partial<Record<Group, Json>>;
export type Inheritance = Partial<Record<Group, boolean>>;
export type CredentialSelection = { mode: 'none' | 'parent' } | { mode: 'inline'; secretId: string } | { mode: 'id'; vaultId: string; credentialId: string } | { mode: 'name'; name: string; scopeVaultIds: string[] };
export type StoredSecretRef = { secretId: string };
export type ObjectReference = { documentId: string; objectId: string };
const REFERENCE_GROUPS: readonly Group[] = ['preConnectTask', 'postDisconnectTask', 'keySequence', 'rdGateway', 'managementEndpoint', 'secureGateway'];
const PROTECTED_GROUPS: readonly Group[] = ['customProperties', ...GROUPS.filter(g => /^customField(1[1-9]|20)$/.test(g))];
export const GROUP_REGISTRY = Object.freeze(Object.fromEntries(GROUPS.map(group => [group, Object.freeze({
  privacy: group === 'credentials' || PROTECTED_GROUPS.includes(group) ? 'private' : 'public',
  capability: REFERENCE_GROUPS.includes(group) ? group : undefined,
})]))) as Readonly<Record<Group, Readonly<{ privacy: 'private' | 'public'; capability?: Group }>>>;
const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const own = (value: object, key: string) => Object.hasOwn(value, key);
export const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const isGroup = (value: string): value is Group => (GROUPS as readonly string[]).includes(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).length === allowed.length && allowed.every(key => own(value, key));
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !value.includes('\0');
export const isStoredSecretRef = (value: unknown): value is StoredSecretRef => isPlainRecord(value) && keys(value, ['secretId']) && uuid(value.secretId);

export class GroupValidationError extends Error {
  constructor(readonly code: 'bad-groups' | 'bad-inherit') { super(code === 'bad-groups' ? 'Invalid group settings' : 'Invalid inheritance settings'); this.name = 'GroupValidationError'; }
}
function selection(value: unknown): value is CredentialSelection {
  if (!isPlainRecord(value)) return false;
  switch (value.mode) {
    case 'none': case 'parent': return keys(value, ['mode']);
    case 'inline': return keys(value, ['mode', 'secretId']) && uuid(value.secretId);
    case 'id': return keys(value, ['mode', 'vaultId', 'credentialId']) && uuid(value.vaultId) && uuid(value.credentialId);
    case 'name': return keys(value, ['mode', 'name', 'scopeVaultIds']) && text(value.name, 256) && (value.name as string).length > 0 && Array.isArray(value.scopeVaultIds) && value.scopeVaultIds.length > 0 && value.scopeVaultIds.length <= 100 && value.scopeVaultIds.every(uuid) && new Set(value.scopeVaultIds).size === value.scopeVaultIds.length;
    default: return false;
  }
}
export function isGroupValue(group: Group, value: unknown): value is Json {
  if (group === 'credentials') return selection(value);
  if (PROTECTED_GROUPS.includes(group)) return value === false || isStoredSecretRef(value);
  if (REFERENCE_GROUPS.includes(group)) return value === false || (isPlainRecord(value) && keys(value, ['documentId', 'objectId']) && uuid(value.documentId) && uuid(value.objectId));
  if (group === 'notes') return text(value, 4000) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value as string);
  if (group === 'color') return value === false || (typeof value === 'string' && COLORS.includes(value));
  return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || text(value, 65_536);
}
export function validateGroups(raw: unknown): GroupSettings {
  if (!isPlainRecord(raw) || Object.entries(raw).some(([key, value]) => !isGroup(key) || !isGroupValue(key, value))) throw new GroupValidationError('bad-groups');
  return structuredClone(raw) as GroupSettings;
}
export function validateInheritance(raw: unknown, groups: GroupSettings = {}): Inheritance {
  if (!isPlainRecord(raw) || Object.entries(raw).some(([key, value]) => !isGroup(key) || typeof value !== 'boolean')) throw new GroupValidationError('bad-inherit');
  const credential = groups.credentials as CredentialSelection | undefined;
  if ((credential?.mode === 'parent' && raw.credentials !== true) || (raw.credentials === true && credential !== undefined && credential.mode !== 'parent')) throw new GroupValidationError('bad-inherit');
  return { ...raw } as Inheritance;
}
/** A separate projection prevents future group fields or a secret UUID from becoming a renderer property by accident. */
export function projectGroup(group: Group, value: Json): Json {
  if (group === 'credentials') {
    const ref = value as CredentialSelection;
    return ref.mode === 'inline' ? { mode: ref.mode, hasSecret: true } : { mode: ref.mode };
  }
  if (PROTECTED_GROUPS.includes(group)) return { hasValue: value !== false };
  return structuredClone(value);
}
