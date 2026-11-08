// One open document in memory: the version last read or written (base), the user's working copy (mine), and the save logic that
// turns "another writer saved meanwhile" into a three-way merge. Clean merges are saved at once; conflicts are returned and
// nothing is written until the user has resolved them.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { ConflictError, keyOf, prune, resolveMany as resolveChoices, type Choice, type Remembered } from './conflicts.js';
import { EnvelopeError, keyFingerprint } from './envelope.js';
import type { KeyCache } from './keywrap.js';
import { merge3, documentValue, credentialGroupState, type Conflict, type FieldConflict } from './merge.js';
import { DocumentError, loadDocument, parseDocument, serializeDocument, validateDocument, type Doc, type Json, type LoadedDocument } from './model.js';
import { applyOp, type Applied, type Env, type Op } from './ops.js';
import { createDocument, openDocument, openWithKey, rebase, saveDocument, StoreError, type Handle, type Options, rekey, type StoreWarning, type StoreLockLease } from './store.js';

/** `merged`: the file had been changed by another writer and the working copy now holds those changes too, so whoever shows the document has to take it again. */
export type SaveResult = { saved: true; merged?: true;warnings?:StoreWarning[] } | { saved: false; conflicts: Conflict[]; merged?: true };
export type Credential = { password: string } | { cache: KeyCache; password?: string };

/** The document in a file that opened, or, when its content cannot be used (damaged, or from a newer version), a wiped key instead of one left for the garbage collector. */
function usable(handle: Handle, plaintext: Buffer): LoadedDocument {
  try { return loadDocument(plaintext); } catch (error) { handle.unlocked.dispose(); throw error; }
}

export class UpgradeRequiredError extends Error {
  readonly code = 'upgrade-required';
  constructor() { super('Explicit document upgrade approval is required'); this.name = 'UpgradeRequiredError'; }
}

/** What the document holds now for the field of a conflict. */
function heldValue(doc: Doc, conflict: FieldConflict): Json | undefined {
  if (conflict.field.startsWith('document.')) return documentValue(doc, conflict.field);
  const node = doc.objects[conflict.id]!; // the conflicts are pruned first: the object is there
  if(conflict.field==='props.groups.credentials')return credentialGroupState(node);
  if (!conflict.field.startsWith('props.')) return (node as unknown as Record<string, Json | undefined>)[conflict.field];
  const key = conflict.field.slice(6);
  if (key.startsWith('groups.') || key.startsWith('inherit.')) {
    const [section, group] = key.split('.'); const values = node.props[section];
    return values && typeof values === 'object' && !Array.isArray(values) && Object.hasOwn(values, group) ? values[group] : undefined;
  }
  return Object.hasOwn(node.props, key) ? node.props[key] : undefined;
}

/**
 * The conflicts that are still to be decided after an edit: those about what the edit deleted are gone (`dropped`: what the other writer saved about those is thrown away when
 * this is saved), "mine" of a field conflict is what the document holds now (it was edited since the merge), and a field that holds their value now is no conflict (nothing of
 * theirs goes). A conflict that the edit did not touch is the very object it was.
 */
function settled(doc: Doc, conflicts: readonly Conflict[]): { left: Conflict[]; dropped: boolean } {
  const left: Conflict[] = [];
  const alive = prune(doc, conflicts);
  for (const conflict of alive) {
    if (conflict.kind !== 'field') { left.push(conflict); continue; }
    const held = heldValue(doc, conflict);
    if (isDeepStrictEqual(held, conflict.mine)) left.push(conflict);
    else if (!isDeepStrictEqual(held, conflict.theirs)) left.push({ ...conflict, mine: held });
  }
  return { left, dropped: alive.length < conflicts.length };
}

export class DocumentSession {
  /** `remembered`: what the choices made so far make sure of, for the ones that follow; it goes when the file is written or another version of it is taken in. */
  #pending: { conflicts: Conflict[]; remembered?: Remembered } | undefined;
  #merges = 0;
  /**
   * Decisions that throw something away (conflicts decided, an edit that deleted what a conflict was about, a whole earlier version put in), counted, and how many of them a save
   * that began after them has written. While some are not written, the next save keeps the file it replaces, whoever saves; a decision made while a save is being written is
   * not written by it.
   */
  #decided = 0;
  #written = 0;
  #consent: { documentId: string; sourceDigest: string; targetSchema: 2 } | undefined;
  #saving=0;
  #rekeying=false;
  #disposeAfter=false;
  get handle():Handle{return this._handle;}
  get creationWarnings():readonly StoreWarning[]{return [...(this._handle.warnings??[])];}
  private constructor(private _handle: Handle, private base: Doc, private mine: Doc, private readonly options: Options, private source: 1 | 2 = 2) {}

  static async create(path: string, doc: Doc, password: string, options: Options = {}): Promise<DocumentSession> {
    const valid = parseDocument(serializeDocument(validateDocument(doc)));
    return new DocumentSession(await createDocument(path, serializeDocument(valid), password, options), valid, valid, options);
  }

  /** Open with the password, or with the keystore's cached key (a missing or stale key falls back to the password). */
  static async open(path: string, credential: Credential, options: Options = {}): Promise<DocumentSession> {
    if ('cache' in credential) {
      const cached = await credential.cache.get(path, keyFingerprint(await readFile(path)));
      if (cached) {
        try {
          const { handle, plaintext } = await openWithKey(path, cached, options);
          const { doc, sourceSchema } = usable(handle, plaintext);
          return new DocumentSession(handle, doc, doc, options, sourceSchema);
        } catch (error) {
          if (!(error instanceof EnvelopeError && error.code === 'auth')) throw error; // only a key that does not fit is stale (the password is used); a file that cannot be read or understood is told as that
        } finally { cached.fill(0); }
      }
      if (credential.password === undefined) throw new StoreError('missing', 'No usable cached key and no password');
    }
    const { handle, plaintext } = await openDocument(path, credential.password!, options);
    const { doc, sourceSchema } = usable(handle, plaintext);
    return new DocumentSession(handle, doc, doc, options, sourceSchema);
  }

  get doc(): Doc { return this.mine; }
  get sourceSchema(): 1 | 2 { return this.source; }
  get needsUpgrade(): boolean { return this.source === 1; }
  /** Called only after a main-process confirmation, bound to the ciphertext the person reviewed. */
  approveUpgrade(sourceDigest: string): void {
    if (sourceDigest !== this.handle.digest) throw new UpgradeRequiredError();
    this.#consent = { documentId: this.mine.id, sourceDigest, targetSchema: 2 };
  }
  #requireUpgradeConsent(): void {
    if (this.source === 1 && (this.#consent?.documentId !== this.mine.id || this.#consent.sourceDigest !== this.handle.digest)) throw new UpgradeRequiredError();
  }
  /** True while the working copy holds changes that are not in the file. */
  get dirty(): boolean { return this.mine !== this.base; }
  get conflicts(): Conflict[] { return this.#pending?.conflicts ?? []; }
  /** How many times the working copy has taken another writer's version of the file in: whoever shows the document has to take it again after each one. */
  get merges(): number { return this.#merges; }

  /** Apply an edit to a copy; the result must still validate, otherwise the working copy is unchanged. */
  update(change: (draft: Doc) => void): void {
    const draft = structuredClone(this.mine);
    change(draft);
    validateDocument(draft);
    this.mine = this.#edited(draft);
    this.#settle();
  }

  /** Apply an operation (ops.ts). The working copy is replaced and never changed in place, so dirty, the snapshot a save takes and the merge behave as they do for update(); an operation that changes nothing leaves the document as clean as it was. */
  apply(op: Op, env: Env): Applied { return this.change((doc) => applyOp(doc, op, env)); }

  /** An edit that something other than an operation works out (a restore, say) from the working copy: for everything that follows from it, the same as apply(). A refusal leaves the working copy alone. */
  change(make: (doc: Doc) => Applied): Applied {
    const applied = make(this.mine);
    // Operations validate local nodes; schema 2 also has cross-node secret/reference invariants.
    if (applied.doc !== this.mine) validateDocument(applied.doc);
    const next=this.#edited(applied.doc);
    if(next===this.mine)return {...applied,doc:this.mine,change:{upsert:[],remove:[]}};
    this.mine=next;
    this.#settle();
    return {...applied,doc:next};
  }

  #edited(next:Doc,force=false):Doc {
    if(!force&&isDeepStrictEqual(next,this.mine))return this.mine;
    if(next.schemaVersion!==2)return next;
    const createdAt=this.mine.schemaVersion===2?this.mine.meta.createdAt:next.meta.createdAt;
    const previous=this.mine.schemaVersion===2?this.mine.meta.updatedAt:null;
    const now=new Date((this.options.now??Date.now)()).toISOString();
    const updatedAt=[previous,next.meta.updatedAt,now].filter((value):value is string=>value!==null).sort().at(-1)!;
    return validateDocument({...next,meta:{...next.meta,createdAt,updatedAt}});
  }

  #settle(): void {
    const pending = this.#pending;
    if (!pending || pending.conflicts.length === 0) return;
    const { left, dropped } = settled(this.mine, pending.conflicts);
    if (dropped) this.#decided++; // an edit deleted what a conflict was about: what the other writer saved about it goes with the next save
    this.#pending = { ...pending, conflicts: left };
  }

  /**
   * `auto`: a timer saves, not a person (the store then keeps the file that is replaced as a revision only when the newest revision is old enough), except for the first save after
   * a decision that throws something away: what the other writer saved, or what was here until a whole earlier version was put in, is then kept whatever the age of the newest revision.
   */
  async save(options: { auto?: boolean;strict?:boolean;lease?:StoreLockLease } = {}): Promise<SaveResult> {
    if(this.#rekeying)throw new StoreError('busy','Password change in progress');
    this.#saving++;try{
    this.#requireUpgradeConsent();
    if (this.conflicts.length > 0) return { saved: false, conflicts: this.conflicts };
    let rebased = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = this.mine;
      const decided = this.#decided; // what this save carries: a decision made while it is written is for the next one
      const candidate = { ...snapshot, revision: Math.max(this.base.revision, snapshot.revision) + 1 };
      try {
        const committed=await saveDocument(this.handle, serializeDocument(validateDocument(candidate)), {...this.options,...(options.auto&&decided===this.#written?{auto:true}:{}),...(options.lease?{lease:options.lease}:{})});
        this.#written = Math.max(this.#written, decided);
        this.base = candidate;
        if (this.mine === snapshot) this.mine = candidate; // an edit made while the file was being written stays, and stays unsaved
        this.#pending = undefined;
        this.source = 2;
        this.#consent = undefined;
        return {saved:true,...(rebased?{merged:true as const}:{}),...(committed.warnings.length?{warnings:committed.warnings}:{})};
      } catch (error) {
        this.#consent = undefined;
        if (!(error instanceof StoreError) || error.code !== 'conflict') throw error;
        if(options.strict)throw error;
        // rebase() moves the handle to the other writer's version before anyone knows whether it can be used. If it cannot (a newer format, a
        // merge that is not valid), the handle goes back, so the next save is a conflict again and never writes over a version nobody merged.
        const seen = this.handle.digest;
        try {
          const { doc: theirs, sourceSchema } = loadDocument(await rebase(this.handle, this.options));
          const { merged, conflicts } = merge3(this.base, this.mine, theirs);
          this.base = theirs;
          this.mine = merged;
          this.#merges++;
          rebased = true;
          this.source = sourceSchema;
          if (conflicts.length > 0) { this.#pending = { conflicts }; return { saved: false, conflicts, merged: true }; }
        } catch (failure) {
          this.handle.digest = seen;
          throw failure;
        }
        this.#requireUpgradeConsent();
      }
    }
    throw new StoreError('conflict', 'The document keeps changing on disk');
    }finally{this.#saving--;}
  }

  /** Decide one pending conflict (conflicts.ts says what can be chosen); when none is left the next save() writes the merged document. A choice that is refused changes nothing. */
  resolve(conflict: Conflict, choice: Choice): void {
    if (!this.#pending?.conflicts.includes(conflict)) throw new ConflictError('unknown-conflict', 'Not a pending conflict');
    this.resolveMany([{ key: keyOf(conflict), choice }]);
  }

  /** Decide several at once, by their keys: all of them or none. What was chosen to be kept, and what was put in a folder by choosing their parent, is remembered for the next ones. */
  resolveMany(items: readonly { key: string; choice: Choice }[]): void {
    if (items.length === 0) return; // nothing is decided: nothing is thrown away
    const { doc, conflicts, remembered } = resolveChoices(this.mine, this.conflicts, items, this.#pending?.remembered);
    this.mine = this.#edited(doc,true);
    this.#pending = { conflicts, remembered };
    this.#decided++;
  }

  /**
   * Throws away what was changed here and what was held back, and takes the file as it is. Like the merge in save(), it moves the handle to the file before anyone knows
   * whether it can be used; if it cannot (a newer format) the handle goes back, and the next save is a conflict again, never a write over a version nobody read.
   */
  async reload(): Promise<void> {
    const seen = this.handle.digest;
    try {
      const { doc: theirs, sourceSchema } = loadDocument(await rebase(this.handle, this.options));
      if (theirs.id !== this.mine.id || theirs.kind !== this.mine.kind) throw new DocumentError('bad-document', 'That file holds another document');
      this.base = theirs;
      this.mine = theirs;
      this.source = sourceSchema;
      this.#consent = undefined;
      this.#pending = undefined;
      this.#written = this.#decided;   // the working copy is the file now: nothing is thrown away by the save that follows
      this.#merges++;
    } catch (failure) {
      this.handle.digest = seen;
      throw failure;
    }
  }

  /** The working copy becomes `doc`, another version of this document (a revision): unsaved like any edit, and it decides whatever was pending. */
  replaceWith(doc: Doc): void {
    const valid = parseDocument(serializeDocument(validateDocument(doc)));
    if (valid.id !== this.mine.id || valid.kind !== this.mine.kind) throw new DocumentError('bad-document', 'That is not this document');
    const comparable={...valid,revision:this.mine.revision,...(valid.schemaVersion===2&&this.mine.schemaVersion===2?{meta:{...valid.meta,createdAt:this.mine.meta.createdAt,updatedAt:this.mine.meta.updatedAt}}:{})};
    if(this.conflicts.length===0&&isDeepStrictEqual(comparable,this.mine))return;
    this.mine = this.#edited(valid,this.conflicts.length>0);
    this.#pending = undefined;
    this.#decided++;
  }

  /** A failed transaction may restore its own candidate, but cannot discard a later edit. */
  rollbackWorkingCopy(expected:Doc,previous:Doc):boolean {
    if(this.mine!==expected)return false;
    if(previous.id!==this.mine.id||previous.kind!==this.mine.kind)throw new DocumentError('bad-document','Rollback belongs to another document');
    validateDocument(previous);this.mine=previous;return true;
  }
  async changePassword(oldPassword:string,newPassword:string):Promise<StoreWarning[]>{
    if(this.needsUpgrade)throw new UpgradeRequiredError();
    if(this.#saving||this.#rekeying)throw new StoreError('busy','Document operation in progress');
    this.#rekeying=true;
    try{const result=await rekey(this.handle,oldPassword,newPassword,this.options);this._handle=result.handle;return result.warnings;}
    finally{this.#rekeying=false;if(this.#disposeAfter)this._handle.unlocked.dispose();}
  }
  dispose(): void { if(this.#rekeying){this.#disposeAfter=true;return;}this.handle.unlocked.dispose(); }
}
