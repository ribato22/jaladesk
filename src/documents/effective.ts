// Pure main-process resolution. It neither opens a vault nor executes a task or protocol adapter.
import type { Json } from './model.js';
import { GROUPS, GROUP_REGISTRY, isGroupValue, isStoredSecretRef, projectGroup, validateGroups, validateInheritance, type CredentialSelection, type Group, type GroupSettings } from './groups.js';

export type EffectiveNode = { id: string; type: string; parentId: string | null; props: Record<string, Json> };
export type EffectiveDocument = { id: string; revision: number; objects: Record<string, EffectiveNode>; defaults: { groups: GroupSettings } };
export type OwnerIdentity = { ownerDocumentId: string; ownerGeneration: number };
export type ResolutionLayer = Partial<OwnerIdentity> & { groups: GroupSettings };
export type ResolutionLayers = {
  documentGeneration: number; documentSeq?: number; vaultGeneration?: number; overrideGeneration?: number;
  applicationDefaults?: GroupSettings; applicationOwner?: OwnerIdentity;
  override?: ResolutionLayer; temporary?: ResolutionLayer; capabilities?: readonly Group[];
};
export type SourceRef = { layer: 'application' | 'document' | 'object' | 'override' | 'temporary'; documentId?: string; objectId?: string };
export type CredentialBinding = OwnerIdentity & { selection: CredentialSelection };
export type BoundSecretRef = OwnerIdentity & { secretId: string; kind: 'protected-value' };
export type PublicEffective = { groups: GroupSettings; provenance: Partial<Record<Group, SourceRef>> };
export type Effective = {
  public: PublicEffective;
  private: { groups: GroupSettings; credentialBinding?: CredentialBinding; protectedBindings: Partial<Record<Group, BoundSecretRef>>; capabilities: readonly Group[] };
  provenance: Partial<Record<Group, SourceRef>>;
};
export type ResolveError = { code: 'missing-object' | 'missing-parent' | 'invalid-parent' | 'cycle' | 'too-deep' | 'invalid-groups' | 'owner-missing' | 'too-many-targets' | 'duplicate-target' | 'invalid-targets' | 'not-supported'; group?: Group };
export type EffectiveResult<T> = { ok: true; value: T } | { ok: false; error: ResolveError };
const bad = (code: ResolveError['code'], group?: Group): EffectiveResult<never> => ({ ok: false, error: { code, ...(group ? { group } : {}) } });
const own = (value: object, key: string) => Object.hasOwn(value, key);
const held = <T>(map: Record<string, T>, key: string): T | undefined => own(map, key) ? map[key] : undefined;
const ownerValid = (value: Partial<OwnerIdentity> | undefined): value is OwnerIdentity => !!value && typeof value.ownerDocumentId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.ownerDocumentId) && Number.isSafeInteger(value.ownerGeneration) && value.ownerGeneration! >= 0;

/** Legacy notes/color remain local values; the schema-2 group wins when both exist. */
function localGroups(node: EffectiveNode): GroupSettings {
  const legacy: Record<string, unknown> = {};
  for (const group of ['notes', 'color'] as const) if (own(node.props, group) && isGroupValue(group, node.props[group])) legacy[group] = node.props[group];
  return validateGroups({ ...legacy, ...validateGroups(own(node.props, 'groups') ? node.props.groups : {}) });
}
export function resolveEffective(doc: EffectiveDocument, objectId: string, layers: ResolutionLayers): EffectiveResult<Effective> {
  for (const owner of [layers.applicationOwner, layers.override, layers.temporary]) if (owner && (own(owner, 'ownerDocumentId') || own(owner, 'ownerGeneration')) && !ownerValid(owner)) return bad('owner-missing');
  const target = held(doc.objects, objectId);
  if (!target) return bad('missing-object');
  const path: EffectiveNode[] = [], seen = new Set<string>();
  for (let at: EffectiveNode | undefined = target; at;) {
    if (seen.has(at.id)) return bad('cycle');
    if (path.length >= 64) return bad('too-deep');
    path.push(at); seen.add(at.id);
    if (at.parentId === null) break;
    const parent: EffectiveNode | undefined = held(doc.objects, at.parentId);
    if (!parent) return bad('missing-parent');
    if (seen.has(parent.id)) return bad('cycle');
    if (parent.type !== 'folder') return bad('invalid-parent');
    at = parent;
  }
  const resolved: GroupSettings = {}, provenance: Partial<Record<Group, SourceRef>> = {}, owners: Partial<Record<Group, Partial<OwnerIdentity>>> = {};
  const documentOwner = { ownerDocumentId: doc.id, ownerGeneration: layers.documentGeneration };
  try {
    const application = validateGroups(layers.applicationDefaults ?? {}), defaults = validateGroups(doc.defaults.groups);
    const locals = path.map(node => { const groups = localGroups(node); return { node, groups, inherit: validateInheritance(own(node.props, 'inherit') ? node.props.inherit : {}, groups) }; });
    const overlays = ([['override', layers.override], ['temporary', layers.temporary]] as const).map(([name, layer]) => ({ name, layer, groups: validateGroups(layer?.groups ?? {}) }));
    for (const group of GROUPS) {
      const fallback = own(defaults, group) ? defaults[group] : application[group];
      const fallbackSource: SourceRef = own(defaults, group) ? { layer: 'document', documentId: doc.id } : { layer: 'application' };
      const fallbackOwner = own(defaults, group) ? documentOwner : layers.applicationOwner;
      let value = fallback, source = fallbackSource, owner: Partial<OwnerIdentity> | undefined = fallbackOwner;
      for (let i = locals.length - 1; i >= 0; i--) {
        const local = locals[i]!;
        if (local.inherit[group] !== true) {
          value = fallback; source = fallbackSource; owner = fallbackOwner;
          if (own(local.groups, group)) { value = local.groups[group]; source = { layer: 'object', documentId: doc.id, objectId: local.node.id }; owner = documentOwner; }
        }
      }
      for (const overlay of overlays) if (own(overlay.groups, group)) { value = overlay.groups[group]; source = { layer: overlay.name, ...(overlay.layer?.ownerDocumentId ? { documentId: overlay.layer.ownerDocumentId } : {}) }; owner = overlay.layer; }
      if (value !== undefined) { resolved[group] = structuredClone(value); provenance[group] = source; if (owner) owners[group] = owner; }
    }
  } catch { return bad('invalid-groups'); }
  const protectedBindings: Partial<Record<Group, BoundSecretRef>> = {};
  let credentialBinding: CredentialBinding | undefined;
  for (const group of GROUPS) {
    const value = resolved[group];
    if (group === 'credentials' && value !== undefined) {
      const owner = owners[group];
      if (!ownerValid(owner)) return bad('owner-missing', group);
      if ((value as CredentialSelection).mode === 'parent') return bad('invalid-groups', group);
      credentialBinding = { selection: structuredClone(value) as CredentialSelection, ownerDocumentId: owner.ownerDocumentId, ownerGeneration: owner.ownerGeneration };
    } else if (isStoredSecretRef(value)) {
      const owner = owners[group];
      if (!ownerValid(owner)) return bad('owner-missing', group);
      protectedBindings[group] = { secretId: value.secretId, ownerDocumentId: owner.ownerDocumentId, ownerGeneration: owner.ownerGeneration, kind: 'protected-value' };
    }
  }
  const publicGroups: GroupSettings = {};
  for (const group of GROUPS) if (resolved[group] !== undefined) publicGroups[group] = projectGroup(group, resolved[group]!);
  return { ok: true, value: { public: { groups: publicGroups, provenance: structuredClone(provenance) }, private: { groups: resolved, ...(credentialBinding ? { credentialBinding } : {}), protectedBindings, capabilities: [...(layers.capabilities ?? [])] }, provenance } };
}
/** Consumers must check this before invoking adapters. Keeping an unavailable reference does not grant its capability. */
export function useEffectiveGroup(effective: Effective, group: Group): EffectiveResult<Json | undefined> {
  if (GROUP_REGISTRY[group].capability && effective.private.groups[group] !== undefined && effective.private.groups[group] !== false && !effective.private.capabilities.includes(group)) return bad('not-supported', group);
  return { ok: true, value: structuredClone(effective.private.groups[group]) };
}
export type PublicEffectiveBatch = { items: (PublicEffective & { objectId: string })[]; seq: number; vaultGeneration: number; overrideGeneration: number };
export function batchPublicEffective(doc: EffectiveDocument, ids: readonly string[], layers: ResolutionLayers): EffectiveResult<PublicEffectiveBatch> {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return bad('invalid-targets');
  if (ids.length > 256) return bad('too-many-targets');
  if (new Set(ids).size !== ids.length) return bad('duplicate-target');
  const items: PublicEffectiveBatch['items'] = [];
  for (const objectId of ids) {
    const result = resolveEffective(doc, objectId, layers);
    if (!result.ok) return result;
    items.push({ objectId, ...result.value.public });
  }
  return { ok: true, value: { items, seq: layers.documentSeq ?? doc.revision, vaultGeneration: layers.vaultGeneration ?? 0, overrideGeneration: layers.overrideGeneration ?? 0 } };
}
