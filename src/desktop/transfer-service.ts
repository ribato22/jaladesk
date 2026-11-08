import {randomUUID} from 'node:crypto';
import type {DocumentLibrary} from '../documents/library.js';
import {UUID} from '../documents/model.js';
import {isPlainRecord} from '../documents/groups.js';
import {prepareTransfer,type PreparedTransfer} from '../documents/transfer.js';
import {OperationPlans,type OperationStamp} from './operation-plans.js';
export type TransferMetadata={sourceName:string;destinationName:string;mode:'copy'|'move';count:number;containsSecrets:boolean;containsPrivateData:boolean;sourceReferencesAffected:number;sourceScopeDependencies:number};
export type TransferServiceDeps={newId?():string;confirmPrivate(metadata:TransferMetadata):Promise<boolean>;confirmMove(metadata:TransferMetadata):Promise<boolean>};
type Candidate={source:OperationStamp;destination:OperationStamp;prepared:PreparedTransfer;mode:'copy'|'move';copyPrivate:boolean;canApply:boolean;blockedReason?:'private-consent'|'source-references';metadata:TransferMetadata};
export type TransferCommit={source:OperationStamp;destination:OperationStamp;prepared:PreparedTransfer;mode:'copy'|'move';confirmMove():Promise<boolean>;cancelled():boolean;scopeValid():boolean};
export type TransferLibrary=Pick<DocumentLibrary,'views'|'view'|'privateDocument'|'privateDocuments'|'entryStamp'>&{transfer(input:TransferCommit):Promise<unknown>};
export type TransferResultView={destination:string;sourceDisk:string;sourceMemory:string;stage:string;errorCode?:string;warnings:string[];status?:'cancelled'|'partial';cancelled?:true};
const invalid=(code='invalid'):never=>{throw Object.assign(new Error('Perpindahan dokumen tidak dapat dilanjutkan.'),{code});};
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>isPlainRecord(value)&&Object.keys(value).every(key=>keys.includes(key));
const uuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);
export class TransferService{
 #active=new Map<string,{owner:string;cancelled:boolean}>();
 constructor(readonly library:TransferLibrary,readonly plans:OperationPlans,readonly deps:TransferServiceDeps){}
 sources(){
  return this.library.views().map(view=>{
   const doc=view.requiresReopen?undefined:this.library.privateDocument(view.id).doc;
   return{id:view.id,seq:view.seq,name:view.name,dirty:view.dirty,conflicts:view.conflicts,...(view.upgradeRequired?{upgradeRequired:true as const}:{}),...(view.requiresReopen?{requiresReopen:true as const}:{}),objects:doc?Object.values(doc.objects).map(node=>({id:node.id,name:node.name,type:node.type,parentId:node.parentId})):[]};
  });
 }
 #busy(owner:string){return [...this.#active.values()].some(active=>active.owner===owner);}
 preview(owner:string,input:unknown){
  if(this.#busy(owner))return invalid('busy');
  if(!exact(input,['sourceId','sourceSeq','destinationId','destinationSeq','objectIds','parentId','mode','copyPrivate'])||!uuid(input.sourceId)||!uuid(input.destinationId)||input.sourceId===input.destinationId||!Number.isSafeInteger(input.sourceSeq)||(input.sourceSeq as number)<0||!Number.isSafeInteger(input.destinationSeq)||(input.destinationSeq as number)<0||!Array.isArray(input.objectIds)||!input.objectIds.length||input.objectIds.length>10000||input.objectIds.some(id=>!uuid(id))||(input.parentId!==undefined&&input.parentId!==null&&!uuid(input.parentId))||!['copy','move'].includes(input.mode as string)||typeof input.copyPrivate!=='boolean')return invalid();
  const sourceView=this.library.view(input.sourceId),destinationView=this.library.view(input.destinationId);
  if(sourceView.seq!==input.sourceSeq||destinationView.seq!==input.destinationSeq)return invalid('stale');
  if(sourceView.requiresReopen||destinationView.requiresReopen)return invalid('reopen-required');
  if(sourceView.upgradeRequired||destinationView.upgradeRequired)return invalid('upgrade-required');
  if(sourceView.dirty||destinationView.dirty||sourceView.conflicts||destinationView.conflicts)return invalid('unsaved');
  const source=this.library.privateDocument(input.sourceId),destination=this.library.privateDocument(input.destinationId);
  if(source.doc.schemaVersion!==2||destination.doc.schemaVersion!==2)return invalid('upgrade-required');
  let prepared:PreparedTransfer;
  try{prepared=prepareTransfer(source.doc,destination.doc,input.objectIds as string[],{newId:this.deps.newId??randomUUID,parentId:input.parentId as string|null|undefined,copySecrets:true,availableDocuments:this.library.privateDocuments().flatMap(state=>state.doc.schemaVersion===2?[state.doc]:[])});}catch{return invalid();}
  const preview=prepared.preview,needsPrivate=preview.containsSecrets||preview.containsPrivateData,blockedReason=input.mode==='move'&&!preview.sourceCanRemove?'source-references' as const:needsPrivate&&!input.copyPrivate?'private-consent' as const:undefined;
  const metadata:TransferMetadata={sourceName:sourceView.name,destinationName:destinationView.name,mode:input.mode as 'copy'|'move',count:preview.count,containsSecrets:preview.containsSecrets,containsPrivateData:preview.containsPrivateData,sourceReferencesAffected:preview.sourceReferencesAffected,sourceScopeDependencies:preview.sourceScopeDependencies};
  const candidate:Candidate={source:this.library.entryStamp(input.sourceId),destination:this.library.entryStamp(input.destinationId),prepared,mode:input.mode as 'copy'|'move',copyPrivate:input.copyPrivate,canApply:blockedReason===undefined,...(blockedReason?{blockedReason}:{}),metadata};
  const receipt=this.plans.store(owner,'transfer',candidate,[candidate.source,candidate.destination]);
  return{...receipt,count:preview.count,containsSecrets:preview.containsSecrets,containsPrivateData:preview.containsPrivateData,externalReferences:preview.externalReferences,missingReferences:preview.missingReferences,unavailableSources:preview.unavailableSources,sourceScopeDependencies:preview.sourceScopeDependencies,sourceReferencesAffected:preview.sourceReferencesAffected,sourceCanRemove:preview.sourceCanRemove,inheritanceMayChange:preview.inheritanceMayChange,privateOverridesCopied:false as const,canApply:candidate.canApply,requiresPrivateConsent:needsPrivate&&!input.copyPrivate,...(blockedReason?{blockedReason}:{})};
 }
 #planId(input:unknown){if(!exact(input,['planId'])||!uuid(input.planId))return invalid();return input.planId;}
 #result(value:unknown):TransferResultView{
  if(!isPlainRecord(value)||typeof value.destination!=='string'||!['unchanged','memory','saved','verified','uncertain'].includes(value.destination)||typeof value.sourceDisk!=='string'||!['retained','removed-saved','uncertain'].includes(value.sourceDisk)||typeof value.sourceMemory!=='string'||!['unchanged','removal-pending','removed'].includes(value.sourceMemory))return invalid('io');
  const stages=['prepared','destination-write','destination-readback','private-consent','move-cancelled','source-check','source-write','complete','cancelled','destination-uncertain','source-uncertain'];
  const stage=typeof value.stage==='string'&&stages.includes(value.stage)?value.stage:'uncertain';
  const errorCode=value.errorCode===undefined?undefined:typeof value.errorCode==='string'&&['invalid','stale','busy','io','reopen-required','cancelled','scope-denied'].includes(value.errorCode)?value.errorCode:'io';
  const warnings=Array.isArray(value.warnings)?[...new Set(value.warnings.map(code=>typeof code==='string'&&['commit-observed-after-error','lock-release-failed','reopen-required'].includes(code)?code:'transfer-warning'))]:value.warnings===undefined?[]:['transfer-warning'];
  const cancelled=value.cancelled===true||value.status==='cancelled'||stage==='cancelled'||stage==='move-cancelled'||errorCode==='cancelled';
  return{destination:value.destination as string,sourceDisk:value.sourceDisk as string,sourceMemory:value.sourceMemory as string,stage,...(errorCode?{errorCode}:{}),warnings,...(cancelled?{status:'cancelled' as const,cancelled:true as const}:value.status==='partial'||errorCode||stage==='uncertain'||stage.endsWith('-uncertain')?{status:'partial' as const}:{})};
 }
 async apply(owner:string,input:unknown){
  if(this.#busy(owner))return invalid('busy');const planId=this.#planId(input),bound=this.plans.take<Candidate>(owner,'transfer',planId),candidate=bound.payload;
  if(!candidate.canApply)return invalid(candidate.blockedReason==='source-references'?'invalid':'scope-denied');
  const active={owner,cancelled:false};this.#active.set(planId,active);
  const cancelled=()=>this.#result({destination:'unchanged',sourceDisk:'retained',sourceMemory:'unchanged',stage:'cancelled',cancelled:true});
  try{
   if(candidate.prepared.preview.containsSecrets||candidate.prepared.preview.containsPrivateData){
    let approved:boolean;try{approved=typeof this.deps.confirmPrivate==='function'&&await this.deps.confirmPrivate(structuredClone(candidate.metadata));}catch{return invalid('io');}
    if(!approved||active.cancelled)return cancelled();
   }
   if(active.cancelled)return cancelled();if(!bound.valid())return invalid('stale');
   let result:unknown;
   try{result=await this.library.transfer({source:candidate.source,destination:candidate.destination,prepared:candidate.prepared,mode:candidate.mode,cancelled:()=>active.cancelled,scopeValid:()=>bound.scopeValid(),confirmMove:async()=>{
    if(active.cancelled)return false;if(!bound.scopeValid())return invalid('stale');
    const approved=await this.deps.confirmMove(structuredClone(candidate.metadata));
    if(!approved||active.cancelled)return false;if(!bound.scopeValid())return invalid('stale');return true;
   }});}catch(error){const code=(error as {code?:unknown})?.code;return invalid(typeof code==='string'&&['invalid','stale','busy','io','reopen-required','cancelled','scope-denied'].includes(code)?code:'io');}
   return this.#result(result);
  }finally{this.#active.delete(planId);}
 }
 cancel(owner:string,input:unknown){
  const planId=this.#planId(input),active=this.#active.get(planId);
  if(active?.owner===owner){active.cancelled=true;return{cancelled:true};}
  return{cancelled:this.plans.discard(owner,'transfer',planId)};
 }
 close(owner:string){for(const active of this.#active.values())if(active.owner===owner)active.cancelled=true;this.plans.revoke(owner);}
}
