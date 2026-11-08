import { randomUUID } from 'node:crypto';
import type { DocumentLibrary, Delta } from '../documents/library.js';
import type { Doc2, ObjectNode } from '../documents/model.js';
import { UUID, validateNode } from '../documents/model.js';
import { isPlainRecord, isGroup, GROUP_REGISTRY } from '../documents/groups.js';
import { resolveEffective, type ResolutionLayers } from '../documents/effective.js';
import { captureTemplate, validateTemplateSnapshot, instantiateTemplate, adHocTemplate, type TemplateSnapshot } from '../documents/templates.js';
import { expandTokenFields, isPublicTokenName, resolveToken, type TokenContext } from '../documents/tokens.js';
import type { StoredOpened } from './connections.js';
import { checkStored } from './connection-settings.js';

type Capture = { id: string; expectedSeq: number; objectId: string; name: string; copyReferences?: boolean };
export type TemplateFields = Partial<{ Name: string; Host: string; Port: string | number; UserName: string; Description: string }>;
type Apply = { id: string; expectedSeq: number; templateHandle: string; templateId: string; parentId?: string | null; name?: string; values?: TokenContext; fields?: TemplateFields };
type AdHoc = { templateHandle: string; templateId: string; values?: TokenContext; fields?: TemplateFields };
export type TemplateSummary = { handle: string; id: string; name: string; roots: number };
export type TemplateDeps = {
  layers?: (ref: { documentHandle: string; objectId: string; expectedSeq: number }) => Omit<ResolutionLayers,'documentGeneration'>;
  confirmPrivateValues?: (request: { documentHandle: string; objectId: string; name: string; count: number }) => Promise<boolean>;
  confirmReferences?: (request: { documentHandle: string; objectId: string; name: string; sourceDocumentIds: string[] }) => Promise<boolean>;
  openAdHoc: (node: ObjectNode) => Promise<StoredOpened>;
};
export class TemplateServiceError extends Error {
  constructor(readonly code: 'invalid' | 'stale' | 'scope-denied' | 'too-large' | 'busy') { super(code); this.name = 'TemplateServiceError'; }
}
function bad(code: TemplateServiceError['code'] = 'invalid'): never { throw new TemplateServiceError(code); }
const shape = (value: unknown, allowed: string[]): value is Record<string, unknown> => isPlainRecord(value) && Object.keys(value).every(key => allowed.includes(key));
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
function seqRequest(value: unknown, allowed: string[]): asserts value is { id: string; expectedSeq: number } {
  if (!shape(value, allowed) || !uuid(value.id) || !Number.isSafeInteger(value.expectedSeq) || (value.expectedSeq as number) < 0) bad();
}
function name(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length > 256 || !value.trim()) bad(); }
function withTokens(original: ObjectNode, supplied: TokenContext = {}, fields: TemplateFields = {}): ObjectNode {
  if (!isPlainRecord(supplied) || Object.keys(supplied).length > 64 || Object.entries(supplied).some(([key,value])=>!isPublicTokenName(key) || !(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 65536))) bad();
  if (!isPlainRecord(fields) || Object.entries(fields).some(([key,value])=>!['Name','Host','Port','UserName','Description'].includes(key) || !(typeof value === 'string' && value.length <= 65536 || key === 'Port' && typeof value === 'number' && Number.isFinite(value)))) bad();
  const node = structuredClone(original), groups = isPlainRecord(node.props.groups) ? node.props.groups : {};
  const context: TokenContext = { Host: typeof node.props.host === 'string' ? node.props.host : undefined, Name: node.name, Description: typeof node.props.notes === 'string' ? node.props.notes : typeof groups.notes === 'string' ? groups.notes : undefined, UserName: typeof node.props.username === 'string' ? node.props.username : undefined, Userdomain: '', Port: typeof node.props.port === 'number' ? node.props.port : undefined };
  for (const key of ['Host','Name','Description','UserName','Userdomain','Port']) context[`Effective${key}`] = context[key];
  context.EffectiveNotes = typeof groups.notes === 'string' ? groups.notes : undefined; context.EffectiveColor = typeof groups.color === 'string' ? groups.color : undefined;
  for (let i = 1; i <= 10; i++) { const value = groups[`customField${i}`]; if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') for (const prefix of ['customField','standardCustomField','EffectiveCustomField']) context[`${prefix}${i}`] = value; }
  Object.assign(context,supplied);
  if (node.type === 'connection') {
    if (fields.Name !== undefined) node.name = fields.Name;
    for (const [field,key] of [['Host','host'],['Port','port'],['UserName','username'],['Description','notes']] as const) if (fields[field] !== undefined) node.props[key] = fields[field]!;
    if (fields.Description !== undefined && isPlainRecord(node.props.groups) && Object.hasOwn(node.props.groups,'notes')) node.props.groups.notes = fields.Description;
  }
  node.name = String(resolveToken(node.name,context,{sink:'label'}));
  node.props = expandTokenFields(node.props,context);
  if (isPlainRecord(node.props.groups)) for (const key of ['notes', ...Array.from({length:10},(_,i)=>`customField${i+1}`)]) { const value = node.props.groups[key]; if (typeof value === 'string') node.props.groups[key] = resolveToken(value,context,{sink:'preview'}); }
  try { validateNode(node); } catch { return bad(); }
  if (node.type === 'connection' && checkStored(node.props).length) bad();
  return node;
}

export class TemplateService {
  #pending = false;
  constructor(readonly library: DocumentLibrary, readonly deps: TemplateDeps) {}
  #source(handle: string): { doc: Doc2; generation: number; seq: number } {
    try { const source = this.library.privateDocument(handle); if (source.doc.schemaVersion !== 2 || source.doc.kind !== 'workspace') bad(); return { ...source, doc: source.doc }; } catch { return bad(); }
  }
  #current(handle: string, expectedSeq: number) { const state = this.#source(handle); if (state.seq !== expectedSeq) bad('stale'); return state; }
  #versions(): string { return JSON.stringify(this.library.privateDocuments().map(source => [source.handle, source.doc.id, source.generation, source.seq]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))); }
  #snapshot(handle: string, templateId: string): TemplateSnapshot {
    const source = this.#source(handle), node = Object.hasOwn(source.doc.objects, templateId) ? source.doc.objects[templateId] : undefined;
    if (node?.type !== 'template' || typeof node.props.snapshot !== 'string' || node.props.snapshot.length > 65536) bad();
    try { return validateTemplateSnapshot(JSON.parse(node.props.snapshot)); } catch { return bad(); }
  }
  list(): TemplateSummary[] {
    const rows: TemplateSummary[] = [];
    for (const source of this.library.privateDocuments()) if (source.doc.kind === 'workspace') for (const node of Object.values(source.doc.objects)) if (node.type === 'template') {
      try { const snapshot = this.#snapshot(source.handle, node.id); rows.push({ handle: source.handle, id: node.id, name: node.name, roots: snapshot.roots.length }); } catch { /* Corrupt snapshots cannot be selected or executed. */ }
    }
    return rows;
  }
  async capture(input: Capture): Promise<{ templateId: string; delta: Delta }> {
    seqRequest(input, ['id','expectedSeq','objectId','name','copyReferences']);
    if (!uuid(input.objectId) || (input.copyReferences !== undefined && typeof input.copyReferences !== 'boolean')) bad(); name(input.name);
    const source = this.#current(input.id, input.expectedSeq);
    const layers = new Map<string,{value:ResolutionLayers;stamp:string}>();
    const readLayer = (objectId: string) => this.deps.layers?.({documentHandle:input.id,objectId,expectedSeq:input.expectedSeq}) ?? {};
    const forObject = (objectId: string): ResolutionLayers => {
      const value = structuredClone(readLayer(objectId)), resolved = {...value,documentGeneration:source.generation};
      layers.set(objectId,{value:resolved,stamp:JSON.stringify(value)});
      return resolved;
    };
    let snapshot: TemplateSnapshot;
    snapshot = captureTemplate(source.doc, [input.objectId], forObject, { copyCredentialReferences: input.copyReferences === true, allowedCredentialDocumentIds: this.library.privateDocuments().map(source=>source.doc.id) });
    let privateCount = 0;
    for (const [objectId,layer] of layers) {
      const effective = resolveEffective(source.doc,objectId,layer.value);
      if (!effective.ok) bad();
      if (Object.entries(effective.value.provenance).some(([group,origin])=>isGroup(group) && GROUP_REGISTRY[group].privacy==='public' && origin.layer==='override')) privateCount++;
    }
    const sources = [...new Set(snapshot.objects.flatMap(node => {
      const groups = isPlainRecord(node.props.groups) ? node.props.groups : {}, credentials = groups.credentials;
      return isPlainRecord(credentials) ? credentials.mode === 'id' ? [String(credentials.vaultId)] : credentials.mode === 'name' && Array.isArray(credentials.scopeVaultIds) ? credentials.scopeVaultIds.map(String) : [] : [];
    }))];
    const payload = JSON.stringify(snapshot);
    if (payload.length > 65536) bad('too-large');
    if (sources.length || privateCount) {
      if (this.#pending) bad('busy');
      this.#pending = true;
      const versions = this.#versions();
      const assertCurrent = () => {
        if (versions !== this.#versions()) bad('stale');
        for (const [objectId,layer] of layers) if (JSON.stringify(readLayer(objectId)) !== layer.stamp) bad('stale');
      };
      try {
        if (privateCount) {
          const allowed = await this.deps.confirmPrivateValues?.({documentHandle:input.id,objectId:input.objectId,name:source.doc.objects[input.objectId]!.name,count:privateCount});
          assertCurrent(); if (!allowed) bad('scope-denied');
        }
        if (sources.length) {
          const allowed = await this.deps.confirmReferences?.({ documentHandle: input.id, objectId: input.objectId, name: input.name, sourceDocumentIds: sources });
          assertCurrent(); if (!allowed) bad('scope-denied');
        }
      } finally { this.#pending = false; }
    }
    const current = this.#current(input.id, input.expectedSeq);
    if (current.generation !== source.generation) bad('stale');
    for (const [objectId,layer] of layers) if (JSON.stringify(readLayer(objectId)) !== layer.stamp) bad('stale');
    const templateId = randomUUID();
    const delta = this.library.changePrivate(input.id, input.expectedSeq, doc => { doc.objects[templateId] = { id: templateId, type: 'template', name: input.name, parentId: null, order: Object.values(doc.objects).filter(node=>node.parentId===null).length, props: { snapshot: payload } }; });
    return { templateId, delta };
  }
  apply(input: Apply): { objectIds: string[]; delta: Delta } {
    seqRequest(input,['id','expectedSeq','templateHandle','templateId','parentId','name','values','fields']);
    if (!uuid(input.templateHandle) || !uuid(input.templateId) || (input.parentId !== undefined && input.parentId !== null && !uuid(input.parentId))) bad();
    if (input.name !== undefined) name(input.name);
    const source = this.#current(input.id,input.expectedSeq), snapshot = this.#snapshot(input.templateHandle,input.templateId);
    snapshot.objects = snapshot.objects.map(node=>withTokens(node,input.values,input.fields));
    let result: ReturnType<typeof instantiateTemplate>;
    try { result = instantiateTemplate(snapshot, source.doc, { parentId: input.parentId, name: input.name }); } catch { return bad(); }
    const delta = this.library.changePrivate(input.id,input.expectedSeq,doc=>{ doc.objects = result.doc.objects; });
    return { objectIds: result.objectIds, delta };
  }
  async adHoc(input: AdHoc): Promise<StoredOpened> {
    if (!shape(input,['templateHandle','templateId','values','fields']) || !uuid(input.templateHandle) || !uuid(input.templateId)) bad();
    const snapshot = this.#snapshot(input.templateHandle,input.templateId), node = withTokens(adHocTemplate(snapshot),input.values,input.fields);
    return this.deps.openAdHoc(node);
  }
  prepareBulk(input:AdHoc&{copyReferences?:boolean}):ObjectNode{
    if(!shape(input,['templateHandle','templateId','values','fields','copyReferences'])||!uuid(input.templateHandle)||!uuid(input.templateId)||(input.copyReferences!==undefined&&typeof input.copyReferences!=='boolean'))bad();
    let node:ObjectNode;try{node=withTokens(adHocTemplate(this.#snapshot(input.templateHandle,input.templateId)),input.values,input.fields);}catch{return bad();}
    const groups=isPlainRecord(node.props.groups)?node.props.groups:undefined,selection=groups?.credentials;
    if(!input.copyReferences){if(groups)delete groups.credentials;return node;}
    if(isPlainRecord(selection)){
      const owners=selection.mode==='id'?[selection.vaultId]:selection.mode==='name'&&Array.isArray(selection.scopeVaultIds)?selection.scopeVaultIds:[];
      for(const id of owners){const matches=this.library.privateDocuments().filter(source=>source.doc.id===id);if(matches.length!==1)bad('scope-denied');if(selection.mode==='id'&&matches[0]!.doc.objects[String(selection.credentialId)]?.type!=='credential')bad('scope-denied');}
    }
    return node;
  }
  remove(input: { id: string; expectedSeq: number; templateId: string }): Delta {
    seqRequest(input,['id','expectedSeq','templateId']); if (!uuid(input.templateId)) bad();
    this.#current(input.id,input.expectedSeq); this.#snapshot(input.id,input.templateId);
    return this.library.changePrivate(input.id,input.expectedSeq,doc=>{ delete doc.objects[input.templateId]; });
  }
}
