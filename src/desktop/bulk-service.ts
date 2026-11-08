import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {DocumentLibrary} from '../documents/library.js';
import {UUID,type ObjectNode,type Json} from '../documents/model.js';
import {isPlainRecord} from '../documents/groups.js';
import {publicPropertyValue,writablePublicProperty} from '../documents/projection.js';
import {applyBatch,type BulkAction} from '../documents/bulk.js';
import type {Props,Patch} from '../documents/ops.js';
import type {TemplateFields} from './template-service.js';
import {isPublicTokenName,type TokenContext} from '../documents/tokens.js';
import {validateTemplateSnapshot} from '../documents/templates.js';
import {checkStored,managed} from './connection-settings.js';
import {OperationPlans,type OperationStamp,type BoundOperation} from './operation-plans.js';
export type BulkTemplateRef={templateHandle:string;templateId:string;copyReferences?:boolean;values?:TokenContext;fields?:TemplateFields};
export type BulkLibrary=Pick<DocumentLibrary,'entryStamp'|'privateDocument'>&{view(id:string):{dirty:boolean};bulk(id:string,seq:number,generation:number,actions:readonly BulkAction[]):unknown;save(id:string):Promise<unknown>};
export type BulkServiceDeps={prepareTemplate(ref:BulkTemplateRef):ObjectNode;confirmReferences?(metadata:{documents:{name:string;count:number}[]}):Promise<boolean>;yield?():Promise<void>};
type Field={field:string;state:'set'|'unset'|'mixed';count:number};
type DocumentCandidate={id:string;name:string;stamp:OperationStamp;actions:BulkAction[];fields:Field[];containsPrivateData:boolean};
type Candidate={documents:DocumentCandidate[];save:boolean};
export type BulkDocumentResult={id:string;name:string;status:'pending'|'applied-memory'|'noop'|'invalid'|'cancelled';save:'not-requested'|'pending'|'saved'|'failed'|'cancelled';errorCode?:string;warnings?:string[]};
type Job={id:string;owner:string;cancelled:boolean;done:boolean;documents:BulkDocumentResult[]};
const invalid=(code='invalid'):never=>{throw Object.assign(new Error('Batch dokumen tidak dapat dilanjutkan.'),{code});};
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>isPlainRecord(value)&&Object.keys(value).every(key=>keys.includes(key));
const uuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);
const name=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256;
export class BulkService{
 #jobs=new Map<string,Job>();
 constructor(readonly library:BulkLibrary,readonly plans:OperationPlans,readonly deps:BulkServiceDeps){}
 #props(raw:unknown):Props{if(!isPlainRecord(raw)||Object.entries(raw).some(([key,value])=>!writablePublicProperty(key)||value===undefined||!publicPropertyValue(key,value as Json)))return invalid();return structuredClone(raw) as Props;}
 #patch(raw:unknown):Patch{if(!exact(raw,['set','unset']))return invalid();const set=raw.set===undefined?{}:this.#props(raw.set),unset=raw.unset===undefined?[]:raw.unset;if(!Array.isArray(unset)||unset.some(key=>typeof key!=='string'||!writablePublicProperty(key)||Object.hasOwn(set,key))||new Set(unset).size!==unset.length)return invalid();return{set,unset:unset as string[]};}
 #action(raw:unknown):BulkAction{
  if(!isPlainRecord(raw))return invalid();
  if(raw.kind==='update'){if(!exact(raw,['kind','objectId','name','patch'])||!uuid(raw.objectId)||raw.name!==undefined&&!name(raw.name))return invalid();return{kind:'update',objectId:raw.objectId,...(raw.name===undefined?{}:{name:raw.name as string}),...(raw.patch===undefined?{}:{patch:this.#patch(raw.patch)})};}
  if(raw.kind!=='create'||!exact(raw,['kind','parentId','type','name','props','templateRef'])||raw.parentId!==null&&!uuid(raw.parentId)||!['folder','connection'].includes(raw.type as string)||!name(raw.name))return invalid();
  const supplied=raw.props===undefined?{}:this.#props(raw.props);let base:Props={};
  if(raw.templateRef!==undefined){const ref=raw.templateRef;if(raw.type!=='connection'||!exact(ref,['templateHandle','templateId','copyReferences','values','fields'])||!uuid(ref.templateHandle)||!uuid(ref.templateId)||ref.copyReferences!==undefined&&typeof ref.copyReferences!=='boolean')return invalid();
   if(ref.values!==undefined&&(!isPlainRecord(ref.values)||Object.keys(ref.values).length>64||Object.entries(ref.values).some(([key,value])=>!isPublicTokenName(key)||!(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=65536))))return invalid();
   if(ref.fields!==undefined&&(!isPlainRecord(ref.fields)||Object.entries(ref.fields).some(([key,value])=>!['Name','Host','Port','UserName','Description'].includes(key)||!(typeof value==='string'&&value.length<=65536||key==='Port'&&typeof value==='number'&&Number.isFinite(value)))))return invalid();
   let node:ObjectNode;try{node=this.deps.prepareTemplate(structuredClone(ref) as BulkTemplateRef);if(node.type!=='connection')return invalid();validateTemplateSnapshot({sourceDocumentId:randomUUID(),roots:[node.id],objects:[{...node,parentId:null}]});}catch{return invalid();}
   base=structuredClone(node.props);if(ref.copyReferences!==true&&isPlainRecord(base.groups)){delete base.groups.credentials;if(!Object.keys(base.groups).length)delete base.groups;}
  }
  return{kind:'create',parentId:raw.parentId as string|null,type:raw.type as 'folder'|'connection',name:raw.name,props:{...base,...supplied}};
 }
 #budget(input:unknown){
  const stack:{value:unknown;depth:number;exit?:boolean}[]=[{value:input,depth:0}],ancestors=new Set<object>();let count=0;
  while(stack.length){const{value,depth,exit}=stack.pop()!;if(exit){ancestors.delete(value as object);continue;}if(depth>32||++count>1000000)return invalid('too-large');
   if(value!==null&&typeof value==='object'){if(ancestors.has(value)||!Array.isArray(value)&&!isPlainRecord(value))return invalid();ancestors.add(value);stack.push({value,depth,exit:true});for(const child of Array.isArray(value)?value:Object.values(value))stack.push({value:child,depth:depth+1});}
   else if(value!==undefined&&typeof value!=='string'&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isFinite(value))&&value!==null)return invalid();
  }
  let text:unknown;try{text=JSON.stringify(input);}catch{return invalid();}if(typeof text!=='string')return invalid();if(Buffer.byteLength(text)>16*1024*1024)return invalid('too-large');
 }

 preview(owner:string,input:unknown){
  this.#budget(input);
  if([...this.#jobs.values()].some(job=>job.owner===owner&&!job.done))return invalid('busy');
  if(!exact(input,['documents','save'])||!Array.isArray(input.documents)||!input.documents.length||input.documents.length>100||input.save!==undefined&&typeof input.save!=='boolean')return invalid();
  const seen=new Set<string>(),documents:DocumentCandidate[]=[];let count=0;
  for(const raw of input.documents){
   if(!exact(raw,['id','expectedSeq','actions'])||!uuid(raw.id)||!Number.isSafeInteger(raw.expectedSeq)||(raw.expectedSeq as number)<0||!Array.isArray(raw.actions)||!raw.actions.length||seen.has(raw.id))return invalid();seen.add(raw.id);count+=raw.actions.length;if(count>10000)return invalid('too-many');
   const source=this.library.privateDocument(raw.id);if(source.seq!==raw.expectedSeq)return invalid('stale');if(source.doc.schemaVersion!==2||source.doc.kind!=='workspace')return invalid();
   const stamp=this.library.entryStamp(raw.id);if(stamp.requiresReopen)return invalid('reopen-required');const actions=raw.actions.map(action=>this.#action(action));let result:ReturnType<typeof applyBatch>;try{result=applyBatch(source.doc,actions,{newId:randomUUID});}catch{return invalid();}
   for(const id of result.createdIds){const node=result.doc.objects[id]!;if(node.type==='connection'&&checkStored(node.props).length)return invalid();}
   for(const action of actions)if(action.kind==='update'&&[...Object.keys(action.patch?.set??{}),...(action.patch?.unset??[])].some(key=>managed.includes(key))){const node=result.doc.objects[action.objectId]!;if(node.type==='connection'&&checkStored(node.props).length)return invalid();}
   const fields=new Set<string>(),ids=new Set(actions.flatMap(action=>action.kind==='update'?[action.objectId]:[]));for(const id of result.createdIds)ids.add(id);
   for(const action of actions){if(action.name!==undefined)fields.add('name');for(const key of action.kind==='create'?Object.keys(action.props??{}):[...Object.keys(action.patch?.set??{}),...(action.patch?.unset??[])])if(writablePublicProperty(key))fields.add(key);}
   const nodes=[...ids].map(id=>result.doc.objects[id]!),summary:Field[]=[...fields].map(field=>{const values=nodes.map(node=>field==='name'?node.name:node.props[field]),first=values[0];return{field,state:values.every(value=>value===undefined)?'unset':values.every(value=>isDeepStrictEqual(value,first))?'set':'mixed',count:nodes.length};});
   documents.push({id:raw.id,name:source.doc.name,stamp,actions,fields:summary,containsPrivateData:actions.some(action=>action.kind==='create'&&isPlainRecord(action.props?.groups)&&action.props.groups.credentials!==undefined)});
  }
  const receipt=this.plans.store(owner,'bulk',{documents,save:input.save===true} satisfies Candidate,documents.map(document=>document.stamp));return{...receipt,count,documents:documents.map(document=>({id:document.id,name:document.name,count:document.actions.length,fields:document.fields,containsPrivateData:document.containsPrivateData}))};
 }
 #job(owner:string,input:unknown){if(!exact(input,['jobId'])||!uuid(input.jobId))return invalid();const job=this.#jobs.get(input.jobId);if(!job||job.owner!==owner)return invalid('missing');return job;}
 #same(stamp:OperationStamp){try{const now=this.library.entryStamp(stamp.handle);return !stamp.requiresReopen&&!now.requiresReopen&&now.seq===stamp.seq&&now.generation===stamp.generation&&now.path===stamp.path&&now.digest===stamp.digest;}catch{return false;}}
 apply(owner:string,input:unknown){
  if([...this.#jobs.values()].some(job=>job.owner===owner&&!job.done))return invalid('busy');if(!exact(input,['planId'])||!uuid(input.planId))return invalid();const bound=this.plans.take<Candidate>(owner,'bulk',input.planId),job:Job={id:randomUUID(),owner,cancelled:false,done:false,documents:bound.payload.documents.map(document=>({id:document.id,name:document.name,status:'pending',save:'not-requested'}))};
  for(const[id,prior]of this.#jobs)if(prior.owner===owner&&prior.done)this.#jobs.delete(id);this.#jobs.set(job.id,job);void this.#run(job,bound);return{jobId:job.id};
 }
 async #run(job:Job,bound:BoundOperation<Candidate>){
  const receipts=new Map(bound.stamps.map(stamp=>[stamp.handle,stamp])),allCurrent=()=>[...receipts.values()].every(stamp=>this.#same(stamp));
  const privateDocuments=bound.payload.documents.filter(document=>document.containsPrivateData);
  if(privateDocuments.length){
   const finish=(code:string,cancelled=false)=>{for(const result of job.documents){result.status=cancelled?'cancelled':'invalid';if(!cancelled)result.errorCode=code;}job.done=true;};
   let approved:boolean;try{approved=await this.deps.confirmReferences?.({documents:privateDocuments.map(document=>({name:document.name,count:document.actions.filter(action=>action.kind==='create'&&isPlainRecord(action.props?.groups)&&action.props.groups.credentials!==undefined).length}))})===true;}catch{finish('io');return;}
   if(job.cancelled){finish('cancelled',true);return;}if(!approved){finish('scope-denied');return;}if(!bound.scopeValid()){finish('scope-denied');return;}if(!bound.valid()){finish('stale');return;}
  }
  const pause=this.deps.yield??(()=>new Promise<void>(resolve=>setImmediate(resolve)));
  let accepted=false;for(let i=0;i<bound.payload.documents.length;i++){
   const document=bound.payload.documents[i]!,result=job.documents[i]!;if(job.cancelled){result.status='cancelled';continue;}
   try{
    await pause();if(job.cancelled){result.status='cancelled';continue;}if(!bound.scopeValid()){result.status='invalid';result.errorCode='scope-denied';continue;}if(!allCurrent()||!accepted&&!bound.valid()){result.status='invalid';result.errorCode='stale';continue;}
    this.library.bulk(document.id,document.stamp.seq,document.stamp.generation,document.actions);const committed=this.library.entryStamp(document.id);receipts.set(document.id,committed);accepted=true;result.status=committed.seq===document.stamp.seq?'noop':'applied-memory';
    if(bound.payload.save){result.save='pending';await pause();if(job.cancelled){result.save='cancelled';continue;}if(!bound.scopeValid()){result.save='failed';result.errorCode='scope-denied';continue;}if(!allCurrent()){result.save='failed';result.errorCode='stale';continue;}
     const content=structuredClone(this.library.privateDocument(document.id).doc);let savedCompleted=false;
     try{const saved=await this.library.save(document.id);if(isPlainRecord(saved)&&saved.saved===false){result.save='failed';result.errorCode='conflict';continue;}result.save='saved';savedCompleted=true;
      const ownLineage=!isPlainRecord(saved)||saved.delta===undefined||isPlainRecord(saved.delta)&&saved.delta.from===committed.seq;
      const current=this.library.privateDocument(document.id).doc,otherReceiptsCurrent=[...receipts.values()].every(stamp=>stamp.handle===document.id||this.#same(stamp));
      const supplied=isPlainRecord(saved)&&isPlainRecord(saved.writeReceipt)?saved.writeReceipt as unknown as OperationStamp:undefined,receiptCurrent=supplied?.handle===document.id&&this.#same(supplied),unchangedReceipt=this.#same(committed);
      if(ownLineage&&this.library.view(document.id).dirty===false&&isDeepStrictEqual({...content,revision:0},{...current,revision:0})&&otherReceiptsCurrent&&bound.scopeValid()&&(receiptCurrent||unchangedReceipt)){if(receiptCurrent)receipts.set(document.id,supplied!);}else result.errorCode=bound.scopeValid()?'stale':'scope-denied';
      if(isPlainRecord(saved)&&Array.isArray(saved.warnings)){const warnings=saved.warnings.map(code=>typeof code==='string'&&['commit-observed-after-error','lock-release-failed'].includes(code)?code:'bulk-warning');if(warnings.length)result.warnings=[...new Set(warnings)];}}
     catch(error){if(!savedCompleted)result.save='failed';result.errorCode=savedCompleted?'stale':(error as {requiresReopen?:unknown})?.requiresReopen===true?'reopen-required':'io';}
    }
   }catch(error){if(result.status==='pending')result.status='invalid';if(result.save==='pending')result.save='failed';const code=(error as {code?:unknown})?.code;result.errorCode=typeof code==='string'&&['invalid','stale','busy','reopen-required','scope-denied'].includes(code)?code:'invalid';}
  }
  job.done=true;
 }
 progress(owner:string,input:unknown){const job=this.#job(owner,input);return{jobId:job.id,done:job.done,documents:structuredClone(job.documents)};}
 cancel(owner:string,input:unknown){const job=this.#job(owner,input);job.cancelled=true;return{cancelled:true};}
 close(owner:string){for(const[id,job]of this.#jobs)if(job.owner===owner){job.cancelled=true;this.#jobs.delete(id);}this.plans.revoke(owner);}
}
