import test from 'node:test';import assert from 'node:assert/strict';
import {TransferService} from '../src/desktop/transfer-service.js';
import {OperationPlans} from '../src/desktop/operation-plans.js';
import {DocumentLibrary} from '../src/documents/library.js';
import {DocumentSession} from '../src/documents/session.js';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
async function fixture(t:{after(fn:()=>Promise<void>):void},privateSource=false){
 const dir=await mkdtemp(join(tmpdir(),'c3-transfer-service-')),library=new DocumentLibrary({kdf:{logN:14,r:8,p:1},now:()=>0});let now=1000,scope='scope-1';
 const source=await library.create(join(dir,'source.rwdoc'),'Sumber','synthetic-password'),target=await library.create(join(dir,'target.rwdoc'),'Tujuan','synthetic-password');
 const object=library.add(source.id,{type:'connection',name:'Koneksi sintetis',parentId:null,props:{protocol:'rdp',host:'example.invalid',notes:'SYNTHETIC-NOT-DTO'}});
 if(privateSource)library.writeGroup(source.id,{objectId:object.objectId,group:'credentials',inherit:false,value:{mode:'inline'},secret:{kind:'credential',username:'lab',domain:'',password:'SYNTHETIC-SECRET'}});
 await library.save(source.id);const calls:any[]=[],consents:any[]=[];
 Object.defineProperty(library,'transfer',{configurable:true,value:async(input:any)=>{calls.push(input);return{destination:'verified',sourceDisk:input.mode==='move'?'removed-saved':'retained',sourceMemory:input.mode==='move'?'removed':'unchanged',stage:'complete',warnings:[]};}});
 const plans=new OperationPlans(library,{scopeStamp:()=>scope,now:()=>now}),deps={newId:undefined as (()=>string)|undefined,confirmPrivate:async(metadata:any)=>{consents.push(metadata);return true;},confirmMove:async(metadata:any)=>{consents.push(metadata);return true;}};
 const service=new TransferService(library as any,plans,deps),request=(extra:Record<string,unknown>={})=>({sourceId:source.id,sourceSeq:library.view(source.id).seq,destinationId:target.id,destinationSeq:library.view(target.id).seq,objectIds:[object.objectId],mode:'copy',copyPrivate:false,...extra});
 t.after(async()=>{service.close('window');plans.close();library.closeAll();await rm(dir,{recursive:true,force:true});});
 return{library,source,target,object,service,plans,deps,calls,consents,request,advance:(milliseconds:number)=>now+=milliseconds,setScope:(value:string)=>scope=value};
}
test('transfer sources and preview expose metadata only and do not write or ask for consent',async t=>{
 const f=await fixture(t),sources=f.service.sources();assert.equal(sources.length,2);assert.deepEqual(Object.keys(sources[0].objects[0]).sort(),['id','name','parentId','type']);
 const preview=f.service.preview('window',f.request());assert.match(preview.planId,/^[0-9a-f-]{36}$/);assert.equal(preview.count,1);assert.equal(preview.canApply,true);assert.equal(preview.requiresPrivateConsent,false);assert.equal(preview.privateOverridesCopied,false);
 for(const forbidden of ['SYNTHETIC-NOT-DTO','example.invalid','idMap','secrets','digest','/source.rwdoc'])assert.equal(JSON.stringify({sources,preview}).includes(forbidden),false);
 assert.equal(f.calls.length,0);assert.equal(f.consents.length,0);assert.equal(f.library.view(f.target.id).dirty,false);
});
test('private checkbox is a preview choice rather than a native consent grant and results omit private receipts',async t=>{
 const f=await fixture(t,true),blocked=f.service.preview('window',f.request());assert.equal(blocked.canApply,false);assert.equal(blocked.requiresPrivateConsent,true);assert.equal(blocked.containsSecrets,true);assert.equal(blocked.blockedReason,'private-consent');
 await assert.rejects(()=>f.service.apply('window',{planId:blocked.planId}),{code:'scope-denied'});assert.equal(f.calls.length,0);assert.equal(f.consents.length,0);
 const reviewed=f.service.preview('window',f.request({copyPrivate:true}));assert.equal(reviewed.canApply,true);
 await assert.rejects(()=>f.service.apply('foreign',{planId:reviewed.planId}),{code:'stale'});
 const result=await f.service.apply('window',{planId:reviewed.planId});assert.equal(result.destination,'verified');assert.equal(result.sourceDisk,'retained');assert.equal(result.stage,'complete');assert.equal(f.calls.length,1);assert.equal(f.consents.length,1);assert.equal(f.consents[0].containsSecrets,true);
 for(const forbidden of ['SYNTHETIC-SECRET','idMap','prepared','/source.rwdoc','digest'])assert.equal(JSON.stringify({result,consents:f.consents}).includes(forbidden),false);
 assert.equal(f.calls[0].prepared.preview.containsSecrets,true);await assert.rejects(()=>f.service.apply('window',{planId:reviewed.planId}),{code:'stale'});
});
test('result projection preserves uncertain phases and rejects coercible phase objects without returning private details',async t=>{
 const f=await fixture(t);Object.defineProperty(f.library,'transfer',{configurable:true,value:async()=>({destination:'verified',sourceDisk:'uncertain',sourceMemory:'removal-pending',stage:'source-uncertain',errorCode:'reopen-required',idMap:{hidden:'SYNTHETIC-PRIVATE'},warnings:['reopen-required','SYNTHETIC-PRIVATE-WARNING']})});
 let preview=f.service.preview('window',f.request());const result=await f.service.apply('window',{planId:preview.planId});assert.equal(result.sourceDisk,'uncertain');assert.equal(result.status,'partial');assert.equal(result.errorCode,'reopen-required');assert.deepEqual(result.warnings,['reopen-required','transfer-warning']);assert.equal(JSON.stringify(result).includes('SYNTHETIC'),false);assert.equal('idMap' in result,false);
 Object.defineProperty(f.library,'transfer',{configurable:true,value:async()=>({destination:new String('verified'),sourceDisk:'retained',sourceMemory:'unchanged',stage:'complete'})});preview=f.service.preview('window',f.request());await assert.rejects(()=>f.service.apply('window',{planId:preview.planId}),{code:'io'});
});
test('private consent cannot authorize expired, changed or cancelled plans and closes never begin a transfer',async t=>{
 for(const action of ['expiry','scope','target','cancel','close']){
  const f=await fixture(t,true);let entered!:()=>void,release!:(value:boolean)=>void;const started=new Promise<void>(resolve=>entered=resolve),consent=new Promise<boolean>(resolve=>release=resolve);
  f.deps.confirmPrivate=async()=>{entered();return consent;};const preview=f.service.preview('window',f.request({copyPrivate:true})),pending=f.service.apply('window',{planId:preview.planId});await started;
  assert.throws(()=>f.service.preview('window',f.request()),{code:'busy'});await assert.rejects(()=>f.service.apply('window',{planId:preview.planId}),{code:'busy'});assert.deepEqual(f.service.cancel('foreign',{planId:preview.planId}),{cancelled:false});
  if(action==='expiry')f.advance(60000);if(action==='scope')f.setScope('scope-2');if(action==='target')f.library.add(f.target.id,{type:'folder',name:'Changed elsewhere',parentId:null});if(action==='cancel')assert.deepEqual(f.service.cancel('window',{planId:preview.planId}),{cancelled:true});if(action==='close')f.service.close('window');
  release(true);if(action==='cancel'||action==='close'){const result=await pending;assert.equal(result.status,'cancelled');assert.equal(result.destination,'unchanged');}else await assert.rejects(pending,{code:'stale'});assert.equal(f.calls.length,0,action);
 }
});
test('source references block only an unsafe move and malformed requests cannot become writes',async t=>{
 const f=await fixture(t);f.library.add(f.source.id,{type:'folder',name:'Unselected reference',parentId:null,props:{groups:{preConnectTask:{documentId:f.source.docId,objectId:f.object.objectId}}}});await f.library.save(f.source.id);
 const blocked=f.service.preview('window',f.request({mode:'move'}));assert.equal(blocked.sourceCanRemove,false);assert.equal(blocked.canApply,false);assert.equal(blocked.blockedReason,'source-references');assert.ok(blocked.sourceReferencesAffected>=1);await assert.rejects(()=>f.service.apply('window',{planId:blocked.planId}),{code:'invalid'});assert.equal(f.calls.length,0);
 const copy=f.service.preview('window',f.request());assert.equal(copy.canApply,true);await assert.rejects(()=>f.service.apply('window',{planId:copy.planId,sourceId:f.source.id}),{code:'invalid'});
 for(const extra of [{owner:'foreign'},{path:'/raw/private'},{sourceSeq:-1},{objectIds:[]},{objectIds:Array(10001).fill(f.object.objectId)},{copyPrivate:'yes'},{parentId:'bad'}])assert.throws(()=>f.service.preview('window',f.request(extra)));
 const result=await f.service.apply('window',{planId:copy.planId});assert.equal(result.destination,'verified');assert.equal(f.calls.length,1);
});
test('an accepted transfer uses continuation scope after own writes and move consent is deferred to the verified phase',async t=>{
 const f=await fixture(t);let verified=false;
 f.deps.confirmMove=async metadata=>{assert.equal(verified,true);assert.equal(metadata.sourceName,'Sumber');assert.equal(metadata.sourceReferencesAffected,0);return true;};
 Object.defineProperty(f.library,'transfer',{configurable:true,value:async(input:any)=>{
  f.advance(60000);f.library.add(f.target.id,{type:'folder',name:'Own phase A',parentId:null});await f.library.save(f.target.id);verified=true;assert.equal(input.scopeValid(),true);assert.equal(input.cancelled(),false);assert.equal(await input.confirmMove(),true);
  return{destination:'verified',sourceDisk:'removed-saved',sourceMemory:'removed',stage:'complete',warnings:[]};
 }});
 const preview=f.service.preview('window',f.request({mode:'move'})),result=await f.service.apply('window',{planId:preview.planId});assert.equal(result.sourceDisk,'removed-saved');assert.equal(result.stage,'complete');
});
test('service and real library move only after destination encrypted readback and a fresh native decision',async t=>{
 const f=await fixture(t);delete(f.library as any).transfer;let asked=false;
 f.deps.confirmMove=async metadata=>{
  asked=true;assert.equal(metadata.count,1);assert.equal(f.library.node(f.source.id,f.object.objectId)!.name,'Koneksi sintetis');
  const saved=await DocumentSession.open(f.target.path,{password:'synthetic-password'});try{assert.equal(Object.values(saved.doc.objects).some(node=>node.name==='Koneksi sintetis'),true);}finally{saved.dispose();}
  return true;
 };
 const preview=f.service.preview('window',f.request({mode:'move'})),result=await f.service.apply('window',{planId:preview.planId});assert.equal(asked,true);assert.equal(result.destination,'verified');assert.equal(result.sourceDisk,'removed-saved');assert.equal(result.sourceMemory,'removed');assert.equal(result.stage,'complete');assert.equal(f.library.node(f.source.id,f.object.objectId),undefined);assert.equal(f.library.view(f.source.id).dirty,false);assert.equal(f.library.view(f.target.id).dirty,false);
 const destination=Object.values(f.library.privateDocument(f.target.id).doc.objects).find(node=>node.name==='Koneksi sintetis')!;assert.notEqual(destination.id,f.object.objectId);assert.equal(JSON.stringify(result).includes('SYNTHETIC'),false);
});
test('scope revocation before or during move consent preserves the verified destination without authorizing deletion',async t=>{
 for(const when of ['before','during']){
  const f=await fixture(t);let asked=0;
  f.deps.confirmMove=async()=>{asked++;f.setScope('revoked');return true;};
  Object.defineProperty(f.library,'transfer',{configurable:true,value:async(input:any)=>{
   f.library.add(f.target.id,{type:'folder',name:'Own verified phase',parentId:null});await f.library.save(f.target.id);assert.equal(input.scopeValid(),true);if(when==='before')f.setScope('revoked');
   await assert.rejects(()=>input.confirmMove(),{code:'stale'});assert.equal(input.scopeValid(),false);
   return{destination:'verified',sourceDisk:'retained',sourceMemory:'unchanged',stage:'source-check',errorCode:'scope-denied',warnings:[]};
  }});
  const preview=f.service.preview('window',f.request({mode:'move'})),result=await f.service.apply('window',{planId:preview.planId});assert.equal(result.status,'partial');assert.equal(result.sourceDisk,'retained');assert.equal(f.library.node(f.source.id,f.object.objectId)!.name,'Koneksi sintetis');assert.equal(asked,when==='before'?0:1);
 }
});
