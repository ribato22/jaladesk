import test from 'node:test';import assert from 'node:assert/strict';
import {DocumentMaintenance} from '../src/desktop/document-maintenance.js';
import {DocumentLibrary} from '../src/documents/library.js';
import {DocumentSession} from '../src/documents/session.js';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
const id='00000000-0000-4000-8000-000000000001';
class LibraryFixture{
 doc={id,name:'Dokumen sintetis',seq:1,dirty:false};generation=1;digest='cipher-1';closed=false;writingNow=false;listeners=new Set<(event:any)=>void>();calls:any[]=[];
 views(){return this.closed?[]:[{...this.doc}];}
 view(handle:string){if(this.closed||handle!==id)throw Error('closed');return {...this.doc};}
 entryStamp(handle:string){this.view(handle);return{handle,seq:this.doc.seq,generation:this.generation,digest:this.digest,path:'/synthetic/private-document.rwdoc'};}
 writing(handle:string){this.view(handle);return this.writingNow;}
 onChange(listener:(event:any)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 emit(event:any={id,dirty:this.doc.dirty,conflicts:0}){for(const listener of this.listeners)listener(event);}
 async changePassword(request:any){this.calls.push(request);this.generation++;this.digest='cipher-2';this.emit();return{warnings:[] as string[]};}
}
function fixture(){
 const library=new LibraryFixture(),started=new Map<string,{path:string;state:any}>(),stopped:string[]=[],questions:string[]=[],forgotten:string[]=[];let listener:(notice:any)=>void=()=>{};let watcherClosed=false;
 const watcher={start:(id:string,path:string,state:any)=>{started.set(id,{path,state});},stop:(id:string)=>{started.delete(id);stopped.push(id);},subscribe:(fn:(notice:any)=>void)=>{listener=fn;return()=>{listener=()=>{};};},close:()=>{watcherClosed=true;started.clear();}};
 const deps={watcher,askPassword:async(purpose:'old'|'new',_name:string):Promise<string|undefined>=>{questions.push(purpose);return purpose==='old'?'SYNTHETIC-OLD':'SYNTHETIC-NEW';},forget:async(path:string)=>{forgotten.push(path);},refresh:()=>{}};
 const service=new DocumentMaintenance(library,deps);
 const request=()=>{const view=service.view(id);return{id,expectedSeq:view.seq,expectedMaintenanceVersion:view.maintenanceVersion};};
 return{library,service,deps,started,stopped,questions,forgotten,request,notice:(value:any)=>listener(value),watcherClosed:()=>watcherClosed};
}
test('maintenance watches open documents and keeps safe notices separate from secret or filesystem data',()=>{
 const f=fixture();assert.equal(f.started.size,1);const state=f.started.get(id)!.state;assert.equal(state.digest(),'cipher-1');assert.equal(state.dirty(),false);assert.equal(state.writing(),false);
 let before=f.service.view(id);assert.equal(before.id,id);assert.match(before.maintenanceVersion,/^[0-9a-f-]{36}$/);f.library.generation++;f.library.emit();assert.notEqual(f.service.view(id).maintenanceVersion,before.maintenanceVersion);before=f.service.view(id);
 f.notice({id,status:'changed',dirty:false,actions:['reload','save-merge'],path:'/private/leak',content:'SYNTHETIC-SECRET'});
 assert.deepEqual(f.service.listNotices(),[{id,status:'changed',dirty:false,actions:['reload','save-merge']}]);assert.equal(JSON.stringify(f.service.view(id)).includes('/synthetic'),false);assert.equal(JSON.stringify(f.service.view(id)).includes('SYNTHETIC-SECRET'),false);assert.notEqual(f.service.view(id).maintenanceVersion,before.maintenanceVersion);
 f.library.doc.dirty=true;f.library.emit();assert.equal(f.service.listNotices()[0].dirty,true);f.library.digest='own-save';f.library.emit();assert.deepEqual(f.service.listNotices(),[]);
 f.library.closed=true;f.library.emit({id,closed:true,dirty:false,conflicts:0});assert.deepEqual(f.stopped,[id]);f.notice({id,status:'missing',dirty:false});assert.deepEqual(f.service.listNotices(),[]);f.service.close();assert.equal(f.watcherClosed(),true);assert.equal(f.library.listeners.size,0);
});
test('password changes use two main-only prompts, a captured generation and committed cache warnings',async()=>{
 const f=fixture(),before=f.service.view(id),request=f.request();
 assert.deepEqual(await f.service.changePassword(request),{status:'changed',warnings:[]});
 assert.deepEqual(f.questions,['old','new']);assert.equal(f.library.calls.length,1);assert.equal(f.library.calls[0].expectedGeneration,1);assert.equal(f.library.calls[0].oldPassword,'SYNTHETIC-OLD');assert.equal(f.library.calls[0].newPassword,'SYNTHETIC-NEW');assert.deepEqual(f.forgotten,['/synthetic/private-document.rwdoc']);
 assert.notEqual(f.service.view(id).maintenanceVersion,before.maintenanceVersion);await assert.rejects(()=>f.service.changePassword(request),{code:'stale'});assert.equal(f.questions.length,2);
 f.deps.forget=async()=>{throw Error('SYNTHETIC-CACHE-ERROR');};
 assert.deepEqual(await f.service.changePassword(f.request()),{status:'changed',warnings:['cache-forget-failed']});assert.equal(f.library.calls.length,2);assert.equal(JSON.stringify(f.service.view(id)).includes('SYNTHETIC'),false);
 f.service.close();
});
test('undefined cancels either password prompt while empty and raw password payloads are rejected',async()=>{
 const f=fixture();f.deps.askPassword=async()=>undefined;
 assert.deepEqual(await f.service.changePassword(f.request()),{status:'cancelled'});assert.equal(f.library.calls.length,0);assert.deepEqual(f.forgotten,[]);
 f.deps.askPassword=async purpose=>purpose==='old'?'SYNTHETIC-OLD':undefined;assert.deepEqual(await f.service.changePassword(f.request()),{status:'cancelled'});assert.equal(f.library.calls.length,0);
 f.deps.askPassword=async purpose=>purpose==='old'?'SYNTHETIC-OLD':'';await assert.rejects(()=>f.service.changePassword(f.request()),{code:'invalid'});assert.equal(f.library.calls.length,0);
 for(const extra of [{oldPassword:'RAW'},{newPassword:'RAW'},{path:'/private/raw'},{generation:1}])await assert.rejects(()=>f.service.changePassword({...f.request(),...extra}),{code:'invalid'});
 (f.library.doc as any).upgradeRequired=true;f.deps.askPassword=async()=>{throw Error('unexpected prompt');};await assert.rejects(()=>f.service.changePassword(f.request()),{code:'upgrade-required'});
 assert.equal(f.library.calls.length,0);assert.equal(f.forgotten.length,0);f.service.close();
});
test('real library rekey preserves unsaved objects and starts/stops watchers through its open/close lifecycle',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'c3-maintenance-real-')),path=join(dir,'synthetic.rwdoc'),library=new DocumentLibrary({kdf:{logN:14,r:8,p:1}}),started=new Map<string,any>(),forgotten:string[]=[];
 const watcher={start:(id:string,_path:string,state:any)=>{started.set(id,state);},stop:(id:string)=>{started.delete(id);},subscribe:(_listener:(notice:any)=>void)=>()=>{},close:()=>{started.clear();}};
 const service=new DocumentMaintenance(library,{watcher,askPassword:async purpose=>purpose==='old'?'synthetic-old':'synthetic-new',forget:async path=>{forgotten.push(path);}});
 t.after(async()=>{service.close();library.closeAll();await rm(dir,{recursive:true,force:true});});
 const document=await library.create(path,'Sintetis','synthetic-old');assert.equal(started.size,1,'newly opened document is watched before an explicit view request');
 const object=library.add(document.id,{type:'folder',name:'Unsaved',parentId:null});const before=library.privateDocument(document.id).doc as any,meta=structuredClone(before.meta),revision=before.revision,view=service.view(document.id);
 assert.deepEqual(await service.changePassword({id:document.id,expectedSeq:view.seq,expectedMaintenanceVersion:view.maintenanceVersion}),{status:'changed',warnings:[]});
 assert.equal(library.view(document.id).dirty,true);assert.equal(library.node(document.id,object.objectId)!.name,'Unsaved');assert.deepEqual((library.privateDocument(document.id).doc as any).meta,meta);assert.equal(library.view(document.id).revision,revision);assert.equal(forgotten[0],library.entryStamp(document.id).path);assert.equal(started.get(document.id).digest(),library.entryStamp(document.id).digest);
 const head=await DocumentSession.open(path,{password:'synthetic-new'});try{assert.deepEqual(Object.keys(head.doc.objects),[]);}finally{head.dispose();}
 await assert.rejects(DocumentSession.open(path,{password:'synthetic-old'}));await library.save(document.id);
 const saved=await DocumentSession.open(path,{password:'synthetic-new'});try{assert.equal(saved.doc.objects[object.objectId].name,'Unsaved');}finally{saved.dispose();}
 library.close(document.id);assert.equal(started.size,0);assert.deepEqual(service.listNotices(),[]);
});
test('a private generation change during the old password prompt rejects before the new prompt',async()=>{
 const f=fixture();let entered!:()=>void,release!:(value:string)=>void;const started=new Promise<void>(resolve=>entered=resolve),password=new Promise<string>(resolve=>release=resolve);let prompted=0;
 f.deps.askPassword=async()=>{prompted++;entered();return password;};const request=f.request(),pending=f.service.changePassword(request);await started;
 await assert.rejects(()=>f.service.changePassword(request),{code:'busy'});f.library.generation++;release('SYNTHETIC-OLD');await assert.rejects(pending,{code:'stale'});assert.equal(prompted,1);assert.equal(f.library.calls.length,0);assert.equal(f.forgotten.length,0);f.service.close();
});
test('close or an external notice during the new password prompt cannot resurrect a key operation',async()=>{
 for(const close of [true,false]){
  const f=fixture();let entered!:()=>void,release!:(value:string)=>void;const started=new Promise<void>(resolve=>entered=resolve),password=new Promise<string>(resolve=>release=resolve);
  f.deps.askPassword=async purpose=>{if(purpose==='old')return'SYNTHETIC-OLD';entered();return password;};const pending=f.service.changePassword(f.request());await started;
  if(close){f.library.closed=true;f.library.emit({id,closed:true,dirty:false,conflicts:0});}else f.notice({id,status:'changed',dirty:false,actions:['reload','save-merge']});
  release('SYNTHETIC-NEW');await assert.rejects(pending,{code:'stale'});assert.equal(f.library.calls.length,0);assert.equal(f.forgotten.length,0);f.service.close();
 }
});
test('uncertain commits require explicit reopen, preserve dirty data and sanitize committed warning details',async()=>{
 const f=fixture(),change=f.library.changePassword.bind(f.library);
 f.library.changePassword=async request=>{await change(request);return{warnings:['lock-release-failed','commit-observed-after-error','SYNTHETIC-PRIVATE-ERROR']};};
 assert.deepEqual(await f.service.changePassword(f.request()),{status:'changed',warnings:['lock-release-failed','commit-observed-after-error','maintenance-warning']});
 f.library.doc.dirty=true;f.library.changePassword=async()=>{throw Object.assign(Error('SYNTHETIC-RAW-DETAIL'),{requiresReopen:true});};
 assert.deepEqual(await f.service.changePassword(f.request()),{status:'reopen-required',warnings:['reopen-required']});assert.equal(f.library.doc.dirty,true);assert.equal(f.service.view(id).requiresReopen,true);assert.equal(f.started.size,0);assert.deepEqual(f.service.listNotices(),[]);
 const count=f.questions.length;assert.deepEqual(await f.service.changePassword(f.request()),{status:'reopen-required',warnings:['reopen-required']});assert.equal(f.questions.length,count);assert.equal(JSON.stringify(f.service.view(id)).includes('SYNTHETIC'),false);f.service.close();
});

test('dirty real-library watcher notices never call reload, even when a reload rejection would be swallowed',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'c4-dirty-watch-real-')),path=join(dir,'synthetic.rwdoc'),library=new DocumentLibrary({kdf:{logN:14,r:8,p:1}}),started=new Map<string,{digest():string;dirty():boolean}>();
 type Notice={id:string;status:'changed'|'missing'|'unreadable';dirty:boolean;actions:['reload','save-merge']};
 let receive:((notice:Notice)=>void)|undefined,reloadCalls=0;
 const watcher={start:(id:string,_path:string,state:{digest():string;dirty():boolean})=>{started.set(id,state);},stop:(id:string)=>{started.delete(id);},subscribe:(listener:(notice:Notice)=>void)=>{receive=listener;return()=>{receive=undefined;};},close:()=>{started.clear();}};
 const service=new DocumentMaintenance(library,{watcher,askPassword:async()=>{throw Error('unexpected password prompt');},forget:async()=>{throw Error('unexpected cache access');}});
 t.after(async()=>{service.close();library.closeAll();await rm(dir,{recursive:true,force:true});});
 const document=await library.create(path,'Sintetis watcher','synthetic-password'),node=library.add(document.id,{type:'folder',name:'Unsaved local content',parentId:null});
 const before={dirty:library.view(document.id).dirty,seq:library.view(document.id).seq,doc:structuredClone(library.privateDocument(document.id).doc)};
 assert.equal(before.dirty,true);assert.equal(started.get(document.id)!.dirty(),true);assert.ok(receive);
 const reload=library.reload.bind(library);library.reload=async handle=>{reloadCalls++;return reload(handle);};
 receive({id:document.id,status:'changed',dirty:true,actions:['reload','save-merge']});
 assert.equal(reloadCalls,0,'dirty watcher notice must not attempt reload synchronously');
 assert.equal(library.view(document.id).dirty,before.dirty);assert.equal(library.view(document.id).seq,before.seq);assert.deepEqual(library.privateDocument(document.id).doc,before.doc);
 assert.deepEqual(service.listNotices(),[{id:document.id,status:'changed',dirty:true,actions:['reload','save-merge']}]);
 await Promise.resolve();await Promise.resolve();
 assert.equal(reloadCalls,0,'dirty watcher notice must not defer an automatic reload');
 assert.equal(library.view(document.id).dirty,before.dirty);assert.equal(library.view(document.id).seq,before.seq);assert.deepEqual(library.privateDocument(document.id).doc,before.doc);
 assert.equal(library.node(document.id,node.objectId)!.name,'Unsaved local content');assert.deepEqual(service.listNotices(),[{id:document.id,status:'changed',dirty:true,actions:['reload','save-merge']}]);
});
