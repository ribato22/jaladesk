import {randomUUID} from 'node:crypto';
import type {DocumentWatcher,WatchNotice} from '../documents/watch.js';
import {isPlainRecord} from '../documents/groups.js';
import {UUID} from '../documents/model.js';
type DocumentView={id:string;name:string;seq:number;dirty:boolean;upgradeRequired?:true};
export type MaintenanceStamp={handle:string;seq:number;generation:number;digest:string;path:string;requiresReopen?:true};
export type MaintenanceLibrary={
 views():DocumentView[];view(id:string):DocumentView;
 entryStamp(id:string):MaintenanceStamp;writing(id:string):boolean;
 onChange(listener:(event:{id:string;closed?:true})=>void):()=>void;
 changePassword(input:{id:string;expectedSeq:number;expectedGeneration:number;oldPassword:string;newPassword:string}):Promise<{warnings:readonly string[]}>;
};
export type DocumentMaintenanceDeps={
 askPassword(purpose:'old'|'new',name:string):Promise<string|undefined>;
 forget(path:string):Promise<unknown>;
 watcher:Pick<DocumentWatcher,'start'|'stop'|'subscribe'|'close'>;refresh?():void;
};
const invalid=(code='invalid'):never=>{throw Object.assign(new Error('Pemeliharaan dokumen tidak dapat dilanjutkan.'),{code});};
export class DocumentMaintenance{
 #watching=new Map<string,string>();
 #notices=new Map<string,{notice:WatchNotice;digest:string}>();
 #versions=new Map<string,{generation:number;version:string}>();
 #reopen=new Set<string>();
 #pending=false;
 #closed=false;
 #unsubscribeLibrary:()=>void;
 #unsubscribeWatcher:()=>void;
 constructor(readonly library:MaintenanceLibrary,readonly deps:DocumentMaintenanceDeps){
  this.#unsubscribeWatcher=deps.watcher.subscribe(notice=>this.#receive(notice));
  this.#unsubscribeLibrary=library.onChange(event=>{if(event.closed)this.#stop(event.id);else this.sync();});
  this.sync();
 }
 #stop(id:string){
  if(this.#watching.delete(id))this.deps.watcher.stop(id);
  this.#notices.delete(id);this.#versions.delete(id);this.#reopen.delete(id);
 }
 #receive(notice:WatchNotice){
  if(this.#closed||!this.#watching.has(notice.id)||!['changed','missing','unreadable'].includes(notice.status))return;
  let stamp:MaintenanceStamp,view:DocumentView;try{stamp=this.library.entryStamp(notice.id);view=this.library.view(notice.id);}catch{return;}
  const safe:WatchNotice={id:notice.id,status:notice.status,dirty:view.dirty,actions:['reload','save-merge']};
  const prior=this.#notices.get(notice.id);
  if(prior?.digest===stamp.digest&&prior.notice.status===safe.status&&prior.notice.dirty===safe.dirty)return;
  this.#notices.set(notice.id,{notice:safe,digest:stamp.digest});this.#versions.delete(notice.id);
  try{this.deps.refresh?.();}catch{/* The notice remains readable if a UI push fails. */}
 }
 sync(){
  if(this.#closed)return;
  const open=this.library.views(),ids=new Set(open.map(view=>view.id));
  for(const id of this.#watching.keys())if(!ids.has(id))this.#stop(id);
  for(const view of open){
   const stamp=this.library.entryStamp(view.id),prior=this.#notices.get(view.id);
   if(stamp.requiresReopen||this.#reopen.has(view.id)){
    if(this.#watching.delete(view.id))this.deps.watcher.stop(view.id);
    this.#notices.delete(view.id);continue;
   }
   if(prior&&prior.digest!==stamp.digest){this.#notices.delete(view.id);this.#versions.delete(view.id);}
   if(this.#watching.has(view.id))continue;
   try{
    this.deps.watcher.start(view.id,stamp.path,{digest:()=>this.library.entryStamp(view.id).digest,dirty:()=>this.library.view(view.id).dirty,writing:()=>this.library.writing(view.id)});
    this.#watching.set(view.id,stamp.path);
   }catch{
    this.#notices.set(view.id,{notice:{id:view.id,status:'unreadable',dirty:view.dirty,actions:['reload','save-merge']},digest:stamp.digest});
   }
  }
 }
 view(id:string){
  if(this.#closed)return invalid('missing');this.sync();
  const view=this.library.view(id),stamp=this.library.entryStamp(id);let held=this.#versions.get(id);
  if(!held||held.generation!==stamp.generation){held={generation:stamp.generation,version:randomUUID()};this.#versions.set(id,held);}
  return{id,seq:view.seq,maintenanceVersion:held.version,dirty:view.dirty,...(stamp.requiresReopen||this.#reopen.has(id)?{requiresReopen:true as const}:{}),...(this.#notices.has(id)?{status:this.#notices.get(id)!.notice.status,actions:['reload','save-merge'] as const}:{})};
 }
 listNotices(){
  this.sync();return [...this.#notices.values()].map(({notice})=>({...notice,dirty:this.library.view(notice.id).dirty,actions:['reload','save-merge'] as ['reload','save-merge']}));
 }
 close(){
  if(this.#closed)return;this.#closed=true;
  this.#unsubscribeLibrary();this.#unsubscribeWatcher();this.deps.watcher.close();this.#watching.clear();this.#notices.clear();this.#versions.clear();this.#reopen.clear();
 }
 #state(ref:{id:string;expectedSeq:number;expectedMaintenanceVersion:string}){
  if(this.#closed)return invalid('missing');
  if(typeof ref.id!=='string'||!UUID.test(ref.id)||!Number.isSafeInteger(ref.expectedSeq)||ref.expectedSeq<0||typeof ref.expectedMaintenanceVersion!=='string'||!UUID.test(ref.expectedMaintenanceVersion))return invalid();
  let stamp:MaintenanceStamp,view:DocumentView;try{stamp=this.library.entryStamp(ref.id);view=this.library.view(ref.id);}catch{return invalid('stale');}
  const held=this.#versions.get(ref.id);
  if(stamp.seq!==ref.expectedSeq||!held||held.version!==ref.expectedMaintenanceVersion||held.generation!==stamp.generation)return invalid('stale');
  return{stamp,view};
 }
 async changePassword(input:unknown){
  if(this.#pending)return invalid('busy');this.#pending=true;
  try{
   if(!isPlainRecord(input)||Object.keys(input).some(key=>!['id','expectedSeq','expectedMaintenanceVersion'].includes(key)))return invalid();
   const ref=input as {id:string;expectedSeq:number;expectedMaintenanceVersion:string},state=this.#state(ref);
   if(state.stamp.requiresReopen||this.#reopen.has(ref.id))return{status:'reopen-required' as const,warnings:['reopen-required']};
   if(state.view.upgradeRequired)return invalid('upgrade-required');
   const oldPassword=await this.deps.askPassword('old',state.view.name);if(oldPassword===undefined)return{status:'cancelled' as const};this.#state(ref);
   if(typeof oldPassword!=='string'||oldPassword.length===0||oldPassword.length>65536)return invalid();
   const newPassword=await this.deps.askPassword('new',state.view.name);if(newPassword===undefined)return{status:'cancelled' as const};this.#state(ref);
   if(typeof newPassword!=='string'||newPassword.length===0||newPassword.length>65536)return invalid();
   let result:{warnings:readonly string[]};
   try{result=await this.library.changePassword({id:ref.id,expectedSeq:ref.expectedSeq,expectedGeneration:state.stamp.generation,oldPassword,newPassword});}
   catch(error){
    if((error as {requiresReopen?:unknown})?.requiresReopen===true){this.#reopen.add(ref.id);this.#versions.delete(ref.id);this.sync();return{status:'reopen-required' as const,warnings:['reopen-required']};}
    const code=(error as {code?:unknown})?.code;return invalid(typeof code==='string'&&['wrong-password','busy','stale','invalid','io','upgrade-required','rekeyed','unsaved','missing','not-found'].includes(code)?code:'io');
   }
   this.#versions.delete(ref.id);
   const warnings=[...new Set(result.warnings.map(code=>['commit-observed-after-error','lock-release-failed'].includes(code)?code:'maintenance-warning'))];
   try{await this.deps.forget(state.stamp.path);}catch{warnings.push('cache-forget-failed');}
   this.sync();try{this.deps.refresh?.();}catch{/* A committed key change is still committed when UI refresh fails. */}
   return{status:'changed' as const,warnings};
  }finally{this.#pending=false;}
 }
}
