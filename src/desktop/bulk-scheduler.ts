import {randomUUID} from 'node:crypto';
import type {DocumentLibrary} from '../documents/library.js';
import {UUID} from '../documents/model.js';
import {isPlainRecord} from '../documents/groups.js';
import {selectedConnections} from '../documents/bulk.js';
export type BulkTarget={documentHandle:string;objectId:string;expectedSeq:number};
export type BulkConnectionState=BulkTarget&{target:string;status:'pending'|'connecting'|'connected'|'failed'|'cancelled'|'disconnected';sessionId?:string;errorCode?:string};
export type EstablishedStored={sessionId:string;established:Promise<'connected'|'failed'|'closed'>;close():Promise<void>};
export type BulkSchedulerDeps={library:Pick<DocumentLibrary,'privateDocument'>;beginStored(ref:BulkTarget,signal:AbortSignal):Promise<EstablishedStored>};
type Job={id:string;owner:string;states:BulkConnectionState[];cancelled:boolean;done:boolean;controllers:Map<string,AbortController>;handles:Map<string,EstablishedStored>;closing:Map<string,Promise<void>>};
const invalid=(code='invalid'):never=>{throw Object.assign(new Error('Antrean koneksi tidak dapat dilanjutkan.'),{code});};
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>isPlainRecord(value)&&Object.keys(value).every(key=>keys.includes(key));
export class BulkScheduler{
 #jobs=new Map<string,Job>();#slots=2;#waiting:{job:Job;ready(release:(()=>void)|undefined):void}[]=[];
 #release=()=>{const waiter=this.#waiting.shift();if(waiter)waiter.ready(this.#release);else this.#slots++;};
 #take(job:Job):Promise<(()=>void)|undefined>{if(job.cancelled)return Promise.resolve(undefined);if(this.#slots){this.#slots--;return Promise.resolve(this.#release);}return new Promise(resolve=>this.#waiting.push({job,ready:resolve}));}
 constructor(readonly deps:BulkSchedulerDeps){}
 #job(owner:string,input:unknown){if(!exact(input,['jobId'])||typeof input.jobId!=='string')return invalid();const job=this.#jobs.get(input.jobId);if(!job||job.owner!==owner)return invalid('missing');return job;}
 #refs(input:unknown){
  if(!exact(input,['targets'])||!Array.isArray(input.targets)||!input.targets.length||input.targets.length>64)return invalid();
  const refs=new Map<string,BulkTarget>();
  for(const raw of input.targets){
   if(!exact(raw,['documentHandle','objectId','expectedSeq'])||typeof raw.documentHandle!=='string'||!UUID.test(raw.documentHandle)||typeof raw.objectId!=='string'||!UUID.test(raw.objectId)||!Number.isSafeInteger(raw.expectedSeq)||(raw.expectedSeq as number)<0)return invalid();
   const current=this.deps.library.privateDocument(raw.documentHandle);if(current.seq!==raw.expectedSeq)return invalid('stale');if(current.doc.schemaVersion!==2||current.doc.kind!=='workspace')return invalid();
   for(const objectId of selectedConnections(current.doc,[raw.objectId])){const target=`${raw.documentHandle}:${objectId}`;if(refs.has(target)&&refs.get(target)!.expectedSeq!==raw.expectedSeq)return invalid('stale');refs.set(target,{documentHandle:raw.documentHandle,objectId,expectedSeq:raw.expectedSeq as number});if(refs.size>64)return invalid('too-many');}
  }
  if(!refs.size)return invalid();return [...refs.values()];
 }
 start(owner:string,input:unknown){
  if([...this.#jobs.values()].some(job=>job.owner===owner&&!job.done))return invalid('busy');const refs=this.#refs(input),job:Job={id:randomUUID(),owner,states:refs.map(ref=>({...ref,target:`${ref.documentHandle}:${ref.objectId}`,status:'pending'})),cancelled:false,done:false,controllers:new Map(),handles:new Map(),closing:new Map()};this.#jobs.set(job.id,job);
  let next=0;const worker=async()=>{while(next<job.states.length){const state=job.states[next++]!,release=await this.#take(job);if(!release)continue;let abort:()=>void=()=>{};try{
   if(job.cancelled)continue;state.status='connecting';const controller=new AbortController();job.controllers.set(state.target,controller);
   const handle=await this.deps.beginStored({documentHandle:state.documentHandle,objectId:state.objectId,expectedSeq:state.expectedSeq},controller.signal);job.handles.set(state.target,handle);state.sessionId=handle.sessionId;
   if(controller.signal.aborted){const early=await Promise.race([handle.established,Promise.resolve(undefined)]);if(early==='connected')state.status='connected';else await this.#close(job,state);continue;}
   const stopped=new Promise<'cancelled'>(resolve=>{abort=()=>resolve('cancelled');controller.signal.addEventListener('abort',abort,{once:true});});
   const established=await Promise.race([handle.established,stopped]);
   if(established==='connected'){state.status='connected';continue;}if(controller.signal.aborted||established==='cancelled'){await this.#close(job,state);continue;}
   state.status='failed';state.errorCode='connection';
  }catch(error){if(state.errorCode!=='close-failed'){state.status=job.cancelled||(error as {code?:string})?.code==='cancelled'?'cancelled':'failed';state.errorCode=state.status==='failed'?'connection':undefined;}}
  finally{job.controllers.get(state.target)?.signal.removeEventListener('abort',abort);job.controllers.delete(state.target);if(state.status!=='connected')job.handles.delete(state.target);release();}}};
  void Promise.all([worker(),worker()]).then(()=>{job.done=true;});return{jobId:job.id};
 }
 #close(job:Job,state:BulkConnectionState){
  const handle=job.handles.get(state.target);if(!handle)return Promise.resolve();let closing=job.closing.get(state.target);
  if(!closing){closing=Promise.resolve().then(()=>handle.close()).catch(()=>{state.status='failed';state.errorCode='close-failed';});job.closing.set(state.target,closing);}return closing;
 }

 progress(owner:string,input:unknown){const job=this.#job(owner,input);return{jobId:job.id,done:job.done,targets:structuredClone(job.states)};}
 cancel(owner:string,input:unknown){const job=this.#job(owner,input);job.cancelled=true;for(let i=this.#waiting.length-1;i>=0;i--){const waiting=this.#waiting[i]!;if(waiting.job===job){this.#waiting.splice(i,1);waiting.ready(undefined);}}for(const state of job.states){if(state.status==='pending')state.status='cancelled';else if(state.status==='connecting'){state.status='cancelled';job.controllers.get(state.target)?.abort();}}return{cancelled:true};}
 retry(owner:string,input:unknown){const prior=this.#job(owner,input);if(!prior.done)return invalid('busy');const failed=prior.states.filter(state=>state.status==='failed');if(!failed.length)return invalid();if(failed.some(state=>state.errorCode==='close-failed'))return invalid('busy');return this.start(owner,{targets:failed.map(state=>({documentHandle:state.documentHandle,objectId:state.objectId,expectedSeq:this.deps.library.privateDocument(state.documentHandle).seq}))});}
 async disconnect(owner:string,input:unknown){
  if(!exact(input,['jobId','targets'])||input.targets!==undefined&&(!Array.isArray(input.targets)||input.targets.length>64||input.targets.some(target=>typeof target!=='string')))return invalid();const job=this.#job(owner,{jobId:input.jobId});const targets=input.targets===undefined?undefined:new Set(input.targets as string[]);if(targets&&[...targets].some(target=>!job.states.some(state=>state.target===target)))return invalid();
  for(const state of job.states)if(state.status==='connected'&&(!targets||targets.has(state.target))){await this.#close(job,state);if(state.errorCode!=='close-failed'){state.status='disconnected';job.handles.delete(state.target);}else state.status='connected';}return{disconnected:true};
 }
 close(owner:string){for(const[id,job]of this.#jobs)if(job.owner===owner){this.cancel(owner,{jobId:id});this.#jobs.delete(id);}}
}
