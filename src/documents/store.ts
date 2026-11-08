// Document files on disk: atomic saves, previous versions, recovery, and detection of another writer.
// The store never looks inside the plaintext (the caller serialises the document); it only moves sealed bytes.
//
// Save: take <path>.lock (O_EXCL; any existing lock stays busy) -> compare the file's digest with the
// handle's (a difference is a conflict, never a silent overwrite) -> seal -> write <path>.<random>.tmp, fsync, close ->
// copy the current file into <path>.revisions/ (as <name>.part first, then renamed: a copy that was cut short never has the name of a revision; a save that a timer made, not a
// person, keeps the file only when the newest revision is old enough) -> rename the temp over the document (atomic) -> prune the revisions -> fsync the directory.
// Existing locks and orphan temps require explicit offline recovery; readers never unlink writer files.
import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { open as openEnvelope, resume, seal as sealEnvelope, EnvelopeError, keyFingerprint, type KdfParams, type Unlocked } from './envelope.js';

export type StoreErrorCode = 'exists' | 'missing' | 'conflict' | 'busy' | 'rekeyed' | 'bad-revision' | 'damaged' | 'io';
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string, readonly cause?: unknown) { super(message); this.name = 'StoreError'; }
}

export interface FileHandleLike { writeFile(data: Uint8Array): Promise<void>; sync(): Promise<void>; close(): Promise<void> }
export interface StoreFs { // the whole surface the store uses, so that tests can inject faults
  open(path: string, flags: string, mode: number): Promise<FileHandleLike>;
  readFile(path: string): Promise<Buffer>;
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  realpath?(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  copyFile(from: string, to: string): Promise<void>;
  syncDir(path: string): Promise<void>;
  stat(path: string): Promise<{ mtimeMs: number; size?: number }>;
}
export const realFs: StoreFs = {
  open: (path, flags, mode) => nodeFs.open(path, flags, mode),
  readFile: (path) => nodeFs.readFile(path),
  rename: (from, to) => nodeFs.rename(from, to),
  link: (from, to) => nodeFs.link(from, to),
  realpath: path => nodeFs.realpath(path),
  unlink: (path) => nodeFs.unlink(path),
  mkdir: async (path) => { await nodeFs.mkdir(path, { recursive: true }); },
  readdir: (path) => nodeFs.readdir(path),
  copyFile: (from, to) => nodeFs.copyFile(from, to, nodeFs.constants.COPYFILE_EXCL),
  stat: (path) => nodeFs.stat(path),
  // Windows cannot open a directory for fsync; macOS fsync does not force the drive cache (F_FULLFSYNC): known limits, see the plan.
  syncDir: async (path) => {
    if (process.platform === 'win32') return;
    const handle = await nodeFs.open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  },
};

export type Options = { fs?: StoreFs; keepRevisions?: number; maxRevisionBytes?: number; autoSpacingMs?: number; kdf?: KdfParams; now?: () => number; lockStaleMs?: number; lease?: StoreLockLease; expectedDigest?: string|null };
/** `auto`: the save was made by a timer and not asked for: the file that it replaces is kept as a revision only when the newest revision is at least `autoSpacingMs` old. */
export type SaveOptions = Options & { auto?: boolean };
export const KEEP_REVISIONS = 20;                   // the newest revisions that stay
export const MIN_REVISIONS = 3;                     // the newest revisions that stay whatever they weigh
export const MAX_REVISION_BYTES = 256 * 1024 * 1024; // what the revisions of one document may weigh together
export const AUTO_SPACING_MS = 10 * 60_000;
/** `fingerprint`: which key the handle holds (the header of the file that it opened names it); it does not change when the file is saved, and it tells a revision of another key from a damaged one. */
export type Handle = { readonly path: string; readonly unlocked: Unlocked; readonly fingerprint: string; digest: string; readonly warnings?:readonly StoreWarning[] };

const digestOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const REVISION = /^\d{8}T\d{9}Z-[0-9a-f]{12}\.rwdoc$/;
const PART = '.part'; // a revision that is being copied
const revisionDir = (path: string) => `${path}.revisions`;
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:.]/g, '').replace(/(\d{8}T\d{6})(\d{3})Z/, '$1$2Z');
const codeOf = (error: unknown) => (error as { code?: string } | undefined)?.code;

/** When a revision was taken (milliseconds since 1970), read from its name; NaN for a name that is not one of a revision. */
export function revisionTime(name: string): number {
  if (!REVISION.test(name)) return Number.NaN;
  return Date.parse(`${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(9, 11)}:${name.slice(11, 13)}:${name.slice(13, 15)}.${name.slice(15, 18)}Z`);
}

async function renameWithRetry(fs: StoreFs, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; } catch (error) {
      // Windows refuses to replace a file that another process has open for a moment (antivirus, indexer, sync client).
      if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(codeOf(error) ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 3 ** attempt));
    }
  }
}

async function writeNew(fs: StoreFs, tmp: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export type StoreWarning='commit-observed-after-error'|'lock-release-failed';
export type StoreCommit={warnings:StoreWarning[]};
export class StoreCommitUncertainError extends StoreError{
  readonly reopenRequired=true;
  constructor(cause:unknown){super('io','The commit state could not be determined; reopen the document',cause);}
}
const leaseBrand:unique symbol=Symbol('StoreLockLease');
export type StoreLockLease={readonly path:string;readonly warnings:readonly StoreWarning[];readonly [leaseBrand]:true};
type LeaseState={path:string;fs:StoreFs;active:boolean;warnings:StoreWarning[];release():Promise<void>};
const leases=new WeakMap<object,LeaseState>();
async function canonicalPath(fs:StoreFs,path:string):Promise<string>{
  const absolute=resolve(path);if(!fs.realpath)return absolute;
  try{return await fs.realpath(absolute);}catch(error){if(codeOf(error)!=='ENOENT')throw new StoreError('io','Cannot identify document path',error);}
  try{return join(await fs.realpath(dirname(absolute)),basename(absolute));}catch(error){throw new StoreError('io','Cannot identify document folder',error);}
}
async function acquireLock(fs:StoreFs,path:string,now:()=>number):Promise<StoreLockLease>{
  const lock=path+'.lock',owner=Buffer.from(JSON.stringify({pid:process.pid,host:hostname(),t:now(),token:randomBytes(24).toString('hex')}));let handle:FileHandleLike;
  try{handle=await fs.open(lock,'wx',0o600);}catch(error){throw new StoreError(codeOf(error)==='EEXIST'?'busy':'io','Document lock unavailable; existing locks require explicit offline recovery',error);}
  try{await handle.writeFile(owner);await handle.sync();}catch(error){throw new StoreError('io','Cannot write document lock',error);}finally{await handle.close();}
  const state:LeaseState={path,fs,active:true,warnings:[],release:async()=>{try{if(!(await fs.readFile(lock)).equals(owner))throw Error('Owner changed');await fs.unlink(lock);}catch{state.warnings.push('lock-release-failed');}}};
  const lease=Object.freeze({path,[leaseBrand]:true as const,get warnings(){return [...state.warnings];}});leases.set(lease,state);return lease;
}
export async function withDocumentLocks<T>(paths:readonly string[],options:Options,work:(leases:ReadonlyMap<string,StoreLockLease>)=>Promise<T>):Promise<T>{
  const fs=options.fs??realFs,names=[...new Set(await Promise.all(paths.map(p=>canonicalPath(fs,p))))].sort(),held=new Map<string,StoreLockLease>(),owned:StoreLockLease[]=[];
  if(!names.length)throw new StoreError('busy','No document lock requested');
  try{for(const path of names){const lease=await acquireLock(fs,path,options.now??Date.now);held.set(path,lease);owned.push(lease);}return await work(held);}
  finally{for(const lease of owned.reverse()){const state=leases.get(lease)!;state.active=false;await state.release();}}
}
async function locked<T>(path:string,options:Options,work:(lease:StoreLockLease)=>Promise<T>):Promise<T>{
  const fs=options.fs??realFs,canonical=await canonicalPath(fs,path);
  if(options.lease){const state=leases.get(options.lease);if(!state||!state.active||state.path!==canonical||state.fs!==fs)throw new StoreError('busy','Invalid document lock lease');return work(options.lease);}
  let held:StoreLockLease|undefined;const result=await withDocumentLocks([canonical],options,async map=>{held=map.get(canonical)!;return work(held);});
  if(result&&typeof result==='object'&&'warnings'in result)(result as {warnings:StoreWarning[]}).warnings.push(...held!.warnings);return result;
}
async function headDigest(fs:StoreFs,path:string):Promise<string|null>{
  try{return digestOf(await fs.readFile(path));}catch(error){if(codeOf(error)==='ENOENT')return null;throw new StoreError('io','Cannot inspect the document head',error);}
}
async function replaceHead(fs:StoreFs,tmp:string,path:string,previous:string|null,next:string):Promise<StoreWarning[]>{
  try{await renameWithRetry(fs,tmp,path);return[];}catch(error){
    let observed:string|null;try{observed=await headDigest(fs,path);}catch{throw new StoreCommitUncertainError(error);}
    if(observed===next)return['commit-observed-after-error'];
    if(observed===previous)throw error;
    throw new StoreCommitUncertainError(error);
  }
}


type Policy = { keep: number; maxBytes: number; spacingMs: number };
const revisionNames = async (fs: StoreFs, dir: string): Promise<string[]> => (await fs.readdir(dir)).filter((n) => REVISION.test(n)).sort().reverse();

/**
 * Keeps the file that is about to be replaced as a revision, and says which one it made. Not when it is kept already (the same file, by the digest in the name: a save whose
 * rename failed, tried again) and, with a spacing, not when the newest revision that is not from the future (the clock went back) is younger than the spacing. The copy is made
 * under another name and renamed, so that a copy that a process death cut short is never taken for the revision that it would have been; the one that is left is cleaned here
 * (the lock is ours: nobody else is copying).
 */
async function keepRevision(fs: StoreFs, path: string, currentDigest: string, now: () => number, spacingMs: number): Promise<string | undefined> {
  const dir = revisionDir(path);
  await fs.mkdir(dir);
  const entries = await fs.readdir(dir);
  for (const leftover of entries.filter((n) => n.endsWith(PART))) await fs.unlink(join(dir, leftover)).catch(() => undefined);
  const names = entries.filter((n) => REVISION.test(n)).sort().reverse();
  if (names.some((n) => n.endsWith(`-${currentDigest.slice(0, 12)}.rwdoc`))) return undefined;
  if (spacingMs > 0) {
    const newest = names.find((n) => revisionTime(n) <= now());
    if (newest !== undefined && now() - revisionTime(newest) < spacingMs) return undefined;
  }
  const name = `${stamp(now())}-${currentDigest.slice(0, 12)}.rwdoc`;
  const part = join(dir, `${name}${PART}`);
  try {
    await fs.copyFile(path, part);
    await renameWithRetry(fs, part, join(dir, name));
  } catch (error) {
    await fs.unlink(part).catch(() => undefined);
    throw error;
  }
  return name;
}

/**
 * Lets go of the oldest revisions once the save has happened: of what is beyond `keep` revisions, and of what is beyond `maxBytes` together (the newest MIN_REVISIONS stay
 * whatever they weigh). The revision that this save made (`created`) is counted as the newest and is never let go of, whatever its name says about the time; the ones stamped
 * after `now` (the clock was set back) are counted as the oldest, so that twenty of them do not push every revision of the present out.
 */
async function pruneRevisions(fs: StoreFs, path: string, created: string | undefined, policy: Policy, now: () => number): Promise<void> {
  const dir = revisionDir(path);
  const others = (await revisionNames(fs, dir)).filter((n) => n !== created);
  const at = now();
  const names = [...(created === undefined ? [] : [created]), ...others.filter((n) => revisionTime(n) <= at), ...others.filter((n) => revisionTime(n) > at)];
  let bytes = 0;
  for (const [i, old] of names.entries()) {
    if (i < policy.keep) {
      bytes += await fs.stat(join(dir, old)).then((s) => s.size ?? 0, () => 0);
      if (i < MIN_REVISIONS || bytes <= policy.maxBytes) continue;
    }
    await fs.unlink(join(dir, old)).catch(() => undefined);
  }
}

export async function createDocument(path:string,plaintext:Uint8Array,password:string,options:Options={}):Promise<Handle>{
  return locked(path,options,async lease=>{
    const fs=options.fs??realFs;path=lease.path;
    try{await fs.stat(path);throw new StoreError('exists','The document already exists');}catch(error){if(error instanceof StoreError)throw error;if(codeOf(error)!=='ENOENT')throw new StoreError('io','Cannot check document destination',error);}
    const {file,unlocked}=await sealEnvelope(plaintext,password,{kdf:options.kdf});const tmp=path+'.'+randomBytes(6).toString('hex')+'.tmp';let committed=false;
    try{await writeNew(fs,tmp,file);try{await fs.link(tmp,path);}catch(error){if(await fs.readFile(path).then(bytes=>digestOf(bytes)===digestOf(file),()=>false))committed=true;else throw new StoreError(codeOf(error)==='EEXIST'?'exists':'io','Cannot publish new document',error);}committed=true;await fs.syncDir(dirname(path)).catch(()=>undefined);return{path,unlocked,fingerprint:keyFingerprint(file),digest:digestOf(file),warnings:[] as StoreWarning[]};}
    catch(error){if(!committed)unlocked.dispose();throw error;}
    finally{await fs.unlink(tmp).catch(()=>undefined);}
  });
}

export async function openDocument(path: string, password: string, options: Options = {}): Promise<{ handle: Handle; plaintext: Buffer }> {
  const fs = options.fs ?? realFs;
  let file: Buffer;
  try { file = await fs.readFile(path); } catch (error) { throw new StoreError(codeOf(error) === 'ENOENT' ? 'missing' : 'io', 'Cannot read the document', error); }
  const { plaintext, unlocked } = await openEnvelope(file, password);
  return { handle: { path, unlocked, fingerprint: keyFingerprint(file), digest: digestOf(file) }, plaintext };
}

/** Open with a document key from the keystore cache instead of the password (see keywrap.ts). */
export async function openWithKey(path: string, key: Uint8Array, options: Options = {}): Promise<{ handle: Handle; plaintext: Buffer }> {
  const fs = options.fs ?? realFs;
  let file: Buffer;
  try { file = await fs.readFile(path); } catch (error) { throw new StoreError(codeOf(error) === 'ENOENT' ? 'missing' : 'io', 'Cannot read the document', error); }
  const { plaintext, unlocked } = resume(file, key);
  return { handle: { path, unlocked, fingerprint: keyFingerprint(file), digest: digestOf(file) }, plaintext };
}

export async function saveDocument(handle:Handle,plaintext:Uint8Array,options:SaveOptions={}):Promise<StoreCommit>{
  return locked(handle.path,options,async()=>{
    const fs=options.fs??realFs,now=options.now??Date.now,warnings:StoreWarning[]=[];let tmp:string|undefined;
    try{
      let current:Buffer;try{current=await fs.readFile(handle.path);}catch(error){throw new StoreError('missing','The document file disappeared',error);}
      const currentDigest=digestOf(current);if(currentDigest!==handle.digest)throw new StoreError('conflict','The document changed on disk since it was opened');
      const next=handle.unlocked.seal(plaintext);tmp=handle.path+'.'+randomBytes(6).toString('hex')+'.tmp';await writeNew(fs,tmp,next);
      const policy:Policy={keep:options.keepRevisions??KEEP_REVISIONS,maxBytes:options.maxRevisionBytes??MAX_REVISION_BYTES,spacingMs:options.auto?options.autoSpacingMs??AUTO_SPACING_MS:0};
      const created=policy.keep>0?await keepRevision(fs,handle.path,currentDigest,now,policy.spacingMs):undefined;
      warnings.push(...await replaceHead(fs,tmp,handle.path,currentDigest,digestOf(next)));
      tmp=undefined;handle.digest=digestOf(next);
      if(policy.keep>0)await pruneRevisions(fs,handle.path,created,policy,now).catch(()=>undefined);await fs.syncDir(dirname(handle.path)).catch(()=>undefined);return{warnings};
    }finally{if(tmp)await fs.unlink(tmp).catch(()=>undefined);}
  });
}

export type RekeyResult={handle:Handle;warnings:StoreWarning[]};
export async function rekey(handle:Handle,oldPassword:string,newPassword:string,options:Options={}):Promise<RekeyResult>{
  if(!newPassword||Buffer.byteLength(newPassword.normalize('NFC'))>1024)throw new EnvelopeError('bad-password','Password must be 1 to 1024 bytes');
  return locked(handle.path,options,async()=>{
    const fs=options.fs??realFs,now=options.now??Date.now;let tmp:string|undefined,newKey:Unlocked|undefined,committed=false;
    try{
      const current=await fs.readFile(handle.path),digest=digestOf(current);if(digest!==handle.digest)throw new StoreError('conflict','The document changed on disk since it was opened');
      const old=await openEnvelope(current,oldPassword);let next:{file:Buffer;unlocked:Unlocked};
      try{next=await sealEnvelope(old.plaintext,newPassword,{kdf:options.kdf});}finally{old.unlocked.dispose();old.plaintext.fill(0);}
      newKey=next.unlocked;tmp=handle.path+'.'+randomBytes(6).toString('hex')+'.tmp';await writeNew(fs,tmp,next.file);
      const created=await keepRevision(fs,handle.path,digest,now,0),warnings=await replaceHead(fs,tmp,handle.path,digest,digestOf(next.file));tmp=undefined;committed=true;
      const result:RekeyResult={handle:{path:handle.path,unlocked:newKey,fingerprint:keyFingerprint(next.file),digest:digestOf(next.file)},warnings};handle.unlocked.dispose();
      await pruneRevisions(fs,handle.path,created,{keep:options.keepRevisions??KEEP_REVISIONS,maxBytes:options.maxRevisionBytes??MAX_REVISION_BYTES,spacingMs:0},now).catch(()=>undefined);await fs.syncDir(dirname(handle.path)).catch(()=>undefined);return result;
    }catch(error){if(error instanceof StoreCommitUncertainError)handle.unlocked.dispose();throw error;}
    finally{if(!committed)newKey?.dispose();if(tmp)await fs.unlink(tmp).catch(()=>undefined);}
  });
}

/** After a conflict: the plaintext of the version now on disk (opened with this handle's key); the handle then accepts the next save. */
export async function rebase(handle: Handle, options: Options = {}): Promise<Buffer> {
  const fs = options.fs ?? realFs;
  const file = await fs.readFile(handle.path);
  let plaintext: Buffer;
  try { plaintext = handle.unlocked.open(file); } catch (error) {
    if (error instanceof EnvelopeError && error.code === 'auth') throw new StoreError('rekeyed', 'The password was changed elsewhere; open the document again', error);
    throw error;
  }
  handle.digest = digestOf(file);
  return plaintext;
}

export async function listRevisions(path: string, options: Options = {}): Promise<string[]> {
  const fs = options.fs ?? realFs;
  try { return await revisionNames(fs, revisionDir(path)); } catch (error) {
    if (codeOf(error) === 'ENOENT') return []; // no revision was ever kept
    throw new StoreError('io', 'Cannot read the revisions', error);
  }
}

async function readRevision(fs: StoreFs, path: string, name: string): Promise<Buffer> {
  if (!REVISION.test(name)) throw new StoreError('bad-revision', 'Not a revision file name');
  return fs.readFile(join(revisionDir(path), name));
}

/** A revision opened with the key of the open document, without the password; one that another key sealed (the password was changed since, or it is not of this document) is `rekeyed`. */
export async function openRevisionWithKey(handle: Handle, name: string, options: Options = {}): Promise<Buffer> {
  let file: Buffer;
  try { file = await readRevision(options.fs ?? realFs, handle.path, name); } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(codeOf(error) === 'ENOENT' ? 'missing' : 'io', 'Cannot read the revision', error);
  }
  try { return handle.unlocked.open(file); } catch (error) {
    if (!(error instanceof EnvelopeError && error.code === 'auth')) throw error;
    // The same failure is a key that is not the right one (the password was changed since) and a file that was damaged: the header of the revision, which names the key, tells which.
    if (keyFingerprint(file) !== handle.fingerprint) throw new StoreError('rekeyed', 'The revision was sealed with another key', error);
    throw new StoreError('damaged', 'The revision is damaged', error);
  }
}

export async function openRevision(path: string, password: string, name: string, options: Options = {}): Promise<Buffer> {
  const opened = await openEnvelope(await readRevision(options.fs ?? realFs, path, name), password);
  opened.unlocked.dispose();
  return opened.plaintext;
}

/** Make a revision the document again. The damaged or replaced file is kept next to it as <path>.broken-<time>. */
export async function recover(path:string,password:string,name:string,options:Options={}):Promise<{handle:Handle;plaintext:Buffer;warnings:StoreWarning[]}>{
  const fs=options.fs??realFs,reviewed=options.expectedDigest===undefined?await headDigest(fs,path):options.expectedDigest;
  if(reviewed!==null&&!/^[0-9a-f]{64}$/.test(reviewed))throw new StoreError('conflict','Invalid reviewed document head');
  return locked(path,options,async lease=>{
    path=lease.path;if(await headDigest(fs,path)!==reviewed)throw new StoreError('conflict','The document changed before recovery');
    const file=await readRevision(fs,path,name),opened=await openEnvelope(file,password);let tmp:string|undefined,committed=false;
    try{
      tmp=path+'.'+randomBytes(6).toString('hex')+'.tmp';await writeNew(fs,tmp,file);
      if(reviewed!==null)await fs.copyFile(path,path+'.broken-'+stamp((options.now??Date.now)())+'-'+randomBytes(6).toString('hex'));
      if(await headDigest(fs,path)!==reviewed)throw new StoreError('conflict','The document changed during recovery');
      let warnings:StoreWarning[];
      if(reviewed===null){try{await fs.link(tmp,path);warnings=[];}catch(error){if(await headDigest(fs,path)===digestOf(file))warnings=['commit-observed-after-error'];else throw new StoreError(codeOf(error)==='EEXIST'?'conflict':'io','Cannot publish recovered document',error);}}
      else warnings=await replaceHead(fs,tmp,path,reviewed,digestOf(file));
      committed=true;await fs.syncDir(dirname(path)).catch(()=>undefined);return{handle:{path,unlocked:opened.unlocked,fingerprint:keyFingerprint(file),digest:digestOf(file)},plaintext:opened.plaintext,warnings};
    }catch(error){if(!committed){opened.unlocked.dispose();opened.plaintext.fill(0);}throw error;}
    finally{if(tmp)await fs.unlink(tmp).catch(()=>undefined);}
  });
}
