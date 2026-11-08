// The documents the app has open. Each one is a DocumentSession plus the path it came from. The rest of the app (IPC, UI) talks to this
// class with plain data and typed errors, and never touches a session, a key or a file name of its own.
//
// What the window is told about a document is a Snapshot (the document as it is) once, when it opens or when the window asks again, and after that
// a Delta per change: only the objects that are new or different and the ids that are gone, so an edit costs the size of the edit and not of the
// document. Every Delta carries `seq`, which counts the changes of that document; a window that sees a seq it did not expect asks for a Snapshot.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ConflictError, describe, sideItems, type Choice, type ConflictView } from './conflicts.js';
import { EnvelopeError, MAX_PASSWORD_BYTES } from './envelope.js';
import type { KeyCache } from './keywrap.js';
import { DocumentError, LIMITS, parseDocument, validateDocument, type Doc, type Doc2, type SecretRecord, type Json, type ObjectNode, type ObjectType } from './model.js';
import { projectNodes } from './projection.js';
import {referencedSecretIds} from './references.js';
import { isGroup, GROUP_REGISTRY, validateGroups, validateInheritance, type Group } from './groups.js';
import { credentialView, type CredentialView } from '../credentials/model.js';
import { compareSiblings } from './order.js';
import { sortOf } from './meta.js';
import { OpError, applyOp, type Applied, type Change, type Env, type Op, type Patch } from './ops.js';
import { compare, restoreAll, restoreObjects } from './restore.js';
import { DocumentSession, UpgradeRequiredError } from './session.js';
import { StoreError, listRevisions, openRevisionWithKey, realFs, revisionTime, withDocumentLocks, type StoreLockLease, type Options, type StoreWarning, StoreCommitUncertainError } from './store.js';
import { duplicateDocumentChoice, type PreparedTransfer } from './transfer.js';
import { applyBatch, type BulkAction } from './bulk.js';

// Only retire previously referenced records; preserve unknown legacy data and secrets still used by another object or a default.
function retireSecrets(before:Doc,after:Doc,conflicts:readonly unknown[]):Doc {
  if(before.schemaVersion!==2||after.schemaVersion!==2)return after;
  const refs=(doc:Doc2)=>new Set([...Object.values(doc.objects).flatMap(referencedSecretIds),...Object.values(doc.defaults.groups).flatMap(value=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.secretId==='string'?[value.secretId]:[])]);
  const used=refs(after),retired=[...refs(before)].filter(id=>!used.has(id)&&Object.hasOwn(after.secrets,id));
  if(!retired.length)return after;
  const held=JSON.stringify(conflicts);if(retired.some(id=>held.includes(id)))throw new LibraryError('invalid','Resolve conflicts before removing private values');
  const secrets={...after.secrets};for(const id of retired)delete secrets[id];return {...after,secrets};
}

/** The document itself, for the code that owns it: no objects, no key, no session. */
export type DocSummary = { id: string; docId: string; name: string; path: string; revision: number; dirty: boolean; conflicts: number; seq: number; kind?: 'vault'; upgradeRequired?: true;meta?:Doc2['meta'];requiresReopen?:true;warnings?:readonly StoreWarning[] };
/** What the window is told about the document itself. Built field by field, so a field added to DocSummary later (the path, say) does not leak by itself. */
export type DocState = Omit<DocSummary, 'path'|'warnings'>;
/** The document as the window may see it: only the kinds of object it shows (a credential, say, stays in the main process). */
export type Snapshot = DocState & { objects: ObjectNode[] };
/**
 * One change, in the state it leaves: `upsert` objects replace or join, `remove` ids go. `reset`: `upsert` is every object there is, and the window starts from it.
 * `from` is the seq the document was at before the change and `seq` the one it is at after: they differ by one, and are the same for a change that leaves nothing
 * different. A window takes a change in only when `from` is the seq it is at; anything else means a change never reached it.
 */
export type Delta = DocState & { from: number; upsert: ObjectNode[]; remove: string[]; reset?: true };
const shown = (o: ObjectNode): boolean => o.type === 'folder' || o.type === 'connection';
const stateOf = (summary: DocSummary): DocState => ({ id: summary.id, docId: summary.docId, name: summary.name, revision: summary.revision, dirty: summary.dirty, conflicts: summary.conflicts, seq: summary.seq, ...(summary.upgradeRequired ? { upgradeRequired: true } : {}), ...(summary.kind ? {kind:summary.kind} : {}),...(summary.meta?{meta:structuredClone(summary.meta)}:{}),...(summary.requiresReopen?{requiresReopen:true as const}:{}) });

export type LibraryErrorCode =
  | 'wrong-password' | 'unreadable' | 'too-new' | 'not-found' | 'exists' | 'busy' | 'rekeyed' | 'already-open'
  | 'unknown-document' | 'unknown-object' | 'unknown-conflict' | 'revision-key' | 'unsaved' | 'invalid' | 'cycle' | 'too-deep' | 'too-many' | 'too-large' | 'io' | 'upgrade-required' | 'reopen-required' | 'duplicate-document';
export class LibraryError extends Error {
  constructor(readonly code: LibraryErrorCode, message: string, readonly cause?: unknown) { super(message); this.name = 'LibraryError'; }
}
export type DuplicateStamp={docId:string;digest:string};
export class DuplicateDocumentError extends LibraryError{
  constructor(readonly duplicateStamp:DuplicateStamp){super('duplicate-document','That document is already open from another file');}
}

/** What a listener is told: the document changed (or was saved, or its held-back conflicts were decided: `dirty` and `conflicts` are how it is now), or was closed. */
export type ChangeEvent = { id: string; dirty: boolean; conflicts: number; closed?: true;opened?:true };
export const MAX_CONFLICT_VIEWS = 200; // the conflicts the window is told of: a person decides these one by one, and "mine for everything" and "theirs for everything" are for the rest
/** One earlier version of the document: its file name in the revisions that are kept, and when it was taken (milliseconds since 1970). */
export type RevisionInfo = { name: string; at: number };
/** An earlier version as the window may see it (only the kinds of object it shows), and how it differs from the document now: the ids it has that the document does not, the ids that are different, and how many objects of the document are new. */
export type RevisionView = RevisionInfo & { docName: string; objects: ObjectNode[]; gone: string[]; changed: string[]; added: number };

export type Where = 'read' | 'edit' | 'write'; // what was being done: the same DocumentError means a damaged file when reading and a refused edit when editing
export function translate(error: unknown, where: Where): LibraryError { // exported for its tests: a document of 64 MiB is not something a test builds
  if (error instanceof UpgradeRequiredError) return new LibraryError('upgrade-required', error.message);
  if (error instanceof LibraryError) return error;
  if (error instanceof EnvelopeError) {
    if (where === 'write' && error.code === 'bad-length') return new LibraryError('too-large', 'The document is too large to be saved', error);
    if (error.code === 'auth' || error.code === 'bad-password') return new LibraryError('wrong-password', 'Wrong password, or the file was changed', error);
    if (error.code === 'unsupported-version') return new LibraryError('too-new', 'The file was written by a newer version of the app', error);
    return new LibraryError('unreadable', 'This is not a readable document', error);
  }
  if (error instanceof OpError) return new LibraryError(error.code === 'unknown-object' ? 'unknown-object' : 'invalid', error.message, error);
  if (error instanceof ConflictError) return new LibraryError(error.code === 'unknown-conflict' ? 'unknown-conflict' : 'invalid', error.message, error);
  if (error instanceof DocumentError) {
    if (where === 'read') return new LibraryError(error.code === 'unsupported-schema' ? 'too-new' : 'unreadable', error.message, error);
    if (where === 'write' && error.code === 'unsupported-schema') return new LibraryError('too-new', error.message, error); // what this app writes is always its own schema, so this is the other writer's file
    const refused = { cycle: 'cycle', 'too-deep': 'too-deep', 'too-many-objects': 'too-many' }[error.code as string] as LibraryErrorCode | undefined;
    return new LibraryError(refused ?? 'invalid', error.message, error);
  }
  if (error instanceof StoreError) {
    const code = { missing: 'not-found', exists: 'exists', busy: 'busy', conflict: 'busy', rekeyed: 'rekeyed', 'bad-revision': 'invalid', damaged: 'unreadable' }[error.code as string] as LibraryErrorCode | undefined;
    return new LibraryError(code ?? 'io', error.message, error);
  }
  return new LibraryError('io', error instanceof Error ? error.message : String(error), error);
}

const invalid = (message: string) => new LibraryError('invalid', message);
const own = (objects: Record<string, ObjectNode>, id: string): ObjectNode | undefined => (Object.hasOwn(objects, id) ? objects[id] : undefined);
export const checkName = (name: unknown): string => {
  if (typeof name !== 'string' || name.trim() === '' || name.length > LIMITS.maxName) throw invalid('The name must have 1 to 256 characters');
  return name;
};
const checkPassword = (password: unknown): string => {
  if (typeof password !== 'string' || password === '' || Buffer.byteLength(password.normalize('NFC'), 'utf8') > MAX_PASSWORD_BYTES) throw invalid('The password must have 1 to 1024 bytes');
  return password;
};

// The same file has many spellings (a link, another case on a volume that ignores case, /tmp for /private/tmp): the operating system's
// canonical name is what two spellings are compared by. A file that is not there yet is named by its folder's canonical name.
function canonical(path: string): string {
  const file = resolve(path);
  try { return realpathSync.native(file); } catch { /* not there yet */ }
  try { return join(realpathSync.native(dirname(file)), basename(file)); } catch { return file; }
}

// Saving replaces the file at the path it is given, so a link that was opened as itself would be replaced by a copy and the real file left behind: the link is followed.
function target(path: string): string {
  const file = resolve(path);
  try { return lstatSync(file).isSymbolicLink() ? realpathSync.native(file) : file; } catch { return file; } // not there: open() will say so
}

/** The name of a copy: "<name> salinan", then "<name> salinan 2", 3 ... the first that no sibling already has, and never longer than a name may be. */
function copyName(siblings: ObjectNode[], name: string): string {
  const taken = new Set(siblings.map((s) => s.name));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' salinan' : ` salinan ${n}`;
    const candidate = `${name.slice(0, LIMITS.maxName - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

type Entry = { session: DocumentSession; path: string; canonical: string; queue: Promise<unknown>; saving: number; pendingIO:number;requiresReopen?:true;closeRequested?:true;seq: number; generation: number; last: string; told: number }; // told: the merges of the session that the window has been told about
/** `report`: where a failure is told that nobody else would hear of (a listener that threw): the edit that it followed has gone through all the same. */
export type LibraryOptions = Options & { newId?: () => string; report?: (error: unknown) => void };
export type SaveOutcome = { saved: boolean; conflicts: number; delta: Delta;warnings?:StoreWarning[];writeReceipt?:EntryStamp };
export type EntryStamp={handle:string;seq:number;generation:number;digest:string;path:string;requiresReopen?:true};
export type TransferResult={destination:'unchanged'|'memory'|'saved'|'verified'|'uncertain';sourceDisk:'retained'|'removed-saved'|'uncertain';sourceMemory:'unchanged'|'removal-pending'|'removed';stage:'prepared'|'destination-write'|'destination-readback'|'move-cancelled'|'source-check'|'source-write'|'complete'|'cancelled'|'destination-uncertain'|'source-uncertain';errorCode?:'invalid'|'stale'|'busy'|'io'|'reopen-required'|'cancelled'|'scope-denied';warnings: (StoreWarning|'reopen-required')[];cancelled?:true};

export class DocumentLibrary {
  #generation = 0;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(event: ChangeEvent) => void>();
  constructor(private readonly options: LibraryOptions = {}) {}

  /** Tells `listener` of every change of every document from now on, until the function that is returned is called. A listener that fails is not a reason for an edit to fail: it is reported. */
  onChange(listener: (event: ChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #emit(event: ChangeEvent): void {
    for (const listener of [...this.#listeners]) {
      try { listener(event); } catch (error) {
        try { this.options.report?.(error); } catch { /* the edit was made; there is nobody left to tell */ }
      }
    }
  }

  #newId(): string { return (this.options.newId ?? randomUUID)(); }
  #leased=new Set<Entry>();
  #mutable(entry:Entry):void {
    if(entry.requiresReopen)throw Object.assign(new LibraryError('reopen-required','Tutup dan buka ulang dokumen.'),{requiresReopen:true});
    if(this.#leased.has(entry)||entry.closeRequested)throw new LibraryError('busy','Document operation in progress');
  }
  entryStamp(id:string){const e=this.#entry(id);return{handle:id,seq:e.seq,generation:e.generation,digest:e.session.handle.digest,path:canonical(e.session.handle.path),...(e.requiresReopen?{requiresReopen:true as const}:{})};}
  writing(id:string):boolean{const e=this.#entry(id);return e.saving>0||e.pendingIO>0||this.#leased.has(e);}
  #finishClose(id:string,entry:Entry):void{if(this.#entries.get(id)!==entry)return;entry.session.dispose();this.#entries.delete(id);this.#emit({id,dirty:false,conflicts:0,closed:true});}
  async #withEntries<T>(expected:readonly {handle:string;seq:number;generation:number;digest:string}[],work:(entries:readonly Entry[])=>Promise<T>):Promise<T>{
    if(new Set(expected.map(s=>s.handle)).size!==expected.length)throw invalid('Duplicate document lease');
    const ordered=[...expected].sort((a,b)=>a.handle.localeCompare(b.handle)),entries=ordered.map(s=>{const e=this.#entry(s.handle);this.#mutable(e);if(e.pendingIO||e.saving)throw new LibraryError('busy','Document operation pending');if(e.seq!==s.seq||e.generation!==s.generation||e.session.handle.digest!==s.digest)throw invalid('The reviewed document changed');return e;});
    entries.forEach(e=>this.#leased.add(e));
    try{return await work(expected.map(stamp=>entries[ordered.findIndex(s=>s.handle===stamp.handle)]!));}
    finally{for(let i=0;i<entries.length;i++){const e=entries[i]!;this.#leased.delete(e);if(e.closeRequested)this.#finishClose(ordered[i]!.handle,e);}}
  }
  #uncertain(id:string,e:Entry,error:unknown):never {
    if(error instanceof StoreCommitUncertainError){e.requiresReopen=true;this.#publish(id,e,[],[],false,true);throw Object.assign(new LibraryError('reopen-required','Status penulisan tidak pasti; tutup dan buka ulang dokumen.',error),{requiresReopen:true});}
    throw translate(error,'write');
  }
  async changePassword(input:{id:string;expectedSeq:number;expectedGeneration:number;oldPassword:string;newPassword:string}):Promise<{warnings:StoreWarning[]}>{
    const stamp=this.entryStamp(input.id);if(stamp.seq!==input.expectedSeq||stamp.generation!==input.expectedGeneration)throw invalid('The reviewed document changed');
    return this.#withEntries([stamp],async([entry])=>{try{const warnings=await entry!.session.changePassword(input.oldPassword,input.newPassword);this.#publish(input.id,entry!,[],[],false,true);return{warnings};}catch(error){return this.#uncertain(input.id,entry!,error);}});
  }
  /** Copy is committed first. Deletion needs fresh entry receipts and both filesystem locks. */
  async transfer(input:{source:EntryStamp;destination:EntryStamp;prepared:PreparedTransfer;mode:'copy'|'move';confirmMove?:()=>Promise<boolean>;cancelled?:()=>boolean;scopeValid?:()=>boolean}):Promise<TransferResult>{
    const result:TransferResult={destination:'unchanged',sourceDisk:'retained',sourceMemory:'unchanged',stage:'prepared',warnings:[]};
    const sourceId=input.source.handle,destinationId=input.destination.handle;
    if(sourceId===destinationId||!['copy','move'].includes(input.mode))throw invalid('Invalid transfer');
    const check=()=>{if(input.cancelled?.())throw Object.assign(invalid('Cancelled'),{code:'cancelled'});if(input.scopeValid&&!input.scopeValid())throw Object.assign(invalid('Scope changed'),{code:'scope-denied'});};
    const clean=(e:Entry)=>{if(e.session.sourceSchema!==2||e.session.doc.schemaVersion!==2)throw new UpgradeRequiredError();if(e.session.dirty||e.session.conflicts.length)throw new LibraryError('unsaved','Save both documents first');};
    const verify=async(e:Entry)=>{const file=await(this.options.fs??realFs).readFile(canonical(e.session.handle.path));if(createHash('sha256').update(file).digest('hex')!==e.session.handle.digest)throw invalid('Document head changed');const plain=e.session.handle.unlocked.open(file);try{if(!isDeepStrictEqual(parseDocument(plain),e.session.doc))throw invalid('Document readback differs');}finally{plain.fill(0);}};
    const fail=(e:unknown)=>{const code=(e as {code?:unknown})?.code;result.errorCode=code==='cancelled'||code==='scope-denied'||code==='busy'?code:code==='invalid'||code==='conflict'?'stale':'io';if(code==='cancelled')result.cancelled=true;return result;};
    const uncertain=(id:string,e:Entry,which:'destination'|'source')=>{e.requiresReopen=true;this.#publish(id,e,[],[],false,true);result[which==='destination'?'destination':'sourceDisk']='uncertain';result.stage=which==='destination'?'destination-uncertain':'source-uncertain';result.errorCode='reopen-required';result.warnings.push('reopen-required');};
    let destinationReceipt:EntryStamp;
    // Everything that can refuse before the first edit remains an ordinary rejection.
    await this.#withEntries([input.source,input.destination],async([s,d])=>{
      const source=s!,destination=d!;clean(source);clean(destination);check();
      const before=destination.session.doc,prepared=input.prepared.document;
      validateDocument(prepared);
      if(prepared.id!==before.id||prepared.kind!==before.kind||prepared.revision!==before.revision||!isDeepStrictEqual({...prepared,objects:before.objects,secrets:before.schemaVersion===2?before.secrets:{}},before)||Object.entries(before.objects).some(([id,node])=>!isDeepStrictEqual(prepared.objects[id],node))||before.schemaVersion!==2||Object.entries(before.secrets).some(([id,secret])=>!isDeepStrictEqual(prepared.secrets[id],secret)))throw invalid('Transfer replaces existing destination data');
      const ids=input.prepared.selectedIds;if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!Object.hasOwn(source.session.doc.objects,id)))throw invalid('Invalid source selection');
      if(input.mode==='move'){const objects={...source.session.doc.objects};for(const id of ids)delete objects[id];validateDocument(retireSecrets(source.session.doc,{...source.session.doc,objects},[]));}
      destination.session.update(draft=>Object.assign(draft,structuredClone(prepared)));
      const staged=destination.session.doc;result.destination='memory';result.stage='destination-write';this.#publish(destinationId,destination,[],[],true,true);
      try{const saved=await destination.session.save({strict:true});if(!saved.saved)throw invalid('Destination conflicts');result.warnings.push(...(saved.warnings??[]));result.destination='saved';this.#publish(destinationId,destination,[],[]);result.stage='destination-readback';await verify(destination);result.destination='verified';destinationReceipt=this.entryStamp(destinationId);}
      catch(error){if(error instanceof StoreCommitUncertainError)uncertain(destinationId,destination,'destination');else{if(result.destination==='memory'&&destination.session.rollbackWorkingCopy(staged,before)){result.destination='unchanged';this.#publish(destinationId,destination,[],[],true,true);}fail(error);}}
    });
    if(result.destination!=='verified')return result;
    if(input.mode==='copy'){result.stage='complete';return result;}
    try{check();if(!input.confirmMove||!await input.confirmMove()){result.stage='move-cancelled';result.cancelled=true;return result;}check();}
    catch(error){result.stage='source-check';return fail(error);}
    result.stage='source-check';let held:readonly StoreLockLease[]=[];
    try{await this.#withEntries([input.source,destinationReceipt!],async([s,d])=>{
      const source=s!,destination=d!;clean(source);clean(destination);check();
      await withDocumentLocks([input.source.path,destinationReceipt!.path],this.options,async leases=>{
        held=[...leases.values()];check();await verify(destination);check();
        const bytes=await(this.options.fs??realFs).readFile(input.source.path);if(createHash('sha256').update(bytes).digest('hex')!==input.source.digest)throw invalid('Source changed');check();
        const before=source.session.doc,objects={...before.objects};for(const id of input.prepared.selectedIds)delete objects[id];const next=retireSecrets(before,{...before,objects},[]);validateDocument(next);
        source.session.update(draft=>Object.assign(draft,next));const staged=source.session.doc;
        result.sourceMemory='removal-pending';result.stage='source-write';this.#publish(sourceId,source,[],[],true,true);
        try{const saved=await source.session.save({strict:true,lease:leases.get(input.source.path)!});if(!saved.saved)throw invalid('Source conflicts');result.warnings.push(...(saved.warnings??[]));result.sourceDisk='removed-saved';result.sourceMemory='removed';result.stage='complete';this.#publish(sourceId,source,[],[]);}
        catch(error){if(error instanceof StoreCommitUncertainError)uncertain(sourceId,source,'source');else{if(source.session.rollbackWorkingCopy(staged,before)){result.sourceMemory='unchanged';this.#publish(sourceId,source,[],[],true,true);}fail(error);}}
      });
    });}catch(error){fail(error);}finally{result.warnings.push(...held.flatMap(lease=>lease.warnings));}
    return result;
  }
  #entry(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new LibraryError('unknown-document', 'That document is not open');
    return entry;
  }
  #summary(id: string, entry: Entry): DocSummary {
    const doc = entry.session.doc;
    return { id, docId: doc.id, name: doc.name, path: entry.path, revision: doc.revision, dirty: entry.session.dirty, conflicts: entry.session.conflicts.length, seq: entry.seq, ...(entry.session.needsUpgrade ? { upgradeRequired: true as const } : {}), ...(doc.kind==='vault'?{kind:'vault' as const}:{}),...(doc.schemaVersion===2?{meta:{createdAt:doc.meta.createdAt,updatedAt:doc.meta.updatedAt,sort:structuredClone(doc.meta.sort)}}:{}),...(entry.requiresReopen?{requiresReopen:true as const}:{}) };
  }
  #fingerprint(entry: Entry): string { const doc = entry.session.doc; return JSON.stringify([doc.name, doc.revision, entry.session.dirty, entry.session.conflicts.length,entry.requiresReopen??false,...(doc.schemaVersion===2?[doc.meta,doc.defaults.groups]:[])]); }
  /**
   * The Delta for what just happened: `seq` moves on only when something the window can see is different, so asking for nothing is answered with nothing.
   * A document that has taken another writer's version of the file in since the window last heard of it differs from the window's picture by more than this
   * change: whatever the change is, the Delta then starts the window again (`reset`) from everything there is, so that nothing after the merge, an edit made
   * while the merged version is still being written included, is taken in on top of a picture that does not have it.
   */
  #publish(id: string, entry: Entry, upsert: ObjectNode[], remove: string[], reset = false, privateChange = false, capture?: (stamp:EntryStamp)=>void): Delta {
    const from = entry.seq;
    const merged = entry.session.merges !== entry.told || reset; // `reset`: a change of many objects at once (a decision, a restore of the whole document) that is told as everything there is
    entry.told = entry.session.merges;
    if (merged) { upsert = Object.values(entry.session.doc.objects).filter(shown); remove = []; }
    upsert = projectNodes(upsert);
    const now = this.#fingerprint(entry);
    const changed = upsert.length > 0 || remove.length > 0 || merged || now !== entry.last;
    if (changed || privateChange) entry.generation = ++this.#generation;
    if (changed) { entry.seq++; entry.last = now; }
    const delta: Delta = { ...stateOf(this.#summary(id, entry)), from, upsert, remove, ...(merged ? { reset: true as const } : {}) };
    capture?.(this.entryStamp(id));
    if (changed) this.#emit({ id, dirty: delta.dirty, conflicts: delta.conflicts });
    return delta;
  }
  #register(session: DocumentSession, path: string): DocSummary {
    if(session.doc.kind==='overrides'){session.dispose();throw invalid('Private override files require their own unlock scope');}
    const id = this.#newId();
    if(this.#entries.has(id)){session.dispose();throw invalid('Document handle collision');}
    const entry: Entry = { session, path, canonical: canonical(path), queue: Promise.resolve(), saving: 0,pendingIO:0, seq: 0, generation: ++this.#generation, last: '', told: session.merges };
    entry.last = this.#fingerprint(entry);
    this.#entries.set(id, entry);
    this.#emit({id,dirty:session.dirty,conflicts:session.conflicts.length,opened:true});
    const warnings=session.creationWarnings;
    return {...this.#summary(id,entry),...(warnings.length?{warnings}:{})};
  }
  /** Runs one operation on a document: refusals are LibraryErrors, and what changed is the Delta (hidden kinds of object never appear in it). */
  #apply(id: string, op: Op): { applied: Applied; delta: Delta } { return this.#run(id, (doc, env) => applyOp(doc, op, env)); }
  #run(id: string, make: (doc: Doc, env: Env) => Applied): { applied: Applied; delta: Delta } {
    const entry = this.#entry(id);
    this.#mutable(entry);
    const before = entry.session.doc;
    const env: Env = { newId: () => this.#newId() };
    let applied: Applied;
    try { applied = entry.session.change((doc) => {const made=make(doc,env);return {...made,doc:retireSecrets(doc,made.doc,entry.session.conflicts)};}); } catch (error) { throw translate(error, 'edit'); }
    const change: Change = applied.change;
    const known = (gone: string): boolean => { const o = own(before.objects, gone); return o !== undefined && shown(o); };
    return { applied, delta: this.#publish(id, entry, change.upsert.filter(shown), change.remove.filter(known), false, applied.doc !== before) };
  }
  /** One at a time per document: what runs here waits for the save or the reload that is under way. */
  #queued<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
    entry.pendingIO++;
    const next=entry.queue.then(run,run).finally(()=>{entry.pendingIO--;if(entry.pendingIO===0&&entry.closeRequested&&!this.#leased.has(entry)){const id=[...this.#entries].find(([,e])=>e===entry)?.[0];if(id)this.#finishClose(id,entry);}});
    entry.queue=next.catch(()=>undefined);return next;
  }

  /**
   * A position as the window means it (a place among the siblings it sees, the object that moves left out) as the place among all the siblings, the kinds
   * of object that are never shown included. A position past what is seen is refused: it would be a way to count what is hidden.
   */
  #position(id: string, parentId: string | null, index: number | undefined, except?: string): number | undefined {
    if (index === undefined) return undefined;
    const folder = parentId === null ? undefined : own(this.#entry(id).session.doc.objects, parentId);
    if (folder && sortOf(folder.props).length > 0) return undefined; // a sorted folder puts its children where the sort puts them: a position means nothing there
    const all = Object.values(this.#entry(id).session.doc.objects).filter((o) => o.parentId === parentId && o.id !== except).sort(compareSiblings);
    const seen = all.filter(shown);
    if (!Number.isInteger(index) || index < 0 || index > seen.length) throw invalid('The position is outside the folder');
    return index < seen.length ? all.indexOf(seen[index]!) : all.length;
  }

  async create(path: string, name: string, password: string, kind: 'workspace' | 'vault' = 'workspace'): Promise<DocSummary> {
    checkName(name);
    checkPassword(password);
    const file = resolve(path);
    if (this.isOpen(file)) throw new LibraryError('already-open', 'That file is already open');
    const createdAt=new Date((this.options.now??Date.now)()).toISOString();
    const doc: Doc2 = { schemaVersion: 2, id: this.#newId(), kind, name, revision: 0, objects: {}, meta: { createdAt, updatedAt:createdAt, sort: [] }, defaults: { groups: {} }, secrets: {} };
    try { return this.#register(await DocumentSession.create(file, doc, password, this.options), file); } catch (error) { throw translate(error, 'read'); }
  }

  createVault(path: string, name: string, password: string): Promise<DocSummary> { return this.create(path,name,password,'vault'); }
  /** Privileged main-process API; never exposed on a renderer IPC channel. */
  privateDocument(id: string): { doc: Doc; generation: number; seq: number } {
    const entry=this.#entry(id);if(entry.requiresReopen)throw Object.assign(new LibraryError('reopen-required','Tutup dan buka ulang dokumen.'),{requiresReopen:true});return {doc:entry.session.doc,generation:entry.generation,seq:entry.seq};
  }
  privateDocuments(): { handle: string; doc: Doc; generation: number; seq: number }[] { return [...this.#entries.keys()].filter(handle=>!this.#entry(handle).requiresReopen).map(handle=>({handle,...this.privateDocument(handle)})); }
  credentialViews(id: string): CredentialView[] {
    const doc=this.#entry(id).session.doc;
    if(doc.kind==='overrides') return [];
    return Object.values(doc.objects).filter(n=>n.type==='credential').map(n=>credentialView(doc,n));
  }
  writeCredential(id: string, input: { objectId?: string; name: string; parentId?: string | null; record: SecretRecord }): { objectId: string; delta: Delta } {
    const entry=this.#entry(id);this.#mutable(entry);const doc=entry.session.doc;
    if(doc.schemaVersion!==2||doc.kind==='overrides'||input.record.kind!=='credential') throw invalid('Credential source is invalid');
    const previous=input.objectId?own(doc.objects,input.objectId):undefined;
    if(input.objectId&&previous?.type!=='credential')throw new LibraryError('unknown-object','That credential is not open');
    const objectId=previous?.id??this.#newId();const secretId=typeof previous?.props.secretId==='string'?previous.props.secretId:this.#newId();
    const parentId=previous?previous.parentId:input.parentId??null;
    entry.session.update(d=>{
      if(d.schemaVersion!==2)throw invalid('Credential source is invalid');
      d.secrets[secretId]=structuredClone(input.record);
      d.objects[objectId]={id:objectId,type:'credential',name:checkName(input.name),parentId,order:previous?.order??Object.values(d.objects).filter(n=>n.parentId===parentId).length,props:{...previous?.props,secretId}};
    });
    return {objectId,delta:this.#publish(id,entry,[],[],false,true)};
  }
  removeCredential(id: string, objectId: string): Delta {
    if(this.node(id,objectId)?.type!=='credential')throw new LibraryError('unknown-object','That credential is not open');
    return this.remove(id,objectId);
  }
  /** Trusted main-process operation: the validated draft is published only after every field succeeds. */
  changePrivate(id: string, expectedSeq: number, change: (doc: Doc2) => void): Delta {
    const entry=this.#entry(id);this.#mutable(entry);if(entry.seq!==expectedSeq)throw invalid('The reviewed document changed');
    const before=entry.session.doc;
    try {entry.session.update(doc=>{
      if(doc.schemaVersion!==2)throw invalid('Document upgrade required');
      change(doc);
      if(doc.id!==before.id||doc.kind!==before.kind||doc.revision!==before.revision)throw invalid('Document identity cannot change');
      doc.secrets=(retireSecrets(before,doc,entry.session.conflicts) as Doc2).secrets;
    });} catch(error){throw translate(error,'edit');}
    const after=entry.session.doc;
    const upsert=Object.values(after.objects).filter(n=>shown(n)&&JSON.stringify(n)!==JSON.stringify(before.objects[n.id]));
    const remove=Object.values(before.objects).filter(n=>shown(n)&&!Object.hasOwn(after.objects,n.id)).map(n=>n.id);
    return this.#publish(id,entry,upsert,remove,false,JSON.stringify(before)!==JSON.stringify(after));
  }
  writeDefaultGroup(id:string,expectedSeq:number,input:{group:Group;value?:Json;secret?:SecretRecord}):Delta {
    if(!isGroup(input.group))throw invalid('Invalid default group');
    return this.changePrivate(id,expectedSeq,doc=>{
      const groups={...doc.defaults.groups};delete groups[input.group];
      if(input.secret!==undefined){
        if(input.group==='credentials'?input.secret.kind!=='credential'||JSON.stringify(input.value)!=='{"mode":"inline"}':GROUP_REGISTRY[input.group].privacy!=='private'||input.secret.kind!=='protected-value'||input.value!==undefined)throw invalid('Invalid private default');
        const secretId=this.#newId();if(Object.hasOwn(doc.secrets,secretId))throw invalid('Duplicate secret identity');doc.secrets[secretId]=structuredClone(input.secret);
        groups[input.group]=input.group==='credentials'?{mode:'inline',secretId}:{secretId};
      }else if(input.value!==undefined)groups[input.group]=structuredClone(input.value);
      doc.defaults.groups=validateGroups(groups);
    });
  }
  writeGroup(id: string, input: {objectId:string;group:Group;inherit:boolean;value?:Json;secret?:SecretRecord}): Delta {
    if(!isGroup(input.group)||typeof input.inherit!=='boolean')throw invalid('Invalid group');
    return this.changePrivate(id,this.view(id).seq,doc=>{
      const node=Object.hasOwn(doc.objects,input.objectId)?doc.objects[input.objectId]:undefined;
      if(!node||!shown(node))throw new LibraryError('unknown-object','That object is not open');
      const groups={...validateGroups(node.props.groups??{})};const inherit={...validateInheritance(node.props.inherit??{},groups)};
      delete groups[input.group];inherit[input.group]=input.inherit;
      if(input.inherit){if(input.secret!==undefined||input.value!==undefined)throw invalid('Inherited fields cannot have local values');if(input.group==='credentials')groups.credentials={mode:'parent'};}
      else if(input.secret!==undefined){
        if(input.group==='credentials'?input.secret.kind!=='credential'||JSON.stringify(input.value)!=='{"mode":"inline"}':GROUP_REGISTRY[input.group].privacy!=='private'||input.secret.kind!=='protected-value')throw invalid('Invalid private group value');
        const secretId=this.#newId();if(Object.hasOwn(doc.secrets,secretId))throw invalid('Duplicate secret identity');
        doc.secrets[secretId]=structuredClone(input.secret);
        groups[input.group]=input.group==='credentials'?{mode:'inline',secretId}:{secretId};
      } else if(input.value!==undefined)groups[input.group]=structuredClone(input.value);
      node.props.groups=validateGroups(groups) as Record<string,Json>;node.props.inherit=validateInheritance(inherit,groups) as Record<string,Json>;
    });
  }
  upgradeRequest(id: string): { digest: string; seq: number } | undefined { const e=this.#entry(id);return e.session.needsUpgrade?{digest:e.session.handle.digest,seq:e.seq}:undefined; }
  approveUpgrade(id: string, request: { digest: string; seq: number }): void {
    const e=this.#entry(id);if(e.seq!==request.seq)throw new LibraryError('upgrade-required','The reviewed document changed');e.session.approveUpgrade(request.digest);
  }

  async open(path: string, password: string): Promise<DocSummary> {
    const file = target(path);
    if (this.isOpen(file)) throw new LibraryError('already-open', 'That file is already open');
    let session: DocumentSession;
    try { session = await DocumentSession.open(file, { password }, this.options); } catch (error) { throw translate(error, 'read'); }
    // Registered in the same turn of the event loop as this check, so two opens of one document cannot both get in.
    if ([...this.#entries.values()].some((e) => e.session.doc.id === session.doc.id)) { const stamp={docId:session.doc.id,digest:session.handle.digest};session.dispose(); throw new DuplicateDocumentError(stamp); }
    return this.#register(session, file);
  }

  async openAsCopy(sourcePath:string,oldPassword:string,destinationPath:string,newPassword:string,expected?:DuplicateStamp):Promise<DocSummary>{
    const sourceFile=target(sourcePath),destinationFile=resolve(destinationPath);await this.assertNew(destinationFile);checkPassword(newPassword);
    let source:DocumentSession;try{source=await DocumentSession.open(sourceFile,{password:oldPassword},this.options);}catch(error){throw translate(error,'read');}
    try{
      if(source.sourceSchema!==2||source.doc.schemaVersion!==2)throw new UpgradeRequiredError();
      if(expected&&(source.doc.id!==expected.docId||source.handle.digest!==expected.digest))throw invalid('Duplicate source changed');
      if(![...this.#entries.values()].some(e=>e.session.doc.id===source.doc.id))throw invalid('Duplicate source changed');
      const doc=duplicateDocumentChoice(source.doc,'copy',()=>this.#newId()).document!;
      if([...this.#entries.values()].some(e=>e.session.doc.id===doc.id))throw invalid('Document identity collision');
      return this.#register(await DocumentSession.create(destinationFile,doc,newPassword,this.options),destinationFile);
    }catch(error){throw translate(error,'write');}finally{source.dispose();}
  }

  /**
   * Opens a document with the key that the keystore remembers for its file: nothing when there is none that works (none kept, stale after a change of password, or not of this file), and then the caller asks
   * for the password. A file that is not there, or is not a document, is an error of its own and not "no key".
   */
  async openRemembered(path: string, cache: KeyCache): Promise<DocSummary | undefined> {
    const file = target(path);
    if (this.isOpen(file)) throw new LibraryError('already-open', 'That file is already open');
    let session: DocumentSession;
    try { session = await DocumentSession.open(file, { cache }, this.options); } catch (error) {
      if (error instanceof StoreError && error.code === 'missing') return undefined;      // no usable cached key, and no password to fall back on
      if ((error as { code?: unknown }).code === 'ENOENT') throw new LibraryError('not-found', 'The file does not exist', error);
      throw translate(error, 'read');
    }
    if ([...this.#entries.values()].some((e) => e.session.doc.id === session.doc.id)) { const stamp={docId:session.doc.id,digest:session.handle.digest};session.dispose(); throw new DuplicateDocumentError(stamp); }
    return this.#register(session, file);
  }

  /** Has the keystore remember the key of an open document, bound to its file and to the key it holds now. False when the keystore will not take it; the copy of the key made here is wiped either way. */
  async rememberKey(id: string, cache: KeyCache): Promise<boolean> {
    const entry=this.#entry(id);this.#mutable(entry);
    return this.#queued(entry,async()=>{const {handle}=entry.session;const key=handle.unlocked.exportKey();try{return await cache.put(entry.path,handle.fingerprint,key);}finally{key.fill(0);}});
  }

  /** True when this file is already open here. Checked before a password is asked for, so a document that cannot be opened is not asked about. */
  isOpen(path: string): boolean { const file = canonical(path); return [...this.#entries.values()].some((e) => e.canonical === file); }

  /** Refuses early when there is no file at `path`: a password is not asked for a file that is not there (a recent document may have gone since it was opened). Only "there is no such file" is told as that; a file that cannot be looked at is an I/O failure. */
  async assertExists(path: string): Promise<void> {
    try { await (this.options.fs ?? realFs).stat(resolve(path)); } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw code === 'ENOENT' || code === 'ENOTDIR' ? new LibraryError('not-found', 'The file does not exist', error) : new LibraryError('io', 'The file cannot be looked at', error);
    }
  }

  /** Refuses early when a document cannot be created at `path` (open, or a file is there), for the same reason. */
  async assertNew(path: string): Promise<void> {
    if (this.isOpen(path)) throw new LibraryError('already-open', 'That file is already open');
    if (await (this.options.fs ?? realFs).stat(resolve(path)).then(() => true, () => false)) throw new LibraryError('exists', 'The document already exists');
  }

  /** The open documents, without their objects. */
  views(): DocSummary[] { return [...this.#entries].map(([id, entry]) => this.#summary(id, entry)); }
  view(id: string): DocSummary { return this.#summary(id, this.#entry(id)); }
  dirtyIds(): string[] { return [...this.#entries].filter(([, entry]) => entry.session.dirty).map(([id]) => id); }
  /** How many objects the document has, of every kind. */
  size(id: string): number { return Object.keys(this.#entry(id).session.doc.objects).length; }
  /** An object the document has (and nothing for an id it does not have: "__proto__" is not an object), so that a caller can refuse what the window has no business with. */
  node(id: string, objectId: string): ObjectNode | undefined { return own(this.#entry(id).session.doc.objects, objectId); }

  /** The document as the window may see it, now. */
  snapshot(id: string): Snapshot {
    const entry = this.#entry(id);
    return { ...stateOf(this.#summary(id, entry)), objects: projectNodes(Object.values(entry.session.doc.objects)) };
  }
  snapshots(): Snapshot[] { return [...this.#entries.keys()].map((id) => this.snapshot(id)); }

  add(id: string, input: { parentId: string | null; type: ObjectType; name: string; props?: Record<string, Json>; index?: number }): { objectId: string; delta: Delta } {
    const objectId = this.#newId();
    const index = this.#position(id, input.parentId, input.index);
    const { delta } = this.#apply(id, { op: 'add', id: objectId, parentId: input.parentId, type: input.type, name: checkName(input.name), props: input.props ?? {}, ...(index === undefined ? {} : { index }) });
    return { objectId, delta };
  }

  /** `props` replaces all the properties, `patch` changes some of them (on the properties as they are now); `spreadSort` gives the folders below the sort setting this folder has afterwards. */
  update(id: string, objectId: string, change: { name?: string; props?: Record<string, Json>; patch?: Patch; spreadSort?: boolean }): Delta {
    return this.#apply(id, {
      op: 'update', id: objectId, ...(change.name === undefined ? {} : { name: checkName(change.name) }), ...(change.props === undefined ? {} : { props: change.props }),
      ...(change.patch === undefined ? {} : { patch: change.patch }), ...(change.spreadSort === true ? { spreadSort: true } : {}),
    }).delta;
  }

  /** How many objects go with it: the object itself and everything below it. */
  subtreeSize(id: string, objectId: string): number {
    const objects = this.#entry(id).session.doc.objects;
    if (!own(objects, objectId)) throw new LibraryError('unknown-object', 'That object does not exist');
    const children = new Map<string, string[]>();
    for (const o of Object.values(objects)) if (o.parentId !== null) { const list = children.get(o.parentId); if (list) list.push(o.id); else children.set(o.parentId, [o.id]); }
    let count = 0;
    const stack = [objectId];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) { count++; for (const child of children.get(next) ?? []) stack.push(child); }
    return count;
  }

  remove(id: string, objectId: string): Delta { return this.#apply(id, { op: 'remove', id: objectId }).delta; }

  /** Moves an object into a folder (or the top level, `null`) at a position among the children of that folder that the window sees, counted without the object itself; no position is the end. */
  move(id: string, objectId: string, parentId: string | null, index?: number): Delta {
    const at = this.#position(id, parentId, index, objectId);
    // An object that is in a sorted folder already has the place the sort gives it: moving it there changes nothing, and must not disturb the manual order kept underneath.
    const objects = this.#entry(id).session.doc.objects;
    const moving = own(objects, objectId), folder = parentId === null ? undefined : own(objects, parentId);
    if (moving && moving.parentId === parentId && folder && sortOf(folder.props).length > 0) return this.update(id, objectId, {});
    return this.#apply(id, { op: 'move', id: objectId, parentId, ...(at === undefined ? {} : { index: at }) }).delta;
  }

  /** Copies an object and everything below it, with new ids, right after the original. */
  duplicate(id: string, objectId: string): { objectId: string; delta: Delta } {
    const objects = this.#entry(id).session.doc.objects;
    const original = own(objects, objectId);
    if (!original) throw new LibraryError('unknown-object', 'That object does not exist');
    const siblings = Object.values(objects).filter((o) => o.parentId === original.parentId && shown(o)); // the names the window sees: a hidden object's name cannot be found out by copying
    const { applied, delta } = this.#apply(id, { op: 'duplicate', id: objectId, name: copyName(siblings, original.name) });
    return { objectId: applied.created!, delta };
  }
  bulk(id:string,expectedSeq:number,expectedGeneration:number,actions:readonly BulkAction[]):{createdIds:string[];delta:Delta}{
    const entry=this.#entry(id);if(entry.seq!==expectedSeq||entry.generation!==expectedGeneration)throw invalid('The reviewed document changed');
    let createdIds:string[]=[];
    const {delta}=this.#run(id,(doc,env)=>{if(doc.schemaVersion!==2||entry.session.needsUpgrade)throw new UpgradeRequiredError();const result=applyBatch(doc,actions,env);createdIds=result.createdIds;return{doc:result.doc,change:result.change};});
    return{createdIds,delta};
  }

  /** Saves the document. Saves of one document run one after the other; a clean document is not rewritten. */
  async save(id: string, options: { auto?: boolean } = {}): Promise<SaveOutcome> { // async: an unknown document is a rejection the caller's catch sees, never a throw that skips it
    const entry = this.#entry(id);this.#mutable(entry);
    const requestedGeneration=entry.generation;
    const run = async (): Promise<SaveOutcome> => {
      // Capture our publication before listeners; a private edit may change only generation, never seq or content.
      const publish=(saved:boolean)=>{const unchanged=entry.generation===requestedGeneration;let writeReceipt:EntryStamp|undefined;const delta=this.#publish(id,entry,[],[],false,false,stamp=>{writeReceipt=stamp;});return{delta,...(saved&&unchanged?{writeReceipt}:{})};};
      if (!entry.session.dirty && !entry.session.needsUpgrade) return { saved: true, conflicts: 0, ...publish(true) };
      entry.saving++;
      try {
        const result = await entry.session.save(options);
        // When the file had been changed by another writer the working copy holds those changes too: #publish starts the window again from what is there now.
        return { saved: result.saved, conflicts: result.saved ? 0 : result.conflicts.length, ...publish(result.saved),...(result.saved&&result.warnings?.length?{warnings:result.warnings}:{}) };
      } catch (error) {
        // A save that fails after it took another program's changes into the working copy leaves the window behind, and nothing says so: #publish moves the seq on,
        // so that the answer to this failure and to the next change tell the window to ask again (a save that took nothing in changes nothing here).
        this.#publish(id, entry, [], []);
        if(error instanceof StoreCommitUncertainError)return this.#uncertain(id,entry,error);
        throw translate(error, 'write');
      } finally {
        entry.saving--;
      }
    };
    return this.#queued(entry, run);
  }

  /** The conflicts that are held back, as the window may see them: the first MAX_CONFLICT_VIEWS, and how many there are in all. */
  conflicts(id: string): { views: ConflictView[]; total: number } {
    const { doc, conflicts } = this.#entry(id).session;
    return { views: describe(doc, conflicts.slice(0, MAX_CONFLICT_VIEWS)), total: conflicts.length };
  }

  /** Decides conflicts, by their keys or all of them for one side; all of it or none. The window starts again from the document as it is now. */
  resolve(id: string, how: { items: readonly { key: string; choice: Choice }[] } | { all: 'mine' | 'theirs' }): Delta {
    const entry = this.#entry(id);
    if ('all' in how && how.all !== 'mine' && how.all !== 'theirs') throw invalid('That is not a side');
    const items = 'all' in how ? sideItems(entry.session.conflicts, how.all) : how.items;
    this.#mutable(entry);
    try { entry.session.resolveMany(items); } catch (error) { throw translate(error, 'edit'); }
    return this.#publish(id, entry, [], [], items.length > 0); // deciding nothing changes nothing
  }

  /** Throws away what was changed here and what was held back, and takes the file as it is: a document without changes, that the window takes from the start. */
  async reload(id: string): Promise<Delta> {
    const entry = this.#entry(id);this.#mutable(entry);
    const run = async (): Promise<Delta> => {
      entry.saving++;
      try { await entry.session.reload(); } catch (error) { throw translate(error, 'read'); } finally { entry.saving--; }
      return this.#publish(id, entry, [], []); // the session counted what it took in: the window starts again
    };
    return this.#queued(entry, run);
  }

  /** The earlier versions that are kept, newest first. */
  async revisions(id: string): Promise<RevisionInfo[]> {
    const entry = this.#entry(id);
    try { return (await listRevisions(entry.path, this.options)).map((name) => ({ name, at: revisionTime(name) })); } catch (error) { throw translate(error, 'read'); }
  }

  /** An earlier version, opened with the key of the open document: a revision that another key sealed is told as such. */
  async #revisionDoc(id: string, entry: Entry, name: string): Promise<Doc> {
    try {
      const doc = parseDocument(await openRevisionWithKey(entry.session.handle, name, this.options));
      if (doc.id !== entry.session.doc.id) throw new LibraryError('unreadable', 'That revision is of another document');
      return doc;
    } catch (error) {
      if (this.#entries.get(id) !== entry) throw new LibraryError('unknown-document', 'That document is not open', error); // it was closed meanwhile, and its key wiped: that is why the revision could not be read
      if (error instanceof StoreError && error.code === 'rekeyed') throw new LibraryError('revision-key', 'That revision was sealed with another key', error);
      throw translate(error, 'read');
    }
  }

  async revision(id: string, name: string): Promise<RevisionView> {
    const entry = this.#entry(id);
    const old = await this.#revisionDoc(id, entry, name);
    const now = entry.session.doc; // as it is when the revision has been read
    const { gone, changed } = compare(now, old);
    const seen = (ids: string[]): string[] => ids.filter((objectId) => shown(old.objects[objectId]!));
    let added = 0;
    for (const o of Object.values(now.objects)) if (shown(o) && !Object.hasOwn(old.objects, o.id)) added++;
    return { name, at: revisionTime(name), docName: old.name, objects: projectNodes(Object.values(old.objects)), gone: seen(gone), changed: seen(changed), added };
  }

  /**
   * Puts an earlier version back, as an edit that is not saved: the objects named (and what is below them) into a new folder at the top level, or the whole document. What is named
   * is what the window sees of the revision; the credentials under a folder come with it, and the window is not told of them.
   */
  async restore(id: string, name: string, what: { ids: readonly string[]; folderName: string } | { all: true }): Promise<{ delta: Delta; created?: string; changed?: boolean }> {
    const entry = this.#entry(id);
    const old = await this.#revisionDoc(id, entry, name); // a document that was closed while the revision was read is told as such there: nothing awaits between that and what follows
    if ('all' in what) {
      this.#mutable(entry);
      const before = entry.session.doc;
      try { entry.session.replaceWith(restoreAll(entry.session.doc, old)); } catch (error) { throw translate(error, 'edit'); }
      const changed = entry.session.doc !== before; // the version the document already is changes nothing
      return { delta: this.#publish(id, entry, [], [], changed), changed };
    }
    if (what.ids.length === 0) throw invalid('Nothing was chosen to restore');
    for (const objectId of what.ids) {
      const o = typeof objectId === 'string' ? own(old.objects, objectId) : undefined;
      if (o === undefined || !shown(o)) throw new LibraryError('unknown-object', 'That object is not in the revision');
    }
    checkName(what.folderName);
    const { applied, delta } = this.#run(id, (doc, env) => restoreObjects(doc, old, what.ids, env, what.folderName));
    return { delta, ...(applied.created === undefined ? {} : { created: applied.created }) };
  }

  /** Closes a document and wipes its key from memory. Unsaved changes are refused unless `discard` says they may go. */
  close(id: string, options: { discard?: boolean } = {}): void {
    const entry = this.#entry(id);
    if (entry.saving > 0||entry.pendingIO>0||this.#leased.has(entry)) throw new LibraryError('busy', 'The document is being saved');
    if (entry.session.dirty && !options.discard) throw new LibraryError('unsaved', 'The document has unsaved changes');
    entry.session.dispose();
    this.#entries.delete(id);
    this.#emit({ id, dirty: false, conflicts: 0, closed: true });
  }

  closeAll(): void {
    for(const [id,entry]of this.#entries){if(entry.saving||entry.pendingIO||this.#leased.has(entry))entry.closeRequested=true;else this.#finishClose(id,entry);}
  }
}
