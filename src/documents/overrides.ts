// Private user overlays reuse document encryption, revisions and compare-and-save; they never enter DocumentLibrary.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { choicesOf, keyOf, type Choice } from './conflicts.js';
import { EnvelopeError } from './envelope.js';
import type { ResolutionLayer } from './effective.js';
import { isGroup, isPlainRecord, validateGroups, type Group, type GroupSettings } from './groups.js';
import { DocumentError, parseDocument, UUID, validateV2, type Doc, type Doc2, type Json, type SecretRecord } from './model.js';
import { referencedSecretIds } from './references.js';
import { DocumentSession } from './session.js';
import { realFs, StoreError, type Options } from './store.js';

export type OverrideTarget = { documentId: string; objectId: string };
export type OverrideErrorCode = 'invalid' | 'stale' | 'locked' | 'missing' | 'auth' | 'io' | 'conflict' | 'busy' | 'closed' | 'rekeyed';
export class OverrideError extends Error {
  constructor(readonly code: OverrideErrorCode) { super('Private override operation refused'); this.name = 'OverrideError'; }
}
export type OverrideConflict = { key: string; choices: Choice[] };
export type OverrideState = { status: 'absent' | 'locked' | 'missing' | 'ready' | 'error' | 'closed'; seq: number; generation: number; dirty: boolean; conflicts: OverrideConflict[]; error?: OverrideErrorCode };
export type OverrideWarning = OverrideTarget & { code: 'missing-document' | 'duplicate-document' | 'missing-object' };
type OverrideOptions = Options & { expected?: boolean };
type OverrideSave = { saved: true; merged?: true } | { saved: false; conflicts: OverrideConflict[]; merged?: true };
const fail = (code: OverrideErrorCode): never => { throw new OverrideError(code); };
const pair = (target: OverrideTarget) => `${target.documentId}/${target.objectId}`;
function validTarget(raw: unknown): OverrideTarget {
  if (!isPlainRecord(raw) || Object.keys(raw).length !== 2 || typeof raw.documentId !== 'string' || typeof raw.objectId !== 'string' || !UUID.test(raw.documentId) || !UUID.test(raw.objectId)) return fail('invalid');
  return { documentId: raw.documentId, objectId: raw.objectId };
}
function nodeId(target: OverrideTarget): string {
  const hash = createHash('sha256').update(`rwdoc-override\0${pair(target)}`).digest();
  hash[6] = (hash[6]! & 15) | 128; hash[8] = (hash[8]! & 63) | 128;
  const hex = hash.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function privateDoc(raw: Doc): Doc2 {
  try {
    const doc = validateV2(raw);
    if (doc.kind !== 'overrides' || Object.keys(doc.defaults.groups).length > 0) return fail('invalid');
    const seen = new Set<string>();
    for (const node of Object.values(doc.objects)) {
      if (node.type !== 'override' || node.parentId !== null || Object.keys(node.props).some(key => key !== 'target' && key !== 'groups') || !Object.hasOwn(node.props, 'target') || !Object.hasOwn(node.props, 'groups')) return fail('invalid');
      const target = validTarget(node.props.target);
      if (seen.has(pair(target)) || node.id !== nodeId(target)) return fail('invalid');
      seen.add(pair(target)); validateGroups(node.props.groups);
    }
    return doc;
  } catch { return fail('invalid'); }
}
function pruneSecrets(doc: Doc2): void {
  const used = new Set(Object.values(doc.objects).flatMap(node => [...referencedSecretIds(node)]));
  for (const id of Object.keys(doc.secrets)) if (!used.has(id)) delete doc.secrets[id];
}
function classify(error: unknown): OverrideError {
  if (error instanceof OverrideError) return error;
  if (error instanceof DocumentError) return new OverrideError('invalid');
  if (error instanceof EnvelopeError) return new OverrideError(error.code === 'auth' ? 'auth' : 'invalid');
  if (error instanceof StoreError) {
    if (error.cause instanceof OverrideError || error.cause instanceof DocumentError) return classify(error.cause);
    return new OverrideError(['missing', 'conflict', 'busy', 'rekeyed'].includes(error.code) ? error.code as OverrideErrorCode : 'io');
  }
  return new OverrideError('io');
}

export class OverrideSession {
  #session?: DocumentSession;
  #status: OverrideState['status'];
  #error?: OverrideErrorCode;
  #seq = 0;
  #generation = 0;
  #busy = false;
  private readonly options: OverrideOptions;
  private constructor(readonly path: string, options: OverrideOptions, status: OverrideState['status']) {
    this.#status = status;
    const fs = options.fs ?? realFs;
    this.options = { ...options, fs: { ...fs, readFile: async file => {
      const bytes = await fs.readFile(file);
      if (this.#session && (file === this.path || file === this.#session.handle.path)) {
        let plaintext: Buffer | undefined;
        try { plaintext = this.#session.handle.unlocked.open(bytes); }
        catch (error) { if (!(error instanceof EnvelopeError && error.code === 'auth')) throw error; }
        if (plaintext) { try { privateDoc(parseDocument(plaintext)); } finally { plaintext.fill(0); } }
      }
      return bytes;
    } } };
  }

  /** A known-but-missing file blocks use. Only an explicit unconfigured choice permits an absent overlay. */
  static async load(path: string, options: OverrideOptions = {}): Promise<OverrideSession> {
    try { await (options.fs ?? realFs).stat(path); return new OverrideSession(path, options, 'locked'); }
    catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') { const result = new OverrideSession(path, options, 'error'); result.#error = 'io'; return result; }
      return new OverrideSession(path, options, options.expected === false ? 'absent' : 'missing');
    }
  }
  static async create(path: string, password: string, options: OverrideOptions & { id?: string } = {}): Promise<OverrideSession> {
    const doc: Doc2 = { schemaVersion: 2, id: options.id ?? randomUUID(), kind: 'overrides', name: 'Private overrides', revision: 0, objects: {}, meta: { createdAt: null, updatedAt: null, sort: [] }, defaults: { groups: {} }, secrets: {} };
    privateDoc(doc);
    const result = new OverrideSession(path, options, 'ready');
    try { result.#session = await DocumentSession.create(path, doc, password, result.options); result.#touch(); return result; }
    catch (error) { throw classify(error); }
  }
  get state(): OverrideState {
    return { status: this.#status, seq: this.#seq, generation: this.#generation, dirty: this.#session?.dirty ?? false, conflicts: (this.#session?.conflicts ?? []).map(conflict => ({ key: keyOf(conflict), choices: choicesOf(conflict) })), ...(this.#error ? { error: this.#error } : {}) };
  }
  #touch(): void { this.#seq++; this.#generation++; }
  #isClosed(): boolean { return this.#status === 'closed'; }
  #checkSeq(seq: number): void { if (!Number.isSafeInteger(seq) || seq !== this.#seq) fail('stale'); }
  #ready(): DocumentSession {
    if (this.#status !== 'ready') return fail(this.#error ?? (this.#status === 'missing' ? 'missing' : this.#status === 'closed' ? 'closed' : 'locked'));
    if (this.#session!.conflicts.length > 0) return fail('conflict');
    return this.#session!;
  }
  async unlock(password: string): Promise<void> {
    if (this.#status === 'closed') return fail('closed');
    if (this.#busy || this.#session) return fail('busy');
    this.#busy = true;
    const before = this.#generation;
    let opened: DocumentSession | undefined;
    try {
      opened = await DocumentSession.open(this.path, { password }, this.options);
      privateDoc(opened.doc);
      if (this.#generation !== before) return fail('closed');
      this.#session = opened; opened = undefined; this.#status = 'ready'; this.#error = undefined; this.#touch();
    } catch (error) {
      opened?.dispose(); const safe = classify(error);
      if (this.#generation === before) { this.#status = 'error'; this.#error = safe.code; this.#touch(); }
      throw safe;
    } finally { this.#busy = false; }
  }
  set(target: OverrideTarget, groupsPatch: GroupSettings, expectedSeq: number, secrets: Record<string, SecretRecord> = {}): void {
    this.#checkSeq(expectedSeq); const session = this.#ready(); target = validTarget(target);
    let groups: GroupSettings;
    try { groups = validateGroups(groupsPatch); if (!isPlainRecord(secrets)) fail('invalid'); } catch { return fail('invalid'); }
    const draft = structuredClone(privateDoc(session.doc));
    const found = Object.values(draft.objects).find(node => pair(validTarget(node.props.target)) === pair(target));
    const key = found?.id ?? nodeId(target);
    if (!found && Object.hasOwn(draft.objects, key)) return fail('invalid');
    const merged = { ...(found?.props.groups as GroupSettings | undefined), ...groups };
    if (Object.keys(merged).length === 0 && Object.keys(secrets).length === 0) return;
    draft.objects[key] = { id: key, name: '', type: 'override', parentId: null, order: found?.order ?? 0, props: { target, groups: merged as Json } };
    Object.assign(draft.secrets, structuredClone(secrets));
    const referenced = new Set(Object.values(draft.objects).flatMap(node => [...referencedSecretIds(node)]));
    if (Object.keys(secrets).some(secretId => !referenced.has(secretId))) return fail('invalid');
    pruneSecrets(draft); privateDoc(draft);
    if (!isDeepStrictEqual(draft, session.doc)) { session.replaceWith(draft); this.#touch(); }
  }
  /** Deleting a group restores the shared value; false is an explicit overlay value. */
  clear(target: OverrideTarget, groups: readonly Group[] | undefined, expectedSeq: number): void {
    this.#checkSeq(expectedSeq); const session = this.#ready(); target = validTarget(target);
    if (groups !== undefined && (!Array.isArray(groups) || groups.some(group => typeof group !== 'string' || !isGroup(group)) || new Set(groups).size !== groups.length)) return fail('invalid');
    const draft = structuredClone(privateDoc(session.doc));
    const found = Object.values(draft.objects).find(node => pair(validTarget(node.props.target)) === pair(target));
    if (!found) return;
    if (groups === undefined) delete draft.objects[found.id];
    else { for (const group of groups as readonly Group[]) delete (found.props.groups as GroupSettings)[group]; if (Object.keys(found.props.groups as GroupSettings).length === 0) delete draft.objects[found.id]; }
    pruneSecrets(draft); privateDoc(draft);
    if (!isDeepStrictEqual(draft, session.doc)) { session.replaceWith(draft); this.#touch(); }
  }
  layer(target: OverrideTarget): ResolutionLayer | undefined {
    target = validTarget(target);
    if (this.#status === 'absent') return undefined;
    const doc = privateDoc(this.#ready().doc);
    const found = Object.values(doc.objects).find(node => pair(validTarget(node.props.target)) === pair(target));
    return found ? { groups: structuredClone(found.props.groups) as GroupSettings, ownerDocumentId: doc.id, ownerGeneration: this.#generation } : undefined;
  }
  /** Trusted main only: this is never a renderer DTO. */
  privateDocument(): { doc: Doc2; generation: number; unlocked: true } { return { doc: structuredClone(privateDoc(this.#ready().doc)), generation: this.#generation, unlocked: true }; }
  validateTargets(documents: readonly Doc[]): OverrideWarning[] {
    const doc = privateDoc(this.#ready().doc), warnings: OverrideWarning[] = [];
    for (const node of Object.values(doc.objects)) {
      const target = validTarget(node.props.target), matches = documents.filter(document => document.id === target.documentId);
      const code = matches.length === 0 ? 'missing-document' : matches.length > 1 ? 'duplicate-document' : !Object.hasOwn(matches[0]!.objects, target.objectId) ? 'missing-object' : undefined;
      if (code) warnings.push({ ...target, code });
    }
    return warnings;
  }
  async save(expectedSeq: number): Promise<OverrideSave> {
    this.#checkSeq(expectedSeq);
    if (this.#busy) return fail('busy');
    if (!this.#session || this.#status === 'closed') return fail(this.#status === 'closed' ? 'closed' : 'locked');
    this.#busy = true; const session = this.#session;
    try {
      const result = await session.save();
      privateDoc(session.doc);
      if (!this.#isClosed()) { this.#status = 'ready'; this.#error = undefined; this.#touch(); }
      return result.saved ? result : { saved: false, conflicts: this.state.conflicts, ...(result.merged ? { merged: true } : {}) };
    } catch (error) {
      const safe = classify(error);
      if (!this.#isClosed()) { this.#status = 'error'; this.#error = safe.code; this.#touch(); }
      throw safe;
    } finally { this.#busy = false; }
  }
  resolve(key: string, choice: Choice, expectedSeq: number): void {
    this.#checkSeq(expectedSeq);
    if (this.#status !== 'ready' || !this.#session) return fail('locked');
    const conflict = this.#session.conflicts.find(conflict => keyOf(conflict) === key);
    if (!conflict || !choicesOf(conflict).includes(choice)) return fail('invalid');
    this.#session.resolve(conflict, choice); privateDoc(this.#session.doc); this.#touch();
  }
  /** Explicit discard/reload decision; never an automatic fallback after a failed save. */
  async reload(expectedSeq: number): Promise<void> {
    this.#checkSeq(expectedSeq);
    if (this.#busy) return fail('busy');
    if (!this.#session || this.#status === 'closed') return fail('locked');
    this.#busy = true; const session = this.#session;
    try { await session.reload(); privateDoc(session.doc); if (!this.#isClosed()) { this.#status = 'ready'; this.#error = undefined; this.#touch(); } }
    catch (error) { const safe = classify(error); if (!this.#isClosed()) { this.#status = 'error'; this.#error = safe.code; this.#touch(); } throw safe; }
    finally { this.#busy = false; }
  }
  close(): void { this.#session?.dispose(); this.#session = undefined; this.#status = 'closed'; this.#error = undefined; this.#touch(); }
}
