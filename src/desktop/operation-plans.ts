import {randomUUID} from 'node:crypto';
import type {DocumentLibrary} from '../documents/library.js';
export type OperationKind='bulk'|'transfer';
export type OperationStamp=ReturnType<DocumentLibrary['entryStamp']>;
export type BoundOperation<T>={readonly payload:T;readonly stamps:readonly OperationStamp[];valid():boolean;scopeValid():boolean};
type StoredPlan<T>={id:string;kind:OperationKind;payload:T;stamps:readonly OperationStamp[];expiresAt:number;scope:string;ownerToken:object;timer:ReturnType<typeof setTimeout>};
const refused=():never=>{throw Object.assign(new Error('Rencana operasi tidak berlaku; buat pratinjau baru.'),{code:'stale'});};
const TTL=60000;
export class OperationPlans{
 #plans=new Map<string,StoredPlan<unknown>>();
 #owners=new Map<string,object>();
 #closed=false;
 constructor(readonly library:Pick<DocumentLibrary,'entryStamp'>,readonly deps:{scopeStamp(excludedHandles:readonly string[]):string;now?():number}){}
 #clear(owner:string){const held=this.#plans.get(owner);if(held){clearTimeout(held.timer);this.#plans.delete(owner);}}
 #same(stamps:readonly OperationStamp[]){
  return stamps.every(before=>{try{const current=this.library.entryStamp(before.handle);return !current.requiresReopen&&current.handle===before.handle&&current.seq===before.seq&&current.generation===before.generation&&current.digest===before.digest&&current.path===before.path;}catch{return false;}});
 }
 store<T>(owner:string,kind:OperationKind,payload:T,stamps:readonly OperationStamp[]){
  if(this.#closed||typeof owner!=='string'||!owner||owner.length>256||!['bulk','transfer'].includes(kind)||!Array.isArray(stamps)||stamps.length===0||stamps.length>100||new Set(stamps.map(stamp=>stamp.handle)).size!==stamps.length||!this.#same(stamps))return refused();
  const captured=Object.freeze(stamps.map(stamp=>Object.freeze(structuredClone(stamp)))),excluded=captured.map(stamp=>stamp.handle),now=(this.deps.now??Date.now)();
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(now+TTL))return refused();
  let detached:T;try{detached=structuredClone(payload);}catch{return refused();}
  const ownerToken=this.#owners.get(owner)??{};this.#owners.set(owner,ownerToken);this.#clear(owner);
  const record:StoredPlan<T>={id:randomUUID(),kind,payload:detached,stamps:captured,expiresAt:now+TTL,scope:this.deps.scopeStamp(excluded),ownerToken,timer:setTimeout(()=>{if(this.#plans.get(owner)===record)this.#clear(owner);},TTL)};
  record.timer.unref();this.#plans.set(owner,record);return{planId:record.id,expiresAt:record.expiresAt};
 }
 take<T>(owner:string,kind:OperationKind,id:string):BoundOperation<T>{
  const record=this.#plans.get(owner);if(this.#closed||!record||record.id!==id||record.kind!==kind)return refused();
  this.#clear(owner);
  const excluded=record.stamps.map(stamp=>stamp.handle),scopeValid=()=>{
   try{return !this.#closed&&this.#owners.get(owner)===record.ownerToken&&this.deps.scopeStamp(excluded)===record.scope;}catch{return false;}
  };
  const valid=()=>{try{return (this.deps.now??Date.now)()<record.expiresAt&&scopeValid()&&this.#same(record.stamps);}catch{return false;}};
  if(!valid())return refused();return{payload:record.payload as T,stamps:record.stamps,valid,scopeValid};
 }
 discard(owner:string,kind:OperationKind,id:string){const record=this.#plans.get(owner);if(!record||record.id!==id||record.kind!==kind)return false;this.#clear(owner);return true;}
 revoke(owner:string){this.#clear(owner);this.#owners.delete(owner);}
 close(){if(this.#closed)return;this.#closed=true;for(const owner of this.#plans.keys())this.#clear(owner);this.#owners.clear();}
}
