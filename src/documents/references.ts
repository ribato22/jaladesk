// Typed paths only: an unknown property's coincidental id is never rewritten.
import type { ObjectNode } from './model.js';
import { isRecord } from './schema-v1.js';
import { GROUPS } from './groups.js';

const protectedGroup = (group: string): boolean => group === 'customProperties' || /^customField(?:1[1-9]|20)$/.test(group);
export function referencedSecretIds(node: ObjectNode): string[] {
  const found = new Set<string>();
  if (node.type === 'credential' && typeof node.props.secretId === 'string') found.add(node.props.secretId);
  if (isRecord(node.props.groups)) for (const group of GROUPS) {
    const ref = node.props.groups[group];
    if (isRecord(ref) && typeof ref.secretId === 'string' && ((group === 'credentials' && ref.mode === 'inline') || protectedGroup(group))) found.add(ref.secretId);
  }
  return [...found];
}
export type ReferenceMaps = { objectIds: Record<string, string>; secretIds: Record<string, string>; sourceDocumentId: string; targetDocumentId: string };
export function remapNodeReferences(node: ObjectNode, maps: ReferenceMaps): ObjectNode {
  const copy = structuredClone(node);
  const secret = (ref: Record<string, unknown>): void => {
    if (typeof ref.secretId === 'string' && Object.hasOwn(maps.secretIds, ref.secretId)) ref.secretId = maps.secretIds[ref.secretId]!;
  };
  if (copy.type === 'credential') secret(copy.props);
  if (isRecord(copy.props.groups)) for (const group of GROUPS) {
    const ref = copy.props.groups[group];
    if (!isRecord(ref)) continue;
    if ((group === 'credentials' && ref.mode === 'inline') || protectedGroup(group)) secret(ref);
    else if (group === 'credentials' && ref.mode === 'id' && ref.vaultId === maps.sourceDocumentId && typeof ref.credentialId === 'string' && Object.hasOwn(maps.objectIds, ref.credentialId)) {
      ref.vaultId = maps.targetDocumentId; ref.credentialId = maps.objectIds[ref.credentialId]!;
    } else if (ref.documentId === maps.sourceDocumentId && typeof ref.objectId === 'string' && Object.hasOwn(maps.objectIds, ref.objectId)) {
      ref.documentId = maps.targetDocumentId; ref.objectId = maps.objectIds[ref.objectId]!;
    }
  }
  return copy;
}
