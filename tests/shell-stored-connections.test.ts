import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentLibrary } from '../src/documents/library.js';
import { DocumentSession } from '../src/documents/session.js';
const modulePath='../src/desktop/connections.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const kdf={logN:14,r:8,p:1};const canary='SYNTHETIC-STORED-PASSWORD';
async function fixture(selection?:any,extraProps:any={},totp?:any){
 const dir=await mkdtemp(join(tmpdir(),'c1-stored-'));const path=join(dir,'doc.rwdoc');
 const doc:any={schemaVersion:2,id:id(900),kind:'workspace',name:'Lab',revision:0,meta:{createdAt:null,updatedAt:null,sort:[]},defaults:{groups:{}},secrets:{[id(11)]:{kind:'credential',username:'LAB\\administrator',domain:'LAB',password:canary}},objects:{[id(1)]:{id:id(1),name:'Server',type:'connection',parentId:null,order:0,props:{protocol:'rdp',host:'example.invalid',port:3389,username:'legacy',certificateSha256:'a'.repeat(64),...(selection?{groups:{credentials:selection}}:{})}}}};
 Object.assign(doc.objects[id(1)].props,extraProps);if(totp)doc.secrets[id(11)].totp=totp;
 const s=await DocumentSession.create(path,doc,'pw',{kdf});s.dispose();const library=new DocumentLibrary({kdf});const summary=await library.open(path,'pw');
 const calls:any[]=[];let next=1;
 const {StoredConnections}=await import(modulePath);
 const service=new StoredConnections({library,open:async(target:any,secret:any)=>{calls.push({target,secret});return `session-${next++}`;},prompt:async()=>({username:'legacy',domain:'',password:canary}),approveScope:async()=>true});
 return{library,summary,calls,service,request:()=>({documentHandle:summary.id,objectId:id(1),expectedSeq:library.view(summary.id).seq})};
}
test('stored connect passes exactly one secret to owner, returns only public data and reconnect resolves current data',async()=>{
 const f=await fixture({mode:'inline',secretId:id(11)});
 const result=await f.service.openStored(f.request());assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].target.username,'administrator');assert.deepEqual(f.calls[0].secret,{domain:'LAB',password:canary});
 assert.ok(!JSON.stringify(result).includes(canary));assert.equal(result.sessionId,'session-1');
 f.library.update(f.summary.id,id(1),{patch:{set:{host:'changed.invalid'}}});
 const again=await f.service.reconnectStored(result.sessionId);assert.equal(again.sessionId,'session-2');assert.equal(f.calls[1].target.host,'changed.invalid');
 f.library.closeAll();await assert.rejects(f.service.reconnectStored(again.sessionId));
});
test('stored IPC refuses forged source/options/stale seq before prompt or engine; pin cannot be removed',async()=>{
 const f=await fixture({mode:'inline',secretId:id(11)});
 for(const patch of [{expectedSeq:99},{password:canary},{temporaryOptions:{certificateSha256:''}},{temporaryOptions:{tls:false}},{scope:[id(900)]}]) await assert.rejects(f.service.openStored({...f.request(),...patch}));
 assert.equal(f.calls.length,0);f.library.closeAll();
});
test('document edit during prompt invalidates one-shot context, even if only private data changed',async()=>{
 const f=await fixture();let release:(v:any)=>void=()=>{};
 const {StoredConnections}=await import(modulePath);let called=0;
 const s=new StoredConnections({library:f.library,open:async()=>{called++;return'never';},prompt:()=>new Promise(resolve=>{release=resolve;}),approveScope:async()=>true});
 const pending=s.openStored(f.request());await Promise.resolve();
 f.library.update(f.summary.id,id(1),{name:'Changed'});release({username:'lab',domain:'',password:canary});
 await assert.rejects(pending,{code:'stale'});assert.equal(called,0);f.library.closeAll();
});
test('scope is approved only by main human prompt and is bound to credential selection and generations',async()=>{
 const f=await fixture();const vault=await f.library.createVault(join(await mkdtemp(join(tmpdir(),'c1-source-')),'vault.rwdoc'),'Vault','pw');
 const cred=f.library.writeCredential(vault.id,{name:'LabCredential',record:{kind:'credential',username:'lab',domain:'',password:canary}});
 f.library.update(f.summary.id,id(1),{patch:{set:{groups:{credentials:{mode:'id',vaultId:vault.docId,credentialId:cred.objectId}}}}});
 const {StoredConnections}=await import(modulePath);let asks=0;
 const s=new StoredConnections({library:f.library,open:async()=>`ok-${asks}`,prompt:async()=>undefined,approveScope:async()=>{asks++;return true;}});
 const first=await s.openStored(f.request());assert.equal(asks,1);await s.reconnectStored(first.sessionId);assert.equal(asks,1);
 f.library.writeCredential(vault.id,{objectId:cred.objectId,name:'LabCredential',record:{kind:'credential',username:'new',domain:'',password:canary}});
 await s.reconnectStored(first.sessionId);assert.equal(asks,2);f.library.closeAll();
});
test('MFA composed into username reaches only owner and never the public target or renderer',async()=>{
 const f=await fixture({mode:'inline',secretId:id(11)},{mfa:{mode:'generate',field:'username',pattern:'ValueMfaCode'}},{secretBase32:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',algorithm:'sha1',digits:8,period:30});
 const {StoredConnections}=await import(modulePath);let target:any;
 const service=new StoredConnections({library:f.library,open:async(t:any)=>{target=t;return'generated';},prompt:async()=>undefined,approveScope:async()=>true,now:()=>59000});
 const result=await service.openStored(f.request());assert.equal(target.username,'administrator94287082');
 assert.ok(!JSON.stringify(result).includes('94287082'));assert.equal(result.publicTarget.username,'administrator');f.library.closeAll();
});
test('a credential source changed while an MFA prompt is open invalidates the pending engine handoff',async()=>{
 const f=await fixture(undefined,{mfa:{mode:'prompt',field:'password',pattern:'ValueMfaCode'}});
 const vault=await f.library.createVault(join(await mkdtemp(join(tmpdir(),'c1-mfa-source-')),'vault.rwdoc'),'Vault','pw');
 const cred=f.library.writeCredential(vault.id,{name:'Lab',record:{kind:'credential',username:'lab',domain:'',password:canary}});
 f.library.update(f.summary.id,id(1),{patch:{set:{groups:{credentials:{mode:'id',vaultId:vault.docId,credentialId:cred.objectId}}}}});
 const {StoredConnections}=await import(modulePath);let release:(v:string)=>void=()=>{},entered:()=>void=()=>{};let called=0;
 const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const service=new StoredConnections({library:f.library,open:async()=>{called++;return'never';},prompt:async()=>undefined,approveScope:async()=>true,promptCode:()=>new Promise(resolve=>{release=resolve;entered();})});
 const pending=service.openStored(f.request());await waiting;
 f.library.writeCredential(vault.id,{objectId:cred.objectId,name:'Lab',record:{kind:'credential',username:'lab',domain:'',password:'CHANGED'}});release('123456');
 await assert.rejects(pending,{code:'stale'});assert.equal(called,0);f.library.closeAll();
});
test('malformed stored protocol values are rejected instead of silently taking defaults',async()=>{
 for(const props of [{port:'3389'},{clipboardToRemote:'yes'},{certificateSha256:123}]){
  const f=await fixture({mode:'inline',secretId:id(11)},props);
  await assert.rejects(f.service.openStored(f.request()));assert.equal(f.calls.length,0);f.library.closeAll();
 }
});
test('inline credential use requires main approval bound to the endpoint, including temporary endpoint changes',async()=>{
 const f=await fixture({mode:'inline',secretId:id(11)});const {StoredConnections}=await import(modulePath);
 let allow=false;const asks:any[]=[];let opens=0;
 const service=new StoredConnections({library:f.library,open:async()=>`session-${++opens}`,prompt:async()=>undefined,approveScope:async(request:any)=>{asks.push(request);return allow;}});
 await assert.rejects(service.openStored(f.request()),{code:'scope-denied'});assert.equal(opens,0);assert.equal(asks[0].target.host,'example.invalid');
 allow=true;const first=await service.openStored(f.request());assert.equal(asks.length,2);
 await service.reconnectStored(first.sessionId);assert.equal(asks.length,2,'the same binding and endpoint reuse the main grant');
 await service.openStored({...f.request(),temporaryOptions:{host:'another.invalid'}});assert.equal(asks.length,3);assert.equal(asks[2].target.host,'another.invalid');
 assert.ok(!JSON.stringify(asks).includes(canary));f.library.closeAll();
});
test('main enforces one pending input, rejects duplicate or parallel requests, and releases the gate after cancellation',async()=>{
 const f=await fixture();const second=f.library.add(f.summary.id,{parentId:null,type:'connection',name:'Second',props:{protocol:'rdp',host:'second.invalid',username:'lab'}});
 const {StoredConnections}=await import(modulePath);let release:(v:any)=>void=()=>{},prompts=0,opens=0;
 const service=new StoredConnections({library:f.library,open:async()=>`ok-${++opens}`,approveScope:async()=>true,prompt:async()=>{prompts++;if(prompts===1)return new Promise(resolve=>{release=resolve;});return{username:'lab',domain:'',password:canary};}});
 const pending=service.openStored(f.request());
 try{
  await assert.rejects(service.openStored(f.request()),{code:'busy'});
  await assert.rejects(service.openStored({...f.request(),objectId:second.objectId}),{code:'busy'});
 }finally{release(undefined);await assert.rejects(pending,{code:'cancelled'});}
 assert.equal(opens,0);assert.equal(prompts,1);assert.equal((await service.openStored(f.request())).sessionId,'ok-1');f.library.closeAll();
});
